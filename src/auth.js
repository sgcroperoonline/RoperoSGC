// Ingreso al panel de voluntarias: UNA clave de servidor (secreto ADMIN_CLAVE), sin usuarios.
// Al acertar la clave se entrega un "token" firmado que dura 12 horas.
import { anotarIntento, quitarIntento } from "./freno.js";
import { aBase64Url, aHex, bytesAleatorios, deBase64Url, ErrorPublico, igualesSeguro, leerJSON } from "./util.js";

const DURACION_SESION_MS = 12 * 60 * 60 * 1000; // 12 horas
const VENTANA_INTENTOS_MS = 15 * 60 * 1000;     // 15 minutos
const MAXIMO_FALLOS = 8;

const SESION_EXPIRADA = "Tu sesión expiró. Vuelve a ingresar.";
const SIN_CLAVE = "El panel no está configurado: falta el secreto ADMIN_CLAVE en el servidor.";

const texto = (valor) => new TextEncoder().encode(valor);
const llaveHmac = (bytes, usos) => crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, usos);

// Secreto aleatorio guardado en la base de datos (tabla "ajustes", migración 0002).
// Si falta, se crea una vez. Se guarda en memoria para no leerlo en cada petición.
let secretoGuardado = null;
async function secretoDeSesiones(db) {
  if (secretoGuardado) return secretoGuardado;
  const leer = db.prepare("SELECT valor FROM ajustes WHERE clave = 'secreto_sesiones'");
  let fila = await leer.first();
  if (!fila) {
    const [, leido] = await db.batch([
      db.prepare("INSERT OR IGNORE INTO ajustes (clave, valor) VALUES ('secreto_sesiones', ?)").bind(aHex(bytesAleatorios(32))),
      leer,
    ]);
    fila = leido.results[0];
  }
  secretoGuardado = fila.valor;
  return secretoGuardado;
}

// Llave para firmar los tokens: el secreto aleatorio mezclado con ADMIN_CLAVE (+ SECRETO_SESION si existe).
// Sin el secreto, un token robado no sirve para adivinar la clave sin conexión, y si alguien
// cambia la clave del panel, todas las sesiones abiertas dejan de servir.
async function llaveDeFirma(env) {
  const secreto = await llaveHmac(texto(await secretoDeSesiones(env.DB)), ["sign"]);
  const llave = await crypto.subtle.sign("HMAC", secreto, texto(`ropero-sg|${env.ADMIN_CLAVE}|${env.SECRETO_SESION || ""}`));
  return llaveHmac(llave, ["sign", "verify"]);
}

async function crearToken(env) {
  const exp = Date.now() + DURACION_SESION_MS;
  const contenido = aBase64Url(texto(JSON.stringify({ exp })));
  const firma = await crypto.subtle.sign("HMAC", await llaveDeFirma(env), texto(contenido));
  return { token: `${contenido}.${aBase64Url(new Uint8Array(firma))}`, expiraEn: new Date(exp).toISOString() };
}

// Revisa la firma (crypto.subtle.verify compara en tiempo constante) y la fecha de expiración.
async function tokenValido(env, token) {
  if (typeof token !== "string" || token.length > 500) return false;
  const partes = token.split(".");
  if (partes.length !== 2) return false;
  const firma = deBase64Url(partes[1]);
  if (!firma) return false;
  const correcta = await crypto.subtle.verify("HMAC", await llaveDeFirma(env), firma, texto(partes[0]));
  if (!correcta) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(deBase64Url(partes[0])));
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

/** POST /api/admin/ingresar  { clave } -> { token, expiraEn } */
export async function ingresar(c) {
  const env = c.env;
  if (!env.ADMIN_CLAVE) throw new ErrorPublico(503, SIN_CLAVE);

  const { clave } = await leerJSON(c);
  if (typeof clave !== "string" || !clave || clave.length > 200) throw new ErrorPublico(400, "Escribe la clave del panel.");

  // Freno contra quien intenta adivinar: máximo 8 fallos por IP (o bloque IPv6) cada 15 minutos.
  // El intento se anota antes de revisar la clave (ver freno.js).
  const intento = await anotarIntento(c, {
    prefijo: "panel:", maximo: MAXIMO_FALLOS, ventanaMs: VENTANA_INTENTOS_MS,
    mensaje: "Demasiados intentos fallidos. Espera 15 minutos antes de volver a intentarlo.",
  });
  if (!(await igualesSeguro(clave, env.ADMIN_CLAVE))) throw new ErrorPublico(401, "Clave incorrecta.");
  await quitarIntento(env.DB, intento);
  return c.json(await crearToken(env));
}

/** Middleware: todas las rutas del panel (salvo ingresar) exigen "Authorization: Bearer <token>". */
export async function exigirSesion(c, next) {
  if (!c.env.ADMIN_CLAVE) throw new ErrorPublico(503, SIN_CLAVE);
  const encabezado = c.req.header("Authorization") || "";
  const token = encabezado.startsWith("Bearer ") ? encabezado.slice(7).trim() : "";
  if (!token || !(await tokenValido(c.env, token))) throw new ErrorPublico(401, SESION_EXPIRADA);
  await next();
}

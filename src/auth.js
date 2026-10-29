// Ingreso al panel de voluntarias: UNA clave de servidor (secreto ADMIN_CLAVE), sin usuarios.
// Al acertar la clave se entrega un "token" firmado que dura 12 horas.
import { aBase64Url, ahora, deBase64Url, ErrorPublico, haceMs, igualesSeguro, leerJSON } from "./util.js";

const DURACION_SESION_MS = 12 * 60 * 60 * 1000; // 12 horas
const VENTANA_INTENTOS_MS = 15 * 60 * 1000;     // 15 minutos
const MAXIMO_FALLOS = 8;

const SESION_EXPIRADA = "Tu sesión expiró. Vuelve a ingresar.";
const SIN_CLAVE = "El panel no está configurado: falta el secreto ADMIN_CLAVE en el servidor.";

// Llave para firmar los tokens. Sale de ADMIN_CLAVE (+ SECRETO_SESION si existe):
// si alguien cambia la clave del panel, todas las sesiones abiertas dejan de servir.
async function llaveDeFirma(env) {
  const base = new TextEncoder().encode(`ropero-sg|${env.ADMIN_CLAVE}|${env.SECRETO_SESION || ""}`);
  const resumen = await crypto.subtle.digest("SHA-256", base);
  return crypto.subtle.importKey("raw", resumen, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function crearToken(env) {
  const exp = Date.now() + DURACION_SESION_MS;
  const contenido = aBase64Url(new TextEncoder().encode(JSON.stringify({ exp })));
  const firma = await crypto.subtle.sign("HMAC", await llaveDeFirma(env), new TextEncoder().encode(contenido));
  return { token: `${contenido}.${aBase64Url(new Uint8Array(firma))}`, expiraEn: new Date(exp).toISOString() };
}

// Revisa la firma (crypto.subtle.verify compara en tiempo constante) y la fecha de expiración.
async function tokenValido(env, token) {
  if (typeof token !== "string" || token.length > 500) return false;
  const partes = token.split(".");
  if (partes.length !== 2) return false;
  const firma = deBase64Url(partes[1]);
  if (!firma) return false;
  const correcta = await crypto.subtle.verify("HMAC", await llaveDeFirma(env), firma, new TextEncoder().encode(partes[0]));
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

  // Freno contra quien intenta adivinar: máximo 8 fallos por IP cada 15 minutos.
  const ip = (c.req.header("CF-Connecting-IP") || "local").slice(0, 64);
  const fallos = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM intentos_acceso WHERE ip = ? AND creado_en > ?"
  ).bind(ip, haceMs(VENTANA_INTENTOS_MS)).first();
  if (fallos.n >= MAXIMO_FALLOS) {
    throw new ErrorPublico(429, "Demasiados intentos fallidos. Espera 15 minutos antes de volver a intentarlo.");
  }

  if (!(await igualesSeguro(clave, env.ADMIN_CLAVE))) {
    await env.DB.prepare("INSERT INTO intentos_acceso (ip, creado_en) VALUES (?, ?)").bind(ip, ahora()).run();
    throw new ErrorPublico(401, "Clave incorrecta.");
  }
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

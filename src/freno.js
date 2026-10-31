// Freno contra quien intenta adivinar: la clave del panel o pedidos ajenos (número + correo).
// Cada intento se anota ANTES de revisarlo y se cuenta en el mismo batch (todo o nada):
// así, aunque lleguen muchos intentos a la vez, nunca pasan más que el máximo.
// Si el intento resulta bueno se borra: solo cuentan los fallos.
import { ahora, ErrorPublico, haceMs } from "./util.js";

// La IPv4 tal cual. La IPv6 se agrupa en su /64: cada casa o servidor tiene millones
// de direcciones de ese bloque y podría cambiar de dirección en cada intento.
export function redDeIp(ip) {
  const texto = String(ip || "").trim().slice(0, 64);
  if (!texto.includes(":")) return texto || "local";
  const v4 = texto.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4) return v4[1];
  const [izquierda, derecha] = texto.split("%")[0].toLowerCase().split("::");
  const antes = izquierda ? izquierda.split(":") : [];
  const despues = derecha ? derecha.split(":") : [];
  const ceros = derecha === undefined ? [] : Array(Math.max(0, 8 - antes.length - despues.length)).fill("0");
  const grupos = [...antes, ...ceros, ...despues].slice(0, 4);
  while (grupos.length < 4) grupos.push("0");
  return grupos.map((g) => (parseInt(g, 16) || 0).toString(16)).join(":") + "::/64";
}

/**
 * Anota un intento de quien hace la petición (por IP) y responde 429 si ya hay
 * más de "maximo" fallos en la ventana. Devuelve el id del intento para poder
 * borrarlo con quitarIntento() si resulta bueno.
 */
export async function anotarIntento(c, { prefijo, maximo, ventanaMs, mensaje }) {
  const db = c.env.DB;
  const clave = prefijo + redDeIp(c.req.header("CF-Connecting-IP"));
  const [anotado, cuenta] = await db.batch([
    db.prepare("INSERT INTO intentos_acceso (ip, creado_en) VALUES (?, ?) RETURNING rowid AS id").bind(clave, ahora()),
    db.prepare("SELECT COUNT(*) AS n FROM intentos_acceso WHERE ip = ? AND creado_en > ?").bind(clave, haceMs(ventanaMs)),
  ]);
  const id = anotado.results[0].id;
  if (cuenta.results[0].n > maximo) {
    await quitarIntento(db, id);
    throw new ErrorPublico(429, mensaje);
  }
  return id;
}

// El intento salió bien: no cuenta como fallo.
export function quitarIntento(db, id) {
  return db.prepare("DELETE FROM intentos_acceso WHERE rowid = ?").bind(id).run();
}

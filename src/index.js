// ================================================================
// Ropero SG — servidor (Cloudflare Worker con Hono)
// ----------------------------------------------------------------
// Las páginas (HTML, CSS, JS, fotos) las entrega Cloudflare directo
// desde /public. Este archivo atiende solo lo que empieza con /api/
// y la tarea programada (cron) que anula pagos Webpay abandonados.
//
//   src/pedidos.js    catálogo, pedidos, "Mis pedidos", reembolsos
//   src/retorno.js    vuelta desde Webpay
//   src/admin.js      panel de voluntarias
//   src/auth.js       clave del panel y sesiones
//   src/webpay.js     conexión con Transbank
//   src/correo.js     correos (con src/plantillas.js)
//   src/db.js         consultas compartidas a la base de datos
//   src/validar.js    revisión de los datos que llegan
// ================================================================
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rutasAdmin } from "./admin.js";
import { expirarPedidosWebpay } from "./db.js";
import { rutasPublicas } from "./pedidos.js";
import { ErrorPublico, haceMs, UN_DIA_MS } from "./util.js";

const app = new Hono();

// Las respuestas de la API no se guardan en caché (salvo las fotos, que lo dicen ellas mismas).
app.use("/api/*", async (c, next) => {
  await next();
  if (!c.res.headers.has("Cache-Control")) c.res.headers.set("Cache-Control", "no-store");
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});

// Tamaño máximo de lo que se puede enviar: 32 KB en general y 1,5 MB para subir una foto.
const limiteNormal = bodyLimit({
  maxSize: 32 * 1024,
  onError: (c) => c.json({ error: "Los datos enviados son demasiado grandes." }, 413),
});
const limiteFoto = bodyLimit({
  maxSize: 1500000,
  onError: (c) => c.json({ error: "La foto es muy pesada: el máximo es 1,5 MB." }, 413),
});
const esSubidaDeFoto = (c) => c.req.method === "PUT" && /^\/api\/admin\/productos\/[^/]+\/imagen$/.test(c.req.path);
app.use("/api/*", (c, next) => (esSubidaDeFoto(c) ? limiteFoto(c, next) : limiteNormal(c, next)));

app.route("/api/admin", rutasAdmin);
app.route("/api", rutasPublicas);

app.notFound((c) => (c.req.path.startsWith("/api/")
  ? c.json({ error: "No encontramos lo que buscas." }, 404)
  : c.text("Página no encontrada", 404)));

app.onError((error, c) => {
  // Errores "esperados" (datos mal escritos, sin stock, etc.): su mensaje es para el usuario.
  if (error instanceof ErrorPublico) {
    return c.json({ error: error.message, ...error.extra }, error.estadoHttp);
  }
  console.error("Error inesperado:", error);
  return c.json({ error: "Ocurrió un error inesperado. Intenta de nuevo." }, 500);
});

// Tarea programada (cada 10 minutos, ver "triggers" en wrangler.jsonc).
async function scheduled(_evento, env) {
  try {
    const anulados = await expirarPedidosWebpay(env);
    if (anulados) console.log(`Cron: ${anulados} pedido(s) Webpay sin pagar se anularon y sus prendas volvieron al catálogo.`);
  } catch (error) {
    console.error("Cron: no se pudieron anular los pedidos Webpay vencidos:", error);
  }
  try {
    // Los intentos fallidos de entrar al panel se guardan solo un día.
    await env.DB.prepare("DELETE FROM intentos_acceso WHERE creado_en < ?").bind(haceMs(UN_DIA_MS)).run();
  } catch (error) {
    console.error("Cron: no se pudieron borrar los intentos de acceso antiguos:", error);
  }
}

export default { fetch: app.fetch, scheduled };

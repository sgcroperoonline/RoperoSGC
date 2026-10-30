// Rutas públicas de la tienda: catálogo, fotos, pedidos, "Mis pedidos" y reembolsos.
import { Hono } from "hono";
import { CONFIG } from "../public/js/datos.js";
import { configWebpay, correoActivo, origenPublico } from "./config.js";
import { enviarCorreosPedido } from "./correo.js";
import {
  cargarPedido, expirarPedidosWebpay, filaPedidoPorNumero, plazoReembolso,
  productoPublico, sentenciasCerrarPendiente,
} from "./db.js";
import { secretoDeSesiones } from "./auth.js";
import { anotarIntento, quitarIntento, redDeIp } from "./freno.js";
import { resolverPagoIncierto } from "./pagos.js";
import { retornoWebpay } from "./retorno.js";
import {
  aBase64Url, aHex, ahora, bytesAleatorios, ErrorPublico, igualesSeguro, leerJSON, textoLargo,
} from "./util.js";
import { correoValido, FORMATO_CODIGO, numeroPedidoValido, validarPedido } from "./validar.js";
import { crearTransaccion, ErrorWebpay } from "./webpay.js";

export const rutasPublicas = new Hono();

const NO_ENCONTRADO = "No encontramos un pedido con ese número y ese correo. Revisa que coincidan exactamente con los del comprobante.";

// Freno para quien prueba números de pedido con un correo: 10 fallos cada 15 minutos por IP.
const FRENO_PEDIDOS = {
  prefijo: "pedidos:", maximo: 10, ventanaMs: 15 * 60 * 1000,
  mensaje: "Demasiados intentos. Espera unos minutos y vuelve a intentarlo.",
};

// Máximo de pagos Webpay sin terminar desde una misma conexión a internet.
// Evita que alguien reserve todo el catálogo dejando pagos a medias (cada uno reserva sus
// prendas hasta 20 minutos). Una familia normal tiene como mucho uno: la tienda cancela
// el pago anterior antes de crear otro. Familias que comparten el Wi-Fi del colegio
// comparten la conexión, por eso el límite no es 1.
const MAXIMO_PAGOS_PENDIENTES = 5;
const MUCHOS_PAGOS_PENDIENTES = "Hay varios pagos con Webpay sin terminar desde esta misma conexión a internet. " +
  "Espera unos minutos y vuelve a intentarlo.";

// Huella de la conexión de quien compra (IP, o su bloque /64 si es IPv6), cifrada con el
// secreto del servidor: sirve para contar pagos pendientes sin guardar la dirección IP.
async function huellaDeRed(c) {
  const llave = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(await secretoDeSesiones(c.env.DB)),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign(
    "HMAC", llave, new TextEncoder().encode("red|" + redDeIp(c.req.header("CF-Connecting-IP"))));
  return aHex(new Uint8Array(firma)).slice(0, 32);
}

async function demasiadosPendientes(db, red) {
  const fila = await db.prepare(
    `SELECT COUNT(*) AS n FROM pedidos
     WHERE red_origen = ? AND metodo_pago = 'webpay' AND estado_pago = 'pendiente'`
  ).bind(red).first();
  return fila.n >= MAXIMO_PAGOS_PENDIENTES;
}

// Año en hora de Chile (el número de pedido lleva el año en que se hizo la compra).
const ANIO_CHILE = new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", year: "numeric" });

/* ----------------------------------------------------------------
   CONFIGURACIÓN Y CATÁLOGO
   ---------------------------------------------------------------- */

// GET /api/config — lo que la tienda necesita saber del servidor.
rutasPublicas.get("/config", (c) => c.json({
  webpay: { ambiente: configWebpay(c.env).ambiente },
  pagos: {
    webpay: CONFIG.pagos?.webpay === true,
    transferencia: CONFIG.pagos?.transferencia === true,
    efectivo: CONFIG.pagos?.efectivo === true,
  },
  diasReembolso: CONFIG.diasReembolso,
  datosTransferencia: CONFIG.datosTransferencia,
  correo: { activo: correoActivo(c.env) },
}));

// GET /api/productos — prendas publicadas (las con stock 0 se muestran como "Vendida").
rutasPublicas.get("/productos", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM productos WHERE publicado = 1 ORDER BY creado_en ASC, id ASC"
  ).all();
  return c.json({ productos: results.map(productoPublico) });
});

// GET /api/imagenes/:id — foto subida desde el panel.
// Leer la foto de D1 gasta CPU, así que se guarda en la caché de Cloudflare (caches.default).
// La llave de la caché lleva la fecha de la foto en la base: si se cambia o se borra la foto,
// nunca se entrega la antigua. (En *.workers.dev la caché no guarda nada; con dominio propio sí.)
rutasPublicas.get("/imagenes/:id", async (c) => {
  const id = c.req.param("id").toUpperCase();
  const db = c.env.DB;
  const datos = FORMATO_CODIGO.test(id)
    ? await db.prepare("SELECT tipo_mime, actualizado_en FROM imagenes WHERE producto_id = ?").bind(id).first()
    : null;
  if (!datos) throw new ErrorPublico(404, "No encontramos esa foto.");

  const llave = new URL(`/api/imagenes/${encodeURIComponent(id)}?foto=${encodeURIComponent(datos.actualizado_en)}`, c.req.url);
  const cache = globalThis.caches?.default;
  const guardada = cache ? await cache.match(llave).catch(() => null) : null;
  if (guardada) return new Response(guardada.body, guardada);

  const fila = await db.prepare("SELECT datos FROM imagenes WHERE producto_id = ?").bind(id).first();
  if (!fila) throw new ErrorPublico(404, "No encontramos esa foto.");
  // D1 entrega el BLOB como una lista de números (o como ArrayBuffer): se pasa a bytes de una vez.
  const respuesta = new Response(new Uint8Array(fila.datos), {
    headers: {
      "Content-Type": datos.tipo_mime,
      // La dirección cambia (?v=…) cada vez que se sube otra foto, así que se puede guardar para siempre.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
  if (cache) c.executionCtx.waitUntil(cache.put(llave, respuesta.clone()).catch(() => {}));
  return respuesta;
});

/* ----------------------------------------------------------------
   CREAR PEDIDO
   ---------------------------------------------------------------- */

// Error 409 con la lista de prendas que ya no se pueden comprar.
function errorSinStock(ids, prendasPorId) {
  const nombres = ids.map((id) => (prendasPorId.get(id)?.nombre ? `${prendasPorId.get(id).nombre} (${id})` : id));
  const inicio = ids.length === 1 ? "Esta prenda ya no está disponible" : "Estas prendas ya no están disponibles";
  return new ErrorPublico(409, `${inicio}: ${nombres.join(", ")}.`, { sinStock: ids });
}

// Lee las prendas pedidas desde la base de datos (nunca se confía en el precio que manda el navegador).
async function leerPrendas(db, items) {
  const ids = items.map((i) => i.id);
  const { results } = await db.prepare(
    `SELECT * FROM productos WHERE id IN (${ids.map(() => "?").join(", ")})`
  ).bind(...ids).all();
  const porId = new Map(results.map((p) => [p.id, p]));
  const sinStock = items
    .filter((i) => { const p = porId.get(i.id); return !p || p.publicado !== 1 || p.stock < i.cant; })
    .map((i) => i.id);
  return { porId, sinStock };
}

// POST /api/pedidos
rutasPublicas.post("/pedidos", async (c) => {
  const env = c.env;
  const db = env.DB;
  const datos = validarPedido(await leerJSON(c));

  // Webpay en producción sin credenciales propias: mejor no reservar nada.
  const webpay = configWebpay(env);
  if (datos.pago === "webpay" && webpay.error) {
    console.error(webpay.error);
    throw new ErrorPublico(503, `El pago con Webpay no está disponible en este momento. Escríbenos a ${CONFIG.correo}.`);
  }

  // Primero se liberan las prendas de pagos Webpay abandonados (lo mismo que hace el cron).
  try {
    await expirarPedidosWebpay(env);
  } catch (error) {
    console.error("No se pudieron anular los pagos Webpay vencidos:", error);
  }

  // Revisar que cada prenda exista, esté publicada y tenga stock.
  const { porId, sinStock } = await leerPrendas(db, datos.items);
  if (sinStock.length) throw errorSinStock(sinStock, porId);

  // El total se calcula AQUÍ con los precios de la base de datos.
  const items = datos.items.map((i) => ({ ...i, prenda: porId.get(i.id) }));
  const total = items.reduce((suma, i) => suma + i.prenda.precio * i.cant, 0);
  if (datos.pago === "webpay" && total <= 0) {
    throw new ErrorPublico(400, "El total del pedido es $0: no se puede pagar con Webpay.");
  }

  // Límite de pagos Webpay sin terminar por conexión (ver MAXIMO_PAGOS_PENDIENTES).
  const red = datos.pago === "webpay" ? await huellaDeRed(c) : null;
  if (red && await demasiadosPendientes(db, red)) throw new ErrorPublico(429, MUCHOS_PAGOS_PENDIENTES);

  // Todo el pedido se guarda en UN solo batch: o se guarda completo o no se guarda nada.
  const tokenAcceso = aBase64Url(bytesAleatorios(24));
  const momento = ahora();
  const { comprador, retira } = datos;
  const sentencias = [
    // El pedido solo se inserta si esa conexión no llegó al límite de pagos pendientes.
    // La cuenta se hace DENTRO del batch, así que muchas peticiones simultáneas no lo saltan.
    // Si no se inserta, el INSERT de los ítems falla (pedido_id NOT NULL) y se deshace todo.
    db.prepare(
      `INSERT INTO pedidos (token_acceso, comprador_nombre, comprador_correo, comprador_fono,
         retira_tipo, retira_nombre, retira_extra, metodo_pago, total, red_origen, creado_en, actualizado_en)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
       WHERE ?10 IS NULL OR (SELECT COUNT(*) FROM pedidos
         WHERE red_origen = ?10 AND metodo_pago = 'webpay' AND estado_pago = 'pendiente') < ?13`
    ).bind(tokenAcceso, comprador.nombre, comprador.correo, comprador.fono,
      retira.tipo, retira.nombre, retira.extra, datos.pago, total, red, momento, momento,
      MAXIMO_PAGOS_PENDIENTES),
    // El número sale del id que le dio la base de datos: RSG-2026-1001, RSG-2026-1002, …
    db.prepare(
      `UPDATE pedidos SET numero = 'RSG-' || ? || '-' || (1000 + id)
       WHERE token_acceso = ? RETURNING id, numero`
    ).bind(ANIO_CHILE.format(new Date(momento)), tokenAcceso),
    // Copia de las características de cada prenda al momento de comprar.
    ...items.map((i) => db.prepare(
      `INSERT INTO pedido_items (pedido_id, producto_id, nombre, tipo, marca, talla, estado, precio_unitario, cantidad)
       VALUES ((SELECT id FROM pedidos WHERE token_acceso = ?), ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(tokenAcceso, i.id, i.prenda.nombre, i.prenda.tipo, i.prenda.marca, i.prenda.talla,
      i.prenda.estado, i.prenda.precio, i.cant)),
    // Descontar stock. Si alguien compró la última unidad un instante antes, el CHECK (stock >= 0)
    // falla y la base de datos deshace TODO el batch.
    ...items.map((i) => db.prepare(
      "UPDATE productos SET stock = stock - ?, actualizado_en = ? WHERE id = ?"
    ).bind(i.cant, momento, i.id)),
  ];

  let resultados;
  try {
    resultados = await db.batch(sentencias);
  } catch (error) {
    if (/CHECK constraint failed/i.test(String(error?.message || error))) {
      const revision = await leerPrendas(db, datos.items);
      throw errorSinStock(revision.sinStock.length ? revision.sinStock : items.map((i) => i.id), porId);
    }
    if (red && await demasiadosPendientes(db, red)) throw new ErrorPublico(429, MUCHOS_PAGOS_PENDIENTES);
    throw error;
  }
  const { id: pedidoId, numero } = resultados[1].results[0];

  // Si una prenda se borró justo entre la revisión y el batch, su stock no se descontó:
  // se anula el pedido (devolviendo el stock de las demás) y se avisa.
  const primeraDeStock = 2 + items.length;
  const borradas = items.filter((_, k) => !resultados[primeraDeStock + k].meta.changes).map((i) => i.id);
  if (borradas.length) {
    await db.batch(sentenciasCerrarPendiente(db, pedidoId, {
      nuevoEstado: "anulado", motivo: "Una prenda dejó de existir mientras se creaba el pedido",
    }));
    throw errorSinStock(borradas, porId);
  }

  const origen = origenPublico(env, c.req.url);

  // Transferencia o efectivo: el pedido queda pendiente y se mandan los correos.
  if (datos.pago !== "webpay") {
    c.executionCtx.waitUntil(enviarCorreosPedido(env, pedidoId, origen));
    return c.json({ numero, token: tokenAcceso }, 201);
  }

  // Webpay: se crea la transacción en Transbank y el navegador va a pagar allá.
  const idSesion = aHex(bytesAleatorios(16)); // 32 caracteres hexadecimales
  let transbank;
  try {
    transbank = await crearTransaccion(env, {
      ordenCompra: numero, idSesion, monto: total, urlRetorno: origen + "/api/webpay/retorno",
    });
  } catch (error) {
    if (!(error instanceof ErrorWebpay)) throw error;
    console.error(`Webpay no creó la transacción del pedido ${numero}:`, error.message);
    const cuando = ahora();
    // Se anota el error, se anula el pedido y las prendas vuelven al catálogo (todo junto).
    await db.batch([
      db.prepare(
        `INSERT INTO transacciones (pedido_id, tipo, ambiente, orden_compra, id_sesion, monto, estado,
           detalle_error, creado_en, actualizado_en)
         VALUES (?, 'pago', ?, ?, ?, ?, 'error', ?, ?, ?)`
      ).bind(pedidoId, webpay.ambiente, numero, idSesion, total, error.message.slice(0, 500), cuando, cuando),
      ...sentenciasCerrarPendiente(db, pedidoId, {
        nuevoEstado: "anulado", motivo: "No se pudo conectar con Webpay", momento: cuando,
      }),
    ]);
    throw new ErrorPublico(502, "No pudimos conectar con Webpay. Intenta de nuevo en unos minutos.");
  }

  const cuando = ahora();
  await db.prepare(
    `INSERT INTO transacciones (pedido_id, tipo, ambiente, token, orden_compra, id_sesion, monto, estado,
       creado_en, actualizado_en)
     VALUES (?, 'pago', ?, ?, ?, ?, ?, 'iniciada', ?, ?)`
  ).bind(pedidoId, webpay.ambiente, transbank.token, numero, idSesion, total, cuando, cuando).run();

  return c.json({ numero, token: tokenAcceso, webpay: { url: transbank.url, token: transbank.token } }, 201);
});

// Vuelta desde Webpay (puede llegar por GET o por POST de formulario).
rutasPublicas.on(["GET", "POST"], "/webpay/retorno", retornoWebpay);

/* ----------------------------------------------------------------
   VER Y BUSCAR PEDIDOS
   ---------------------------------------------------------------- */

// POST /api/pedidos/buscar  { numero, correo }  ("Mis pedidos")
// Los números son correlativos: cada búsqueda fallida cuenta para el freno (429).
rutasPublicas.post("/pedidos/buscar", async (c) => {
  const cuerpo = await leerJSON(c);
  const intento = await anotarIntento(c, FRENO_PEDIDOS);
  const numero = numeroPedidoValido(cuerpo.numero);
  const correo = correoValido(cuerpo.correo);
  const fila = numero && correo
    ? await c.env.DB.prepare("SELECT id FROM pedidos WHERE numero = ? AND comprador_correo = ?").bind(numero, correo).first()
    : null;
  if (!fila) throw new ErrorPublico(404, NO_ENCONTRADO);
  await quitarIntento(c.env.DB, intento);
  return c.json({ pedido: await cargarPedido(c.env.DB, fila.id) });
});

// El pedido con ese número y ese token del comprobante; si no calzan, 404.
async function filaConToken(db, numeroCrudo, token) {
  const numero = numeroPedidoValido(numeroCrudo);
  const fila = numero && typeof token === "string" && token.length >= 16 && token.length <= 100
    ? await filaPedidoPorNumero(db, numero)
    : null;
  if (!fila || !(await igualesSeguro(token, fila.token_acceso))) {
    throw new ErrorPublico(404, "No encontramos ese pedido.");
  }
  return fila;
}

// GET /api/pedidos/:numero?t=<token>  (comprobante después de pagar)
rutasPublicas.get("/pedidos/:numero", async (c) => {
  const fila = await filaConToken(c.env.DB, c.req.param("numero"), c.req.query("t"));
  return c.json({ pedido: await cargarPedido(c.env.DB, fila.id) });
});

// POST /api/pedidos/:numero/cancelar  { t }
// El comprador volvió a la tienda sin terminar de pagar en Webpay (botón "Atrás"):
// se anula el pedido y sus prendas vuelven al catálogo para que pueda comprar de nuevo.
// Si el pago se está confirmando justo ahora, o el pedido ya no está pendiente, no cambia nada.
// Si su confirmación quedó a medias, primero se le pregunta a Transbank si se cobró.
rutasPublicas.post("/pedidos/:numero/cancelar", async (c) => {
  const db = c.env.DB;
  const cuerpo = await leerJSON(c);
  const fila = await filaConToken(db, c.req.param("numero"), cuerpo.t);
  if (fila.metodo_pago === "webpay" && fila.estado_pago === "pendiente") {
    const motivo = "Pago abandonado: el comprador volvió a la tienda";
    const resultados = await db.batch(sentenciasCerrarPendiente(db, fila.id, {
      nuevoEstado: "anulado", motivo, estadoTransaccion: "abortada",
    }));
    if (!resultados[resultados.length - 1].results.length) {
      await resolverPagoIncierto(c.env, fila.id, {
        nuevoEstado: "anulado", motivo, origen: origenPublico(c.env, c.req.url),
        enSegundoPlano: (promesa) => c.executionCtx.waitUntil(promesa),
      });
    }
  }
  return c.json({ pedido: await cargarPedido(db, fila.id) });
});

// POST /api/pedidos/:numero/reembolso  { correo? , t?, motivo }
rutasPublicas.post("/pedidos/:numero/reembolso", async (c) => {
  const db = c.env.DB;
  const cuerpo = await leerJSON(c);
  const numero = numeroPedidoValido(c.req.param("numero"));
  const fila = numero ? await filaPedidoPorNumero(db, numero) : null;

  // Se identifica con el token del comprobante o con el correo del pedido.
  // Con el correo cuenta el mismo freno que en "Mis pedidos" (429).
  let identificado = false;
  if (fila && typeof cuerpo.t === "string" && cuerpo.t && cuerpo.t.length <= 100) {
    identificado = await igualesSeguro(cuerpo.t, fila.token_acceso);
  }
  if (!identificado && cuerpo.correo !== undefined) {
    const intento = await anotarIntento(c, FRENO_PEDIDOS);
    identificado = Boolean(fila) && correoValido(cuerpo.correo) === fila.comprador_correo;
    if (identificado) await quitarIntento(db, intento);
  }
  if (!identificado) throw new ErrorPublico(404, NO_ENCONTRADO);

  const previo = await db.prepare("SELECT 1 AS hay FROM reembolsos WHERE pedido_id = ?").bind(fila.id).first();
  if (previo) throw new ErrorPublico(409, "Ya pediste un reembolso para este pedido.");
  if (fila.estado_pago !== "pagado") throw new ErrorPublico(409, "Solo se puede pedir reembolso de un pedido pagado.");
  if (!plazoReembolso(fila, false).dentroDelPlazo) {
    throw new ErrorPublico(409, `El plazo de ${CONFIG.diasReembolso} días para pedir reembolso ya venció. Escríbenos a ${CONFIG.correo} y lo vemos caso a caso.`);
  }

  const motivo = textoLargo(cuerpo.motivo);
  if (motivo.length < 10) throw new ErrorPublico(400, "Cuéntanos el motivo del reembolso (al menos 10 caracteres).");
  if (motivo.length > 1000) throw new ErrorPublico(400, "El motivo es muy largo: máximo 1000 caracteres.");

  let resultado;
  try {
    // Solo se guarda si el pedido sigue pagado en este mismo instante.
    resultado = await db.prepare(
      `INSERT INTO reembolsos (pedido_id, motivo, estado, solicitado_en)
       SELECT ?1, ?2, 'solicitado', ?3 WHERE EXISTS (SELECT 1 FROM pedidos WHERE id = ?1 AND estado_pago = 'pagado')`
    ).bind(fila.id, motivo, ahora()).run();
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || error))) {
      throw new ErrorPublico(409, "Ya pediste un reembolso para este pedido.");
    }
    throw error;
  }
  if (!resultado.meta.changes) throw new ErrorPublico(409, "Solo se puede pedir reembolso de un pedido pagado.");

  return c.json({ pedido: await cargarPedido(db, fila.id) }, 201);
});

// Vuelta del comprador desde Webpay (return_url). Transbank puede volver de 4 formas:
//   1. Normal:    solo token_ws                       -> se confirma (commit) el pago
//   2. Timeout:   TBK_ORDEN_COMPRA + TBK_ID_SESION     -> se acabó el tiempo en el formulario
//   3. Abortado:  TBK_TOKEN (+ orden y sesión)         -> el comprador apretó "Anular compra"
//   4. Atípico:   token_ws Y TBK_TOKEN juntos          -> pago inválido, NO se confirma
// Siempre termina redirigiendo (303) a la tienda, que muestra el resultado.
import { origenPublico } from "./config.js";
import { marcarExpiradaSiSigueIniciada, sentenciasCerrarPendiente } from "./db.js";
import { confirmarConReserva, reservarConfirmacion } from "./pagos.js";

const irAPedido = (c, tx) =>
  c.redirect(`/?pedido=${encodeURIComponent(tx.numero)}&t=${encodeURIComponent(tx.token_acceso)}`, 303);
const irAError = (c) => c.redirect("/?pago=error", 303);

// Solo letras, números, guion, punto y guion bajo (así son los tokens y números de Transbank).
const FORMATO_PARAMETRO = /^[\w.-]{1,200}$/;

// Junta los datos que mandó Transbank (en la URL o en el formulario).
// Devuelve null si alguno viene con un formato extraño.
async function leerParametros(c) {
  const datos = { ...c.req.query() };
  if (c.req.method === "POST") {
    try {
      const cuerpo = await c.req.parseBody();
      for (const [clave, valor] of Object.entries(cuerpo)) {
        if (typeof valor === "string") datos[clave] = valor;
      }
    } catch {
      // Formulario ilegible: se usan solo los datos de la URL.
    }
  }
  const resultado = {};
  for (const [clave, nombre] of [["token_ws", "tokenWs"], ["TBK_TOKEN", "tbkToken"],
                                 ["TBK_ORDEN_COMPRA", "ordenCompra"], ["TBK_ID_SESION", "idSesion"]]) {
    const valor = typeof datos[clave] === "string" ? datos[clave].trim() : "";
    if (valor && !FORMATO_PARAMETRO.test(valor)) return null;
    resultado[nombre] = valor;
  }
  return resultado;
}

// Busca el intento de pago (y su pedido) con una condición fija de este archivo.
function buscarTransaccion(db, donde, ...valores) {
  return db.prepare(
    `SELECT t.id, t.pedido_id, t.token, t.monto, t.estado, p.numero, p.token_acceso, p.estado_pago
     FROM transacciones t JOIN pedidos p ON p.id = t.pedido_id
     WHERE t.tipo = 'pago' AND ${donde}`
  ).bind(...valores).first();
}

/* ---------------- Caso 1: confirmar el pago ---------------- */
async function confirmarPago(c, tx) {
  const env = c.env;
  const db = env.DB;

  // Ya estaba pagado (por ejemplo, el comprador recargó la página): no se llama a Transbank.
  if (tx.estado_pago === "pagado") return irAPedido(c, tx);

  // El pedido ya se anuló (expiró, lo anuló el ropero…): NO se confirma. Transbank reversa solo.
  if (tx.estado_pago !== "pendiente") {
    await marcarExpiradaSiSigueIniciada(db, tx.id);
    return irAPedido(c, tx);
  }

  // Reserva para confirmar (ver db.js): solo una petición a la vez puede confirmar este pago,
  // y desde ahora nadie puede anular el pedido sin preguntarle antes a Transbank.
  const reserva = await reservarConfirmacion(db, tx.id);
  if (!reserva) {
    // Otra petición lo está confirmando ahora (la tienda mostrará "Estamos confirmando tu pago"),
    // o el pedido se anuló recién.
    await marcarExpiradaSiSigueIniciada(db, tx.id);
    return irAPedido(c, tx);
  }

  // Pagado, rechazado por el banco o, si Transbank no contesta, pendiente hasta saberlo.
  await confirmarConReserva(env, tx, reserva, {
    nuevoEstado: "rechazado",
    motivo: "Pago rechazado en Webpay",
    origen: origenPublico(env, c.req.url),
    enSegundoPlano: (promesa) => c.executionCtx.waitUntil(promesa),
  });
  return irAPedido(c, tx);
}

/* -------- Casos 2, 3 y 4: el pago no se hizo, se anula el pedido -------- */
async function cerrarSinPagar(c, tx, estadoTransaccion, motivo) {
  // Si alguien empezó a confirmar este pago, o el pedido ya no está pendiente, estas
  // sentencias no cambian nada (ver db.js); si quedó a medias, lo resuelve el cron.
  await c.env.DB.batch(sentenciasCerrarPendiente(c.env.DB, tx.pedido_id, {
    nuevoEstado: "anulado", motivo, estadoTransaccion,
  }));
  return irAPedido(c, tx);
}

/** GET|POST /api/webpay/retorno */
export async function retornoWebpay(c) {
  const db = c.env.DB;
  const p = await leerParametros(c);
  if (!p) return irAError(c);

  // Caso 4: token_ws y TBK_TOKEN juntos -> pago inválido, sin confirmar.
  if (p.tokenWs && p.tbkToken) {
    const tx = await buscarTransaccion(db, "t.token = ?", p.tokenWs)
      || await buscarTransaccion(db, "t.token = ?", p.tbkToken);
    if (!tx) return irAError(c);
    return cerrarSinPagar(c, tx, "invalida", "Pago inválido en Webpay");
  }

  // Caso 1: vuelta normal con token_ws.
  if (p.tokenWs) {
    const tx = await buscarTransaccion(db, "t.token = ?", p.tokenWs);
    if (!tx) return irAError(c);
    return confirmarPago(c, tx);
  }

  // Caso 3: el comprador anuló la compra en Webpay.
  if (p.tbkToken) {
    const tx = await buscarTransaccion(db, "t.token = ?", p.tbkToken);
    if (!tx) return irAError(c);
    return cerrarSinPagar(c, tx, "abortada", "Pago cancelado en Webpay");
  }

  // Caso 2: se acabó el tiempo. Tienen que calzar la orden de compra Y la sesión
  // (la sesión es aleatoria y nadie más la conoce); si no calzan, no se toca nada.
  if (p.ordenCompra && p.idSesion) {
    const tx = await buscarTransaccion(db, "t.orden_compra = ? AND t.id_sesion = ?", p.ordenCompra, p.idSesion);
    if (!tx) return irAError(c);
    return cerrarSinPagar(c, tx, "expirada", "Se acabó el tiempo para pagar en Webpay");
  }

  return irAError(c);
}

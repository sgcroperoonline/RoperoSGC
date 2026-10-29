// Vuelta del comprador desde Webpay (return_url). Transbank puede volver de 4 formas:
//   1. Normal:    solo token_ws                       -> se confirma (commit) el pago
//   2. Timeout:   TBK_ORDEN_COMPRA + TBK_ID_SESION     -> se acabó el tiempo en el formulario
//   3. Abortado:  TBK_TOKEN (+ orden y sesión)         -> el comprador apretó "Anular compra"
//   4. Atípico:   token_ws Y TBK_TOKEN juntos          -> pago inválido, NO se confirma
// Siempre termina redirigiendo (303) a la tienda, que muestra el resultado.
import { origenPublico } from "./config.js";
import { enviarCorreosPedido } from "./correo.js";
import { limiteReserva, marcarExpiradaSiSigueIniciada, sentenciasCerrarPendiente } from "./db.js";
import { ahora } from "./util.js";
import { confirmarTransaccion, estadoTransaccion, pagoAutorizado } from "./webpay.js";

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

// Datos útiles de la respuesta de Transbank, listos para guardar.
function camposRespuesta(r) {
  const texto = (valor, largo = 40) => (valor === undefined || valor === null ? null : String(valor).slice(0, largo));
  const entero = (valor) => (Number.isInteger(valor) ? valor : null);
  // Transbank solo manda los últimos 4 dígitos; igual se recortan por seguridad.
  const ultimos4 = r?.card_detail?.card_number ? String(r.card_detail.card_number).replace(/\D/g, "").slice(-4) : null;
  let json = null;
  if (r) {
    const copia = JSON.parse(JSON.stringify(r));
    if (copia.card_detail && typeof copia.card_detail === "object") copia.card_detail.card_number = ultimos4;
    json = JSON.stringify(copia).slice(0, 4000);
  }
  return {
    codigoRespuesta: entero(r?.response_code),
    codigoAutorizacion: texto(r?.authorization_code, 20),
    tipoPago: texto(r?.payment_type_code, 5),
    cuotas: entero(r?.installments_number),
    tarjeta: ultimos4,
    fechaTransaccion: texto(r?.transaction_date),
    fechaContable: texto(r?.accounting_date, 10),
    vci: texto(r?.vci, 10),
    json,
  };
}

// Actualiza el intento de pago con la respuesta de Transbank.
function sentenciaTransaccion(db, tx, estado, respuesta, detalleError, momento, soloSiIniciada) {
  const d = camposRespuesta(respuesta);
  return db.prepare(
    `UPDATE transacciones
     SET estado = ?, codigo_respuesta = ?, codigo_autorizacion = ?, tipo_pago = ?, cuotas = ?,
         tarjeta_ultimos4 = ?, fecha_transaccion = ?, fecha_contable = ?, vci = ?, respuesta_json = ?,
         detalle_error = ?, actualizado_en = ?
     WHERE id = ?${soloSiIniciada ? " AND estado = 'iniciada'" : ""}`
  ).bind(estado, d.codigoRespuesta, d.codigoAutorizacion, d.tipoPago, d.cuotas, d.tarjeta, d.fechaTransaccion,
    d.fechaContable, d.vci, d.json, detalleError ? String(detalleError).slice(0, 500) : null, momento, tx.id);
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
  // y mientras tanto nadie puede anular el pedido.
  const momento = ahora();
  const reserva = await db.prepare(
    `UPDATE transacciones SET actualizado_en = ?2
     WHERE id = ?1 AND estado = 'iniciada'
       AND NOT (actualizado_en > creado_en AND actualizado_en > ?3)
       AND EXISTS (SELECT 1 FROM pedidos WHERE id = transacciones.pedido_id AND estado_pago = 'pendiente')`
  ).bind(tx.id, momento, limiteReserva(momento)).run();
  if (!reserva.meta.changes) {
    // Otra petición lo está confirmando ahora (la tienda mostrará "Estamos confirmando tu pago"),
    // o el pedido se anuló recién.
    await marcarExpiradaSiSigueIniciada(db, tx.id);
    return irAPedido(c, tx);
  }

  let respuesta = null;
  let errorConfirmar = null;
  try {
    respuesta = await confirmarTransaccion(env, tx.token);
  } catch (error) {
    errorConfirmar = error?.message || String(error);
    console.error(`Falló la confirmación Webpay del pedido ${tx.numero}:`, errorConfirmar);
    // Puede que el cobro sí se haya hecho y se perdiera la respuesta: se pregunta el estado.
    try {
      respuesta = await estadoTransaccion(env, tx.token);
    } catch (error2) {
      errorConfirmar += ` | Estado: ${error2?.message || error2}`;
      respuesta = null;
    }
  }

  const cuando = ahora();

  if (respuesta && pagoAutorizado(respuesta)) {
    // ¡Pagado! Transacción autorizada y pedido pagado, juntos.
    const [, pedido] = await db.batch([
      sentenciaTransaccion(db, tx, "autorizada", respuesta, null, cuando, false),
      db.prepare(
        `UPDATE pedidos SET estado_pago = 'pagado', pagado_en = ?, actualizado_en = ?
         WHERE id = ? AND estado_pago = 'pendiente' RETURNING id`
      ).bind(cuando, cuando, tx.pedido_id),
    ]);
    if (pedido.results.length) {
      c.executionCtx.waitUntil(enviarCorreosPedido(env, tx.pedido_id, origenPublico(env, c.req.url)));
    } else {
      const actual = await db.prepare("SELECT estado_pago FROM pedidos WHERE id = ?").bind(tx.pedido_id).first();
      if (actual?.estado_pago !== "pagado") {
        // No debería pasar gracias a la reserva, pero si pasa queda a la vista en el panel.
        const aviso = "Webpay autorizó el pago, pero el pedido ya estaba anulado: hay que devolver el dinero al comprador.";
        console.error(`ALERTA pedido ${tx.numero}: ${aviso}`);
        await db.prepare("UPDATE transacciones SET detalle_error = ? WHERE id = ?").bind(aviso, tx.id).run();
      }
    }
    return irAPedido(c, tx);
  }

  // Rechazado por el banco (Transbank contestó, pero no autorizó) o error al confirmar.
  // La transacción se cierra y las prendas vuelven al catálogo, todo junto.
  const estado = errorConfirmar ? "error" : "rechazada";
  const motivo = errorConfirmar ? "No se pudo confirmar el pago en Webpay" : "Pago rechazado en Webpay";
  await db.batch([
    sentenciaTransaccion(db, tx, estado, respuesta, errorConfirmar, cuando, true),
    ...sentenciasCerrarPendiente(db, tx.pedido_id, { nuevoEstado: "rechazado", motivo, momento: cuando }),
  ]);
  return irAPedido(c, tx);
}

/* -------- Casos 2, 3 y 4: el pago no se hizo, se anula el pedido -------- */
async function cerrarSinPagar(c, tx, estadoTransaccion, motivo) {
  // Si alguien está confirmando este pago justo ahora, o el pedido ya no está pendiente,
  // estas sentencias no cambian nada (ver db.js).
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

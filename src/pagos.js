// Confirmar pagos Webpay con Transbank y resolver los que quedaron con resultado incierto.
// Un pedido solo pasa a "pagado" o se cierra sin pago cuando Transbank lo dice; si
// Transbank no contesta, el pedido sigue pendiente y el cron vuelve a preguntar.
import { origenPublico } from "./config.js";
import { enviarCorreosPedido } from "./correo.js";
import { limiteReserva, sentenciasCerrarPendiente } from "./db.js";
import { ahora } from "./util.js";
import { confirmarTransaccion, ESTADOS_SIN_COBRO, estadoTransaccion, pagoAutorizado } from "./webpay.js";

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
// Con "reserva", solo si sigue "iniciada" y reservada por quien la llama.
function sentenciaTransaccion(db, txId, estado, respuesta, detalleError, momento, reserva = null) {
  const d = camposRespuesta(respuesta);
  return db.prepare(
    `UPDATE transacciones
     SET estado = ?, codigo_respuesta = ?, codigo_autorizacion = ?, tipo_pago = ?, cuotas = ?,
         tarjeta_ultimos4 = ?, fecha_transaccion = ?, fecha_contable = ?, vci = ?, respuesta_json = ?,
         detalle_error = ?, actualizado_en = ?
     WHERE id = ?${reserva ? " AND estado = 'iniciada' AND actualizado_en = ?" : ""}`
  ).bind(estado, d.codigoRespuesta, d.codigoAutorizacion, d.tipoPago, d.cuotas, d.tarjeta, d.fechaTransaccion,
    d.fechaContable, d.vci, d.json, detalleError ? String(detalleError).slice(0, 500) : null, momento, txId,
    ...(reserva ? [reserva] : []));
}

/**
 * Reserva el intento de pago para confirmarlo (ver db.js): solo un proceso a la vez.
 * Si otro la tomó hace menos de 2 minutos, o el pedido ya no está pendiente, devuelve null.
 * Si no, devuelve el momento de la reserva.
 */
export async function reservarConfirmacion(db, txId) {
  const momento = ahora();
  const reserva = await db.prepare(
    `UPDATE transacciones SET actualizado_en = ?2
     WHERE id = ?1 AND estado = 'iniciada'
       AND NOT (actualizado_en > creado_en AND actualizado_en > ?3)
       AND EXISTS (SELECT 1 FROM pedidos WHERE id = transacciones.pedido_id AND estado_pago = 'pendiente')`
  ).bind(txId, momento, limiteReserva(momento)).run();
  return reserva.meta.changes ? momento : null;
}

/**
 * Pide a Transbank confirmar (commit) el pago. Si la respuesta no llega, pregunta el estado.
 * Devuelve { resultado, respuesta, error } con resultado:
 *   "pagado"    Transbank autorizó el pago
 *   "rechazado" Transbank dice que no se autorizó (no hubo cobro)
 *   "incierto"  no se sabe (Transbank no contestó): el pedido no se toca
 */
async function preguntarATransbank(env, token) {
  let errorConfirmar;
  try {
    const respuesta = await confirmarTransaccion(env, token);
    return { resultado: pagoAutorizado(respuesta) ? "pagado" : "rechazado", respuesta, error: null };
  } catch (error) {
    errorConfirmar = error;
  }
  const mensaje = errorConfirmar?.message || String(errorConfirmar);
  try {
    const respuesta = await estadoTransaccion(env, token);
    if (pagoAutorizado(respuesta)) return { resultado: "pagado", respuesta, error: mensaje };
    // "INITIALIZED" solo es definitivo si Transbank además rechazó la confirmación:
    // si no contestó, puede que todavía la esté procesando.
    const rechazoLaConfirmacion = errorConfirmar?.estadoHttp >= 400 && errorConfirmar?.estadoHttp < 500;
    if (ESTADOS_SIN_COBRO.includes(respuesta?.status) || (respuesta?.status === "INITIALIZED" && rechazoLaConfirmacion)) {
      return { resultado: "rechazado", respuesta, error: mensaje };
    }
    return { resultado: "incierto", respuesta: null, error: `${mensaje} | Estado: ${respuesta?.status ?? "sin estado"}` };
  } catch (error) {
    return { resultado: "incierto", respuesta: null, error: `${mensaje} | Estado: ${error?.message || error}` };
  }
}

/**
 * Confirma con Transbank un pago ya reservado y guarda el resultado.
 *   pagado    -> transacción autorizada, pedido pagado y correos
 *   rechazado -> transacción rechazada, pedido en "nuevoEstado" y las prendas vuelven al catálogo
 *   incierto  -> todo sigue igual (pendiente, prendas reservadas); se anota el error
 * Devuelve "pagado", nuevoEstado o "incierto".
 */
export async function confirmarConReserva(env, tx, reserva, { nuevoEstado, motivo, origen, enSegundoPlano }) {
  const db = env.DB;
  const r = await preguntarATransbank(env, tx.token);
  const cuando = ahora();

  if (r.resultado === "pagado") {
    // ¡Pagado! Transacción autorizada y pedido pagado, juntos.
    const [, pedido] = await db.batch([
      sentenciaTransaccion(db, tx.id, "autorizada", r.respuesta, null, cuando),
      db.prepare(
        `UPDATE pedidos SET estado_pago = 'pagado', pagado_en = ?, actualizado_en = ?
         WHERE id = ? AND estado_pago = 'pendiente' RETURNING id`
      ).bind(cuando, cuando, tx.pedido_id),
    ]);
    if (pedido.results.length) {
      enSegundoPlano(enviarCorreosPedido(env, tx.pedido_id, origen));
    } else {
      const actual = await db.prepare("SELECT estado_pago FROM pedidos WHERE id = ?").bind(tx.pedido_id).first();
      if (actual?.estado_pago !== "pagado") {
        // No debería pasar gracias a la reserva, pero si pasa queda a la vista en el panel.
        const aviso = "Webpay autorizó el pago, pero el pedido ya estaba anulado: hay que devolver el dinero al comprador.";
        console.error(`ALERTA pedido ${tx.numero}: ${aviso}`);
        await db.prepare("UPDATE transacciones SET detalle_error = ? WHERE id = ?").bind(aviso, tx.id).run();
      }
    }
    return "pagado";
  }

  if (r.resultado === "rechazado") {
    // Transbank dice que no hubo cobro: la transacción se cierra y las prendas vuelven, todo junto.
    await db.batch([
      sentenciaTransaccion(db, tx.id, "rechazada", r.respuesta, r.error, cuando, reserva),
      ...sentenciasCerrarPendiente(db, tx.pedido_id, { nuevoEstado, motivo, momento: cuando }),
    ]);
    return nuevoEstado;
  }

  // No se sabe si se cobró: el pedido queda pendiente (la tienda muestra "Estamos confirmando
  // tu pago") y la transacción sigue reservada. El cron vuelve a preguntar más tarde.
  console.error(`No se pudo confirmar el pago Webpay del pedido ${tx.numero}; queda pendiente:`, r.error);
  await db.prepare(
    `UPDATE transacciones SET detalle_error = ?, actualizado_en = ?
     WHERE id = ? AND estado = 'iniciada' AND actualizado_en = ?`
  ).bind(r.error.slice(0, 500), cuando, tx.id, reserva).run();
  return "incierto";
}

/**
 * Resuelve el pago de un pedido pendiente cuya confirmación quedó a medias (se reservó,
 * pero el resultado no se guardó o Transbank no contestó). Se usa antes de anularlo.
 * Devuelve null si no había nada que resolver, "en_curso" si otro proceso lo está
 * confirmando ahora, o el resultado de confirmarConReserva().
 */
export async function resolverPagoIncierto(env, pedidoId, opciones) {
  const db = env.DB;
  const tx = await db.prepare(
    `SELECT t.id, t.pedido_id, t.token, p.numero FROM transacciones t JOIN pedidos p ON p.id = t.pedido_id
     WHERE t.pedido_id = ? AND t.tipo = 'pago' AND t.estado = 'iniciada' AND t.actualizado_en > t.creado_en
       AND p.estado_pago = 'pendiente'
     ORDER BY t.id DESC LIMIT 1`
  ).bind(pedidoId).first();
  if (!tx) return null;
  const reserva = await reservarConfirmacion(db, tx.id);
  if (!reserva) return "en_curso";
  return confirmarConReserva(env, tx, reserva, opciones);
}

/**
 * Cron: vuelve a preguntarle a Transbank por los pagos con resultado incierto
 * (los que llevan más de 2 minutos sin que nadie los esté confirmando).
 * Devuelve cuántos quedaron pagados, anulados o todavía inciertos.
 */
export async function resolverPagosInciertos(env, enSegundoPlano) {
  const { results } = await env.DB.prepare(
    `SELECT t.pedido_id FROM transacciones t JOIN pedidos p ON p.id = t.pedido_id
     WHERE t.tipo = 'pago' AND t.estado = 'iniciada' AND t.actualizado_en > t.creado_en AND t.actualizado_en <= ?
       AND p.estado_pago = 'pendiente' AND p.metodo_pago = 'webpay'
     ORDER BY t.actualizado_en LIMIT 5`
  ).bind(limiteReserva(ahora())).all();
  const cuenta = { pagado: 0, anulado: 0, incierto: 0 };
  for (const { pedido_id: pedidoId } of results) {
    const resultado = await resolverPagoIncierto(env, pedidoId, {
      nuevoEstado: "anulado", motivo: "Pago Webpay no completado", origen: origenPublico(env, null), enSegundoPlano,
    });
    if (resultado in cuenta) cuenta[resultado]++;
  }
  return cuenta;
}

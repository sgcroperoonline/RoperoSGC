// Consultas a la base de datos que usan varias partes del servidor.
import { CONFIG } from "../public/js/datos.js";
import { minutosExpiraWebpay } from "./config.js";
import { ahora, UN_DIA_MS } from "./util.js";

/* ----------------------------------------------------------------
   RESERVA MIENTRAS SE CONFIRMA UN PAGO
   Cuando el comprador vuelve de Webpay, el servidor "reserva" su
   transacción (le pone la hora actual en actualizado_en) antes de
   pedirle a Transbank que cobre. Una transacción reservada nunca se
   anula "a ciegas" (el cron, otra pestaña, el panel): puede que
   Transbank sí haya cobrado y el resultado no alcanzara a guardarse.
   Esos pedidos se resuelven preguntándole a Transbank (src/pagos.js).
   Llamar a Transbank demora como máximo ~30 s; pasados 2 min, otro
   proceso puede tomar la reserva para volver a preguntar.
   ---------------------------------------------------------------- */
export const RESERVA_CONFIRMACION_MS = 2 * 60 * 1000;

export const limiteReserva = (momento) =>
  new Date(Date.parse(momento) - RESERVA_CONFIRMACION_MS).toISOString();

// Condición SQL: el pedido ?1 sigue pendiente y su pago nunca se empezó a confirmar.
// Se repite dentro de cada sentencia para que cada una se revise sola, en el mismo
// instante en que se ejecuta.
const SE_PUEDE_CERRAR = `
  EXISTS (SELECT 1 FROM pedidos WHERE id = ?1 AND estado_pago = 'pendiente')
  AND NOT EXISTS (
    SELECT 1 FROM transacciones t
    WHERE t.pedido_id = ?1 AND t.tipo = 'pago' AND t.estado = 'iniciada' AND t.actualizado_en > t.creado_en)`;

/**
 * Sentencias para cerrar un pedido PENDIENTE (anularlo o marcarlo rechazado)
 * devolviendo sus prendas al stock. Se ejecutan juntas en un DB.batch (todo o nada).
 * Son "idempotentes": si dos procesos las corren a la vez (el retorno de Webpay y el
 * cron), solo el primero devuelve el stock; para el segundo el pedido ya no está
 * pendiente y no pasa nada. La última sentencia devuelve el id si el pedido se cerró.
 * Si el pago tiene una confirmación empezada (ver arriba), no cambian nada.
 */
export function sentenciasCerrarPendiente(db, pedidoId, { nuevoEstado, motivo, estadoTransaccion = null, momento = ahora() }) {
  const sentencias = [];
  if (estadoTransaccion) {
    // El intento de pago Webpay que seguía abierto queda cerrado con este estado.
    sentencias.push(db.prepare(
      `UPDATE transacciones SET estado = ?2, actualizado_en = ?3
       WHERE pedido_id = ?1 AND tipo = 'pago' AND estado = 'iniciada' AND ${SE_PUEDE_CERRAR}`
    ).bind(pedidoId, estadoTransaccion, momento));
  }
  // Primero se devuelve el stock (solo si el pedido sigue pendiente)…
  sentencias.push(db.prepare(
    `UPDATE productos
     SET stock = stock + (SELECT SUM(cantidad) FROM pedido_items WHERE pedido_id = ?1 AND producto_id = productos.id),
         actualizado_en = ?2
     WHERE id IN (SELECT producto_id FROM pedido_items WHERE pedido_id = ?1) AND ${SE_PUEDE_CERRAR}`
  ).bind(pedidoId, momento));
  // …y después se cambia el estado del pedido (con la misma condición).
  sentencias.push(db.prepare(
    `UPDATE pedidos
     SET estado_pago = ?2, anulado_en = ?3, motivo_anulacion = ?4, actualizado_en = ?3
     WHERE id = ?1 AND ${SE_PUEDE_CERRAR}
     RETURNING id`
  ).bind(pedidoId, nuevoEstado, momento, motivo));
  return sentencias;
}

// Si el pedido ya no está pendiente ni pagado, su intento de pago abierto queda "expirada".
export function marcarExpiradaSiSigueIniciada(db, transaccionId) {
  return db.prepare(
    `UPDATE transacciones SET estado = 'expirada', actualizado_en = ?2
     WHERE id = ?1 AND estado = 'iniciada'
       AND EXISTS (SELECT 1 FROM pedidos WHERE id = transacciones.pedido_id
                   AND estado_pago NOT IN ('pendiente', 'pagado'))`
  ).bind(transaccionId, ahora()).run();
}

/**
 * Anula los pedidos Webpay que llevan más de MINUTOS_EXPIRA_WEBPAY sin pagarse
 * y devuelve sus prendas al catálogo. La usan el cron y la creación de pedidos.
 * Los que tienen una confirmación empezada no se tocan: los resuelve el cron
 * preguntándole a Transbank (src/pagos.js). Devuelve cuántos pedidos anuló.
 */
export async function expirarPedidosWebpay(env) {
  const db = env.DB;
  const momento = ahora();
  const limite = new Date(Date.parse(momento) - minutosExpiraWebpay(env) * 60 * 1000).toISOString();
  const { results } = await db.prepare(
    `SELECT id FROM pedidos
     WHERE metodo_pago = 'webpay' AND estado_pago = 'pendiente' AND creado_en < ?
       AND NOT EXISTS (SELECT 1 FROM transacciones t
                       WHERE t.pedido_id = pedidos.id AND t.tipo = 'pago' AND t.estado = 'iniciada'
                         AND t.actualizado_en > t.creado_en)
     ORDER BY id LIMIT 100`
  ).bind(limite).all();
  if (!results.length) return 0;

  const sentencias = results.flatMap((fila) => sentenciasCerrarPendiente(db, fila.id, {
    nuevoEstado: "anulado",
    motivo: "Pago Webpay no completado",
    estadoTransaccion: "expirada",
    momento,
  }));
  const resultados = await db.batch(sentencias);
  // Cada pedido usa 3 sentencias; la tercera devuelve una fila si el pedido se anuló.
  let anulados = 0;
  for (let i = 2; i < resultados.length; i += 3) anulados += resultados[i].results?.length || 0;
  return anulados;
}

/* ----------------------------------------------------------------
   LECTURA DE PEDIDOS
   ---------------------------------------------------------------- */

// Plazo para pedir reembolso: CONFIG.diasReembolso días desde que se pagó.
export function plazoReembolso(fila, tieneReembolso) {
  if (fila.estado_pago !== "pagado" || !fila.pagado_en) {
    return { dentroDelPlazo: false, diasRestantes: 0, puede: false };
  }
  const restanteMs = Date.parse(fila.pagado_en) + CONFIG.diasReembolso * UN_DIA_MS - Date.now();
  const dentroDelPlazo = restanteMs > 0;
  return {
    dentroDelPlazo,
    diasRestantes: dentroDelPlazo ? Math.ceil(restanteMs / UN_DIA_MS) : 0,
    puede: dentroDelPlazo && !tieneReembolso,
  };
}

/**
 * Convierte las filas de la base de datos en el pedido que se envía al navegador
 * ("PedidoPublico"). Con admin = true agrega lo que solo ve el panel ("PedidoAdmin").
 */
export function armarPedido(fila, items, transacciones, reembolso, admin = false) {
  const pagos = transacciones.filter((t) => t.tipo === "pago" && t.estado === "autorizada");
  const pago = pagos[pagos.length - 1];
  const plazo = plazoReembolso(fila, Boolean(reembolso));

  const pedido = {
    numero: fila.numero,
    creadoEn: fila.creado_en,
    estadoPago: fila.estado_pago,
    metodoPago: fila.metodo_pago,
    entrega: fila.entrega,
    total: fila.total,
    comprador: { nombre: fila.comprador_nombre, correo: fila.comprador_correo },
    retira: { tipo: fila.retira_tipo, nombre: fila.retira_nombre, extra: fila.retira_extra },
    items: items.map((i) => ({
      id: i.producto_id, nombre: i.nombre, tipo: i.tipo, marca: i.marca, talla: i.talla,
      estado: i.estado, precio: i.precio_unitario, cant: i.cantidad,
    })),
    pago: pago ? {
      ordenCompra: pago.orden_compra,
      codigoAutorizacion: pago.codigo_autorizacion,
      tarjeta: pago.tarjeta_ultimos4,
      tipoPago: pago.tipo_pago,
      cuotas: pago.cuotas,
      fecha: pago.fecha_transaccion,
      monto: pago.monto,
    } : null,
    reembolso: reembolso ? {
      estado: reembolso.estado,
      motivo: reembolso.motivo,
      respuesta: reembolso.respuesta,
      solicitadoEn: reembolso.solicitado_en,
    } : null,
    puedePedirReembolso: plazo.puede,
    diasRestantesReembolso: plazo.diasRestantes,
  };
  if (fila.metodo_pago === "transferencia") pedido.datosTransferencia = CONFIG.datosTransferencia;

  if (admin) {
    pedido.comprador.fono = fila.comprador_fono;
    pedido.pagadoEn = fila.pagado_en;
    pedido.entregadoEn = fila.entregado_en;
    pedido.anuladoEn = fila.anulado_en;
    pedido.motivoAnulacion = fila.motivo_anulacion;
    if (pedido.reembolso) {
      pedido.reembolso.error = reembolso.error;
      pedido.reembolso.resueltoEn = reembolso.resuelto_en;
      pedido.reembolso.devueltoEn = reembolso.devuelto_en;
    }
    // Pagado con la tarjeta de prueba (Webpay en integración): no entró dinero real.
    pedido.pagoDePrueba = pago?.ambiente === "integracion";
    pedido.transacciones = transacciones.map((t) => ({
      tipo: t.tipo,
      estado: t.estado,
      ambiente: t.ambiente,
      monto: t.monto,
      codigoRespuesta: t.codigo_respuesta,
      codigoAutorizacion: t.codigo_autorizacion,
      tarjeta: t.tarjeta_ultimos4,
      tipoPago: t.tipo_pago,
      cuotas: t.cuotas,
      ordenCompra: t.orden_compra,
      tipoReembolso: t.tipo_reembolso,
      detalleError: t.detalle_error,
      creadoEn: t.creado_en,
    }));
  }
  return pedido;
}

/**
 * Carga pedidos completos (con prendas, transacciones y reembolso), los más nuevos primero.
 * "donde" es SIEMPRE un texto fijo escrito en este código (nunca lo que manda el usuario);
 * los valores del usuario van aparte en "valores", con "?".
 */
export async function cargarPedidos(db, { donde = "1 = 1", valores = [], admin = false } = {}) {
  const preparar = (sql) => (valores.length ? db.prepare(sql).bind(...valores) : db.prepare(sql));
  const subconsulta = `SELECT id FROM pedidos WHERE ${donde}`;
  const [pedidos, items, transacciones, reembolsos] = await db.batch([
    preparar(`SELECT * FROM pedidos WHERE ${donde} ORDER BY id DESC`),
    preparar(`SELECT * FROM pedido_items WHERE pedido_id IN (${subconsulta}) ORDER BY id`),
    preparar(`SELECT * FROM transacciones WHERE pedido_id IN (${subconsulta}) ORDER BY id`),
    preparar(`SELECT * FROM reembolsos WHERE pedido_id IN (${subconsulta})`),
  ]);

  // Agrupa las filas por pedido para armar cada uno.
  const agrupar = (filas) => {
    const mapa = new Map();
    for (const fila of filas) {
      if (!mapa.has(fila.pedido_id)) mapa.set(fila.pedido_id, []);
      mapa.get(fila.pedido_id).push(fila);
    }
    return mapa;
  };
  const itemsPorPedido = agrupar(items.results);
  const transaccionesPorPedido = agrupar(transacciones.results);
  const reembolsoPorPedido = new Map(reembolsos.results.map((r) => [r.pedido_id, r]));

  return pedidos.results.map((fila) => armarPedido(
    fila,
    itemsPorPedido.get(fila.id) || [],
    transaccionesPorPedido.get(fila.id) || [],
    reembolsoPorPedido.get(fila.id) || null,
    admin,
  ));
}

// Un pedido completo por su id interno (o null).
export async function cargarPedido(db, pedidoId, admin = false) {
  const [pedido] = await cargarPedidos(db, { donde: "id = ?", valores: [pedidoId], admin });
  return pedido || null;
}

// La fila "cruda" de un pedido por su número (o null).
export function filaPedidoPorNumero(db, numero) {
  return db.prepare("SELECT * FROM pedidos WHERE numero = ?").bind(numero).first();
}

/* ----------------------------------------------------------------
   PRENDAS
   ---------------------------------------------------------------- */

// Prenda tal como la ve la tienda.
export function productoPublico(fila) {
  return {
    id: fila.id, nombre: fila.nombre, tipo: fila.tipo, marca: fila.marca, talla: fila.talla,
    estado: fila.estado, precio: fila.precio, stock: fila.stock, detalle: fila.detalle, imagen: fila.imagen,
  };
}

// Prenda tal como la ve el panel (incluye si está publicada y las fechas).
export function productoAdmin(fila) {
  return {
    ...productoPublico(fila),
    publicado: fila.publicado === 1,
    creadoEn: fila.creado_en,
    actualizadoEn: fila.actualizado_en,
  };
}

// Rutas del panel de voluntarias (/api/admin/...). Todas exigen sesión, salvo "ingresar".
import { Hono } from "hono";
import { configWebpay, correoActivo, destinoAvisos } from "./config.js";
import { exigirSesion, ingresar } from "./auth.js";
import {
  cargarPedido, cargarPedidos, filaPedidoPorNumero, productoAdmin, sentenciasCerrarPendiente,
} from "./db.js";
import { fechaChile } from "./plantillas.js";
import { ahora, ErrorPublico, leerJSON, plata, textoLargo } from "./util.js";
import { FORMATO_CODIGO, numeroPedidoValido, validarProducto } from "./validar.js";
import { reembolsarTransaccion, reembolsoExitoso } from "./webpay.js";

export const rutasAdmin = new Hono();

rutasAdmin.post("/ingresar", ingresar);
rutasAdmin.use("*", (c, next) => (c.req.path === "/api/admin/ingresar" ? next() : exigirSesion(c, next)));

// Código de prenda que viene en la URL (o 404 si no tiene el formato correcto).
function codigoDe(c) {
  const id = c.req.param("id").toUpperCase();
  if (!FORMATO_CODIGO.test(id)) throw new ErrorPublico(404, "No encontramos esa prenda.");
  return id;
}

// Pedido "crudo" según el número que viene en la URL (o 404).
async function filaDe(c) {
  const numero = numeroPedidoValido(c.req.param("numero"));
  const fila = numero ? await filaPedidoPorNumero(c.env.DB, numero) : null;
  if (!fila) throw new ErrorPublico(404, "No encontramos ese pedido.");
  return fila;
}

const responderPedido = async (c, pedidoId, extra = {}) =>
  c.json({ pedido: await cargarPedido(c.env.DB, pedidoId, true), ...extra });

/* ----------------------------------------------------------------
   ESTADO DEL SERVIDOR
   ---------------------------------------------------------------- */

rutasAdmin.get("/estado", (c) => {
  const webpay = configWebpay(c.env);
  return c.json({
    webpay: { ambiente: webpay.ambiente, comercio: webpay.comercio },
    correo: { activo: correoActivo(c.env), avisosA: destinoAvisos(c.env) },
  });
});

/* ----------------------------------------------------------------
   PRENDAS
   ---------------------------------------------------------------- */

rutasAdmin.get("/productos", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM productos ORDER BY creado_en ASC, id ASC").all();
  return c.json({ productos: results.map(productoAdmin) });
});

rutasAdmin.post("/productos", async (c) => {
  const p = validarProducto(await leerJSON(c));
  const momento = ahora();
  try {
    const fila = await c.env.DB.prepare(
      `INSERT INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado,
         creado_en, actualizado_en)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(p.id, p.nombre, p.tipo, p.marca, p.talla, p.estado, p.precio, p.stock, p.detalle, p.imagen,
      p.publicado ? 1 : 0, momento, momento).first();
    return c.json({ producto: productoAdmin(fila) }, 201);
  } catch (error) {
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(String(error?.message || error))) {
      throw new ErrorPublico(409, `Ya existe una prenda con el código ${p.id}.`);
    }
    throw error;
  }
});

rutasAdmin.put("/productos/:id", async (c) => {
  const id = codigoDe(c);
  const p = validarProducto(await leerJSON(c), id);
  const fila = await c.env.DB.prepare(
    `UPDATE productos SET nombre = ?, tipo = ?, marca = ?, talla = ?, estado = ?, precio = ?, stock = ?,
       detalle = ?, imagen = ?, publicado = ?, actualizado_en = ?
     WHERE id = ? RETURNING *`
  ).bind(p.nombre, p.tipo, p.marca, p.talla, p.estado, p.precio, p.stock, p.detalle, p.imagen,
    p.publicado ? 1 : 0, ahora(), id).first();
  if (!fila) throw new ErrorPublico(404, "No encontramos esa prenda.");
  return c.json({ producto: productoAdmin(fila) });
});

rutasAdmin.delete("/productos/:id", async (c) => {
  const id = codigoDe(c);
  const db = c.env.DB;
  // Se borra la foto y la prenda. Los pedidos conservan su copia en pedido_items.
  const [, borrado] = await db.batch([
    db.prepare("DELETE FROM imagenes WHERE producto_id = ?").bind(id),
    db.prepare("DELETE FROM productos WHERE id = ? RETURNING id").bind(id),
  ]);
  if (!borrado.results.length) throw new ErrorPublico(404, "No encontramos esa prenda.");
  return c.json({ ok: true });
});

// Los primeros bytes de cada formato de imagen ("firma"), para no guardar cualquier archivo.
function esImagen(bytes, tipo) {
  const empieza = (firma, desde = 0) => firma.every((b, i) => bytes[desde + i] === b);
  if (tipo === "image/jpeg") return empieza([0xff, 0xd8, 0xff]);
  if (tipo === "image/png") return empieza([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (tipo === "image/webp") return empieza([0x52, 0x49, 0x46, 0x46]) && empieza([0x57, 0x45, 0x42, 0x50], 8);
  return false;
}

const MAXIMO_FOTO = 1500000; // bytes (1,5 MB). El panel achica la foto antes de subirla.

rutasAdmin.put("/productos/:id/imagen", async (c) => {
  const id = codigoDe(c);
  const db = c.env.DB;
  const tipo = (c.req.header("Content-Type") || "").split(";")[0].trim().toLowerCase();
  if (!["image/jpeg", "image/png", "image/webp"].includes(tipo)) {
    throw new ErrorPublico(400, "La foto debe ser JPG, PNG o WEBP.");
  }
  const datos = await c.req.arrayBuffer();
  if (!datos.byteLength) throw new ErrorPublico(400, "No llegó ninguna foto.");
  if (datos.byteLength > MAXIMO_FOTO) throw new ErrorPublico(413, "La foto es muy pesada: el máximo es 1,5 MB.");
  if (!esImagen(new Uint8Array(datos), tipo)) throw new ErrorPublico(400, "El archivo no parece ser una foto JPG, PNG o WEBP.");

  const existe = await db.prepare("SELECT 1 AS hay FROM productos WHERE id = ?").bind(id).first();
  if (!existe) throw new ErrorPublico(404, "No encontramos esa prenda.");

  // "?v=" cambia con cada foto nueva para que los navegadores no muestren la antigua.
  const momento = ahora();
  const ruta = `/api/imagenes/${id}?v=${Date.now()}`;
  const [, actualizado] = await db.batch([
    db.prepare(
      "INSERT OR REPLACE INTO imagenes (producto_id, tipo_mime, datos, actualizado_en) VALUES (?, ?, ?, ?)"
    ).bind(id, tipo, datos, momento),
    db.prepare("UPDATE productos SET imagen = ?, actualizado_en = ? WHERE id = ? RETURNING *").bind(ruta, momento, id),
  ]);
  if (!actualizado.results.length) throw new ErrorPublico(404, "No encontramos esa prenda.");
  return c.json({ producto: productoAdmin(actualizado.results[0]) });
});

rutasAdmin.delete("/productos/:id/imagen", async (c) => {
  const id = codigoDe(c);
  const db = c.env.DB;
  const [, actualizado] = await db.batch([
    db.prepare("DELETE FROM imagenes WHERE producto_id = ?").bind(id),
    db.prepare("UPDATE productos SET imagen = '', actualizado_en = ? WHERE id = ? RETURNING *").bind(ahora(), id),
  ]);
  if (!actualizado.results.length) throw new ErrorPublico(404, "No encontramos esa prenda.");
  return c.json({ producto: productoAdmin(actualizado.results[0]) });
});

/* ----------------------------------------------------------------
   PEDIDOS
   ---------------------------------------------------------------- */

rutasAdmin.get("/pedidos", async (c) => {
  return c.json({ pedidos: await cargarPedidos(c.env.DB, { admin: true }) });
});

// Transferencia o efectivo recibido: el pedido queda pagado.
rutasAdmin.post("/pedidos/:numero/pagado", async (c) => {
  const fila = await filaDe(c);
  const momento = ahora();
  const resultado = await c.env.DB.prepare(
    `UPDATE pedidos SET estado_pago = 'pagado', pagado_en = ?, actualizado_en = ?
     WHERE id = ? AND metodo_pago <> 'webpay' AND estado_pago = 'pendiente'`
  ).bind(momento, momento, fila.id).run();
  if (!resultado.meta.changes) {
    throw new ErrorPublico(409, "Solo se pueden marcar como pagados los pedidos pendientes por transferencia o efectivo.");
  }
  return responderPedido(c, fila.id);
});

rutasAdmin.post("/pedidos/:numero/entregado", async (c) => {
  const fila = await filaDe(c);
  const momento = ahora();
  const resultado = await c.env.DB.prepare(
    `UPDATE pedidos SET entrega = 'entregado', entregado_en = COALESCE(entregado_en, ?), actualizado_en = ?
     WHERE id = ? AND estado_pago NOT IN ('anulado', 'rechazado', 'reembolsado')`
  ).bind(momento, momento, fila.id).run();
  if (!resultado.meta.changes) {
    throw new ErrorPublico(409, "Este pedido está anulado, rechazado o reembolsado: no se puede marcar como entregado.");
  }
  return responderPedido(c, fila.id);
});

// Anular un pedido pendiente: las prendas vuelven al catálogo.
rutasAdmin.post("/pedidos/:numero/anular", async (c) => {
  const fila = await filaDe(c);
  const motivo = textoLargo((await leerJSON(c)).motivo);
  if (!motivo) throw new ErrorPublico(400, "Escribe el motivo de la anulación.");
  if (motivo.length > 500) throw new ErrorPublico(400, "El motivo es muy largo: máximo 500 caracteres.");
  if (fila.estado_pago !== "pendiente") throw new ErrorPublico(409, "Solo se pueden anular pedidos pendientes de pago.");

  const db = c.env.DB;
  const resultados = await db.batch(sentenciasCerrarPendiente(db, fila.id, {
    nuevoEstado: "anulado", motivo, estadoTransaccion: "expirada",
  }));
  if (!resultados[resultados.length - 1].results.length) {
    const actual = await db.prepare("SELECT estado_pago FROM pedidos WHERE id = ?").bind(fila.id).first();
    throw new ErrorPublico(409, actual?.estado_pago === "pendiente"
      ? "El pago de este pedido se está confirmando en Webpay en este momento. Intenta de nuevo en un par de minutos."
      : "Solo se pueden anular pedidos pendientes de pago.");
  }
  return responderPedido(c, fila.id);
});

/* ----------------------------------------------------------------
   REEMBOLSOS
   ---------------------------------------------------------------- */

rutasAdmin.get("/reembolsos", async (c) => {
  const pedidos = await cargarPedidos(c.env.DB, {
    donde: "id IN (SELECT pedido_id FROM reembolsos)", admin: true,
  });
  // Primero los que esperan respuesta; dentro de cada grupo, los más recientes primero.
  pedidos.sort((a, b) =>
    (b.reembolso.estado === "solicitado") - (a.reembolso.estado === "solicitado")
    || String(b.reembolso.solicitadoEn).localeCompare(String(a.reembolso.solicitadoEn)));
  return c.json({ pedidos });
});

// Pide a Webpay devolver el total del pedido y deja todo anotado. Devuelve { ok, mensaje }.
async function devolverPorWebpay(env, fila) {
  const db = env.DB;
  const ambiente = configWebpay(env).ambiente;
  const pago = await db.prepare(
    `SELECT * FROM transacciones WHERE pedido_id = ? AND tipo = 'pago' AND estado = 'autorizada'
     ORDER BY id DESC LIMIT 1`
  ).bind(fila.id).first();

  let respuesta = null;
  let error = null;
  let seLlamoAWebpay = false;
  if (!pago?.token) {
    error = "No encontramos el pago Webpay de este pedido.";
  } else if (pago.ambiente !== ambiente) {
    error = `Este pago se hizo en el ambiente "${pago.ambiente}" de Webpay y el servidor ahora está en "${ambiente}".`;
  } else {
    seLlamoAWebpay = true;
    try {
      respuesta = await reembolsarTransaccion(env, pago.token, fila.total);
      if (!reembolsoExitoso(respuesta)) {
        error = `Webpay no aprobó la devolución (tipo ${respuesta?.type ?? "-"}, código ${respuesta?.response_code ?? "-"}).`;
      }
    } catch (e) {
      error = e?.message || String(e);
    }
  }

  const momento = ahora();
  const json = respuesta ? JSON.stringify(respuesta).slice(0, 4000) : null;
  const texto = (valor, largo) => (valor === undefined || valor === null ? null : String(valor).slice(0, largo));
  const codigoRespuesta = Number.isInteger(respuesta?.response_code) ? respuesta.response_code : null;

  if (!error) {
    // Devolución hecha: transacción de reembolso + reembolso "devuelto" + pedido "reembolsado", juntos.
    await db.batch([
      db.prepare(
        `INSERT INTO transacciones (pedido_id, tipo, ambiente, token, orden_compra, monto, estado,
           codigo_respuesta, codigo_autorizacion, tipo_reembolso, respuesta_json, creado_en, actualizado_en)
         VALUES (?, 'reembolso', ?, ?, ?, ?, 'reembolsada', ?, ?, ?, ?, ?, ?)`
      ).bind(fila.id, ambiente, pago.token, pago.orden_compra, fila.total, codigoRespuesta,
        texto(respuesta.authorization_code, 20), texto(respuesta.type, 20), json, momento, momento),
      db.prepare(
        `UPDATE reembolsos SET estado = 'devuelto', devuelto_en = ?1, error = NULL,
           transaccion_id = (SELECT MAX(id) FROM transacciones WHERE pedido_id = ?2 AND tipo = 'reembolso')
         WHERE pedido_id = ?2 AND estado = 'aprobado'`
      ).bind(momento, fila.id),
      db.prepare(
        "UPDATE pedidos SET estado_pago = 'reembolsado', actualizado_en = ? WHERE id = ? AND estado_pago = 'pagado'"
      ).bind(momento, fila.id),
    ]);
    return { ok: true, mensaje: `Webpay devolvió ${plata(fila.total)} al medio de pago del comprador.` };
  }

  console.error(`Devolución Webpay del pedido ${fila.numero} falló:`, error);
  const sentencias = [
    db.prepare("UPDATE reembolsos SET error = ? WHERE pedido_id = ? AND estado = 'aprobado'").bind(error.slice(0, 500), fila.id),
  ];
  if (seLlamoAWebpay) {
    // El intento fallido también queda registrado.
    sentencias.unshift(db.prepare(
      `INSERT INTO transacciones (pedido_id, tipo, ambiente, token, orden_compra, monto, estado,
         codigo_respuesta, tipo_reembolso, detalle_error, respuesta_json, creado_en, actualizado_en)
       VALUES (?, 'reembolso', ?, ?, ?, ?, 'error', ?, ?, ?, ?, ?, ?)`
    ).bind(fila.id, ambiente, pago.token, pago.orden_compra, fila.total, codigoRespuesta,
      texto(respuesta?.type, 20), error.slice(0, 500), json, momento, momento));
  }
  await db.batch(sentencias);
  return {
    ok: false,
    mensaje: `Webpay no pudo hacer la devolución: ${error} Puedes reintentar o devolver el dinero a mano y marcarlo como devuelto.`,
  };
}

// Aprobar o rechazar una solicitud. Al aprobar, las prendas vuelven al stock y,
// si se pagó con Webpay, se devuelve el dinero automáticamente.
rutasAdmin.post("/reembolsos/:numero/resolver", async (c) => {
  const fila = await filaDe(c);
  const db = c.env.DB;
  const cuerpo = await leerJSON(c);
  const decision = cuerpo.decision;
  if (decision !== "aprobado" && decision !== "rechazado") throw new ErrorPublico(400, "Elige aprobar o rechazar.");
  const respuesta = textoLargo(cuerpo.respuesta ?? "");
  if (respuesta.length > 1000) throw new ErrorPublico(400, "La respuesta es muy larga: máximo 1000 caracteres.");

  const reembolso = await db.prepare("SELECT estado FROM reembolsos WHERE pedido_id = ?").bind(fila.id).first();
  if (!reembolso) throw new ErrorPublico(404, "Este pedido no tiene una solicitud de reembolso.");
  if (reembolso.estado !== "solicitado") throw new ErrorPublico(409, "Esta solicitud ya fue resuelta.");

  const momento = ahora();
  let cambio;
  if (decision === "aprobado") {
    // Primero vuelve el stock y después cambia el estado, ambos solo si seguía "solicitado":
    // si se aprieta "Aprobar" dos veces, el stock vuelve una sola vez.
    const resultados = await db.batch([
      db.prepare(
        `UPDATE productos
         SET stock = stock + (SELECT SUM(cantidad) FROM pedido_items WHERE pedido_id = ?1 AND producto_id = productos.id),
             actualizado_en = ?2
         WHERE id IN (SELECT producto_id FROM pedido_items WHERE pedido_id = ?1)
           AND EXISTS (SELECT 1 FROM reembolsos WHERE pedido_id = ?1 AND estado = 'solicitado')`
      ).bind(fila.id, momento),
      db.prepare(
        `UPDATE reembolsos SET estado = 'aprobado', respuesta = ?, resuelto_en = ?
         WHERE pedido_id = ? AND estado = 'solicitado'`
      ).bind(respuesta, momento, fila.id),
    ]);
    cambio = resultados[1].meta.changes;
  } else {
    const resultado = await db.prepare(
      `UPDATE reembolsos SET estado = 'rechazado', respuesta = ?, resuelto_en = ?
       WHERE pedido_id = ? AND estado = 'solicitado'`
    ).bind(respuesta, momento, fila.id).run();
    cambio = resultado.meta.changes;
  }
  if (!cambio) throw new ErrorPublico(409, "Esta solicitud ya fue resuelta.");

  let webpay = null;
  if (decision === "aprobado") {
    const actual = await db.prepare("SELECT * FROM pedidos WHERE id = ?").bind(fila.id).first();
    if (actual.metodo_pago === "webpay" && actual.estado_pago === "pagado") webpay = await devolverPorWebpay(c.env, actual);
  }
  return responderPedido(c, fila.id, { webpay });
});

rutasAdmin.post("/reembolsos/:numero/reintentar", async (c) => {
  const fila = await filaDe(c);
  const reembolso = await c.env.DB.prepare("SELECT estado FROM reembolsos WHERE pedido_id = ?").bind(fila.id).first();
  if (reembolso?.estado !== "aprobado" || fila.metodo_pago !== "webpay" || fila.estado_pago !== "pagado") {
    throw new ErrorPublico(409, "Solo se puede reintentar la devolución de un reembolso aprobado de un pago Webpay.");
  }
  const webpay = await devolverPorWebpay(c.env, fila);
  return responderPedido(c, fila.id, { webpay });
});

// El ropero devolvió el dinero a mano (transferencia, efectivo o Webpay falló).
rutasAdmin.post("/reembolsos/:numero/devuelto", async (c) => {
  const fila = await filaDe(c);
  const db = c.env.DB;
  const momento = ahora();
  const [pedido, reembolso] = await db.batch([
    db.prepare(
      `UPDATE pedidos SET estado_pago = 'reembolsado', actualizado_en = ?1
       WHERE id = ?2 AND estado_pago = 'pagado'
         AND EXISTS (SELECT 1 FROM reembolsos WHERE pedido_id = ?2 AND estado = 'aprobado')`
    ).bind(momento, fila.id),
    db.prepare(
      "UPDATE reembolsos SET estado = 'devuelto', devuelto_en = ?, error = NULL WHERE pedido_id = ? AND estado = 'aprobado'"
    ).bind(momento, fila.id),
  ]);
  if (!reembolso.meta.changes) throw new ErrorPublico(409, "Solo se puede marcar como devuelto un reembolso aprobado.");
  if (!pedido.meta.changes) console.error(`Pedido ${fila.numero}: reembolso devuelto, pero el pedido no estaba pagado.`);
  return responderPedido(c, fila.id);
});

/* ----------------------------------------------------------------
   RESUMEN Y RESPALDO
   ---------------------------------------------------------------- */

rutasAdmin.get("/resumen", async (c) => {
  const cifras = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM productos) AS prendas,
       (SELECT COUNT(*) FROM productos WHERE publicado = 1 AND stock > 0) AS disponibles,
       (SELECT COUNT(*) FROM pedidos WHERE estado_pago NOT IN ('anulado', 'rechazado')) AS pedidos,
       (SELECT COALESCE(SUM(i.cantidad), 0) FROM pedido_items i JOIN pedidos p ON p.id = i.pedido_id
          WHERE p.estado_pago = 'pagado') AS prendasVendidas,
       (SELECT COALESCE(SUM(total), 0) FROM pedidos WHERE estado_pago = 'pagado') AS recaudado,
       (SELECT COALESCE(SUM(total), 0) FROM pedidos WHERE estado_pago = 'pendiente' AND metodo_pago <> 'webpay') AS porCobrar,
       (SELECT COALESCE(SUM(total), 0) FROM pedidos WHERE estado_pago = 'reembolsado') AS reembolsado`
  ).first();
  return c.json(cifras);
});

// Celda de CSV entre comillas. Si un texto empieza con = + - @, Excel podría ejecutarlo
// como fórmula: se le antepone un apóstrofo (salvo números y teléfonos como +56 9 …).
function celda(valor) {
  let t = valor === null || valor === undefined ? "" : String(valor);
  if (/^[=@\t\r]/.test(t) || (/^[+-]/.test(t) && !/^[+-][\d\s().-]*$/.test(t))) t = "'" + t;
  return `"${t.replace(/"/g, '""')}"`;
}

rutasAdmin.get("/ventas.csv", async (c) => {
  const pedidos = (await cargarPedidos(c.env.DB, { admin: true })).reverse(); // del más antiguo al más nuevo
  const filas = [["N pedido", "Fecha", "Comprador", "Correo", "Telefono", "Retira", "Rol", "Dato extra",
    "Codigo", "Prenda", "Talla", "Marca", "Estado", "Cantidad", "Precio", "Metodo de pago", "Pago", "Entrega",
    "Reembolso", "Codigo autorizacion", "Tarjeta"]];
  for (const p of pedidos) {
    for (const i of p.items) {
      filas.push([
        p.numero, fechaChile(p.creadoEn), p.comprador.nombre, p.comprador.correo, p.comprador.fono,
        p.retira.nombre, p.retira.tipo, p.retira.extra,
        i.id, i.nombre, i.talla, i.marca, i.estado, i.cant, i.precio,
        p.metodoPago, p.estadoPago, p.entrega, p.reembolso ? p.reembolso.estado : "",
        p.pago?.codigoAutorizacion || "", p.pago?.tarjeta || "",
      ]);
    }
  }
  // BOM (\uFEFF) para que Excel reconozca los tildes; separador ";" como usa Excel en español.
  const csv = "\uFEFF" + filas.map((f) => f.map(celda).join(";")).join("\r\n") + "\r\n";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="ventas-ropero.csv"',
    },
  });
});

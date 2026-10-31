// Rutas del panel de voluntarias (/api/admin/...). Todas exigen sesión, salvo "ingresar".
import { Hono } from "hono";
import { configWebpay, correoActivo, destinoAvisos, origenPublico } from "./config.js";
import { exigirSesion, ingresar } from "./auth.js";
import {
  cargarPedido, cargarPedidos, filaPedidoPorNumero, productoAdmin, sentenciasCerrarPendiente,
} from "./db.js";
import { resolverPagoIncierto } from "./pagos.js";
import { fechaChile } from "./plantillas.js";
import { ahora, ErrorPublico, leerJSON, plata, textoLargo } from "./util.js";
import { FORMATO_CODIGO, numeroPedidoValido, validarProducto } from "./validar.js";
import { estadoTransaccion, reembolsarTransaccion, reembolsoExitoso } from "./webpay.js";

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

// Siguiente código SG-NNNN libre. Mira también los pedidos: un código que ya se vendió
// no se vuelve a usar, aunque se haya borrado la prenda (si no, una devolución vieja
// le sumaría stock a otra prenda).
async function siguienteCodigo(db) {
  const { results } = await db.prepare(
    `SELECT id FROM productos WHERE id LIKE 'SG-%'
     UNION SELECT producto_id FROM pedido_items WHERE producto_id LIKE 'SG-%'`
  ).all();
  const numeros = results.map((f) => /^SG-(\d{1,9})$/.exec(f.id)).filter(Boolean).map((m) => Number(m[1]));
  return "SG-" + String(Math.max(0, ...numeros) + 1).padStart(4, "0");
}

const PRENDA_CAMBIO = "Esta prenda cambió mientras la editabas (se vendió, se reservó o alguien más la modificó). Recarga la lista y vuelve a intentarlo.";

rutasAdmin.get("/productos", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM productos ORDER BY creado_en ASC, id ASC").all();
  return c.json({ productos: results.map(productoAdmin), siguienteCodigo: await siguienteCodigo(c.env.DB) });
});

rutasAdmin.post("/productos", async (c) => {
  const db = c.env.DB;
  const p = validarProducto(await leerJSON(c));
  const momento = ahora();
  let fila;
  try {
    // Solo se crea si el código nunca estuvo en un pedido.
    fila = await db.prepare(
      `INSERT INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado,
         creado_en, actualizado_en)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12
       WHERE NOT EXISTS (SELECT 1 FROM pedido_items WHERE producto_id = ?1) RETURNING *`
    ).bind(p.id, p.nombre, p.tipo, p.marca, p.talla, p.estado, p.precio, p.stock, p.detalle, p.imagen,
      p.publicado ? 1 : 0, momento).first();
  } catch (error) {
    if (/UNIQUE constraint failed|PRIMARY KEY/i.test(String(error?.message || error))) {
      throw new ErrorPublico(409, `Ya existe una prenda con el código ${p.id}.`);
    }
    throw error;
  }
  if (!fila) {
    const existe = await db.prepare("SELECT 1 AS hay FROM productos WHERE id = ?").bind(p.id).first();
    if (existe) throw new ErrorPublico(409, `Ya existe una prenda con el código ${p.id}.`);
    throw new ErrorPublico(409, `Ese código ya se usó en un pedido. Usa otro (sugerido: ${await siguienteCodigo(db)}).`);
  }
  return c.json({ producto: productoAdmin(fila) }, 201);
});

// Editar: el panel manda "actualizadoEn" tal como lo leyó. Si la prenda cambió desde
// entonces (por ejemplo, se vendió), no se guarda: así nunca se pisa el stock con uno viejo.
rutasAdmin.put("/productos/:id", async (c) => {
  const id = codigoDe(c);
  const cuerpo = await leerJSON(c);
  const p = validarProducto(cuerpo, id);
  const version = cuerpo.actualizadoEn;
  if (typeof version !== "string" || !version || version.length > 40) {
    throw new ErrorPublico(400, "Falta la versión de la prenda (actualizadoEn). Recarga la lista y vuelve a intentarlo.");
  }
  const fila = await c.env.DB.prepare(
    `UPDATE productos SET nombre = ?, tipo = ?, marca = ?, talla = ?, estado = ?, precio = ?, stock = ?,
       detalle = ?, imagen = ?, publicado = ?, actualizado_en = ?
     WHERE id = ? AND actualizado_en = ? RETURNING *`
  ).bind(p.nombre, p.tipo, p.marca, p.talla, p.estado, p.precio, p.stock, p.detalle, p.imagen,
    p.publicado ? 1 : 0, ahora(), id, version).first();
  if (!fila) {
    const existe = await c.env.DB.prepare("SELECT 1 AS hay FROM productos WHERE id = ?").bind(id).first();
    throw existe ? new ErrorPublico(409, PRENDA_CAMBIO) : new ErrorPublico(404, "No encontramos esa prenda.");
  }
  return c.json({ producto: productoAdmin(fila) });
});

// Ocultar o publicar: cambia solo "publicado", nunca el stock.
rutasAdmin.post("/productos/:id/publicado", async (c) => {
  const id = codigoDe(c);
  const { publicado } = await leerJSON(c);
  if (typeof publicado !== "boolean") throw new ErrorPublico(400, "Indica si la prenda está publicada o no.");
  const fila = await c.env.DB.prepare(
    "UPDATE productos SET publicado = ?, actualizado_en = ? WHERE id = ? RETURNING *"
  ).bind(publicado ? 1 : 0, ahora(), id).first();
  if (!fila) throw new ErrorPublico(404, "No encontramos esa prenda.");
  return c.json({ producto: productoAdmin(fila) });
});

rutasAdmin.delete("/productos/:id", async (c) => {
  const id = codigoDe(c);
  const db = c.env.DB;
  // No se borra si está en un pedido pendiente: al anularse, su stock volvería a una prenda
  // que ya no existe (o a otra nueva con el mismo código).
  const sinPendientes = `NOT EXISTS (SELECT 1 FROM pedido_items i JOIN pedidos p ON p.id = i.pedido_id
                                     WHERE i.producto_id = ?1 AND p.estado_pago = 'pendiente')`;
  // Se borra la foto y la prenda. Los pedidos conservan su copia en pedido_items.
  const [, borrado] = await db.batch([
    db.prepare(`DELETE FROM imagenes WHERE producto_id = ?1 AND ${sinPendientes}`).bind(id),
    db.prepare(`DELETE FROM productos WHERE id = ?1 AND ${sinPendientes} RETURNING id`).bind(id),
  ]);
  if (!borrado.results.length) {
    const existe = await db.prepare("SELECT 1 AS hay FROM productos WHERE id = ?").bind(id).first();
    if (existe) {
      throw new ErrorPublico(409, "Esta prenda está en un pedido pendiente de pago. Espera a que se pague o anúlalo antes de borrarla.");
    }
    throw new ErrorPublico(404, "No encontramos esa prenda.");
  }
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
    // Si su pago Webpay quedó a medias, antes de anular se le pregunta a Transbank si se cobró.
    const resultado = fila.metodo_pago === "webpay"
      ? await resolverPagoIncierto(c.env, fila.id, {
        nuevoEstado: "anulado", motivo, origen: origenPublico(c.env, c.req.url),
        enSegundoPlano: (promesa) => c.executionCtx.waitUntil(promesa),
      })
      : null;
    if (resultado === "anulado") return responderPedido(c, fila.id);
    if (resultado === "pagado") {
      throw new ErrorPublico(409, "Transbank confirmó que este pedido sí se pagó: quedó como pagado y no se anuló.");
    }
    if (resultado === "incierto") {
      throw new ErrorPublico(409, "No pudimos confirmar con Transbank si este pedido se pagó, así que no se anuló. Intenta de nuevo en unos minutos.");
    }
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

// ¿El estado del pago en Transbank muestra que la devolución ya se hizo?
// (anulado o reversado, o con el saldo rebajado en el total del pedido)
function devolucionHecha(estado, montoPago, total) {
  return estado?.status === "NULLIFIED" || estado?.status === "REVERSED"
    || (Number.isInteger(estado?.balance) && estado.balance <= montoPago - total);
}

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
  let yaDevuelto = false;   // la devolución ya estaba hecha (lo dice el estado del pago en Transbank)
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
    if (error) {
      // Puede que Transbank sí la haya hecho y la respuesta se perdiera (o que sea un reintento
      // de una devolución ya hecha): antes de anotar el error se pregunta el estado del pago.
      try {
        const estado = await estadoTransaccion(env, pago.token);
        if (devolucionHecha(estado, pago.monto, fila.total)) {
          respuesta = estado;
          error = null;
          yaDevuelto = true;
        }
      } catch (e) {
        error += ` | Estado: ${e?.message || e}`;
      }
    }
  }

  const momento = ahora();
  const json = respuesta ? JSON.stringify(respuesta).slice(0, 4000) : null;
  const texto = (valor, largo) => (valor === undefined || valor === null ? null : String(valor).slice(0, largo));
  const codigoRespuesta = Number.isInteger(respuesta?.response_code) ? respuesta.response_code : null;
  // Si se supo por el estado, el tipo es el estado del pago y no hay código de la devolución.
  const tipoReembolso = yaDevuelto ? (respuesta.status === "REVERSED" ? "REVERSED" : "NULLIFIED") : respuesta?.type;
  const codigoAutorizacion = yaDevuelto ? null : respuesta?.authorization_code;

  if (!error) {
    // Devolución hecha: transacción de reembolso + reembolso "devuelto" + pedido "reembolsado", juntos.
    await db.batch([
      db.prepare(
        `INSERT INTO transacciones (pedido_id, tipo, ambiente, token, orden_compra, monto, estado,
           codigo_respuesta, codigo_autorizacion, tipo_reembolso, respuesta_json, creado_en, actualizado_en)
         VALUES (?, 'reembolso', ?, ?, ?, ?, 'reembolsada', ?, ?, ?, ?, ?, ?)`
      ).bind(fila.id, ambiente, pago.token, pago.orden_compra, fila.total, codigoRespuesta,
        texto(codigoAutorizacion, 20), texto(tipoReembolso, 20), json, momento, momento),
      db.prepare(
        `UPDATE reembolsos SET estado = 'devuelto', devuelto_en = ?1, error = NULL,
           transaccion_id = (SELECT MAX(id) FROM transacciones WHERE pedido_id = ?2 AND tipo = 'reembolso')
         WHERE pedido_id = ?2 AND estado = 'aprobado'`
      ).bind(momento, fila.id),
      db.prepare(
        "UPDATE pedidos SET estado_pago = 'reembolsado', actualizado_en = ? WHERE id = ? AND estado_pago = 'pagado'"
      ).bind(momento, fila.id),
    ]);
    return {
      ok: true,
      mensaje: yaDevuelto
        ? `Webpay ya había devuelto ${plata(fila.total)} al medio de pago del comprador (lo confirma Transbank).`
        : `Webpay devolvió ${plata(fila.total)} al medio de pago del comprador.`,
    };
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
  if (!seLlamoAWebpay) {
    return {
      ok: false,
      mensaje: `Webpay no pudo hacer la devolución: ${error} Puedes devolver el dinero a mano y marcarlo como devuelto.`,
    };
  }
  // Nunca se sugiere devolver a mano sin revisar antes: el dinero pudo haberse devuelto igual.
  return {
    ok: false,
    mensaje: `No pudimos confirmar la devolución por Webpay: ${error} Antes de devolver el dinero a mano, revisa en el portal de Transbank si la devolución ya se hizo. Si no aparece, reintenta la devolución por Webpay.`,
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
    "Reembolso", "Codigo autorizacion", "Tarjeta", "Ambiente"]];
  for (const p of pedidos) {
    // Una vez por pedido (no por prenda): formatear fechas gasta CPU.
    const fecha = fechaChile(p.creadoEn);
    // Ambiente de Webpay del pago: "integracion" = tarjeta de prueba, no entró dinero real.
    const pago = p.transacciones.filter((t) => t.tipo === "pago" && t.estado === "autorizada").pop();
    for (const i of p.items) {
      filas.push([
        p.numero, fecha, p.comprador.nombre, p.comprador.correo, p.comprador.fono,
        p.retira.nombre, p.retira.tipo, p.retira.extra,
        i.id, i.nombre, i.talla, i.marca, i.estado, i.cant, i.precio,
        p.metodoPago, p.estadoPago, p.entrega, p.reembolso ? p.reembolso.estado : "",
        p.pago?.codigoAutorizacion || "", p.pago?.tarjeta || "", pago?.ambiente || "",
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

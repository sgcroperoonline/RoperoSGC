/* ================================================================
   MOCK DE WEBPAY PLUS (Transbank) PARA LOS TESTS
   ----------------------------------------------------------------
   La red del colegio (y la de los tests) no llega a Transbank, así
   que este servidor imita lo justo de Webpay Plus REST v1.2:

   API (la que llama nuestro servidor):
     POST /rswebpaytransaction/api/webpay/v1.2/transactions                 crear
     PUT  /rswebpaytransaction/api/webpay/v1.2/transactions/:token          confirmar (commit)
     GET  /rswebpaytransaction/api/webpay/v1.2/transactions/:token          estado
     POST /rswebpaytransaction/api/webpay/v1.2/transactions/:token/refunds  reembolsar

   Páginas (las que ve el navegador del comprador):
     GET|POST /webpayserver/initTransaction   formulario con botones
              "Pagar", "Rechazar", "Anular compra" y "Expirar"
     POST     /webpayserver/accion            vuelve a la tienda (return_url)
              igual que Transbank: un formulario que se envía solo.

   Control (solo para los tests):
     POST /__control   { accion: "reiniciar" }
                       { accion: "fallar", operacion, veces?, status?, mensaje?, procesar? }
                         (procesar: Transbank alcanzó a hacer el commit o la devolución,
                          pero la respuesta "se perdió"; sirve para confirmar y reembolsar.
                          cortar: en "crear", la respuesta se corta a mitad del cuerpo)
                       { accion: "tipoReembolso", tipo: "NULLIFIED" | "REVERSED" }
     GET  /__llamadas  lista de llamadas que hizo nuestro servidor a la API

   Exige las credenciales públicas de INTEGRACIÓN: así comprobamos que
   el servidor las usa por defecto cuando no hay WEBPAY_API_KEY.
   ================================================================ */

import http from "node:http";
import { randomBytes } from "node:crypto";

export const CODIGO_COMERCIO_INTEGRACION = "597055555532";
export const LLAVE_INTEGRACION = "579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C";

const BASE_API = "/rswebpaytransaction/api/webpay/v1.2/transactions";

// Datos fijos que devuelve el "banco" cuando el pago se aprueba (como en la documentación de Transbank)
export const PAGO_APROBADO = {
  vci: "TSY",
  authorization_code: "1213",
  card_number: "6623",
  payment_type_code: "VN",
  installments_number: 0
};

/** Levanta el mock en un puerto libre. Devuelve { url, puerto, llamadas, transacciones, control(), llamadasDe(), cerrar() } */
export async function iniciarMockWebpay() {
  const estado = {
    llamadas: [],                  // cada llamada a la API (para revisar headers y cuerpos)
    transacciones: new Map(),      // token -> transacción
    fallas: [],                    // fallas programadas: { operacion, veces, status, mensaje, procesar }
    tipoReembolso: "NULLIFIED"
  };

  // Aplica un comando de control (lo usa POST /__control y también los tests directamente)
  function control(cuerpo = {}) {
    if (cuerpo.accion === "reiniciar") {
      estado.llamadas.length = 0;
      estado.transacciones.clear();
      estado.fallas.length = 0;
      estado.tipoReembolso = "NULLIFIED";
      return { ok: true };
    }
    if (cuerpo.accion === "fallar") {
      const operaciones = ["crear", "confirmar", "estado", "reembolsar"];
      if (!operaciones.includes(cuerpo.operacion)) {
        throw new Error("operacion debe ser una de: " + operaciones.join(", "));
      }
      estado.fallas.push({
        operacion: cuerpo.operacion,
        veces: cuerpo.veces ?? 1,
        status: cuerpo.status ?? 500,
        mensaje: cuerpo.mensaje ?? "Error simulado por el mock de Webpay",
        procesar: Boolean(cuerpo.procesar),  // true: Transbank alcanzó a procesar, pero la respuesta "se perdió"
        cortar: Boolean(cuerpo.cortar)       // true: manda los encabezados y parte del cuerpo, y corta la conexión
      });
      return { ok: true };
    }
    if (cuerpo.accion === "tipoReembolso") {
      if (!["NULLIFIED", "REVERSED"].includes(cuerpo.tipo)) throw new Error("tipo debe ser NULLIFIED o REVERSED");
      estado.tipoReembolso = cuerpo.tipo;
      return { ok: true };
    }
    throw new Error("Acción de control desconocida: " + cuerpo.accion);
  }

  // Si hay una falla programada para esta operación, la consume y la devuelve
  function tomarFalla(operacion) {
    const falla = estado.fallas.find(f => f.operacion === operacion && f.veces > 0);
    if (!falla) return null;
    falla.veces--;
    return falla;
  }

  const servidor = http.createServer(async (req, res) => {
    try {
      await atender(req, res);
    } catch (error) {
      responderJson(res, 500, { error_message: "Error interno del mock: " + error.message });
    }
  });

  let urlBase = "";

  async function atender(req, res) {
    const url = new URL(req.url, urlBase);
    const ruta = url.pathname;
    const textoCuerpo = await leerCuerpo(req);

    // ---------- Control para los tests ----------
    if (ruta === "/__control" && req.method === "POST") {
      try {
        return responderJson(res, 200, control(JSON.parse(textoCuerpo || "{}")));
      } catch (error) {
        return responderJson(res, 400, { error: error.message });
      }
    }
    if (ruta === "/__llamadas" && req.method === "GET") {
      return responderJson(res, 200, estado.llamadas);
    }
    if (ruta === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    // ---------- Páginas del navegador ----------
    if (ruta === "/webpayserver/initTransaction" && (req.method === "GET" || req.method === "POST")) {
      const campos = req.method === "POST" ? new URLSearchParams(textoCuerpo) : url.searchParams;
      const tx = estado.transacciones.get(campos.get("token_ws") || "");
      if (!tx) return responderHtml(res, 404, paginaSimple("Transacción no encontrada", "El token_ws no existe en el mock."));
      return responderHtml(res, 200, paginaPago(tx));
    }
    if (ruta === "/webpayserver/accion" && req.method === "POST") {
      const campos = new URLSearchParams(textoCuerpo);
      const tx = estado.transacciones.get(campos.get("token_ws") || "");
      if (!tx) return responderHtml(res, 404, paginaSimple("Transacción no encontrada", "El token_ws no existe en el mock."));
      return responderHtml(res, 200, paginaRetorno(tx, campos.get("accion")));
    }

    // ---------- API REST de Webpay Plus ----------
    if (ruta === BASE_API || ruta.startsWith(BASE_API + "/")) {
      return atenderApi(req, res, ruta.slice(BASE_API.length), textoCuerpo);
    }

    responderJson(res, 404, { error_message: "Ruta no existe en el mock: " + req.method + " " + ruta });
  }

  function atenderApi(req, res, resto, textoCuerpo) {
    // resto: "" | "/<token>" | "/<token>/refunds"
    const partes = resto.split("/").filter(Boolean);
    let operacion = null;
    if (req.method === "POST" && partes.length === 0) operacion = "crear";
    else if (req.method === "PUT" && partes.length === 1) operacion = "confirmar";
    else if (req.method === "GET" && partes.length === 1) operacion = "estado";
    else if (req.method === "POST" && partes.length === 2 && partes[1] === "refunds") operacion = "reembolsar";

    let cuerpo = null;
    if (textoCuerpo) {
      try { cuerpo = JSON.parse(textoCuerpo); } catch { cuerpo = textoCuerpo; }
    }

    const llamada = {
      operacion,
      metodo: req.method,
      ruta: BASE_API + resto,
      token: partes[0] || null,
      cuerpo,
      apiKeyId: req.headers["tbk-api-key-id"] ?? null,
      apiKeySecret: req.headers["tbk-api-key-secret"] ?? null,
      contentType: req.headers["content-type"] ?? null,
      autorizado: false,
      status: 0,
      fecha: new Date().toISOString()
    };
    estado.llamadas.push(llamada);

    const responder = (status, datos) => {
      llamada.status = status;
      llamada.respuesta = datos;
      responderJson(res, status, datos);
    };
    // Encabezados y el comienzo del cuerpo, y después se corta la conexión
    responder.cortar = () => {
      llamada.status = 200;
      llamada.respuesta = "(cortada)";
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Length": "500" });
      res.write('{"token":"');
      setTimeout(() => res.destroy(), 50);
    };

    if (!operacion) return responder(404, { error_message: "Operación no soportada por el mock" });

    // Credenciales de integración obligatorias (como Transbank: si no calzan, 401)
    if (llamada.apiKeyId !== CODIGO_COMERCIO_INTEGRACION || llamada.apiKeySecret !== LLAVE_INTEGRACION) {
      return responder(401, { error_message: "Not Authorized" });
    }
    llamada.autorizado = true;

    // Las operaciones que mandan JSON deben decir que es JSON
    if ((operacion === "crear" || operacion === "reembolsar") && !String(llamada.contentType || "").includes("application/json")) {
      return responder(415, { error_message: "Content-Type debe ser application/json" });
    }

    if (operacion === "crear") return crear(cuerpo, responder);

    const tx = estado.transacciones.get(llamada.token);
    if (!tx) return responder(404, { error_message: "Transaction not found" });

    if (operacion === "confirmar") return confirmar(tx, responder);
    if (operacion === "estado") return consultarEstado(tx, responder);
    return reembolsar(tx, cuerpo, responder);
  }

  function crear(cuerpo, responder) {
    const falla = tomarFalla("crear");
    if (falla?.cortar) return responder.cortar();
    if (falla) return responder(falla.status, { error_message: falla.mensaje });

    const c = cuerpo && typeof cuerpo === "object" ? cuerpo : {};
    const errores = [];
    if (typeof c.buy_order !== "string" || !c.buy_order || c.buy_order.length > 26) errores.push("buy_order inválido (texto de 1 a 26)");
    if (typeof c.session_id !== "string" || !c.session_id || c.session_id.length > 61) errores.push("session_id inválido (texto de 1 a 61)");
    if (!Number.isInteger(c.amount) || c.amount <= 0) errores.push("amount debe ser un entero mayor que 0");
    if (typeof c.return_url !== "string" || !/^https?:\/\//.test(c.return_url) || c.return_url.length > 255) errores.push("return_url inválida");
    if (errores.length) return responder(422, { error_message: errores.join("; ") });

    const token = randomBytes(32).toString("hex");   // 64 caracteres, como los tokens reales
    estado.transacciones.set(token, {
      token,
      buy_order: c.buy_order,
      session_id: c.session_id,
      amount: c.amount,
      return_url: c.return_url,
      balance: c.amount,
      estado: "INITIALIZED",     // INITIALIZED -> AUTHORIZED | FAILED | ABORTED | NULLIFIED | REVERSED
      decision: null,            // lo que hizo el comprador en la página: pagar | rechazar | anular | expirar
      confirmada: false,
      transaction_date: new Date().toISOString()
    });
    responder(200, { token, url: urlBase + "/webpayserver/initTransaction" });
  }

  // Forma de la respuesta de commit/estado de Transbank
  function respuestaTransaccion(tx) {
    const aprobada = tx.estado === "AUTHORIZED" || tx.estado === "NULLIFIED" || tx.estado === "REVERSED";
    const base = {
      vci: tx.decision === "pagar" ? PAGO_APROBADO.vci : "TSN",
      amount: tx.amount,
      status: tx.estado,
      buy_order: tx.buy_order,
      session_id: tx.session_id,
      card_detail: { card_number: PAGO_APROBADO.card_number },
      accounting_date: fechaContable(tx.transaction_date),
      transaction_date: tx.transaction_date,
      authorization_code: aprobada ? PAGO_APROBADO.authorization_code : "000000",
      payment_type_code: PAGO_APROBADO.payment_type_code,
      response_code: aprobada ? 0 : -1,
      installments_number: PAGO_APROBADO.installments_number
    };
    return base;
  }

  // Aplica el commit en la transacción. Devuelve null si se pudo, o un mensaje de error.
  function procesarConfirmacion(tx) {
    if (tx.confirmada) return "Transaction already locked by another process";
    if (tx.decision === "pagar") tx.estado = "AUTHORIZED";
    else if (tx.decision === "rechazar") tx.estado = "FAILED";
    else return `Invalid status '${tx.estado}' for transaction while authorizing`;
    tx.confirmada = true;
    return null;
  }

  function confirmar(tx, responder) {
    const falla = tomarFalla("confirmar");
    if (falla) {
      if (falla.procesar) procesarConfirmacion(tx);   // Transbank lo procesó pero la respuesta no llegó
      return responder(falla.status, { error_message: falla.mensaje });
    }
    const error = procesarConfirmacion(tx);
    if (error) return responder(422, { error_message: error });
    responder(200, respuestaTransaccion(tx));
  }

  function consultarEstado(tx, responder) {
    const falla = tomarFalla("estado");
    if (falla) return responder(falla.status, { error_message: falla.mensaje });
    if (!tx.confirmada) {
      return responder(200, {
        amount: tx.amount,
        status: tx.estado,
        buy_order: tx.buy_order,
        session_id: tx.session_id,
        accounting_date: fechaContable(tx.transaction_date),
        transaction_date: tx.transaction_date,
        installments_number: 0
      });
    }
    responder(200, { ...respuestaTransaccion(tx), balance: tx.balance });
  }

  function reembolsar(tx, cuerpo, responder) {
    const falla = tomarFalla("reembolsar");
    // procesar: true -> Transbank hace la devolución, pero la respuesta "se pierde" (responde la falla)
    if (falla && !falla.procesar) return responder(falla.status, { error_message: falla.mensaje });
    const responderFinal = falla ? () => responder(falla.status, { error_message: falla.mensaje }) : responder;

    const monto = cuerpo && typeof cuerpo === "object" ? cuerpo.amount : undefined;
    if (!Number.isInteger(monto) || monto <= 0) return responder(422, { error_message: "amount debe ser un entero mayor que 0" });
    if (tx.estado !== "AUTHORIZED") return responder(422, { error_message: `Invalid status '${tx.estado}' for transaction while refunding` });
    if (monto > tx.balance) return responder(422, { error_message: "Amount to refund is greater than the balance" });

    tx.balance -= monto;
    tx.reembolsos = (tx.reembolsos || 0) + 1;
    if (estado.tipoReembolso === "REVERSED") {
      tx.estado = "REVERSED";
      tx.balance = 0;
      return responderFinal(200, { type: "REVERSED" });
    }
    if (tx.balance === 0) tx.estado = "NULLIFIED";
    responderFinal(200, {
      type: "NULLIFIED",
      authorization_code: "123456",
      authorization_date: new Date().toISOString(),
      nullified_amount: monto,
      balance: tx.balance,
      response_code: 0
    });
  }

  // ---------- HTML de las páginas del navegador ----------
  function paginaPago(tx) {
    const monto = "$" + Number(tx.amount).toLocaleString("es-CL");
    return `<!DOCTYPE html>
<html lang="es-CL"><head><meta charset="UTF-8"><title>Webpay (simulado para tests)</title></head>
<body>
  <h1>Webpay Plus · simulador de pruebas</h1>
  <p>Orden de compra: <strong id="orden">${escaparHtml(tx.buy_order)}</strong></p>
  <p>Monto: <strong id="monto">${escaparHtml(monto)}</strong></p>
  <form method="post" action="/webpayserver/accion">
    <input type="hidden" name="token_ws" value="${escaparHtml(tx.token)}">
    <button type="submit" name="accion" value="pagar">Pagar</button>
    <button type="submit" name="accion" value="rechazar">Rechazar</button>
    <button type="submit" name="accion" value="anular">Anular compra</button>
    <button type="submit" name="accion" value="expirar">Expirar</button>
  </form>
</body></html>`;
  }

  // Igual que Transbank: una página con un formulario que se envía solo hacia return_url
  function paginaRetorno(tx, accion) {
    let metodo = "post";
    let campos;
    if (accion === "pagar" || accion === "rechazar") {
      tx.decision = accion;
      campos = { token_ws: tx.token };                                     // flujo normal
    } else if (accion === "anular") {
      tx.decision = "anular";
      if (!tx.confirmada) tx.estado = "ABORTED";
      campos = { TBK_TOKEN: tx.token, TBK_ORDEN_COMPRA: tx.buy_order, TBK_ID_SESION: tx.session_id };   // abortado
    } else if (accion === "expirar") {
      tx.decision = "expirar";
      if (!tx.confirmada) tx.estado = "ABORTED";
      metodo = "get";   // el timeout lo mandamos por GET para probar que el retorno acepta ambos métodos
      campos = { TBK_ORDEN_COMPRA: tx.buy_order, TBK_ID_SESION: tx.session_id };                         // timeout
    } else {
      return paginaSimple("Acción desconocida", "Usa pagar, rechazar, anular o expirar.");
    }
    const ocultos = Object.entries(campos)
      .map(([k, v]) => `<input type="hidden" name="${escaparHtml(k)}" value="${escaparHtml(v)}">`).join("\n    ");
    return `<!DOCTYPE html>
<html lang="es-CL"><head><meta charset="UTF-8"><title>Volviendo al comercio</title></head>
<body onload="document.forms[0].submit()">
  <form method="${metodo}" action="${escaparHtml(tx.return_url)}">
    ${ocultos}
    <noscript><button type="submit">Volver al comercio</button></noscript>
  </form>
</body></html>`;
  }

  await new Promise((resolver, rechazar) => {
    servidor.once("error", rechazar);
    servidor.listen(0, "127.0.0.1", resolver);
  });
  const puerto = servidor.address().port;
  urlBase = `http://127.0.0.1:${puerto}`;

  return {
    url: urlBase,
    puerto,
    llamadas: estado.llamadas,
    transacciones: estado.transacciones,
    control,
    /** Llamadas autorizadas de una operación (opcionalmente de un token) */
    llamadasDe(operacion, token) {
      return estado.llamadas.filter(l => l.operacion === operacion && (token === undefined || l.token === token));
    },
    cerrar() {
      return new Promise(resolver => {
        servidor.closeAllConnections?.();
        servidor.close(() => resolver());
      });
    }
  };
}

/* ---------- Utilidades ---------- */

function leerCuerpo(req) {
  return new Promise((resolver, rechazar) => {
    const trozos = [];
    req.on("data", t => trozos.push(t));
    req.on("end", () => resolver(Buffer.concat(trozos).toString("utf8")));
    req.on("error", rechazar);
  });
}

function responderJson(res, status, datos) {
  const texto = JSON.stringify(datos);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(texto) });
  res.end(texto);
}

function responderHtml(res, status, html) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
  res.end(html);
}

function paginaSimple(titulo, texto) {
  return `<!DOCTYPE html><html lang="es-CL"><head><meta charset="UTF-8"><title>${escaparHtml(titulo)}</title></head>
<body><h1>${escaparHtml(titulo)}</h1><p>${escaparHtml(texto)}</p></body></html>`;
}

function escaparHtml(t) {
  return String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Transbank manda la fecha contable como MMDD
function fechaContable(iso) {
  const d = new Date(iso);
  return String(d.getUTCMonth() + 1).padStart(2, "0") + String(d.getUTCDate()).padStart(2, "0");
}

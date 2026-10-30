// Conexión con Webpay Plus de Transbank usando su API REST (sin SDK).
// Documentación: https://www.transbankdevelopers.cl/referencia/webpay
import { configWebpay } from "./config.js";

const RUTA = "/rswebpaytransaction/api/webpay/v1.2/transactions";

// Error al hablar con Transbank (red caída, respuesta con error, etc.).
// estadoHttp: el código HTTP si Transbank alcanzó a responder (null si no hubo respuesta).
export class ErrorWebpay extends Error {
  constructor(mensaje, estadoHttp = null) {
    super(mensaje);
    this.estadoHttp = estadoHttp;
  }
}

// Hace una llamada a Transbank y devuelve su respuesta JSON.
async function llamar(env, metodo, ruta, cuerpo) {
  const config = configWebpay(env);
  if (config.error) throw new ErrorWebpay(config.error);

  let respuesta;
  let texto;
  try {
    respuesta = await fetch(config.base + RUTA + ruta, {
      method: metodo,
      headers: {
        "Tbk-Api-Key-Id": config.comercio,
        "Tbk-Api-Key-Secret": config.llave,
        "Content-Type": "application/json",
      },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      // Si Transbank no contesta en 15 segundos, nos rendimos (y no dejamos al comprador esperando).
      signal: AbortSignal.timeout(15000),
    });
    // El cuerpo también puede cortarse o demorar: se lee dentro del mismo try.
    texto = await respuesta.text();
  } catch (error) {
    const motivo = error?.name === "TimeoutError" ? "Webpay no respondió a tiempo" : "No se pudo conectar con Webpay";
    throw new ErrorWebpay(`${motivo} (${error?.message || error}).`);
  }

  let datos = null;
  try {
    datos = JSON.parse(texto);
  } catch {
    // se revisa abajo
  }
  if (!respuesta.ok) {
    const mensaje = typeof datos?.error_message === "string" ? datos.error_message : texto.slice(0, 200);
    throw new ErrorWebpay(`Webpay respondió ${respuesta.status}: ${mensaje || "sin detalle"}`, respuesta.status);
  }
  if (!datos || typeof datos !== "object") throw new ErrorWebpay("Webpay entregó una respuesta que no se entiende.");
  return datos;
}

const ruta = (token) => "/" + encodeURIComponent(token);

/** Crea la transacción. Devuelve { token, url } para enviar al comprador a pagar. */
export async function crearTransaccion(env, { ordenCompra, idSesion, monto, urlRetorno }) {
  const datos = await llamar(env, "POST", "", {
    buy_order: ordenCompra,
    session_id: idSesion,
    amount: monto,
    return_url: urlRetorno,
  });
  if (typeof datos.token !== "string" || !datos.token || datos.token.length > 200 ||
      typeof datos.url !== "string" || !/^https?:\/\//.test(datos.url)) {
    throw new ErrorWebpay("Webpay no entregó el token o la dirección de pago.");
  }
  return { token: datos.token, url: datos.url };
}

/** Confirma (commit) el pago. Solo aquí Transbank cobra de verdad. */
export function confirmarTransaccion(env, token) {
  return llamar(env, "PUT", ruta(token), {});
}

/** Consulta el estado de una transacción (sirve si la confirmación falló a medias). */
export function estadoTransaccion(env, token) {
  return llamar(env, "GET", ruta(token));
}

/** Devuelve dinero (reembolso) de un pago ya confirmado. */
export function reembolsarTransaccion(env, token, monto) {
  return llamar(env, "POST", ruta(token) + "/refunds", { amount: monto });
}

// ¿La respuesta de commit/estado dice que el pago quedó aprobado?
export function pagoAutorizado(respuesta) {
  return respuesta?.response_code === 0 && respuesta?.status === "AUTHORIZED";
}

// ¿La respuesta del reembolso dice que el dinero se devolvió?
export function reembolsoExitoso(respuesta) {
  return respuesta?.type === "REVERSED" || (respuesta?.type === "NULLIFIED" && respuesta?.response_code === 0);
}

// Estados con los que Transbank dice que el pago NO quedó hecho (no hubo cobro, o se reversó).
export const ESTADOS_SIN_COBRO = ["FAILED", "REVERSED", "NULLIFIED", "ABORTED"];

// Nombre en palabras del tipo de pago que informa Transbank.
export const TIPOS_DE_PAGO = {
  VD: "Débito",
  VN: "Crédito",
  VC: "Crédito en cuotas",
  SI: "3 cuotas sin interés",
  S2: "2 cuotas sin interés",
  NC: "N cuotas sin interés",
  VP: "Prepago",
};

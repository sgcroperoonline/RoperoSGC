// Configuración que sale de las variables de Cloudflare (wrangler.jsonc y secretos).
// Las claves NUNCA se escriben en el código: llegan en "env".
import { CONFIG } from "../public/js/datos.js";

// Credenciales PÚBLICAS de pruebas que Transbank publica para su ambiente de integración.
// Con ellas nadie paga de verdad.
export const WEBPAY_INTEGRACION = {
  host: "https://webpay3gint.transbank.cl",
  comercio: "597055555532",
  llave: "579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C",
};
const WEBPAY_HOST_PRODUCCION = "https://webpay3g.transbank.cl";

const texto = (valor) => (typeof valor === "string" ? valor.trim() : "");

/**
 * Datos para hablar con Webpay según el ambiente.
 * En "produccion" se exigen credenciales propias y se ignora WEBPAY_URL_BASE
 * (esa variable existe solo para que las pruebas usen una imitación de Transbank).
 */
export function configWebpay(env) {
  const ambiente = texto(env.WEBPAY_AMBIENTE).toLowerCase() === "produccion" ? "produccion" : "integracion";
  const comercio = texto(env.WEBPAY_CODIGO_COMERCIO);
  const llave = texto(env.WEBPAY_API_KEY);

  if (ambiente === "produccion") {
    let error = null;
    if (!llave || llave === WEBPAY_INTEGRACION.llave) {
      error = "Webpay está en producción pero falta su llave secreta propia (secreto WEBPAY_API_KEY).";
    } else if (!comercio || comercio === WEBPAY_INTEGRACION.comercio) {
      error = "Webpay está en producción pero falta el código de comercio propio (WEBPAY_CODIGO_COMERCIO).";
    }
    return { ambiente, base: WEBPAY_HOST_PRODUCCION, comercio, llave, error };
  }

  const base = (texto(env.WEBPAY_URL_BASE) || WEBPAY_INTEGRACION.host).replace(/\/+$/, "");
  return {
    ambiente,
    base,
    comercio: comercio || WEBPAY_INTEGRACION.comercio,
    llave: llave || WEBPAY_INTEGRACION.llave,
    error: null,
  };
}

// Minutos que un pedido Webpay puede quedar sin pagar antes de anularse (por defecto 20).
// Acepta decimales y 0 (las pruebas automáticas lo usan para no esperar 20 minutos).
export function minutosExpiraWebpay(env) {
  const valor = texto(env.MINUTOS_EXPIRA_WEBPAY);
  const minutos = Number(valor);
  return valor !== "" && Number.isFinite(minutos) && minutos >= 0 ? minutos : 20;
}

// Los correos funcionan solo si están el servidor, el usuario y la contraseña.
export function correoActivo(env) {
  return Boolean(texto(env.SMTP_HOST) && texto(env.SMTP_USUARIO) && texto(env.SMTP_CLAVE));
}

// Opciones para worker-mailer según SMTP_SEGURIDAD: tls | starttls | ninguna.
export function opcionesSmtp(env) {
  const seguridad = texto(env.SMTP_SEGURIDAD).toLowerCase() || "tls";
  const puertoPorDefecto = { tls: 465, starttls: 587, ninguna: 25 }[seguridad] || 465;
  const puerto = parseInt(texto(env.SMTP_PUERTO), 10) || puertoPorDefecto;
  return {
    host: texto(env.SMTP_HOST),
    port: puerto,
    // "ninguna" (sin cifrar) existe solo para las pruebas automáticas.
    secure: seguridad !== "starttls" && seguridad !== "ninguna",
    startTls: seguridad === "starttls",
    credentials: { username: texto(env.SMTP_USUARIO), password: texto(env.SMTP_CLAVE) },
    authType: "plain",
    socketTimeoutMs: 15000,
    responseTimeoutMs: 15000,
  };
}

// Dirección que aparece como remitente de los correos.
export function remitenteCorreo(env) {
  return texto(env.SMTP_REMITENTE) || texto(env.SMTP_USUARIO);
}

// A quién le llega el aviso de pedido nuevo.
export function destinoAvisos(env) {
  return texto(env.CORREO_AVISOS) || CONFIG.correo;
}

// Dirección pública de la tienda: URL_PUBLICA o, si está vacía, la de la petición.
export function origenPublico(env, urlPeticion) {
  const publica = texto(env.URL_PUBLICA).replace(/\/+$/, "");
  if (/^https?:\/\/[^\s"'<>]+$/i.test(publica)) return publica;
  return new URL(urlPeticion).origin;
}

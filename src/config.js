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

const seguridadSmtp = (env) => texto(env.SMTP_SEGURIDAD).toLowerCase() || "tls";

/**
 * Motivo por el que la configuración del correo no se puede usar (o null si está bien).
 * Solo se acepta "tls" (puerto 465): con "starttls" worker-mailer manda la contraseña
 * sin cifrar si el servidor no ofrece STARTTLS. "ninguna" existe solo para las pruebas
 * automáticas, con un servidor de correo en el mismo computador.
 */
export function errorSmtp(env) {
  const seguridad = seguridadSmtp(env);
  if (seguridad === "tls") return null;
  const host = texto(env.SMTP_HOST).toLowerCase();
  if (seguridad === "ninguna" && (host === "127.0.0.1" || host === "localhost")) return null;
  return `SMTP_SEGURIDAD="${seguridad}" no se acepta: usa "tls" (puerto 465). Los correos quedan desactivados.`;
}

// ¿Están el servidor, el usuario y la contraseña del correo?
export function correoConfigurado(env) {
  return Boolean(texto(env.SMTP_HOST) && texto(env.SMTP_USUARIO) && texto(env.SMTP_CLAVE));
}

// Los correos funcionan solo si están configurados y de forma segura.
export function correoActivo(env) {
  return correoConfigurado(env) && !errorSmtp(env);
}

// Opciones para worker-mailer según SMTP_SEGURIDAD: tls (o ninguna, solo en pruebas).
export function opcionesSmtp(env) {
  const seguridad = seguridadSmtp(env);
  const puerto = parseInt(texto(env.SMTP_PUERTO), 10) || (seguridad === "ninguna" ? 25 : 465);
  return {
    host: texto(env.SMTP_HOST),
    port: puerto,
    secure: seguridad === "tls",
    startTls: false,
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
// En el cron no hay petición: sin URL_PUBLICA devuelve "" (los correos van sin links).
export function origenPublico(env, urlPeticion) {
  const publica = texto(env.URL_PUBLICA).replace(/\/+$/, "");
  if (/^https?:\/\/[^\s"'<>]+$/i.test(publica)) return publica;
  return urlPeticion ? new URL(urlPeticion).origin : "";
}

// Herramientas pequeñas que usan varios archivos del servidor.

/**
 * Error con un mensaje pensado para mostrárselo a la persona (en español)
 * y el código HTTP que corresponde. index.js lo convierte en { error: "…" }.
 */
export class ErrorPublico extends Error {
  constructor(estadoHttp, mensaje, extra = {}) {
    super(mensaje);
    this.estadoHttp = estadoHttp;
    this.extra = extra;
  }
}

// Fecha y hora actual en el formato que usa la base de datos (ISO en UTC).
export const ahora = () => new Date().toISOString();

// Fecha de hace "ms" milisegundos, en el mismo formato.
export const haceMs = (ms) => new Date(Date.now() - ms).toISOString();

export const UN_DIA_MS = 24 * 60 * 60 * 1000;

// Bytes al azar, seguros para claves (crypto.getRandomValues, no Math.random).
export function bytesAleatorios(cantidad) {
  const bytes = new Uint8Array(cantidad);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function aHex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// base64url = base64 sin los caracteres que molestan en una URL (+ / =).
export function aBase64Url(bytes) {
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function deBase64Url(texto) {
  try {
    const base64 = texto.replace(/-/g, "+").replace(/_/g, "/");
    const binario = atob(base64 + "===".slice((base64.length + 3) % 4));
    return Uint8Array.from(binario, (letra) => letra.charCodeAt(0));
  } catch {
    return null;
  }
}

// Compara dos textos sin que el tiempo que demora revele cuántas letras coinciden.
// Se comparan sus resúmenes SHA-256 (siempre 32 bytes) byte por byte, sin salir antes.
export async function igualesSeguro(a, b) {
  const codificar = new TextEncoder();
  const [resumenA, resumenB] = await Promise.all([
    crypto.subtle.digest("SHA-256", codificar.encode(String(a))),
    crypto.subtle.digest("SHA-256", codificar.encode(String(b))),
  ]);
  const x = new Uint8Array(resumenA);
  const y = new Uint8Array(resumenB);
  let diferencia = 0;
  for (let i = 0; i < x.length; i++) diferencia |= x[i] ^ y[i];
  return diferencia === 0;
}

// 8000 -> "$8.000"
export function plata(monto) {
  return "$" + String(Math.round(Number(monto) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// Texto de una sola línea: sin saltos de línea ni caracteres invisibles.
// Así nadie puede "inyectar" encabezados en los correos con su nombre.
export function textoLinea(valor) {
  if (typeof valor !== "string") return "";
  return valor.replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
}

// Texto de varias líneas (motivos, observaciones): deja los saltos de línea normales.
export function textoLargo(valor) {
  if (typeof valor !== "string") return "";
  return valor
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F\u2028\u2029]/g, "")
    .trim();
}

// Lee el cuerpo JSON de la petición. Si no es un objeto válido responde 400.
export async function leerJSON(c) {
  let datos;
  try {
    datos = await c.req.json();
  } catch {
    throw new ErrorPublico(400, "Los datos enviados no son válidos.");
  }
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) {
    throw new ErrorPublico(400, "Los datos enviados no son válidos.");
  }
  return datos;
}

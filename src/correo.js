// Envío de correos por SMTP con worker-mailer.
// Siempre se llama dentro de ctx.waitUntil: si el correo falla, el pedido igual queda bien.
import { LogLevel, WorkerMailer } from "worker-mailer";
import { correoActivo, destinoAvisos, opcionesSmtp, remitenteCorreo } from "./config.js";
import { cargarPedido } from "./db.js";
import { correoAviso, correoComprador } from "./plantillas.js";

// En los encabezados del correo no pueden ir comillas ni saltos de línea.
const nombreSeguro = (nombre) => String(nombre || "").replace(/["\\\r\n]/g, "").slice(0, 100);

/**
 * Manda el comprobante al comprador y el aviso al ropero.
 * Nunca lanza errores: si algo falla, lo deja anotado en los registros (console.error).
 */
export async function enviarCorreosPedido(env, pedidoId, origen) {
  if (!correoActivo(env)) return;
  try {
    const pedido = await cargarPedido(env.DB, pedidoId, true);
    if (!pedido) return;

    const remitente = { name: "Ropero SG", email: remitenteCorreo(env) };
    const paraComprador = correoComprador(pedido, origen);
    const paraRopero = correoAviso(pedido, origen);
    const mensajes = [
      {
        to: { name: nombreSeguro(pedido.comprador.nombre), email: pedido.comprador.correo },
        ...paraComprador,
      },
      { to: { email: destinoAvisos(env) }, ...paraRopero },
    ];

    const cartero = await WorkerMailer.connect({ ...opcionesSmtp(env), logLevel: LogLevel.WARN });
    try {
      for (const m of mensajes) {
        try {
          await cartero.send({ from: remitente, to: m.to, subject: m.asunto, text: m.texto, html: m.html });
        } catch (error) {
          console.error(`No se pudo enviar el correo "${m.asunto}":`, error?.message || error);
        }
      }
    } finally {
      await cartero.close();
    }
  } catch (error) {
    console.error(`No se pudieron enviar los correos del pedido ${pedidoId}:`, error?.message || error);
  }
}

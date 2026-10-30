// Textos de los correos (versión texto simple y versión HTML).
// Todo lo que viene de la base de datos se "escapa" antes de ponerlo en HTML.
import { CONFIG } from "../public/js/datos.js";
import { TIPOS_DE_PAGO } from "./webpay.js";
import { plata } from "./util.js";

export function escaparHtml(valor) {
  return String(valor ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Se crea una sola vez: crear un formateador nuevo en cada fecha gasta mucha CPU
// (el plan gratis da 10 ms por petición y el CSV formatea cientos de fechas).
const PARTES_CHILE = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Santiago", hourCycle: "h23",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
});

// Fecha en hora de Chile, por ejemplo "04-03-2026 12:20:00".
export function fechaChile(iso) {
  if (!iso) return "";
  try {
    const p = {};
    for (const { type, value } of PARTES_CHILE.formatToParts(new Date(iso))) p[type] = value;
    return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return iso;
  }
}

const QUIEN_RETIRA = { apoderado: "Apoderado o apoderada", estudiante: "Estudiante", tercero: "Otra persona" };

function textoRetira(pedido) {
  const r = pedido.retira;
  return `${r.nombre} (${QUIEN_RETIRA[r.tipo] || r.tipo}${r.extra ? " · " + r.extra : ""})`;
}

// Una línea por prenda: código, nombre, talla, cantidad y precio.
function lineasPrendas(pedido) {
  return pedido.items.map((i) =>
    `${i.id} · ${i.nombre} · Talla ${i.talla} · ${i.cant} x ${plata(i.precio)}`);
}

// Explicación del pago según el medio elegido.
function lineasPago(pedido) {
  if (pedido.metodoPago === "webpay") {
    const p = pedido.pago || {};
    return [
      "Pagado con Webpay.",
      `Código de autorización: ${p.codigoAutorizacion || "-"}`,
      `Tarjeta terminada en ${p.tarjeta || "----"}`,
      `Tipo de pago: ${TIPOS_DE_PAGO[p.tipoPago] || p.tipoPago || "-"}${p.cuotas ? ` · ${p.cuotas} cuotas` : ""}`,
    ];
  }
  if (pedido.metodoPago === "transferencia") {
    return [
      "Pago por transferencia: pendiente.",
      CONFIG.datosTransferencia
        ? `Datos para transferir: ${CONFIG.datosTransferencia}`
        : `Escríbenos a ${CONFIG.correo} para recibir los datos de la cuenta.`,
      `Indica el número de pedido ${pedido.numero} en el comentario de la transferencia.`,
    ];
  }
  return ["Pagas en efectivo al retirar en el ropero."];
}

// Convierte una lista de líneas en párrafos HTML (escapando cada una).
const parrafos = (lineas) => lineas.map((l) => `<p style="margin:0 0 4px">${escaparHtml(l)}</p>`).join("");

function tablaPrendasHtml(pedido) {
  const filas = pedido.items.map((i) => `
      <tr>
        <td style="padding:4px 8px;border-bottom:1px solid #ddd">${escaparHtml(i.id)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #ddd">${escaparHtml(i.nombre)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #ddd">${escaparHtml(i.talla)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #ddd;text-align:right">${escaparHtml(i.cant)}</td>
        <td style="padding:4px 8px;border-bottom:1px solid #ddd;text-align:right">${escaparHtml(plata(i.precio))}</td>
      </tr>`).join("");
  return `
    <table style="border-collapse:collapse;font-size:14px;margin:8px 0">
      <tr>
        <th style="padding:4px 8px;text-align:left">Código</th><th style="padding:4px 8px;text-align:left">Prenda</th>
        <th style="padding:4px 8px;text-align:left">Talla</th><th style="padding:4px 8px;text-align:right">Cant.</th>
        <th style="padding:4px 8px;text-align:right">Precio</th>
      </tr>${filas}
      <tr><td colspan="4" style="padding:6px 8px;text-align:right"><strong>Total</strong></td>
          <td style="padding:6px 8px;text-align:right"><strong>${escaparHtml(plata(pedido.total))}</strong></td></tr>
    </table>`;
}

const envolverHtml = (contenido) => `<!doctype html>
<html lang="es"><body style="font-family:Arial,Helvetica,sans-serif;color:#1d2433;line-height:1.45">
${contenido}
<p style="margin-top:24px;color:#667">Ropero SG · Saint George's College</p>
</body></html>`;

/** Correo de confirmación para quien compró. */
export function correoComprador(pedido, origen) {
  const asunto = `Ropero SG · Pedido ${pedido.numero} confirmado`;
  const tienda = origen + "/";
  const retiro = [
    `Lugar: ${CONFIG.lugarRetiro}`,
    `Horario: ${CONFIG.horarioRetiro}`,
    `Retira: ${textoRetira(pedido)}`,
    "Lleva tu número de pedido anotado o en el teléfono.",
  ];
  const plazo = pedido.metodoPago === "webpay"
    ? `Si algo no te sirve, tienes ${CONFIG.diasReembolso} días desde el pago para pedir un reembolso en "Mis pedidos" de la tienda, con tu número de pedido y este correo.`
    : `Una vez pagado el pedido, tienes ${CONFIG.diasReembolso} días para pedir un reembolso en "Mis pedidos" de la tienda, con tu número de pedido y este correo.`;

  const texto = [
    `Hola ${pedido.comprador.nombre}:`,
    "",
    "¡Gracias por comprar en Ropero SG! Tu pedido quedó confirmado.",
    "",
    `Número de pedido: ${pedido.numero}`,
    "",
    "Prendas:",
    ...lineasPrendas(pedido).map((l) => "- " + l),
    `Total: ${plata(pedido.total)}`,
    "",
    "Pago:",
    ...lineasPago(pedido),
    "",
    "Retiro:",
    ...retiro,
    "",
    plazo,
    ...(origen ? ["", `Tienda: ${tienda}`] : []),
    "",
    "Ropero SG · Saint George's College",
  ].join("\n");

  const html = envolverHtml(`
<h2 style="margin:0 0 8px">¡Gracias por comprar en Ropero SG!</h2>
<p>Hola ${escaparHtml(pedido.comprador.nombre)}: tu pedido quedó confirmado.</p>
<p style="font-size:18px">Número de pedido: <strong>${escaparHtml(pedido.numero)}</strong></p>
<h3 style="margin:16px 0 4px">Prendas</h3>
${tablaPrendasHtml(pedido)}
<h3 style="margin:16px 0 4px">Pago</h3>
${parrafos(lineasPago(pedido))}
<h3 style="margin:16px 0 4px">Retiro</h3>
${parrafos(retiro)}
<p style="margin-top:16px">${escaparHtml(plazo)}</p>
${origen ? `<p><a href="${escaparHtml(tienda)}">Ir a la tienda</a></p>` : ""}`);

  return { asunto, texto, html };
}

/** Aviso de pedido nuevo para el ropero. */
export function correoAviso(pedido, origen) {
  const asunto = `Nuevo pedido ${pedido.numero} · ${plata(pedido.total)}`;
  const panel = origen + "/admin.html";
  const contacto = [
    `Comprador: ${pedido.comprador.nombre}`,
    `Correo: ${pedido.comprador.correo}`,
    `Teléfono: ${pedido.comprador.fono || "-"}`,
    `Retira: ${textoRetira(pedido)}`,
  ];

  const texto = [
    `Nuevo pedido ${pedido.numero} (${fechaChile(pedido.creadoEn)})`,
    "",
    ...contacto,
    "",
    "Prendas:",
    ...lineasPrendas(pedido).map((l) => "- " + l),
    `Total: ${plata(pedido.total)}`,
    "",
    "Pago:",
    ...lineasPago(pedido),
    ...(origen ? ["", `Panel de voluntarias: ${panel}`] : []),
  ].join("\n");

  const html = envolverHtml(`
<h2 style="margin:0 0 8px">Nuevo pedido ${escaparHtml(pedido.numero)}</h2>
<p style="color:#667">${escaparHtml(fechaChile(pedido.creadoEn))}</p>
${parrafos(contacto)}
<h3 style="margin:16px 0 4px">Prendas</h3>
${tablaPrendasHtml(pedido)}
<h3 style="margin:16px 0 4px">Pago</h3>
${parrafos(lineasPago(pedido))}
${origen ? `<p style="margin-top:16px"><a href="${escaparHtml(panel)}">Abrir el panel de voluntarias</a></p>` : ""}`);

  return { asunto, texto, html };
}

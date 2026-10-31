// Validación de lo que llega desde el navegador. Nunca confiamos en el cliente:
// todo se revisa aquí aunque la página ya lo haya revisado.
import { CONFIG, ESTADOS, LISTAS } from "../public/js/datos.js";
import { normalizarRut } from "./rut.js";
import { ErrorPublico, textoLargo, textoLinea } from "./util.js";

const falla = (mensaje) => new ErrorPublico(400, mensaje);

// Mismo formato que exige el panel para el código de una prenda.
export const FORMATO_CODIGO = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
// Correo: letras, números y . _ % + - ' antes de la @, y un dominio con punto.
const FORMATO_CORREO = /^[A-Za-z0-9._%+'-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;
// Número de pedido: RSG-2026-1001
const FORMATO_NUMERO = /^RSG-\d{4}-\d{4,12}$/;

const MEDIOS_DE_PAGO = ["webpay", "transferencia", "efectivo"];

// Devuelve el correo en minúsculas o null si no tiene un formato válido.
export function correoValido(valor) {
  const correo = textoLinea(valor).toLowerCase();
  if (!correo || correo.length > 120 || !FORMATO_CORREO.test(correo)) return null;
  return correo;
}

// Devuelve el número de pedido en mayúsculas o null si no tiene el formato correcto.
export function numeroPedidoValido(valor) {
  const numero = textoLinea(valor).toUpperCase();
  return numero.length <= 30 && FORMATO_NUMERO.test(numero) ? numero : null;
}

// Convierte "3" o 3 en el número 3; cualquier otra cosa queda como NaN.
function entero(valor) {
  if (typeof valor === "number") return Number.isInteger(valor) ? valor : NaN;
  if (typeof valor === "string" && /^\d{1,9}$/.test(valor.trim())) return Number(valor.trim());
  return NaN;
}

/** Revisa el cuerpo de POST /api/pedidos y devuelve los datos limpios. */
export function validarPedido(cuerpo) {
  // 1) Prendas
  const lineas = cuerpo.items;
  if (!Array.isArray(lineas) || lineas.length === 0) throw falla("No hay prendas en el pedido.");
  if (lineas.length > 30) throw falla("Un pedido puede tener como máximo 30 prendas distintas.");

  const cantidades = new Map(); // código -> cantidad (si un código viene repetido, se suma)
  for (const linea of lineas) {
    const id = typeof linea?.id === "string" ? linea.id.trim().toUpperCase() : "";
    if (!FORMATO_CODIGO.test(id)) throw falla("Revisa las prendas del pedido: hay un código que no es válido.");
    const cant = entero(linea.cant);
    if (!(cant >= 1 && cant <= 10)) throw falla("La cantidad de cada prenda debe ser un número entero entre 1 y 10.");
    cantidades.set(id, (cantidades.get(id) || 0) + cant);
  }
  const items = [];
  for (const [id, cant] of cantidades) {
    if (cant > 10) throw falla("Puedes llevar como máximo 10 unidades de cada prenda.");
    items.push({ id, cant });
  }

  // 2) Comprador
  const comprador = cuerpo.comprador || {};
  const nombre = textoLinea(comprador.nombre);
  if (nombre.length < 2 || nombre.length > 100) throw falla("Escribe el nombre del apoderado o apoderada (entre 2 y 100 caracteres).");
  const correo = correoValido(comprador.correo);
  if (!correo) throw falla("Revisa el correo: no tiene un formato válido.");
  const fono = textoLinea(comprador.fono);
  if (fono.length < 6 || fono.length > 30) throw falla("Escribe un teléfono de contacto válido (entre 6 y 30 caracteres).");

  // 3) Quién retira
  const retira = cuerpo.retira || {};
  let quienRetira;
  if (retira.tipo === "apoderado") {
    quienRetira = { tipo: "apoderado", nombre, extra: "" };
  } else if (retira.tipo === "estudiante") {
    const nombreEst = textoLinea(retira.nombre);
    const curso = textoLinea(retira.curso);
    if (nombreEst.length < 2 || nombreEst.length > 100 || curso.length < 1 || curso.length > 20) {
      throw falla("Completa el nombre y el curso del estudiante.");
    }
    quienRetira = { tipo: "estudiante", nombre: nombreEst, extra: `Curso ${curso}` };
  } else if (retira.tipo === "tercero") {
    const nombreTer = textoLinea(retira.nombre);
    if (nombreTer.length < 2 || nombreTer.length > 100 || !textoLinea(retira.rut)) {
      throw falla("Completa el nombre y el RUT de quien retira.");
    }
    const rut = normalizarRut(textoLinea(retira.rut));
    if (!rut) throw falla("El RUT de quien retira no es válido. Revisa el dígito verificador.");
    quienRetira = { tipo: "tercero", nombre: nombreTer, extra: `RUT ${rut}` };
  } else {
    throw falla("Elige quién retira el pedido.");
  }

  // 4) Medio de pago: tiene que existir y estar encendido en CONFIG.pagos (datos.js)
  const pago = cuerpo.pago;
  if (!MEDIOS_DE_PAGO.includes(pago) || CONFIG.pagos?.[pago] !== true) {
    throw falla("Ese medio de pago no está disponible.");
  }

  return { items, comprador: { nombre, correo, fono }, retira: quienRetira, pago };
}

/**
 * Revisa los datos de una prenda que llegan desde el panel.
 * "idFijo" se usa al editar: el código no se puede cambiar.
 */
export function validarProducto(cuerpo, idFijo = null) {
  let id;
  if (idFijo) {
    id = idFijo;
    const idEnviado = cuerpo.id === undefined || cuerpo.id === null ? "" : String(cuerpo.id).trim().toUpperCase();
    if (idEnviado && idEnviado !== idFijo) {
      throw falla("El código de una prenda no se puede cambiar.");
    }
  } else {
    id = typeof cuerpo.id === "string" ? cuerpo.id.trim().toUpperCase() : "";
    if (!FORMATO_CODIGO.test(id)) {
      throw falla("El código debe tener entre 2 y 20 caracteres: letras, números y guiones (por ejemplo SG-0020).");
    }
  }

  const nombre = textoLinea(cuerpo.nombre);
  if (nombre.length < 2 || nombre.length > 100) throw falla("El nombre de la prenda debe tener entre 2 y 100 caracteres.");
  if (!LISTAS.tipos.includes(cuerpo.tipo)) throw falla("Elige un tipo de prenda de la lista.");
  if (!LISTAS.marcas.includes(cuerpo.marca)) throw falla("Elige una marca de la lista.");
  if (!LISTAS.tallas.includes(cuerpo.talla)) throw falla("Elige una talla de la lista.");
  if (typeof cuerpo.estado !== "string" || !Object.hasOwn(ESTADOS, cuerpo.estado)) {
    throw falla("Elige un estado de la pauta.");
  }

  const precio = entero(cuerpo.precio);
  if (!(precio >= 0 && precio <= 1000000)) throw falla("El precio debe ser un número entero entre 0 y 1.000.000.");
  const stock = entero(cuerpo.stock);
  if (!(stock >= 0 && stock <= 999)) throw falla("El stock debe ser un número entero entre 0 y 999.");

  const detalle = textoLargo(cuerpo.detalle ?? "");
  if (detalle.length > 500) throw falla("Las observaciones pueden tener como máximo 500 caracteres.");

  const imagen = textoLinea(cuerpo.imagen ?? "");
  if (imagen) {
    const rutaPermitida = imagen.startsWith("/img/") || imagen.startsWith("/api/imagenes/") || imagen.startsWith("https://");
    if (!rutaPermitida || imagen.length > 300 || /[\s"'<>\\]/.test(imagen)) {
      throw falla("La foto debe ser una ruta que empiece con /img/, /api/imagenes/ o https:// (máximo 300 caracteres).");
    }
  }

  let publicado = cuerpo.publicado;
  if (publicado === undefined) publicado = true;
  if (publicado === 1 || publicado === 0) publicado = publicado === 1;
  if (typeof publicado !== "boolean") throw falla("Indica si la prenda está publicada o no.");

  return { id, nombre, tipo: cuerpo.tipo, marca: cuerpo.marca, talla: cuerpo.talla, estado: cuerpo.estado,
           precio, stock, detalle, imagen, publicado };
}

/* ================================================================
   TESTS DE LA API (npm test)
   ----------------------------------------------------------------
   Levanta el servidor de verdad (wrangler dev) con una base D1 nueva
   y mocks de Webpay y de correo. Los tests corren EN ORDEN y algunos
   usan pedidos de tests anteriores (por ejemplo, el reembolso usa el
   pedido pagado del primer test de compra).

   Prendas de la semilla que usa cada test (casi todas tienen stock 1):
     SG-0004 + SG-0013  compra aprobada (y luego reembolso)
     SG-0006            anulada y expirada en Webpay
     SG-0007            rechazada por el banco
     SG-0008            doble retorno (y luego entregado / CSV)
     SG-0006, SG-0007   pago cancelado al volver a la tienda sin pagar
     SG-0005            sin stock (se piden más de las que hay)
     SG-0009            dos compras al mismo tiempo
     SG-0010            precio enviado por el cliente
     SG-0011            reembolso que falla y se reintenta
     SG-0014, SG-0017   cron
     SG-0015            anulación desde el panel
   Los tests del final crean sus propias prendas (ED-, PI-, RB-, WC-, SG-009x).
   ================================================================ */

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  levantarEntorno, CLAVE_ADMIN, SMTP_USUARIO, SMTP_CLAVE, SMTP_REMITENTE, CORREO_AVISOS
} from "./helpers/entorno.mjs";
import { CODIGO_COMERCIO_INTEGRACION, LLAVE_INTEGRACION } from "./mocks/webpay.mjs";
import { crearPng } from "./helpers/imagenes.mjs";
import { correoActivo, errorSmtp, opcionesSmtp } from "../src/config.js";

const OPC = { timeout: 60_000 };
// El año del número de pedido es el de Chile
const ANIO = new Intl.DateTimeFormat("en-US", { timeZone: "America/Santiago", year: "numeric" }).format(new Date());

let e;                       // el entorno (servidor + mocks)
let tokenAdminCache = null;
let fallosIngreso = 0;       // intentos de ingreso fallidos hechos por los tests (para el 429)

// Pedidos que se reutilizan entre tests
let pedidoAprobado;          // SG-0004 + 2×SG-0013, pagado
let pedidoDoble;             // SG-0008, pagado
let pedidoCancelado;         // SG-0006, cancelado al volver a la tienda sin pagar
let numeroEnvejecido;        // pedido al que el test del cron le cambió la fecha de creación
const sinCorreo = [];        // números de pedidos que NUNCA deben generar correos

before(async () => {
  e = await levantarEntorno();
}, { timeout: 360_000 });

afterEach(t => {
  if (!t.passed) e?.marcarFalla();
});

after(async () => {
  await e?.cerrar();
}, { timeout: 30_000 });

/* ---------------- Ayudas ---------------- */

async function admin() {
  if (!tokenAdminCache) tokenAdminCache = await e.ingresarAdmin();
  return tokenAdminCache;
}

const comprador = (extra = {}) => ({
  nombre: "Carolina Muñoz", correo: "carolina@ejemplo.cl", fono: "+56 9 8765 4321", ...extra
});

function cuerpoPedido(items, extra = {}) {
  return { items, comprador: comprador(), retira: { tipo: "apoderado" }, pago: "webpay", ...extra };
}

async function pedir(items, extra = {}) {
  return e.api("/api/pedidos", { metodo: "POST", cuerpo: cuerpoPedido(items, extra) });
}

// Crea un pedido Webpay y verifica la respuesta 201
async function crearPedido(items, extra = {}) {
  const r = await pedir(items, extra);
  assert.equal(r.status, 201, `crear pedido respondió ${r.status}: ${r.texto}`);
  assert.match(r.datos.numero, new RegExp(`^RSG-${ANIO}-\\d{4,}$`));
  assert.equal(typeof r.datos.token, "string");
  assert.ok(r.datos.token.length >= 32, "el token de acceso debe ser largo (≥24 bytes)");
  assert.equal(r.datos.webpay.url, e.webpay.url + "/webpayserver/initTransaction");
  assert.match(r.datos.webpay.token, /^[0-9a-f]{64}$/);
  return r.datos;
}

async function verPedido(p) {
  const r = await e.api(`/api/pedidos/${encodeURIComponent(p.numero)}?t=${encodeURIComponent(p.token)}`);
  assert.equal(r.status, 200, `ver pedido respondió ${r.status}: ${r.texto}`);
  return r.datos.pedido;
}

async function pedidoAdmin(numero) {
  const r = await e.api("/api/admin/pedidos", { token: await admin() });
  assert.equal(r.status, 200, r.texto);
  const p = r.datos.pedidos.find(x => x.numero === numero);
  assert.ok(p, `el panel no muestra el pedido ${numero}`);
  return p;
}

async function stockDe(id) {
  const r = await e.api("/api/admin/productos", { token: await admin() });
  assert.equal(r.status, 200, r.texto);
  const p = r.datos.productos.find(x => x.id === id);
  assert.ok(p, `no existe la prenda ${id}`);
  return p.stock;
}

// Pagar en Webpay y volver: la tienda siempre responde 303 al comprobante
async function volverDeWebpay(pedido, accion) {
  const r = await e.pasarPorWebpay(pedido.webpay, accion);
  esRedireccionAlPedido(r, pedido);
  return r;
}

function esRedireccionAlPedido(r, pedido) {
  assert.equal(r.status, 303, "el retorno de Webpay debe responder 303");
  assert.equal(r.destino.pathname, "/");
  assert.equal(r.destino.searchParams.get("pedido"), pedido.numero);
  assert.equal(r.destino.searchParams.get("t"), pedido.token);
}

const transaccionesDePago = p => p.transacciones.filter(t => t.tipo === "pago");

// Espera activa (sin sleeps largos): repite `revisar` hasta que devuelva algo "verdadero"
async function esperarQue(revisar, descripcion, msMaximo = 10_000) {
  const limite = Date.now() + msMaximo;
  let ultimo;
  while (Date.now() < limite) {
    ultimo = await revisar();
    if (ultimo) return ultimo;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.fail(`Se acabó el tiempo esperando: ${descripcion}`);
}

const asuntoComprador = numero => `Ropero SG · Pedido ${numero} confirmado`;
const correosConfirmacion = numero =>
  e.smtp.mensajes.filter(m => m.asunto === asuntoComprador(numero) || m.asunto.startsWith(`Nuevo pedido ${numero} · `));

/* ================================================================
   PÚBLICO
   ================================================================ */

test("config: datos públicos de la tienda", OPC, async () => {
  const r = await e.api("/api/config");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control") || "", /no-store/);
  assert.equal(r.datos.webpay.ambiente, "integracion");
  assert.deepEqual(r.datos.pagos, { webpay: true, transferencia: false, efectivo: false });
  assert.equal(r.datos.diasReembolso, 7);
  assert.equal(r.datos.datosTransferencia, "");
  assert.equal(r.datos.correo.activo, true);

  const noExiste = await e.api("/api/no-existe");
  assert.equal(noExiste.status, 404);
  assert.equal(typeof noExiste.datos?.error, "string", "una ruta /api desconocida responde 404 en JSON");
});

test("catálogo: muestra las 12 prendas de la semilla en orden", OPC, async () => {
  const r = await e.api("/api/productos");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("cache-control") || "", /no-store/);
  const ids = r.datos.productos.map(p => p.id);
  assert.deepEqual(ids, ["SG-0004", "SG-0005", "SG-0006", "SG-0007", "SG-0008", "SG-0009",
    "SG-0010", "SG-0011", "SG-0013", "SG-0014", "SG-0015", "SG-0017"]);
  const p = r.datos.productos[0];
  for (const campo of ["id", "nombre", "tipo", "marca", "talla", "estado", "precio", "stock", "detalle", "imagen"]) {
    assert.ok(campo in p, `falta el campo ${campo}`);
  }
  assert.equal(p.nombre, "Polera piqué manga corta");
  assert.equal(p.tipo, "Polera");
  assert.equal(p.marca, "First Option");
  assert.equal(p.talla, "S");
  assert.equal(p.estado, "excelente");
  assert.equal(p.precio, 4000);
  assert.equal(p.stock, 1);
  assert.equal(p.imagen, "/img/prendas/SG-0004.png");

  // Las fotos de la semilla se sirven como archivos estáticos
  const foto = await fetch(e.url + p.imagen);
  assert.equal(foto.status, 200);
  await foto.arrayBuffer();
});

/* ================================================================
   COMPRAS CON WEBPAY
   ================================================================ */

test("pedido webpay aprobado: baja el stock, guarda la transacción y manda 2 correos", OPC, async () => {
  const llamadasAntes = e.webpay.llamadasDe("crear").length;
  // SG-0013 viene repetido: el servidor debe juntar las líneas (2 unidades)
  const pedido = await crearPedido(
    [{ id: "SG-0004", cant: 1 }, { id: "SG-0013", cant: 1 }, { id: "SG-0013", cant: 1 }],
    { comprador: comprador({ correo: "Carolina.Munoz@Ejemplo.CL" }) }
  );
  pedidoAprobado = pedido;

  // Lo que recibió "Transbank"
  const creadas = e.webpay.llamadasDe("crear").slice(llamadasAntes);
  assert.equal(creadas.length, 1);
  const c = creadas[0];
  assert.equal(c.apiKeyId, CODIGO_COMERCIO_INTEGRACION, "debe usar el código de comercio de integración");
  assert.equal(c.apiKeySecret, LLAVE_INTEGRACION, "debe usar la llave de integración por defecto");
  assert.equal(c.autorizado, true);
  assert.equal(c.cuerpo.buy_order, pedido.numero);
  assert.equal(c.cuerpo.amount, 8000);
  assert.match(c.cuerpo.session_id, /^[0-9a-f]{32}$/);
  assert.equal(c.cuerpo.return_url, e.url + "/api/webpay/retorno");

  // Mientras paga, las prendas quedan reservadas
  assert.equal(await stockDe("SG-0004"), 0);
  assert.equal(await stockDe("SG-0013"), 1);

  let p = await verPedido(pedido);
  assert.equal(p.numero, pedido.numero);
  assert.equal(p.estadoPago, "pendiente");
  assert.equal(p.metodoPago, "webpay");
  assert.equal(p.entrega, "por_retirar");
  assert.equal(p.total, 8000);
  assert.deepEqual(p.comprador, { nombre: "Carolina Muñoz", correo: "carolina.munoz@ejemplo.cl" });
  assert.deepEqual(p.retira, { tipo: "apoderado", nombre: "Carolina Muñoz", extra: "" });
  assert.equal(p.pago, null);
  const items = [...p.items].sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(items.length, 2);
  assert.deepEqual(items.map(i => [i.id, i.cant, i.precio]), [["SG-0004", 1, 4000], ["SG-0013", 2, 2000]]);
  assert.equal(items[0].nombre, "Polera piqué manga corta");
  assert.equal(items[0].talla, "S");
  assert.equal(items[0].estado, "excelente");

  // Paga en Webpay y vuelve
  await volverDeWebpay(pedido, "pagar");
  assert.equal(e.webpay.llamadasDe("confirmar", pedido.webpay.token).length, 1);

  p = await verPedido(pedido);
  assert.equal(p.estadoPago, "pagado");
  assert.equal(p.pago.ordenCompra, pedido.numero);
  assert.equal(p.pago.codigoAutorizacion, "1213");
  assert.equal(p.pago.tarjeta, "6623");
  assert.equal(p.pago.tipoPago, "VN");
  assert.equal(p.pago.cuotas, 0);
  assert.equal(p.pago.monto, 8000);
  assert.ok(!Number.isNaN(Date.parse(p.pago.fecha)), "pago.fecha debe ser una fecha");
  assert.equal(p.puedePedirReembolso, true);
  assert.equal(p.diasRestantesReembolso, 7);
  assert.equal(p.reembolso, null);

  // El stock sigue descontado
  assert.equal(await stockDe("SG-0004"), 0);
  assert.equal(await stockDe("SG-0013"), 1);

  // La transacción quedó guardada con todos sus datos
  const pa = await pedidoAdmin(pedido.numero);
  assert.equal(pa.comprador.fono, "+56 9 8765 4321");
  assert.ok(pa.pagadoEn, "falta pagadoEn");
  const [tx] = transaccionesDePago(pa);
  assert.equal(transaccionesDePago(pa).length, 1);
  assert.equal(tx.estado, "autorizada");
  assert.equal(tx.monto, 8000);
  assert.equal(tx.codigoRespuesta, 0);
  assert.equal(tx.codigoAutorizacion, "1213");
  assert.equal(tx.tarjeta, "6623");
  assert.equal(tx.tipoPago, "VN");
  assert.equal(tx.cuotas, 0);
  assert.equal(tx.ordenCompra, pedido.numero);

  // Dos correos: comprobante al comprador y aviso al ropero
  const correos = await e.smtp.esperarCorreos(m => m.asunto.includes(pedido.numero), 2, 20_000);
  const alComprador = correos.find(m => m.to.includes("carolina.munoz@ejemplo.cl"));
  const alRopero = correos.find(m => m.to.includes(CORREO_AVISOS));
  assert.ok(alComprador, "falta el correo al comprador");
  assert.ok(alRopero, "falta el aviso al ropero");
  assert.equal(alComprador.asunto, asuntoComprador(pedido.numero));
  assert.equal(alRopero.asunto, `Nuevo pedido ${pedido.numero} · $8.000`);
  for (const texto of [pedido.numero, "SG-0004", "SG-0013", "1213", "6623"]) {
    assert.ok(alComprador.cuerpo.includes(texto), `el correo al comprador no menciona ${texto}`);
  }
  assert.ok(alRopero.cuerpo.includes("carolina.munoz@ejemplo.cl"), "el aviso debe traer el correo del comprador");
  assert.ok(alRopero.cuerpo.includes("+56 9 8765 4321"), "el aviso debe traer el teléfono del comprador");
  for (const m of [alComprador, alRopero]) {
    assert.equal(m.from, SMTP_REMITENTE);
    assert.equal(m.auth?.usuario, SMTP_USUARIO);
    assert.equal(m.auth?.clave, SMTP_CLAVE);
  }
});

test("pedido webpay anulado en Webpay: libera el stock", OPC, async () => {
  const pedido = await crearPedido([{ id: "SG-0006", cant: 1 }], {
    retira: { tipo: "estudiante", nombre: "Tomás Muñoz", curso: "7°B" }
  });
  sinCorreo.push(pedido.numero);
  assert.equal(await stockDe("SG-0006"), 0);
  assert.deepEqual((await verPedido(pedido)).retira, { tipo: "estudiante", nombre: "Tomás Muñoz", extra: "Curso 7°B" });

  await volverDeWebpay(pedido, "anular");

  const p = await verPedido(pedido);
  assert.equal(p.estadoPago, "anulado");
  assert.equal(await stockDe("SG-0006"), 1);
  assert.equal(e.webpay.llamadasDe("confirmar", pedido.webpay.token).length, 0, "no se confirma un pago anulado");
  const pa = await pedidoAdmin(pedido.numero);
  assert.equal(transaccionesDePago(pa)[0].estado, "abortada");
  assert.equal(pa.motivoAnulacion, "Pago cancelado en Webpay");
  assert.ok(pa.anuladoEn, "falta anuladoEn");
});

test("timeout de Webpay: un TBK_ID_SESION falso no anula; el verdadero sí", OPC, async () => {
  const pedido = await crearPedido([{ id: "SG-0006", cant: 1 }]);
  sinCorreo.push(pedido.numero);
  assert.equal(await stockDe("SG-0006"), 0);

  // Alguien intenta anular el pedido ajeno adivinando el número de orden
  const falso = await e.enviarRetorno({ TBK_ORDEN_COMPRA: pedido.numero, TBK_ID_SESION: "f".repeat(32) }, "get");
  assert.equal(falso.status, 303);
  assert.equal((await verPedido(pedido)).estadoPago, "pendiente", "con un TBK_ID_SESION falso no se toca nada");
  assert.equal(await stockDe("SG-0006"), 0);
  assert.equal(transaccionesDePago(await pedidoAdmin(pedido.numero))[0].estado, "iniciada");

  // Timeout de verdad (el mock lo manda por GET con los datos correctos)
  await volverDeWebpay(pedido, "expirar");
  const p = await verPedido(pedido);
  assert.equal(p.estadoPago, "anulado");
  assert.equal(await stockDe("SG-0006"), 1);
  assert.equal(transaccionesDePago(await pedidoAdmin(pedido.numero))[0].estado, "expirada");
  assert.equal(e.webpay.llamadasDe("confirmar", pedido.webpay.token).length, 0);
});

test("pedido webpay rechazado por el banco: libera el stock", OPC, async () => {
  const pedido = await crearPedido([{ id: "SG-0007", cant: 1 }], {
    retira: { tipo: "tercero", nombre: "Rosa Pérez", rut: "12345678-5" }   // sin puntos: se guarda normalizado
  });
  sinCorreo.push(pedido.numero);
  assert.deepEqual((await verPedido(pedido)).retira, { tipo: "tercero", nombre: "Rosa Pérez", extra: "RUT 12.345.678-5" });
  assert.equal(await stockDe("SG-0007"), 0);

  await volverDeWebpay(pedido, "rechazar");

  assert.equal(e.webpay.llamadasDe("confirmar", pedido.webpay.token).length, 1);
  assert.equal((await verPedido(pedido)).estadoPago, "rechazado");
  assert.equal(await stockDe("SG-0007"), 1);
  assert.equal(transaccionesDePago(await pedidoAdmin(pedido.numero))[0].estado, "rechazada");
});

test("retorno doble de Webpay: no confirma dos veces ni descuenta dos veces", OPC, async () => {
  const pedido = await crearPedido([{ id: "SG-0008", cant: 1 }]);
  pedidoDoble = pedido;

  await volverDeWebpay(pedido, "pagar");
  // El navegador vuelve a mandar el mismo token (recargar, botón atrás…), por GET y por POST
  esRedireccionAlPedido(await e.enviarRetorno({ token_ws: pedido.webpay.token }, "get"), pedido);
  esRedireccionAlPedido(await e.enviarRetorno({ token_ws: pedido.webpay.token }, "post"), pedido);

  assert.equal(e.webpay.llamadasDe("confirmar", pedido.webpay.token).length, 1, "solo un commit en Transbank");
  assert.equal((await verPedido(pedido)).estadoPago, "pagado");
  assert.equal(await stockDe("SG-0008"), 0);
  const pa = await pedidoAdmin(pedido.numero);
  assert.equal(transaccionesDePago(pa).length, 1);
  assert.equal(transaccionesDePago(pa)[0].estado, "autorizada");
});

/* ---------- El comprador vuelve a la tienda sin pagar ("Atrás" desde Webpay) ---------- */

const cancelar = (numero, cuerpo) => e.api(`/api/pedidos/${encodeURIComponent(numero)}/cancelar`, { metodo: "POST", cuerpo });

test("cancelar un pago Webpay a medias: libera el stock y la transacción queda abortada", OPC, async () => {
  const pedido = await crearPedido([{ id: "SG-0006", cant: 1 }]);
  pedidoCancelado = pedido;
  sinCorreo.push(pedido.numero);
  assert.equal(await stockDe("SG-0006"), 0);

  // Sin el token correcto: 404 y no se toca nada
  for (const [nombre, numero, cuerpo] of [
    ["token inventado", pedido.numero, { t: "x".repeat(43) }],
    ["sin token", pedido.numero, {}],
    ["token de otro pedido", pedido.numero, { t: pedidoDoble.token }],
    ["número que no existe", `RSG-${ANIO}-99999`, { t: pedido.token }]
  ]) {
    const r = await cancelar(numero, cuerpo);
    assert.equal(r.status, 404, `${nombre}: esperaba 404 y llegó ${r.status} ${r.texto}`);
    assert.equal(typeof r.datos?.error, "string", `${nombre}: falta el mensaje`);
  }
  assert.equal((await verPedido(pedido)).estadoPago, "pendiente");
  assert.equal(await stockDe("SG-0006"), 0);

  // El número se acepta sin distinguir mayúsculas, como en las otras rutas
  const r = await cancelar(pedido.numero.toLowerCase(), { t: pedido.token });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.datos.pedido.numero, pedido.numero);
  assert.equal(r.datos.pedido.estadoPago, "anulado");
  assert.equal(r.datos.pedido.comprador.fono, undefined, "responde la vista pública del pedido");
  assert.equal(await stockDe("SG-0006"), 1, "la prenda vuelve al catálogo");

  const pa = await pedidoAdmin(pedido.numero);
  assert.equal(transaccionesDePago(pa).length, 1);
  assert.equal(transaccionesDePago(pa)[0].estado, "abortada");
  assert.equal(pa.motivoAnulacion, "Pago abandonado: el comprador volvió a la tienda");
  assert.ok(pa.anuladoEn, "falta anuladoEn");

  // Repetirlo no cambia nada (el stock no se devuelve dos veces)
  const otraVez = await cancelar(pedido.numero, { t: pedido.token });
  assert.equal(otraVez.status, 200, otraVez.texto);
  assert.equal(otraVez.datos.pedido.estadoPago, "anulado");
  assert.equal(await stockDe("SG-0006"), 1);
  assert.equal(e.webpay.llamadasDe("confirmar", pedido.webpay.token).length, 0);
});

test("volver de Webpay con token_ws después de cancelar: NO se confirma el pago", OPC, async () => {
  assert.ok(pedidoCancelado, "necesita el pedido cancelado del test anterior");
  // El comprador vuelve a la página de Webpay ("Adelante") y paga igual
  await volverDeWebpay(pedidoCancelado, "pagar");

  const llamadas = await (await fetch(e.webpay.url + "/__llamadas")).json();
  const delPedido = llamadas.filter(l => l.token === pedidoCancelado.webpay.token);
  assert.deepEqual(delPedido.map(l => l.operacion), [], "no se llama a Transbank: sin commit, Transbank reversa solo");

  assert.equal((await verPedido(pedidoCancelado)).estadoPago, "anulado");
  assert.equal(await stockDe("SG-0006"), 1);
  assert.equal(transaccionesDePago(await pedidoAdmin(pedidoCancelado.numero))[0].estado, "abortada");
});

test("cancelar no toca pedidos pagados ni pedidos que no son Webpay", OPC, async () => {
  const pagado = await cancelar(pedidoDoble.numero, { t: pedidoDoble.token });
  assert.equal(pagado.status, 200, pagado.texto);
  assert.equal(pagado.datos.pedido.estadoPago, "pagado");
  assert.equal(pagado.datos.pedido.pago.codigoAutorizacion, "1213");
  assert.equal(await stockDe("SG-0008"), 0);
  const pa = await pedidoAdmin(pedidoDoble.numero);
  assert.equal(pa.estadoPago, "pagado");
  assert.equal(transaccionesDePago(pa)[0].estado, "autorizada");

  // Transferencia y efectivo están apagados: se simula uno cambiando el método directo en la base
  const pedido = await crearPedido([{ id: "SG-0007", cant: 1 }]);
  sinCorreo.push(pedido.numero);
  await e.sql(`UPDATE pedidos SET metodo_pago = 'transferencia' WHERE numero = '${pedido.numero}'`);
  const transferencia = await cancelar(pedido.numero, { t: pedido.token });
  assert.equal(transferencia.status, 200, transferencia.texto);
  assert.equal(transferencia.datos.pedido.metodoPago, "transferencia");
  assert.equal(transferencia.datos.pedido.estadoPago, "pendiente", "una transferencia no se anula por esta vía");
  assert.equal(await stockDe("SG-0007"), 0);

  // De vuelta a Webpay sí se cancela (así la prenda queda libre para los demás tests)
  await e.sql(`UPDATE pedidos SET metodo_pago = 'webpay' WHERE numero = '${pedido.numero}'`);
  assert.equal((await cancelar(pedido.numero, { t: pedido.token })).datos.pedido.estadoPago, "anulado");
  assert.equal(await stockDe("SG-0007"), 1);
});

test("sin stock: 409 con la lista de prendas que no se pueden comprar", OPC, async () => {
  const llamadasAntes = e.webpay.llamadasDe("crear").length;
  const r = await pedir([
    { id: "SG-0004", cant: 1 },     // ya vendida
    { id: "SG-9999", cant: 1 },     // no existe
    { id: "SG-0005", cant: 3 }      // hay solo 2
  ]);
  assert.equal(r.status, 409, r.texto);
  assert.equal(typeof r.datos.error, "string");
  assert.deepEqual([...r.datos.sinStock].sort(), ["SG-0004", "SG-0005", "SG-9999"]);
  assert.equal(await stockDe("SG-0005"), 2, "no se reserva nada si el pedido falla");
  assert.equal(e.webpay.llamadasDe("crear").length, llamadasAntes, "no se llama a Webpay si no hay stock");
});

test("dos compras simultáneas de la última unidad: solo una gana", OPC, async () => {
  const llamadasAntes = e.webpay.llamadasDe("crear").length;
  const [a, b] = await Promise.all([
    pedir([{ id: "SG-0009", cant: 1 }], { comprador: comprador({ nombre: "Apoderada Uno", correo: "uno@ejemplo.cl" }) }),
    pedir([{ id: "SG-0009", cant: 1 }], { comprador: comprador({ nombre: "Apoderado Dos", correo: "dos@ejemplo.cl" }) })
  ]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], `respuestas: ${a.status} ${a.texto} | ${b.status} ${b.texto}`);
  const perdedor = a.status === 409 ? a : b;
  assert.deepEqual(perdedor.datos.sinStock, ["SG-0009"]);
  assert.equal(await stockDe("SG-0009"), 0, "el stock nunca queda negativo");
  assert.equal(e.webpay.llamadasDe("crear").length, llamadasAntes + 1, "solo el ganador va a Webpay");
});

test("validaciones: 400 con un mensaje claro", OPC, async () => {
  const llamadasAntes = e.webpay.llamadasDe("crear").length;
  const item = [{ id: "SG-0010", cant: 1 }];
  const casos = [
    ["sin prendas", cuerpoPedido([])],
    ["más de 30 líneas", cuerpoPedido(Array.from({ length: 31 }, (_, i) => ({ id: `SG-${1000 + i}`, cant: 1 })))],
    ["cantidad 0", cuerpoPedido([{ id: "SG-0010", cant: 0 }])],
    ["cantidad 11", cuerpoPedido([{ id: "SG-0010", cant: 11 }])],
    ["cantidad con decimales", cuerpoPedido([{ id: "SG-0010", cant: 1.5 }])],
    ["nombre muy corto", cuerpoPedido(item, { comprador: comprador({ nombre: "A" }) })],
    ["correo inválido", cuerpoPedido(item, { comprador: comprador({ correo: "esto-no-es-un-correo" }) })],
    ["correo sin dominio", cuerpoPedido(item, { comprador: comprador({ correo: "ana@" }) })],
    ["teléfono muy corto", cuerpoPedido(item, { comprador: comprador({ fono: "123" }) })],
    ["estudiante sin curso", cuerpoPedido(item, { retira: { tipo: "estudiante", nombre: "Tomás" } })],
    ["tercero con RUT inválido", cuerpoPedido(item, { retira: { tipo: "tercero", nombre: "Rosa Pérez", rut: "12.345.678-0" } })],
    ["tercero sin RUT", cuerpoPedido(item, { retira: { tipo: "tercero", nombre: "Rosa Pérez" } })],
    ["tipo de retiro desconocido", cuerpoPedido(item, { retira: { tipo: "vecino", nombre: "Juan" } })],
    ["transferencia apagada", cuerpoPedido(item, { pago: "transferencia" })],
    ["efectivo apagado", cuerpoPedido(item, { pago: "efectivo" })],
    ["medio de pago inexistente", cuerpoPedido(item, { pago: "bitcoin" })]
  ];
  for (const [nombre, cuerpo] of casos) {
    const r = await e.api("/api/pedidos", { metodo: "POST", cuerpo });
    assert.equal(r.status, 400, `${nombre}: esperaba 400 y llegó ${r.status} ${r.texto}`);
    assert.ok(typeof r.datos?.error === "string" && r.datos.error.length > 0, `${nombre}: falta el mensaje de error`);
  }
  assert.equal(await stockDe("SG-0010"), 1, "un pedido inválido no reserva stock");
  assert.equal(e.webpay.llamadasDe("crear").length, llamadasAntes);
});

test("el precio y el total los calcula el servidor (se ignora lo que manda el cliente)", OPC, async () => {
  const llamadasAntes = e.webpay.llamadasDe("crear").length;
  const r = await e.api("/api/pedidos", {
    metodo: "POST",
    cuerpo: { ...cuerpoPedido([{ id: "SG-0010", cant: 1, precio: 1 }]), total: 1, amount: 1 }
  });
  assert.equal(r.status, 201, r.texto);
  const pedido = r.datos;
  sinCorreo.push(pedido.numero);
  const [c] = e.webpay.llamadasDe("crear").slice(llamadasAntes);
  assert.equal(c.cuerpo.amount, 5000, "a Webpay se le cobra el precio de la base de datos");
  const p = await verPedido(pedido);
  assert.equal(p.total, 5000);
  assert.equal(p.items[0].precio, 5000);
});

test("buscar pedido por número y correo (sin distinguir mayúsculas)", OPC, async () => {
  const r = await e.api("/api/pedidos/buscar", {
    metodo: "POST",
    cuerpo: { numero: pedidoAprobado.numero.toLowerCase(), correo: "CAROLINA.MUNOZ@EJEMPLO.CL" }
  });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.datos.pedido.numero, pedidoAprobado.numero);
  assert.equal(r.datos.pedido.estadoPago, "pagado");
  assert.equal(r.datos.pedido.comprador.fono, undefined, "la vista pública no muestra el teléfono");

  const otroCorreo = await e.api("/api/pedidos/buscar", {
    metodo: "POST",
    cuerpo: { numero: pedidoAprobado.numero, correo: "otra@ejemplo.cl" }
  });
  assert.equal(otroCorreo.status, 404);
  assert.equal(typeof otroCorreo.datos.error, "string");

  const tokenMalo = await e.api(`/api/pedidos/${pedidoAprobado.numero}?t=token-inventado`);
  assert.equal(tokenMalo.status, 404, "sin el token correcto no se ve el comprobante");
});

/* ================================================================
   REEMBOLSOS
   ================================================================ */

test("reembolso: se pide desde la tienda y al aprobarlo se devuelve por Webpay", OPC, async () => {
  const numero = pedidoAprobado.numero;
  const ruta = `/api/pedidos/${numero}/reembolso`;
  const motivo = "La talla no le quedó a mi hija.";

  const corto = await e.api(ruta, { metodo: "POST", cuerpo: { correo: "carolina.munoz@ejemplo.cl", motivo: "chica" } });
  assert.equal(corto.status, 400, "el motivo necesita al menos 10 caracteres");
  const ajeno = await e.api(ruta, { metodo: "POST", cuerpo: { correo: "otra@ejemplo.cl", motivo } });
  assert.ok(ajeno.status >= 400 && ajeno.status < 500, `con otro correo no se puede pedir (llegó ${ajeno.status})`);
  const noPagado = await e.api(`/api/pedidos/${sinCorreo[0]}/reembolso`, {
    metodo: "POST", cuerpo: { correo: "carolina@ejemplo.cl", motivo }
  });
  assert.ok(noPagado.status >= 400 && noPagado.status < 500, `un pedido anulado no se reembolsa (llegó ${noPagado.status})`);

  const r = await e.api(ruta, { metodo: "POST", cuerpo: { correo: "Carolina.Munoz@ejemplo.cl", motivo } });
  assert.equal(r.status, 201, r.texto);
  assert.equal(r.datos.pedido.reembolso.estado, "solicitado");
  assert.equal(r.datos.pedido.reembolso.motivo, motivo);
  assert.equal(r.datos.pedido.puedePedirReembolso, false);

  const repetido = await e.api(ruta, { metodo: "POST", cuerpo: { correo: "carolina.munoz@ejemplo.cl", motivo } });
  assert.ok(repetido.status >= 400 && repetido.status < 500, "no se puede pedir dos veces");

  const lista = await e.api("/api/admin/reembolsos", { token: await admin() });
  assert.equal(lista.status, 200);
  assert.ok(lista.datos.pedidos.some(p => p.numero === numero && p.reembolso.estado === "solicitado"));

  // La voluntaria lo aprueba: se devuelve el stock y el dinero por Webpay
  const resolver = await e.api(`/api/admin/reembolsos/${numero}/resolver`, {
    metodo: "POST", token: await admin(),
    cuerpo: { decision: "aprobado", respuesta: "Aprobado, devolvemos el dinero a tu tarjeta." }
  });
  assert.equal(resolver.status, 200, resolver.texto);
  assert.equal(resolver.datos.webpay.ok, true);
  assert.equal(typeof resolver.datos.webpay.mensaje, "string");
  assert.equal(resolver.datos.pedido.estadoPago, "reembolsado");
  assert.equal(resolver.datos.pedido.reembolso.estado, "devuelto");
  assert.equal(resolver.datos.pedido.reembolso.respuesta, "Aprobado, devolvemos el dinero a tu tarjeta.");

  const devoluciones = e.webpay.llamadasDe("reembolsar", pedidoAprobado.webpay.token);
  assert.equal(devoluciones.length, 1);
  assert.equal(devoluciones[0].cuerpo.amount, 8000);
  assert.equal(devoluciones[0].status, 200);

  assert.equal(await stockDe("SG-0004"), 1, "la prenda vuelve al catálogo");
  assert.equal(await stockDe("SG-0013"), 3);

  const pa = await pedidoAdmin(numero);
  const tx = pa.transacciones.find(t => t.tipo === "reembolso");
  assert.ok(tx, "falta la transacción de reembolso");
  assert.equal(tx.estado, "reembolsada");
  assert.equal(tx.monto, 8000);
  assert.equal(tx.tipoReembolso, "NULLIFIED");
  assert.ok(pa.reembolso.devueltoEn, "falta devueltoEn");
  assert.ok(pa.reembolso.resueltoEn, "falta resueltoEn");

  const otraVez = await e.api(`/api/admin/reembolsos/${numero}/resolver`, {
    metodo: "POST", token: await admin(), cuerpo: { decision: "rechazado", respuesta: "x" }
  });
  assert.ok(otraVez.status >= 400 && otraVez.status < 500, "solo se resuelve una solicitud pendiente");
});

test("reembolso: si Webpay falla queda aprobado con el error y se puede reintentar", OPC, async () => {
  const pedido = await crearPedido([{ id: "SG-0011", cant: 1 }]);
  await volverDeWebpay(pedido, "pagar");
  assert.equal((await verPedido(pedido)).estadoPago, "pagado");

  // Esta vez se identifica con el token del comprobante (sin correo)
  const solicitud = await e.api(`/api/pedidos/${pedido.numero}/reembolso`, {
    metodo: "POST", cuerpo: { t: pedido.token, motivo: "El polar tenía una mancha que no salía en la foto." }
  });
  assert.equal(solicitud.status, 201, solicitud.texto);

  e.webpay.control({ accion: "fallar", operacion: "reembolsar", veces: 1, status: 500, mensaje: "Servicio no disponible" });
  const resolver = await e.api(`/api/admin/reembolsos/${pedido.numero}/resolver`, {
    metodo: "POST", token: await admin(), cuerpo: { decision: "aprobado", respuesta: "Aprobado." }
  });
  assert.equal(resolver.status, 200, resolver.texto);
  assert.equal(resolver.datos.webpay.ok, false);
  assert.equal(typeof resolver.datos.webpay.mensaje, "string");
  assert.equal(resolver.datos.pedido.reembolso.estado, "aprobado");
  assert.equal(resolver.datos.pedido.estadoPago, "pagado", "si Webpay falla, el dinero todavía no se devuelve");
  let pa = await pedidoAdmin(pedido.numero);
  assert.ok(pa.reembolso.error, "debe quedar guardado el error de Webpay");
  assert.equal(await stockDe("SG-0011"), 1, "al aprobar, la prenda vuelve al catálogo");

  const reintento = await e.api(`/api/admin/reembolsos/${pedido.numero}/reintentar`, { metodo: "POST", token: await admin() });
  assert.equal(reintento.status, 200, reintento.texto);
  pa = await pedidoAdmin(pedido.numero);
  assert.equal(pa.reembolso.estado, "devuelto");
  assert.equal(pa.estadoPago, "reembolsado");
  assert.equal(await stockDe("SG-0011"), 1, "el stock no se devuelve dos veces");
  const llamadas = e.webpay.llamadasDe("reembolsar", pedido.webpay.token);
  assert.deepEqual(llamadas.map(l => l.status), [500, 200]);

  const deNuevo = await e.api(`/api/admin/reembolsos/${pedido.numero}/reintentar`, { metodo: "POST", token: await admin() });
  assert.ok(deNuevo.status >= 400 && deNuevo.status < 500, "solo se reintenta un reembolso aprobado");
});

/* ================================================================
   PANEL
   ================================================================ */

test("admin: ingreso y 401 sin sesión válida", OPC, async () => {
  const mala = await e.api("/api/admin/ingresar", { metodo: "POST", cuerpo: { clave: "no-es-la-clave" } });
  fallosIngreso++;
  assert.equal(mala.status, 401);
  assert.equal(typeof mala.datos.error, "string");

  const buena = await e.api("/api/admin/ingresar", { metodo: "POST", cuerpo: { clave: CLAVE_ADMIN } });
  assert.equal(buena.status, 200, buena.texto);
  assert.equal(typeof buena.datos.token, "string");
  // expiraEn puede venir como fecha ISO o como milisegundos (o segundos) desde 1970
  const exp = buena.datos.expiraEn;
  const expMs = typeof exp === "number" && exp < 1e12 ? exp * 1000 : new Date(exp).getTime();
  const horas = (expMs - Date.now()) / 3_600_000;
  assert.ok(horas > 11 && horas <= 12.1, `la sesión dura 12 horas (quedan ${horas})`);

  const estado = await e.api("/api/admin/estado", { token: buena.datos.token });
  assert.equal(estado.status, 200, estado.texto);
  assert.deepEqual(estado.datos.webpay, { ambiente: "integracion", comercio: CODIGO_COMERCIO_INTEGRACION });
  assert.deepEqual(estado.datos.correo, { activo: true, avisosA: CORREO_AVISOS });

  const alterado = buena.datos.token.slice(0, -2) + (buena.datos.token.endsWith("AA") ? "BB" : "AA");
  for (const [nombre, headers] of [
    ["sin token", {}],
    ["token inventado", { Authorization: "Bearer inventado.inventado" }],
    ["token alterado", { Authorization: "Bearer " + alterado }]
  ]) {
    const r = await e.api("/api/admin/pedidos", { headers });
    assert.equal(r.status, 401, `${nombre}: esperaba 401 y llegó ${r.status}`);
    assert.equal(r.datos.error, "Tu sesión expiró. Vuelve a ingresar.");
  }
  // También protege las acciones que modifican datos
  const sinSesion = await e.api("/api/admin/productos", { metodo: "POST", cuerpo: { id: "X-01" } });
  assert.equal(sinSesion.status, 401);
});

test("admin: crear, editar, ocultar y borrar una prenda", OPC, async () => {
  const token = await admin();
  const prenda = {
    id: "PR-0001", nombre: "Parka de prueba", tipo: "Parka", marca: "Otra", talla: "M", estado: "bueno",
    precio: 7000, stock: 2, detalle: "Creada por los tests.", imagen: "", publicado: true
  };
  const creada = await e.api("/api/admin/productos", { metodo: "POST", token, cuerpo: prenda });
  assert.equal(creada.status, 201, creada.texto);
  for (const [campo, valor] of Object.entries(prenda)) assert.deepEqual(creada.datos.producto[campo], valor, campo);

  const repetida = await e.api("/api/admin/productos", { metodo: "POST", token, cuerpo: prenda });
  assert.equal(repetida.status, 409, "el código ya existe");

  const otra = { ...prenda, id: "PR-0002" };
  const invalidas = [
    ["código muy corto", { ...otra, id: "P" }],
    ["código con espacio", { ...otra, id: "PR 0002" }],
    ["tipo fuera de la lista", { ...otra, tipo: "Sombrero" }],
    ["marca fuera de la lista", { ...otra, marca: "Marca rara" }],
    ["talla fuera de la lista", { ...otra, talla: "XXL" }],
    ["estado desconocido", { ...otra, estado: "roto" }],
    ["precio negativo", { ...otra, precio: -1 }],
    ["precio muy alto", { ...otra, precio: 1_000_001 }],
    ["precio con decimales", { ...otra, precio: 10.5 }],
    ["stock muy alto", { ...otra, stock: 1000 }],
    ["nombre muy corto", { ...otra, nombre: "X" }],
    ["detalle muy largo", { ...otra, detalle: "x".repeat(501) }],
    ["imagen data:", { ...otra, imagen: "data:image/png;base64,AAAA" }],
    ["imagen sin https", { ...otra, imagen: "http://sitio.cl/foto.png" }]
  ];
  for (const [nombre, cuerpo] of invalidas) {
    const r = await e.api("/api/admin/productos", { metodo: "POST", token, cuerpo });
    assert.equal(r.status, 400, `${nombre}: esperaba 400 y llegó ${r.status} ${r.texto}`);
    assert.equal(typeof r.datos?.error, "string", `${nombre}: falta el mensaje`);
  }

  let publico = (await e.api("/api/productos")).datos.productos;
  assert.ok(publico.some(p => p.id === "PR-0001" && p.stock === 2), "la prenda nueva aparece en la tienda");
  assert.ok(!publico.some(p => p.id === "PR-0002"), "las inválidas no se guardaron");

  // Editar exige la versión que se leyó (actualizadoEn)
  const sinVersion = await e.api("/api/admin/productos/PR-0001", { metodo: "PUT", token, cuerpo: { ...prenda, precio: 6500 } });
  assert.equal(sinVersion.status, 400, "sin actualizadoEn no se guarda");
  const editada = await e.api("/api/admin/productos/PR-0001", {
    metodo: "PUT", token,
    cuerpo: { ...prenda, precio: 6500, imagen: "/img/prendas/SG-0004.png", publicado: false, actualizadoEn: creada.datos.producto.actualizadoEn }
  });
  assert.equal(editada.status, 200, editada.texto);
  assert.equal(editada.datos.producto.id, "PR-0001");
  assert.equal(editada.datos.producto.precio, 6500);
  assert.equal(editada.datos.producto.imagen, "/img/prendas/SG-0004.png");
  assert.equal(editada.datos.producto.publicado, false);

  publico = (await e.api("/api/productos")).datos.productos;
  assert.ok(!publico.some(p => p.id === "PR-0001"), "una prenda oculta no aparece en la tienda");
  const enPanel = (await e.api("/api/admin/productos", { token })).datos.productos.find(p => p.id === "PR-0001");
  assert.equal(enPanel.publicado, false);
  assert.equal(enPanel.precio, 6500);
  assert.ok(enPanel.creadoEn && enPanel.actualizadoEn, "el panel muestra las fechas");

  const version = editada.datos.producto.actualizadoEn;
  const malEditada = await e.api("/api/admin/productos/PR-0001", { metodo: "PUT", token, cuerpo: { ...prenda, precio: -5, actualizadoEn: version } });
  assert.equal(malEditada.status, 400);
  const noExiste = await e.api("/api/admin/productos/NO-EXISTE", {
    metodo: "PUT", token, cuerpo: { ...prenda, id: "NO-EXISTE", actualizadoEn: version }
  });
  assert.equal(noExiste.status, 404);
  // Con la versión de antes de editar: 409 y no cambia nada
  const vieja = await e.api("/api/admin/productos/PR-0001", {
    metodo: "PUT", token, cuerpo: { ...prenda, precio: 1000, actualizadoEn: creada.datos.producto.actualizadoEn }
  });
  assert.equal(vieja.status, 409, vieja.texto);
  assert.equal((await e.api("/api/admin/productos", { token })).datos.productos.find(p => p.id === "PR-0001").precio, 6500);

  const borrada = await e.api("/api/admin/productos/PR-0001", { metodo: "DELETE", token });
  assert.equal(borrada.status, 200, borrada.texto);
  assert.deepEqual(borrada.datos, { ok: true });
  const lista = (await e.api("/api/admin/productos", { token })).datos.productos;
  assert.ok(!lista.some(p => p.id === "PR-0001"));
  const otraVez = await e.api("/api/admin/productos/PR-0001", { metodo: "DELETE", token });
  assert.equal(otraVez.status, 404);
});

test("admin: subir, servir y borrar la foto de una prenda", OPC, async () => {
  const token = await admin();
  const prenda = {
    id: "IMG-01", nombre: "Blusa con foto", tipo: "Blusa", marca: "Sin marca", talla: "10", estado: "nuevo",
    precio: 3000, stock: 1, detalle: "", imagen: "", publicado: true
  };
  assert.equal((await e.api("/api/admin/productos", { metodo: "POST", token, cuerpo: prenda })).status, 201);

  const png = crearPng(40, 30);
  const subir = (cuerpo, tipo, tok = token, id = "IMG-01") =>
    e.api(`/api/admin/productos/${id}/imagen`, { metodo: "PUT", token: tok, crudo: cuerpo, headers: { "Content-Type": tipo } });

  const r = await subir(png, "image/png");
  assert.equal(r.status, 200, r.texto);
  const ruta = r.datos.producto.imagen;
  assert.match(ruta, /^\/api\/imagenes\/IMG-01\?v=\d+$/);

  const foto = await fetch(e.url + ruta);
  assert.equal(foto.status, 200);
  assert.equal(foto.headers.get("content-type"), "image/png");
  assert.match(foto.headers.get("cache-control") || "", /max-age=31536000/);
  assert.match(foto.headers.get("cache-control") || "", /immutable/);
  assert.deepEqual(Buffer.from(await foto.arrayBuffer()), png, "se sirven los mismos bytes que se subieron");
  const otraVez = await fetch(e.url + ruta);   // ahora puede salir de la caché
  assert.equal(otraVez.status, 200);
  assert.equal(otraVez.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await otraVez.arrayBuffer()), png, "la caché entrega los mismos bytes");

  const enTienda = (await e.api("/api/productos")).datos.productos.find(p => p.id === "IMG-01");
  assert.equal(enTienda.imagen, ruta);

  // Rechazos
  assert.equal((await subir(png, "image/png", null)).status, 401, "sin sesión no se sube nada");
  const texto = await subir(Buffer.from("hola"), "text/plain");
  assert.ok(texto.status >= 400 && texto.status < 500, `un archivo que no es foto se rechaza (llegó ${texto.status})`);
  const gigante = await subir(Buffer.alloc(1_500_001, 1), "image/jpeg");
  assert.ok(gigante.status >= 400 && gigante.status < 500, `más de 1.500.000 bytes se rechaza (llegó ${gigante.status})`);
  assert.equal((await subir(png, "image/png", token, "NO-EXISTE")).status, 404);
  const igual = (await e.api("/api/admin/productos", { token })).datos.productos.find(p => p.id === "IMG-01");
  assert.equal(igual.imagen, ruta, "los rechazos no cambian la foto");

  const sinFoto = await e.api("/api/imagenes/NO-EXISTE");
  assert.equal(sinFoto.status, 404);

  // Al cambiar la foto se entrega la nueva (la caché no guarda la antigua)
  const png2 = crearPng(12, 9);
  const cambio = await subir(png2, "image/png");
  assert.equal(cambio.status, 200, cambio.texto);
  const ruta2 = cambio.datos.producto.imagen;
  assert.notEqual(ruta2, ruta);
  assert.deepEqual(Buffer.from(await (await fetch(e.url + ruta2)).arrayBuffer()), png2, "se sirve la foto nueva");

  const quitar = await e.api("/api/admin/productos/IMG-01/imagen", { metodo: "DELETE", token });
  assert.equal(quitar.status, 200, quitar.texto);
  assert.equal(quitar.datos.producto.imagen, "");
  assert.equal((await fetch(e.url + ruta)).status, 404, "la foto borrada ya no se sirve");
  assert.equal((await fetch(e.url + ruta2)).status, 404, "tampoco desde la caché");

  assert.equal((await e.api("/api/admin/productos/IMG-01", { metodo: "DELETE", token })).status, 200);
});

test("cron: anula los pedidos Webpay vencidos y devuelve el stock", OPC, async () => {
  const viejo = await crearPedido([{ id: "SG-0014", cant: 1 }]);
  const nuevo = await crearPedido([{ id: "SG-0017", cant: 1 }]);
  sinCorreo.push(viejo.numero, nuevo.numero);
  numeroEnvejecido = viejo.numero;
  assert.equal(await stockDe("SG-0014"), 0);

  // Hacemos "viejo" al primer pedido directo en la base (como si hubieran pasado horas)
  await e.sql(`UPDATE pedidos SET creado_en = '2020-01-01T00:00:00.000Z' WHERE numero = '${viejo.numero}'`);
  await e.ejecutarCron();

  await esperarQue(async () => (await verPedido(viejo)).estadoPago === "anulado", "que el cron anule el pedido vencido");
  assert.equal(await stockDe("SG-0014"), 1);
  const pa = await pedidoAdmin(viejo.numero);
  assert.equal(pa.motivoAnulacion, "Pago Webpay no completado");
  assert.equal(transaccionesDePago(pa)[0].estado, "expirada");

  assert.equal((await verPedido(nuevo)).estadoPago, "pendiente", "un pedido reciente no se toca");
  assert.equal(await stockDe("SG-0017"), 0);

  // Si el comprador vuelve tarde de Webpay, NO se confirma el pago (Transbank lo reversa solo)
  await volverDeWebpay(viejo, "pagar");
  assert.equal((await verPedido(viejo)).estadoPago, "anulado");
  assert.equal(e.webpay.llamadasDe("confirmar", viejo.webpay.token).length, 0);
  assert.equal(await stockDe("SG-0014"), 1);
});

test("admin: anular un pedido pendiente devuelve el stock", OPC, async () => {
  const token = await admin();
  const pedido = await crearPedido([{ id: "SG-0015", cant: 1 }]);
  sinCorreo.push(pedido.numero);
  assert.equal(await stockDe("SG-0015"), 0);

  const r = await e.api(`/api/admin/pedidos/${pedido.numero}/anular`, {
    metodo: "POST", token, cuerpo: { motivo: "La apoderada avisó que ya no lo quiere." }
  });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.datos.pedido.estadoPago, "anulado");
  assert.equal(r.datos.pedido.motivoAnulacion, "La apoderada avisó que ya no lo quiere.");
  assert.equal(await stockDe("SG-0015"), 1);

  const otraVez = await e.api(`/api/admin/pedidos/${pedido.numero}/anular`, { metodo: "POST", token, cuerpo: { motivo: "otra vez" } });
  assert.ok(otraVez.status >= 400 && otraVez.status < 500, "solo se anula un pedido pendiente");
  assert.equal(await stockDe("SG-0015"), 1, "el stock no se devuelve dos veces");

  const pagado = await e.api(`/api/admin/pedidos/${pedidoDoble.numero}/anular`, { metodo: "POST", token, cuerpo: { motivo: "no" } });
  assert.ok(pagado.status >= 400 && pagado.status < 500, "un pedido pagado no se anula");
});

test("admin: marcar entregado", OPC, async () => {
  const token = await admin();
  const r = await e.api(`/api/admin/pedidos/${pedidoDoble.numero}/entregado`, { metodo: "POST", token });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.datos.pedido.entrega, "entregado");
  assert.ok((await pedidoAdmin(pedidoDoble.numero)).entregadoEn, "falta entregadoEn");

  const anulado = await e.api(`/api/admin/pedidos/${sinCorreo[0]}/entregado`, { metodo: "POST", token });
  assert.ok(anulado.status >= 400 && anulado.status < 500, "un pedido anulado no se entrega");

  // "Marcar pagado" es solo para transferencia/efectivo: Webpay se confirma solo
  const pagadoWebpay = await e.api(`/api/admin/pedidos/${pedidoDoble.numero}/pagado`, { metodo: "POST", token });
  assert.ok(pagadoWebpay.status >= 400 && pagadoWebpay.status < 500);
});

test("admin: el resumen cuadra con los pedidos y las prendas", OPC, async () => {
  const token = await admin();
  const r = await e.api("/api/admin/resumen", { token });
  assert.equal(r.status, 200, r.texto);
  const productos = (await e.api("/api/admin/productos", { token })).datos.productos;
  const pedidos = (await e.api("/api/admin/pedidos", { token })).datos.pedidos;

  // Los pedidos vienen del más nuevo al más antiguo (sin contar el que el cron "envejeció" a mano)
  const ordenados = pedidos.filter(p => p.numero !== numeroEnvejecido);
  for (let i = 1; i < ordenados.length; i++) {
    assert.ok(ordenados[i - 1].creadoEn >= ordenados[i].creadoEn, "los pedidos deben venir más nuevos primero");
  }

  const suma = lista => lista.reduce((s, x) => s + x, 0);
  const pagados = pedidos.filter(p => p.estadoPago === "pagado");
  const esperado = {
    prendas: productos.length,
    disponibles: productos.filter(p => p.publicado && p.stock > 0).length,
    pedidos: pedidos.filter(p => !["anulado", "rechazado"].includes(p.estadoPago)).length,
    prendasVendidas: suma(pagados.flatMap(p => p.items.map(i => i.cant))),
    recaudado: suma(pagados.map(p => p.total)),
    porCobrar: suma(pedidos.filter(p => p.estadoPago === "pendiente" && p.metodoPago !== "webpay").map(p => p.total)),
    reembolsado: suma(pedidos.filter(p => p.estadoPago === "reembolsado").map(p => p.total))
  };
  assert.deepEqual(r.datos, esperado);
  assert.ok(esperado.recaudado > 0 && esperado.reembolsado === 13000, "los tests anteriores dejan ventas y reembolsos");
});

test("admin: ventas.csv para Excel", OPC, async () => {
  const sinSesion = await fetch(e.url + "/api/admin/ventas.csv");
  assert.equal(sinSesion.status, 401);
  await sinSesion.arrayBuffer();

  const res = await fetch(e.url + "/api/admin/ventas.csv", { headers: { Authorization: "Bearer " + await admin() } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /^text\/csv;\s*charset=utf-8/i);
  assert.match(res.headers.get("content-disposition") || "", /attachment;\s*filename="ventas-ropero\.csv"/);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "empieza con BOM para que Excel lea las tildes");

  const filas = bytes.toString("utf8").slice(1).split(/\r?\n/).filter(l => l.trim()).map(leerFilaCsv);
  const encabezado = filas[0];
  for (const columna of ["N pedido", "Fecha", "Comprador", "Correo", "Codigo", "Prenda", "Codigo autorizacion", "Tarjeta", "Ambiente"]) {
    assert.ok(encabezado.includes(columna), `falta la columna "${columna}" (hay: ${encabezado.join(" | ")})`);
  }
  const fila = filas.find(f => f.includes(pedidoDoble.numero));
  assert.ok(fila, "el pedido pagado aparece en el CSV");
  assert.equal(fila.length, encabezado.length, "todas las filas tienen las mismas columnas");
  assert.equal(fila[encabezado.indexOf("Codigo autorizacion")], "1213");
  assert.ok(fila[encabezado.indexOf("Tarjeta")].includes("6623"));
  assert.equal(fila[encabezado.indexOf("Codigo")], "SG-0008");
  assert.equal(fila[encabezado.indexOf("Ambiente")], "integracion", "el pago se hizo con la tarjeta de prueba");
  assert.match(fila[encabezado.indexOf("Fecha")], /^\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}$/, "fecha en hora de Chile");
});

test("correos: uno por pedido confirmado y ninguno de pedidos sin pagar", OPC, async () => {
  // A estas alturas ya pasaron varios segundos: si hubiera correos duplicados, ya habrían llegado
  await e.smtp.esperarCorreos(m => m.asunto.includes(pedidoDoble.numero), 2, 20_000);
  for (const numero of [pedidoAprobado.numero, pedidoDoble.numero]) {
    const correos = correosConfirmacion(numero);
    assert.equal(correos.filter(m => m.asunto === asuntoComprador(numero)).length, 1, `${numero}: un comprobante`);
    assert.equal(correos.filter(m => m.to.includes(CORREO_AVISOS)).length, 1, `${numero}: un aviso al ropero`);
  }
  for (const numero of sinCorreo) {
    assert.equal(correosConfirmacion(numero).length, 0, `${numero} no estaba pagado y no debía mandar correos`);
  }
});

/* ================================================================
   CORRECCIONES: PRENDAS EDITADAS A LA VEZ, CÓDIGOS, PAGOS INCIERTOS,
   DEVOLUCIONES CON RESPUESTA PERDIDA Y FRENOS
   ================================================================ */

// Crea una prenda desde el panel (stock 1 por defecto)
async function crearPrenda(id, extra = {}) {
  const r = await e.api("/api/admin/productos", {
    metodo: "POST", token: await admin(),
    cuerpo: { id, nombre: "Prenda " + id, tipo: "Polera", marca: "Otra", talla: "M", estado: "bueno",
      precio: 3000, stock: 1, detalle: "", imagen: "", publicado: true, ...extra }
  });
  assert.equal(r.status, 201, r.texto);
  return r.datos.producto;
}

async function prendaAdmin(id) {
  return (await e.api("/api/admin/productos", { token: await admin() })).datos.productos.find(p => p.id === id);
}

// Hace "viejas" la creación y la reserva de la transacción (como si hubieran pasado minutos)
const envejecerReserva = token => e.sql(
  `UPDATE transacciones SET creado_en = '2020-01-01T00:00:00.000Z', actualizado_en = '2020-01-01T00:05:00.000Z'
   WHERE tipo = 'pago' AND token = '${token}'`);

// Paga en Webpay, pero el commit y la consulta del estado fallan (Transbank no contesta)
async function pagarSinRespuesta(pedido, accion, { procesar = true } = {}) {
  e.webpay.control({ accion: "fallar", operacion: "confirmar", status: 500, procesar });
  e.webpay.control({ accion: "fallar", operacion: "estado", status: 503 });
  await volverDeWebpay(pedido, accion);
}

test("admin: guardar una prenda con datos viejos responde 409 y no pisa el stock", OPC, async () => {
  const token = await admin();
  const leida = await crearPrenda("ED-0001", { stock: 1 });

  // Mientras la voluntaria la tiene abierta, se vende
  const pedido = await crearPedido([{ id: "ED-0001", cant: 1 }]);
  await volverDeWebpay(pedido, "pagar");
  assert.equal((await verPedido(pedido)).estadoPago, "pagado");

  const cuerpo = { ...leida, precio: 2500, actualizadoEn: leida.actualizadoEn };
  const r = await e.api("/api/admin/productos/ED-0001", { metodo: "PUT", token, cuerpo });
  assert.equal(r.status, 409, r.texto);
  assert.equal(r.datos.error, "Esta prenda cambió mientras la editabas (se vendió, se reservó o alguien más la modificó). Recarga la lista y vuelve a intentarlo.");
  let actual = await prendaAdmin("ED-0001");
  assert.equal(actual.stock, 0, "la prenda vendida no vuelve al catálogo");
  assert.equal(actual.precio, 3000);

  // Con la versión al día sí se guarda
  const bien = await e.api("/api/admin/productos/ED-0001", {
    metodo: "PUT", token, cuerpo: { ...actual, precio: 2500, actualizadoEn: actual.actualizadoEn }
  });
  assert.equal(bien.status, 200, bien.texto);
  assert.equal(bien.datos.producto.precio, 2500);
  assert.equal(bien.datos.producto.stock, 0);
});

test("admin: Ocultar/Publicar cambia solo «publicado» y nunca el stock", OPC, async () => {
  const token = await admin();
  const ruta = "/api/admin/productos/ED-0001/publicado";
  assert.equal((await prendaAdmin("ED-0001")).stock, 0);

  const ocultar = await e.api(ruta, { metodo: "POST", token, cuerpo: { publicado: false } });
  assert.equal(ocultar.status, 200, ocultar.texto);
  assert.equal(ocultar.datos.producto.publicado, false);
  assert.equal(ocultar.datos.producto.stock, 0);
  assert.ok(!(await e.api("/api/productos")).datos.productos.some(p => p.id === "ED-0001"), "oculta no sale en la tienda");

  const publicar = await e.api(ruta, { metodo: "POST", token, cuerpo: { publicado: true } });
  assert.equal(publicar.status, 200, publicar.texto);
  assert.equal(publicar.datos.producto.publicado, true);
  assert.equal(publicar.datos.producto.stock, 0, "publicarla no revive la prenda vendida");
  assert.equal((await e.api("/api/productos")).datos.productos.find(p => p.id === "ED-0001").stock, 0);

  assert.equal((await e.api(ruta, { metodo: "POST", token, cuerpo: { publicado: "si" } })).status, 400);
  assert.equal((await e.api("/api/admin/productos/NO-EXISTE/publicado", { metodo: "POST", token, cuerpo: { publicado: true } })).status, 404);
  assert.equal((await e.api(ruta, { metodo: "POST", cuerpo: { publicado: false } })).status, 401);
});

test("admin: no se borra una prenda con un pedido pendiente ni se reutiliza un código ya vendido", OPC, async () => {
  const token = await admin();
  await crearPrenda("SG-0090");
  const lista = await e.api("/api/admin/productos", { token });
  assert.equal(lista.datos.siguienteCodigo, "SG-0091", "el código sugerido sigue al más alto");

  const pedido = await crearPedido([{ id: "SG-0090", cant: 1 }]);
  sinCorreo.push(pedido.numero);
  const borrar = await e.api("/api/admin/productos/SG-0090", { metodo: "DELETE", token });
  assert.equal(borrar.status, 409, borrar.texto);
  assert.equal(borrar.datos.error, "Esta prenda está en un pedido pendiente de pago. Espera a que se pague o anúlalo antes de borrarla.");
  assert.ok(await prendaAdmin("SG-0090"), "la prenda sigue ahí");

  // Al anularse el pedido ya se puede borrar…
  assert.equal((await cancelar(pedido.numero, { t: pedido.token })).datos.pedido.estadoPago, "anulado");
  assert.equal((await e.api("/api/admin/productos/SG-0090", { metodo: "DELETE", token })).status, 200);

  // …pero su código ya estuvo en un pedido: no se sugiere ni se acepta de nuevo
  assert.equal((await e.api("/api/admin/productos", { token })).datos.siguienteCodigo, "SG-0091");
  const repetido = await e.api("/api/admin/productos", {
    metodo: "POST", token,
    cuerpo: { id: "SG-0090", nombre: "Otra prenda", tipo: "Polera", marca: "Otra", talla: "M", estado: "bueno", precio: 1000, stock: 1 }
  });
  assert.equal(repetido.status, 409, repetido.texto);
  assert.equal(repetido.datos.error, "Ese código ya se usó en un pedido. Usa otro (sugerido: SG-0091).");
});

test("pago incierto: si el commit y el estado fallan queda pendiente, y el cron lo resuelve como pagado", OPC, async () => {
  await crearPrenda("PI-0001");
  const pedido = await crearPedido([{ id: "PI-0001", cant: 1 }]);
  await pagarSinRespuesta(pedido, "pagar");

  let p = await verPedido(pedido);
  assert.equal(p.estadoPago, "pendiente", "sin respuesta de Transbank no se da por rechazado");
  assert.equal(p.pago, null);
  assert.equal(await stockDe("PI-0001"), 0, "la prenda sigue reservada");
  let [tx] = transaccionesDePago(await pedidoAdmin(pedido.numero));
  assert.equal(tx.estado, "iniciada");
  assert.match(tx.detalleError || "", /500/);
  assert.equal(correosConfirmacion(pedido.numero).length, 0);

  // Mientras la reserva está vigente, nadie lo anula: ni la tienda ni el cron (aunque sea viejo)
  assert.equal((await cancelar(pedido.numero, { t: pedido.token })).datos.pedido.estadoPago, "pendiente");
  await e.sql(`UPDATE pedidos SET creado_en = '2020-01-01T00:00:00.000Z' WHERE numero = '${pedido.numero}'`);
  await e.ejecutarCron();
  assert.equal((await verPedido(pedido)).estadoPago, "pendiente");
  assert.equal(e.webpay.llamadasDe("confirmar", pedido.webpay.token).length, 1);

  // Vencida la reserva, el cron vuelve a preguntar: Transbank sí lo cobró
  await envejecerReserva(pedido.webpay.token);
  await e.ejecutarCron();
  p = await esperarQue(async () => { const x = await verPedido(pedido); return x.estadoPago === "pagado" && x; }, "que el cron lo marque pagado");
  assert.equal(p.pago.codigoAutorizacion, "1213");
  assert.equal(await stockDe("PI-0001"), 0);
  [tx] = transaccionesDePago(await pedidoAdmin(pedido.numero));
  assert.equal(tx.estado, "autorizada");
  assert.equal(e.webpay.llamadasDe("confirmar", pedido.webpay.token).length, 2);
  await e.smtp.esperarCorreos(m => m.asunto.includes(pedido.numero), 2, 20_000);
});

test("pago incierto rechazado: el cron espera mientras Transbank no contesta y después lo anula", OPC, async () => {
  await crearPrenda("PI-0002");
  const pedido = await crearPedido([{ id: "PI-0002", cant: 1 }]);
  sinCorreo.push(pedido.numero);
  await pagarSinRespuesta(pedido, "rechazar");
  assert.equal((await verPedido(pedido)).estadoPago, "pendiente");

  // Transbank sigue sin contestar: no se toca
  await envejecerReserva(pedido.webpay.token);
  e.webpay.control({ accion: "fallar", operacion: "confirmar", status: 503 });
  e.webpay.control({ accion: "fallar", operacion: "estado", status: 503 });
  await e.ejecutarCron();
  assert.equal((await verPedido(pedido)).estadoPago, "pendiente");
  assert.equal(await stockDe("PI-0002"), 0);
  assert.equal(transaccionesDePago(await pedidoAdmin(pedido.numero))[0].estado, "iniciada");

  // Transbank contesta que el banco lo rechazó: se anula y la prenda vuelve
  await envejecerReserva(pedido.webpay.token);
  await e.ejecutarCron();
  await esperarQue(async () => (await verPedido(pedido)).estadoPago === "anulado", "que el cron anule el pedido");
  assert.equal(await stockDe("PI-0002"), 1);
  const pa = await pedidoAdmin(pedido.numero);
  assert.equal(transaccionesDePago(pa)[0].estado, "rechazada");
  assert.equal(pa.motivoAnulacion, "Pago Webpay no completado");
});

test("pago a medias: «cancelar» y «Anular» del panel le preguntan antes a Transbank", OPC, async () => {
  const token = await admin();
  // 1) El commit no llegó a Transbank: al cancelar se confirma y resulta pagado
  await crearPrenda("PI-0003");
  const pagado = await crearPedido([{ id: "PI-0003", cant: 1 }]);
  await pagarSinRespuesta(pagado, "pagar", { procesar: false });
  assert.equal((await verPedido(pagado)).estadoPago, "pendiente");
  await envejecerReserva(pagado.webpay.token);
  const r = await cancelar(pagado.numero, { t: pagado.token });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.datos.pedido.estadoPago, "pagado", "el comprador sí pagó: no se anula");
  assert.equal(await stockDe("PI-0003"), 0);
  await e.smtp.esperarCorreos(m => m.asunto.includes(pagado.numero), 2, 20_000);

  // 2) Rechazado por el banco, pero sin respuesta: el panel no lo anula a ciegas
  await crearPrenda("PI-0004");
  const pedido = await crearPedido([{ id: "PI-0004", cant: 1 }]);
  sinCorreo.push(pedido.numero);
  await pagarSinRespuesta(pedido, "rechazar");
  const anular = () => e.api(`/api/admin/pedidos/${pedido.numero}/anular`, { metodo: "POST", token, cuerpo: { motivo: "No se pagó." } });

  let a = await anular();
  assert.equal(a.status, 409, a.texto);
  assert.match(a.datos.error, /confirmando/);

  await envejecerReserva(pedido.webpay.token);
  e.webpay.control({ accion: "fallar", operacion: "confirmar", status: 503 });
  e.webpay.control({ accion: "fallar", operacion: "estado", status: 503 });
  a = await anular();
  assert.equal(a.status, 409, a.texto);
  assert.match(a.datos.error, /Transbank/);
  assert.equal((await verPedido(pedido)).estadoPago, "pendiente");
  assert.equal(await stockDe("PI-0004"), 0);

  await envejecerReserva(pedido.webpay.token);
  a = await anular();
  assert.equal(a.status, 200, a.texto);
  assert.equal(a.datos.pedido.estadoPago, "anulado");
  assert.equal(a.datos.pedido.motivoAnulacion, "No se pagó.");
  assert.equal(await stockDe("PI-0004"), 1);
});

test("Webpay corta la respuesta al crear la transacción: 502 y la prenda vuelve al catálogo", OPC, async () => {
  await crearPrenda("WC-0001");
  e.webpay.control({ accion: "fallar", operacion: "crear", cortar: true });
  const r = await pedir([{ id: "WC-0001", cant: 1 }]);
  assert.equal(r.status, 502, r.texto);
  assert.equal(await stockDe("WC-0001"), 1);
  const pedidos = (await e.api("/api/admin/pedidos", { token: await admin() })).datos.pedidos;
  const p = pedidos.find(x => x.items.some(i => i.id === "WC-0001"));
  assert.equal(p.estadoPago, "anulado");
  assert.equal(transaccionesDePago(p)[0].estado, "error");
  sinCorreo.push(p.numero);
});

test("reembolso: si se pierde la respuesta de Webpay, se pregunta el estado antes de anotar un error", OPC, async () => {
  const token = await admin();
  const pedirYAprobar = async (id) => {
    await crearPrenda(id);
    const pedido = await crearPedido([{ id, cant: 1 }]);
    await volverDeWebpay(pedido, "pagar");
    const s = await e.api(`/api/pedidos/${pedido.numero}/reembolso`, { metodo: "POST", cuerpo: { t: pedido.token, motivo: "No le quedó bien la talla." } });
    assert.equal(s.status, 201, s.texto);
    return pedido;
  };
  const resolver = numero => e.api(`/api/admin/reembolsos/${numero}/resolver`, {
    metodo: "POST", token, cuerpo: { decision: "aprobado", respuesta: "Aprobado." }
  });

  // 1) Transbank devolvió el dinero, pero su respuesta no llegó
  const uno = await pedirYAprobar("RB-0001");
  e.webpay.control({ accion: "fallar", operacion: "reembolsar", status: 504, procesar: true });
  let r = await resolver(uno.numero);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.datos.webpay.ok, true, r.datos.webpay.mensaje);
  assert.equal(r.datos.pedido.estadoPago, "reembolsado");
  assert.equal(r.datos.pedido.reembolso.estado, "devuelto");
  assert.deepEqual(e.webpay.llamadasDe("reembolsar", uno.webpay.token).map(l => l.status), [504]);
  assert.equal(transaccionesDePago(r.datos.pedido).length, 1);
  assert.equal(r.datos.pedido.transacciones.find(t => t.tipo === "reembolso").estado, "reembolsada");

  // 2) Tampoco se pudo consultar el estado: no se sabe, y no se sugiere devolver a mano sin revisar
  const dos = await pedirYAprobar("RB-0002");
  e.webpay.control({ accion: "fallar", operacion: "reembolsar", status: 504, procesar: true });
  e.webpay.control({ accion: "fallar", operacion: "estado", status: 503 });
  r = await resolver(dos.numero);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.datos.webpay.ok, false);
  assert.match(r.datos.webpay.mensaje, /portal de Transbank/);
  assert.equal(r.datos.pedido.estadoPago, "pagado");
  assert.equal(r.datos.pedido.reembolso.estado, "aprobado");

  // Reintentar: Transbank rechaza la devolución (ya estaba hecha) y el estado lo confirma
  r = await e.api(`/api/admin/reembolsos/${dos.numero}/reintentar`, { metodo: "POST", token });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.datos.webpay.ok, true, r.datos.webpay.mensaje);
  assert.equal(r.datos.pedido.estadoPago, "reembolsado");
  assert.equal(r.datos.pedido.reembolso.estado, "devuelto");
  assert.deepEqual(e.webpay.llamadasDe("reembolsar", dos.webpay.token).map(l => l.status), [504, 422]);
  assert.equal(e.webpay.transacciones.get(dos.webpay.token).reembolsos, 1, "Transbank devolvió el dinero una sola vez");
});

test("admin: los pagos con la tarjeta de prueba se marcan (ambiente de Webpay)", OPC, async () => {
  const pa = await pedidoAdmin(pedidoDoble.numero);
  assert.equal(pa.pagoDePrueba, true);
  assert.equal(transaccionesDePago(pa)[0].ambiente, "integracion");
  const anulado = await pedidoAdmin(sinCorreo[0]);
  assert.equal(anulado.pagoDePrueba, false, "sin pago autorizado no es un pago de prueba");
});

test("admin: el freno de la clave no se salta con intentos simultáneos ni cambiando de IPv6", OPC, async () => {
  const ingresar = (clave, ip) => e.api("/api/admin/ingresar", { metodo: "POST", cuerpo: { clave }, headers: { "CF-Connecting-IP": ip } });

  // 30 intentos a la vez desde una IP: solo 8 alcanzan a probar la clave
  const respuestas = await Promise.all(Array.from({ length: 30 }, (_, i) => ingresar("adivinando-" + i, "203.0.113.50")));
  const cuenta = s => respuestas.filter(r => r.status === s).length;
  assert.equal(cuenta(401), 8, `401: ${cuenta(401)}, 429: ${cuenta(429)}`);
  assert.equal(cuenta(429), 22);
  assert.equal((await ingresar(CLAVE_ADMIN, "203.0.113.50")).status, 429, "bloqueada, ni con la clave correcta");
  assert.equal((await ingresar(CLAVE_ADMIN, "203.0.113.51")).status, 200, "otra IP entra normal");

  // IPv6: cambiar de dirección dentro del mismo /64 no sirve
  for (let i = 1; i <= 8; i++) assert.equal((await ingresar("x" + i, `2001:db8:aa:bb::${i}`)).status, 401);
  assert.equal((await ingresar("x9", "2001:db8:aa:bb:ffff:1:2:3")).status, 429);
  assert.equal((await ingresar("x10", "2001:db8:aa:cc::1")).status, 401, "otro /64 es otra conexión");
});

test("Mis pedidos: 429 después de 10 búsquedas fallidas desde la misma IP", OPC, async () => {
  const ip = "198.51.100.20";
  const buscar = (correo, desde = ip) => e.api("/api/pedidos/buscar", {
    metodo: "POST", cuerpo: { numero: pedidoAprobado.numero, correo }, headers: { "CF-Connecting-IP": desde }
  });
  assert.equal((await buscar("carolina.munoz@ejemplo.cl")).status, 200, "una búsqueda correcta no cuenta");
  for (let i = 0; i < 10; i++) assert.equal((await buscar(`otra${i}@ejemplo.cl`)).status, 404);
  const bloqueada = await buscar("otra@ejemplo.cl");
  assert.equal(bloqueada.status, 429);
  assert.equal(bloqueada.datos.error, "Demasiados intentos. Espera unos minutos y vuelve a intentarlo.");
  assert.equal((await buscar("carolina.munoz@ejemplo.cl")).status, 429);

  // Pedir reembolso con el correo usa el mismo freno; con el token del comprobante no
  const reembolso = cuerpo => e.api(`/api/pedidos/${pedidoAprobado.numero}/reembolso`, {
    metodo: "POST", cuerpo: { motivo: "La talla no le quedó.", ...cuerpo }, headers: { "CF-Connecting-IP": ip }
  });
  assert.equal((await reembolso({ correo: "carolina.munoz@ejemplo.cl" })).status, 429);
  assert.equal((await reembolso({ t: pedidoAprobado.token })).status, 409, "con el token no hay freno (ya tiene reembolso)");

  assert.equal((await buscar("carolina.munoz@ejemplo.cl", "198.51.100.21")).status, 200, "otra IP busca normal");
});

test("sesiones: la firma no sale solo de ADMIN_CLAVE y la configuración del correo exige TLS", OPC, async () => {
  // Un token firmado como antes (solo con la clave) no sirve
  const b64 = b => Buffer.from(b).toString("base64url");
  const contenido = b64(JSON.stringify({ exp: Date.now() + 3_600_000 }));
  const { createHash, createHmac } = await import("node:crypto");
  const llave = createHash("sha256").update(`ropero-sg|${CLAVE_ADMIN}|`).digest();
  const falso = `${contenido}.${createHmac("sha256", llave).update(contenido).digest("base64url")}`;
  assert.equal((await e.api("/api/admin/pedidos", { token: falso })).status, 401);
  const [fila] = await e.sql("SELECT length(valor) AS largo FROM ajustes WHERE clave = 'secreto_sesiones'");
  assert.equal(fila.largo, 64, "hay un secreto aleatorio de 32 bytes");

  // SMTP: solo "tls"; "starttls" podría mandar la clave sin cifrar; "ninguna" solo en este computador
  const base = { SMTP_HOST: "smtp.gmail.com", SMTP_USUARIO: "ropero@ejemplo.cl", SMTP_CLAVE: "x" };
  assert.equal(correoActivo(base), true);
  assert.deepEqual([opcionesSmtp(base).port, opcionesSmtp(base).secure, opcionesSmtp(base).startTls], [465, true, false]);
  assert.equal(correoActivo({ ...base, SMTP_SEGURIDAD: "starttls", SMTP_PUERTO: "587" }), false);
  assert.match(errorSmtp({ ...base, SMTP_SEGURIDAD: "starttls" }), /tls/);
  assert.equal(correoActivo({ ...base, SMTP_SEGURIDAD: "ninguna" }), false);
  assert.equal(correoActivo({ ...base, SMTP_HOST: "127.0.0.1", SMTP_SEGURIDAD: "ninguna" }), true);
});

// Va al final: después de esto la IP queda bloqueada 15 minutos para el panel
test("admin: 429 después de muchos intentos fallidos", OPC, async () => {
  let respuesta;
  let fallosAhora = 0;
  for (let i = 0; i < 12; i++) {
    respuesta = await e.api("/api/admin/ingresar", { metodo: "POST", cuerpo: { clave: "adivinando-" + i } });
    if (respuesta.status === 429) break;
    assert.equal(respuesta.status, 401);
    fallosAhora++;
  }
  assert.equal(respuesta.status, 429, "después de 8 fallos desde la misma IP debe responder 429");
  assert.equal(typeof respuesta.datos.error, "string");
  const total = fallosIngreso + fallosAhora;
  assert.ok(total >= 7 && total <= 8, `bloquea al llegar a 8 fallos (bloqueó después de ${total})`);
});

/* ---------- CSV ---------- */

// Lee una fila con separador ";" y campos entre comillas (las comillas dobles "" son una comilla)
function leerFilaCsv(linea) {
  const celdas = [];
  let actual = "", entreComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i];
    if (entreComillas) {
      if (c === '"' && linea[i + 1] === '"') { actual += '"'; i++; }
      else if (c === '"') entreComillas = false;
      else actual += c;
    } else if (c === '"') entreComillas = true;
    else if (c === ";") { celdas.push(actual); actual = ""; }
    else actual += c;
  }
  celdas.push(actual);
  return celdas;
}

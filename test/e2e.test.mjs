/* ================================================================
   TESTS DE PUNTA A PUNTA CON UN NAVEGADOR (npm run test:e2e)
   ----------------------------------------------------------------
   Chromium sin ventana recorre la tienda y el panel como lo haría
   una apoderada o una voluntaria. Webpay y el correo son mocks.
   Cada test falla si la página muestra errores en la consola.
   Los tests corren EN ORDEN: el reembolso usa la compra del primero.
   ================================================================ */

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { levantarEntorno, CLAVE_ADMIN } from "./helpers/entorno.mjs";
import { crearPng, medidasJpeg } from "./helpers/imagenes.mjs";

// Playwright está instalado globalmente (NODE_PATH): con import "playwright" no se encuentra
const { chromium } = createRequire(import.meta.url)("playwright");

const OPC = { timeout: 120_000 };
const PALABRAS_PROHIBIDAS = ["prototipo", "demostración", "4111"];

let e;
let navegador;
let tokenAdminCache = null;
const abiertas = [];          // contextos abiertos, para cerrarlos aunque un test falle

// Datos de la compra del primer test (los usan los siguientes)
let compra = null;            // { numero, correo }

before(async () => {
  e = await levantarEntorno();
  navegador = await chromium.launch({ headless: true });
}, { timeout: 360_000 });

afterEach(async t => {
  if (!t.passed) e?.marcarFalla();
  while (abiertas.length) await abiertas.pop().close().catch(() => {});
});

after(async () => {
  await navegador?.close().catch(() => {});
  await e?.cerrar();
}, { timeout: 30_000 });

/* ---------------- Ayudas ---------------- */

// Una pestaña nueva y limpia (sin carrito ni sesión) que anota los errores de consola
async function nuevaPagina() {
  const contexto = await navegador.newContext({ locale: "es-CL", viewport: { width: 1280, height: 900 } });
  abiertas.push(contexto);
  // Los tests no usan internet: lo externo (fuentes de Google) responde vacío y no ensucia la consola
  const origenes = [new URL(e.url).origin, new URL(e.webpay.url).origin];
  await contexto.route(url => !origenes.includes(url.origin), ruta =>
    ruta.fulfill({ status: 200, contentType: "text/css", body: "" }));

  const pagina = await contexto.newPage();
  pagina.setDefaultTimeout(20_000);
  const errores = [];
  pagina.on("console", m => {
    if (m.type() === "error") errores.push(`[consola] ${m.text()} (en ${pagina.url()})`);
  });
  pagina.on("pageerror", error => errores.push(`[error JS] ${error.message} (en ${pagina.url()})`));
  pagina.on("dialog", d => d.accept());   // los confirm() del panel
  return { pagina, errores };
}

function sinErroresDeConsola(errores) {
  assert.deepEqual(errores, [], "la página no debe mostrar errores en la consola");
}

async function revisarTextosProhibidos(pagina, donde) {
  const html = (await pagina.content()).toLowerCase();
  for (const palabra of PALABRAS_PROHIBIDAS) {
    assert.ok(!html.includes(palabra), `${donde} contiene "${palabra}"`);
  }
}

async function admin() {
  if (!tokenAdminCache) tokenAdminCache = await e.ingresarAdmin();
  return tokenAdminCache;
}

async function pedidoAdmin(numero) {
  const r = await e.api("/api/admin/pedidos", { token: await admin() });
  assert.equal(r.status, 200, r.texto);
  return r.datos.pedidos.find(p => p.numero === numero);
}

async function prendaAdmin(id) {
  const r = await e.api("/api/admin/productos", { token: await admin() });
  assert.equal(r.status, 200, r.texto);
  return r.datos.productos.find(p => p.id === id);
}

// Espera activa (sin sleeps largos): repite `revisar` hasta que devuelva algo "verdadero"
async function esperarQue(revisar, descripcion, msMaximo = 20_000) {
  const limite = Date.now() + msMaximo;
  while (Date.now() < limite) {
    const resultado = await revisar();
    if (resultado) return resultado;
    await new Promise(r => setTimeout(r, 200));
  }
  assert.fail(`Se acabó el tiempo esperando: ${descripcion}`);
}

// Abre la ficha de una prenda del catálogo y la agrega al carrito
async function agregarAlCarrito(pagina, codigo) {
  const tarjeta = pagina.locator("#grillaPrendas article.prenda", { hasText: codigo });
  await tarjeta.getByRole("button", { name: "Ver prenda" }).click();
  await pagina.getByRole("button", { name: /Añadir al carrito/ }).click();
}

// Desde el carrito abierto: llena el checkout, confirma y llega a la página de Webpay.
// Devuelve el número de pedido que muestra Webpay.
async function pagarConWebpayHastaElBanco(pagina, { nombre, correo, fono }) {
  await pagina.getByRole("button", { name: "Continuar con la entrega" }).click();
  await pagina.locator("#vistaCheckout").waitFor({ state: "visible" });
  await pagina.fill("#compNombre", nombre);
  await pagina.fill("#compCorreo", correo);
  await pagina.fill("#compFono", fono);
  const opcionWebpay = pagina.locator('input[name="pago"][value="webpay"]');
  if (!(await opcionWebpay.isChecked())) await opcionWebpay.check();
  // Servidor en ambiente de integración: se avisa que no hay cobro real
  await pagina.getByText("Webpay está en modo de pruebas").first().waitFor();
  await revisarTextosProhibidos(pagina, "El checkout");

  const origenWebpay = new URL(e.webpay.url).origin;
  await pagina.getByRole("button", { name: "Confirmar pedido" }).click();
  await pagina.waitForURL(u => u.origin === origenWebpay);
  return (await pagina.textContent("#orden")).trim();
}

/* ================================================================
   TIENDA
   ================================================================ */

test("compra completa por la tienda hasta el comprobante de Webpay", OPC, async () => {
  const { pagina, errores } = await nuevaPagina();
  await pagina.goto(e.url + "/");
  await revisarTextosProhibidos(pagina, "La tienda");

  await agregarAlCarrito(pagina, "SG-0004");
  const datos = { nombre: "María José Pérez", correo: "mariajose@ejemplo.cl", fono: "+56 9 1111 2222" };
  const numero = await pagarConWebpayHastaElBanco(pagina, datos);
  assert.match(numero, /^RSG-\d{4}-\d{4,}$/);

  // En "Webpay" aprieta Pagar y vuelve sola a la tienda
  await pagina.getByRole("button", { name: "Pagar", exact: true }).click();
  await pagina.waitForURL(u => u.origin === new URL(e.url).origin);
  await pagina.getByText(numero).first().waitFor();

  // Comprobante con lo que pide Transbank
  const texto = await pagina.locator("body").innerText();
  for (const dato of ["1213", "6623", "Crédito", "$4.000", "Te enviamos el detalle a"]) {
    assert.ok(texto.includes(dato), `el comprobante debe mostrar "${dato}"`);
  }
  // Se pagó lo que estaba en el carrito: el carrito queda vacío
  await pagina.waitForFunction(() => JSON.parse(localStorage.getItem("ropero_carrito") || "[]").length === 0);

  const p = await pedidoAdmin(numero);
  assert.equal(p.estadoPago, "pagado");
  assert.equal(p.total, 4000);
  assert.equal((await prendaAdmin("SG-0004")).stock, 0);
  compra = { numero, correo: datos.correo };

  await revisarTextosProhibidos(pagina, "El comprobante");
  sinErroresDeConsola(errores);
});

test("si el pago se anula en Webpay, el carrito se conserva", OPC, async () => {
  const { pagina, errores } = await nuevaPagina();
  await pagina.goto(e.url + "/");
  await agregarAlCarrito(pagina, "SG-0005");
  const numero = await pagarConWebpayHastaElBanco(pagina, {
    nombre: "Pedro Soto", correo: "pedro@ejemplo.cl", fono: "+56 9 3333 4444"
  });

  await pagina.getByRole("button", { name: "Anular compra", exact: true }).click();
  await pagina.waitForURL(u => u.origin === new URL(e.url).origin);
  await pagina.getByText("El pago no se completó").first().waitFor();
  assert.ok((await pagina.locator("body").innerText()).includes("No se hizo ningún cargo"));

  // El carrito sigue ahí, listo para intentarlo de nuevo
  const carrito = await pagina.evaluate(() => JSON.parse(localStorage.getItem("ropero_carrito") || "[]"));
  assert.deepEqual(carrito.map(l => l.id), ["SG-0005"]);
  assert.equal((await pagina.textContent("#contadorCarrito")).trim(), "1");

  assert.equal((await pedidoAdmin(numero)).estadoPago, "anulado");
  assert.equal((await prendaAdmin("SG-0005")).stock, 2, "la prenda reservada vuelve al catálogo");

  await pagina.getByRole("button", { name: "Intentar de nuevo" }).click();
  await pagina.locator("#vistaCheckout").waitFor({ state: "visible" });
  sinErroresDeConsola(errores);
});

test("Mis pedidos: buscar la compra y pedir un reembolso", OPC, async () => {
  assert.ok(compra, "necesita la compra del primer test");
  const { pagina, errores } = await nuevaPagina();
  await pagina.goto(e.url + "/");
  await pagina.locator("nav.menu").getByText("Mis pedidos").click();
  await pagina.locator("#vistaPedidos").waitFor({ state: "visible" });

  await pagina.fill("#buscarNumero", compra.numero);
  await pagina.fill("#buscarCorreo", compra.correo);
  await pagina.getByRole("button", { name: "Buscar pedido" }).click();
  await pagina.getByText(`Pedido ${compra.numero}`).first().waitFor();
  const texto = await pagina.locator("#resultadoPedidos").innerText();
  assert.ok(texto.includes("1213"), "Mis pedidos muestra el pago Webpay");

  const motivo = "La talla no le quedó a mi hijo, necesitamos una más grande.";
  await pagina.fill("#motivoReembolso", motivo);
  await pagina.getByRole("button", { name: "Solicitar reembolso" }).click();
  await pagina.getByText(motivo).first().waitFor();

  const p = await pedidoAdmin(compra.numero);
  assert.equal(p.reembolso?.estado, "solicitado");
  assert.equal(p.reembolso?.motivo, motivo);
  sinErroresDeConsola(errores);
});

/* ================================================================
   PANEL DE VOLUNTARIAS
   ================================================================ */

test("panel: ingresar, crear una prenda con foto achicada y aprobar el reembolso", OPC, async () => {
  assert.ok(compra, "necesita la compra del primer test");
  const { pagina, errores } = await nuevaPagina();
  await pagina.goto(e.url + "/admin.html");
  await revisarTextosProhibidos(pagina, "El ingreso al panel");

  await pagina.fill("#claveIngreso", CLAVE_ADMIN);
  await pagina.getByRole("button", { name: "Entrar" }).click();
  await pagina.locator("#panel").waitFor({ state: "visible" });
  await pagina.getByText("Webpay: modo pruebas").first().waitFor();
  await pagina.getByText("Correos: activos").first().waitFor();
  await pagina.locator("#tablaPrendas").getByText("SG-0017").first().waitFor();   // ya cargaron las prendas
  await revisarTextosProhibidos(pagina, "El panel");

  // ---- Agregar prenda con una "foto de teléfono" grande (2400×1600, varios MB) ----
  await pagina.locator('.pestanas button[data-p="nueva"]').click();
  await pagina.locator("#sec-nueva").waitFor({ state: "visible" });
  const codigo = await pagina.inputValue("#fCodigo");
  assert.equal(codigo, "SG-0018", "el código sugerido es el siguiente SG-XXXX");

  const fotoGrande = crearPng(2400, 1600, 24);
  assert.ok(fotoGrande.length > 1_500_000, "la foto original pesa más de lo que acepta el servidor");
  await pagina.fill("#fNombre", "Blazer azul con insignia");
  await pagina.selectOption("#fTipo", "Blazer");
  await pagina.selectOption("#fMarca", "First Option");
  await pagina.selectOption("#fTalla", "12");
  await pagina.selectOption("#fEstado", "excelente");
  await pagina.fill("#fPrecio", "9000");
  await pagina.fill("#fStock", "1");
  await pagina.fill("#fDetalle", "Botones completos. Forro sin roturas.");
  await pagina.setInputFiles("#fArchivo", { name: "foto-telefono.png", mimeType: "image/png", buffer: fotoGrande });
  await pagina.locator("#vistaPrevia img").waitFor();
  await pagina.click("#btnGuardar");

  const prenda = await esperarQue(async () => {
    const p = await prendaAdmin(codigo);
    return p && p.imagen.startsWith(`/api/imagenes/${codigo}`) ? p : null;
  }, "que la prenda nueva quede guardada con su foto");
  assert.equal(prenda.nombre, "Blazer azul con insignia");
  assert.equal(prenda.precio, 9000);
  assert.equal(prenda.publicado, true);

  const foto = await fetch(e.url + prenda.imagen);
  assert.equal(foto.status, 200);
  assert.equal(foto.headers.get("content-type"), "image/jpeg", "la foto se convierte a JPEG");
  const bytes = Buffer.from(await foto.arrayBuffer());
  const medidas = medidasJpeg(bytes);
  assert.ok(medidas, "la foto guardada es un JPEG válido");
  assert.ok(Math.max(medidas.ancho, medidas.alto) <= 1200, `el lado mayor queda en 1200 px o menos (${medidas.ancho}×${medidas.alto})`);
  assert.ok(Math.abs(medidas.ancho / medidas.alto - 1.5) < 0.02, "se mantiene la proporción de la foto");
  assert.ok(bytes.length < 1_500_000, "la foto achicada cabe en el límite del servidor");

  // ---- La prenda aparece en la tienda con su foto ----
  const tienda = await pagina.context().newPage();
  const erroresTienda = [];
  tienda.on("console", m => { if (m.type() === "error") erroresTienda.push(`[consola] ${m.text()}`); });
  tienda.on("pageerror", error => erroresTienda.push(`[error JS] ${error.message}`));
  await tienda.goto(e.url + "/");
  const tarjeta = tienda.locator("#grillaPrendas article.prenda", { hasText: codigo });
  await tarjeta.waitFor();
  const img = tarjeta.locator("img").first();
  assert.ok((await img.getAttribute("src")).includes(`/api/imagenes/${codigo}`));
  await img.scrollIntoViewIfNeeded();
  await tienda.waitForFunction(el => el.complete && el.naturalWidth > 0, await img.elementHandle());
  sinErroresDeConsola(erroresTienda);
  await tienda.close();

  // ---- Aprobar el reembolso pedido en "Mis pedidos": Webpay devuelve el dinero ----
  await pagina.locator('.pestanas button[data-p="reembolsos"]').click();
  const caja = pagina.locator("#listaReembolsos .caja", { hasText: compra.numero });
  await caja.locator("textarea").fill("Aprobado. Te devolvemos el dinero a la tarjeta.");
  await caja.getByRole("button", { name: "Aprobar" }).click();

  const p = await esperarQue(async () => {
    const x = await pedidoAdmin(compra.numero);
    return x.reembolso?.estado === "devuelto" ? x : null;
  }, "que el reembolso quede devuelto por Webpay");
  assert.equal(p.estadoPago, "reembolsado");
  assert.equal((await prendaAdmin("SG-0004")).stock, 1, "la prenda vuelve al catálogo");
  assert.equal(e.webpay.llamadasDe("reembolsar").filter(l => l.status === 200).length, 1);
  sinErroresDeConsola(errores);
});

/* ================================================================
   OTRAS PÁGINAS
   ================================================================ */

test("pauta.html muestra los 4 estados", OPC, async () => {
  const { pagina, errores } = await nuevaPagina();
  await pagina.goto(e.url + "/pauta.html");
  const tarjetas = pagina.locator("#tarjetasPauta > .caja");
  await tarjetas.first().waitFor();
  assert.equal(await tarjetas.count(), 4);
  const texto = await pagina.locator("#tarjetasPauta").innerText();
  for (const estado of ["Nuevo", "Excelente", "Bueno", "Usado"]) assert.ok(texto.includes(estado), `falta "${estado}"`);
  sinErroresDeConsola(errores);
});

test("ninguna página dice prototipo, demostración ni 4111", OPC, async () => {
  const { pagina, errores } = await nuevaPagina();
  for (const ruta of ["/", "/index.html", "/admin.html", "/pauta.html"]) {
    await pagina.goto(e.url + ruta);
    await pagina.waitForLoadState("networkidle");
    await revisarTextosProhibidos(pagina, ruta);
  }
  sinErroresDeConsola(errores);
});

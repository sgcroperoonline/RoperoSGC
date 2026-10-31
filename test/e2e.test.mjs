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

// Igual, pero ignora los avisos que el navegador anota solo por respuestas que el test provoca
// a propósito (por ejemplo "status of 409" o una petición cortada: "net::ERR_FAILED")
function sinErroresSalvo(errores, ...esperados) {
  sinErroresDeConsola(errores.filter(x => !esperados.some(t => x.includes("Failed to load resource") && x.includes(t))));
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

// Vende una prenda por la API, pagando en el mock de Webpay (como otra familia comprando)
async function venderPorApi(codigo, cant = 1) {
  const r = await e.api("/api/pedidos", { metodo: "POST", cuerpo: {
    items: [{ id: codigo, cant }],
    comprador: { nombre: "Ana Díaz", correo: "ana@ejemplo.cl", fono: "+56 9 7777 8888" },
    retira: { tipo: "apoderado" },
    pago: "webpay"
  } });
  assert.equal(r.status, 201, r.texto);
  await e.pasarPorWebpay(r.datos.webpay, "pagar");
  assert.equal((await pedidoAdmin(r.datos.numero)).estadoPago, "pagado");
  return r.datos.numero;
}

// Entra al panel con la clave y espera a que carguen las prendas
async function entrarAlPanel(pagina) {
  await pagina.goto(e.url + "/admin.html");
  await pagina.fill("#claveIngreso", CLAVE_ADMIN);
  await pagina.getByRole("button", { name: "Entrar" }).click();
  await pagina.locator("#panel").waitFor({ state: "visible" });
  await pagina.locator("#tablaPrendas").getByText("SG-0017").first().waitFor();
}

// Texto del aviso flotante del panel, cuando dice `texto`
async function esperarAvisoPanel(pagina, texto) {
  await pagina.locator("#aviso", { hasText: texto }).waitFor({ state: "visible" });
  return pagina.locator("#aviso").innerText();
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
async function pagarConWebpayHastaElBanco(pagina, datos) {
  await pagina.getByRole("button", { name: "Continuar con la entrega" }).click();
  return confirmarConWebpay(pagina, datos);
}

// Con el checkout a la vista: llena los datos, confirma y llega a la página de Webpay
async function confirmarConWebpay(pagina, { nombre, correo, fono }) {
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

test("si vuelve de Webpay con «Atrás», el pago se cancela y puede comprar de nuevo", OPC, async () => {
  const { pagina, errores } = await nuevaPagina();
  // Respuestas de POST /api/pedidos: ningún 409 por la reserva de su propio pedido
  const respuestasPedido = [];
  pagina.on("response", r => {
    if (r.request().method() === "POST" && new URL(r.url()).pathname === "/api/pedidos") respuestasPedido.push(r.status());
  });

  await pagina.goto(e.url + "/");
  await agregarAlCarrito(pagina, "SG-0007");   // hay 1 sola: si siguiera reservada, el segundo intento daría 409
  const datos = { nombre: "Javiera Rojas", correo: "javiera@ejemplo.cl", fono: "+56 9 5555 6666" };
  const primero = await pagarConWebpayHastaElBanco(pagina, datos);
  assert.equal((await prendaAdmin("SG-0007")).stock, 0, "mientras paga, la prenda queda reservada");

  // En la página de Webpay aprieta "Atrás" del navegador
  await pagina.goBack();
  await pagina.getByText("Tu pago en Webpay no se completó").first().waitFor();
  assert.ok((await pagina.locator("#avisoFlotante").innerText()).includes("tus prendas siguen en el carrito"));
  await pagina.waitForLoadState("networkidle");   // ya se recargó el catálogo y se revisó el carrito

  const p = await pedidoAdmin(primero);
  assert.equal(p.estadoPago, "anulado");
  assert.equal(p.motivoAnulacion, "Pago abandonado: el comprador volvió a la tienda");
  assert.equal(p.transacciones.find(t => t.tipo === "pago").estado, "abortada");
  assert.equal((await prendaAdmin("SG-0007")).stock, 1, "la prenda reservada vuelve al catálogo");
  assert.equal(await pagina.evaluate(() => sessionStorage.getItem("ropero_pago_en_curso")), null);

  // El carrito conserva la prenda
  const carrito = await pagina.evaluate(() => JSON.parse(localStorage.getItem("ropero_carrito") || "[]"));
  assert.deepEqual(carrito, [{ id: "SG-0007", cant: 1 }]);
  assert.equal((await pagina.textContent("#contadorCarrito")).trim(), "1");

  // Confirma otra vez: llega a Webpay con un pedido nuevo y esta vez paga
  await pagina.getByRole("button", { name: "Abrir carrito" }).click();
  const segundo = await pagarConWebpayHastaElBanco(pagina, datos);
  assert.notEqual(segundo, primero);
  await pagina.getByRole("button", { name: "Pagar", exact: true }).click();
  await pagina.waitForURL(u => u.origin === new URL(e.url).origin);
  await pagina.getByText("¡Pedido confirmado!").first().waitFor();
  await pagina.getByText(segundo).first().waitFor();
  await pagina.waitForFunction(() => JSON.parse(localStorage.getItem("ropero_carrito") || "[]").length === 0);

  assert.deepEqual(respuestasPedido, [201, 201]);
  assert.equal((await pedidoAdmin(segundo)).estadoPago, "pagado");
  assert.equal((await pedidoAdmin(primero)).estadoPago, "anulado");
  assert.equal((await prendaAdmin("SG-0007")).stock, 0);
  sinErroresDeConsola(errores);
});

test("compra directa con el carrito abierto entremedio: se cobra lo que muestra el resumen", OPC, async () => {
  const { pagina, errores } = await nuevaPagina();
  await pagina.goto(e.url + "/");
  await agregarAlCarrito(pagina, "SG-0013");   // corbata de $2.000 en el carrito
  await pagina.getByRole("button", { name: "Seguir comprando", exact: true }).click();

  // "Comprar ahora" en el pantalón de $5.000
  const tarjeta = pagina.locator("#grillaPrendas article.prenda", { hasText: "SG-0011" });
  await tarjeta.getByRole("button", { name: "Ver prenda" }).click();
  await pagina.getByRole("button", { name: "Comprar ahora" }).click();
  await pagina.locator("#vistaCheckout").waitFor({ state: "visible" });

  // Abre el carrito y vuelve sin continuar desde ahí
  await pagina.getByRole("button", { name: "Abrir carrito" }).click();
  await pagina.getByRole("button", { name: "Seguir comprando", exact: true }).click();
  const resumen = await pagina.locator("#resumenPedido").innerText();
  assert.ok(resumen.includes("Pantalón gris media") && resumen.includes("$5.000"), resumen);
  assert.ok(!resumen.includes("Corbata"), "el resumen no cambia a lo del carrito");

  const numero = await confirmarConWebpay(pagina, {
    nombre: "Rosa Lagos", correo: "rosa@ejemplo.cl", fono: "+56 9 1212 3434"
  });
  assert.equal((await pagina.textContent("#monto")).trim(), "$5.000", "Webpay cobra lo que mostraba el resumen");
  const p = await pedidoAdmin(numero);
  assert.deepEqual(p.items.map(i => i.id), ["SG-0011"]);
  assert.equal(p.total, 5000);

  // Anula en Webpay: se muestra una vez que no se completó…
  await pagina.getByRole("button", { name: "Anular compra", exact: true }).click();
  await pagina.waitForURL(u => u.origin === new URL(e.url).origin);
  await pagina.getByText("El pago no se completó").first().waitFor();
  assert.equal((await prendaAdmin("SG-0011")).stock, 1, "el pantalón vuelve al catálogo");
  const carrito = await pagina.evaluate(() => JSON.parse(localStorage.getItem("ropero_carrito") || "[]"));
  assert.deepEqual(carrito, [{ id: "SG-0013", cant: 1 }], "la compra directa no toca el carrito");

  // …y no vuelve a avisarse al salir de la tienda y regresar
  await pagina.getByRole("button", { name: "Volver al catálogo", exact: true }).click();
  await pagina.goto(e.url + "/pauta.html");
  await pagina.goBack();
  await pagina.locator("#grillaPrendas article.prenda").first().waitFor();
  await pagina.waitForLoadState("networkidle");
  const aviso = (await pagina.locator("#avisoFlotante").count()) ? await pagina.locator("#avisoFlotante").innerText() : "";
  assert.ok(!aviso.includes("no se completó"), `no debe repetirse el aviso: "${aviso}"`);
  assert.equal(await pagina.evaluate(() => sessionStorage.getItem("ropero_pago_en_curso")), null);
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

test("panel: precio con punto de miles, edición con datos viejos, Ocultar/Publicar sin revivir stock y foto que no subió", OPC, async () => {
  const { pagina, errores } = await nuevaPagina();
  await entrarAlPanel(pagina);
  await pagina.locator('.pestanas button[data-p="nueva"]').click();
  const codigo = await pagina.inputValue("#fCodigo");
  assert.match(codigo, /^SG-\d{4}$/);

  await pagina.fill("#fNombre", "Polerón azul de deportes");
  await pagina.selectOption("#fTipo", "Buzo");
  await pagina.fill("#fStock", "2");

  // Precio vacío: no se guarda como $0
  await pagina.fill("#fPrecio", "");
  await pagina.click("#btnGuardar");
  await esperarAvisoPanel(pagina, "Escribe el precio");
  assert.equal(await prendaAdmin(codigo), undefined, "sin precio no se crea la prenda");

  // "4.000" (como se escribe en Chile) se guarda como $4.000, no como $4
  await pagina.fill("#fPrecio", "4.000");
  await pagina.click("#btnGuardar");
  const creada = await esperarQue(() => prendaAdmin(codigo), "que se cree la prenda");
  assert.equal(creada.precio, 4000);
  assert.equal(creada.stock, 2);

  // Abre "Editar" y, mientras tanto, otra familia compra una unidad
  const fila = pagina.locator("#tablaPrendas tr", { hasText: codigo });
  await fila.getByRole("button", { name: "Editar" }).click();
  await pagina.locator("#tituloFormulario", { hasText: "Editar " + codigo }).waitFor();
  assert.equal(await pagina.inputValue("#fStock"), "2");
  assert.equal(await pagina.inputValue("#fPrecio"), "4000");
  await venderPorApi(codigo);
  await pagina.fill("#fPrecio", "3500");
  await pagina.click("#btnGuardar");
  await esperarAvisoPanel(pagina, "cambió mientras la editabas");
  let prenda = await prendaAdmin(codigo);
  assert.equal(prenda.stock, 1, "guardar con datos viejos no pisa el stock");
  assert.equal(prenda.precio, 4000);

  // La lista quedó al día (stock 1). Se vende la última unidad con la lista abierta…
  await esperarQue(async () => (await fila.locator("td").nth(7).innerText()).trim() === "1", "la lista recargada");
  await venderPorApi(codigo);
  assert.equal((await prendaAdmin(codigo)).stock, 0);

  // …y Ocultar/Publicar desde esa lista vieja no la devuelve al catálogo
  await fila.getByRole("button", { name: "Ocultar" }).click();
  await esperarQue(async () => (await prendaAdmin(codigo)).publicado === false, "que la prenda quede oculta");
  await fila.getByRole("button", { name: "Publicar" }).click();
  await esperarQue(async () => (await prendaAdmin(codigo)).publicado === true, "que la prenda quede publicada");
  prenda = await prendaAdmin(codigo);
  assert.equal(prenda.stock, 0, "la prenda vendida sigue sin stock");
  const catalogo = await e.api("/api/productos");
  const enTienda = catalogo.datos.productos.find(p => p.id === codigo);
  assert.ok(!enTienda || enTienda.stock === 0, "la tienda no la ofrece de nuevo");

  // Los pagos hechos con la tarjeta de prueba se marcan en la lista de pedidos
  await pagina.locator('.pestanas button[data-p="pedidos"]').click();
  await pagina.locator("#tablaPedidos tr", { hasText: codigo }).first()
    .locator(".pastilla", { hasText: "Pago de prueba" }).waitFor();

  // Prenda nueva con foto y se corta la red justo después de crearla (falla la foto y
  // también recargar la lista): el formulario queda editándola para reintentar solo la foto
  await pagina.locator('.pestanas button[data-p="nueva"]').click();
  const codigo2 = await pagina.inputValue("#fCodigo");
  assert.match(codigo2, /^SG-\d{4}$/);
  assert.notEqual(codigo2, codigo);
  await pagina.fill("#fNombre", "Falda gris plisada");
  await pagina.selectOption("#fTipo", "Falda");
  await pagina.fill("#fPrecio", "6000");
  await pagina.fill("#fStock", "1");
  await pagina.setInputFiles("#fArchivo", { name: "falda.png", mimeType: "image/png", buffer: crearPng(300, 200) });
  await pagina.locator("#vistaPrevia img").waitFor();

  const sinRed = u => u.pathname === "/api/admin/productos" || /^\/api\/admin\/productos\/[^/]+\/imagen$/.test(u.pathname);
  const cortar = ruta => (ruta.request().method() === "POST" ? ruta.continue() : ruta.abort());
  await pagina.route(sinRed, cortar);
  await pagina.click("#btnGuardar");
  await esperarAvisoPanel(pagina, "la foto no se pudo subir");
  await pagina.locator("#tituloFormulario", { hasText: "Editar " + codigo2 }).waitFor();
  assert.equal(await pagina.locator("#btnGuardar").innerText(), "Guardar cambios");
  assert.equal(await pagina.locator("#fCodigo").evaluate(el => el.readOnly), true);
  assert.equal((await prendaAdmin(codigo2)).imagen, "", "la prenda quedó guardada, todavía sin foto");
  await pagina.unroute(sinRed, cortar);

  // Vuelve la red: "Guardar cambios" sube la foto, sin intentar crear la prenda otra vez
  await pagina.click("#btnGuardar");
  await esperarAvisoPanel(pagina, "Prenda actualizada");
  const falda = await prendaAdmin(codigo2);
  assert.ok(falda.imagen.startsWith(`/api/imagenes/${codigo2}`), falda.imagen);
  assert.equal(falda.precio, 6000);
  sinErroresSalvo(errores, "status of 409", "net::ERR_FAILED");
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

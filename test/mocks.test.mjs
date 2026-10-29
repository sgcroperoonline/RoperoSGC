/* ================================================================
   AUTOTEST DE LOS MOCKS (no necesita el servidor)
   Correr con:  node --test test/mocks.test.mjs
   Sirve para confiar en los mocks antes de culpar al servidor.
   ================================================================ */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { iniciarMockWebpay, CODIGO_COMERCIO_INTEGRACION, LLAVE_INTEGRACION } from "./mocks/webpay.mjs";
import { iniciarMockSmtp } from "./mocks/smtp.mjs";
import { leerFormulario } from "./helpers/entorno.mjs";

const BASE = "/rswebpaytransaction/api/webpay/v1.2/transactions";
const HEADERS = {
  "Tbk-Api-Key-Id": CODIGO_COMERCIO_INTEGRACION,
  "Tbk-Api-Key-Secret": LLAVE_INTEGRACION,
  "Content-Type": "application/json"
};

let webpay, smtp;

before(async () => {
  webpay = await iniciarMockWebpay();
  smtp = await iniciarMockSmtp();
});

after(async () => {
  await webpay?.cerrar();
  await smtp?.cerrar();
});

/* ---------- Webpay ---------- */

async function api(metodo, ruta, cuerpo, headers = HEADERS) {
  const res = await fetch(webpay.url + BASE + ruta, {
    method: metodo,
    headers,
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo)
  });
  return { status: res.status, datos: await res.json() };
}

async function crear(monto = 8000, orden = "RSG-2026-1001") {
  const r = await api("POST", "", {
    buy_order: orden, session_id: "a".repeat(32), amount: monto, return_url: "http://127.0.0.1:9/api/webpay/retorno"
  });
  assert.equal(r.status, 200, JSON.stringify(r.datos));
  return r.datos;
}

// Simula al navegador: abre la página y aprieta un botón. Devuelve el formulario de vuelta al comercio
async function apretar(token, accion) {
  const pagina = await fetch(webpay.url + "/webpayserver/initTransaction", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token_ws: token })
  });
  const html = await pagina.text();
  for (const boton of ["Pagar", "Rechazar", "Anular compra", "Expirar"]) assert.ok(html.includes(`>${boton}</button>`), boton);
  const vuelta = await fetch(webpay.url + "/webpayserver/accion", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token_ws: token, accion })
  });
  return leerFormulario(await vuelta.text());
}

test("webpay: exige las credenciales de integración", async () => {
  const sinClave = await api("POST", "", { buy_order: "X", session_id: "s", amount: 1, return_url: "http://x/y" },
    { "Tbk-Api-Key-Id": CODIGO_COMERCIO_INTEGRACION, "Tbk-Api-Key-Secret": "otra", "Content-Type": "application/json" });
  assert.equal(sinClave.status, 401);
  assert.equal(sinClave.datos.error_message, "Not Authorized");
  const ultima = webpay.llamadas.at(-1);
  assert.equal(ultima.autorizado, false);
  assert.equal(ultima.apiKeySecret, "otra");
});

test("webpay: valida el cuerpo al crear", async () => {
  const r = await api("POST", "", { buy_order: "X".repeat(27), session_id: "s", amount: 10.5, return_url: "nada" });
  assert.equal(r.status, 422);
  assert.match(r.datos.error_message, /buy_order/);
});

test("webpay: pago aprobado (crear, pagar, commit, estado, reembolso)", async () => {
  const { token, url } = await crear(8000);
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(url, webpay.url + "/webpayserver/initTransaction");

  const form = await apretar(token, "pagar");
  assert.equal(form.metodo, "post");
  assert.equal(form.accion, "http://127.0.0.1:9/api/webpay/retorno");
  assert.deepEqual(form.campos, { token_ws: token });

  const commit = await api("PUT", "/" + token);
  assert.equal(commit.status, 200);
  assert.equal(commit.datos.status, "AUTHORIZED");
  assert.equal(commit.datos.response_code, 0);
  assert.equal(commit.datos.amount, 8000);
  assert.equal(commit.datos.buy_order, "RSG-2026-1001");
  assert.equal(commit.datos.authorization_code, "1213");
  assert.equal(commit.datos.card_detail.card_number, "6623");

  const otraVez = await api("PUT", "/" + token);
  assert.equal(otraVez.status, 422, "un segundo commit debe fallar como en Transbank");

  const estado = await api("GET", "/" + token);
  assert.equal(estado.datos.status, "AUTHORIZED");
  assert.equal(estado.datos.balance, 8000);

  const reembolso = await api("POST", `/${token}/refunds`, { amount: 8000 });
  assert.equal(reembolso.status, 200);
  assert.equal(reembolso.datos.type, "NULLIFIED");
  assert.equal(reembolso.datos.response_code, 0);
  assert.equal(reembolso.datos.balance, 0);

  const deNuevo = await api("POST", `/${token}/refunds`, { amount: 8000 });
  assert.equal(deNuevo.status, 422);

  assert.equal(webpay.llamadasDe("confirmar", token).length, 2);
  const llamadas = await (await fetch(webpay.url + "/__llamadas")).json();
  assert.ok(llamadas.some(l => l.operacion === "reembolsar" && l.token === token && l.cuerpo.amount === 8000));
});

test("webpay: pago rechazado", async () => {
  const { token } = await crear(5000);
  const form = await apretar(token, "rechazar");
  assert.deepEqual(form.campos, { token_ws: token });
  const commit = await api("PUT", "/" + token);
  assert.equal(commit.status, 200);
  assert.equal(commit.datos.status, "FAILED");
  assert.notEqual(commit.datos.response_code, 0);
});

test("webpay: commit sin que el comprador pague falla", async () => {
  const { token } = await crear(5000);
  const commit = await api("PUT", "/" + token);
  assert.equal(commit.status, 422);
  const estado = await api("GET", "/" + token);
  assert.equal(estado.datos.status, "INITIALIZED");
});

test("webpay: anular y expirar devuelven los campos TBK_*", async () => {
  const a = await crear(4000, "RSG-2026-2001");
  const anulado = await apretar(a.token, "anular");
  assert.equal(anulado.metodo, "post");
  assert.deepEqual(anulado.campos, { TBK_TOKEN: a.token, TBK_ORDEN_COMPRA: "RSG-2026-2001", TBK_ID_SESION: "a".repeat(32) });

  const b = await crear(4000, "RSG-2026-2002");
  const expirado = await apretar(b.token, "expirar");
  assert.equal(expirado.metodo, "get");
  assert.deepEqual(expirado.campos, { TBK_ORDEN_COMPRA: "RSG-2026-2002", TBK_ID_SESION: "a".repeat(32) });
  assert.equal((await api("PUT", "/" + b.token)).status, 422, "no se puede confirmar una compra expirada");
});

test("webpay: fallas programadas por /__control", async () => {
  const control = await fetch(webpay.url + "/__control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accion: "fallar", operacion: "crear", veces: 1, status: 503, mensaje: "caído" })
  });
  assert.equal(control.status, 200);
  const r1 = await api("POST", "", { buy_order: "X", session_id: "s", amount: 1, return_url: "http://x/y" });
  assert.equal(r1.status, 503);
  assert.equal(r1.datos.error_message, "caído");
  const r2 = await api("POST", "", { buy_order: "X", session_id: "s", amount: 1, return_url: "http://x/y" });
  assert.equal(r2.status, 200, "la falla era solo una vez");

  // Falla al reembolsar y luego funciona (para probar "reintentar")
  const { token } = await crear(3000);
  await apretar(token, "pagar");
  await api("PUT", "/" + token);
  webpay.control({ accion: "fallar", operacion: "reembolsar" });
  assert.equal((await api("POST", `/${token}/refunds`, { amount: 3000 })).status, 500);
  webpay.control({ accion: "tipoReembolso", tipo: "REVERSED" });
  const ok = await api("POST", `/${token}/refunds`, { amount: 3000 });
  assert.deepEqual(ok.datos, { type: "REVERSED" });

  // Commit "procesado pero sin respuesta": el estado dice AUTHORIZED
  const c = await crear(2000);
  await apretar(c.token, "pagar");
  webpay.control({ accion: "fallar", operacion: "confirmar", procesar: true });
  assert.equal((await api("PUT", "/" + c.token)).status, 500);
  assert.equal((await api("GET", "/" + c.token)).datos.status, "AUTHORIZED");

  webpay.control({ accion: "reiniciar" });
  assert.equal(webpay.llamadas.length, 0);
});

/* ---------- SMTP ---------- */

// Cliente SMTP mínimo: manda comandos uno a uno y devuelve las respuestas
function clienteSmtp(puerto) {
  const socket = net.connect(puerto, "127.0.0.1");
  socket.setEncoding("utf8");
  let buffer = "";
  const esperando = [];
  socket.on("data", d => {
    buffer += d;
    // Una respuesta termina en una línea "NNN texto" (sin guion)
    for (;;) {
      const lineas = buffer.split("\r\n");
      const fin = lineas.findIndex((l, i) => i < lineas.length - 1 && /^\d{3}( |$)/.test(l));
      if (fin === -1 || !esperando.length) return;
      const respuesta = lineas.slice(0, fin + 1).join("\r\n");
      buffer = lineas.slice(fin + 1).join("\r\n");
      esperando.shift()(respuesta);
    }
  });
  const leer = () => new Promise(r => esperando.push(r));
  return {
    saludo: leer(),
    async enviar(texto) {
      const p = leer();
      socket.write(texto);
      return p;
    },
    cerrar: () => socket.destroy()
  };
}

test("smtp: AUTH PLAIN + correo con asunto codificado y cuerpo quoted-printable", async () => {
  smtp.limpiar();
  const c = clienteSmtp(smtp.puerto);
  assert.match(await c.saludo, /^220 /);
  const ehlo = await c.enviar("EHLO [127.0.0.1]\r\n");
  assert.match(ehlo, /^250-/);
  assert.match(ehlo, /250-AUTH PLAIN LOGIN/);
  const credenciales = Buffer.from("\0envios@ropero.test\0secreta").toString("base64");
  assert.match(await c.enviar(`AUTH PLAIN ${credenciales}\r\n`), /^235/);
  assert.match(await c.enviar("MAIL FROM: <tienda@ropero.test>\r\n"), /^250/);
  assert.match(await c.enviar("RCPT TO: <comprador@ejemplo.cl>\r\n"), /^250/);
  assert.match(await c.enviar("DATA\r\n"), /^354/);

  // Así arma worker-mailer el correo: multipart, quoted-printable y asunto con =?UTF-8?Q?…?=
  const correo = [
    "MIME-Version: 1.0",
    "From: \"Ropero SG\" <tienda@ropero.test>",
    "To: comprador@ejemplo.cl",
    "Subject: =?UTF-8?Q?Ropero_SG_=C2=B7_Pedido_RSG-2026-1001_confirmado?=",
    "Content-Type: multipart/mixed; boundary=\"mixed_1\"",
    "",
    "--mixed_1",
    "Content-Type: multipart/alternative; boundary=\"alternative_1\"",
    "",
    "--alternative_1",
    "Content-Type: text/plain; charset=\"UTF-8\"",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Tu pedido RSG-2026-1001 qued=C3=B3 pagado. Una l=C3=ADnea muy larga que se c=",
    "orta con un salto suave.",
    "..empieza con punto",
    "",
    "--alternative_1",
    "Content-Type: text/html; charset=\"UTF-8\"",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("<p>Código de autorización 1213</p>").toString("base64"),
    "",
    "--alternative_1--",
    "--mixed_1--",
    "",
    "."
  ].join("\r\n") + "\r\n";
  assert.match(await c.enviar(correo), /^250/);
  assert.match(await c.enviar("QUIT\r\n"), /^221/);
  c.cerrar();

  const [m] = await smtp.esperarCorreos(m => m.cuerpo.includes("RSG-2026-1001"), 1, 2000);
  assert.equal(m.from, "tienda@ropero.test");
  assert.deepEqual(m.to, ["comprador@ejemplo.cl"]);
  assert.equal(m.asunto, "Ropero SG · Pedido RSG-2026-1001 confirmado");
  assert.deepEqual(m.auth, { metodo: "PLAIN", usuario: "envios@ropero.test", clave: "secreta" });
  assert.ok(m.texto.includes("quedó pagado"));
  assert.ok(m.texto.includes("se corta con un salto suave"));
  assert.ok(m.texto.includes("\n.empieza con punto"), "deshace el dot-stuffing");
  assert.equal(m.html, "<p>Código de autorización 1213</p>");
  assert.match(m.deEncabezado, /Ropero SG/);
});

test("smtp: AUTH LOGIN, RSET, NOOP y dos correos en la misma conexión", async () => {
  smtp.limpiar();
  const c = clienteSmtp(smtp.puerto);
  await c.saludo;
  await c.enviar("EHLO prueba\r\n");
  assert.match(await c.enviar("AUTH LOGIN\r\n"), /^334 /);
  assert.match(await c.enviar(Buffer.from("usuario").toString("base64") + "\r\n"), /^334 /);
  assert.match(await c.enviar(Buffer.from("clave").toString("base64") + "\r\n"), /^235/);
  assert.match(await c.enviar("NOOP\r\n"), /^250/);
  await c.enviar("MAIL FROM: <a@b.cl>\r\n");
  assert.match(await c.enviar("RSET\r\n"), /^250/);
  for (const n of [1, 2]) {
    await c.enviar("MAIL FROM: <a@b.cl>\r\n");
    await c.enviar(`RCPT TO: <destino${n}@b.cl>\r\n`);
    await c.enviar("DATA\r\n");
    assert.match(await c.enviar(`Subject: Hola ${n}\r\n\r\nCuerpo ${n}\r\n.\r\n`), /^250/);
  }
  await c.enviar("QUIT\r\n");
  c.cerrar();

  const recibidos = await smtp.esperarCorreos(() => true, 2, 2000);
  assert.deepEqual(recibidos.map(m => m.asunto), ["Hola 1", "Hola 2"]);
  assert.deepEqual(recibidos.map(m => m.to[0]), ["destino1@b.cl", "destino2@b.cl"]);
  assert.equal(recibidos[0].cuerpo, "Cuerpo 1");
  assert.deepEqual(recibidos[0].auth, { metodo: "LOGIN", usuario: "usuario", clave: "clave" });
});

test("smtp: esperarCorreos falla con un mensaje claro si no llega nada", async () => {
  await assert.rejects(smtp.esperarCorreos(m => m.asunto === "no existe", 1, 100), /No llegaron 1 correo/);
});

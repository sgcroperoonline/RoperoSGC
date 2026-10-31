/* ================================================================
   MOCK DE SERVIDOR DE CORREO (SMTP) PARA LOS TESTS
   ----------------------------------------------------------------
   Habla lo justo de SMTP para que worker-mailer pueda mandar correos
   sin cifrado (SMTP_SEGURIDAD=ninguna):
     220 saludo · EHLO (varias líneas, ofrece AUTH PLAIN LOGIN)
     AUTH PLAIN / AUTH LOGIN · MAIL FROM · RCPT TO · DATA · RSET · NOOP · QUIT

   Cada correo recibido queda en `mensajes` con from, to, asunto y
   cuerpo ya decodificados (quoted-printable / base64), para que los
   tests puedan buscar, por ejemplo, el número de pedido.
   ================================================================ */

import net from "node:net";
import { EventEmitter } from "node:events";

/** Levanta el mock en un puerto libre. Devuelve { host, puerto, mensajes, esperarCorreos(), limpiar(), cerrar() } */
export async function iniciarMockSmtp() {
  const mensajes = [];
  const avisos = new EventEmitter();   // avisa cuando llega un correo (para no esperar con sleeps)
  const conexiones = new Set();

  const servidor = net.createServer(socket => {
    conexiones.add(socket);
    socket.on("close", () => conexiones.delete(socket));
    socket.on("error", () => {});       // un cliente que corta de golpe no debe botar el mock
    atenderConexion(socket, mensaje => {
      mensajes.push(mensaje);
      avisos.emit("mensaje", mensaje);
    });
  });

  await new Promise((resolver, rechazar) => {
    servidor.once("error", rechazar);
    servidor.listen(0, "127.0.0.1", resolver);
  });

  return {
    host: "127.0.0.1",
    puerto: servidor.address().port,
    mensajes,

    /**
     * Espera (sin sleeps fijos) hasta que haya al menos `cantidad` correos que cumplan `filtro`.
     * Devuelve esos correos. Si no llegan a tiempo, falla con la lista de lo que sí llegó.
     */
    esperarCorreos(filtro = () => true, cantidad = 1, msMaximo = 15000) {
      return new Promise((resolver, rechazar) => {
        const revisar = () => {
          const encontrados = mensajes.filter(filtro);
          if (encontrados.length >= cantidad) {
            terminar();
            resolver(encontrados);
          }
        };
        const temporizador = setTimeout(() => {
          terminar();
          const recibidos = mensajes.map(m => `  - para ${m.to.join(", ")}: ${m.asunto}`).join("\n") || "  (ninguno)";
          rechazar(new Error(`No llegaron ${cantidad} correo(s) esperados en ${msMaximo} ms. Recibidos:\n${recibidos}`));
        }, msMaximo);
        const terminar = () => {
          clearTimeout(temporizador);
          avisos.off("mensaje", revisar);
        };
        avisos.on("mensaje", revisar);
        revisar();
      });
    },

    limpiar() {
      mensajes.length = 0;
    },

    cerrar() {
      return new Promise(resolver => {
        for (const s of conexiones) s.destroy();
        servidor.close(() => resolver());
      });
    }
  };
}

/* ---------- Conversación SMTP de una conexión ---------- */

function atenderConexion(socket, alGuardar) {
  let buffer = "";
  let modo = "comando";              // comando | authPlain | authLoginUsuario | authLoginClave | datos
  let auth = null;                   // { metodo, usuario, clave }
  let usuarioLogin = "";
  let sobre = { from: null, to: [] };  // remitente y destinatarios del correo en curso

  const responder = texto => socket.write(texto + "\r\n");

  socket.setEncoding("latin1");      // byte a byte: el cuerpo se decodifica después como UTF-8
  responder("220 mock-smtp.local ESMTP listo para los tests");

  socket.on("data", trozo => {
    buffer += trozo;
    procesar();
  });

  function procesar() {
    for (;;) {
      if (modo === "datos") {
        // El cuerpo termina con una línea que tiene solo un punto: "\r\n.\r\n"
        const conSalto = "\r\n" + buffer;
        const fin = conSalto.indexOf("\r\n.\r\n");
        if (fin === -1) return;
        const crudo = conSalto.slice(2, fin + 2);   // incluye el último "\r\n" del cuerpo
        buffer = conSalto.slice(fin + 5);
        modo = "comando";
        alGuardar(armarMensaje(sobre, auth, crudo));
        sobre = { from: null, to: [] };
        responder("250 2.0.0 OK: correo guardado");
        continue;
      }

      const salto = buffer.indexOf("\r\n");
      if (salto === -1) return;
      const linea = buffer.slice(0, salto);
      buffer = buffer.slice(salto + 2);
      atenderLinea(linea);
      if (socket.destroyed) return;
    }
  }

  function atenderLinea(linea) {
    if (modo === "authPlain") {
      auth = decodificarPlain(linea);
      modo = "comando";
      return responder("235 2.7.0 Autenticado");
    }
    if (modo === "authLoginUsuario") {
      usuarioLogin = desdeBase64(linea);
      modo = "authLoginClave";
      return responder("334 UGFzc3dvcmQ6");          // "Password:" en base64
    }
    if (modo === "authLoginClave") {
      auth = { metodo: "LOGIN", usuario: usuarioLogin, clave: desdeBase64(linea) };
      modo = "comando";
      return responder("235 2.7.0 Autenticado");
    }

    const comando = linea.split(" ")[0].toUpperCase();
    const resto = linea.slice(comando.length).trim();

    switch (comando) {
      case "EHLO":
        // Varias líneas: "250-" en todas menos la última, que va con "250 "
        return socket.write("250-mock-smtp.local saluda\r\n250-AUTH PLAIN LOGIN\r\n250-8BITMIME\r\n250 SIZE 10485760\r\n");
      case "HELO":
        return responder("250 mock-smtp.local");
      case "AUTH": {
        const [metodo, inicial] = resto.split(" ");
        if (/^PLAIN$/i.test(metodo)) {
          if (inicial) {
            auth = decodificarPlain(inicial);
            return responder("235 2.7.0 Autenticado");
          }
          modo = "authPlain";
          return responder("334 ");
        }
        if (/^LOGIN$/i.test(metodo)) {
          if (inicial) {
            usuarioLogin = desdeBase64(inicial);
            modo = "authLoginClave";
            return responder("334 UGFzc3dvcmQ6");
          }
          modo = "authLoginUsuario";
          return responder("334 VXNlcm5hbWU6");        // "Username:" en base64
        }
        return responder("504 5.5.4 Método de autenticación no soportado");
      }
      case "MAIL":
        sobre = { from: extraerDireccion(resto), to: [] };
        return responder("250 2.1.0 OK");
      case "RCPT":
        sobre.to.push(extraerDireccion(resto));
        return responder("250 2.1.5 OK");
      case "DATA":
        if (!sobre.to.length) return responder("503 5.5.1 Falta RCPT TO");
        modo = "datos";
        return responder("354 Termina con <CRLF>.<CRLF>");
      case "RSET":
        sobre = { from: null, to: [] };
        return responder("250 2.0.0 OK");
      case "NOOP":
        return responder("250 2.0.0 OK");
      case "QUIT":
        responder("221 2.0.0 Chao");
        return socket.end();
      default:
        return responder("502 5.5.2 Comando no reconocido");
    }
  }
}

/* ---------- Armar y decodificar el correo ---------- */

function armarMensaje(sobre, auth, crudoLatin1) {
  // Deshace el "dot-stuffing": las líneas que empiezan con ".." en realidad empiezan con "."
  const crudo = crudoLatin1.split("\r\n").map(l => (l.startsWith("..") ? l.slice(1) : l)).join("\r\n");
  const { encabezados, cuerpo } = separarEncabezados(crudo);
  const partes = [];
  recolectarPartes(encabezados, cuerpo, partes);

  const texto = partes.filter(p => p.tipo === "text/plain").map(p => p.contenido).join("\n");
  const html = partes.filter(p => p.tipo === "text/html").map(p => p.contenido).join("\n");

  return {
    from: sobre.from,
    to: [...sobre.to],
    auth,
    asunto: decodificarEncabezado(encabezados["subject"] || ""),
    deEncabezado: decodificarEncabezado(encabezados["from"] || ""),
    paraEncabezado: decodificarEncabezado(encabezados["to"] || ""),
    texto,
    html,
    cuerpo: [texto, html].filter(Boolean).join("\n"),   // todo junto, para buscar fácil
    encabezados,
    crudo: Buffer.from(crudo, "latin1").toString("utf8"),
    recibidoEn: new Date().toISOString()
  };
}

// Separa encabezados (en minúsculas, ya "desdoblados") del cuerpo
function separarEncabezados(texto) {
  const corte = texto.indexOf("\r\n\r\n");
  const cabecera = corte === -1 ? texto : texto.slice(0, corte);
  const cuerpo = corte === -1 ? "" : texto.slice(corte + 4);
  const encabezados = {};
  // Una línea que empieza con espacio o tab continúa el encabezado anterior
  for (const linea of cabecera.replace(/\r\n[ \t]+/g, " ").split("\r\n")) {
    const dosPuntos = linea.indexOf(":");
    if (dosPuntos > 0) encabezados[linea.slice(0, dosPuntos).trim().toLowerCase()] = linea.slice(dosPuntos + 1).trim();
  }
  return { encabezados, cuerpo };
}

// Recorre el MIME (multipart dentro de multipart) y junta las partes de texto decodificadas
function recolectarPartes(encabezados, cuerpo, partes) {
  const tipoCompleto = encabezados["content-type"] || "text/plain";
  const tipo = tipoCompleto.split(";")[0].trim().toLowerCase();

  if (tipo.startsWith("multipart/")) {
    const limite = (tipoCompleto.match(/boundary="?([^";]+)"?/i) || [])[1];
    if (!limite) return;
    const trozos = cuerpo.split("--" + limite);
    // El primer trozo es el preámbulo y el que empieza con "--" es el cierre
    for (const trozo of trozos.slice(1)) {
      if (trozo.startsWith("--")) break;
      const sub = separarEncabezados(trozo.replace(/^\r\n/, ""));
      recolectarPartes(sub.encabezados, sub.cuerpo, partes);
    }
    return;
  }

  const codificacion = (encabezados["content-transfer-encoding"] || "7bit").toLowerCase();
  let bytes;
  if (codificacion === "quoted-printable") bytes = desdeQuotedPrintable(cuerpo);
  else if (codificacion === "base64") bytes = Buffer.from(cuerpo.replace(/\s+/g, ""), "base64");
  else bytes = Buffer.from(cuerpo, "latin1");
  partes.push({ tipo, contenido: bytes.toString("utf8").replace(/\r\n/g, "\n").trimEnd() });
}

// "Hola=20mundo=\r\n..." -> bytes. "=" al final de línea es un salto suave (se borra)
function desdeQuotedPrintable(texto) {
  const sinSaltosSuaves = texto.replace(/=\r?\n/g, "");
  const bytes = [];
  for (let i = 0; i < sinSaltosSuaves.length; i++) {
    const c = sinSaltosSuaves[i];
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(sinSaltosSuaves.slice(i + 1, i + 3))) {
      bytes.push(parseInt(sinSaltosSuaves.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(sinSaltosSuaves.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

// Encabezados con tildes vienen como "=?UTF-8?Q?Ropero_SG_=C2=B7_Pedido?=" o "=?UTF-8?B?...?="
function decodificarEncabezado(valor) {
  // El socket se lee byte a byte (latin1): si vino UTF-8 "en crudo", lo recuperamos primero
  const texto = Buffer.from(valor, "latin1").toString("utf8")
    .replace(/\?=\s+=\?/g, "?==?");   // palabras codificadas seguidas van pegadas
  return texto.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (_, _juego, tipo, datos) => {
    if (tipo.toUpperCase() === "B") return Buffer.from(datos, "base64").toString("utf8");
    return desdeQuotedPrintable(datos.replace(/_/g, " ")).toString("utf8");
  });
}

function decodificarPlain(base64) {
  // Formato: "\0usuario\0clave" (puede traer una identidad antes del primer \0)
  const [, usuario = "", clave = ""] = desdeBase64(base64).split("\0");
  return { metodo: "PLAIN", usuario, clave };
}

function desdeBase64(texto) {
  return Buffer.from(texto.trim(), "base64").toString("utf8");
}

// "FROM: <tienda@ropero.test> RET=HDRS" -> "tienda@ropero.test"
function extraerDireccion(texto) {
  const m = texto.match(/<([^>]*)>/);
  if (m) return m[1];
  return texto.replace(/^(FROM|TO)\s*:/i, "").trim().split(/\s+/)[0] || "";
}

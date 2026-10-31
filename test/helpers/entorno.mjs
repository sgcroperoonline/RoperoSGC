/* ================================================================
   ENTORNO DE PRUEBA
   ----------------------------------------------------------------
   Levanta todo lo que necesitan los tests, aislado del resto:
     1. mock de Webpay y mock de correo (SMTP) en puertos libres
     2. una base D1 nueva en test/.tmp/<id> (migraciones + semilla)
     3. `wrangler dev` apuntando a esos mocks y a esa base
   y al final apaga todo y borra la base, aunque algún test falle.
   ================================================================ */

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { iniciarMockWebpay } from "../mocks/webpay.mjs";
import { iniciarMockSmtp } from "../mocks/smtp.mjs";

export const RAIZ = fileURLToPath(new URL("../../", import.meta.url));
// Es lo mismo que `npx wrangler`, pero sin pasar por npx (más rápido y sin ir a internet)
const WRANGLER = path.join(RAIZ, "node_modules", "wrangler", "bin", "wrangler.js");

// Datos fijos de prueba (ninguno es real)
export const CLAVE_ADMIN = "clave-de-prueba";
export const SMTP_USUARIO = "envios@ropero.test";
export const SMTP_CLAVE = "clave-smtp-de-prueba";
export const SMTP_REMITENTE = "tienda@ropero.test";
export const CORREO_AVISOS = "avisos@ropero.test";

const MS_ESPERA_SERVIDOR = 90_000;   // la primera vez wrangler puede demorar en compilar

/** Pide al sistema un puerto TCP libre */
export function puertoLibre() {
  return new Promise((resolver, rechazar) => {
    const s = net.createServer();
    s.once("error", rechazar);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolver(port));
    });
  });
}

function variablesDeProceso() {
  return { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" };
}

/** Corre un comando de wrangler y espera a que termine. Devuelve { stdout, stderr } */
export function correrWrangler(argumentos, msMaximo = 120_000) {
  return new Promise((resolver, rechazar) => {
    const hijo = spawn(process.execPath, [WRANGLER, ...argumentos], {
      cwd: RAIZ,
      env: variablesDeProceso(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "", stderr = "";
    hijo.stdout.on("data", d => (stdout += d));
    hijo.stderr.on("data", d => (stderr += d));
    const temporizador = setTimeout(() => {
      hijo.kill("SIGKILL");
      rechazar(new Error(`wrangler ${argumentos.join(" ")} no terminó en ${msMaximo} ms`));
    }, msMaximo);
    hijo.on("error", error => {
      clearTimeout(temporizador);
      rechazar(error);
    });
    hijo.on("close", codigo => {
      clearTimeout(temporizador);
      if (codigo === 0) resolver({ stdout, stderr });
      else rechazar(new Error(`wrangler ${argumentos.join(" ")} falló (código ${codigo}):\n${stdout}\n${stderr}`));
    });
  });
}

/**
 * Levanta mocks + D1 temporal + wrangler dev.
 * `variables` permite cambiar alguna variable (por ejemplo MINUTOS_EXPIRA_WEBPAY).
 */
export async function levantarEntorno({ variables = {} } = {}) {
  const id = `${Date.now()}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const carpetaTmp = path.join(RAIZ, "test", ".tmp");
  const carpeta = path.join(carpetaTmp, id);
  let hijo = null;
  let registro = "";            // lo que imprime wrangler dev (sirve para entender un test que falla)
  let huboFallas = false;
  let cerrado = false;

  const matarHijo = senal => {
    if (!hijo || hijo.exitCode !== null) return;
    // detached: true deja a wrangler y a workerd en su propio grupo; "-pid" los mata a todos
    try { process.kill(-hijo.pid, senal); } catch { try { hijo.kill(senal); } catch {} }
  };
  // Si el proceso de tests muere de golpe, que no quede wrangler corriendo
  const alSalir = () => matarHijo("SIGKILL");
  process.on("exit", alSalir);

  const entorno = {
    url: "",
    carpeta,
    webpay: null,
    smtp: null,
    variables: {},

    /** Llamada a la API del servidor. Devuelve { status, headers, datos, texto } */
    async api(ruta, { metodo = "GET", cuerpo, token, headers = {}, crudo } = {}) {
      const h = { ...headers };
      if (token) h.Authorization = "Bearer " + token;
      let body;
      if (crudo !== undefined) body = crudo;
      else if (cuerpo !== undefined) {
        body = JSON.stringify(cuerpo);
        h["Content-Type"] = "application/json";
      }
      const res = await fetch(entorno.url + ruta, { method: metodo, headers: h, body, redirect: "manual" });
      const texto = await res.text();
      let datos = null;
      try { datos = JSON.parse(texto); } catch {}
      return { status: res.status, headers: res.headers, datos, texto };
    },

    /** Entra al panel con la clave de prueba y devuelve el token */
    async ingresarAdmin() {
      const r = await entorno.api("/api/admin/ingresar", { metodo: "POST", cuerpo: { clave: CLAVE_ADMIN } });
      if (r.status !== 200 || !r.datos?.token) throw new Error(`No se pudo ingresar al panel: ${r.status} ${r.texto}`);
      return r.datos.token;
    },

    /**
     * Hace lo que haría el navegador en la página de Webpay: abre el formulario,
     * aprieta un botón (pagar | rechazar | anular | expirar) y vuelve a la tienda
     * con el formulario que arma Transbank. Devuelve lo mismo que enviarRetorno().
     */
    async pasarPorWebpay(webpay, accion) {
      const inicio = await fetch(webpay.url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token_ws: webpay.token })
      });
      if (inicio.status !== 200) throw new Error(`La página de Webpay respondió ${inicio.status}`);
      const pagina = await fetch(new URL("/webpayserver/accion", webpay.url), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token_ws: webpay.token, accion })
      });
      const formulario = leerFormulario(await pagina.text());
      return entorno.enviarRetorno(formulario.campos, formulario.metodo, formulario.accion);
    },

    /** Manda campos al retorno de Webpay (como el navegador) sin seguir la redirección */
    async enviarRetorno(campos, metodo = "post", destino = entorno.url + "/api/webpay/retorno") {
      const datos = new URLSearchParams(campos);
      let res;
      if (metodo.toLowerCase() === "get") {
        const url = new URL(destino);
        for (const [k, v] of datos) url.searchParams.append(k, v);
        res = await fetch(url, { redirect: "manual" });
      } else {
        res = await fetch(destino, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: datos,
          redirect: "manual"
        });
      }
      await res.arrayBuffer();
      const location = res.headers.get("location");
      return { status: res.status, location, destino: location ? new URL(location, entorno.url) : null };
    },

    /** Dispara el cron como lo haría Cloudflare cada 10 minutos */
    async ejecutarCron() {
      const res = await fetch(entorno.url + "/__scheduled?cron=*/10+*+*+*+*");
      const texto = await res.text();
      if (!res.ok) throw new Error(`El cron respondió ${res.status}: ${texto}`);
      return texto;
    },

    /** Corre SQL directo en la D1 temporal. Devuelve las filas del primer resultado */
    async sql(comando) {
      const { stdout } = await correrWrangler(["d1", "execute", "DB", "--local", "--persist-to", carpeta, "--command", comando, "--json"]);
      const salida = JSON.parse(stdout.slice(stdout.indexOf("[")));
      return salida[0]?.results ?? [];
    },

    /** Lo que imprimió wrangler dev hasta ahora */
    registro: () => registro,

    /** Los tests avisan cuando algo falla: así al cerrar mostramos el registro de wrangler */
    marcarFalla() { huboFallas = true; },

    async cerrar() {
      if (cerrado) return;
      cerrado = true;
      if (huboFallas && registro) {
        console.error("\n----- Últimas líneas de wrangler dev -----\n" + registro.split("\n").slice(-80).join("\n"));
      }
      if (hijo && hijo.exitCode === null) {
        const termino = new Promise(r => hijo.once("exit", r));
        matarHijo("SIGTERM");
        const aTiempo = await Promise.race([termino.then(() => true), new Promise(r => setTimeout(() => r(false), 5000))]);
        if (!aTiempo) {
          matarHijo("SIGKILL");
          await Promise.race([termino, new Promise(r => setTimeout(r, 2000))]);
        }
      }
      process.off("exit", alSalir);
      await Promise.allSettled([entorno.webpay?.cerrar(), entorno.smtp?.cerrar()]);
      await rm(carpeta, { recursive: true, force: true });
      await rmdir(carpetaTmp).catch(() => {});   // solo se borra si quedó vacía
    }
  };

  try {
    await mkdir(carpeta, { recursive: true });
    entorno.webpay = await iniciarMockWebpay();
    entorno.smtp = await iniciarMockSmtp();

    // Base nueva: esquema + prendas de ejemplo
    await correrWrangler(["d1", "migrations", "apply", "DB", "--local", "--persist-to", carpeta]);
    await correrWrangler(["d1", "execute", "DB", "--local", "--persist-to", carpeta, "--file", "seed/prendas-iniciales.sql"]);

    const puerto = await puertoLibre();
    const puertoInspector = await puertoLibre();
    entorno.url = `http://127.0.0.1:${puerto}`;
    // Webpay en pruebas y sin URL_PUBLICA, pase lo que pase en wrangler.jsonc o .dev.vars
    // (al publicar se cambian ahí, y el mock solo acepta las credenciales de integración).
    entorno.variables = {
      ADMIN_CLAVE: CLAVE_ADMIN,
      WEBPAY_AMBIENTE: "integracion",
      WEBPAY_CODIGO_COMERCIO: "597055555532",
      WEBPAY_API_KEY: "",
      URL_PUBLICA: "",
      WEBPAY_URL_BASE: entorno.webpay.url,
      SMTP_HOST: "127.0.0.1",
      SMTP_PUERTO: String(entorno.smtp.puerto),
      SMTP_SEGURIDAD: "ninguna",
      SMTP_USUARIO,
      SMTP_CLAVE,
      SMTP_REMITENTE,
      CORREO_AVISOS,
      MINUTOS_EXPIRA_WEBPAY: "20",
      ...variables
    };

    const argumentos = [
      WRANGLER, "dev",
      "--ip", "127.0.0.1",
      "--port", String(puerto),
      "--inspector-port", String(puertoInspector),
      "--persist-to", carpeta,
      "--test-scheduled",
      "--show-interactive-dev-session=false"
    ];
    for (const [nombre, valor] of Object.entries(entorno.variables)) argumentos.push("--var", `${nombre}:${valor}`);

    hijo = spawn(process.execPath, argumentos, {
      cwd: RAIZ,
      env: variablesDeProceso(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });
    const guardar = d => {
      registro += d;
      if (registro.length > 400_000) registro = registro.slice(-200_000);
    };
    hijo.stdout.on("data", guardar);
    hijo.stderr.on("data", guardar);

    await esperarServidor(entorno.url, () => hijo.exitCode, () => registro);
    return entorno;
  } catch (error) {
    huboFallas = true;
    await entorno.cerrar();
    throw error;
  }
}

// Espera activa: pregunta /api/config hasta que responda bien (o se acabe el tiempo)
async function esperarServidor(url, codigoSalida, registro) {
  const limite = Date.now() + MS_ESPERA_SERVIDOR;
  let ultimoError = "";
  while (Date.now() < limite) {
    if (codigoSalida() !== null) {
      throw new Error(`wrangler dev se cerró antes de arrancar (código ${codigoSalida()}):\n${registro().slice(-6000)}`);
    }
    try {
      const res = await fetch(url + "/api/config", { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        await res.json();
        return;
      }
      ultimoError = `respondió ${res.status}`;
    } catch (error) {
      ultimoError = error.message;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error(`El servidor no respondió /api/config en ${MS_ESPERA_SERVIDOR / 1000} s (${ultimoError}):\n${registro().slice(-6000)}`);
}

/** Lee el primer <form> de una página: método, destino y campos ocultos */
export function leerFormulario(html) {
  const form = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!form) throw new Error("La página no tiene formulario:\n" + html.slice(0, 500));
  const atributo = (texto, nombre) => {
    const m = texto.match(new RegExp(`\\b${nombre}="([^"]*)"`, "i"));
    return m ? desescapar(m[1]) : "";
  };
  const campos = {};
  for (const input of form[2].matchAll(/<input\b([^>]*)>/gi)) {
    const nombre = atributo(input[1], "name");
    if (nombre) campos[nombre] = atributo(input[1], "value");
  }
  return { metodo: atributo(form[1], "method") || "get", accion: atributo(form[1], "action"), campos };
}

function desescapar(t) {
  return t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

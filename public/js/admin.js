/* ================================================================
   ROPERO SG — Panel de voluntarias
   Uso: apoderadas voluntarias que reciben, revisan y publican prendas,
   y que atienden pedidos y reembolsos.

   Todo se guarda en el servidor (/api/admin/...). Para entrar se pide
   la clave del ropero; el servidor devuelve un "token" (un pase que
   dura 12 horas) que mandamos en cada pedido al servidor.
   ESTADOS y LISTAS vienen de js/datos.js.
   ================================================================ */

const $  = (s, c=document) => c.querySelector(s);
const $$ = (s, c=document) => [...c.querySelectorAll(s)];
const plata = n => "$" + Number(n || 0).toLocaleString("es-CL");
// Todo texto que viene del servidor pasa por escapar() antes de ir al HTML,
// así nadie puede "colar" código en un nombre o un motivo.
const escapar = t => (t ?? "").toString()
  .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
  .replace(/"/g,"&quot;").replace(/'/g,"&#39;");

// Busca una clave en una tabla de textos; si no está, devuelve la clave tal cual
const traducir = (tabla, clave) => Object.hasOwn(tabla, clave) ? tabla[clave] : clave;

function fecha(iso, conHora = true){
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d)) return "";
  return conHora ? d.toLocaleString("es-CL", { dateStyle:"short", timeStyle:"short" })
                 : d.toLocaleDateString("es-CL");
}

let prendas = null;        // null = todavía no se cargan
let pedidos = null;
let reembolsos = null;
let editando = null;       // código de la prenda que se está editando (o null si es nueva)
let versionEditando = "";  // actualizadoEn de esa prenda cuando se abrió: el servidor lo compara al guardar
let codigoSugerido = "";   // último código que propusimos para una prenda nueva
let siguienteCodigo = "";  // el que propone el servidor (nunca repite uno que ya estuvo en un pedido)
let fotoPendiente = null;  // foto ya achicada, esperando que se guarde la prenda

/* ---------- Mensajes flotantes ---------- */
function avisar(texto, esError = false){
  const c = $("#aviso");
  c.textContent = texto;
  c.classList.toggle("error", esError);
  c.style.display = "block";
  clearTimeout(c._t);
  c._t = setTimeout(() => c.style.display = "none", esError ? 7000 : 4000);
}

/* ================================================================
   CONVERSAR CON EL SERVIDOR
   ================================================================ */

const LLAVE_TOKEN = "ropero_admin_token";
let tokenEnMemoria = "";   // respaldo por si el navegador bloquea sessionStorage

function leerToken(){
  try{ return sessionStorage.getItem(LLAVE_TOKEN) || ""; }catch(e){ return tokenEnMemoria; }
}
function guardarToken(t){
  tokenEnMemoria = t;
  try{ sessionStorage.setItem(LLAVE_TOKEN, t); }catch(e){}
}
function borrarToken(){
  tokenEnMemoria = "";
  try{ sessionStorage.removeItem(LLAVE_TOKEN); }catch(e){}
}

// Error especial: la sesión venció y ya mandamos a la voluntaria al ingreso.
// Quien lo reciba no necesita mostrar otro mensaje.
class SesionVencida extends Error {}

// Hace la petición con el token. Si el servidor dice 401, vuelve al ingreso.
async function pedir(ruta, { metodo = "GET", json, binario } = {}){
  const opciones = { method: metodo, headers: { "Authorization": "Bearer " + leerToken() } };
  if (binario){
    opciones.headers["Content-Type"] = binario.type || "image/jpeg";
    opciones.body = binario;
  } else if (json !== undefined){
    opciones.headers["Content-Type"] = "application/json";
    opciones.body = JSON.stringify(json);
  }
  let resp;
  try{ resp = await fetch(ruta, opciones); }
  catch(e){ throw new Error("No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo."); }

  if (resp.status === 401){
    const datos = await leerJson(resp);
    volverAlIngreso(datos.error || "Tu sesión expiró. Vuelve a ingresar.");
    throw new SesionVencida();
  }
  if (!resp.ok){
    const datos = await leerJson(resp);
    const error = new Error(datos.error || `El servidor respondió con un error (${resp.status}). Intenta de nuevo.`);
    error.estado = resp.status;   // por ejemplo 409: la prenda o el pedido cambió
    throw error;
  }
  return resp;
}

// Igual que pedir(), pero devuelve el JSON de la respuesta
async function api(ruta, opciones){
  return leerJson(await pedir(ruta, opciones));
}

async function leerJson(resp){
  try{ return await resp.json(); }catch(e){ return {}; }
}

// Muestra el error, salvo que sea una sesión vencida (eso ya se avisó)
function mostrarError(e){
  if (e instanceof SesionVencida) return;
  avisar(e.message || "Ocurrió un error inesperado. Intenta de nuevo.", true);
}

// Caja de "Cargando…" o de error con botón para reintentar
function htmlCargando(){
  return `<div class="estado-carga">Cargando…</div>`;
}
function htmlErrorCarga(e, funcion){
  if (e instanceof SesionVencida) return "";
  return `<div class="estado-carga">${escapar(e.message)}<br>
    <button class="btn btn-linea btn-chico" onclick="${funcion}()">Reintentar</button></div>`;
}

/* ================================================================
   ACCESO
   ================================================================ */

async function entrar(evento){
  if (evento) evento.preventDefault();   // el formulario no debe recargar la página
  const clave = $("#claveIngreso").value;
  const error = $("#errorClave");
  const boton = $("#btnEntrar");
  if (!clave){ error.textContent = "Escribe la clave."; return; }

  error.textContent = "";
  boton.disabled = true; boton.textContent = "Entrando…";
  try{
    // Aquí no usamos pedir(): un 401 en el ingreso significa "clave incorrecta", no "sesión vencida"
    const resp = await fetch("/api/admin/ingresar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clave })
    });
    const datos = await leerJson(resp);
    if (!resp.ok || !datos.token){
      error.textContent = datos.error || "No pudimos ingresar. Intenta de nuevo.";
      return;
    }
    guardarToken(datos.token);
    $("#claveIngreso").value = "";
    mostrarPanel();
  }catch(e){
    error.textContent = "No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.";
  }finally{
    boton.disabled = false; boton.textContent = "Entrar";
  }
}

function salir(){
  borrarToken();
  volverAlIngreso("");
}

// Esconde el panel, borra lo cargado y muestra el ingreso con un mensaje
function volverAlIngreso(mensaje){
  borrarToken();
  prendas = null; pedidos = null; reembolsos = null;   // que no queden datos a la vista
  $("#panel").classList.add("oculto");
  $("#btnSalir").classList.add("oculto");
  $("#pantallaIngreso").classList.remove("oculto");
  $("#errorClave").textContent = mensaje || "";
  $("#claveIngreso").focus();
}

function mostrarPanel(){
  $("#pantallaIngreso").classList.add("oculto");
  $("#panel").classList.remove("oculto");
  $("#btnSalir").classList.remove("oculto");
  cargarEstado();
  pestana("prendas");
}

// Insignias: en qué modo está Webpay y si se mandan correos
async function cargarEstado(){
  const caja = $("#insignias");
  caja.innerHTML = "";
  try{
    const estado = await api("/api/admin/estado");
    const pruebas = estado.webpay?.ambiente !== "produccion";
    const correo = estado.correo || {};
    caja.innerHTML = `
      <span class="pastilla ${pruebas ? "ambar" : "verde"}"
        ${estado.webpay?.comercio ? `title="Código de comercio: ${escapar(estado.webpay.comercio)}"` : ""}>
        ${pruebas ? "Webpay: modo pruebas" : "Webpay: producción"}</span>
      <span class="pastilla ${correo.activo ? "verde" : "gris"}"
        ${correo.activo && correo.avisosA ? `title="Avisos de pedidos a: ${escapar(correo.avisosA)}"` : ""}>
        ${correo.activo ? "Correos: activos" : "Correos: desactivados"}</span>`;
  }catch(e){
    // Si falla, el panel igual funciona; solo no mostramos las insignias
    if (!(e instanceof SesionVencida)) console.error(e);
  }
}

/* ================================================================
   PESTAÑAS
   ================================================================ */

function pestana(nombre){
  $$(".pestanas button").forEach(b => b.classList.toggle("activa", b.dataset.p === nombre));
  $$(".seccion").forEach(s => s.classList.add("oculto"));
  $("#sec-" + nombre).classList.remove("oculto");
  // Cada vez que se abre una pestaña pedimos datos frescos al servidor
  if (nombre === "prendas")    cargarPrendas();
  if (nombre === "pedidos")    cargarPedidos();
  if (nombre === "reembolsos") cargarReembolsos();
  if (nombre === "exportar")   cargarResumen();
}

/* ================================================================
   PRENDAS
   ================================================================ */

function cargarSelectores(){
  $("#fTipo").innerHTML   = LISTAS.tipos.map(t => `<option>${escapar(t)}</option>`).join("");
  $("#fMarca").innerHTML  = LISTAS.marcas.map(m => `<option>${escapar(m)}</option>`).join("");
  $("#fTalla").innerHTML  = LISTAS.tallas.map(t => `<option>${escapar(t)}</option>`).join("");
  $("#fEstado").innerHTML = Object.entries(ESTADOS)
    .map(([k,v]) => `<option value="${escapar(k)}">${escapar(v.etiqueta)} — ${escapar(v.resumen)}</option>`).join("");
}

// Color y nombre del estado. Si el servidor trae una clave rara, usamos un gris.
function estadoDe(clave){
  return Object.hasOwn(ESTADOS, clave) ? ESTADOS[clave] : { etiqueta: clave, color: "#999999" };
}

function fotoDe(p){
  if (p.imagen && p.imagen.trim()) return p.imagen;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <rect width="100" height="100" fill="#EDF1F9"/>
    <rect x="24" y="24" width="52" height="52" rx="7" fill="#C9D6EE"/></svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

// Trae las prendas y el código sugerido. Si falla, lanza el error.
async function leerPrendas(){
  const datos = await api("/api/admin/productos");
  prendas = datos.productos || [];
  siguienteCodigo = typeof datos.siguienteCodigo === "string" ? datos.siguienteCodigo : "";
}

async function cargarPrendas(){
  if (!prendas) $("#tablaPrendas").innerHTML = htmlCargando();
  try{
    await leerPrendas();
    pintarTablaPrendas();
    // Si la voluntaria no ha escrito un código propio, actualizamos la sugerencia
    if (!editando && ($("#fCodigo").value === "" || $("#fCodigo").value === codigoSugerido)){
      codigoSugerido = nuevoCodigo();
      $("#fCodigo").value = codigoSugerido;
    }
  }catch(e){
    if (!prendas) $("#tablaPrendas").innerHTML = htmlErrorCarga(e, "cargarPrendas");
    else mostrarError(e);
  }
}

function pintarTablaPrendas(){
  if (!prendas) return;
  const q = ($("#filtroPrendas").value || "").toLowerCase().trim();
  const lista = prendas.filter(p =>
    !q || [p.id,p.nombre,p.tipo,p.marca,p.talla].join(" ").toLowerCase().includes(q));

  $("#totalPrendas").textContent =
    `${prendas.length} prendas · ${prendas.filter(p => p.stock > 0 && p.publicado).length} disponibles en el catálogo`;

  if (!lista.length){
    $("#tablaPrendas").innerHTML = `<div class="estado-carga">${prendas.length
      ? "Ninguna prenda calza con la búsqueda."
      : "Todavía no hay prendas. Agrega la primera con “+ Agregar prenda”."}</div>`;
    return;
  }

  // Los botones llevan data-accion y data-id; un solo "escuchador" (abajo) decide qué hacer
  $("#tablaPrendas").innerHTML = `
    <table>
      <thead><tr>
        <th></th><th>Código</th><th>Prenda</th><th>Marca</th><th>Talla</th>
        <th>Estado</th><th>Precio</th><th>Stock</th><th>Visible</th><th>Acciones</th>
      </tr></thead>
      <tbody>
        ${lista.map(p => {
          const e = estadoDe(p.estado);
          return `<tr>
            <td><img class="miniatura" src="${escapar(fotoDe(p))}" alt=""></td>
            <td>${escapar(p.id)}</td>
            <td>${escapar(p.nombre)}<br><span class="chico">${escapar(p.tipo)}</span></td>
            <td>${escapar(p.marca)}</td>
            <td>${escapar(p.talla)}</td>
            <td><span class="punto" style="background:${escapar(e.color)}"></span> ${escapar(e.etiqueta)}</td>
            <td>${plata(p.precio)}</td>
            <td>${Number(p.stock) || 0}</td>
            <td>${p.publicado
              ? '<span class="pastilla verde">Publicada</span>'
              : '<span class="pastilla gris">Oculta</span>'}</td>
            <td class="acciones-prenda">
              <button class="btn btn-linea btn-chico" data-accion="editar" data-id="${escapar(p.id)}">Editar</button>
              <button class="btn btn-fantasma btn-chico" data-accion="publicar" data-id="${escapar(p.id)}">${p.publicado ? "Ocultar" : "Publicar"}</button>
              <button class="btn btn-peligro btn-chico" data-accion="borrar" data-id="${escapar(p.id)}">Borrar</button>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

// Siguiente código libre del tipo SG-0018. Lo calcula el servidor, que también mira
// los pedidos; si todavía no responde, se calcula con las prendas de la lista.
function nuevoCodigo(){
  if (siguienteCodigo) return siguienteCodigo;
  const nums = (prendas || [])
    .map(p => (p.id.match(/^SG-(\d+)$/) || [])[1])
    .filter(Boolean).map(n => parseInt(n, 10));
  const sig = (nums.length ? Math.max(...nums) : 0) + 1;
  return "SG-" + String(sig).padStart(4, "0");
}

function limpiarFormulario(){
  editando = null;
  versionEditando = "";
  codigoSugerido = nuevoCodigo();
  $("#tituloFormulario").textContent = "Agregar una prenda";
  $("#fCodigo").value  = codigoSugerido;
  $("#fCodigo").readOnly = false;
  $("#pistaCodigo").textContent = "Se sugiere solo. Pégalo en la etiqueta física.";
  $("#fNombre").value  = "";
  $("#fTipo").selectedIndex = 0;
  $("#fMarca").selectedIndex = 0;
  $("#fTalla").selectedIndex = 0;
  $("#fEstado").selectedIndex = 0;
  $("#fPrecio").value  = 4000;
  $("#fStock").value   = 1;
  $("#fDetalle").value = "";
  $("#fImagen").value  = "";
  $("#fArchivo").value = "";
  quitarFotoPendiente();
  $("#vistaPrevia").innerHTML = "";
  $("#fPublicado").checked = true;
  $("#btnGuardar").textContent = "Guardar prenda";
}

// Antes de llenar el formulario se pide la prenda de nuevo al servidor:
// así no se parte con un stock viejo (pudo venderse con la lista abierta).
async function editarPrenda(id){
  try{
    await leerPrendas();
    pintarTablaPrendas();
  }catch(e){ mostrarError(e); return; }
  const p = prendas.find(x => x.id === id);
  if (!p){ avisar("Esa prenda ya no existe. Puede que otra voluntaria la haya borrado.", true); return; }
  llenarFormulario(p);
}

// Deja el formulario en modo edición con los datos de la prenda p
function llenarFormulario(p){
  editando = p.id;
  versionEditando = p.actualizadoEn || "";
  pestana("nueva");
  $("#tituloFormulario").textContent = "Editar " + p.id;
  $("#fCodigo").value = p.id;
  $("#fCodigo").readOnly = true;   // el código no se puede cambiar: es la etiqueta física
  $("#pistaCodigo").textContent = "El código no se puede cambiar.";
  $("#fNombre").value = p.nombre;
  $("#fTipo").value   = p.tipo;
  $("#fMarca").value  = p.marca;
  $("#fTalla").value  = p.talla;
  $("#fEstado").value = p.estado;
  $("#fPrecio").value = p.precio;
  $("#fStock").value  = p.stock;
  $("#fDetalle").value= p.detalle || "";
  $("#fImagen").value = p.imagen || "";
  $("#fArchivo").value = "";
  quitarFotoPendiente();
  $("#vistaPrevia").innerHTML = p.imagen
    ? `<img src="${escapar(fotoDe(p))}" alt="Foto actual de la prenda">`
    : "";
  $("#fPublicado").checked = !!p.publicado;
  $("#btnGuardar").textContent = "Guardar cambios";
}

/* ---------- Foto: se achica en el navegador antes de subirla ---------- */

const MAX_ARCHIVO = 15 * 1024 * 1024;   // fotos de teléfono de hasta ~15 MB
const LADO_MAXIMO = 1200;               // px del lado más largo después de achicar
const MAX_SUBIDA  = 1500000;            // lo máximo que acepta el servidor

function quitarFotoPendiente(){
  if (fotoPendiente && fotoPendiente.url) URL.revokeObjectURL(fotoPendiente.url);
  fotoPendiente = null;
}

function ponerFotoPendiente(blob){
  quitarFotoPendiente();
  fotoPendiente = { blob, url: URL.createObjectURL(blob) };
  $("#vistaPrevia").innerHTML = `<img src="${fotoPendiente.url}" alt="Foto nueva de la prenda">
    <p>Foto lista (${Math.round(blob.size / 1024)} KB). Se sube al guardar la prenda.</p>`;
}

async function elegirFoto(input){
  const archivo = input.files[0];
  if (!archivo) return;
  if (!archivo.type.startsWith("image/")){
    avisar("Ese archivo no es una foto. Elige una imagen JPG o PNG.", true); input.value = ""; return;
  }
  if (archivo.size > MAX_ARCHIVO){
    avisar("La foto pesa más de 15 MB. Elige otra o sácala con menos resolución.", true); input.value = ""; return;
  }
  const boton = $("#btnGuardar");
  boton.disabled = true;   // que no se guarde a medio camino
  $("#vistaPrevia").innerHTML = `<p>Preparando la foto…</p>`;
  try{
    ponerFotoPendiente(await achicarFoto(archivo));
  }catch(e){
    $("#vistaPrevia").innerHTML = "";
    input.value = "";
    avisar(e.message, true);
  }finally{
    boton.disabled = false;
  }
}

// Dibuja la foto en un <canvas> más chico y la convierte a JPEG.
// Así una foto de 8 MB del teléfono queda en unos pocos cientos de KB.
async function achicarFoto(archivo){
  const url = URL.createObjectURL(archivo);
  try{
    const img = new Image();
    await new Promise((listo, falla) => {
      img.onload = listo;
      img.onerror = () => falla(new Error("No pudimos leer esa foto. Prueba con una JPG o PNG."));
      img.src = url;
    });

    const escala = Math.min(1, LADO_MAXIMO / Math.max(img.naturalWidth, img.naturalHeight));
    const ancho = Math.max(1, Math.round(img.naturalWidth * escala));
    const alto  = Math.max(1, Math.round(img.naturalHeight * escala));

    const lienzo = document.createElement("canvas");
    lienzo.width = ancho; lienzo.height = alto;
    const ctx = lienzo.getContext("2d");
    ctx.fillStyle = "#ffffff";          // fondo blanco: JPEG no tiene transparencia
    ctx.fillRect(0, 0, ancho, alto);
    ctx.drawImage(img, 0, 0, ancho, alto);

    // Calidad 0.85. Si aun así queda sobre el límite del servidor (muy raro), bajamos la calidad.
    for (const calidad of [0.85, 0.7, 0.55]){
      const blob = await new Promise(ok => lienzo.toBlob(ok, "image/jpeg", calidad));
      if (!blob) break;
      if (blob.size <= MAX_SUBIDA) return blob;
    }
    throw new Error("No pudimos achicar la foto lo suficiente. Prueba con otra.");
  }finally{
    URL.revokeObjectURL(url);
  }
}

/* ---------- Guardar, publicar y borrar ---------- */

// Número entero escrito por la voluntaria: "4000" o "4.000" (punto de miles) → 4000.
// Vacío, decimales u otros signos → null, para no guardar $4 ni $0 por error.
function leerEntero(texto){
  const t = String(texto ?? "").trim();
  if (!/^\d+$/.test(t) && !/^\d{1,3}(\.\d{3})+$/.test(t)) return null;
  return Number(t.replace(/\./g, ""));
}

// Lee el formulario y revisa lo básico. El servidor revisa todo de nuevo.
function leerFormulario(){
  const datos = {
    id:     $("#fCodigo").value.trim().toUpperCase(),
    nombre: $("#fNombre").value.trim(),
    tipo:   $("#fTipo").value,
    marca:  $("#fMarca").value,
    talla:  $("#fTalla").value,
    estado: $("#fEstado").value,
    precio: leerEntero($("#fPrecio").value),
    stock:  leerEntero($("#fStock").value),
    detalle:$("#fDetalle").value.trim(),
    imagen: $("#fImagen").value.trim(),
    publicado: $("#fPublicado").checked
  };
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(datos.id)){
    avisar("El código debe tener de 2 a 20 letras, números o guiones (ej: SG-0018).", true); return null;
  }
  if (datos.nombre.length < 2){ avisar("Ponle un nombre a la prenda.", true); return null; }
  if (datos.precio === null){
    avisar("Escribe el precio sin puntos ni comas, por ejemplo 4000.", true);
    $("#fPrecio").focus(); return null;
  }
  if (datos.precio > 1000000){
    avisar("El precio debe ser un número entero entre 0 y 1.000.000.", true); return null;
  }
  if (datos.stock === null){
    avisar("Escribe la cantidad solo con números, por ejemplo 1.", true);
    $("#fStock").focus(); return null;
  }
  if (datos.stock > 999){
    avisar("La cantidad debe ser un número entero entre 0 y 999.", true); return null;
  }
  if (datos.imagen && !/^(\/img\/|\/api\/imagenes\/|https:\/\/)/.test(datos.imagen)){
    avisar("La ruta de la foto debe empezar con /img/, /api/imagenes/ o https://", true); return null;
  }
  return datos;
}

async function guardarPrenda(){
  const datos = leerFormulario();
  if (!datos) return;
  const eraNueva = !editando;
  const boton = $("#btnGuardar");
  boton.disabled = true; boton.textContent = "Guardando…";
  try{
    // 1) Guardar los datos de la prenda. Al editar se manda la versión que se leyó:
    //    si la prenda cambió entretanto (se vendió, por ejemplo), el servidor responde 409.
    let r;
    try{
      r = eraNueva
        ? await api("/api/admin/productos", { metodo:"POST", json:datos })
        : await api("/api/admin/productos/" + encodeURIComponent(editando),
                    { metodo:"PUT", json:{ ...datos, actualizadoEn: versionEditando } });
    }catch(e){
      if (!eraNueva && e.estado === 409){
        avisar(e.message, true);
        limpiarFormulario();   // los datos del formulario están viejos: no se reusan
        pestana("prendas");    // recarga la lista; con “Editar” se abre la prenda al día
        return;
      }
      throw e;
    }
    const id = r.producto?.id || datos.id;

    // 2) Si hay foto nueva, subirla ahora que la prenda existe
    if (fotoPendiente){
      const foto = fotoPendiente.blob;
      try{
        await api("/api/admin/productos/" + encodeURIComponent(id) + "/imagen", { metodo:"PUT", binario:foto });
      }catch(e){
        if (e instanceof SesionVencida) return;
        // La prenda sí quedó guardada: el formulario queda editándola (aunque la lista
        // no se pueda recargar) para reintentar solo la foto, nunca crearla otra vez.
        if (r.producto) llenarFormulario(r.producto);
        else await editarPrenda(id);
        ponerFotoPendiente(foto);
        avisar("La prenda se guardó, pero la foto no se pudo subir: " + e.message +
               " Aprieta “Guardar cambios” para intentarlo de nuevo.", true);
        leerPrendas().then(pintarTablaPrendas, () => {});   // sin tapar el aviso si falla
        return;
      }
    }

    avisar(!eraNueva ? "Prenda actualizada."
         : datos.publicado ? "Prenda publicada en el catálogo."
         : "Prenda guardada. Queda oculta hasta que la publiques.");
    limpiarFormulario();
    pestana("prendas");   // recarga la lista desde el servidor
  }catch(e){
    mostrarError(e);
  }finally{
    boton.disabled = false;
    boton.textContent = editando ? "Guardar cambios" : "Guardar prenda";
  }
}

// Ocultar o publicar cambia solo "publicado": nunca toca el stock
async function alternarPublicado(id){
  const p = (prendas || []).find(x => x.id === id);
  if (!p) return;
  try{
    await api("/api/admin/productos/" + encodeURIComponent(id) + "/publicado", {
      metodo:"POST", json:{ publicado: !p.publicado }
    });
    avisar(p.publicado ? "Prenda oculta del catálogo." : "Prenda publicada en el catálogo.");
  }catch(e){
    mostrarError(e);
    if (e.estado !== 404 && e.estado !== 409) return;
  }
  await cargarPrendas();
}

async function borrarPrenda(id){
  if (!confirm("¿Borrar la prenda " + id + "? Esto no se puede deshacer.\nLos pedidos que la incluyen conservan su copia.")) return;
  try{
    await api("/api/admin/productos/" + encodeURIComponent(id), { metodo:"DELETE" });
    if (editando === id) limpiarFormulario();
    avisar("Prenda borrada.");
  }catch(e){
    mostrarError(e);   // 409: está en un pedido pendiente de pago
    if (e.estado !== 404 && e.estado !== 409) return;
  }
  await cargarPrendas();
}

/* ================================================================
   PEDIDOS
   ================================================================ */

const ROL       = { apoderado:"Apoderado/a", estudiante:"Estudiante", tercero:"Tercero autorizado" };
const METODO    = { webpay:"Webpay", transferencia:"Transferencia", efectivo:"Efectivo" };
const TIPO_PAGO = { VD:"Débito", VN:"Crédito", VC:"Crédito en cuotas", SI:"3 cuotas sin interés",
                    S2:"2 cuotas sin interés", NC:"N cuotas sin interés", VP:"Prepago" };
const ESTADO_PAGO = {
  pendiente:   ["ambar", "Pendiente"],
  pagado:      ["verde", "Pagado"],
  rechazado:   ["roja",  "Rechazado"],
  anulado:     ["gris",  "Anulado"],
  reembolsado: ["gris",  "Reembolsado"]
};
const ESTADO_TX = { iniciada:"iniciada", autorizada:"autorizada", rechazada:"rechazada", abortada:"cancelada en Webpay",
                    expirada:"expirada", invalida:"inválida", error:"con error", reembolsada:"devuelta" };

function pastillaPago(estado){
  const [color, texto] = Object.hasOwn(ESTADO_PAGO, estado) ? ESTADO_PAGO[estado] : ["gris", estado];
  return `<span class="pastilla ${color}">${escapar(texto)}</span>`;
}

const cerrado = p => ["anulado", "rechazado", "reembolsado"].includes(p.estadoPago);

// "Activo" = todavía falta cobrarlo o entregarlo
const esActivo = p => !cerrado(p) && (p.estadoPago === "pendiente" || p.entrega !== "entregado");

// Lista de transacciones Webpay (pagos y devoluciones) para revisar qué pasó
function htmlTransacciones(p){
  const lista = p.transacciones || [];
  if (!lista.length) return "";
  return `<details class="transacciones"><summary>Transacciones (${lista.length})</summary><ul>
    ${lista.map(t => {
      const partes = [
        `${t.tipo === "reembolso" ? "Devolución" : "Pago"} ${escapar(traducir(ESTADO_TX, t.estado))}`,
        plata(t.monto),
        escapar(fecha(t.creadoEn))
      ];
      if (t.codigoAutorizacion) partes.push("autorización " + escapar(t.codigoAutorizacion));
      if (t.tarjeta)            partes.push("tarjeta ****" + escapar(t.tarjeta));
      if (t.tipoPago)           partes.push(escapar(traducir(TIPO_PAGO, t.tipoPago)));
      if (t.cuotas)             partes.push(escapar(t.cuotas) + " cuotas");
      if (t.tipoReembolso)      partes.push(escapar(t.tipoReembolso === "REVERSED" ? "reversa" : t.tipoReembolso === "NULLIFIED" ? "anulación" : t.tipoReembolso));
      if (t.codigoRespuesta !== null && t.codigoRespuesta !== undefined) partes.push("código " + escapar(t.codigoRespuesta));
      if (t.detalleError)       partes.push("error: " + escapar(t.detalleError));
      if (t.ambiente === "integracion") partes.push("ambiente de pruebas");
      return `<li>${partes.join(" · ")}</li>`;
    }).join("")}
  </ul></details>`;
}

// Columna "Pago": método, estado y, si fue Webpay, autorización y tarjeta
// Pagado con la tarjeta de prueba (Webpay en integración): no entró dinero
function htmlPagoDePrueba(p){
  return p.pagoDePrueba
    ? ` <span class="pastilla roja" title="Se pagó en el ambiente de pruebas de Webpay: no entró dinero real.">Pago de prueba</span>`
    : "";
}

function htmlPago(p){
  let html = `${escapar(traducir(METODO, p.metodoPago))}<br>${pastillaPago(p.estadoPago)}${htmlPagoDePrueba(p)}`;
  if (p.pagoDePrueba){
    html += `<br><span class="chico">Tarjeta de prueba: no entró dinero real.</span>`;
  }
  if (p.estadoPago === "pendiente" && p.metodoPago === "webpay"){
    html += `<br><span class="chico">Esperando el pago en Webpay</span>`;
  }
  if (p.pago){
    html += `<br><span class="chico">Aut. ${escapar(p.pago.codigoAutorizacion)}` +
            (p.pago.tarjeta ? ` · ****${escapar(p.pago.tarjeta)}` : "") +
            (p.pago.tipoPago ? `<br>${escapar(traducir(TIPO_PAGO, p.pago.tipoPago))}` : "") +
            (p.pago.cuotas ? ` · ${escapar(p.pago.cuotas)} cuotas` : "") + `</span>`;
  }
  if (p.pagadoEn) html += `<br><span class="chico">Pagado el ${escapar(fecha(p.pagadoEn))}</span>`;
  if (p.motivoAnulacion) html += `<br><span class="chico">${escapar(p.motivoAnulacion)}</span>`;
  return html + htmlTransacciones(p);
}

function htmlItems(p){
  return (p.items || []).map(i =>
    `${escapar(i.id)} · ${escapar(i.nombre)} (T${escapar(i.talla)}) x${Number(i.cant) || 0}`).join("<br>");
}

async function cargarPedidos(){
  if (!pedidos) $("#tablaPedidos").innerHTML = htmlCargando();
  try{
    const datos = await api("/api/admin/pedidos");
    pedidos = datos.pedidos || [];
    pintarTablaPedidos();
  }catch(e){
    if (!pedidos) $("#tablaPedidos").innerHTML = htmlErrorCarga(e, "cargarPedidos");
    else mostrarError(e);
  }
}

function pintarTablaPedidos(){
  if (!pedidos) return;
  const soloActivos = $("#verPedidos").value === "activos";
  const lista = soloActivos ? pedidos.filter(esActivo) : pedidos;

  $("#totalPedidos").textContent = soloActivos
    ? `${lista.length} pedidos activos de ${pedidos.length} en total`
    : `${pedidos.length} pedidos en total`;

  if (!lista.length){
    $("#tablaPedidos").innerHTML = `<div class="vacio"><h3>${pedidos.length ? "No hay pedidos activos" : "Todavía no hay pedidos"}</h3>
      <p>${pedidos.length ? "Elige “Todos” para ver los pedidos ya cerrados." : "Cuando alguien compre en el catálogo, aparecerá aquí."}</p></div>`;
    return;
  }

  $("#tablaPedidos").innerHTML = `
    <table>
      <thead><tr>
        <th>N° pedido</th><th>Fecha</th><th>Compra</th><th>Retira</th>
        <th>Prendas</th><th>Total</th><th>Pago</th><th>Entrega</th><th>Acciones</th>
      </tr></thead>
      <tbody>
        ${lista.map(p => {
          const n = escapar(p.numero);
          // Solo se ofrecen las acciones que el servidor permite en cada estado
          const puedePagar    = p.estadoPago === "pendiente" && p.metodoPago !== "webpay";
          const puedeEntregar = p.entrega !== "entregado" && !cerrado(p) &&
                                (p.estadoPago === "pagado" || p.metodoPago !== "webpay");
          const puedeAnular   = p.estadoPago === "pendiente";
          return `<tr>
            <td><strong>${n}</strong></td>
            <td>${escapar(fecha(p.creadoEn))}</td>
            <td>${escapar(p.comprador?.nombre)}<br>
                <span class="chico">${escapar(p.comprador?.correo)}<br>${escapar(p.comprador?.fono)}</span></td>
            <td>${escapar(p.retira?.nombre)}<br>
                <span class="pastilla gris">${escapar(traducir(ROL, p.retira?.tipo))}</span>
                ${p.retira?.extra ? `<br><span class="chico">${escapar(p.retira.extra)}</span>` : ""}</td>
            <td>${htmlItems(p)}</td>
            <td><strong>${plata(p.total)}</strong></td>
            <td>${htmlPago(p)}</td>
            <td>${p.entrega === "entregado"
                ? `<span class="pastilla verde">Entregado</span>${p.entregadoEn ? `<br><span class="chico">${escapar(fecha(p.entregadoEn))}</span>` : ""}`
                : cerrado(p) ? `<span class="chico">—</span>`
                : '<span class="pastilla ambar">Por retirar</span>'}</td>
            <td><div class="acciones-fila">
              ${puedePagar    ? `<button class="btn btn-linea btn-chico" data-accion="pagado" data-numero="${n}">Marcar pagado</button>` : ""}
              ${puedeEntregar ? `<button class="btn btn-azul btn-chico" data-accion="entregado" data-numero="${n}">Marcar entregado</button>` : ""}
              ${puedeAnular   ? `<button class="btn btn-peligro btn-chico" data-accion="anular" data-numero="${n}">Anular</button>` : ""}
            </div></td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
}

async function marcarPagado(numero){
  try{
    await api("/api/admin/pedidos/" + encodeURIComponent(numero) + "/pagado", { metodo:"POST", json:{} });
    avisar("Pedido marcado como pagado.");
    await cargarPedidos();
  }catch(e){ mostrarError(e); }
}

async function marcarEntregado(numero){
  try{
    await api("/api/admin/pedidos/" + encodeURIComponent(numero) + "/entregado", { metodo:"POST", json:{} });
    avisar("Pedido marcado como entregado.");
    await cargarPedidos();
  }catch(e){ mostrarError(e); }
}

async function anularPedido(numero){
  const motivo = prompt("¿Por qué se anula el pedido " + numero + "?\nLas prendas vuelven al catálogo.");
  if (motivo === null) return;               // apretó "Cancelar"
  if (!motivo.trim()){ avisar("Escribe el motivo para poder anular el pedido.", true); return; }
  try{
    await api("/api/admin/pedidos/" + encodeURIComponent(numero) + "/anular", { metodo:"POST", json:{ motivo: motivo.trim() } });
    avisar("Pedido anulado. Las prendas volvieron al catálogo.");
  }catch(e){
    mostrarError(e);   // 409: se está pagando o ya no está pendiente
    if (e.estado !== 409) return;
  }
  await cargarPedidos();
}

/* ================================================================
   REEMBOLSOS
   ================================================================ */

const ESTADO_REEMBOLSO = {
  solicitado: ["ambar", "Solicitado"],
  aprobado:   ["verde", "Aprobado"],
  rechazado:  ["roja",  "Rechazado"],
  devuelto:   ["verde", "Dinero devuelto"]
};

async function cargarReembolsos(){
  if (!reembolsos) $("#listaReembolsos").innerHTML = htmlCargando();
  try{
    const datos = await api("/api/admin/reembolsos");
    reembolsos = datos.pedidos || [];
    pintarReembolsos();
  }catch(e){
    if (!reembolsos) $("#listaReembolsos").innerHTML = htmlErrorCarga(e, "cargarReembolsos");
    else mostrarError(e);
  }
}

// Qué pasó con la devolución del dinero por Webpay
function htmlResultadoWebpay(p){
  const r = p.reembolso;
  if (p.metodoPago !== "webpay") return "";
  const devolucion = (p.transacciones || []).find(t => t.tipo === "reembolso" && t.estado === "reembolsada");
  if (r.estado === "devuelto" && devolucion){
    return `<div class="aviso info" style="margin-top:12px">Webpay devolvió ${plata(devolucion.monto)} a la tarjeta
      (${devolucion.tipoReembolso === "REVERSED" ? "reversa" : "anulación"})${r.devueltoEn ? " · " + escapar(fecha(r.devueltoEn)) : ""}</div>`;
  }
  if (r.estado === "aprobado" && r.error){
    return `<div class="aviso" style="margin-top:12px"><strong>No pudimos confirmar la devolución por Webpay:</strong>
      ${escapar(r.error)}<br>Antes de devolver el dinero a mano, revisa en el portal de Transbank si la devolución
      ya se hizo. Si no aparece, reintenta la devolución por Webpay.</div>`;
  }
  return "";
}

function pintarReembolsos(){
  if (!reembolsos) return;
  if (!reembolsos.length){
    $("#listaReembolsos").innerHTML = `<div class="vacio"><h3>No hay solicitudes de reembolso</h3>
      <p>Las solicitudes que envíen los apoderados desde "Mis pedidos" llegan aquí.</p></div>`;
    return;
  }
  $("#listaReembolsos").innerHTML = reembolsos.map(p => {
    const r = p.reembolso;
    const n = escapar(p.numero);
    const [color, texto] = Object.hasOwn(ESTADO_REEMBOLSO, r.estado) ? ESTADO_REEMBOLSO[r.estado] : ["gris", r.estado];
    return `
    <div class="caja">
      <div style="display:flex;justify-content:space-between;gap:14px;flex-wrap:wrap">
        <h3>${n} · ${plata(p.total)}</h3>
        <span class="pastilla ${color}">${escapar(texto)}</span>
      </div>
      <p class="ayuda">${escapar(p.comprador?.nombre)} · ${escapar(p.comprador?.correo)}${p.comprador?.fono ? " · " + escapar(p.comprador.fono) : ""} ·
        solicitado el ${escapar(fecha(r.solicitadoEn))}</p>
      <p><strong>Motivo:</strong> ${escapar(r.motivo)}</p>
      <p style="font-size:.85rem;color:var(--tenue);margin-top:8px">
        Prendas: ${(p.items || []).map(i => escapar(i.id)).join(", ")} ·
        Pago: ${escapar(traducir(METODO, p.metodoPago))} ${pastillaPago(p.estadoPago)}${htmlPagoDePrueba(p)}</p>
      ${p.metodoPago === "webpay" ? htmlTransacciones(p) : ""}
      ${r.respuesta ? `<p style="margin-top:10px"><strong>Respuesta:</strong> ${escapar(r.respuesta)}</p>` : ""}
      ${htmlResultadoWebpay(p)}
      ${r.estado === "solicitado" ? `
        <div class="campo" style="margin-top:14px">
          <label for="resp-${n}">Respuesta para la familia</label>
          <textarea id="resp-${n}" rows="2" maxlength="1000" placeholder="Ej: aprobado, devolvemos el miércoles en el ropero."></textarea>
        </div>
        <div class="botones">
          <button class="btn btn-azul btn-chico" data-accion="aprobar" data-numero="${n}">Aprobar</button>
          <button class="btn btn-peligro btn-chico" data-accion="rechazar" data-numero="${n}">Rechazar</button>
        </div>
      ` : r.estado === "aprobado" ? `
        <div class="botones">
          ${p.metodoPago === "webpay" ? `<button class="btn btn-azul btn-chico" data-accion="reintentar" data-numero="${n}">Reintentar devolución por Webpay</button>` : ""}
          <button class="btn btn-linea btn-chico" data-accion="devuelto" data-numero="${n}">Marcar dinero devuelto</button>
        </div>
      ` : ""}
    </div>`;
  }).join("");
}

// Muestra lo que respondió Webpay al intentar devolver el dinero
function avisarResultado(r, textoSinWebpay){
  if (r && r.webpay){
    avisar(r.webpay.mensaje || (r.webpay.ok ? "Webpay devolvió el dinero."
      : "No pudimos confirmar la devolución. Revisa el portal de Transbank antes de devolver el dinero a mano."), !r.webpay.ok);
  } else {
    avisar(textoSinWebpay);
  }
}

async function resolverReembolso(numero, decision){
  const campo = document.getElementById("resp-" + numero);
  const respuesta = campo ? campo.value.trim() : "";
  try{
    const r = await api("/api/admin/reembolsos/" + encodeURIComponent(numero) + "/resolver",
                        { metodo:"POST", json:{ decision, respuesta } });
    avisarResultado(r, decision === "aprobado" ? "Reembolso aprobado." : "Reembolso rechazado.");
    await cargarReembolsos();
  }catch(e){ mostrarError(e); }
}

async function reintentarDevolucion(numero){
  try{
    const r = await api("/api/admin/reembolsos/" + encodeURIComponent(numero) + "/reintentar", { metodo:"POST", json:{} });
    avisarResultado(r, "Devolución reintentada.");
    await cargarReembolsos();
  }catch(e){ mostrarError(e); }
}

async function marcarDevuelto(numero){
  // Si fue Webpay, la devolución pudo haberse hecho aunque no llegó la respuesta
  const p = (reembolsos || []).find(x => x.numero === numero);
  if (p && p.metodoPago === "webpay" && !confirm("¿Ya revisaste en el portal de Transbank que Webpay no devolvió el dinero?\n" +
      "Marca como devuelto solo si devolviste el dinero tú misma.")) return;
  try{
    await api("/api/admin/reembolsos/" + encodeURIComponent(numero) + "/devuelto", { metodo:"POST", json:{} });
    avisar("Reembolso marcado como devuelto.");
    await cargarReembolsos();
  }catch(e){ mostrarError(e); }
}

/* ================================================================
   RESUMEN Y RESPALDO
   ================================================================ */

async function cargarResumen(){
  $("#resumenCifras").innerHTML = htmlCargando();
  try{
    const r = await api("/api/admin/resumen");
    $("#resumenCifras").innerHTML = `
      <div class="tabla-marco"><table>
        <tr><th>Prendas en el sistema</th><td>${Number(r.prendas) || 0}</td></tr>
        <tr><th>Disponibles en el catálogo</th><td>${Number(r.disponibles) || 0}</td></tr>
        <tr><th>Pedidos (sin anulados ni rechazados)</th><td>${Number(r.pedidos) || 0}</td></tr>
        <tr><th>Prendas vendidas</th><td>${Number(r.prendasVendidas) || 0}</td></tr>
        <tr><th>Recaudado (pagado)</th><td><strong>${plata(r.recaudado)}</strong></td></tr>
        <tr><th>Por cobrar</th><td>${plata(r.porCobrar)}</td></tr>
        <tr><th>Reembolsado</th><td>${plata(r.reembolsado)}</td></tr>
      </table></div>`;
  }catch(e){
    $("#resumenCifras").innerHTML = htmlErrorCarga(e, "cargarResumen");
  }
}

// El CSV necesita el token, por eso no basta con un enlace normal:
// lo pedimos con fetch, lo convertimos en archivo y lo "descargamos".
async function descargarVentas(){
  const boton = $("#btnCsv");
  boton.disabled = true; boton.textContent = "Preparando…";
  try{
    const resp = await pedir("/api/admin/ventas.csv");
    const archivo = await resp.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(archivo);
    a.download = "ventas-ropero.csv";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }catch(e){
    mostrarError(e);
  }finally{
    boton.disabled = false; boton.textContent = "Descargar ventas en CSV";
  }
}

/* ================================================================
   BOTONES DE LAS TABLAS
   Las filas se dibujan con innerHTML, así que en vez de un onclick por
   botón escuchamos los clics en toda la página y miramos data-accion.
   ================================================================ */

const ACCIONES = {
  editar:     b => editarPrenda(b.dataset.id),
  publicar:   b => alternarPublicado(b.dataset.id),
  borrar:     b => borrarPrenda(b.dataset.id),
  pagado:     b => marcarPagado(b.dataset.numero),
  entregado:  b => marcarEntregado(b.dataset.numero),
  anular:     b => anularPedido(b.dataset.numero),
  aprobar:    b => resolverReembolso(b.dataset.numero, "aprobado"),
  rechazar:   b => resolverReembolso(b.dataset.numero, "rechazado"),
  reintentar: b => reintentarDevolucion(b.dataset.numero),
  devuelto:   b => marcarDevuelto(b.dataset.numero)
};

document.addEventListener("click", async e => {
  const boton = e.target.closest("button[data-accion]");
  if (!boton || !Object.hasOwn(ACCIONES, boton.dataset.accion)) return;
  // Desactivamos el botón mientras el servidor responde, para evitar dobles clics
  boton.disabled = true;
  try{ await ACCIONES[boton.dataset.accion](boton); }
  finally{ boton.disabled = false; }
});

/* ================================================================
   ARRANQUE
   ================================================================ */

document.addEventListener("DOMContentLoaded", () => {
  cargarSelectores();
  limpiarFormulario();
  $("#filtroPrendas").addEventListener("input", pintarTablaPrendas);
  // Si ya había ingresado en esta pestaña, entra directo (el servidor revisa el token)
  if (leerToken()) mostrarPanel();
  else $("#claveIngreso").focus();
});

/* ================================================================
   ROPERO SG — Lógica de la tienda
   No necesitas editar este archivo para operar el ropero.
   · Textos, horarios y medios de pago: js/datos.js
   · Prendas: se agregan y editan desde el panel (admin.html)
   Las prendas y los pedidos viven en el servidor (/api/...).
   En este navegador solo se guarda el carrito.
   ================================================================ */

/* ---------- Guardado local (con respaldo en memoria) ------------- */
// Si el navegador bloquea localStorage (modo incógnito estricto),
// el carrito igual funciona mientras la página esté abierta.
const memoria = {};
const almacen = {
  leer(clave, porDefecto){
    try{
      const v = localStorage.getItem(clave);
      return v ? JSON.parse(v) : porDefecto;
    }catch(e){
      return (clave in memoria) ? memoria[clave] : porDefecto;
    }
  },
  guardar(clave, valor){
    try{ localStorage.setItem(clave, JSON.stringify(valor)); }
    catch(e){ memoria[clave] = valor; }
  },
  borrar(clave){
    try{ localStorage.removeItem(clave); }catch(e){}
    delete memoria[clave];
  }
};

// sessionStorage dura solo mientras la pestaña está abierta: sirve para
// recordar qué pago mandamos a Webpay y reconocerlo cuando volvemos.
const PAGO_EN_CURSO = "ropero_pago_en_curso";

function leerPagoEnCurso(){
  try{
    const v = JSON.parse(sessionStorage.getItem(PAGO_EN_CURSO) || "null");
    return (v && typeof v.numero === "string") ? v : null;
  }catch(e){ return null; }
}
function guardarPagoEnCurso(datos){
  try{ sessionStorage.setItem(PAGO_EN_CURSO, JSON.stringify(datos)); }catch(e){}
}
function borrarPagoEnCurso(){
  try{ sessionStorage.removeItem(PAGO_EN_CURSO); }catch(e){}
}

// El servidor acepta de 1 a 10 unidades por prenda en cada pedido.
const MAX_POR_PRENDA = 10;

/* Lee el carrito guardado y descarta líneas raras (por ejemplo, de una
   versión antigua de la página o editadas a mano). */
function leerCarrito(){
  const guardado = almacen.leer("ropero_carrito", []);
  if (!Array.isArray(guardado)) return [];
  const cantidades = new Map();
  guardado.forEach(l => {
    if (l && typeof l.id === "string" && Number.isInteger(l.cant) && l.cant > 0)
      cantidades.set(l.id, (cantidades.get(l.id) || 0) + l.cant);
  });
  return [...cantidades].map(([id, cant]) => ({ id, cant }));
}

/* ---------- Estado de la aplicación ----------------------------- */
const estado = {
  prendas:       [],          // llegan desde /api/productos
  catalogoListo: false,
  cargaCatalogo: null,        // promesa de la última carga del catálogo
  carrito:       leerCarrito(),
  compraDirecta: null,
  filtros:       { tipos:[], marcas:[], tallas:[], estados:[] },
  busqueda:      "",
  orden:         "recientes",

  // Lo que responde /api/config. Mientras no llega, suponemos lo más
  // prudente: sin aviso de pruebas y sin prometer correos.
  config: {
    webpay:             { ambiente: null },
    pagos:              CONFIG.pagos,
    diasReembolso:      CONFIG.diasReembolso,
    datosTransferencia: CONFIG.datosTransferencia,
    correo:             { activo: false }
  },
  cargaConfig:    null,

  retornoListo:   null,       // promesa: terminamos de revisar si volvimos de Webpay
  retenerCarrito: false,      // true mientras un pago Webpay se está confirmando
  pedidoRetorno:  null,       // pedido que se muestra al volver de Webpay
  pedidoVisto:    null        // { numero, correo } o { numero, t }: para pedir reembolso
};

function guardarCarrito(){ almacen.guardar("ropero_carrito", estado.carrito); }

/* ---------- Utilidades ------------------------------------------ */
const $  = (s, ctx=document) => ctx.querySelector(s);
const $$ = (s, ctx=document) => [...ctx.querySelectorAll(s)];

const plata = n => "$" + Number(n || 0).toLocaleString("es-CL");

const limpiar = t => (t ?? "").toString().toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "");

function escapar(t){
  return (t ?? "").toString()
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

/* Convierte un valor en texto JS seguro para ponerlo dentro de un
   onclick="funcion(...)". Devuelve el valor YA entre comillas. */
function jsSeguro(v){
  return escapar(JSON.stringify(String(v ?? "")));
}

function buscarPrenda(id){
  return estado.prendas.find(x => x.id === id);
}

function fechaHora(iso){
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleString("es-CL");
}
function fechaCorta(iso){
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("es-CL");
}

/* Marcador de posición cuando la prenda no tiene foto */
function fotoDe(p){
  if (p.imagen && p.imagen.trim()) return p.imagen;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300">
    <rect width="300" height="300" fill="#EDF1F9"/>
    <rect x="70" y="72" width="160" height="156" rx="18" fill="#C9D6EE"/>
    <path d="M92 92h116v40H92z" fill="#B0C2E4"/>
    <text x="150" y="256" font-family="Montserrat,Arial" font-size="20"
      font-weight="700" fill="#1E3C7B" text-anchor="middle">${escapar(p.tipo)}</text>
  </svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

function infoEstado(clave){
  return ESTADOS[clave] || { etiqueta: clave, color:"#6B7590", resumen:"" };
}

/* Desactiva un botón mientras esperamos al servidor, para que nadie
   haga doble clic y cree dos pedidos. */
function ocupado(boton, texto){
  if (!boton) return;
  if (!boton.dataset.texto) boton.dataset.texto = boton.textContent;
  boton.disabled = true;
  boton.textContent = texto;
}
function libre(boton){
  if (!boton || !boton.dataset.texto) return;
  boton.textContent = boton.dataset.texto;
  delete boton.dataset.texto;
  boton.disabled = false;
}

/* ---------- Conversación con el servidor ------------------------ */
/* Hace la petición y devuelve el JSON. Si algo falla, lanza un error
   con un mensaje listo para mostrar (error.estado = código HTTP). */
async function api(ruta, { metodo = "GET", cuerpo } = {}){
  const opciones = { method: metodo, headers: { "Accept": "application/json" } };
  if (cuerpo !== undefined){
    opciones.headers["Content-Type"] = "application/json";
    opciones.body = JSON.stringify(cuerpo);
  }

  let respuesta;
  try{
    respuesta = await fetch(ruta, opciones);
  }catch(e){
    const err = new Error("No pudimos conectar con el servidor. Revisa tu conexión e intenta de nuevo.");
    err.estado = 0;
    throw err;
  }

  let datos = null;
  try{ datos = await respuesta.json(); }catch(e){ /* respuesta sin JSON */ }

  if (!respuesta.ok){
    const err = new Error((datos && datos.error) || (respuesta.status === 429
      ? "Demasiados intentos. Espera unos minutos y vuelve a intentarlo."
      : "Ocurrió un error inesperado. Intenta de nuevo."));
    err.estado = respuesta.status;
    err.datos  = datos;
    throw err;
  }
  return datos || {};
}

/* ================================================================
   CONFIGURACIÓN DEL SERVIDOR (/api/config)
   ================================================================ */

function cargarConfig(){
  estado.cargaConfig = (async () => {
    try{
      const c = await api("/api/config");
      estado.config = {
        ...estado.config,
        ...c,
        webpay: c.webpay || estado.config.webpay,
        correo: c.correo || estado.config.correo
      };
    }catch(e){
      // Sin config seguimos igual: no mostramos el aviso de pruebas ni prometemos correos.
      console.warn("No se pudo leer /api/config:", e.message);
    }
    aplicarConfig();
  })();
  return estado.cargaConfig;
}

function correoActivo(){
  return !!(estado.config.correo && estado.config.correo.activo);
}

function webpayEnPruebas(){
  return !!(estado.config.webpay && estado.config.webpay.ambiente === "integracion");
}

/* Ajusta los textos que dependen de la config del servidor */
function aplicarConfig(){
  $$(".js-pista-correo").forEach(e => {
    e.textContent = correoActivo()
      ? "Aquí llega el comprobante y el número de pedido."
      : "Con este correo y el número de pedido puedes revisar tu compra en «Mis pedidos».";
  });
  // Si el checkout ya está pintado, refrescamos el aviso de Webpay
  if ($("#formularioPago")) mostrarFormularioPago();
}

/* ================================================================
   CATÁLOGO DESDE EL SERVIDOR
   ================================================================ */

function cargarCatalogo({ silencioso = false } = {}){
  estado.cargaCatalogo = (async () => {
    if (!estado.catalogoListo){
      $("#conteo").textContent = "";
      $("#grillaPrendas").innerHTML = `
        <div class="vacio">
          <h3>Cargando prendas…</h3>
          <p>Un momento, estamos trayendo el catálogo.</p>
        </div>`;
    }

    try{
      const r = await api("/api/productos");
      estado.prendas = Array.isArray(r.productos) ? r.productos : [];
      estado.catalogoListo = true;
    }catch(e){
      // Si ya había un catálogo cargado lo dejamos; si no, mostramos el error.
      if (!estado.catalogoListo){
        $("#conteo").textContent = "";
        $("#grillaPrendas").innerHTML = `
          <div class="vacio">
            <h3>No pudimos cargar el catálogo</h3>
            <p>${escapar(e.message)}</p>
            <p style="margin-top:16px"><button class="btn btn-azul" onclick="cargarCatalogo()">Reintentar</button></p>
          </div>`;
      } else {
        avisar(e.message);
      }
      return false;
    }

    pintarFiltros();
    pintarCatalogo();

    // Esperamos a saber si volvimos de Webpay antes de tocar el carrito
    await Promise.resolve(estado.retornoListo).catch(() => {});
    if (!estado.retenerCarrito) conciliarCarrito(silencioso);
    return true;
  })();
  return estado.cargaCatalogo;
}

/* Ajusta una lista de líneas {id, cant} a lo que hay en el catálogo:
   quita lo que ya no existe o se vendió y baja cantidades al stock. */
function ajustarLineas(lineas){
  const quitadas = [], ajustadas = [], resultado = [];
  lineas.forEach(l => {
    const p = buscarPrenda(l.id);
    if (!p || (p.stock ?? 0) <= 0){ quitadas.push(l.id); return; }
    const maximo = Math.min(p.stock, MAX_POR_PRENDA);
    if (l.cant > maximo){
      ajustadas.push(p.nombre);
      resultado.push({ id:l.id, cant:maximo });
    } else {
      resultado.push({ id:l.id, cant:l.cant });
    }
  });
  return { lineas: resultado, quitadas, ajustadas };
}

/* El carrito guardado puede tener prendas que otra persona compró
   mientras tanto: lo ponemos al día y avisamos qué cambió. */
function conciliarCarrito(silencioso = false){
  const r = ajustarLineas(estado.carrito);
  const cambio = r.quitadas.length || r.ajustadas.length;
  estado.carrito = r.lineas;
  if (cambio){
    guardarCarrito();
    if (!silencioso){
      const partes = [];
      if (r.quitadas.length)
        partes.push(r.quitadas.length === 1
          ? "1 prenda ya no está disponible y la quitamos."
          : `${r.quitadas.length} prendas ya no están disponibles y las quitamos.`);
      if (r.ajustadas.length)
        partes.push("Ajustamos la cantidad de " + r.ajustadas.join(", ") + " según el stock.");
      avisar("Actualizamos tu carrito: " + partes.join(" "));
    }
  }
  actualizarContador();
  return !!cambio;
}

/* ================================================================
   FILTROS Y BÚSQUEDA
   ================================================================ */

// El servidor ya manda solo las prendas publicadas
function prendasVisibles(){
  return estado.prendas;
}

function aplicarFiltros(){
  const q = limpiar(estado.busqueda).trim();
  const f = estado.filtros;

  let r = prendasVisibles().filter(p => {
    if (f.tipos.length   && !f.tipos.includes(p.tipo))     return false;
    if (f.marcas.length  && !f.marcas.includes(p.marca))   return false;
    if (f.tallas.length  && !f.tallas.includes(p.talla))   return false;
    if (f.estados.length && !f.estados.includes(p.estado)) return false;
    if (q){
      const heno = limpiar([p.nombre,p.tipo,p.marca,p.talla,p.id,p.detalle,
                            infoEstado(p.estado).etiqueta].join(" "));
      if (!q.split(/\s+/).every(pal => heno.includes(pal))) return false;
    }
    return true;
  });

  const sinStock = p => (p.stock ?? 0) <= 0;
  r.sort((a,b) => sinStock(a) - sinStock(b));   // lo agotado va al final

  if (estado.orden === "precio-asc")  r.sort((a,b)=>a.precio-b.precio);
  if (estado.orden === "precio-desc") r.sort((a,b)=>b.precio-a.precio);
  if (estado.orden === "talla")       r.sort((a,b)=>LISTAS.tallas.indexOf(a.talla)-LISTAS.tallas.indexOf(b.talla));
  if (estado.orden === "estado"){
    const ord = Object.keys(ESTADOS);
    r.sort((a,b)=>ord.indexOf(a.estado)-ord.indexOf(b.estado));
  }
  return r;
}

function contarPor(campo, valor){
  return prendasVisibles().filter(p => p[campo] === valor && (p.stock ?? 0) > 0).length;
}

function pintarFiltros(){
  const g = (titulo, clave, opciones, extra="") => `
    <div class="grupo" data-abierto="si">
      <button type="button" onclick="alternarGrupo(this)">
        ${titulo} <span class="flecha">▼</span>
      </button>
      <div class="opciones ${extra}">${opciones}</div>
    </div>`;

  const casilla = (clave, valor, etiqueta, cuenta=null, punto="") => `
    <label class="${estado.filtros[clave].includes(valor) ? "marcada" : ""}">
      <input type="checkbox" value="${escapar(valor)}"
        ${estado.filtros[clave].includes(valor) ? "checked" : ""}
        onchange="alternarFiltro('${clave}', this.value, this.checked, this)">
      ${punto}<span>${escapar(etiqueta)}</span>
      ${cuenta !== null ? `<span class="cant">${cuenta}</span>` : ""}
    </label>`;

  $("#panelFiltros").innerHTML =
    g("Categoría", "tipos",
      LISTAS.tipos.map(t => casilla("tipos", t, t, contarPor("tipo", t))).join("")) +

    g("Marcas", "marcas",
      LISTAS.marcas.map(m => casilla("marcas", m, m, contarPor("marca", m))).join("")) +

    g("Tallas", "tallas",
      LISTAS.tallas.map(t => casilla("tallas", t, t)).join(""), "tallas") +

    g("Estado", "estados",
      Object.entries(ESTADOS).map(([k,v]) =>
        casilla("estados", k, v.etiqueta, contarPor("estado", k),
          `<span class="punto" style="background:${escapar(v.color)}"></span>`)).join("")) +

    `<button class="limpiar" onclick="limpiarFiltros()">Borrar todos los filtros</button>
     <p style="font-size:.78rem;color:#B9C8E6;margin-top:12px;text-align:center">
       <a href="pauta.html" style="color:#FFE1A6">¿Qué significa cada estado?</a>
     </p>`;
}

function alternarGrupo(btn){
  const g = btn.closest(".grupo");
  g.dataset.abierto = g.dataset.abierto === "si" ? "no" : "si";
}

function alternarFiltro(clave, valor, activo, elemento){
  const lista = estado.filtros[clave];
  if (activo){ if (!lista.includes(valor)) lista.push(valor); }
  else       { estado.filtros[clave] = lista.filter(v => v !== valor); }
  if (elemento){
    const etiqueta = elemento.closest("label");
    if (etiqueta) etiqueta.classList.toggle("marcada", activo);
  }
  pintarCatalogo();
}

function limpiarFiltros(){
  estado.filtros = { tipos:[], marcas:[], tallas:[], estados:[] };
  estado.busqueda = "";
  $("#campoBusqueda").value = "";
  pintarFiltros();
  pintarCatalogo();
}

function pintarChips(){
  const chips = [];
  const agregar = (clave, valor, texto) => chips.push(
    `<span class="chip">${escapar(texto)}
      <button onclick="alternarFiltro('${clave}',${jsSeguro(valor)},false);pintarFiltros()"
        aria-label="Quitar filtro">✕</button></span>`);

  estado.filtros.tipos.forEach(v => agregar("tipos", v, v));
  estado.filtros.marcas.forEach(v => agregar("marcas", v, v));
  estado.filtros.tallas.forEach(v => agregar("tallas", v, "Talla " + v));
  estado.filtros.estados.forEach(v => agregar("estados", v, infoEstado(v).etiqueta));
  if (estado.busqueda.trim())
    chips.push(`<span class="chip">Búsqueda: ${escapar(estado.busqueda)}
      <button onclick="$('#campoBusqueda').value='';estado.busqueda='';pintarCatalogo()">✕</button></span>`);

  $("#chipsFiltros").innerHTML = chips.join("");
}

/* ================================================================
   CATÁLOGO
   ================================================================ */

function pintarCatalogo(){
  // Mientras carga, la grilla muestra "Cargando…" (o el error)
  if (!estado.catalogoListo){ pintarChips(); return; }

  const lista = aplicarFiltros();
  pintarChips();

  $("#conteo").textContent =
    lista.length === 1 ? "1 prenda disponible" : `${lista.length} prendas disponibles`;

  if (!lista.length){
    $("#grillaPrendas").innerHTML = `
      <div class="vacio">
        <h3>No encontramos prendas con esos filtros</h3>
        <p>Prueba quitando alguno o revisa el catálogo completo.</p>
        <p style="margin-top:16px"><button class="btn btn-azul" onclick="limpiarFiltros()">Ver todo el catálogo</button></p>
      </div>`;
    return;
  }

  $("#grillaPrendas").innerHTML = lista.map(p => {
    const e = infoEstado(p.estado);
    const agotado = (p.stock ?? 0) <= 0;
    return `
      <article class="prenda ${agotado ? "sin-stock" : ""}">
        <div class="foto">
          <span class="talla-flotante">Talla ${escapar(p.talla)}</span>
          <img src="${escapar(fotoDe(p))}" alt="${escapar(p.nombre)}" loading="lazy">
          ${agotado ? '<span class="etiqueta-vendido">Vendida</span>' : ""}
        </div>
        <div class="cuerpo">
          <span class="tipo">${escapar(p.tipo)} · ${escapar(p.id)}</span>
          <span class="nombre">${escapar(p.nombre)}</span>
          <span class="marca">${escapar(p.marca)}</span>
          <span class="estado-linea">
            <span class="punto" style="background:${escapar(e.color)}"></span>${escapar(e.etiqueta)}
          </span>
          <div class="pie">
            <span class="precio">${plata(p.precio)}</span>
            <button class="btn btn-azul btn-chico" onclick="abrirFicha(${jsSeguro(p.id)})">
              ${agotado ? "Ver ficha" : "Ver prenda"}
            </button>
          </div>
        </div>
      </article>`;
  }).join("");
}

/* ================================================================
   FICHA DE LA PRENDA
   ================================================================ */

function abrirFicha(id){
  const p = buscarPrenda(id);
  if (!p) return;
  const e = infoEstado(p.estado);
  const agotado = (p.stock ?? 0) <= 0;

  $("#capaModal").innerHTML = `
    <div class="telon" onclick="if(event.target===this) cerrarFicha()">
      <div class="modal" role="dialog" aria-modal="true" aria-label="Ficha de la prenda">
        <button class="cerrar" onclick="cerrarFicha()" aria-label="Cerrar">✕</button>
        <div class="ficha">
          <div class="imagen"><img src="${escapar(fotoDe(p))}" alt="${escapar(p.nombre)}"></div>
          <div class="datos">
            <h2>${escapar(p.nombre)}</h2>
            <dl>
              <dt>Producto:</dt><dd>${escapar(p.tipo)}</dd>
              <dt>Marca:</dt><dd>${escapar(p.marca)}</dd>
              <dt>Estado:</dt>
              <dd>
                ${escapar(e.etiqueta)}
                <span class="punto" style="background:${escapar(e.color)}"></span>
                <a class="ver-pauta" href="pauta.html#${encodeURIComponent(p.estado)}" target="_blank" rel="noopener">Ver pauta</a>
              </dd>
              <dt>Talla:</dt><dd>${escapar(p.talla)}</dd>
              <dt>Código:</dt><dd>${escapar(p.id)}</dd>
            </dl>
            <p class="notas"><strong>Revisión del ropero:</strong> ${escapar(p.detalle || "Sin observaciones.")}</p>
            <div class="precio-grande">${plata(p.precio)}</div>
            <p style="font-size:.85rem;color:var(--tenue)">
              ${agotado ? "Sin stock por ahora." : `Quedan ${escapar(p.stock)} unidad(es) · Retiro: ${escapar(CONFIG.horarioRetiro)}`}
            </p>
            <div class="acciones">
              <button class="btn btn-azul"   ${agotado?"disabled":""} onclick="alCarrito(${jsSeguro(p.id)})">🛒 Añadir al carrito</button>
              <button class="btn btn-dorado" ${agotado?"disabled":""} onclick="comprarAhora(${jsSeguro(p.id)})">Comprar ahora</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
  document.body.style.overflow = "hidden";
}

function cerrarFicha(){
  $("#capaModal").innerHTML = "";
  document.body.style.overflow = "";
}

/* ================================================================
   CARRITO
   ================================================================ */

function alCarrito(id){
  const p = buscarPrenda(id);
  if (!p || (p.stock ?? 0) <= 0) return;
  const maximo = Math.min(p.stock, MAX_POR_PRENDA);
  const linea = estado.carrito.find(l => l.id === id);
  if (linea){
    if (linea.cant >= maximo){
      avisar(linea.cant >= p.stock
        ? "Ya tienes todas las unidades disponibles en el carrito."
        : `Puedes llevar hasta ${MAX_POR_PRENDA} unidades de una misma prenda por pedido.`);
      return;
    }
    linea.cant++;
  } else {
    estado.carrito.push({ id, cant:1 });
  }
  guardarCarrito();
  actualizarContador();
  cerrarFicha();
  abrirCarrito();
}

function quitarDelCarrito(id){
  estado.carrito = estado.carrito.filter(l => l.id !== id);
  guardarCarrito();
  actualizarContador();
  abrirCarrito();
}

function cambiarCantidad(id, delta){
  const linea = estado.carrito.find(l => l.id === id);
  const p = buscarPrenda(id);
  if (!linea || !p) return;
  linea.cant = Math.max(1, Math.min(p.stock, MAX_POR_PRENDA, linea.cant + delta));
  guardarCarrito();
  abrirCarrito();
  actualizarContador();
}

/* Prendas del pedido que se está armando: la compra directa o el carrito */
function itemsActivos(){
  const fuente = estado.compraDirecta || estado.carrito;
  return fuente.map(l => {
    const p = buscarPrenda(l.id);
    return p ? { ...p, cant: l.cant } : null;
  }).filter(Boolean);
}

// Este total es solo para mostrar: el servidor calcula el total real.
function totalActivo(){
  return itemsActivos().reduce((s,i) => s + i.precio * i.cant, 0);
}

function actualizarContador(){
  const n = estado.carrito.reduce((s,l) => s + l.cant, 0);
  const c = $("#contadorCarrito");
  c.textContent = n;
  c.style.display = n ? "grid" : "none";
}

/* Abrir el carrito no cambia el pedido del checkout: si era una compra directa,
   sigue siéndolo hasta que se aprieta "Continuar con la entrega". */
function abrirCarrito(){
  const items = estado.carrito.map(l => {
    const p = buscarPrenda(l.id);
    return p ? { ...p, cant:l.cant } : null;
  }).filter(Boolean);
  const total = items.reduce((s,i) => s + i.precio*i.cant, 0);

  $("#capaPanel").innerHTML = `
    <div class="telon" onclick="if(event.target===this) cerrarPanel()">
      <aside class="panel" role="dialog" aria-label="Carrito de compras">
        <header>
          <h2>Tu carrito</h2>
          <button onclick="cerrarPanel()" aria-label="Cerrar">✕</button>
        </header>
        <div class="lista">
          ${items.length ? items.map(i => `
            <div class="linea-carro">
              <div class="mini"><img src="${escapar(fotoDe(i))}" alt=""></div>
              <div>
                <div class="t">${escapar(i.nombre)}</div>
                <div class="s">Talla ${escapar(i.talla)} · ${escapar(i.marca)} · ${escapar(infoEstado(i.estado).etiqueta)}</div>
                <div class="s" style="margin-top:5px;display:flex;align-items:center;gap:8px">
                  <button class="btn btn-fantasma btn-chico" style="padding:2px 9px" onclick="cambiarCantidad(${jsSeguro(i.id)},-1)" aria-label="Quitar una unidad">−</button>
                  ${escapar(i.cant)}
                  <button class="btn btn-fantasma btn-chico" style="padding:2px 9px" onclick="cambiarCantidad(${jsSeguro(i.id)},1)" aria-label="Agregar una unidad">+</button>
                  <strong style="margin-left:6px">${plata(i.precio*i.cant)}</strong>
                </div>
              </div>
              <button class="quitar" onclick="quitarDelCarrito(${jsSeguro(i.id)})" aria-label="Quitar">🗑</button>
            </div>`).join("")
          : `<div class="vacio" style="border:0;background:none">
               <h3>Tu carrito está vacío</h3>
               <p>Explora el catálogo y agrega prendas.</p>
             </div>`}
        </div>
        <footer>
          <div class="total-fila"><span>Subtotal</span><span>${plata(total)}</span></div>
          <div class="total-fila"><span>Retiro en el colegio</span><span>Gratis</span></div>
          <div class="total-fila grande"><span>Total</span><span>${plata(total)}</span></div>
          <button class="btn btn-azul btn-ancho" ${items.length?"":"disabled"} onclick="irACheckout()">
            Continuar con la entrega
          </button>
          <button class="btn btn-fantasma btn-ancho" style="margin-top:9px" onclick="cerrarPanel()">Seguir comprando</button>
        </footer>
      </aside>
    </div>`;
  document.body.style.overflow = "hidden";
}

function cerrarPanel(){
  $("#capaPanel").innerHTML = "";
  document.body.style.overflow = "";
  // Si el carrito cambió con el checkout abierto, el resumen muestra lo mismo que se va a cobrar
  if (!$("#vistaCheckout").classList.contains("oculto")) pintarResumenPedido();
}

function comprarAhora(id){
  const p = buscarPrenda(id);
  if (!p || (p.stock ?? 0) <= 0) return;
  estado.compraDirecta = [{ id, cant:1 }];
  cerrarFicha();
  irACheckout(true);
}

/* ================================================================
   NAVEGACIÓN ENTRE VISTAS
   ================================================================ */

/* Quita ?pedido=...&t=... de la dirección, para que al recargar
   no vuelva a aparecer el comprobante. */
function limpiarUrl(){
  if (location.search) history.replaceState(null, "", location.pathname + location.hash);
}

function mostrarVista(nombre){
  $$(".vista").forEach(v => v.classList.add("oculto"));
  $("#vista" + nombre).classList.remove("oculto");
  if (nombre !== "Confirmacion") limpiarUrl();
  window.scrollTo({ top:0, behavior:"instant" });
}

function irACatalogo(){ estado.compraDirecta = null; mostrarVista("Catalogo"); }

function irACheckout(directa=false){
  if (!directa) estado.compraDirecta = null;
  if (!itemsActivos().length){ avisar("Primero agrega al menos una prenda."); return; }
  cerrarPanel();
  pintarCheckout();
  mostrarVista("Checkout");
}

function irAPedidos(){ pintarBuscadorPedidos(); mostrarVista("Pedidos"); }

/* ================================================================
   CHECKOUT
   ================================================================ */

function pintarCheckout(){
  pintarResumenPedido();
  pintarOpcionesPago();
  cambiarRetiro();
}

function pintarResumenPedido(){
  const items = itemsActivos();
  const total = totalActivo();

  $("#resumenPedido").innerHTML = `
    <div class="caja">
      <h3>Resumen del pedido</h3>
      <p class="ayuda">${items.length} prenda(s)</p>
      ${items.map(i => `
        <div class="linea-carro" style="margin-bottom:12px">
          <div class="mini"><img src="${escapar(fotoDe(i))}" alt=""></div>
          <div>
            <div class="t">${escapar(i.nombre)}</div>
            <div class="s">Talla ${escapar(i.talla)} · ${escapar(i.marca)} · x${escapar(i.cant)}</div>
          </div>
          <strong>${plata(i.precio*i.cant)}</strong>
        </div>`).join("")}
      <div class="total-fila" style="border-top:1px solid var(--borde);padding-top:12px">
        <span>Subtotal</span><span>${plata(total)}</span></div>
      <div class="total-fila"><span>Retiro en el colegio</span><span>Gratis</span></div>
      <div class="total-fila grande"><span>Total</span><span>${plata(total)}</span></div>
      <p style="font-size:.8rem;color:var(--tenue)">
        Lo recaudado va íntegro a las becas del viaje de estudios de 11° grado.
      </p>
    </div>`;
}

function pintarOpcionesPago(){
  const pagos = CONFIG.pagos;
  // El primero que esté activo parte marcado
  const primero = ["webpay","transferencia","efectivo"].find(m => pagos[m]);

  if (!primero){
    $("#opcionesPago").innerHTML = `
      <div class="aviso">
        Por ahora no hay medios de pago disponibles. Escríbenos a ${escapar(CONFIG.correo)}.
      </div>
      <div id="formularioPago"></div>`;
    $("#btnConfirmar").disabled = true;
    return;
  }
  if (!$("#btnConfirmar").dataset.texto) $("#btnConfirmar").disabled = false;

  $("#opcionesPago").innerHTML = `
    ${pagos.webpay ? `
      <label class="opcion">
        <input type="radio" name="pago" value="webpay" ${primero==="webpay"?"checked":""} onchange="mostrarFormularioPago()">
        <span><span class="t">Webpay Plus — tarjeta de crédito, débito o prepago</span>
        <span class="d">Pagas en el sitio seguro de Transbank. Tus prendas quedan reservadas mientras pagas.</span></span>
      </label>` : ""}
    ${pagos.transferencia ? `
      <label class="opcion">
        <input type="radio" name="pago" value="transferencia" ${primero==="transferencia"?"checked":""} onchange="mostrarFormularioPago()">
        <span><span class="t">Transferencia bancaria</span>
        <span class="d">${correoActivo()
          ? "Te enviamos los datos por correo."
          : "Al confirmar te mostramos los datos de la cuenta."} La prenda queda reservada 48 horas.</span></span>
      </label>` : ""}
    ${pagos.efectivo ? `
      <label class="opcion">
        <input type="radio" name="pago" value="efectivo" ${primero==="efectivo"?"checked":""} onchange="mostrarFormularioPago()">
        <span><span class="t">Efectivo al retirar</span>
        <span class="d">Pagas en el ropero el día del retiro. ${escapar(CONFIG.horarioRetiro)}.</span></span>
      </label>` : ""}
    <div id="formularioPago"></div>`;

  mostrarFormularioPago();
}

function metodoPago(){
  const r = $$('input[name="pago"]').find(x => x.checked);
  return r ? r.value : null;
}

function mostrarFormularioPago(){
  const m = metodoPago();
  const c = $("#formularioPago");
  if (!c) return;
  if (m === "webpay"){
    // Solo cuando Webpay está en ambiente de pruebas, para que nadie crea que pagó de verdad
    c.innerHTML = webpayEnPruebas() ? `
      <div class="aviso info">
        <strong>Webpay está en modo de pruebas: no se hace ningún cobro real.</strong><br>
        Para probar usa la tarjeta <strong>4051 8856 0044 6623</strong>, CVV 123 y cualquier fecha futura.
        Si te pide RUT y clave: RUT 11.111.111-1, clave 123.
      </div>` : "";
  } else if (m === "transferencia"){
    c.innerHTML = `
      <div class="aviso info">
        Al confirmar te mostramos los datos de la cuenta${correoActivo() ? " y te llegan también por correo" : ""}.
        La prenda queda reservada 48 horas a tu nombre.
      </div>`;
  } else if (m === "efectivo"){
    c.innerHTML = `
      <div class="aviso info">
        Pagas al retirar en el ropero. ${escapar(CONFIG.horarioRetiro)}.
        Lleva el número de pedido anotado o en el teléfono.
      </div>`;
  } else {
    c.innerHTML = "";
  }
}

function cambiarRetiro(){
  const v = ($$('input[name="retira"]').find(x => x.checked) || {}).value;
  $("#datosEstudiante").classList.toggle("oculto", v !== "estudiante");
  $("#datosTercero").classList.toggle("oculto",   v !== "tercero");
}

/* Revisa el dígito verificador del RUT (módulo 11).
   Acepta "12.345.678-5", "12345678-5" o "123456785". */
function rutValido(rut){
  // Misma regla que el servidor (src/rut.js): puntos opcionales y guion solo antes del dígito
  const partes = /^(\d{1,8})-?([0-9K])$/.exec(String(rut || "").replace(/[.\s]/g, "").toUpperCase());
  if (!partes) return false;
  const cuerpo = partes[1].replace(/^0+/, ""), dv = partes[2];
  if (!cuerpo) return false;
  let suma = 0, factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--){
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  const esperado = resto === 11 ? "0" : resto === 10 ? "K" : String(resto);
  return dv === esperado;
}

async function confirmarPedido(){
  const boton = $("#btnConfirmar");
  if (boton.disabled) return;   // ya se está enviando

  const items = itemsActivos();
  if (!items.length){ avisar("No hay prendas en el pedido."); return; }

  const nombre   = $("#compNombre").value.trim();
  const correo   = $("#compCorreo").value.trim();
  const fono     = $("#compFono").value.trim();
  const tipo     = ($$('input[name="retira"]').find(x => x.checked) || {}).value || "apoderado";
  const pago     = metodoPago();

  if (!nombre){ avisar("Falta el nombre del apoderado o apoderada."); $("#compNombre").focus(); return; }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)){ avisar("Revisa el correo: no tiene un formato válido."); $("#compCorreo").focus(); return; }
  if (!fono){ avisar("Falta el teléfono de contacto."); $("#compFono").focus(); return; }

  let retira = { tipo:"apoderado" };
  if (tipo === "estudiante"){
    const n = $("#estNombre").value.trim(), curso = $("#estCurso").value.trim();
    if (!n || !curso){ avisar("Completa el nombre y el curso del estudiante."); return; }
    retira = { tipo:"estudiante", nombre:n, curso };
  }
  if (tipo === "tercero"){
    const n = $("#terNombre").value.trim(), rut = $("#terRut").value.trim();
    if (!n || !rut){ avisar("Completa el nombre y el RUT de quien retira."); return; }
    if (!rutValido(rut)){ avisar("Revisa el RUT de quien retira: el dígito verificador no calza."); $("#terRut").focus(); return; }
    retira = { tipo:"tercero", nombre:n, rut };
  }

  if (!pago){ avisar("Elige cómo quieres pagar."); return; }

  // Solo mandamos códigos y cantidades: el precio lo pone el servidor
  const cuerpo = {
    items:     items.map(i => ({ id:i.id, cant:i.cant })),
    comprador: { nombre, correo, fono },
    retira,
    pago
  };
  const origen = estado.compraDirecta ? "directa" : "carrito";

  ocupado(boton, pago === "webpay" ? "Conectando con Webpay…" : "Enviando pedido…");

  // Si quedó a medias un pago Webpay anterior, primero se cancela:
  // si no, sus prendas siguen reservadas y parecerían agotadas.
  const anterior = leerPagoEnCurso();
  if (anterior && anterior.visto){
    borrarPagoEnCurso();   // ya terminó (rechazado o anulado) y se mostró
  } else if (anterior){
    const p = await cancelarPagoEnCurso(anterior);
    if (p && (p.estadoPago === "pendiente" || p.estadoPago === "pagado")){
      // Ese pago se está confirmando (o ya se pagó): no creamos otro pedido
      libre(boton);
      history.replaceState(null, "", "?pedido=" + encodeURIComponent(p.numero) + "&t=" + encodeURIComponent(anterior.token));
      await mostrarRetorno(p.numero, anterior.token);
      return;
    }
    if (p){ borrarPagoEnCurso(); estado.retenerCarrito = false; }
  }

  let r;
  try{
    r = await api("/api/pedidos", { metodo:"POST", cuerpo });
  }catch(err){
    libre(boton);
    if (err.estado === 409){ await manejarSinStock(err); return; }
    avisar(err.message);
    return;
  }

  if (pago === "webpay"){
    const url = r.webpay && r.webpay.url, token = r.webpay && r.webpay.token;
    if (!url || !token || !/^https?:\/\//i.test(url)){
      libre(boton);
      avisar("No pudimos conectar con Webpay. Intenta de nuevo en unos minutos.");
      return;
    }
    // Lo recordamos para reconocer el pedido cuando Webpay nos devuelva
    guardarPagoEnCurso({ numero:r.numero, token:r.token, origen, items:cuerpo.items });
    irAWebpay(url, token);   // el botón queda desactivado mientras el navegador cambia de página
    return;
  }

  // Transferencia o efectivo: el pedido ya quedó creado
  if (origen === "carrito"){ estado.carrito = []; guardarCarrito(); }
  estado.compraDirecta = null;
  actualizarContador();
  libre(boton);
  cargarCatalogo({ silencioso:true });   // el stock cambió
  history.replaceState(null, "", "?pedido=" + encodeURIComponent(r.numero) + "&t=" + encodeURIComponent(r.token));
  await mostrarRetorno(r.numero, r.token);
}

/* Webpay pide que el navegador llegue a su página con un formulario
   POST que lleve el campo token_ws. */
function irAWebpay(url, token){
  const formulario = document.createElement("form");
  formulario.method = "post";
  formulario.action = url;
  const campo = document.createElement("input");
  campo.type  = "hidden";
  campo.name  = "token_ws";
  campo.value = token;
  formulario.appendChild(campo);
  document.body.appendChild(formulario);
  formulario.submit();
}

/* El servidor respondió 409: alguna prenda se vendió mientras comprabas */
async function manejarSinStock(err){
  const ids = (err.datos && Array.isArray(err.datos.sinStock)) ? err.datos.sinStock : [];
  const nombres = ids.map(id => {
    const p = buscarPrenda(id);
    return p ? `${p.nombre} (${id})` : id;
  });

  await cargarCatalogo({ silencioso:true });
  if (estado.compraDirecta) estado.compraDirecta = ajustarLineas(estado.compraDirecta).lineas;

  avisar(nombres.length
    ? "Lo sentimos, se agotó: " + nombres.join(", ") + ". Actualizamos tu pedido."
    : err.message);

  if (!itemsActivos().length){ irACatalogo(); return; }
  pintarResumenPedido();
}

/* ================================================================
   VUELTA DESDE WEBPAY (?pedido=...&t=...) Y CONFIRMACIÓN
   ================================================================ */

// Nombres en palabras de los tipos de pago que informa Transbank
const TIPOS_PAGO = {
  VD: "Débito",
  VN: "Crédito",
  VC: "Crédito en cuotas",
  SI: "Crédito, 3 cuotas sin interés",
  S2: "Crédito, 2 cuotas sin interés",
  NC: "Crédito, cuotas sin interés",
  VP: "Prepago"
};

function tipoPagoEnPalabras(codigo){
  return TIPOS_PAGO[codigo] || codigo || "—";
}

function nombreMetodo(p){
  const pagado = p.estadoPago === "pagado";
  if (p.metodoPago === "webpay")        return pagado ? "Webpay (pagado)" : "Webpay";
  if (p.metodoPago === "transferencia") return pagado ? "Transferencia (pagada)" : "Transferencia (por pagar)";
  if (p.metodoPago === "efectivo")      return pagado ? "Efectivo (pagado)" : "Efectivo al retirar";
  return p.metodoPago || "";
}

function nombreRetira(tipo){
  return tipo === "apoderado" ? "Apoderado/a" : tipo === "estudiante" ? "Estudiante" : "Tercero autorizado";
}

async function mostrarRetorno(numero, t){
  $("#vistaConfirmacion").innerHTML = `
    <div class="contenedor" style="max-width:760px">
      <div class="caja exito">
        <h2>Cargando tu pedido…</h2>
        <p style="color:var(--tenue)">Un momento, por favor.</p>
      </div>
    </div>`;
  mostrarVista("Confirmacion");

  let p;
  try{
    const r = await api("/api/pedidos/" + encodeURIComponent(numero) + "?t=" + encodeURIComponent(t));
    p = r.pedido;
    if (!p) throw Object.assign(new Error("No encontramos tu pedido."), { estado:404 });
  }catch(err){
    if (err.estado === 404) pintarErrorPago();
    else pintarErrorCarga(err.message);
    return;
  }

  await estado.cargaConfig;
  estado.pedidoRetorno = p;
  estado.pedidoVisto   = { numero:p.numero, t };

  const enCurso = leerPagoEnCurso();
  const esMio   = enCurso && enCurso.numero === p.numero;

  if (p.estadoPago === "pagado"){
    // Pago listo: ahora sí vaciamos el carrito (si la compra salió de ahí)
    if (esMio){
      if (enCurso.origen === "carrito"){ estado.carrito = []; guardarCarrito(); actualizarContador(); }
      borrarPagoEnCurso();
    }
    pintarConfirmacion(p);
  } else if (p.metodoPago === "webpay" && (p.estadoPago === "rechazado" || p.estadoPago === "anulado")){
    // Se marca como visto: así no vuelve a avisarse, pero "Intentar de nuevo"
    // sigue sabiendo si la compra salió del carrito o fue directa.
    if (esMio) guardarPagoEnCurso({ ...enCurso, visto:true });
    pintarPagoFallido(p);
  } else if (p.estadoPago === "pendiente" && p.metodoPago === "webpay"){
    // Las prendas siguen reservadas: no limpiamos el carrito todavía
    estado.retenerCarrito = true;
    pintarPagoPendiente(p);
  } else if (p.estadoPago === "pendiente"){
    pintarConfirmacion(p);
  } else {
    // Reembolsado o anulado por el ropero: lo mostramos como en "Mis pedidos"
    pintarPedido(p);
    mostrarVista("Pedidos");
    return;
  }
  mostrarVista("Confirmacion");
}

function comprobanteWebpay(p){
  const pg = p.pago;
  return `
    <div class="caja">
      <h3>Comprobante de pago</h3>
      <p class="ayuda">Pago aprobado por Webpay Plus (Transbank).</p>
      <table>
        <tr><th>Comercio</th><td>${escapar(CONFIG.nombreSitio || "Ropero SG")}</td></tr>
        <tr><th>Orden de compra</th><td>${escapar(pg.ordenCompra)}</td></tr>
        <tr><th>Monto</th><td><strong>${plata(pg.monto)}</strong></td></tr>
        <tr><th>Código de autorización</th><td>${escapar(pg.codigoAutorizacion)}</td></tr>
        <tr><th>Fecha</th><td>${escapar(fechaHora(pg.fecha))}</td></tr>
        <tr><th>Tipo de pago</th><td>${escapar(tipoPagoEnPalabras(pg.tipoPago))}</td></tr>
        <tr><th>Cuotas</th><td>${Number(pg.cuotas) > 0 ? escapar(pg.cuotas) : "Sin cuotas"}</td></tr>
        <tr><th>Tarjeta</th><td>**** ${escapar(pg.tarjeta)}</td></tr>
      </table>
    </div>`;
}

function pintarConfirmacion(p){
  const datosTransferencia = (p.datosTransferencia || "").trim();
  $("#vistaConfirmacion").innerHTML = `
    <div class="contenedor" style="max-width:760px">
      <div class="caja exito">
        <div class="tic">✓</div>
        <h2>¡Pedido confirmado!</h2>
        <p style="color:var(--tenue)">${correoActivo()
          ? `Te enviamos el detalle a ${escapar(p.comprador && p.comprador.correo)}.`
          : "Guarda este número de pedido."}</p>
        <div class="numero">${escapar(p.numero)}</div>
        <p style="color:var(--tenue);font-size:.9rem">Anota este número: lo necesitas para retirar y para pedir un reembolso.</p>
      </div>

      ${p.metodoPago === "webpay" && p.pago ? comprobanteWebpay(p) : ""}

      <div class="caja">
        <h3>Retiro</h3>
        <p class="ayuda">${escapar(CONFIG.lugarRetiro)}</p>
        <table>
          <tr><th>Retira</th><td>${escapar(p.retira.nombre)} ${p.retira.extra ? "· " + escapar(p.retira.extra) : ""}
            <span class="pastilla gris">${nombreRetira(p.retira.tipo)}</span></td></tr>
          <tr><th>Horario</th><td>${escapar(CONFIG.horarioRetiro)}</td></tr>
          <tr><th>Pago</th><td>${escapar(nombreMetodo(p))}</td></tr>
          <tr><th>Total</th><td><strong>${plata(p.total)}</strong></td></tr>
        </table>
        ${p.metodoPago === "transferencia" && p.estadoPago === "pendiente" ? `
          <div class="aviso" style="margin-top:16px">
            <strong>Datos de transferencia:</strong><br>
            ${datosTransferencia
              ? `<span class="texto-multilinea">${escapar(datosTransferencia)}</span><br>`
              : `Escríbenos a ${escapar(CONFIG.correo)} y te enviamos los datos de la cuenta.<br>`}
            Envía el comprobante indicando el número de pedido.
          </div>` : ""}
      </div>

      <div style="display:flex;gap:11px;flex-wrap:wrap;padding-bottom:60px">
        <button class="btn btn-azul" onclick="irACatalogo()">Volver al catálogo</button>
        <button class="btn btn-linea" onclick="irAPedidos()">Ver mis pedidos</button>
        <button class="btn btn-fantasma" onclick="window.print()">Imprimir comprobante</button>
      </div>
    </div>`;
}

function pintarPagoFallido(p){
  $("#vistaConfirmacion").innerHTML = `
    <div class="contenedor" style="max-width:760px">
      <div class="caja exito">
        <div class="tic error">✕</div>
        <h2>El pago no se completó</h2>
        <p style="color:var(--tenue)">No se hizo ningún cargo. Puedes intentarlo de nuevo cuando quieras.</p>
        <div class="numero">${escapar(p.numero)}</div>
      </div>
      <div style="display:flex;gap:11px;flex-wrap:wrap;padding-bottom:60px">
        <button class="btn btn-dorado" id="btnReintentar" onclick="reintentarPago()">Intentar de nuevo</button>
        <button class="btn btn-azul" onclick="irACatalogo()">Volver al catálogo</button>
      </div>
    </div>`;
}

function pintarPagoPendiente(p){
  $("#vistaConfirmacion").innerHTML = `
    <div class="contenedor" style="max-width:760px">
      <div class="caja exito">
        <div class="tic espera">…</div>
        <h2>Estamos confirmando tu pago</h2>
        <p style="color:var(--tenue)">Esto puede tardar unos minutos. Si ya pagaste, no vuelvas a pagar:
          recarga esta página en un momento. Si sigue así, escríbenos a ${escapar(CONFIG.correo)}.</p>
        <div class="numero">${escapar(p.numero)}</div>
      </div>
      <div style="display:flex;gap:11px;flex-wrap:wrap;padding-bottom:60px">
        <button class="btn btn-azul" onclick="location.reload()">Recargar</button>
        <button class="btn btn-fantasma" onclick="irACatalogo()">Volver al catálogo</button>
      </div>
    </div>`;
}

function pintarErrorPago(){
  $("#vistaConfirmacion").innerHTML = `
    <div class="contenedor" style="max-width:760px">
      <div class="caja exito">
        <div class="tic error">!</div>
        <h2>No pudimos confirmar tu pago</h2>
        <p style="color:var(--tenue)">Algo salió mal al volver de Webpay y no pudimos identificar tu pedido.
          Si ves un cargo en tu tarjeta, escríbenos a ${escapar(CONFIG.correo)} y lo revisamos.</p>
      </div>
      <div style="display:flex;gap:11px;flex-wrap:wrap;padding-bottom:60px">
        <button class="btn btn-azul" onclick="irACatalogo()">Volver al catálogo</button>
        <button class="btn btn-linea" onclick="irAPedidos()">Ver mis pedidos</button>
      </div>
    </div>`;
  mostrarVista("Confirmacion");
}

function pintarErrorCarga(mensaje){
  $("#vistaConfirmacion").innerHTML = `
    <div class="contenedor" style="max-width:760px">
      <div class="caja exito">
        <div class="tic error">!</div>
        <h2>No pudimos cargar tu pedido</h2>
        <p style="color:var(--tenue)">${escapar(mensaje)}</p>
      </div>
      <div style="display:flex;gap:11px;flex-wrap:wrap;padding-bottom:60px">
        <button class="btn btn-azul" onclick="location.reload()">Reintentar</button>
        <button class="btn btn-fantasma" onclick="irACatalogo()">Volver al catálogo</button>
      </div>
    </div>`;
  mostrarVista("Confirmacion");
}

/* ---------- Pago Webpay que quedó a medias ----------
   Si el comprador vuelve de Webpay sin pagar (botón "Atrás", o abre de
   nuevo la tienda en esta pestaña), su pedido seguiría reservando las
   prendas. Le pedimos al servidor que lo cancele. */

/* Devuelve el pedido con su estado actual, o null si no se pudo preguntar. */
async function cancelarPagoEnCurso(enCurso){
  try{
    const r = await api("/api/pedidos/" + encodeURIComponent(enCurso.numero) + "/cancelar",
                        { metodo:"POST", cuerpo:{ t:enCurso.token } });
    return r.pedido || null;
  }catch(e){
    if (e.estado === 404) borrarPagoEnCurso();   // ese pedido no existe: lo olvidamos
    return null;
  }
}

/* Si quedó un pago a medias, lo cancela y muestra cómo quedó.
   Sin conexión no hace nada: la tienda sigue funcionando. */
async function revisarPagoAbandonado(){
  const enCurso = leerPagoEnCurso();
  if (!enCurso) return;
  if (enCurso.visto){ borrarPagoEnCurso(); return; }   // ese resultado ya se mostró
  const p = await cancelarPagoEnCurso(enCurso);
  if (!p){
    // Sin conexión: no tocamos el carrito (sus prendas siguen reservadas por ese
    // pedido); confirmarPedido() lo vuelve a intentar antes de crear otro.
    if (leerPagoEnCurso()) estado.retenerCarrito = true;
    return;
  }

  if (p.estadoPago === "pagado" || p.estadoPago === "pendiente"){
    // Ya se pagó, o Webpay lo está confirmando justo ahora: mostramos ese pedido
    history.replaceState(null, "", "?pedido=" + encodeURIComponent(p.numero) + "&t=" + encodeURIComponent(enCurso.token));
    await mostrarRetorno(p.numero, enCurso.token);
    return;
  }
  borrarPagoEnCurso();
  if (p.estadoPago === "anulado" || p.estadoPago === "rechazado"){
    avisar("Tu pago en Webpay no se completó. No se hizo ningún cargo; " +
      (enCurso.origen === "directa" ? "puedes volver a comprarla." : "tus prendas siguen en el carrito."));
  }
}

/* "Intentar de nuevo": vuelve al checkout con el mismo carrito
   o con la misma compra directa. */
async function reintentarPago(){
  const boton = $("#btnReintentar");
  ocupado(boton, "Cargando…");
  await estado.cargaCatalogo;
  if (!estado.catalogoListo) await cargarCatalogo({ silencioso:true });
  libre(boton);
  if (!estado.catalogoListo){ avisar("No pudimos cargar el catálogo. Intenta de nuevo."); return; }

  const p = estado.pedidoRetorno;
  const enCurso = leerPagoEnCurso();
  const esMio = enCurso && p && enCurso.numero === p.numero;

  let directa = null;
  if (esMio && enCurso.origen === "directa" && Array.isArray(enCurso.items)){
    directa = enCurso.items;
  } else if (!estado.carrito.length && p){
    // Por ejemplo, si el link se abrió en otra pestaña: usamos las prendas del pedido
    directa = p.items.map(i => ({ id:i.id, cant:i.cant }));
  }
  borrarPagoEnCurso();

  if (directa){
    const r = ajustarLineas(directa);
    if (r.quitadas.length) avisar("Algunas prendas de ese pedido ya no están disponibles.");
    estado.compraDirecta = r.lineas;
  }

  // Ahorramos tipear de nuevo el nombre y el correo
  if (p && p.comprador){
    if (!$("#compNombre").value) $("#compNombre").value = p.comprador.nombre || "";
    if (!$("#compCorreo").value) $("#compCorreo").value = p.comprador.correo || "";
  }

  if (directa){
    if (!estado.compraDirecta.length){ estado.compraDirecta = null; irACatalogo(); return; }
    irACheckout(true);
  } else {
    irACheckout();
  }
}

/* ================================================================
   MIS PEDIDOS Y REEMBOLSOS
   ================================================================ */

function pintarBuscadorPedidos(){
  $("#resultadoPedidos").innerHTML = "";
}

async function buscarPedido(){
  const numero = $("#buscarNumero").value.trim().toUpperCase();
  const correo = $("#buscarCorreo").value.trim().toLowerCase();
  if (!numero || !correo){ avisar("Escribe el número de pedido y el correo de la compra."); return; }

  const boton = $("#btnBuscarPedido");
  if (boton.disabled) return;
  ocupado(boton, "Buscando…");
  try{
    const r = await api("/api/pedidos/buscar", { metodo:"POST", cuerpo:{ numero, correo } });
    estado.pedidoVisto = { numero:r.pedido.numero, correo };
    pintarPedido(r.pedido);
  }catch(err){
    if (err.estado === 404){
      $("#resultadoPedidos").innerHTML = `
        <div class="aviso">No encontramos un pedido con ese número y ese correo. Revisa que
        coincidan exactamente con los del comprobante.</div>`;
    } else if (err.estado === 429){
      $("#resultadoPedidos").innerHTML = `<div class="aviso">${escapar(err.message)}</div>`;
    } else {
      avisar(err.message);
    }
  }finally{
    libre(boton);
  }
}

function diasDesde(iso){
  return Math.max(0, Math.floor((Date.now() - new Date(iso)) / 86400000));
}

function pastillaPago(estadoPago){
  return {
    pagado:      '<span class="pastilla verde">Pagado</span>',
    pendiente:   '<span class="pastilla ambar">Pendiente</span>',
    rechazado:   '<span class="pastilla roja">Pago rechazado</span>',
    anulado:     '<span class="pastilla gris">Anulado</span>',
    reembolsado: '<span class="pastilla gris">Reembolsado</span>'
  }[estadoPago] || `<span class="pastilla gris">${escapar(estadoPago)}</span>`;
}

function pintarPedido(p){
  const dias = diasDesde(p.creadoEn);
  const plazo = estado.config.diasReembolso ?? CONFIG.diasReembolso;
  const entrega = p.entrega === "entregado" ? "Entregado"
    : ["anulado", "rechazado", "reembolsado"].includes(p.estadoPago) ? "No aplica"
    : "Por retirar";

  const estadoReembolso = p.reembolso ? ({
    solicitado:'<span class="pastilla ambar">Reembolso en revisión</span>',
    aprobado:  '<span class="pastilla verde">Reembolso aprobado</span>',
    rechazado: '<span class="pastilla roja">Reembolso rechazado</span>',
    devuelto:  '<span class="pastilla verde">Dinero devuelto</span>'
  }[p.reembolso.estado] || "") : "";

  let sinReembolso;
  if (p.estadoPago === "pendiente")
    sinReembolso = "Este pedido todavía no está pagado, así que no hay nada que devolver. Si ya no lo quieres, avísanos por correo y lo anulamos.";
  else if (p.estadoPago === "pagado")
    sinReembolso = `El plazo de ${escapar(plazo)} días ya venció. Escríbenos a ${escapar(CONFIG.correo)} y lo vemos caso a caso.`;
  else
    sinReembolso = "Este pedido no tiene un pago que devolver.";

  $("#resultadoPedidos").innerHTML = `
    <div class="caja">
      <h3>Pedido ${escapar(p.numero)}</h3>
      <p class="ayuda">${escapar(fechaHora(p.creadoEn))} · ${dias} día(s) atrás</p>
      <table>
        <tr><th>Estado del pago</th><td>${pastillaPago(p.estadoPago)} ${estadoReembolso}</td></tr>
        <tr><th>Forma de pago</th><td>${escapar(nombreMetodo(p))}</td></tr>
        ${p.pago ? `<tr><th>Pago Webpay</th><td>Autorización ${escapar(p.pago.codigoAutorizacion)}
          · Tarjeta **** ${escapar(p.pago.tarjeta)} · ${escapar(tipoPagoEnPalabras(p.pago.tipoPago))}
          · ${escapar(fechaHora(p.pago.fecha))}</td></tr>` : ""}
        <tr><th>Entrega</th><td>${entrega}</td></tr>
        <tr><th>Retira</th><td>${escapar(p.retira.nombre)} ${p.retira.extra ? "· "+escapar(p.retira.extra) : ""}</td></tr>
        <tr><th>Total</th><td><strong>${plata(p.total)}</strong></td></tr>
      </table>

      <h3 style="margin-top:22px">Prendas</h3>
      <div class="tabla-marco" style="margin-top:10px">
        <table>
          <thead><tr><th>Código</th><th>Prenda</th><th>Talla</th><th>Cant.</th><th>Precio</th></tr></thead>
          <tbody>${(p.items || []).map(i => `<tr>
            <td>${escapar(i.id)}</td><td>${escapar(i.nombre)}</td>
            <td>${escapar(i.talla)}</td><td>${escapar(i.cant)}</td><td>${plata(i.precio*i.cant)}</td>
          </tr>`).join("")}</tbody>
        </table>
      </div>

      <h3 style="margin-top:24px">Reembolso</h3>
      ${p.reembolso ? `
        <p class="ayuda">Solicitado el ${escapar(fechaCorta(p.reembolso.solicitadoEn))}</p>
        <p><strong>Motivo:</strong> ${escapar(p.reembolso.motivo)}</p>
        <p style="margin-top:8px">${estadoReembolso}</p>
        ${p.reembolso.respuesta ? `<div class="aviso info" style="margin-top:12px">${escapar(p.reembolso.respuesta)}</div>` : ""}
      ` : p.puedePedirReembolso ? `
        <p class="ayuda">Tienes ${escapar(plazo)} días desde la compra para pedir la devolución.
          Quedan ${escapar(p.diasRestantesReembolso)} día(s).</p>
        <div class="campo">
          <label for="motivoReembolso">¿Qué pasó?</label>
          <textarea id="motivoReembolso" rows="3" maxlength="1000" placeholder="Ej: la talla no le quedó, el estado no coincide con la descripción…"></textarea>
        </div>
        <button class="btn btn-azul" id="btnReembolso" onclick="pedirReembolso(${jsSeguro(p.numero)})">Solicitar reembolso</button>
      ` : `
        <div class="aviso info">${sinReembolso}</div>`}
    </div>`;
}

async function pedirReembolso(numero){
  const motivo = $("#motivoReembolso").value.trim();
  if (motivo.length < 10){ avisar("Cuéntanos un poco más del motivo (mínimo 10 caracteres)."); return; }
  if (motivo.length > 1000){ avisar("El motivo es muy largo (máximo 1000 caracteres)."); return; }

  const visto = estado.pedidoVisto;
  if (!visto || visto.numero !== numero){ avisar("Vuelve a buscar tu pedido e intenta de nuevo."); return; }

  // El servidor nos reconoce con el correo de la compra o con el token del comprobante
  const cuerpo = { motivo };
  if (visto.correo) cuerpo.correo = visto.correo;
  else cuerpo.t = visto.t;

  const boton = $("#btnReembolso");
  if (boton.disabled) return;
  ocupado(boton, "Enviando…");
  try{
    const r = await api("/api/pedidos/" + encodeURIComponent(numero) + "/reembolso", { metodo:"POST", cuerpo });
    pintarPedido(r.pedido);
    avisar("Solicitud enviada. El ropero la revisa los miércoles.");
  }catch(err){
    libre(boton);
    avisar(err.message);
  }
}

/* ================================================================
   AVISOS
   ================================================================ */

function avisar(texto){
  let caja = $("#avisoFlotante");
  if (!caja){
    caja = document.createElement("div");
    caja.id = "avisoFlotante";
    caja.setAttribute("role", "status");
    caja.style.cssText = "position:fixed;left:50%;bottom:26px;transform:translateX(-50%);"+
      "background:#142A57;color:#fff;padding:13px 22px;border-radius:999px;z-index:200;"+
      "box-shadow:0 8px 24px rgba(0,0,0,.25);font-size:.9rem;max-width:90vw;text-align:center";
    document.body.appendChild(caja);
  }
  caja.textContent = texto;
  caja.style.display = "block";
  clearTimeout(caja._t);
  // Los mensajes largos se quedan un poco más en pantalla
  caja._t = setTimeout(() => caja.style.display = "none", Math.max(3800, texto.length * 60));
}

/* ================================================================
   ARRANQUE
   ================================================================ */

function iniciar(){
  // Llaves de la versión anterior, cuando todo se guardaba en el navegador
  almacen.borrar("ropero_prendas");
  almacen.borrar("ropero_pedidos");

  $("#tituloPortada").textContent = CONFIG.tituloPortada;
  $("#textoPortada").textContent  = CONFIG.textoPortada;
  $("#horarioPortada").textContent = "Retiro: " + CONFIG.horarioRetiro;
  $$(".js-horario").forEach(e => e.textContent = CONFIG.horarioRetiro);
  $$(".js-lugar").forEach(e => e.textContent = CONFIG.lugarRetiro);
  $$(".js-correo").forEach(e => { e.textContent = CONFIG.correo; e.href = "mailto:"+CONFIG.correo; });
  $$(".js-instagram").forEach(e => e.href = CONFIG.instagram);

  const campo = $("#campoBusqueda");
  let temporizador;
  campo.addEventListener("input", () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => {
      estado.busqueda = campo.value;
      irACatalogo();
      pintarCatalogo();
    }, 220);
  });

  $("#ordenar").addEventListener("change", e => { estado.orden = e.target.value; pintarCatalogo(); });

  document.addEventListener("keydown", e => {
    if (e.key === "Escape"){ cerrarFicha(); cerrarPanel(); }
  });

  // Si alguien vuelve con el botón "Atrás" desde Webpay, el navegador puede
  // mostrar la página guardada con el botón desactivado: lo reactivamos
  // y cancelamos el pago que quedó a medias (luego se recarga el catálogo).
  window.addEventListener("pageshow", e => {
    if (!e.persisted) return;
    $$("button[data-texto]").forEach(libre);
    if (!new URLSearchParams(location.search).get("pedido") && leerPagoEnCurso()){
      estado.retornoListo = revisarPagoAbandonado();
      estado.retornoListo.catch(() => {}).then(() => cargarCatalogo());
    }
  });

  pintarFiltros();
  actualizarContador();

  // En pantallas chicas el panel de filtros parte cerrado
  if (window.innerWidth <= 1000) $("#panelFiltros").classList.add("plegado");

  cargarConfig();

  // ¿Venimos de vuelta de Webpay o de un link de comprobante?
  const params = new URLSearchParams(location.search);
  const numero = params.get("pedido"), t = params.get("t");
  if (numero && t){
    estado.retornoListo = mostrarRetorno(numero, t);
    cargarCatalogo();
  } else {
    if (params.get("pago") === "error") pintarErrorPago();
    // Primero se cancela un pago Webpay que haya quedado a medias y después
    // se pide el catálogo: así trae el stock devuelto y el carrito no pierde esas prendas.
    estado.retornoListo = revisarPagoAbandonado();
    estado.retornoListo.catch(() => {}).then(() => cargarCatalogo());
  }
}

document.addEventListener("DOMContentLoaded", iniciar);

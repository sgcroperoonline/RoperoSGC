/* ================================================================
   ROPERO SG — ARCHIVO DE DATOS
   ----------------------------------------------------------------
   ESTE ES EL ARCHIVO QUE NECESITAS TOCAR PARA:
     · cambiar textos, horarios y contacto        -> CONFIG
     · activar o desactivar medios de pago        -> CONFIG.pagos
     · cambiar la pauta de estados y sus colores  -> ESTADOS
     · agregar tallas, marcas o tipos de prenda   -> LISTAS

   Las PRENDAS ya no van aquí: ahora viven en la base de datos y se
   agregan, editan y borran desde el panel de voluntarias (admin.html).

   Este archivo lo leen las páginas Y el servidor, así que lo que
   cambies acá se respeta en los dos lados (por ejemplo, un medio de
   pago apagado aquí tampoco lo acepta el servidor).

   Regla de oro: cada coma y cada llave importan. Si algo deja de
   funcionar, abre la consola del navegador (F12 -> Console).
   ================================================================ */


/* ----------------------------------------------------------------
   1) CONFIGURACIÓN GENERAL
   ---------------------------------------------------------------- */
export const CONFIG = {
  nombreSitio:   "Ropero SG",
  bajada:        "Uniformes de segunda mano · Saint George's College",

  // Texto de la portada
  tituloPortada: "Bienvenidos a Ropero SG",
  textoPortada:  "Uniformes recuperados, revisados y clasificados por apoderadas voluntarias. Comprar aquí alarga la vida de cada prenda y financia becas del viaje de estudios de 11° grado.",

  // Retiro presencial
  lugarRetiro:   "Ropero, Saint George's College — Av. Santa Cruz 5400, Vitacura",
  horarioRetiro: "Miércoles de 8:00 a 13:30 h",

  // Contacto
  instagram:     "https://www.instagram.com/roperosgc/",
  paginaColegio: "https://saintgeorge.cl/familia/ropero/",
  correo:        "ropero@saintgeorge.cl",   // <-- CAMBIAR por el correo real

  // Medios de pago (true = se ofrece en la tienda y el servidor lo acepta)
  pagos: {
    webpay:        true,    // Webpay Plus de Transbank: crédito, débito y prepago
    transferencia: false,   // queda pendiente hasta que una voluntaria la marque pagada
    efectivo:      false    // se paga al retirar en el ropero
  },

  // Solo se muestra si pagos.transferencia está en true.
  // Escribe aquí los datos REALES de la cuenta antes de activarla.
  datosTransferencia: "",

  // Días que tiene el comprador para pedir reembolso
  diasReembolso: 7
};


/* ----------------------------------------------------------------
   2) PAUTA DE ESTADOS
   Cambia aquí los nombres, colores y criterios. La página de la
   pauta (pauta.html) y los puntos de color se generan desde acá.
   No cambies las claves (nuevo, excelente, bueno, usado): son las
   que quedan guardadas en la base de datos.
   ---------------------------------------------------------------- */
export const ESTADOS = {
  nuevo: {
    etiqueta: "Nuevo",
    color:    "#0B5FD8",
    resumen:  "Sin uso. Puede conservar la etiqueta original.",
    criterios: [
      "Nunca fue usada o se usó una o dos veces",
      "Sin desgaste, pilling, manchas ni deformación",
      "Insignia y botones completos y firmes",
      "Cierres y elásticos como nuevos"
    ]
  },
  excelente: {
    etiqueta: "Excelente",
    color:    "#00A651",
    resumen:  "Uso leve. Se ve prácticamente igual a una prenda nueva.",
    criterios: [
      "Color parejo, sin decoloración visible",
      "Sin manchas, roturas ni zurcidos",
      "Máximo pilling muy leve en zonas de roce",
      "Insignia completa, cierres funcionando"
    ]
  },
  bueno: {
    etiqueta: "Bueno",
    color:    "#F58220",
    resumen:  "Uso visible pero prenda entera y presentable para el día a día.",
    criterios: [
      "Leve decoloración o pilling notorio",
      "Puede tener una reparación bien hecha (basta, botón cambiado)",
      "Sin agujeros ni manchas que no salgan",
      "Insignia presente aunque algo gastada"
    ]
  },
  usado: {
    etiqueta: "Usado",
    color:    "#E8272C",
    resumen:  "Sirve para deporte, talleres o emergencias. Precio más bajo.",
    criterios: [
      "Decoloración clara, pilling generalizado o bastas gastadas",
      "Puede tener una marca pequeña que no sale",
      "Se indica el defecto en la ficha de la prenda",
      "No se venden prendas rotas: esas van a reciclaje con CIRKLA"
    ]
  }
};


/* ----------------------------------------------------------------
   3) LISTAS DE LOS FILTROS
   Si necesitas un tipo, marca o talla nuevos, agrégalos acá: así
   aparecen en el panel de filtros y en el formulario del panel.
   ---------------------------------------------------------------- */
export const LISTAS = {
  tipos:  ["Polera", "Buzo", "Polar", "Blazer", "Blusa", "Camisa",
           "Falda", "Pantalón", "Parka", "Chaleco", "Corbata", "Calcetas", "Short"],

  marcas: ["First Option", "Uniformes Sport", "Falabella", "Vestuario Escolar",
           "Sin marca", "Otra"],

  tallas: ["4", "6", "8", "10", "12", "14", "16",
           "XS", "S", "M", "L", "XL"]
};


/* No tocar: deja los datos disponibles para tienda.js, admin.js y pauta.html */
if (typeof window !== "undefined") Object.assign(window, { CONFIG, ESTADOS, LISTAS });

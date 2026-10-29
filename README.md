# Ropero SG — tienda online

Venta online de uniformes de segunda mano del Saint George's College.
Catálogo, carrito, pago con **Webpay Plus** (Transbank), retiro en el colegio, "Mis pedidos" con
reembolsos y un panel para las apoderadas voluntarias. Todo queda guardado en una base de datos.

---

## 1. Cómo está armado

| Pieza | Qué es | Dónde está |
|---|---|---|
| Páginas | HTML, CSS y JavaScript sin compilar (las mismas del prototipo) | `public/` |
| Servidor (backend) | Un *Cloudflare Worker* con [Hono](https://hono.dev): recibe los pedidos, habla con Webpay y manda los correos | `src/` |
| Base de datos | **Cloudflare D1** (SQLite): prendas, pedidos, transacciones y reembolsos | `migrations/` |
| Pagos | **Webpay Plus** de Transbank (crédito, débito y prepago) | `src/webpay.js` |
| Correos | Comprobante al comprador y aviso al ropero, por SMTP (por ejemplo Gmail) | `src/correo.js` |

**Por qué Cloudflare:** el plan gratis alcanza de sobra para el ropero, no tiene "arranque en frío"
(la página responde al instante aunque nadie la haya visitado en días) y permite uso con pagos.
Páginas, servidor y base de datos quedan en un solo lugar.

```
Comprador ──► public/index.html ──► /api/... (src/) ──► Base de datos D1
                    │                      │
                    └── paga en Webpay ◄───┘──► correo de confirmación
```

### Qué guarda la base de datos

No hay cuentas de usuario: el comprador se identifica con su **número de pedido y su correo**.

| Tabla | Qué guarda |
|---|---|
| `productos` | Cada prenda: código, nombre, tipo, marca, talla, estado, precio, stock, observaciones, foto, si está publicada |
| `imagenes` | Las fotos que se suben desde el panel |
| `pedidos` | Número de pedido (`RSG-2026-1001`), comprador, quién retira, medio de pago, estado del pago, entrega y total |
| `pedido_items` | Las prendas de cada pedido **con sus características al momento de la compra** (aunque después se borre la prenda) |
| `transacciones` | Cada intento de pago y cada devolución en Webpay: token, orden de compra, monto, resultado, código de autorización, últimos 4 dígitos, tipo de pago, cuotas y la respuesta completa de Transbank |
| `reembolsos` | Solicitudes de reembolso: motivo, respuesta del ropero y estado |

---

## 2. Qué contiene cada archivo

| Archivo | Qué hace | ¿Lo vas a editar? |
|---|---|---|
| `public/js/datos.js` | **Textos, horarios, contacto, medios de pago, pauta de estados, tallas, marcas, tipos** | **Sí, este es TU archivo** |
| `public/index.html` + `public/js/tienda.js` | Catálogo, filtros, ficha, carrito, pago y "Mis pedidos" | Solo textos fijos |
| `public/admin.html` + `public/js/admin.js` | Panel de las voluntarias | Casi nunca |
| `public/pauta.html` | Pauta de estados (se arma sola desde `datos.js`) | Nunca |
| `public/css/estilos.css` | Colores y tipografía (todo arriba, en `:root`) | Solo para cambiar la paleta |
| `public/img/prendas/` | Fotos de las 12 prendas de ejemplo | No |
| `src/` | El servidor | No, salvo que sepas lo que haces |
| `migrations/` | La estructura de la base de datos | No |
| `seed/prendas-iniciales.sql` | Las 12 prendas de ejemplo del prototipo (opcional) | No |
| `wrangler.jsonc` | Configuración de Cloudflare (nombre, base de datos, variables) | Al publicar |
| `test/` | Pruebas automáticas | No |

Las **prendas ya no se escriben en `datos.js`**: se agregan, editan y borran desde el panel
(`admin.html`) y quedan en la base de datos. Las ve todo el mundo al instante.

---

## 3. Probarlo en tu computador

Necesitas [Node.js](https://nodejs.org) 20 o más nuevo y Visual Studio Code.

```bash
npm install                      # instala lo necesario (una sola vez)
cp .dev.vars.example .dev.vars   # claves locales: abre .dev.vars y elige una ADMIN_CLAVE
npm run db:migrar                # crea las tablas en una base de datos local
npm run db:semilla               # (opcional) carga las 12 prendas de ejemplo
npm run dev                      # abre http://localhost:8787
```

En tu computador Webpay funciona en **modo de pruebas** (ambiente de integración de Transbank):
nadie paga de verdad. Para "pagar" usa la tarjeta de prueba de Transbank:

| Dato | Valor |
|---|---|
| Tarjeta Visa (aprueba) | `4051 8856 0044 6623` · CVV `123` · cualquier fecha futura |
| Tarjeta Mastercard (rechaza) | `5186 0595 5959 0568` · CVV `123` · cualquier fecha futura |
| RUT y clave en la pantalla del banco | `11.111.111-1` y `123` |

Mientras Webpay esté en modo de pruebas, la tienda lo avisa en el paso de pago. Ese aviso
desaparece solo cuando se configura la producción (punto 5).

Panel de voluntarias: `http://localhost:8787/admin.html`, con la `ADMIN_CLAVE` de tu `.dev.vars`.

---

## 4. Publicarlo gratis en Cloudflare

1. Crea una cuenta gratis en [dash.cloudflare.com](https://dash.cloudflare.com/sign-up).
2. En la carpeta del proyecto:

   ```bash
   npx wrangler login                  # abre el navegador para autorizar
   npx wrangler d1 create ropero-sg    # crea la base de datos
   ```

   Copia el `database_id` que aparece y pégalo en `wrangler.jsonc`, en lugar de
   `00000000-0000-0000-0000-000000000000`.
3. Crea las tablas (y, si quieres, las prendas de ejemplo):

   ```bash
   npm run db:migrar:remoto
   npm run db:semilla:remoto           # opcional
   ```
4. Guarda la clave del panel (te la pide sin mostrarla en pantalla):

   ```bash
   npx wrangler secret put ADMIN_CLAVE
   ```
5. Publica:

   ```bash
   npm run deploy
   ```

   Queda en `https://ropero-sg.TU-SUBDOMINIO.workers.dev`. Escribe esa dirección en
   `URL_PUBLICA` dentro de `wrangler.jsonc` (sirve para los links de los correos y el retorno
   de Webpay) y vuelve a correr `npm run deploy`.

**Publicar solo con cada cambio en GitHub (opcional):** en el panel de Cloudflare, *Workers &
Pages* → `ropero-sg` → *Settings* → *Builds* → conecta este repositorio. Desde ahí cada `push`
a `main` se publica solo.

**Dirección propia (opcional):** si el colegio quiere algo como `ropero.saintgeorge.cl`, se
agrega en *Settings* → *Domains & Routes* del Worker. Requiere que el dominio esté en
Cloudflare o que el área de informática del colegio cree el registro DNS.

Para revisar la base de datos publicada: panel de Cloudflare → *Storage & Databases* → *D1* →
`ropero-sg` → *Console*, o desde la terminal:

```bash
npx wrangler d1 execute DB --remote --command "SELECT numero, comprador_nombre, total, estado_pago FROM pedidos ORDER BY id DESC LIMIT 20"
npx wrangler d1 export DB --remote --output respaldo.sql      # respaldo completo
```

---

## 5. Cobrar de verdad con Webpay (producción)

Mientras no hagas esto, **Webpay está en modo de pruebas y no se cobra nada**.

1. El colegio (o el centro de apoderados) contrata **Webpay Plus** con Transbank y recibe un
   **código de comercio**. El README del prototipo indicaba que el colegio ya usa Webpay:
   pregunten si pueden usar ese convenio o si Transbank les da un código nuevo.
2. Transbank pide un **proceso de validación** antes de entregar la llave de producción: hay
   que hacer compras de prueba en el ambiente de integración (punto 3) y enviarles la evidencia
   que piden en [transbankdevelopers.cl](https://www.transbankdevelopers.cl).
3. Con el código y la llave secreta (*API Key Secret*) que entrega Transbank:
   - En `wrangler.jsonc`: `"WEBPAY_AMBIENTE": "produccion"` y
     `"WEBPAY_CODIGO_COMERCIO": "<tu código>"`.
   - La llave, como secreto: `npx wrangler secret put WEBPAY_API_KEY`
   - `npm run deploy`

Si `WEBPAY_AMBIENTE` dice `produccion` pero falta la llave propia o el código de comercio
sigue siendo el de pruebas, el servidor no acepta pagos con Webpay (la tienda muestra un
mensaje de error). Así nunca se mezclan credenciales de prueba con cobros reales.

**Reembolsos:** cuando una voluntaria aprueba un reembolso en el panel, el servidor le pide a
Webpay que devuelva el dinero a la tarjeta. Si Webpay no puede (por ejemplo, pasaron muchos días
o era tarjeta de débito y el banco no lo permite), el panel muestra el error y deja reintentar o
marcar la devolución como hecha a mano.

**Pagos abandonados:** si alguien entra a Webpay y vuelve a la tienda sin pagar, su pedido se
anula al instante y las prendas siguen en su carrito. Si cierra la pestaña, cada 10 minutos el
servidor anula los pedidos que llevan más de 20 minutos sin pagarse y las prendas vuelven al
catálogo. No se hace ningún cobro: Transbank solo cobra cuando el servidor confirma el pago.

---

## 6. Correos de confirmación

Cuando un pedido queda pagado, el servidor manda el comprobante al comprador y un aviso al
ropero. Sin configurar el correo la tienda funciona igual, pero no manda correos (y en vez de
"te enviamos el detalle" le pide al comprador que guarde su número de pedido).

Con una cuenta de Gmail (o Google Workspace) del ropero:

1. Activa la verificación en dos pasos en esa cuenta.
2. Crea una **contraseña de aplicación** en
   [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
3. En `wrangler.jsonc` completa:
   - `"SMTP_USUARIO": "ropero@tu-dominio.cl"` (la cuenta que envía)
   - `"CORREO_AVISOS": "..."` (a quién le llega el aviso de pedido nuevo; si lo dejas vacío
     se usa el `correo` de `datos.js`)
4. Guarda la contraseña de aplicación: `npx wrangler secret put SMTP_CLAVE`
5. `npm run deploy`

Otro proveedor de correo: cambia `SMTP_HOST`, `SMTP_PUERTO` y `SMTP_SEGURIDAD`
(`tls` para el puerto 465, `starttls` para el 587).

---

## 7. Panel de voluntarias (`admin.html`)

- **Prendas:** agregar, editar, publicar/ocultar y borrar. Las fotos se achican solas antes de
  subirse, así que sirven las fotos tomadas con el teléfono.
- **Pedidos:** lista de retiro con quién está autorizado a retirar; marcar entregado; anular
  pedidos que no se pagaron (las prendas vuelven al catálogo).
- **Reembolsos:** aprobar o rechazar; al aprobar, las prendas vuelven al catálogo y el dinero se
  devuelve por Webpay.
- **Resumen:** cifras de ventas y descarga de todas las ventas en CSV (se abre en Excel).

La clave del panel es el secreto `ADMIN_CLAVE`: no está escrita en ninguna página. Para
cambiarla, vuelve a correr `npx wrangler secret put ADMIN_CLAVE`.

---

## 8. Cambiar textos, medios de pago, colores

- **Textos, horario, lugar de retiro, contacto y plazo de reembolso:** `public/js/datos.js`.
- **Medios de pago:** en `datos.js`, `CONFIG.pagos`. Hoy solo está activo Webpay. Si activan
  `transferencia`, escriban antes los datos reales de la cuenta en `CONFIG.datosTransferencia`.
  El servidor también lee este archivo, así que un medio apagado aquí no se puede usar.
- **Tallas, marcas y tipos de prenda:** `LISTAS` en `datos.js`.
- **Colores y tipografía:** las primeras líneas de `public/css/estilos.css` (`:root`). Para
  cambiar la tipografía, edita también la línea de Google Fonts en el `<head>` de los `.html`.

Después de cualquier cambio: `npm run deploy` (o `push` a GitHub si conectaste los Builds).

---

## 9. Pruebas automáticas

```bash
npm test            # prueba la API completa (pedidos, Webpay, reembolsos, panel, correos)
npm run test:e2e    # recorre la tienda y el panel en un navegador (requiere Playwright)
```

Las pruebas usan una imitación local de Webpay y de un servidor de correo, así que no
necesitan internet ni cobran nada. Si tu `.dev.vars` tiene una `WEBPAY_API_KEY` real, déjala
vacía mientras corres las pruebas: la imitación solo acepta las credenciales públicas de prueba. Para `test:e2e` en tu computador instala Playwright una vez:
`npm install --no-save playwright && npx playwright install chromium`.

---

## 10. Atajos útiles en VS Code

- `Ctrl + P` (Windows) / `Cmd + P` (Mac): abrir un archivo por nombre.
- `Ctrl + F`: buscar dentro del archivo.
- `Alt + Shift + F`: ordenar y alinear el código automáticamente.
- `F12` en el navegador → pestaña *Console*: ahí aparecen los errores si algo se rompe.
  El más común es una coma o una llave que falta en `public/js/datos.js`.
- Si el servidor falla, los errores aparecen en la terminal donde corre `npm run dev`
  (o en Cloudflare: *Workers & Pages* → `ropero-sg` → *Logs*).

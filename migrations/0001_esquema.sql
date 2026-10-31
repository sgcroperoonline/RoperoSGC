-- ================================================================
-- Ropero SG — estructura de la base de datos (Cloudflare D1 = SQLite)
-- ----------------------------------------------------------------
-- Se aplica con:  npm run db:migrar          (base local)
--                 npm run db:migrar:remoto   (base publicada)
-- Las fechas se guardan como texto ISO en hora UTC, con el mismo
-- formato que new Date().toISOString() en JavaScript, por ejemplo
-- '2026-03-04T15:20:00.000Z'. Así se pueden comparar como texto.
-- ================================================================


-- Cada prenda del catálogo.
CREATE TABLE productos (
  id             TEXT PRIMARY KEY,                      -- código, por ejemplo 'SG-0004'
  nombre         TEXT NOT NULL,
  tipo           TEXT NOT NULL,                         -- uno de LISTAS.tipos (datos.js)
  marca          TEXT NOT NULL,                         -- uno de LISTAS.marcas
  talla          TEXT NOT NULL,                         -- uno de LISTAS.tallas
  estado         TEXT NOT NULL,                         -- clave de ESTADOS: nuevo|excelente|bueno|usado
  precio         INTEGER NOT NULL CHECK (precio >= 0),  -- en pesos chilenos
  -- El CHECK es lo que impide vender más unidades de las que hay:
  -- si una compra dejaría el stock en negativo, la base de datos la rechaza completa.
  stock          INTEGER NOT NULL DEFAULT 1 CHECK (stock >= 0),
  detalle        TEXT NOT NULL DEFAULT '',              -- observaciones de la prenda
  imagen         TEXT NOT NULL DEFAULT '',              -- '/img/prendas/SG-0004.png', '/api/imagenes/SG-0004?v=…' o ''
  publicado      INTEGER NOT NULL DEFAULT 1 CHECK (publicado IN (0, 1)),
  creado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


-- Fotos subidas desde el panel (una por prenda).
CREATE TABLE imagenes (
  producto_id    TEXT PRIMARY KEY REFERENCES productos(id) ON DELETE CASCADE,
  tipo_mime      TEXT NOT NULL,                         -- image/jpeg, image/png o image/webp
  datos          BLOB NOT NULL,
  actualizado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);


-- Cada pedido. No hay cuentas: el comprador se identifica con el número y su correo.
CREATE TABLE pedidos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  numero           TEXT UNIQUE,                         -- 'RSG-2026-1001' = 'RSG-' || año || '-' || (1000 + id)
  token_acceso     TEXT NOT NULL UNIQUE,                -- clave aleatoria que permite ver el comprobante
  comprador_nombre TEXT NOT NULL,
  comprador_correo TEXT NOT NULL,                       -- siempre en minúsculas
  comprador_fono   TEXT NOT NULL,
  retira_tipo      TEXT NOT NULL CHECK (retira_tipo IN ('apoderado', 'estudiante', 'tercero')),
  retira_nombre    TEXT NOT NULL,
  retira_extra     TEXT NOT NULL DEFAULT '',            -- 'Curso 7°B' o 'RUT 12.345.678-5'
  metodo_pago      TEXT NOT NULL CHECK (metodo_pago IN ('webpay', 'transferencia', 'efectivo')),
  estado_pago      TEXT NOT NULL DEFAULT 'pendiente'
                   CHECK (estado_pago IN ('pendiente', 'pagado', 'rechazado', 'anulado', 'reembolsado')),
  entrega          TEXT NOT NULL DEFAULT 'por_retirar' CHECK (entrega IN ('por_retirar', 'entregado')),
  total            INTEGER NOT NULL CHECK (total >= 0), -- calculado SIEMPRE en el servidor
  pagado_en        TEXT,
  entregado_en     TEXT,
  anulado_en       TEXT,
  motivo_anulacion TEXT,
  creado_en        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_pedidos_correo ON pedidos (comprador_correo);
CREATE INDEX idx_pedidos_estado ON pedidos (estado_pago, metodo_pago, creado_en);


-- Prendas de cada pedido, con una COPIA de sus características al momento de comprar.
-- No tiene llave foránea a productos: si se borra la prenda, el pedido conserva su copia.
CREATE TABLE pedido_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id       INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id     TEXT NOT NULL,
  nombre          TEXT NOT NULL,
  tipo            TEXT NOT NULL,
  marca           TEXT NOT NULL,
  talla           TEXT NOT NULL,
  estado          TEXT NOT NULL,
  precio_unitario INTEGER NOT NULL,
  cantidad        INTEGER NOT NULL CHECK (cantidad > 0)
);
CREATE INDEX idx_pedido_items_pedido ON pedido_items (pedido_id);


-- Cada intento de pago y cada devolución hechos en Webpay.
CREATE TABLE transacciones (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id           INTEGER NOT NULL REFERENCES pedidos(id),
  tipo                TEXT NOT NULL CHECK (tipo IN ('pago', 'reembolso')),
  proveedor           TEXT NOT NULL DEFAULT 'webpay',
  ambiente            TEXT NOT NULL,                    -- 'integracion' (pruebas) o 'produccion'
  token               TEXT,                             -- token de Transbank
  orden_compra        TEXT,                             -- buy_order (= número de pedido)
  id_sesion           TEXT,                             -- session_id aleatorio
  monto               INTEGER NOT NULL,
  estado              TEXT NOT NULL CHECK (estado IN ('iniciada', 'autorizada', 'rechazada', 'abortada',
                                                      'expirada', 'invalida', 'error', 'reembolsada')),
  codigo_respuesta    INTEGER,
  codigo_autorizacion TEXT,
  tipo_pago           TEXT,                             -- VD, VN, VC, SI, S2, NC o VP
  cuotas              INTEGER,
  tarjeta_ultimos4    TEXT,                             -- solo los últimos 4 dígitos
  fecha_transaccion   TEXT,
  fecha_contable      TEXT,
  vci                 TEXT,
  tipo_reembolso      TEXT,                             -- 'REVERSED' o 'NULLIFIED'
  detalle_error       TEXT,
  respuesta_json      TEXT,                             -- respuesta completa de Transbank (nunca trae el número completo de la tarjeta)
  creado_en           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actualizado_en      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Un token de pago no se puede repetir (los reembolsos usan el mismo token del pago).
CREATE UNIQUE INDEX idx_transacciones_token_pago ON transacciones (token) WHERE tipo = 'pago';
CREATE INDEX idx_transacciones_pedido ON transacciones (pedido_id);


-- Solicitudes de reembolso (máximo una por pedido).
CREATE TABLE reembolsos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id      INTEGER NOT NULL UNIQUE REFERENCES pedidos(id),
  motivo         TEXT NOT NULL,
  estado         TEXT NOT NULL DEFAULT 'solicitado'
                 CHECK (estado IN ('solicitado', 'aprobado', 'rechazado', 'devuelto')),
  respuesta      TEXT NOT NULL DEFAULT '',              -- respuesta del ropero para la familia
  error          TEXT,                                  -- último error al devolver por Webpay
  transaccion_id INTEGER REFERENCES transacciones(id),  -- la devolución hecha en Webpay
  solicitado_en  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  resuelto_en    TEXT,
  devuelto_en    TEXT
);


-- Intentos fallidos de entrar al panel (para frenar a quien intente adivinar la clave).
CREATE TABLE intentos_acceso (
  ip        TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_intentos_acceso ON intentos_acceso (ip, creado_en);

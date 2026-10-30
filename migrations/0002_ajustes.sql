-- ================================================================
-- Ropero SG — cambio 2 de la base de datos
-- ----------------------------------------------------------------
-- Se aplica igual que la primera:  npm run db:migrar  (local)
--                                  npm run db:migrar:remoto  (publicada)
-- ================================================================


-- Ajustes internos del servidor (no se editan a mano).
--   secreto_sesiones: llave aleatoria para firmar las sesiones del panel.
--   Así la firma no sale solo de ADMIN_CLAVE y un token robado no sirve
--   para adivinar la clave sin conexión.
CREATE TABLE ajustes (
  clave     TEXT PRIMARY KEY,
  valor     TEXT NOT NULL,
  creado_en TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
INSERT INTO ajustes (clave, valor) VALUES ('secreto_sesiones', lower(hex(randomblob(32))));


-- Para saber rápido si un código de prenda ya estuvo en algún pedido
-- (un código usado no se vuelve a dar a otra prenda).
CREATE INDEX idx_pedido_items_producto ON pedido_items (producto_id);

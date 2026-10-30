-- ================================================================
-- Ropero SG — cambio 3 de la base de datos
-- ----------------------------------------------------------------
-- Se aplica igual que las anteriores:  npm run db:migrar  (local)
--                                      npm run db:migrar:remoto  (publicada)
-- ================================================================


-- Límite de pagos Webpay sin terminar por conexión a internet (máximo 5 a la vez),
-- para que nadie pueda reservar todo el catálogo dejando pagos a medias.
-- No se guarda la dirección IP: solo una huella cifrada con el secreto del servidor
-- (tabla "ajustes"), que sirve para contar pero no para saber de dónde se compró.
ALTER TABLE pedidos ADD COLUMN red_origen TEXT;
CREATE INDEX idx_pedidos_red_pendientes ON pedidos (red_origen, metodo_pago, estado_pago);

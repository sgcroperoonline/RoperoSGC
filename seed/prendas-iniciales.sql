-- Prendas de ejemplo del prototipo (12 prendas).
-- NO es una migración: se carga solo si tú lo pides con
--   npm run db:semilla          (base local de desarrollo)
--   npm run db:semilla:remoto   (base publicada en Cloudflare)
-- Las fotos están en public/img/prendas/.
-- Si una prenda ya existe (mismo código), no se toca.

INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0004', 'Polera piqué manga corta', 'Polera', 'First Option', 'S', 'excelente', 4000, 1, 'Insignia bordada completa. Sin manchas.', '/img/prendas/SG-0004.png', 1, '2026-01-01T12:00:00.000Z', '2026-01-01T12:00:00.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0005', 'Polera piqué manga corta', 'Polera', 'Uniformes Sport', '14', 'bueno', 4000, 2, 'Pilling leve en el cuello.', '/img/prendas/SG-0005.png', 1, '2026-01-01T12:00:01.000Z', '2026-01-01T12:00:01.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0006', 'Pantalón de buzo algodón', 'Buzo', 'Uniformes Sport', 'L', 'excelente', 4000, 1, 'Elástico firme, bastas sin deshilachar.', '/img/prendas/SG-0006.png', 1, '2026-01-01T12:00:02.000Z', '2026-01-01T12:00:02.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0007', 'Polar con cierre', 'Buzo', 'Uniformes Sport', 'M', 'bueno', 5000, 1, 'Cierre funciona perfecto. Puños algo estirados.', '/img/prendas/SG-0007.png', 1, '2026-01-01T12:00:03.000Z', '2026-01-01T12:00:03.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0008', 'Polar azul con cierre completo', 'Polar', 'First Option', 'L', 'excelente', 6000, 1, 'Insignia impecable. Sin pelusas.', '/img/prendas/SG-0008.jpg', 1, '2026-01-01T12:00:04.000Z', '2026-01-01T12:00:04.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0009', 'Polar azul con capucha', 'Polar', 'Sin marca', '10', 'nuevo', 6000, 1, 'Donación, nunca usada. Conserva etiqueta.', '/img/prendas/SG-0009.png', 1, '2026-01-01T12:00:05.000Z', '2026-01-01T12:00:05.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0010', 'Falda tableada azul marino', 'Falda', 'Vestuario Escolar', '12', 'bueno', 5000, 1, 'Tableado marcado. Basta subida prolijamente.', '/img/prendas/SG-0010.png', 1, '2026-01-01T12:00:06.000Z', '2026-01-01T12:00:06.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0011', 'Pantalón gris media', 'Pantalón', 'First Option', '16', 'excelente', 5000, 1, 'Sin brillo ni manchas. Pretina firme.', '/img/prendas/SG-0011.png', 1, '2026-01-01T12:00:07.000Z', '2026-01-01T12:00:07.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0013', 'Corbata institucional', 'Corbata', 'Sin marca', 'S', 'excelente', 2000, 3, 'Nudo listo. Colores firmes.', '/img/prendas/SG-0013.png', 1, '2026-01-01T12:00:08.000Z', '2026-01-01T12:00:08.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0014', 'Camisa blanca manga larga', 'Camisa', 'Falabella', '14', 'nuevo', 5000, 1, 'Donación sin uso.', '/img/prendas/SG-0014.png', 1, '2026-01-01T12:00:09.000Z', '2026-01-01T12:00:09.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0015', 'Chaleco azul cuello en V', 'Chaleco', 'Vestuario Escolar', '8', 'usado', 3000, 1, 'Un pequeño zurcido en el borde inferior, poco visible.', '/img/prendas/SG-0015.png', 1, '2026-01-01T12:00:10.000Z', '2026-01-01T12:00:10.000Z');
INSERT OR IGNORE INTO productos (id, nombre, tipo, marca, talla, estado, precio, stock, detalle, imagen, publicado, creado_en, actualizado_en)
VALUES ('SG-0017', 'Short de educación física', 'Short', 'First Option', '14', 'excelente', 4000, 1, 'Cintura elástica ajustable. Sin desgaste.', '/img/prendas/SG-0017.png', 1, '2026-01-01T12:00:11.000Z', '2026-01-01T12:00:11.000Z');

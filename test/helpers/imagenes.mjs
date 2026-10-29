/* ================================================================
   IMÁGENES DE PRUEBA (sin librerías)
   crearPng: arma un PNG de verdad del tamaño que se pida.
   medidasJpeg: lee ancho y alto de un JPEG (para saber si se achicó).
   ================================================================ */

import { deflateSync } from "node:zlib";

// Tabla para el CRC32 que exige cada bloque ("chunk") de un PNG
const TABLA_CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = TABLA_CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function bloque(tipo, datos) {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const tipoYDatos = Buffer.concat([Buffer.from(tipo, "ascii"), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(tipoYDatos));
  return Buffer.concat([largo, tipoYDatos, crc]);
}

/**
 * PNG RGB con un degradado. `ruido` (0 a 127) agrega granitos para que el
 * archivo pese como una foto de teléfono. Siempre sale igual (no es azar real).
 */
export function crearPng(ancho, alto, ruido = 0) {
  let semilla = 12345;
  const azar = () => {
    semilla = (semilla * 1103515245 + 12345) & 0x7fffffff;
    return semilla / 0x7fffffff;
  };
  const fila = 1 + ancho * 3;                 // cada fila parte con el byte de "filtro" (0 = ninguno)
  const crudo = Buffer.alloc(fila * alto);
  for (let y = 0; y < alto; y++) {
    for (let x = 0; x < ancho; x++) {
      const i = y * fila + 1 + x * 3;
      const extra = ruido ? Math.round((azar() * 2 - 1) * ruido) : 0;
      crudo[i] = limitar(30 + (x / ancho) * 60 + extra);        // tonos azules, como un polar del colegio
      crudo[i + 1] = limitar(60 + (y / alto) * 60 + extra);
      crudo[i + 2] = limitar(140 + (x / ancho) * 90 + extra);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8;   // 8 bits por canal
  ihdr[9] = 2;   // color RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    bloque("IHDR", ihdr),
    bloque("IDAT", deflateSync(crudo)),
    bloque("IEND", Buffer.alloc(0))
  ]);
}

function limitar(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** Devuelve { ancho, alto } de un JPEG, o null si no lo es */
export function medidasJpeg(bytes) {
  const b = Buffer.from(bytes);
  if (b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const marca = b[i + 1];
    // SOF0..SOF15 (menos C4, C8 y CC, que son otras cosas) traen las medidas
    if (marca >= 0xc0 && marca <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marca)) {
      return { alto: b.readUInt16BE(i + 5), ancho: b.readUInt16BE(i + 7) };
    }
    if (marca === 0xd8 || marca === 0x01 || (marca >= 0xd0 && marca <= 0xd7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

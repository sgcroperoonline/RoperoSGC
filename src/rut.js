// RUT chileno: revisa el dígito verificador (módulo 11) y lo deja con puntos y guion.

// Calcula el dígito verificador de la parte numérica del RUT ("12345678" -> "5").
export function digitoVerificador(cuerpo) {
  let suma = 0;
  let factor = 2;
  // Se recorre de derecha a izquierda multiplicando por 2, 3, 4, 5, 6, 7, 2, 3, …
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  if (resto === 11) return "0";
  if (resto === 10) return "K";
  return String(resto);
}

/**
 * Recibe un RUT escrito como sea ("12.345.678-5", "12345678-5", "123456785")
 * y devuelve "12.345.678-5" si es válido, o null si no lo es.
 */
export function normalizarRut(texto) {
  if (typeof texto !== "string" || texto.length > 20) return null;
  const limpio = texto.replace(/[.\s]/g, "").toUpperCase();
  const partes = /^(\d{1,8})-?([0-9K])$/.exec(limpio);
  if (!partes) return null;
  const cuerpo = partes[1].replace(/^0+/, "");
  const digito = partes[2];
  if (!cuerpo || digitoVerificador(cuerpo) !== digito) return null;
  const conPuntos = cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${conPuntos}-${digito}`;
}

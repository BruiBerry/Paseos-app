// Los montos son enteros de pesos chilenos: sin decimales, punto de miles.
const formateador = new Intl.NumberFormat('es-CL', {
  style: 'currency',
  currency: 'CLP',
  maximumFractionDigits: 0
})

export function pesos(monto) {
  return formateador.format(monto ?? 0)
}

/** Para inputs de dinero: '' cuando el campo está vacío, entero cuando no. */
export function aEnteroONulo(valor) {
  const limpio = String(valor).trim()
  if (limpio === '') return null
  const n = Number(limpio)
  return Number.isFinite(n) ? Math.round(n) : null
}

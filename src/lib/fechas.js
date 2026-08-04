// Todo lo que tenga que ver con fechas pasa por acá, y siempre en hora local.
//
// `new Date().toISOString()` devuelve la fecha en UTC: en Chile, después de
// las 20:00, eso ya es el día siguiente. Un "Hoy" que se adelanta ocho horas
// antes de medianoche no sirve, así que las fechas de calendario se arman
// leyendo los componentes locales del Date, nunca serializando a UTC.

const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const DIAS_CORTOS = ['L', 'M', 'M', 'J', 'V', 'S', 'D'] // la rejilla parte el lunes
const MESES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
]

export { DIAS_CORTOS, MESES }

const dosDigitos = (n) => String(n).padStart(2, '0')

/** Date -> 'YYYY-MM-DD' con los componentes locales. */
export function aISO(fecha) {
  return `${fecha.getFullYear()}-${dosDigitos(fecha.getMonth() + 1)}-${dosDigitos(fecha.getDate())}`
}

/** 'YYYY-MM-DD' -> Date a medianoche local (no UTC). */
export function desdeISO(iso) {
  const [a, m, d] = iso.split('-').map(Number)
  return new Date(a, m - 1, d)
}

export function hoyISO() {
  return aISO(new Date())
}

export function sumarDias(iso, n) {
  const f = desdeISO(iso)
  f.setDate(f.getDate() + n)
  return aISO(f)
}

/** 1 = lunes … 7 = domingo, que es como `paseo_recurrente.dias_semana` los guarda. */
export function diaSemana(iso) {
  const d = desdeISO(iso).getDay() // 0 = domingo
  return d === 0 ? 7 : d
}

/** 'jueves 6 de agosto' */
export function fechaLarga(iso) {
  const f = desdeISO(iso)
  return `${DIAS[f.getDay()]} ${f.getDate()} de ${MESES[f.getMonth()]}`
}

/** '09:30:00' -> '09:30'. Postgres devuelve `time` con segundos. */
export function hora(t) {
  return t ? t.slice(0, 5) : ''
}

/** Suma minutos a un 'HH:MM[:SS]' y devuelve 'HH:MM'. Para la hora de término. */
export function horaMas(t, minutos) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  const total = ((h * 60 + m + minutos) % 1440 + 1440) % 1440
  return `${dosDigitos(Math.floor(total / 60))}:${dosDigitos(total % 60)}`
}

/**
 * Las seis semanas que dibuja la vista mensual, empezando el lunes.
 * Devuelve `{ iso, delMes }` para poder atenuar los días de relleno.
 */
export function rejillaMes(anio, mes) {
  const primero = new Date(anio, mes, 1)
  const desplazamiento = (primero.getDay() + 6) % 7 // lunes = 0
  const inicio = new Date(anio, mes, 1 - desplazamiento)

  return Array.from({ length: 42 }, (_, i) => {
    const f = new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + i)
    return { iso: aISO(f), delMes: f.getMonth() === mes }
  })
}

// --- Periodos de cobro: '2026-07' ---

export function periodo(anio, mes) {
  return `${anio}-${dosDigitos(mes + 1)}`
}

/** El último mes cerrado. Cobros abre acá, no en el mes en curso. */
export function periodoCerrado() {
  const f = new Date()
  f.setDate(1)
  f.setMonth(f.getMonth() - 1)
  return periodo(f.getFullYear(), f.getMonth())
}

export function periodoVecino(p, delta) {
  const [a, m] = p.split('-').map(Number)
  const f = new Date(a, m - 1 + delta, 1)
  return periodo(f.getFullYear(), f.getMonth())
}

export function rangoPeriodo(p) {
  const [a, m] = p.split('-').map(Number)
  return {
    desde: `${a}-${dosDigitos(m)}-01`,
    hasta: aISO(new Date(a, m, 0)) // día 0 del mes siguiente = último de este
  }
}

export function nombrePeriodo(p) {
  const [a, m] = p.split('-').map(Number)
  return `${MESES[m - 1]} ${a}`
}

// --- Duraciones ---

/** 3725 -> '1:02:05'. La fuente monoespaciada evita que el ancho baile. */
export function reloj(segundos) {
  const s = Math.max(0, Math.floor(segundos))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const seg = s % 60
  return h > 0
    ? `${h}:${dosDigitos(m)}:${dosDigitos(seg)}`
    : `${dosDigitos(m)}:${dosDigitos(seg)}`
}

/** 5400 -> '1h 30min'. Para listados, donde el segundero no aporta. */
export function duracionCorta(segundos) {
  if (segundos == null) return ''
  const min = Math.round(segundos / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

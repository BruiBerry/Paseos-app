// Construcción del feed `.ics` (spec §7). Sin dependencias y sin red: recibe
// los paseos ya leídos y devuelve el texto del calendario.

import { duracionPrevistaDePaseo } from './duracion.js'

/**
 * Las horas van como "hora flotante": sin `Z` y sin `TZID`.
 *
 * El estándar dice que una hora flotante se interpreta en la zona del
 * dispositivo que la muestra, que es exactamente lo que queremos — el paseo
 * de las 09:00 se ve a las 09:00. La alternativa, convertir a UTC, obliga a
 * conocer el desfase de Chile en cada fecha, y Chile cambia de horario dos
 * veces al año y ha movido las fechas del cambio por decreto más de una vez.
 * Un feed en UTC se corre una hora solo en algunas semanas del año, que es la
 * clase de error que nadie nota hasta que llega tarde a un paseo.
 *
 * Es la misma razón por la que `fechas.js` nunca serializa a UTC.
 */
function marcaLocal(iso, hhmm) {
  const [h, m] = hhmm.split(':')
  return `${iso.replace(/-/g, '')}T${h}${m}00`
}

/** Instante UTC, solo para DTSTAMP, que sí exige hora absoluta. */
function marcaUTC(fecha) {
  return `${fecha.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`
}

/** Escapa según RFC 5545: la coma y el punto y coma son separadores. */
function esc(texto) {
  return String(texto ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * Las líneas se doblan a 75 octetos, no a 75 caracteres. Con acentos y ñ —o
 * sea, en todos los nombres de esta app— un carácter ocupa dos octetos, y
 * cortar por caracteres genera líneas demasiado largas que algunos
 * calendarios truncan. Peor: cortar en medio de un carácter multibyte lo
 * parte y el nombre llega con basura.
 */
function doblar(linea) {
  const bytes = Buffer.from(linea, 'utf8')
  if (bytes.length <= 75) return linea

  const partes = []
  let inicio = 0
  let limite = 75
  while (inicio < bytes.length) {
    let fin = Math.min(inicio + limite, bytes.length)
    // Retrocede hasta el comienzo de un carácter (los de continuación son 10xxxxxx).
    while (fin < bytes.length && (bytes[fin] & 0xc0) === 0x80) fin--
    partes.push(bytes.subarray(inicio, fin).toString('utf8'))
    inicio = fin
    limite = 74 // las líneas siguientes gastan un octeto en el espacio inicial
  }
  return partes.join('\r\n ')
}

function sumarMinutos(hhmm, minutos) {
  const [h, m] = hhmm.split(':').map(Number)
  const total = h * 60 + m + minutos
  const dias = Math.floor(total / 1440)
  const resto = ((total % 1440) + 1440) % 1440
  const dosDig = (n) => String(n).padStart(2, '0')
  return { hhmm: `${dosDig(Math.floor(resto / 60))}:${dosDig(resto % 60)}`, dias }
}

function sumarDiasISO(iso, dias) {
  if (!dias) return iso
  const [a, m, d] = iso.split('-').map(Number)
  const f = new Date(a, m - 1, d + dias)
  const dosDig = (n) => String(n).padStart(2, '0')
  return `${f.getFullYear()}-${dosDig(f.getMonth() + 1)}-${dosDig(f.getDate())}`
}

/** Los perros que efectivamente van: los cancelados no cuentan ni se nombran. */
function perrosVigentes(paseo) {
  return (paseo.paseo_perro ?? []).filter((pp) => pp.estado !== 'cancelado')
}

/** Título: el grupo y cuántos perros van; si no hay grupo, los nombres. */
export function tituloEvento(paseo) {
  const perros = perrosVigentes(paseo)
  const cuenta = perros.length === 1 ? '1 perro' : `${perros.length} perros`
  if (paseo.grupo?.nombre) return `${paseo.grupo.nombre} · ${cuenta}`

  const nombres = perros.map((pp) => pp.perro?.nombre).filter(Boolean)
  return nombres.length ? nombres.join(', ') : 'Paseo'
}

/** Las casas distintas que toca el paseo, sin repetir. */
function casas(paseo) {
  const porNombre = new Map()
  for (const pp of perrosVigentes(paseo)) {
    const c = pp.perro?.cliente
    if (c?.nombre && !porNombre.has(c.nombre)) porNombre.set(c.nombre, c)
  }
  return [...porNombre.values()]
}

export function descripcionEvento(paseo, incluyeNotas) {
  const lineas = []
  for (const pp of perrosVigentes(paseo)) {
    const c = pp.perro?.cliente
    lineas.push(`${pp.perro?.nombre ?? 'Perro'} — ${c?.nombre ?? 'Sin dueño'}`)
  }
  // Apagado por defecto (spec §7): son códigos de portón y dónde está la
  // llave de casas ajenas. Encenderlo los copia al calendario del teléfono y
  // a cualquier respaldo en la nube que ese calendario tenga.
  if (incluyeNotas) {
    for (const c of casas(paseo)) {
      if (c.notas_acceso) lineas.push(`Acceso ${c.nombre}: ${c.notas_acceso}`)
    }
  }
  return lineas.join('\n')
}

/**
 * El calendario completo. `ahora` entra por parámetro para que la salida sea
 * reproducible al verificarla: si no, DTSTAMP cambia en cada corrida.
 */
export function construirICS({ paseos, config, ahora = new Date() }) {
  const avisoMin = config?.minutos_aviso_previo ?? 30
  const incluyeNotas = Boolean(config?.calendario_incluye_notas)

  const lineas = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Paseos//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Paseos',
    'X-WR-TIMEZONE:America/Santiago'
  ]

  for (const paseo of paseos ?? []) {
    const inicioHHMM = (paseo.hora_programada ?? '00:00').slice(0, 5)
    const duracion = duracionPrevistaDePaseo(paseo, config)
    const fin = sumarMinutos(inicioHHMM, duracion)

    const direcciones = casas(paseo).map((c) => c.direccion).filter(Boolean)
    const descripcion = descripcionEvento(paseo, incluyeNotas)

    lineas.push(
      'BEGIN:VEVENT',
      // El UID es estable por paseo: así el calendario reconoce el evento al
      // refrescar y lo actualiza en vez de duplicarlo.
      `UID:${paseo.id}@paseos`,
      `DTSTAMP:${marcaUTC(ahora)}`,
      `DTSTART:${marcaLocal(paseo.fecha, inicioHHMM)}`,
      `DTEND:${marcaLocal(sumarDiasISO(paseo.fecha, fin.dias), fin.hhmm)}`,
      doblar(`SUMMARY:${esc(tituloEvento(paseo))}`)
    )
    if (direcciones.length) lineas.push(doblar(`LOCATION:${esc(direcciones.join(' · '))}`))
    if (descripcion) lineas.push(doblar(`DESCRIPTION:${esc(descripcion)}`))

    if (avisoMin > 0) {
      lineas.push(
        'BEGIN:VALARM',
        'ACTION:DISPLAY',
        doblar(`DESCRIPTION:${esc(tituloEvento(paseo))}`),
        `TRIGGER:-PT${avisoMin}M`,
        'END:VALARM'
      )
    }
    lineas.push('END:VEVENT')
  }

  lineas.push('END:VCALENDAR')
  // El estándar exige CRLF, y termina en salto de línea.
  return lineas.join('\r\n') + '\r\n'
}

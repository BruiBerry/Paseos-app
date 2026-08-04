import { supabase } from './supabaseClient'
import { hoyISO, sumarDias, diaSemana } from './fechas'
import { crearPaseo, perrosDeGrupo } from './paseos'

// Materialización: convertir las reglas de `paseo_recurrente` en filas
// reales de `paseo`, manteniendo un horizonte de 8 semanas hacia adelante.
//
// Solo **crea** las ocurrencias que faltan; nunca borra ni modifica una
// existente. Eso cumple sin esfuerzo la regla de respetar toda fila cuyo
// estado no sea `programado`: lo completado o cancelado jamás se toca.
//
// Corre en el navegador al abrir la app. La especificación la quiere como
// Edge Function programada, y ahí debería terminar — la lógica de acá se
// mueve tal cual. Mientras tanto esto evita depender de infraestructura que
// hay que desplegar y operar para poder ver un calendario con datos.

const HORIZONTE_SEMANAS = 8
const CLAVE_ULTIMA_CORRIDA = 'paseos:materializado'

export async function materializar(paseadorId, { semanas = HORIZONTE_SEMANAS } = {}) {
  const desde = hoyISO()
  const hasta = sumarDias(desde, semanas * 7)

  const { data: reglas, error } = await supabase
    .from('paseo_recurrente')
    .select('id, grupo_id, dias_semana, hora_inicio, vigente_desde, vigente_hasta')
    .eq('activo', true)
    .lte('vigente_desde', hasta)
    .or(`vigente_hasta.is.null,vigente_hasta.gte.${desde}`)
  if (error) throw error
  if (!reglas?.length) return 0

  const { data: existentes, error: errorExistentes } = await supabase
    .from('paseo')
    .select('fecha, recurrente_id')
    .in('recurrente_id', reglas.map((r) => r.id))
    .gte('fecha', desde)
    .lte('fecha', hasta)
  if (errorExistentes) throw errorExistentes

  const yaExiste = new Set((existentes ?? []).map((p) => `${p.recurrente_id}|${p.fecha}`))
  const perrosPorGrupo = new Map()
  let creados = 0

  for (const regla of reglas) {
    const dias = new Set(regla.dias_semana ?? [])
    if (!dias.size) continue

    const fechas = []
    for (let f = desde; f <= hasta; f = sumarDias(f, 1)) {
      if (!dias.has(diaSemana(f))) continue
      if (f < regla.vigente_desde) continue
      if (regla.vigente_hasta && f > regla.vigente_hasta) continue
      if (yaExiste.has(`${regla.id}|${f}`)) continue
      fechas.push(f)
    }
    if (!fechas.length) continue

    if (!perrosPorGrupo.has(regla.grupo_id)) {
      perrosPorGrupo.set(regla.grupo_id, await perrosDeGrupo(regla.grupo_id))
    }
    const perros = perrosPorGrupo.get(regla.grupo_id)
    if (!perros.length) continue // grupo vacío: no hay paseo que generar

    for (const fecha of fechas) {
      await crearPaseo(paseadorId, {
        grupoId: regla.grupo_id,
        recurrenteId: regla.id,
        fecha,
        hora: regla.hora_inicio,
        perroIds: perros.map((p) => p.id)
      })
      creados++
    }
  }

  return creados
}

/**
 * Una corrida por día y por dispositivo. La primera vez tras crear una regla
 * genera hasta 8 semanas de una vez, así que no conviene repetirla en cada
 * montaje de un componente.
 */
export async function materializarUnaVezAlDia(paseadorId) {
  const hoy = hoyISO()
  if (localStorage.getItem(CLAVE_ULTIMA_CORRIDA) === hoy) return 0
  const creados = await materializar(paseadorId)
  localStorage.setItem(CLAVE_ULTIMA_CORRIDA, hoy)
  return creados
}

/** Tras crear o editar una regla hay que rellenar el horizonte de inmediato. */
export function olvidarUltimaCorrida() {
  localStorage.removeItem(CLAVE_ULTIMA_CORRIDA)
}

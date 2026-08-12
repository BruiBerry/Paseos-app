import { supabase } from './supabaseClient'
import { SELECT_PASEO } from './consultas'
import { hoyISO } from './fechas'
import { duracionPrevistaDePaseo } from './duracion'

// Crear un paseo, calcular su precio y cerrarlo. Todo lo que toca dinero
// pasa por acá para que exista un solo lugar donde el precio se congela.

/** Los perros de un grupo, con lo necesario para precio y duración. */
export async function perrosDeGrupo(grupoId) {
  const { data, error } = await supabase
    .from('grupo_perro')
    // Sin espacios: PostgREST rechaza el blanco entre paréntesis de cierre.
    .select('perro(id,nombre,duracion_min,color_hex,activo,cliente(id,nombre))')
    .eq('grupo_id', grupoId)
  if (error) throw error
  return (data ?? []).map((f) => f.perro).filter((p) => p && p.activo)
}

// La cascada de duración vive en `duracion.js`, sin dependencias, porque la
// comparte con la función de servidor del feed. Se reexporta acá para no
// obligar a las pantallas a saber de esa separación.
export { duracionPrevistaMin, duracionPrevistaDePaseo } from './duracion'

/**
 * Precio de cada perro dentro de un mismo paseo.
 *
 * El recargo por perro adicional se cuenta **por casa, no por grupo**: los
 * perros se agrupan por cliente y cada cliente se evalúa por separado, así
 * que a quien lleva un solo perro no le afecta que el grupo tenga cuatro.
 * Esa lógica ya vive en `fn_precios_cliente_en_paseo`, en la base.
 */
export async function calcularPrecios(perroIds) {
  const { data: perros, error } = await supabase
    .from('perro')
    .select('id, cliente_id')
    .in('id', perroIds)
  if (error) throw error

  const porCliente = new Map()
  for (const p of perros ?? []) {
    if (!porCliente.has(p.cliente_id)) porCliente.set(p.cliente_id, [])
    porCliente.get(p.cliente_id).push(p.id)
  }

  const precios = []
  for (const [clienteId, ids] of porCliente) {
    const { data, error: errorRpc } = await supabase.rpc('fn_precios_cliente_en_paseo', {
      p_cliente_id: clienteId,
      p_perro_ids: ids
    })
    if (errorRpc) throw errorRpc
    precios.push(...(data ?? []))
  }
  return precios // [{ perro_id, precio }]
}

/**
 * Inserta el paseo y sus filas de `paseo_perro` con el precio ya congelado.
 * Son dos pasos porque el precio depende de qué perros van; si el segundo
 * falla se borra el paseo, porque uno sin filas de perro no se cobra nunca
 * y no hay nada en la interfaz que delate que quedó a medias.
 */
export async function crearPaseo(paseadorId, { grupoId = null, recurrenteId = null, fecha, hora, perroIds, duracionMin = null }) {
  if (!perroIds?.length) throw new Error('Un paseo necesita al menos un perro.')

  const { data: paseo, error } = await supabase
    .from('paseo')
    .insert({
      paseador_id: paseadorId,
      grupo_id: grupoId,
      recurrente_id: recurrenteId,
      fecha,
      hora_programada: hora,
      duracion_min: duracionMin || null
    })
    .select('id')
    .single()
  if (error) throw error

  try {
    const precios = await calcularPrecios(perroIds)
    if (!precios.length) throw new Error('No se pudo calcular el precio de ningún perro.')

    const { error: errorPerros } = await supabase.from('paseo_perro').insert(
      precios.map((p) => ({
        paseo_id: paseo.id,
        perro_id: p.perro_id,
        paseador_id: paseadorId,
        precio_cobrado: p.precio
      }))
    )
    if (errorPerros) throw errorPerros
  } catch (e) {
    await supabase.from('paseo').delete().eq('id', paseo.id)
    throw e
  }

  return paseo.id
}

/**
 * El inicio se marca con el reloj del teléfono, no con el del servidor: es
 * el teléfono el que está parado frente a la casa, y puede estar sin señal.
 */
export async function iniciarPaseo(paseoId, inicio = new Date()) {
  const { error } = await supabase
    .from('paseo')
    .update({ estado: 'en_curso', inicio_real: inicio.toISOString() })
    .eq('id', paseoId)
  if (error) throw error
  return inicio
}

/**
 * Guarda el total pausado hasta ahora. Se llama al reanudar, no al pausar:
 * mientras la pausa corre todavía no se sabe cuánto va a durar.
 *
 * Es un total absoluto y no un incremento a propósito. Si el reintento de la
 * cola la manda dos veces —que pasa seguido, porque esto se usa sin señal—
 * escribir el mismo total dos veces no hace nada, mientras que sumar dos
 * veces inflaría la pausa y acortaría el paseo.
 */
export async function registrarPausa(paseoId, pausadoSeg) {
  const { error } = await supabase
    .from('paseo')
    .update({ pausado_seg: Math.max(0, Math.round(pausadoSeg)) })
    .eq('id', paseoId)
  if (error) throw error
}

export async function terminarPaseo(paseoId, { fin = new Date(), duracionSeg, pausadoSeg = 0, automatico = false }) {
  const { error } = await supabase
    .from('paseo')
    .update({
      estado: automatico ? 'cerrado_automaticamente' : 'completado',
      fin_real: fin.toISOString(),
      // `duracion_seg` va limpia, sin las pausas; `pausado_seg` queda aparte
      // para poder explicar después por qué el reloj no cuadra con
      // fin_real − inicio_real.
      duracion_seg: Math.max(0, Math.round(duracionSeg)),
      pausado_seg: Math.max(0, Math.round(pausadoSeg))
    })
    .eq('id', paseoId)
  if (error) throw error

  // Los perros que no se cancelaron uno por uno se dan por realizados.
  const { error: errorPerros } = await supabase
    .from('paseo_perro')
    .update({ estado: 'completado' })
    .eq('paseo_id', paseoId)
    .eq('estado', 'programado')
  if (errorPerros) throw errorPerros
}

/**
 * Margen sobre la duración prevista antes de dar un paseo por olvidado.
 *
 * La especificación (§189) dice 15 minutos, pero ahí supone que existen los
 * avisos: primero se notifica, se insiste, y recién si el paseador los ignora
 * se cierra. Sin notificaciones no hay "los ignoró" que detectar, y cerrar a
 * los 15 minutos cerraría por la espalda un paseo que de verdad se alargó y
 * que el paseador está caminando en ese momento — el peor error posible,
 * porque además marca los perros como completados y toca el cobro.
 *
 * Así que hasta que existan los avisos se cierra solo lo que no admite otra
 * lectura: un paseo de un día anterior, o uno tan excedido que ningún paseo
 * real dura eso. Volver a los 15 minutos es correcto el día que el aviso
 * exista y el paseador haya tenido cómo enterarse.
 */
export const MARGEN_OLVIDO_MIN = 15
const MARGEN_SIN_AVISOS_MIN = 180

/**
 * ¿Este paseo quedó olvidado? Devuelve con qué cerrarlo, o null si sigue vivo.
 *
 * Va aparte y sin tocar la red para poder verificarla sin base: decide marcar
 * perros como completados, y eso entra al cobro del mes.
 */
export function cierrePorOlvido(paseo, config, ahoraMs, hoy) {
  if (!paseo?.inicio_real) return null

  const previstaSeg = duracionPrevistaDePaseo(paseo, config) * 60
  const pausadoSeg = paseo.pausado_seg ?? 0
  const inicio = new Date(paseo.inicio_real).getTime()
  const excedidoSeg = (ahoraMs - inicio) / 1000 - pausadoSeg - previstaSeg

  if (excedidoSeg <= 0) return null
  if (paseo.fecha >= hoy && excedidoSeg <= MARGEN_SIN_AVISOS_MIN * 60) return null

  // El fin se calcula, no se pone "ahora": el paseo se cierra con la duración
  // prevista, así que la hora de término es la que habría tenido si se
  // hubiera cerrado a tiempo. Poner `ahora` inventaría en el historial un
  // paseo de catorce horas que nadie caminó.
  return {
    fin: new Date(inicio + (pausadoSeg + previstaSeg) * 1000),
    duracionSeg: previstaSeg,
    pausadoSeg,
    automatico: true
  }
}

/**
 * Cierra los paseos que quedaron corriendo, con la duración prevista y en
 * estado `cerrado_automaticamente` para que se revisen (spec §189).
 *
 * Corre en el cliente, al abrir Hoy. Eso significa que un paseo olvidado se
 * cierra la próxima vez que el paseador abre la app, no en el momento: sin
 * app abierta no hay JavaScript corriendo. La versión que cierra sola de
 * verdad es una función agendada en la base.
 */
export async function cerrarOlvidados(paseadorId, config) {
  const { data, error } = await supabase
    .from('paseo')
    .select(SELECT_PASEO)
    .eq('paseador_id', paseadorId)
    .eq('estado', 'en_curso')
  if (error) throw error

  const ahora = Date.now()
  const hoy = hoyISO()
  let cerrados = 0

  for (const paseo of data ?? []) {
    const cierre = cierrePorOlvido(paseo, config, ahora, hoy)
    if (!cierre) continue
    await terminarPaseo(paseo.id, cierre)
    cerrados++
  }

  return cerrados
}

/** Cancelar no borra: cambia el estado y deja de cobrarse (spec §4). */
export async function cancelarPaseo(paseoId, motivo) {
  const { error } = await supabase
    .from('paseo')
    .update({ estado: 'cancelado', notas: motivo || null })
    .eq('id', paseoId)
  if (error) throw error

  const { error: errorPerros } = await supabase
    .from('paseo_perro')
    .update({ estado: 'cancelado', se_cobra: false, motivo_cancelacion: motivo || null })
    .eq('paseo_id', paseoId)
    .neq('estado', 'completado')
  if (errorPerros) throw errorPerros
}

/** Que falte un perro no cancela el paseo: solo esa fila deja de cobrarse. */
export async function cancelarPerroEnPaseo(paseoId, perroId, motivo) {
  const { error } = await supabase
    .from('paseo_perro')
    .update({ estado: 'cancelado', se_cobra: false, motivo_cancelacion: motivo || null })
    .eq('paseo_id', paseoId)
    .eq('perro_id', perroId)
  if (error) throw error
}

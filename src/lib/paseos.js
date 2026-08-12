import { supabase } from './supabaseClient'

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
 * Cierra los paseos que quedaron corriendo (spec §189).
 *
 * La decisión —qué margen, con qué duración cerrarlos, qué hora de término
 * inventarles— vive entera en `fn_cerrar_olvidados_paseador`, en la base,
 * porque pg_cron la corre cada hora sin que haya navegador abierto. Acá se
 * llama a lo mismo al abrir Hoy, para que el paseador vea el efecto de
 * inmediato en vez de esperar a la próxima corrida.
 *
 * Tener la regla en un solo lugar importa más que de costumbre: cerrar un
 * paseo marca sus perros como completados, y eso entra al cobro del mes. Dos
 * implementaciones con márgenes distintos cobrarían distinto según quién
 * cerró el paseo.
 */
export async function cerrarOlvidados() {
  const { data, error } = await supabase.rpc('fn_cerrar_olvidados_mios')
  if (error) throw error
  return data ?? 0
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

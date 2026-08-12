import { supabase } from './supabaseClient'
import { hoyISO } from './fechas'

// Materialización: convertir las reglas de `paseo_recurrente` en filas reales
// de `paseo`, manteniendo un horizonte de 8 semanas hacia adelante.
//
// La lógica vive en la base, en `fn_materializar_paseador`, y pg_cron la
// corre todas las madrugadas para todos los paseadores. Acá solo queda la
// llamada.
//
// Antes esto se armaba en el navegador: leía las reglas, calculaba las
// fechas, y creaba cada paseo con su propio ida y vuelta. Además de lento,
// dependía de que el paseador abriera la app — si no la abría, no se
// generaba nada. Y obligaba a mantener dos copias de la misma regla, una en
// JavaScript y otra en SQL para el cron, que es exactamente el tipo de par
// que termina discrepando.

const CLAVE_ULTIMA_CORRIDA = 'paseos:materializado'

/**
 * Rellena el horizonte del paseador de la sesión. Devuelve cuántos creó.
 *
 * No recibe `paseadorId`: quién es sale de `auth.uid()` dentro de la base.
 * Que el navegador no pueda elegir sobre qué paseador opera es la mitad de
 * por qué esto es seguro de exponer por RPC.
 */
export async function materializar({ semanas = 8 } = {}) {
  const { data, error } = await supabase.rpc('fn_materializar_mis_paseos', {
    p_semanas: semanas
  })
  if (error) throw error
  return data ?? 0
}

/**
 * Una corrida por día y por dispositivo.
 *
 * Con el cron andando esto es una red de seguridad, no el mecanismo: si el
 * agendamiento se cae o alguien lo desactiva sin darse cuenta, la app se
 * sigue rellenando sola al abrirla. Cuesta una sola llamada y la función es
 * idempotente —solo crea lo que falta—, así que sobra dejarla.
 */
export async function materializarUnaVezAlDia() {
  const hoy = hoyISO()
  if (localStorage.getItem(CLAVE_ULTIMA_CORRIDA) === hoy) return 0
  const creados = await materializar()
  localStorage.setItem(CLAVE_ULTIMA_CORRIDA, hoy)
  return creados
}

/** Tras crear o editar una regla hay que rellenar el horizonte de inmediato. */
export function olvidarUltimaCorrida() {
  localStorage.removeItem(CLAVE_ULTIMA_CORRIDA)
}

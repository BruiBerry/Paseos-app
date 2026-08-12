// La cascada de duración, sola y sin dependencias.
//
// Vive aparte de `paseos.js` porque la usan dos mundos: el navegador y la
// función de servidor que arma el feed `.ics`. `paseos.js` importa el cliente
// de Supabase, que necesita `import.meta.env` y no carga fuera de Vite; si la
// cascada siguiera ahí, el servidor tendría que llevar su propia copia — y
// dos copias de la regla que decide cuánto dura un paseo terminan
// discrepando justo cuando alguien cambia una y olvida la otra.

/**
 * Cascada de duración prevista, en minutos (spec §4):
 *   1. la escrita a mano al agendar ese paseo (`paseo.duracion_min`)
 *   2. si no, la de la regla recurrente
 *   3. si no, la más larga entre los perros que participan — no se puede
 *      pasear a uno 45 minutos y a otro 60 al mismo tiempo
 *   4. si no, la default del paseador
 *
 * Cada paso se salta con null, no con cero: `duracion_min = 0` no es un
 * paseo de duración indefinida, es un dato malo, y dejarlo caer al paso
 * siguiente es más útil que mostrar un cronómetro que nace excedido.
 */
export function duracionPrevistaMin({ propiaMin, recurrenteMin, perros, config }) {
  if (propiaMin) return propiaMin
  if (recurrenteMin) return recurrenteMin

  const propias = (perros ?? []).map((p) => p?.duracion_min).filter(Boolean)
  if (propias.length) return Math.max(...propias)

  return config?.duracion_default_min ?? 60
}

/** La misma cascada, leyendo un paseo tal como lo devuelven las consultas. */
export function duracionPrevistaDePaseo(paseo, config) {
  return duracionPrevistaMin({
    propiaMin: paseo?.duracion_min,
    recurrenteMin: paseo?.paseo_recurrente?.duracion_min,
    perros: (paseo?.paseo_perro ?? []).map((pp) => pp.perro),
    config
  })
}

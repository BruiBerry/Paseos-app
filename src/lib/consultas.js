// El paseo con todo lo que las pantallas necesitan para mostrarlo: el grupo
// (color del calendario), la regla que lo generó (duración prevista) y los
// perros con su dueño (dirección, notas de acceso, precio congelado).
//
// Vive acá para que Hoy, el cronómetro y el detalle del día no se
// desincronicen cada vez que se agrega un campo.
//
// Va sin espacios a propósito: el parser de PostgREST no acepta espacio en
// blanco entre un paréntesis de cierre y el siguiente, así que indentar un
// embed anidado devuelve 400. Compacto es la única forma segura.
export const SELECT_PASEO = [
  'id,fecha,hora_programada,estado,inicio_real,fin_real,duracion_seg,notas',
  'grupo(id,nombre,color_hex,zona)',
  'paseo_recurrente(id,duracion_min)',
  'paseo_perro(perro_id,precio_cobrado,se_cobra,estado,motivo_cancelacion,' +
    'perro(id,nombre,color_hex,duracion_min,' +
      'cliente(id,nombre,telefono,direccion,notas_acceso,lat,lng)))'
].join(',')

/** Nombre para mostrar: el grupo si lo hay, si no los perros que van. */
export function tituloPaseo(paseo) {
  if (paseo.grupo?.nombre) return paseo.grupo.nombre
  const nombres = (paseo.paseo_perro ?? []).map((pp) => pp.perro?.nombre).filter(Boolean)
  if (!nombres.length) return 'Paseo sin perros'
  return nombres.join(', ')
}

/** Las casas distintas que toca un paseo, para la dirección y la proximidad. */
export function clientesDePaseo(paseo) {
  const porId = new Map()
  for (const pp of paseo.paseo_perro ?? []) {
    const c = pp.perro?.cliente
    if (c && !porId.has(c.id)) porId.set(c.id, c)
  }
  return [...porId.values()]
}

export const ESTADOS = {
  programado: { texto: 'Programado' },
  en_curso: { texto: 'En curso' },
  completado: { texto: 'Completado' },
  cancelado: { texto: 'Cancelado' },
  cerrado_automaticamente: { texto: 'Cerrado automáticamente' }
}

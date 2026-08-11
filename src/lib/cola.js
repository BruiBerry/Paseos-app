import { iniciarPaseo, terminarPaseo, cancelarPaseo, registrarPausa } from './paseos'

// Cola de escrituras pendientes para el cronómetro.
//
// Es lo único que se usa sin señal, y por una razón concreta: el paseador
// aprieta "iniciar" parado en la calle, donde puede no haber cobertura, y el
// paseo tiene que empezar igual. Las demás pantallas requieren conexión.
//
// No es la cola de sincronización completa que describe la especificación
// (§2, con base local para todas las tablas). Cubre el caso que no admite
// fallar; el resto puede esperar a que exista IndexedDB detrás.

const CLAVE = 'paseos:cola'

export function leerCola() {
  try {
    return JSON.parse(localStorage.getItem(CLAVE)) ?? []
  } catch {
    return []
  }
}

function escribirCola(cola) {
  localStorage.setItem(CLAVE, JSON.stringify(cola))
}

export function encolar(accion) {
  escribirCola([...leerCola(), accion])
}

async function ejecutar(accion) {
  switch (accion.tipo) {
    case 'iniciar':
      return iniciarPaseo(accion.paseoId, new Date(accion.inicio))
    case 'pausa':
      return registrarPausa(accion.paseoId, accion.pausadoSeg)
    case 'terminar':
      return terminarPaseo(accion.paseoId, {
        fin: new Date(accion.fin),
        duracionSeg: accion.duracionSeg,
        pausadoSeg: accion.pausadoSeg,
        automatico: accion.automatico
      })
    case 'cancelar':
      return cancelarPaseo(accion.paseoId, accion.motivo)
    default:
      throw new Error(`Acción desconocida en la cola: ${accion.tipo}`)
  }
}

/**
 * Reintenta todo lo pendiente. Lo que vuelve a fallar se queda en la cola
 * en el mismo orden; no se descarta nada por reintentar.
 */
export async function vaciarCola() {
  const cola = leerCola()
  if (!cola.length) return { enviadas: 0, pendientes: 0 }

  const quedan = []
  let enviadas = 0
  for (const accion of cola) {
    try {
      await ejecutar(accion)
      enviadas++
    } catch (e) {
      console.error('Quedó pendiente en la cola', accion, e)
      quedan.push(accion)
    }
  }
  escribirCola(quedan)
  return { enviadas, pendientes: quedan.length }
}

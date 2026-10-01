// Instalación de la PWA y los pasos pendientes del primer arranque (spec §6,
// "Restricción de iOS"). Sin imports de React ni de Supabase, para poder
// probar `pendientesInicio` y las fechas con `node`; lo que toca `window`
// solo se ejecuta cuando alguien lo llama, nunca al importar.

import { sumarDias } from './fechas.js'

export function esIOS() {
  // iPadOS se presenta como Mac; el contacto táctil lo delata.
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

export function estaInstalada() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
}

// --- El aviso de instalación de Chrome/Android ---
//
// `beforeinstallprompt` se dispara una sola vez, poco después de cargar la
// página, y mucho antes de que se monte Hoy. Hay que escucharlo desde el
// arranque (main.jsx) y guardar el evento: si se espera a que la pantalla lo
// pida, ya se perdió. iOS no tiene este evento; ahí solo hay instrucciones.

let eventoInstalar = null
const oyentes = new Set()
const avisar = () => oyentes.forEach((f) => f())

export function escucharInstalacion() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault() // sin esto Chrome muestra su propia barra, fuera de nuestro control
    eventoInstalar = e
    avisar()
  })
  window.addEventListener('appinstalled', () => {
    eventoInstalar = null
    avisar()
  })
}

export const instalacionDisponible = () => eventoInstalar !== null

/** Devuelve la función para dejar de escuchar. */
export function alCambiarInstalacion(f) {
  oyentes.add(f)
  return () => oyentes.delete(f)
}

/** Abre el diálogo nativo. Tiene que llamarse directo desde un toque. */
export async function pedirInstalacion() {
  if (!eventoInstalar) return 'no-disponible'
  eventoInstalar.prompt()
  const { outcome } = await eventoInstalar.userChoice // 'accepted' | 'dismissed'
  eventoInstalar = null // el evento solo sirve una vez
  avisar()
  return outcome
}

// --- Lo que falta hacer ---

/**
 * Los pasos que faltan, calculados del estado real y no de una marca
 * guardada: al cumplirlos desaparecen solos, sin que haya que recordarlos.
 *
 * `estadoPush` es el de `estadoPush()` de push.js. Si el navegador no admite
 * notificaciones no hay nada que el paseador pueda hacer, así que ese paso
 * no se muestra. `motivo` explica por qué un paso no se puede hacer aún.
 */
export function pendientesInicio({ instalada, estadoPush }) {
  const pendientes = []
  if (!instalada) pendientes.push({ id: 'instalar' })

  if (estadoPush === 'inactivo') pendientes.push({ id: 'notificaciones' })
  else if (estadoPush === 'requiere-instalar') pendientes.push({ id: 'notificaciones', motivo: 'instalar' })
  else if (estadoPush === 'bloqueado') pendientes.push({ id: 'notificaciones', motivo: 'denegado' })

  return pendientes
}

// --- Posponer ---

export const DIAS_POSPUESTO = 14

/** Hasta qué día (excluido) queda oculta la tarjeta si se pospone hoy. */
export const posponerHasta = (hoy) => sumarDias(hoy, DIAS_POSPUESTO)

/** Las fechas ISO se comparan como texto: 'YYYY-MM-DD' ordena igual que el calendario. */
export const estaPospuesto = (hoy, hasta) => Boolean(hasta) && hoy < hasta

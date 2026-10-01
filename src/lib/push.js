import { supabase } from './supabaseClient'
import { esIOS, estaInstalada } from './instalacion'

// Suscripción a notificaciones push (spec §6). Lo que decide qué avisar vive
// en la base; esto solo registra este dispositivo para recibirlos.

const CLAVE_VAPID = import.meta.env.VAPID_PUBLIC_KEY

// La clave VAPID pública viaja en base64url y `subscribe` la pide en bytes.
function claveABytes(base64url) {
  const relleno = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + relleno).replace(/-/g, '+').replace(/_/g, '/')
  const crudo = atob(base64)
  return Uint8Array.from(crudo, (c) => c.charCodeAt(0))
}

/**
 * 'requiere-instalar' | 'no-soportado' | 'bloqueado' | 'activo' | 'inactivo'
 *
 * En iOS el push solo existe con la app instalada en la pantalla de inicio:
 * en una pestaña de Safari ni siquiera está `PushManager`. Por eso se revisa
 * la instalación antes que el soporte, para poder decir qué hacer y no solo
 * "no funciona".
 */
export async function estadoPush() {
  if (esIOS() && !estaInstalada()) return 'requiere-instalar'
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return 'no-soportado'
  }
  if (Notification.permission === 'denied') return 'bloqueado'

  const registro = await navigator.serviceWorker.ready
  const suscripcion = await registro.pushManager.getSubscription()
  return suscripcion && Notification.permission === 'granted' ? 'activo' : 'inactivo'
}

/**
 * Pide permiso, suscribe este dispositivo y lo registra en la base.
 * Tiene que llamarse directo desde un toque: los navegadores ignoran el
 * permiso pedido fuera de un gesto del usuario.
 */
export async function activarPush(paseadorId) {
  if (!CLAVE_VAPID) throw new Error('Falta VAPID_PUBLIC_KEY en el entorno')

  const permiso = await Notification.requestPermission()
  if (permiso !== 'granted') return 'bloqueado'

  const registro = await navigator.serviceWorker.ready
  const suscripcion = (await registro.pushManager.getSubscription()) ??
    (await registro.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: claveABytes(CLAVE_VAPID)
    }))

  const { endpoint, keys } = suscripcion.toJSON()
  const { error } = await supabase.from('suscripcion_push').upsert(
    { paseador_id: paseadorId, endpoint, p256dh: keys.p256dh, auth: keys.auth, activa: true },
    { onConflict: 'endpoint' }
  )
  if (error) throw error
  return 'activo'
}

/** Apaga los avisos en este dispositivo. La fila queda, con `activa = false`. */
export async function desactivarPush() {
  const registro = await navigator.serviceWorker.ready
  const suscripcion = await registro.pushManager.getSubscription()
  if (!suscripcion) return

  const { error } = await supabase
    .from('suscripcion_push')
    .update({ activa: false })
    .eq('endpoint', suscripcion.endpoint)
  if (error) throw error
  await suscripcion.unsubscribe()
}

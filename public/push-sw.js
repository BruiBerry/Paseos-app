// Manejo de push, cargado dentro del service worker que genera vite-plugin-pwa
// (`workbox.importScripts` en vite.config.js). Vive aparte y no se reescribe
// el SW completo para no tocar el caché offline, que ya funciona.

self.addEventListener('push', (event) => {
  let datos = {}
  try {
    datos = event.data ? event.data.json() : {}
  } catch {
    datos = { cuerpo: event.data ? event.data.text() : '' }
  }

  // iOS exige mostrar una notificación por cada push que llega: si un push
  // no termina en `showNotification`, Safari da de baja la suscripción. Por
  // eso siempre se muestra algo, aunque el payload venga vacío o roto.
  event.waitUntil(
    self.registration.showNotification(datos.titulo || 'Paseos', {
      body: datos.cuerpo || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      // Mismo tag reemplaza en vez de apilar: un reintento no duplica el aviso.
      tag: datos.tag,
      data: { url: datos.url || '/' }
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const destino = new URL(event.notification.data?.url || '/', self.location.origin).href

  event.waitUntil((async () => {
    const ventanas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const ventana of ventanas) {
      if (!('focus' in ventana)) continue
      await ventana.focus()
      try {
        if ('navigate' in ventana) await ventana.navigate(destino)
        return
      } catch {
        // Algunos navegadores no dejan navegar una ventana ya abierta.
        break
      }
    }
    return self.clients.openWindow(destino)
  })())
})

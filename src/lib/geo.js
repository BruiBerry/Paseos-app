// Detección de proximidad al abrir la app.
//
// No es geofencing: una PWA no puede despertar sola cuando llegas a una casa
// (iOS suspende el JavaScript y Chrome abandonó la API). Lo que sí se puede
// es mirar dónde estás en el momento en que abres la app, y si coincide con
// una casa que tiene paseo pendiente, dejar el botón de iniciar a un toque.

const RADIO_TIERRA_M = 6371000

export function distanciaM(a, b) {
  const rad = (g) => (g * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * RADIO_TIERRA_M * Math.asin(Math.sqrt(h))
}

/** Resuelve a null en vez de rechazar: no tener GPS no es un error a mostrar. */
export function ubicacionActual() {
  return new Promise((resolver) => {
    if (!navigator.geolocation) return resolver(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => resolver({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => resolver(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    )
  })
}

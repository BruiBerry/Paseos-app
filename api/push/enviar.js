// Envía los push que la base decidió que hay que mandar (spec §6).
//
// Este endpoint NO decide nada: qué avisar, a quién y con qué texto lo
// calcula `fn_avisos_pendientes` en SQL, junto a la lógica del cierre. Acá
// solo se firma con VAPID y se habla con el servicio de push del navegador,
// que es lo único que no se puede hacer desde Postgres.
//
// Lo dispara pg_cron con pg_net cada 5 minutos, mandando el secreto en
// `Authorization: Bearer`. El secreto no está en el entorno de Vercel: vive
// solo en la tabla `secreto_servidor`, y este endpoint se limita a pasárselo
// a la base, que es quien lo valida. Usa la llave `anon`, la misma que el
// navegador — igual que el feed .ics, ninguna llave que se salte RLS sale de
// Supabase.
//
// `?prueba=1` manda un aviso de prueba a todas las suscripciones activas, con
// el mismo secreto. Sirve para comprobar un dispositivo nuevo sin esperar a
// que un paseo se pase de la duración.

import webpush from 'web-push'
import { createClient } from '@supabase/supabase-js'

// Cuánto vale un aviso si el teléfono está apagado o sin señal. Pasado ese
// rato el servicio de push lo descarta: "tu paseo sigue corriendo" a las dos
// horas ya no es accionable.
const TTL_SEG = 10 * 60

async function enviarUno(suscripcion, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: suscripcion.endpoint, keys: { p256dh: suscripcion.p256dh, auth: suscripcion.auth } },
      JSON.stringify(payload),
      { TTL: TTL_SEG, urgency: 'high' }
    )
    return { ok: true }
  } catch (e) {
    // 404 y 410: el navegador dio de baja esa suscripción. No sirve reintentar.
    const caducada = e.statusCode === 404 || e.statusCode === 410
    if (!caducada) console.error('Falló un envío push', e.statusCode, e.body)
    return { ok: false, caducada, endpoint: suscripcion.endpoint }
  }
}

async function enviarATodas(suscripciones, payload) {
  const resultados = await Promise.all(suscripciones.map((s) => enviarUno(s, payload)))
  return {
    entregado: resultados.some((r) => r.ok),
    caducadas: resultados.filter((r) => r.caducada).map((r) => r.endpoint)
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).send('Método no permitido')
  }

  const cabecera = req.headers.authorization ?? ''
  const secreto = cabecera.startsWith('Bearer ') ? cabecera.slice(7) : ''
  if (!secreto) return res.status(401).send('No autorizado')

  const url = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  const vapidPublica = process.env.VAPID_PUBLIC_KEY
  const vapidPrivada = process.env.VAPID_PRIVATE_KEY
  const vapidContacto = process.env.VAPID_SUBJECT
  if (!url || !anonKey || !vapidPublica || !vapidPrivada || !vapidContacto) {
    console.error('Faltan variables de entorno del servidor para enviar push')
    return res.status(500).send('Mal configurado')
  }

  webpush.setVapidDetails(vapidContacto, vapidPublica, vapidPrivada)
  const supabase = createClient(url, anonKey, { auth: { persistSession: false } })

  if (req.query.prueba === '1') {
    const { data, error } = await supabase.rpc('fn_suscripciones_push', { p_secreto: secreto })
    if (error) {
      console.error('No se pudieron leer las suscripciones', error)
      return res.status(500).send('Error')
    }
    if (data === null) return res.status(401).send('No autorizado')

    const { entregado, caducadas } = await enviarATodas(data, {
      titulo: 'Prueba de avisos',
      cuerpo: 'Los avisos llegan a este dispositivo.',
      url: '/ajustes',
      tag: 'prueba'
    })
    if (caducadas.length) {
      await supabase.rpc('fn_registrar_avisos', {
        p_secreto: secreto,
        p_resultados: { avisos: [], caducadas }
      })
    }
    return res.status(200).json({ suscripciones: data.length, entregado })
  }

  const { data: avisos, error } = await supabase.rpc('fn_avisos_pendientes', { p_secreto: secreto })
  if (error) {
    console.error('No se pudieron leer los avisos pendientes', error)
    return res.status(500).send('Error')
  }
  // Secreto que no corresponde a nada: mismo trato que una cabecera ausente.
  if (avisos === null) return res.status(401).send('No autorizado')

  const resultadoAvisos = []
  const caducadas = new Set()
  for (const aviso of avisos) {
    // `paseo_ids` solo viene en los avisos de bloque (paseo próximo): la base
    // necesita saber qué paseos cubría para marcarlos todos. No es parte de
    // lo que se le muestra al paseador.
    const { suscripciones, paseo_id, paseo_ids, tipo, ...payload } = aviso
    const r = await enviarATodas(suscripciones, payload)
    resultadoAvisos.push({ paseo_id, paseo_ids, tipo, entregado: r.entregado })
    r.caducadas.forEach((e) => caducadas.add(e))
  }

  if (resultadoAvisos.length || caducadas.size) {
    const { error: errorRegistro } = await supabase.rpc('fn_registrar_avisos', {
      p_secreto: secreto,
      p_resultados: { avisos: resultadoAvisos, caducadas: [...caducadas] }
    })
    // Si el registro falla, el aviso se reenvía en la próxima corrida: mejor
    // un aviso repetido que uno que nunca se marca como entregado.
    if (errorRegistro) {
      console.error('No se pudo registrar el resultado de los avisos', errorRegistro)
      return res.status(500).send('Error')
    }
  }

  return res.status(200).json({
    avisos: resultadoAvisos.length,
    entregados: resultadoAvisos.filter((r) => r.entregado).length
  })
}

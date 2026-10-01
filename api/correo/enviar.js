// Envía los correos que la base decidió que hay que mandar (spec §6).
//
// Igual que `api/push/enviar.js`, este endpoint NO decide nada: a quién y con
// qué datos lo calcula `fn_correos_pendientes` en SQL. Acá solo se le da
// forma al texto y se habla con Resend, que es lo único que no se puede
// hacer desde Postgres.
//
// Lo dispara pg_cron con pg_net cada 15 minutos, con el secreto en
// `Authorization: Bearer`. El secreto no está en el entorno de Vercel: se lo
// pasamos a la base, que lo valida. Usa la llave `anon`; ninguna llave que se
// salte RLS sale de Supabase.
//
// Variables de entorno: RESEND_API_KEY y CORREO_REMITENTE. Sin dominio propio
// verificado en Resend, el remitente solo puede ser `onboarding@resend.dev` y
// el destinatario solo el correo de la cuenta de Resend: sirve mientras el
// paseador y esa cuenta sean el mismo correo.

import { createClient } from '@supabase/supabase-js'
import { asuntoSemanal, htmlSemanal, textoSemanal } from '../../src/lib/correoSemanal.js'

async function enviarSemanal(datos, { llave, remitente }) {
  const respuesta = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${llave}`,
      'Content-Type': 'application/json',
      // Si el registro falla y el correo se reintenta, Resend lo reconoce y
      // no lo manda dos veces.
      'Idempotency-Key': `semanal-${datos.paseador_id}-${datos.desde}`
    },
    body: JSON.stringify({
      from: remitente,
      to: [datos.email],
      subject: asuntoSemanal(datos),
      html: htmlSemanal(datos),
      text: textoSemanal(datos)
    })
  })
  if (!respuesta.ok) {
    console.error('Resend rechazó el correo', respuesta.status, await respuesta.text())
  }
  return respuesta.ok
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
  const llave = process.env.RESEND_API_KEY
  const remitente = process.env.CORREO_REMITENTE
  if (!url || !anonKey || !llave || !remitente) {
    console.error('Faltan variables de entorno del servidor para enviar correos')
    return res.status(500).send('Mal configurado')
  }

  const supabase = createClient(url, anonKey, { auth: { persistSession: false } })

  const { data: correos, error } = await supabase.rpc('fn_correos_pendientes', { p_secreto: secreto })
  if (error) {
    console.error('No se pudieron leer los correos pendientes', error)
    return res.status(500).send('Error')
  }
  // Secreto que no corresponde a nada: mismo trato que una cabecera ausente.
  if (correos === null) return res.status(401).send('No autorizado')

  const resultados = []
  for (const datos of correos) {
    const entregado = await enviarSemanal(datos, { llave, remitente })
    resultados.push({ paseador_id: datos.paseador_id, tipo: datos.tipo, entregado })
  }

  if (resultados.length) {
    const { error: errorRegistro } = await supabase.rpc('fn_registrar_correos', {
      p_secreto: secreto,
      p_resultados: { correos: resultados }
    })
    // Si el registro falla, el correo se reintenta en la próxima corrida:
    // la Idempotency-Key evita que llegue repetido.
    if (errorRegistro) {
      console.error('No se pudo registrar el resultado de los correos', errorRegistro)
      return res.status(500).send('Error')
    }
  }

  return res.status(200).json({
    correos: resultados.length,
    entregados: resultados.filter((r) => r.entregado).length
  })
}

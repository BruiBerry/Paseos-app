// Sirve el feed `.ics` que el paseador suscribe en su calendario (spec §7).
//
// Existe como función de servidor porque una app de calendario pide la URL
// sin cabeceras ni sesión: no puede mandar la llave, ni un token de Supabase,
// ni negociar nada. Solo hace GET y espera `text/calendar`.
//
// Usa la llave `anon`, la misma que el navegador. Quien autoriza es
// `fn_agenda_por_token`, que es SECURITY DEFINER y valida el token dentro de
// la base. Así ninguna llave capaz de saltarse RLS sale de Supabase: si esta
// función se viera comprometida, no expondría más de lo que ya expone el
// bundle público.

import { createClient } from '@supabase/supabase-js'
import { construirICS } from '../../src/lib/ics.js'

// Cuánto publica el feed. Ocho semanas hacia adelante es el mismo horizonte
// que materializa las reglas recurrentes: más allá de eso no hay paseos que
// mostrar. Cuatro hacia atrás dejan ver la semana pasada sin engordar el
// archivo, que el teléfono vuelve a bajar entero en cada refresco.
const SEMANAS_ADELANTE = 8
const SEMANAS_ATRAS = 4

function fechaISO(base, dias) {
  const f = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dias)
  const dosDig = (n) => String(n).padStart(2, '0')
  return `${f.getFullYear()}-${dosDig(f.getMonth() + 1)}-${dosDig(f.getDate())}`
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD')
    return res.status(405).send('Método no permitido')
  }

  const { token } = req.query
  if (typeof token !== 'string' || token.length < 32) {
    return res.status(404).send('No encontrado')
  }

  const url = process.env.VITE_SUPABASE_URL
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !anonKey) {
    console.error('Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY en el entorno del servidor')
    return res.status(500).send('Mal configurado')
  }

  const supabase = createClient(url, anonKey, { auth: { persistSession: false } })

  // El `.ics` se pide desde el teléfono del paseador, que puede estar en
  // cualquier parte, así que el rango se ancla al día del servidor. Basta:
  // un día de corrimiento en los bordes de una ventana de doce semanas no
  // cambia nada de lo que el paseador ve.
  const hoy = new Date()
  const { data, error } = await supabase.rpc('fn_agenda_por_token', {
    p_token: token,
    p_desde: fechaISO(hoy, -SEMANAS_ATRAS * 7),
    p_hasta: fechaISO(hoy, SEMANAS_ADELANTE * 7)
  })

  if (error) {
    console.error('No se pudo leer la agenda', error)
    return res.status(500).send('Error al generar el calendario')
  }

  // Token que no corresponde a nadie. Se responde igual que una URL
  // inexistente, sin decir si el token existe pero está vacío: la URL es la
  // contraseña, y una respuesta distinta ayudaría a adivinarla.
  if (!data) return res.status(404).send('No encontrado')

  const ics = construirICS({ paseos: data.paseos ?? [], config: data.config ?? {} })

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
  res.setHeader('Content-Disposition', 'inline; filename="paseos.ics"')
  // Sin caché intermedia: la URL es secreta y el contenido es personal.
  // Igual el teléfono refresca cuando quiere — esa es la limitación conocida
  // del feed (spec §7), y no hay cabecera que la cambie.
  res.setHeader('Cache-Control', 'private, no-store')
  return res.status(200).send(ics)
}

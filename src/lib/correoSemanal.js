// Arma el correo del resumen semanal (spec §6). Sin dependencias de red:
// recibe lo que devuelve `fn_correos_semanales_pendientes` y entrega el
// asunto y el cuerpo, para poder probarlo con `node` sin Supabase ni Resend.
//
// La base decide a quién y con qué datos; acá solo se le da forma. El correo
// no lleva direcciones ni notas de acceso: es un orden de la semana, y esos
// datos viven en la app.

import { sumarDias, fechaLarga } from './fechas.js'
import { pesos } from './formato.js'

const escapar = (texto) =>
  String(texto)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`

/** 'Tu semana: 14 paseos, $98.000' — el asunto lleva la información completa. */
export function asuntoSemanal({ n_paseos, monto }) {
  return `Tu semana: ${plural(n_paseos, 'paseo', 'paseos')}, ${pesos(monto)}`
}

/** Los siete días desde `desde`, con sus paseos (vacío si no hay). */
function porDia({ desde, paseos }) {
  return Array.from({ length: 7 }, (_, i) => {
    const fecha = sumarDias(desde, i)
    return { fecha, paseos: paseos.filter((p) => p.fecha === fecha) }
  })
}

function textoPaseo(p) {
  const perros = p.perros.join(', ')
  return `${p.hora}–${p.fin}  ${p.grupo} (${perros})  ${pesos(p.monto)}`
}

/** Versión en texto plano: es lo que muestran los clientes que no pintan HTML. */
export function textoSemanal(datos) {
  const lineas = [`Hola ${datos.nombre},`, '', asuntoSemanal(datos), '']

  for (const dia of porDia(datos)) {
    lineas.push(fechaLarga(dia.fecha))
    if (!dia.paseos.length) lineas.push('  Sin paseos')
    for (const p of dia.paseos) lineas.push('  ' + textoPaseo(p))
    lineas.push('')
  }

  const atencion = []
  for (const c of datos.choques) {
    atencion.push(
      `Horarios que se pisan el ${fechaLarga(c.fecha)}: ${c.a_grupo} (${c.a_hora}–${c.a_fin}) y ${c.b_grupo} (${c.b_hora}).`
    )
  }
  if (datos.sin_tarifa.length) {
    atencion.push(`Sin tarifa configurada, se cobra la tarifa por defecto: ${datos.sin_tarifa.join(', ')}.`)
  }
  if (atencion.length) lineas.push('Necesita tu atención', ...atencion.map((a) => '  - ' + a), '')

  return lineas.join('\n')
}

/** Versión en HTML, con estilos en línea: los clientes de correo ignoran las hojas. */
export function htmlSemanal(datos) {
  const dias = porDia(datos)
    .map((dia) => {
      const filas = dia.paseos.length
        ? dia.paseos
            .map(
              (p) =>
                `<tr>
                  <td style="padding:4px 12px 4px 0;white-space:nowrap;color:#555">${p.hora}–${p.fin}</td>
                  <td style="padding:4px 12px 4px 0">${escapar(p.grupo)}<br><span style="color:#777;font-size:13px">${escapar(p.perros.join(', '))}</span></td>
                  <td style="padding:4px 0;text-align:right;white-space:nowrap">${pesos(p.monto)}</td>
                </tr>`
            )
            .join('')
        : `<tr><td colspan="3" style="padding:4px 0;color:#999">Sin paseos</td></tr>`
      return `<h3 style="margin:18px 0 4px;font-size:15px;text-transform:capitalize">${fechaLarga(dia.fecha)}</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px">${filas}</table>`
    })
    .join('')

  const items = [
    ...datos.choques.map(
      (c) =>
        `Horarios que se pisan el ${escapar(fechaLarga(c.fecha))}: <b>${escapar(c.a_grupo)}</b> (${c.a_hora}–${c.a_fin}) y <b>${escapar(c.b_grupo)}</b> (${c.b_hora}).`
    )
  ]
  if (datos.sin_tarifa.length) {
    items.push(
      `Sin tarifa configurada, se cobra la tarifa por defecto: ${datos.sin_tarifa.map(escapar).join(', ')}.`
    )
  }
  const atencion = items.length
    ? `<div style="margin-top:24px;padding:12px 16px;background:#fff4e5;border-radius:8px">
        <b>Necesita tu atención</b>
        <ul style="margin:8px 0 0;padding-left:18px">${items.map((i) => `<li>${i}</li>`).join('')}</ul>
      </div>`
    : ''

  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;color:#222">
    <p>Hola ${escapar(datos.nombre)},</p>
    <h2 style="margin:8px 0 0">${escapar(asuntoSemanal(datos))}</h2>
    <p style="margin:2px 0 0;color:#777;font-size:13px">Hasta el ${fechaLarga(datos.hasta)}</p>
    ${dias}
    ${atencion}
  </div>`
}

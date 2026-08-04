import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useSesion } from '../lib/sesion'
import { pesos } from '../lib/formato'
import { hora as soloHora } from '../lib/fechas'
import { Barra, Campo, Cargando } from '../components/ui'

export default function Ajustes() {
  const { sesion, paseadorId, config, cargandoConfig, recargarConfig, salir } = useSesion()
  const [form, setForm] = useState(null)
  const [guardando, setGuardando] = useState(false)
  const [mensaje, setMensaje] = useState(null)

  useEffect(() => {
    if (!config) return
    setForm({
      tarifa_default: config.tarifa_default,
      recargo_perro_adicional: config.recargo_perro_adicional,
      duracion_default_min: config.duracion_default_min,
      radio_geocerca_m: config.radio_geocerca_m,
      hora_resumen_diario: soloHora(config.hora_resumen_diario),
      minutos_aviso_previo: config.minutos_aviso_previo
    })
  }, [config])

  const set = (campo) => (e) => setForm({ ...form, [campo]: e.target.value })

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setMensaje(null)
    const { error } = await supabase.from('configuracion').update({
      tarifa_default: Number(form.tarifa_default),
      recargo_perro_adicional: Number(form.recargo_perro_adicional),
      duracion_default_min: Number(form.duracion_default_min),
      radio_geocerca_m: Number(form.radio_geocerca_m),
      hora_resumen_diario: form.hora_resumen_diario,
      minutos_aviso_previo: Number(form.minutos_aviso_previo)
    }).eq('paseador_id', paseadorId)

    setGuardando(false)
    if (error) { console.error(error); setMensaje('No se pudo guardar.'); return }
    await recargarConfig()
    setMensaje('Guardado.')
  }

  if (cargandoConfig || !form) return <Cargando />

  return (
    <div>
      <Barra titulo="Ajustes" />

      <form onSubmit={guardar}>
        <h2 style={{ marginBottom: 10 }}>Tarifas</h2>
        <Campo
          etiqueta="Tarifa por paseo"
          pista="Se usa con los clientes que no tienen tarifa propia."
        >
          <input type="number" inputMode="numeric" value={form.tarifa_default} onChange={set('tarifa_default')} required />
        </Campo>
        <Campo
          etiqueta="Recargo por perro adicional"
          pista="Desde el segundo perro de una misma casa en un mismo paseo. Puede ser 0."
        >
          <input
            type="number"
            inputMode="numeric"
            value={form.recargo_perro_adicional}
            onChange={set('recargo_perro_adicional')}
            required
          />
        </Campo>

        <h2 style={{ margin: '22px 0 10px' }}>Paseos</h2>
        <Campo etiqueta="Duración por defecto (minutos)">
          <input
            type="number"
            inputMode="numeric"
            value={form.duracion_default_min}
            onChange={set('duracion_default_min')}
            required
          />
        </Campo>
        <Campo etiqueta="Radio de proximidad (metros)" pista="A qué distancia de la casa la app te ofrece iniciar el paseo.">
          <input type="number" inputMode="numeric" value={form.radio_geocerca_m} onChange={set('radio_geocerca_m')} required />
        </Campo>

        <h2 style={{ margin: '22px 0 10px' }}>Avisos</h2>
        <Campo etiqueta="Hora del resumen diario">
          <input type="time" value={form.hora_resumen_diario} onChange={set('hora_resumen_diario')} required />
        </Campo>
        <Campo etiqueta="Aviso previo (minutos antes)">
          <input
            type="number"
            inputMode="numeric"
            value={form.minutos_aviso_previo}
            onChange={set('minutos_aviso_previo')}
            required
          />
        </Campo>
        <p className="aviso info" style={{ marginBottom: 16 }}>
          Estos horarios quedan guardados, pero todavía no se envía ninguna notificación:
          eso necesita el trabajo del servidor que aún no existe.
        </p>

        {mensaje && <p className={mensaje === 'Guardado.' ? 'micro' : 'error'}>{mensaje}</p>}
        <button className="boton primario ancho" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Guardar ajustes'}
        </button>
      </form>

      <div style={{ marginTop: 32, paddingTop: 16, borderTop: '0.5px solid var(--borde)' }}>
        <p className="micro">Sesión iniciada como {sesion?.user?.email}</p>
        <p className="micro">
          Con la configuración actual, un paseo de un perro cuesta {pesos(form.tarifa_default)} y
          el segundo perro de la misma casa suma {pesos(form.recargo_perro_adicional)}.
        </p>
        <button className="boton ancho" style={{ marginTop: 12 }} onClick={salir}>
          Cerrar sesión
        </button>
      </div>
    </div>
  )
}

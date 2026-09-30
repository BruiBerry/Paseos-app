import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useSesion } from '../lib/sesion'
import { pesos } from '../lib/formato'
import { hora as soloHora } from '../lib/fechas'
import { estadoPush, activarPush, desactivarPush } from '../lib/push'
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
          El aviso previo ya se usa. La hora del resumen diario queda guardada, pero
          todavía no se envía ese aviso.
        </p>

        {mensaje && <p className={mensaje === 'Guardado.' ? 'micro' : 'error'}>{mensaje}</p>}
        <button className="boton primario ancho" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Guardar ajustes'}
        </button>
      </form>

      <AvisosPush paseadorId={paseadorId} />

      <FeedCalendario config={config} paseadorId={paseadorId} recargarConfig={recargarConfig} />

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

/**
 * Avisos push en ESTE dispositivo (spec §6).
 *
 * La suscripción es por dispositivo, no por cuenta: activarlos en el
 * teléfono no los enciende en otro navegador donde también tengas la sesión.
 * En iPhone solo funcionan con la app instalada en la pantalla de inicio, así
 * que ese caso explica qué hacer en vez de mostrar un botón que no serviría.
 */
function AvisosPush({ paseadorId }) {
  const [estado, setEstado] = useState(null)
  const [trabajando, setTrabajando] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    estadoPush().then(setEstado).catch((e) => { console.error(e); setEstado('no-soportado') })
  }, [])

  async function alternar(e) {
    setTrabajando(true)
    setError(null)
    try {
      if (e.target.checked) setEstado(await activarPush(paseadorId))
      else { await desactivarPush(); setEstado('inactivo') }
    } catch (err) {
      console.error(err)
      setError('No se pudo cambiar. Intenta de nuevo.')
      setEstado(await estadoPush())
    }
    setTrabajando(false)
  }

  if (!estado) return null

  return (
    <div style={{ marginTop: 32, paddingTop: 16, borderTop: '0.5px solid var(--borde)' }}>
      <h2 style={{ marginBottom: 10 }}>Notificaciones</h2>

      {estado === 'requiere-instalar' && (
        <p className="aviso info">
          En iPhone los avisos solo llegan con la app instalada. En Safari toca
          Compartir → «Agregar a pantalla de inicio», ábrela desde ahí y vuelve
          a esta pantalla.
        </p>
      )}
      {estado === 'no-soportado' && (
        <p className="aviso info">Este navegador no admite notificaciones.</p>
      )}
      {estado === 'bloqueado' && (
        <p className="aviso info">
          Las notificaciones están bloqueadas para esta app. Actívalas en los
          ajustes del teléfono o del navegador y vuelve aquí.
        </p>
      )}
      {(estado === 'activo' || estado === 'inactivo') && (
        <>
          <label className="fila" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={estado === 'activo'}
              onChange={alternar}
              disabled={trabajando}
            />
            <div className="crece">
              <div>Recibir avisos en este dispositivo</div>
              <div className="micro">
                Te avisa antes de cada paseo, con la dirección, y cuando uno se pasa
                de su duración, antes de que la app lo cierre sola.
              </div>
            </div>
          </label>
          {error && <p className="error">{error}</p>}
        </>
      )}
    </div>
  )
}

/**
 * La suscripción del calendario (spec §7).
 *
 * La URL es la contraseña: quien la tenga ve la agenda completa sin
 * necesidad de contraseña ni sesión. Por eso la pantalla la trata como un
 * secreto —se muestra tapada— y ofrece regenerarla, que es lo único que
 * revoca el acceso de una copia que se compartió de más.
 */
function FeedCalendario({ config, paseadorId, recargarConfig }) {
  const [visible, setVisible] = useState(false)
  const [copiado, setCopiado] = useState(false)
  const [trabajando, setTrabajando] = useState(false)

  const url = config?.token_calendario
    ? `${window.location.origin}/api/calendario/${config.token_calendario}`
    : null

  async function copiar() {
    try {
      await navigator.clipboard.writeText(url)
      setCopiado(true)
      setTimeout(() => setCopiado(false), 2000)
    } catch {
      // Sin permiso de portapapeles no queda más que mostrarla para copiar a mano.
      setVisible(true)
    }
  }

  async function regenerar() {
    const seguro = window.confirm(
      'La dirección actual dejará de funcionar y el calendario de tu teléfono ' +
      'quedará vacío hasta que lo suscribas de nuevo. ¿Continuar?'
    )
    if (!seguro) return
    setTrabajando(true)
    const { error } = await supabase.rpc('fn_regenerar_token_calendario')
    setTrabajando(false)
    if (error) { console.error(error); return }
    setVisible(false)
    await recargarConfig()
  }

  async function alternarNotas(e) {
    const incluir = e.target.checked
    if (incluir) {
      const seguro = window.confirm(
        'Las notas de acceso son códigos de portón y dónde están las llaves de ' +
        'casas de tus clientes. Encender esto las copia al calendario de tu ' +
        'teléfono y a su respaldo en la nube. ¿Continuar?'
      )
      if (!seguro) { e.target.checked = false; return }
    }
    setTrabajando(true)
    const { error } = await supabase
      .from('configuracion')
      .update({ calendario_incluye_notas: incluir })
      .eq('paseador_id', paseadorId)
    setTrabajando(false)
    if (error) { console.error(error); return }
    await recargarConfig()
  }

  if (!url) return null

  return (
    <div style={{ marginTop: 32, paddingTop: 16, borderTop: '0.5px solid var(--borde)' }}>
      <h2 style={{ marginBottom: 10 }}>Calendario</h2>
      <p className="micro">
        Suscribe esta dirección en el calendario de tu teléfono y los paseos
        aparecen junto al resto de tu agenda. Tu teléfono decide cada cuánto la
        revisa, así que un cambio de última hora puede tardar en reflejarse.
      </p>

      <div className="tarjeta" style={{ marginTop: 10 }}>
        <div className="micro" style={{ wordBreak: 'break-all', fontFamily: 'monospace' }}>
          {visible ? url : '••••••••••••••••••••••••••••••••'}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="boton chico" onClick={() => setVisible((v) => !v)}>
            {visible ? 'Ocultar' : 'Mostrar'}
          </button>
          <button className="boton chico" onClick={copiar}>
            {copiado ? 'Copiada' : 'Copiar'}
          </button>
        </div>
      </div>

      <p className="micro" style={{ marginTop: 10 }}>
        Cualquiera con esta dirección puede ver tu agenda: no pide contraseña.
        Trátala como una.
      </p>

      <label className="fila" style={{ marginTop: 12, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={Boolean(config.calendario_incluye_notas)}
          onChange={alternarNotas}
          disabled={trabajando}
        />
        <div className="crece">
          <div>Incluir notas de acceso</div>
          <div className="micro">
            Códigos de portón y dónde están las llaves. Apagado, esa información
            se queda solo dentro de la app.
          </div>
        </div>
      </label>

      <button
        className="boton ancho"
        style={{ marginTop: 12 }}
        onClick={regenerar}
        disabled={trabajando}
      >
        {trabajando ? 'Trabajando…' : 'Generar una dirección nueva'}
      </button>
    </div>
  )
}

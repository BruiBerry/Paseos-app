import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useSesion } from '../lib/sesion'
import { pesos, aEnteroONulo } from '../lib/formato'
import { Barra, Campo, Cargando, ErrorCarga, Hoja, Punto, Vacio } from '../components/ui'

export default function Cliente() {
  const { id } = useParams()
  const { paseadorId, config } = useSesion()
  const [cliente, setCliente] = useState(null)
  const [perros, setPerros] = useState([])
  const [estado, setEstado] = useState('cargando')
  const [editando, setEditando] = useState(false)
  const [perroEnEdicion, setPerroEnEdicion] = useState(null) // objeto | 'nuevo' | null

  const cargar = useCallback(async () => {
    const [resCliente, resPerros] = await Promise.all([
      supabase.from('cliente').select('*').eq('id', id).single(),
      supabase.from('perro').select('*').eq('cliente_id', id).order('nombre')
    ])
    if (resCliente.error) { console.error(resCliente.error); setEstado('error'); return }
    setCliente(resCliente.data)
    setPerros(resPerros.data ?? [])
    setEstado('ok')
  }, [id])

  useEffect(() => { cargar() }, [cargar])

  async function alternarBaja() {
    const nuevo = !cliente.activo
    const texto = nuevo
      ? '¿Reactivar a este cliente?'
      : '¿Dar de baja a este cliente? No se borra nada: el historial y los cobros quedan intactos.'
    if (!window.confirm(texto)) return
    const { error } = await supabase.from('cliente').update({ activo: nuevo }).eq('id', id)
    if (error) { console.error(error); return }
    cargar()
  }

  if (estado === 'cargando') return <Cargando />
  if (estado === 'error') return <ErrorCarga />

  return (
    <div>
      <Barra
        titulo={cliente.nombre}
        volver="/clientes"
        accion={<button className="boton chico" onClick={() => setEditando(true)}>Editar</button>}
      />

      {!cliente.activo && (
        <div className="aviso" style={{ marginBottom: 12 }}>
          Cliente dado de baja. No aparece al armar paseos nuevos.
        </div>
      )}

      <div className="tarjeta" style={{ marginBottom: 16 }}>
        <Dato etiqueta="Teléfono" valor={cliente.telefono} enlace={cliente.telefono && `tel:${cliente.telefono}`} />
        <Dato etiqueta="Correo" valor={cliente.email} />
        <Dato etiqueta="Dirección" valor={cliente.direccion} />
        <Dato
          etiqueta="Tarifa por paseo"
          valor={cliente.tarifa_paseo == null
            ? `${pesos(config?.tarifa_default)} (por defecto)`
            : pesos(cliente.tarifa_paseo)}
        />
        <Dato
          etiqueta="Perro adicional"
          valor={cliente.tarifa_perro_adicional == null
            ? `${pesos(config?.recargo_perro_adicional)} (por defecto)`
            : pesos(cliente.tarifa_perro_adicional)}
        />
        <Dato etiqueta="Notas de acceso" valor={cliente.notas_acceso} ultimo />
      </div>

      <div className="barra">
        <h2>Perros</h2>
        <button className="boton chico" onClick={() => setPerroEnEdicion('nuevo')}>+ Perro</button>
      </div>

      {perros.length === 0
        ? <Vacio>Sin perros todavía.</Vacio>
        : (
          <div className="lista">
            {perros.map((p) => (
              <button
                key={p.id}
                className={`fila${p.activo ? '' : ' atenuado'}`}
                onClick={() => setPerroEnEdicion(p)}
              >
                <Punto color={p.color_hex} />
                <div className="crece">
                  <div>{p.nombre}</div>
                  <div className="micro">
                    {p.duracion_min ? `${p.duracion_min} min` : `${config?.duracion_default_min ?? 60} min (por defecto)`}
                    {p.notas ? ` · ${p.notas}` : ''}
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}

      <button className="boton peligro ancho" style={{ marginTop: 24 }} onClick={alternarBaja}>
        {cliente.activo ? 'Dar de baja' : 'Reactivar cliente'}
      </button>

      {editando && (
        <HojaEditarCliente
          cliente={cliente}
          config={config}
          onCerrar={() => setEditando(false)}
          onListo={() => { setEditando(false); cargar() }}
        />
      )}

      {perroEnEdicion && (
        <HojaPerro
          perro={perroEnEdicion === 'nuevo' ? null : perroEnEdicion}
          clienteId={id}
          paseadorId={paseadorId}
          config={config}
          onCerrar={() => setPerroEnEdicion(null)}
          onListo={() => { setPerroEnEdicion(null); cargar() }}
        />
      )}
    </div>
  )
}

function Dato({ etiqueta, valor, enlace, ultimo }) {
  return (
    <div style={{
      display: 'flex',
      gap: 12,
      padding: '6px 0',
      borderBottom: ultimo ? 'none' : '0.5px solid #EDEBE5'
    }}>
      <span className="micro" style={{ width: 120, flex: 'none' }}>{etiqueta}</span>
      <span style={{ flex: 1, fontSize: 14 }}>
        {valor
          ? (enlace ? <a href={enlace} style={{ color: 'var(--azul)' }}>{valor}</a> : valor)
          : <span className="micro">—</span>}
      </span>
    </div>
  )
}

function HojaEditarCliente({ cliente, config, onCerrar, onListo }) {
  const [form, setForm] = useState({
    nombre: cliente.nombre ?? '',
    telefono: cliente.telefono ?? '',
    email: cliente.email ?? '',
    direccion: cliente.direccion ?? '',
    tarifa_paseo: cliente.tarifa_paseo ?? '',
    tarifa_perro_adicional: cliente.tarifa_perro_adicional ?? '',
    notas_acceso: cliente.notas_acceso ?? '',
    lat: cliente.lat ?? '',
    lng: cliente.lng ?? ''
  })
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)
  const [ubicando, setUbicando] = useState(false)

  const set = (campo) => (e) => setForm({ ...form, [campo]: e.target.value })

  function usarUbicacionActual() {
    if (!navigator.geolocation) { setError('Este navegador no entrega la ubicación.'); return }
    setUbicando(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUbicando(false)
        setForm((f) => ({
          ...f,
          lat: pos.coords.latitude.toFixed(6),
          lng: pos.coords.longitude.toFixed(6)
        }))
      },
      (err) => { setUbicando(false); console.error(err); setError('No se pudo obtener la ubicación.') },
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    const { error: err } = await supabase.from('cliente').update({
      nombre: form.nombre.trim(),
      telefono: form.telefono.trim() || null,
      email: form.email.trim() || null,
      direccion: form.direccion.trim() || null,
      tarifa_paseo: aEnteroONulo(form.tarifa_paseo),
      tarifa_perro_adicional: aEnteroONulo(form.tarifa_perro_adicional),
      notas_acceso: form.notas_acceso.trim() || null,
      lat: form.lat === '' ? null : Number(form.lat),
      lng: form.lng === '' ? null : Number(form.lng)
    }).eq('id', cliente.id)
    setGuardando(false)
    if (err) { console.error(err); setError('No se pudo guardar.'); return }
    onListo()
  }

  return (
    <Hoja titulo="Editar cliente" onCerrar={onCerrar}>
      <form onSubmit={guardar}>
        <Campo etiqueta="Nombre">
          <input value={form.nombre} onChange={set('nombre')} required />
        </Campo>
        <Campo etiqueta="Teléfono">
          <input type="tel" value={form.telefono} onChange={set('telefono')} />
        </Campo>
        <Campo etiqueta="Correo">
          <input type="email" value={form.email} onChange={set('email')} />
        </Campo>
        <Campo etiqueta="Dirección">
          <input value={form.direccion} onChange={set('direccion')} />
        </Campo>

        <Campo
          etiqueta="Tarifa por paseo"
          pista={`Déjala vacía para usar la tarifa por defecto (${pesos(config?.tarifa_default)}).`}
        >
          <input type="number" inputMode="numeric" value={form.tarifa_paseo} onChange={set('tarifa_paseo')} />
        </Campo>
        <Campo
          etiqueta="Perro adicional de la misma casa"
          pista={`Vacía usa el recargo por defecto (${pesos(config?.recargo_perro_adicional)}). Se aplica desde el segundo perro de este cliente en un mismo paseo.`}
        >
          <input
            type="number"
            inputMode="numeric"
            value={form.tarifa_perro_adicional}
            onChange={set('tarifa_perro_adicional')}
          />
        </Campo>

        <Campo
          etiqueta="Notas de acceso"
          pista="Código del portón, dónde está la llave. No sale de la app."
        >
          <textarea value={form.notas_acceso} onChange={set('notas_acceso')} />
        </Campo>

        <Campo etiqueta="Ubicación" pista="Para detectar que llegaste. Se llena mejor parado frente a la casa.">
          <div style={{ display: 'flex', gap: 6 }}>
            <input placeholder="Latitud" value={form.lat} onChange={set('lat')} />
            <input placeholder="Longitud" value={form.lng} onChange={set('lng')} />
          </div>
        </Campo>
        <button type="button" className="boton chico" onClick={usarUbicacionActual} disabled={ubicando}>
          {ubicando ? 'Ubicando…' : 'Usar mi ubicación actual'}
        </button>

        {error && <p className="error">{error}</p>}
        <button className="boton primario ancho" style={{ marginTop: 16 }} disabled={guardando}>
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </form>
    </Hoja>
  )
}

function HojaPerro({ perro, clienteId, paseadorId, config, onCerrar, onListo }) {
  const [form, setForm] = useState({
    nombre: perro?.nombre ?? '',
    duracion_min: perro?.duracion_min ?? '',
    color_hex: perro?.color_hex ?? '#7F77DD',
    notas: perro?.notas ?? '',
    activo: perro?.activo ?? true
  })
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  const set = (campo) => (e) => setForm({ ...form, [campo]: e.target.value })

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)

    const valores = {
      nombre: form.nombre.trim(),
      duracion_min: aEnteroONulo(form.duracion_min),
      color_hex: form.color_hex,
      notas: form.notas.trim() || null,
      activo: form.activo
    }

    const { error: err } = perro
      ? await supabase.from('perro').update(valores).eq('id', perro.id)
      : await supabase.from('perro').insert({ ...valores, paseador_id: paseadorId, cliente_id: clienteId })

    setGuardando(false)
    if (err) { console.error(err); setError('No se pudo guardar.'); return }
    onListo()
  }

  return (
    <Hoja titulo={perro ? `Editar a ${perro.nombre}` : 'Nuevo perro'} onCerrar={onCerrar}>
      <form onSubmit={guardar}>
        <Campo etiqueta="Nombre">
          <input value={form.nombre} onChange={set('nombre')} required autoFocus={!perro} />
        </Campo>
        <Campo
          etiqueta="Duración del paseo (minutos)"
          pista={`Vacía usa la duración por defecto (${config?.duracion_default_min ?? 60} min). Si va en grupo, manda la más larga del grupo.`}
        >
          <input type="number" inputMode="numeric" value={form.duracion_min} onChange={set('duracion_min')} />
        </Campo>
        <Campo etiqueta="Color">
          <input type="color" value={form.color_hex} onChange={set('color_hex')} style={{ height: 44, padding: 4 }} />
        </Campo>
        <Campo etiqueta="Notas" pista="Temperamento, medicamentos, con quién no se lleva.">
          <textarea value={form.notas} onChange={set('notas')} />
        </Campo>

        {perro && (
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, fontSize: 14 }}>
            <input
              type="checkbox"
              checked={form.activo}
              onChange={(e) => setForm({ ...form, activo: e.target.checked })}
            />
            Activo
          </label>
        )}

        {error && <p className="error">{error}</p>}
        <button className="boton primario ancho" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </form>
    </Hoja>
  )
}

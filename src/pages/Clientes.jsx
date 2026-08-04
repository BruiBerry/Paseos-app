import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useSesion } from '../lib/sesion'
import { pesos } from '../lib/formato'
import { Barra, Campo, Cargando, ErrorCarga, Hoja, Punto, Vacio } from '../components/ui'

export default function Clientes() {
  const { paseadorId } = useSesion()
  const [pestana, setPestana] = useState('clientes')
  const [clientes, setClientes] = useState([])
  const [grupos, setGrupos] = useState([])
  const [estado, setEstado] = useState('cargando')
  const [creando, setCreando] = useState(null) // 'cliente' | 'grupo' | null

  const cargar = useCallback(async () => {
    const [resClientes, resGrupos] = await Promise.all([
      supabase
        .from('cliente')
        .select('id,nombre,telefono,direccion,tarifa_paseo,activo,perro(id,activo)')
        .order('nombre'),
      supabase
        .from('grupo')
        .select('id,nombre,color_hex,zona,grupo_perro(perro_id)')
        .order('nombre')
    ])

    if (resClientes.error || resGrupos.error) {
      console.error(resClientes.error ?? resGrupos.error)
      setEstado('error')
      return
    }
    setClientes(resClientes.data ?? [])
    setGrupos(resGrupos.data ?? [])
    setEstado('ok')
  }, [])

  useEffect(() => { cargar() }, [cargar])

  const enClientes = pestana === 'clientes'

  return (
    <div>
      <Barra
        titulo="Clientes"
        accion={
          <button className="boton chico" onClick={() => setCreando(enClientes ? 'cliente' : 'grupo')}>
            + {enClientes ? 'Cliente' : 'Grupo'}
          </button>
        }
      />

      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {[['clientes', 'Clientes'], ['grupos', 'Grupos']].map(([clave, texto]) => (
          <button
            key={clave}
            className={`boton chico${pestana === clave ? ' primario' : ''}`}
            onClick={() => setPestana(clave)}
          >
            {texto}
          </button>
        ))}
      </div>

      {estado === 'cargando' && <Cargando />}
      {estado === 'error' && <ErrorCarga />}

      {estado === 'ok' && enClientes && <ListaClientes clientes={clientes} />}
      {estado === 'ok' && !enClientes && <ListaGrupos grupos={grupos} />}

      {creando === 'cliente' && (
        <HojaNuevoCliente
          paseadorId={paseadorId}
          onCerrar={() => setCreando(null)}
          onListo={() => { setCreando(null); cargar() }}
        />
      )}
      {creando === 'grupo' && (
        <HojaNuevoGrupo
          paseadorId={paseadorId}
          onCerrar={() => setCreando(null)}
          onListo={() => { setCreando(null); cargar() }}
        />
      )}
    </div>
  )
}

function ListaClientes({ clientes }) {
  const activos = clientes.filter((c) => c.activo)
  const inactivos = clientes.filter((c) => !c.activo)

  if (!clientes.length) {
    return <Vacio>Todavía no hay clientes. Empieza por acá: los perros y los grupos cuelgan de ellos.</Vacio>
  }

  return (
    <div className="lista">
      {activos.map((c) => <FilaCliente key={c.id} cliente={c} />)}
      {inactivos.length > 0 && (
        <>
          <p className="micro" style={{ marginTop: 12, marginBottom: 0 }}>Dados de baja</p>
          {inactivos.map((c) => <FilaCliente key={c.id} cliente={c} />)}
        </>
      )}
    </div>
  )
}

function FilaCliente({ cliente }) {
  const perros = (cliente.perro ?? []).filter((p) => p.activo)
  return (
    <Link to={`/clientes/${cliente.id}`} className={`fila${cliente.activo ? '' : ' atenuado'}`}>
      <div className="crece">
        <div>{cliente.nombre}</div>
        <div className="micro">
          {perros.length === 0 ? 'Sin perros' : `${perros.length} ${perros.length === 1 ? 'perro' : 'perros'}`}
          {cliente.direccion ? ` · ${cliente.direccion}` : ''}
        </div>
      </div>
      <span className="micro">
        {cliente.tarifa_paseo == null ? 'Tarifa por defecto' : pesos(cliente.tarifa_paseo)}
      </span>
    </Link>
  )
}

function ListaGrupos({ grupos }) {
  if (!grupos.length) {
    return (
      <Vacio>
        Todavía no hay grupos. Un grupo junta a los perros que se pasean juntos: es lo que
        el calendario pinta y lo que los paseos recurrentes necesitan para existir.
      </Vacio>
    )
  }

  return (
    <div className="lista">
      {grupos.map((g) => (
        <Link key={g.id} to={`/grupos/${g.id}`} className="fila">
          <Punto color={g.color_hex} />
          <div className="crece">
            <div>{g.nombre}</div>
            <div className="micro">
              {(g.grupo_perro ?? []).length} {(g.grupo_perro ?? []).length === 1 ? 'perro' : 'perros'}
              {g.zona ? ` · ${g.zona}` : ''}
            </div>
          </div>
        </Link>
      ))}
    </div>
  )
}

function HojaNuevoCliente({ paseadorId, onCerrar, onListo }) {
  const [form, setForm] = useState({ nombre: '', telefono: '', direccion: '' })
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    const { error: err } = await supabase.from('cliente').insert({
      paseador_id: paseadorId,
      nombre: form.nombre.trim(),
      telefono: form.telefono.trim() || null,
      direccion: form.direccion.trim() || null
    })
    setGuardando(false)
    if (err) { console.error(err); setError('No se pudo guardar.'); return }
    onListo()
  }

  return (
    <Hoja titulo="Nuevo cliente" onCerrar={onCerrar}>
      <form onSubmit={guardar}>
        <Campo etiqueta="Nombre">
          <input
            value={form.nombre}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            required
            autoFocus
          />
        </Campo>
        <Campo etiqueta="Teléfono">
          <input
            type="tel"
            value={form.telefono}
            onChange={(e) => setForm({ ...form, telefono: e.target.value })}
          />
        </Campo>
        <Campo etiqueta="Dirección">
          <input
            value={form.direccion}
            onChange={(e) => setForm({ ...form, direccion: e.target.value })}
          />
        </Campo>
        {error && <p className="error">{error}</p>}
        <p className="micro">Las tarifas, las notas de acceso y los perros se agregan en la ficha.</p>
        <button className="boton primario ancho" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Crear cliente'}
        </button>
      </form>
    </Hoja>
  )
}

function HojaNuevoGrupo({ paseadorId, onCerrar, onListo }) {
  const [form, setForm] = useState({ nombre: '', zona: '', color_hex: '#1D9E75' })
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    const { error: err } = await supabase.from('grupo').insert({
      paseador_id: paseadorId,
      nombre: form.nombre.trim(),
      zona: form.zona.trim() || null,
      color_hex: form.color_hex
    })
    setGuardando(false)
    if (err) { console.error(err); setError('No se pudo guardar.'); return }
    onListo()
  }

  return (
    <Hoja titulo="Nuevo grupo" onCerrar={onCerrar}>
      <form onSubmit={guardar}>
        <Campo etiqueta="Nombre">
          <input
            value={form.nombre}
            onChange={(e) => setForm({ ...form, nombre: e.target.value })}
            placeholder="Los Militares"
            required
            autoFocus
          />
        </Campo>
        <Campo etiqueta="Zona">
          <input value={form.zona} onChange={(e) => setForm({ ...form, zona: e.target.value })} />
        </Campo>
        <Campo etiqueta="Color" pista="Es el color del punto en el calendario.">
          <input
            type="color"
            value={form.color_hex}
            onChange={(e) => setForm({ ...form, color_hex: e.target.value })}
            style={{ height: 44, padding: 4 }}
          />
        </Campo>
        {error && <p className="error">{error}</p>}
        <button className="boton primario ancho" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Crear grupo'}
        </button>
      </form>
    </Hoja>
  )
}

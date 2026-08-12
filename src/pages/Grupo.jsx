import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useSesion } from '../lib/sesion'
import { hoyISO, hora as soloHora } from '../lib/fechas'
import { materializar, olvidarUltimaCorrida } from '../lib/recurrentes'
import { Barra, Campo, Cargando, ErrorCarga, Hoja, Punto, Vacio } from '../components/ui'

const DIAS = [[1, 'L'], [2, 'M'], [3, 'M'], [4, 'J'], [5, 'V'], [6, 'S'], [7, 'D']]
const NOMBRES_DIA = { 1: 'Lun', 2: 'Mar', 3: 'Mié', 4: 'Jue', 5: 'Vie', 6: 'Sáb', 7: 'Dom' }

export default function Grupo() {
  const { id } = useParams()
  const navegar = useNavigate()
  const { paseadorId } = useSesion()
  const [grupo, setGrupo] = useState(null)
  const [miembros, setMiembros] = useState([])   // ids de perro
  const [todosLosPerros, setTodosLosPerros] = useState([])
  const [reglas, setReglas] = useState([])
  const [estado, setEstado] = useState('cargando')
  const [editando, setEditando] = useState(false)
  const [eligiendoPerros, setEligiendoPerros] = useState(false)
  const [nuevaRegla, setNuevaRegla] = useState(false)
  const [generando, setGenerando] = useState(null)

  const cargar = useCallback(async () => {
    const [resGrupo, resMiembros, resPerros, resReglas] = await Promise.all([
      supabase.from('grupo').select('*').eq('id', id).single(),
      supabase.from('grupo_perro').select('perro_id').eq('grupo_id', id),
      supabase
        .from('perro')
        .select('id,nombre,color_hex,duracion_min,activo,cliente(id,nombre,activo)')
        .eq('activo', true)
        .order('nombre'),
      supabase
        .from('paseo_recurrente')
        .select('*')
        .eq('grupo_id', id)
        .order('hora_inicio')
    ])

    if (resGrupo.error) { console.error(resGrupo.error); setEstado('error'); return }
    setGrupo(resGrupo.data)
    setMiembros((resMiembros.data ?? []).map((m) => m.perro_id))
    setTodosLosPerros(resPerros.data ?? [])
    setReglas(resReglas.data ?? [])
    setEstado('ok')
  }, [id])

  useEffect(() => { cargar() }, [cargar])

  /**
   * Al activar o crear una regla hay que rellenar el horizonte de inmediato,
   * si no el calendario se queda vacío hasta el día siguiente.
   */
  async function regenerar() {
    setGenerando('trabajando')
    try {
      olvidarUltimaCorrida()
      const creados = await materializar()
      setGenerando(`${creados} ${creados === 1 ? 'paseo generado' : 'paseos generados'}`)
    } catch (e) {
      console.error(e)
      setGenerando('No se pudieron generar los paseos.')
    }
  }

  async function alternarRegla(regla) {
    const activo = !regla.activo
    const { error } = await supabase.from('paseo_recurrente').update({ activo }).eq('id', regla.id)
    if (error) { console.error(error); return }

    if (!activo) {
      // Al apagar la regla, las ocurrencias futuras que todavía nadie tocó
      // dejan de tener sentido. Solo se borran las que siguen `programado`:
      // lo completado o cancelado es historial y no se toca.
      await supabase
        .from('paseo')
        .delete()
        .eq('recurrente_id', regla.id)
        .eq('estado', 'programado')
        .gte('fecha', hoyISO())
    }
    await cargar()
    if (activo) await regenerar()
  }

  async function borrarGrupo() {
    if (!window.confirm('¿Borrar el grupo? Los paseos ya realizados se conservan, pero pierden el color del grupo.')) return
    const { error } = await supabase.from('grupo').delete().eq('id', id)
    if (error) { console.error(error); return }
    navegar('/clientes')
  }

  if (estado === 'cargando') return <Cargando />
  if (estado === 'error') return <ErrorCarga />

  const perrosDelGrupo = todosLosPerros.filter((p) => miembros.includes(p.id))

  return (
    <div>
      <Barra
        titulo={grupo.nombre}
        volver="/clientes"
        accion={<button className="boton chico" onClick={() => setEditando(true)}>Editar</button>}
      />

      <div className="tarjeta" style={{ marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center' }}>
        <Punto color={grupo.color_hex} />
        <span className="micro">
          {grupo.zona || 'Sin zona'} · el punto de este color es el que aparece en el calendario
        </span>
      </div>

      <div className="barra">
        <h2>Perros del grupo</h2>
        <button className="boton chico" onClick={() => setEligiendoPerros(true)}>Elegir</button>
      </div>

      {perrosDelGrupo.length === 0
        ? <Vacio>Sin perros. Un grupo vacío no genera paseos.</Vacio>
        : (
          <div className="lista">
            {perrosDelGrupo.map((p) => (
              <div key={p.id} className="fila" style={{ cursor: 'default' }}>
                <Punto color={p.color_hex} />
                <div className="crece">
                  <div>{p.nombre}</div>
                  <div className="micro">{p.cliente?.nombre}</div>
                </div>
              </div>
            ))}
          </div>
        )}

      <div className="barra" style={{ marginTop: 24 }}>
        <h2>Paseos recurrentes</h2>
        <button
          className="boton chico"
          onClick={() => setNuevaRegla(true)}
          disabled={perrosDelGrupo.length === 0}
        >
          + Regla
        </button>
      </div>

      {reglas.length === 0
        ? <Vacio>Sin reglas. Una regla dice qué días y a qué hora sale este grupo; de ahí salen los paseos del calendario.</Vacio>
        : (
          <div className="lista">
            {reglas.map((r) => (
              <div key={r.id} className={`fila${r.activo ? '' : ' atenuado'}`} style={{ cursor: 'default' }}>
                <div className="crece">
                  <div>
                    {(r.dias_semana ?? []).map((d) => NOMBRES_DIA[d]).join(' · ')} a las {soloHora(r.hora_inicio)}
                  </div>
                  <div className="micro">
                    {r.duracion_min ? `${r.duracion_min} min` : 'Duración según los perros'}
                    {r.vigente_hasta ? ` · hasta ${r.vigente_hasta}` : ' · sin fecha de término'}
                  </div>
                </div>
                <button className="boton chico" onClick={() => alternarRegla(r)}>
                  {r.activo ? 'Pausar' : 'Activar'}
                </button>
              </div>
            ))}
          </div>
        )}

      {reglas.some((r) => r.activo) && (
        <button className="boton ancho" style={{ marginTop: 12 }} onClick={regenerar} disabled={generando === 'trabajando'}>
          {generando === 'trabajando' ? 'Generando…' : 'Generar las próximas 8 semanas'}
        </button>
      )}
      {generando && generando !== 'trabajando' && <p className="micro">{generando}</p>}

      <button className="boton peligro ancho" style={{ marginTop: 24 }} onClick={borrarGrupo}>
        Borrar grupo
      </button>

      {editando && (
        <HojaEditarGrupo grupo={grupo} onCerrar={() => setEditando(false)} onListo={() => { setEditando(false); cargar() }} />
      )}

      {eligiendoPerros && (
        <HojaElegirPerros
          grupoId={id}
          perros={todosLosPerros}
          seleccionInicial={miembros}
          onCerrar={() => setEligiendoPerros(false)}
          onListo={() => { setEligiendoPerros(false); cargar() }}
        />
      )}

      {nuevaRegla && (
        <HojaNuevaRegla
          grupoId={id}
          paseadorId={paseadorId}
          onCerrar={() => setNuevaRegla(false)}
          onListo={async () => { setNuevaRegla(false); await cargar(); regenerar() }}
        />
      )}
    </div>
  )
}

function HojaEditarGrupo({ grupo, onCerrar, onListo }) {
  const [form, setForm] = useState({
    nombre: grupo.nombre,
    zona: grupo.zona ?? '',
    color_hex: grupo.color_hex
  })
  const [guardando, setGuardando] = useState(false)

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    const { error } = await supabase.from('grupo').update({
      nombre: form.nombre.trim(),
      zona: form.zona.trim() || null,
      color_hex: form.color_hex
    }).eq('id', grupo.id)
    setGuardando(false)
    if (error) { console.error(error); return }
    onListo()
  }

  return (
    <Hoja titulo="Editar grupo" onCerrar={onCerrar}>
      <form onSubmit={guardar}>
        <Campo etiqueta="Nombre">
          <input value={form.nombre} onChange={(e) => setForm({ ...form, nombre: e.target.value })} required />
        </Campo>
        <Campo etiqueta="Zona">
          <input value={form.zona} onChange={(e) => setForm({ ...form, zona: e.target.value })} />
        </Campo>
        <Campo etiqueta="Color">
          <input
            type="color"
            value={form.color_hex}
            onChange={(e) => setForm({ ...form, color_hex: e.target.value })}
            style={{ height: 44, padding: 4 }}
          />
        </Campo>
        <button className="boton primario ancho" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Guardar'}
        </button>
      </form>
    </Hoja>
  )
}

function HojaElegirPerros({ grupoId, perros, seleccionInicial, onCerrar, onListo }) {
  const [seleccion, setSeleccion] = useState(new Set(seleccionInicial))
  const [guardando, setGuardando] = useState(false)

  function alternar(perroId) {
    const copia = new Set(seleccion)
    copia.has(perroId) ? copia.delete(perroId) : copia.add(perroId)
    setSeleccion(copia)
  }

  async function guardar() {
    setGuardando(true)
    const previos = new Set(seleccionInicial)
    const agregados = [...seleccion].filter((id) => !previos.has(id))
    const quitados = [...previos].filter((id) => !seleccion.has(id))

    if (agregados.length) {
      const { error } = await supabase
        .from('grupo_perro')
        .insert(agregados.map((perro_id) => ({ grupo_id: grupoId, perro_id })))
      if (error) { console.error(error); setGuardando(false); return }
    }
    if (quitados.length) {
      const { error } = await supabase
        .from('grupo_perro')
        .delete()
        .eq('grupo_id', grupoId)
        .in('perro_id', quitados)
      if (error) { console.error(error); setGuardando(false); return }
    }
    setGuardando(false)
    onListo()
  }

  return (
    <Hoja titulo="Perros del grupo" onCerrar={onCerrar}>
      {perros.length === 0 && <Vacio>No hay perros activos todavía. Créalos desde la ficha del cliente.</Vacio>}
      <div className="lista">
        {perros.map((p) => (
          <label key={p.id} className="fila">
            <input type="checkbox" checked={seleccion.has(p.id)} onChange={() => alternar(p.id)} />
            <Punto color={p.color_hex} />
            <div className="crece">
              <div>{p.nombre}</div>
              <div className="micro">{p.cliente?.nombre}</div>
            </div>
          </label>
        ))}
      </div>
      <button className="boton primario ancho" style={{ marginTop: 16 }} onClick={guardar} disabled={guardando}>
        {guardando ? 'Guardando…' : 'Guardar'}
      </button>
      <p className="micro">
        Cambiar los perros no altera los paseos ya generados: esos conservan el precio congelado.
      </p>
    </Hoja>
  )
}

function HojaNuevaRegla({ grupoId, paseadorId, onCerrar, onListo }) {
  const [dias, setDias] = useState(new Set())
  const [form, setForm] = useState({
    hora_inicio: '09:00',
    duracion_min: '',
    vigente_desde: hoyISO(),
    vigente_hasta: ''
  })
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  function alternarDia(d) {
    const copia = new Set(dias)
    copia.has(d) ? copia.delete(d) : copia.add(d)
    setDias(copia)
  }

  async function guardar(e) {
    e.preventDefault()
    if (!dias.size) { setError('Elige al menos un día.'); return }
    setGuardando(true)
    setError(null)
    const { error: err } = await supabase.from('paseo_recurrente').insert({
      paseador_id: paseadorId,
      grupo_id: grupoId,
      dias_semana: [...dias].sort((a, b) => a - b),
      hora_inicio: form.hora_inicio,
      duracion_min: form.duracion_min === '' ? null : Number(form.duracion_min),
      vigente_desde: form.vigente_desde,
      vigente_hasta: form.vigente_hasta || null
    })
    setGuardando(false)
    if (err) { console.error(err); setError('No se pudo guardar.'); return }
    onListo()
  }

  return (
    <Hoja titulo="Nueva regla" onCerrar={onCerrar}>
      <form onSubmit={guardar}>
        <Campo etiqueta="Días">
          <div style={{ display: 'flex', gap: 4 }}>
            {DIAS.map(([valor, letra]) => (
              <button
                key={valor}
                type="button"
                className={`boton chico${dias.has(valor) ? ' primario' : ''}`}
                style={{ flex: 1, padding: '10px 0' }}
                onClick={() => alternarDia(valor)}
              >
                {letra}
              </button>
            ))}
          </div>
        </Campo>
        <Campo etiqueta="Hora de inicio">
          <input
            type="time"
            value={form.hora_inicio}
            onChange={(e) => setForm({ ...form, hora_inicio: e.target.value })}
            required
          />
        </Campo>
        <Campo etiqueta="Duración (minutos)" pista="Vacía usa la duración más larga entre los perros del grupo.">
          <input
            type="number"
            inputMode="numeric"
            value={form.duracion_min}
            onChange={(e) => setForm({ ...form, duracion_min: e.target.value })}
          />
        </Campo>
        <Campo etiqueta="Desde">
          <input
            type="date"
            value={form.vigente_desde}
            onChange={(e) => setForm({ ...form, vigente_desde: e.target.value })}
            required
          />
        </Campo>
        <Campo etiqueta="Hasta" pista="Vacía = indefinido.">
          <input
            type="date"
            value={form.vigente_hasta}
            onChange={(e) => setForm({ ...form, vigente_hasta: e.target.value })}
          />
        </Campo>
        {error && <p className="error">{error}</p>}
        <button className="boton primario ancho" disabled={guardando}>
          {guardando ? 'Guardando…' : 'Crear regla'}
        </button>
      </form>
    </Hoja>
  )
}

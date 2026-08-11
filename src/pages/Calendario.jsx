import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useSesion } from '../lib/sesion'
import {
  hoyISO, rejillaMes, fechaLarga, desdeISO,
  hora as soloHora, duracionCorta, MESES, DIAS_CORTOS
} from '../lib/fechas'
import { crearPaseo, perrosDeGrupo, duracionPrevistaDePaseo } from '../lib/paseos'
import { SELECT_PASEO, tituloPaseo, clientesDePaseo } from '../lib/consultas'
import { Barra, Campo, Cargando, ErrorCarga, Hoja, Punto, Vacio } from '../components/ui'

const SIN_GRUPO = '#B9B7AF'

export default function Calendario() {
  const hoy = hoyISO()
  const [ancla, setAncla] = useState(() => {
    const f = desdeISO(hoy)
    return { anio: f.getFullYear(), mes: f.getMonth() }
  })
  const [elegido, setElegido] = useState(hoy)
  const [delMes, setDelMes] = useState([])
  const [estado, setEstado] = useState('cargando')
  const [agendando, setAgendando] = useState(false)
  const [refresco, setRefresco] = useState(0)

  const celdas = useMemo(() => rejillaMes(ancla.anio, ancla.mes), [ancla])

  const cargar = useCallback(async () => {
    setEstado('cargando')
    const { data, error } = await supabase
      .from('paseo')
      .select('id,fecha,estado,grupo(id,color_hex)')
      .gte('fecha', celdas[0].iso)
      .lte('fecha', celdas[celdas.length - 1].iso)

    if (error) { console.error(error); setEstado('error'); return }
    setDelMes(data ?? [])
    setEstado('ok')
  }, [celdas])

  useEffect(() => { cargar() }, [cargar])

  // Un color por grupo y por día, sin repetir: con doce perros los colores
  // por perro dejan de distinguirse, y el punto de grupo además significa
  // algo — quién sale, no cuántos.
  const coloresPorDia = useMemo(() => {
    const mapa = new Map()
    for (const p of delMes) {
      if (p.estado === 'cancelado') continue
      if (!mapa.has(p.fecha)) mapa.set(p.fecha, new Set())
      mapa.get(p.fecha).add(p.grupo?.color_hex ?? SIN_GRUPO)
    }
    return mapa
  }, [delMes])

  function mover(delta) {
    const f = new Date(ancla.anio, ancla.mes + delta, 1)
    setAncla({ anio: f.getFullYear(), mes: f.getMonth() })
  }

  return (
    <div>
      <Barra
        titulo={`${MESES[ancla.mes]} ${ancla.anio}`}
        accion={
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="boton chico" onClick={() => mover(-1)} aria-label="Mes anterior">←</button>
            <button className="boton chico" onClick={() => mover(1)} aria-label="Mes siguiente">→</button>
          </div>
        }
      />

      <div className="rejilla-mes" style={{ marginBottom: 4 }}>
        {DIAS_CORTOS.map((d, i) => (
          <div key={i} className="micro centrado">{d}</div>
        ))}
      </div>

      <div className="rejilla-mes">
        {celdas.map(({ iso, delMes: propio }) => {
          const colores = [...(coloresPorDia.get(iso) ?? [])]
          const clases = ['celda-dia']
          if (!propio) clases.push('fuera')
          if (iso === hoy) clases.push('hoy')
          if (iso === elegido) clases.push('elegido')
          return (
            <button key={iso} className={clases.join(' ')} onClick={() => setElegido(iso)}>
              <span style={{ fontSize: 14 }}>{Number(iso.slice(8))}</span>
              <span className="puntos">
                {colores.slice(0, 4).map((c) => <Punto key={c} color={c} />)}
                {colores.length > 4 && <span className="mas">+{colores.length - 4}</span>}
              </span>
            </button>
          )
        })}
      </div>

      {estado === 'error' && <ErrorCarga />}

      <div className="barra" style={{ marginTop: 20 }}>
        <h2>{fechaLarga(elegido)}</h2>
        <button className="boton chico" onClick={() => setAgendando(true)}>+ Paseo</button>
      </div>

      <DetalleDia fecha={elegido} refresco={refresco} />

      {agendando && (
        <HojaAgendar
          fecha={elegido}
          onCerrar={() => setAgendando(false)}
          onListo={() => { setAgendando(false); cargar(); setRefresco((n) => n + 1) }}
        />
      )}
    </div>
  )
}

function DetalleDia({ fecha, refresco }) {
  const { config } = useSesion()
  const [paseos, setPaseos] = useState([])
  const [estado, setEstado] = useState('cargando')

  useEffect(() => {
    let vigente = true
    setEstado('cargando')
    supabase
      .from('paseo')
      .select(SELECT_PASEO)
      .eq('fecha', fecha)
      .order('hora_programada')
      .then(({ data, error }) => {
        if (!vigente) return
        if (error) { console.error(error); setEstado('error'); return }
        setPaseos(data ?? [])
        setEstado('ok')
      })
    return () => { vigente = false }
  }, [fecha, refresco])

  if (estado === 'cargando') return <Cargando />
  if (estado === 'error') return <ErrorCarga />
  if (!paseos.length) return <Vacio>Sin paseos este día.</Vacio>

  return (
    <div className="lista">
      {paseos.map((p) => {
        const cancelado = p.estado === 'cancelado'
        const cerrado = p.estado === 'completado' || p.estado === 'cerrado_automaticamente'
        return (
          <Link key={p.id} to={`/paseo/${p.id}`} className={`fila${cancelado || cerrado ? ' atenuado' : ''}`}>
            <span className="mono" style={{ width: 44, flex: 'none', fontSize: 14 }}>
              {soloHora(p.hora_programada)}
            </span>
            {p.grupo && <Punto color={p.grupo.color_hex} />}
            <div className="crece">
              <div className={cancelado ? 'tachado' : undefined}>{tituloPaseo(p)}</div>
              <div className="micro">
                {clientesDePaseo(p).map((c) => c.nombre).join(', ')}
              </div>
            </div>
            <span className="micro">
              {cerrado ? duracionCorta(p.duracion_seg) : `${duracionPrevistaDePaseo(p, config)} min`}
            </span>
          </Link>
        )
      })}
    </div>
  )
}

/**
 * Agendar un paseo suelto. Es el único camino para tener paseos antes de que
 * existan reglas recurrentes, y el que sirve para los esporádicos.
 */
function HojaAgendar({ fecha, onCerrar, onListo }) {
  const { paseadorId } = useSesion()
  const [modo, setModo] = useState('grupo')
  const [grupos, setGrupos] = useState([])
  const [perros, setPerros] = useState([])
  const [grupoId, setGrupoId] = useState('')
  const [seleccion, setSeleccion] = useState(new Set())
  const [hora, setHora] = useState('09:00')
  const [duracionMin, setDuracionMin] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    Promise.all([
      supabase.from('grupo').select('id, nombre, color_hex').order('nombre'),
      supabase
        .from('perro')
        .select('id,nombre,color_hex,activo,cliente(id,nombre,activo)')
        .eq('activo', true)
        .order('nombre')
    ]).then(([resGrupos, resPerros]) => {
      setGrupos(resGrupos.data ?? [])
      setPerros((resPerros.data ?? []).filter((p) => p.cliente?.activo))
    })
  }, [])

  function alternar(id) {
    const copia = new Set(seleccion)
    copia.has(id) ? copia.delete(id) : copia.add(id)
    setSeleccion(copia)
  }

  async function guardar(e) {
    e.preventDefault()
    setGuardando(true)
    setError(null)
    try {
      let perroIds
      if (modo === 'grupo') {
        if (!grupoId) throw new Error('Elige un grupo.')
        perroIds = (await perrosDeGrupo(grupoId)).map((p) => p.id)
        if (!perroIds.length) throw new Error('Ese grupo no tiene perros activos.')
      } else {
        perroIds = [...seleccion]
        if (!perroIds.length) throw new Error('Elige al menos un perro.')
      }

      await crearPaseo(paseadorId, {
        grupoId: modo === 'grupo' ? grupoId : null,
        fecha,
        hora,
        perroIds,
        duracionMin: Number(duracionMin) || null
      })
      onListo()
    } catch (err) {
      console.error(err)
      setError(err.message ?? 'No se pudo crear el paseo.')
    } finally {
      setGuardando(false)
    }
  }

  return (
    <Hoja titulo={`Agendar · ${fechaLarga(fecha)}`} onCerrar={onCerrar}>
      <form onSubmit={guardar}>
        <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
          {[['grupo', 'Un grupo'], ['sueltos', 'Perros sueltos']].map(([clave, texto]) => (
            <button
              key={clave}
              type="button"
              className={`boton chico${modo === clave ? ' primario' : ''}`}
              onClick={() => setModo(clave)}
            >
              {texto}
            </button>
          ))}
        </div>

        {modo === 'grupo' ? (
          <Campo etiqueta="Grupo">
            <select value={grupoId} onChange={(e) => setGrupoId(e.target.value)}>
              <option value="">Elige un grupo…</option>
              {grupos.map((g) => <option key={g.id} value={g.id}>{g.nombre}</option>)}
            </select>
          </Campo>
        ) : (
          <Campo etiqueta="Perros">
            <div className="lista" style={{ maxHeight: 220, overflowY: 'auto' }}>
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
          </Campo>
        )}

        <Campo etiqueta="Hora">
          <input type="time" value={hora} onChange={(e) => setHora(e.target.value)} required />
        </Campo>

        <Campo
          etiqueta="Duración"
          pista="Solo para este paseo. Vacía sigue la cascada normal: la regla recurrente, si no la más larga de los perros que van, si no la duración por defecto."
        >
          <input
            type="number"
            inputMode="numeric"
            min="1"
            placeholder="min"
            value={duracionMin}
            onChange={(e) => setDuracionMin(e.target.value)}
          />
        </Campo>

        <p className="micro">
          El precio de cada perro se calcula ahora y queda congelado: cambiar la tarifa
          después no altera este paseo.
        </p>

        {error && <p className="error">{error}</p>}
        <button className="boton primario ancho" disabled={guardando}>
          {guardando ? 'Creando…' : 'Agendar paseo'}
        </button>
      </form>
    </Hoja>
  )
}

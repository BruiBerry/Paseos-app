import { useEffect, useState, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useSesion } from '../lib/sesion'
import { hoyISO, fechaLarga, hora as soloHora, horaMas, duracionCorta } from '../lib/fechas'
import { duracionPrevistaDePaseo, iniciarPaseo } from '../lib/paseos'
import { materializarUnaVezAlDia } from '../lib/recurrentes'
import { SELECT_PASEO, tituloPaseo, clientesDePaseo } from '../lib/consultas'
import { distanciaM, ubicacionActual } from '../lib/geo'
import { Barra, Cargando, ErrorCarga, Punto, Vacio } from '../components/ui'

export default function Hoy() {
  const navegar = useNavigate()
  const { paseadorId, config, cargandoConfig } = useSesion()
  const [paseos, setPaseos] = useState([])
  const [estado, setEstado] = useState('cargando')
  const [cerca, setCerca] = useState(null)

  const cargar = useCallback(async () => {
    const { data, error } = await supabase
      .from('paseo')
      .select(SELECT_PASEO)
      .eq('fecha', hoyISO())
      .order('hora_programada')

    if (error) { console.error(error); setEstado('error'); return }
    setPaseos(data ?? [])
    setEstado('ok')
    return data ?? []
  }, [])

  useEffect(() => { cargar() }, [cargar])

  // La materialización rellena el horizonte de paseos recurrentes. Corre una
  // vez al día en segundo plano; si genera algo, hay que releer el día.
  useEffect(() => {
    if (!paseadorId) return
    materializarUnaVezAlDia(paseadorId)
      .then((creados) => { if (creados > 0) cargar() })
      .catch((e) => console.error('No se pudieron generar los paseos recurrentes', e))
  }, [paseadorId, cargar])

  // Proximidad: solo se pide el GPS si hay algo pendiente que pueda gatillarlo.
  useEffect(() => {
    if (estado !== 'ok' || !config) return

    const candidatos = paseos
      .filter((p) => p.estado === 'programado')
      .flatMap((p) => clientesDePaseo(p)
        .filter((c) => c.lat != null && c.lng != null)
        .map((c) => ({ paseo: p, cliente: c })))

    if (!candidatos.length) return

    let vigente = true
    ubicacionActual().then((yo) => {
      if (!vigente || !yo) return
      const cercanos = candidatos
        .map((c) => ({ ...c, metros: distanciaM(yo, { lat: c.cliente.lat, lng: c.cliente.lng }) }))
        .filter((c) => c.metros <= config.radio_geocerca_m)
        .sort((a, b) => a.metros - b.metros)
      setCerca(cercanos[0] ?? null)
    })
    return () => { vigente = false }
  }, [estado, paseos, config])

  async function iniciarDesdeTarjeta(paseo) {
    try {
      await iniciarPaseo(paseo.id)
      navegar(`/paseo/${paseo.id}`)
    } catch (e) {
      console.error(e)
    }
  }

  if (estado === 'cargando' || cargandoConfig) return <Cargando />
  if (estado === 'error') return <ErrorCarga />

  const pendientes = paseos.filter((p) => p.estado === 'programado' || p.estado === 'en_curso')
  const minutosPendientes = pendientes.reduce(
    (total, p) => total + duracionPrevistaDePaseo(p, config), 0
  )
  const enCurso = paseos.find((p) => p.estado === 'en_curso')

  return (
    <div>
      <Barra titulo="Hoy" accion={<span className="micro">{fechaLarga(hoyISO())}</span>} />

      {enCurso && (
        <Link
          to={`/paseo/${enCurso.id}`}
          className="fila"
          style={{ marginBottom: 12, borderColor: 'var(--verde)', borderWidth: 1 }}
        >
          <div className="crece">
            <div style={{ color: 'var(--verde)' }}>Paseo en curso</div>
            <div className="micro">{tituloPaseo(enCurso)} · empezó a las {new Date(enCurso.inicio_real).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
          <span className="micro">Ver →</span>
        </Link>
      )}

      {cerca && !enCurso && (
        <div className="tarjeta" style={{ marginBottom: 12, borderColor: 'var(--azul)' }}>
          <div style={{ fontSize: 14 }}>
            Estás a {Math.round(cerca.metros)} m de {cerca.cliente.nombre}
          </div>
          <div className="micro" style={{ marginBottom: 10 }}>
            {tituloPaseo(cerca.paseo)} · {soloHora(cerca.paseo.hora_programada)}
          </div>
          <button className="boton primario ancho" onClick={() => iniciarDesdeTarjeta(cerca.paseo)}>
            Iniciar paseo
          </button>
        </div>
      )}

      {paseos.length === 0 && (
        <Vacio>
          Sin paseos programados. Se generan solos desde las reglas de cada grupo,
          o puedes agendar uno suelto desde el calendario.
        </Vacio>
      )}

      <div className="lista">
        {paseos.map((p) => (
          <FilaPaseo key={p.id} paseo={p} config={config} />
        ))}
      </div>

      {pendientes.length > 0 && (
        <p className="micro" style={{ marginTop: 16, textAlign: 'center' }}>
          {pendientes.length} {pendientes.length === 1 ? 'paseo pendiente' : 'paseos pendientes'} ·{' '}
          {duracionCorta(minutosPendientes * 60)} de trabajo por delante
        </p>
      )}
    </div>
  )
}

function FilaPaseo({ paseo, config }) {
  const cancelado = paseo.estado === 'cancelado'
  const cerrado = paseo.estado === 'completado' || paseo.estado === 'cerrado_automaticamente'
  const previstaMin = duracionPrevistaDePaseo(paseo, config)
  const clientes = clientesDePaseo(paseo)

  return (
    <Link to={`/paseo/${paseo.id}`} className={`fila${cancelado || cerrado ? ' atenuado' : ''}`}>
      <span className="mono" style={{ width: 44, flex: 'none', fontSize: 14 }}>
        {soloHora(paseo.hora_programada)}
      </span>
      {paseo.grupo && <Punto color={paseo.grupo.color_hex} />}
      <div className="crece">
        <div className={cancelado ? 'tachado' : undefined}>{tituloPaseo(paseo)}</div>
        <div className="micro">
          {cancelado
            ? (paseo.notas || 'Cancelado')
            : clientes.map((c) => c.direccion).filter(Boolean).join(' · ') ||
              `${paseo.paseo_perro?.length ?? 0} perros`}
        </div>
      </div>
      <span className="micro" style={{ textAlign: 'right', flex: 'none' }}>
        {cerrado
          ? duracionCorta(paseo.duracion_seg)
          : <>{previstaMin} min<br />→ {horaMas(paseo.hora_programada, previstaMin)}</>}
      </span>
    </Link>
  )
}

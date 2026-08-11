import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useSesion } from '../lib/sesion'
import { reloj, duracionCorta, hora as soloHora, fechaLarga } from '../lib/fechas'
import { pesos } from '../lib/formato'
import {
  duracionPrevistaDePaseo,
  iniciarPaseo,
  terminarPaseo,
  cancelarPaseo,
  cancelarPerroEnPaseo,
  registrarPausa
} from '../lib/paseos'
import { SELECT_PASEO, tituloPaseo, clientesDePaseo } from '../lib/consultas'
import { encolar, vaciarCola } from '../lib/cola'
import { Barra, Cargando, ErrorCarga, Punto } from '../components/ui'

// El cronómetro NO cuenta segundos con un temporizador. Guarda la hora de
// inicio y calcula `ahora − inicio − pausado` cada vez que la pantalla
// despierta. Es obligatorio: iOS suspende el JavaScript en cuanto la app
// deja de estar en primer plano, así que cualquier contador que sume de a
// uno pierde exactamente el tiempo del paseo.
//
// El intervalo de un segundo existe solo para repintar; el número siempre
// sale del reloj, nunca de acumular.
//
// El total pausado vive en `paseo.pausado_seg` y se escribe al reanudar.
// `localStorage` quedó como espejo, no como fuente: sin señal la escritura
// se encola, así que entre la pausa y la sincronización el valor local es el
// único que está al día. Por eso al cargar gana el local cuando existe.

const claveLocal = (id) => `paseo:cronometro:${id}`

function leerLocal(id) {
  try {
    return JSON.parse(localStorage.getItem(claveLocal(id)))
  } catch {
    return null
  }
}

function guardarLocal(id, datos) {
  localStorage.setItem(claveLocal(id), JSON.stringify(datos))
  return datos
}

function borrarLocal(id) {
  localStorage.removeItem(claveLocal(id))
}

function transcurridoSeg(inicioISO, acumuladaSeg, pausaDesde) {
  if (!inicioISO) return 0
  const ahora = Date.now()
  const pausaEnCurso = pausaDesde ? (ahora - new Date(pausaDesde).getTime()) / 1000 : 0
  const bruto = (ahora - new Date(inicioISO).getTime()) / 1000
  return Math.max(0, bruto - acumuladaSeg - pausaEnCurso)
}

export default function Cronometro() {
  const { id } = useParams()
  const { config } = useSesion()
  const [paseo, setPaseo] = useState(null)
  const [estado, setEstado] = useState('cargando')
  const [local, setLocal] = useState(() => leerLocal(id))
  const [sinSincronizar, setSinSincronizar] = useState(false)
  const [, repintar] = useState(0)
  const tickRef = useRef(null)

  const cargar = useCallback(async () => {
    const { data, error } = await supabase.from('paseo').select(SELECT_PASEO).eq('id', id).single()
    if (error) { console.error(error); setEstado('error'); return }
    setPaseo(data)
    setEstado('ok')
  }, [id])

  useEffect(() => { cargar() }, [cargar])

  // Reintentar lo que quedó sin enviar, al montar y al recuperar la señal.
  useEffect(() => {
    const intentar = () => vaciarCola().then(({ pendientes }) => {
      setSinSincronizar(pendientes > 0)
      if (pendientes === 0) borrarLocalSiCerrado()
    })
    function borrarLocalSiCerrado() {
      const l = leerLocal(id)
      if (l?.cerrado) { borrarLocal(id); setLocal(null) }
    }
    intentar()
    window.addEventListener('online', intentar)
    return () => window.removeEventListener('online', intentar)
  }, [id])

  // Repintado: cada segundo mientras la pestaña está visible, y una vez de
  // inmediato al volver del segundo plano, sin esperar el siguiente tick.
  useEffect(() => {
    const tick = () => repintar((n) => n + 1)
    const arrancar = () => {
      clearInterval(tickRef.current)
      if (document.visibilityState === 'visible') {
        tick()
        tickRef.current = setInterval(tick, 1000)
      }
    }
    arrancar()
    document.addEventListener('visibilitychange', arrancar)
    return () => {
      clearInterval(tickRef.current)
      document.removeEventListener('visibilitychange', arrancar)
    }
  }, [])

  if (estado === 'cargando') return <Cargando />
  if (estado === 'error') return <ErrorCarga />

  const inicio = paseo.inicio_real ?? local?.inicio ?? null
  const cerrado = ['completado', 'cerrado_automaticamente', 'cancelado'].includes(paseo.estado)
  const corriendo = Boolean(inicio) && !cerrado
  const previstaMin = duracionPrevistaDePaseo(paseo, config)
  const previstaSeg = previstaMin * 60

  // El local gana porque puede ir adelante de la base: si la escritura de la
  // última pausa quedó en la cola, la base todavía tiene el total anterior.
  const pausaAcumulada = local?.pausaAcumuladaSeg ?? paseo.pausado_seg ?? 0
  const pausaDesde = local?.pausaDesde ?? null

  async function intentar(accion, alFallar) {
    try {
      await accion()
      setSinSincronizar(false)
      return true
    } catch (e) {
      console.error(e)
      encolar(alFallar)
      setSinSincronizar(true)
      return false
    }
  }

  async function alIniciar() {
    const ahora = new Date()
    setLocal(guardarLocal(id, { inicio: ahora.toISOString(), pausaAcumuladaSeg: 0, pausaDesde: null }))
    setPaseo((p) => ({ ...p, estado: 'en_curso', inicio_real: ahora.toISOString() }))
    await intentar(
      () => iniciarPaseo(id, ahora),
      { tipo: 'iniciar', paseoId: id, inicio: ahora.toISOString() }
    )
  }

  // La pausa es para el tiempo real de entrar a la casa, dejar al perro y
  // llenar el agua.
  //
  // Empezarla no toca la base: todavía no hay nada que guardar, y escribir al
  // reanudar significa que una pausa abierta cuando el teléfono se queda sin
  // batería no descuenta nada. Es el error que conviene: cobrar el paseo
  // completo y arreglarlo a mano es mejor que descontar una pausa que quedó
  // corriendo toda la noche.
  function alPausar() {
    setLocal(guardarLocal(id, {
      inicio,
      pausaAcumuladaSeg: pausaAcumulada,
      pausaDesde: new Date().toISOString()
    }))
  }

  async function alReanudar() {
    const extra = pausaDesde ? (Date.now() - new Date(pausaDesde).getTime()) / 1000 : 0
    const total = Math.round(pausaAcumulada + extra)
    setLocal(guardarLocal(id, { inicio, pausaAcumuladaSeg: total, pausaDesde: null }))
    setPaseo((p) => ({ ...p, pausado_seg: total }))
    await intentar(
      () => registrarPausa(id, total),
      { tipo: 'pausa', paseoId: id, pausadoSeg: total }
    )
  }

  async function alTerminar() {
    const fin = new Date()
    // Una pausa abierta al apretar Terminar cuenta hasta este momento, si no
    // el tramo entre pausar y cerrar se cobraría como paseo.
    const enCurso = pausaDesde ? (Date.now() - new Date(pausaDesde).getTime()) / 1000 : 0
    const pausado = Math.round(pausaAcumulada + enCurso)
    const segundos = Math.round(transcurridoSeg(inicio, pausaAcumulada, pausaDesde))
    guardarLocal(id, { ...(local ?? { inicio }), cerrado: true })
    setPaseo((p) => ({
      ...p,
      estado: 'completado',
      fin_real: fin.toISOString(),
      duracion_seg: segundos,
      pausado_seg: pausado
    }))
    const ok = await intentar(
      () => terminarPaseo(id, { fin, duracionSeg: segundos, pausadoSeg: pausado }),
      { tipo: 'terminar', paseoId: id, fin: fin.toISOString(), duracionSeg: segundos, pausadoSeg: pausado }
    )
    if (ok) { borrarLocal(id); setLocal(null); cargar() }
  }

  async function alCancelar() {
    const motivo = window.prompt('¿Por qué se cancela? Queda escrito en el detalle del cobro.')
    if (motivo === null) return
    setPaseo((p) => ({ ...p, estado: 'cancelado', notas: motivo }))
    const ok = await intentar(
      () => cancelarPaseo(id, motivo),
      { tipo: 'cancelar', paseoId: id, motivo }
    )
    if (ok) { borrarLocal(id); setLocal(null); cargar() }
  }

  async function alCancelarPerro(perroId, nombre) {
    const motivo = window.prompt(`¿Por qué no va ${nombre}?`)
    if (motivo === null) return
    try {
      await cancelarPerroEnPaseo(id, perroId, motivo)
      cargar()
    } catch (e) {
      console.error(e)
    }
  }

  const segundos = transcurridoSeg(inicio, pausaAcumulada, pausaDesde)
  const mostrado = cerrado ? (paseo.duracion_seg ?? segundos) : segundos
  const excedido = mostrado > previstaSeg
  const avance = Math.min(100, (mostrado / previstaSeg) * 100)

  return (
    <div>
      <Barra titulo={tituloPaseo(paseo)} volver={-1} />

      <p className="micro" style={{ marginTop: -8 }}>
        {fechaLarga(paseo.fecha)} · programado a las {soloHora(paseo.hora_programada)} · {previstaMin} min previstos
      </p>

      {sinSincronizar && (
        <div className="aviso info" style={{ marginBottom: 12 }}>
          Sin conexión. El paseo está corriendo igual y se guardará cuando vuelva la señal.
        </div>
      )}

      {paseo.estado === 'cancelado' ? (
        <div className="tarjeta centrado" style={{ marginBottom: 16 }}>
          <div className="tenue">Paseo cancelado</div>
          {paseo.notas && <div className="micro">{paseo.notas}</div>}
        </div>
      ) : (
        <>
          <div className={`reloj${pausaDesde ? ' tenue' : ''}`}>{reloj(mostrado)}</div>

          <div className={`progreso${excedido ? ' excedido' : ''}`}>
            <div style={{ width: `${avance}%` }} />
          </div>
          <p className="micro centrado" style={{ marginTop: 6 }}>
            {pausaDesde
              ? 'En pausa'
              : excedido
                ? `${duracionCorta(mostrado - previstaSeg)} por sobre lo previsto`
                : `${duracionCorta(previstaSeg - mostrado)} para completar lo previsto`}
          </p>

          {excedido && corriendo && (
            <div className="aviso" style={{ marginTop: 10 }}>
              El paseo pasó la duración prevista. El aviso automático y el cierre
              por olvido necesitan el trabajo del servidor, que todavía no existe:
              por ahora, ciérralo tú.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            {!corriendo && !cerrado && (
              <button className="boton primario ancho" onClick={alIniciar}>Iniciar paseo</button>
            )}
            {corriendo && (
              <>
                <button
                  className="boton"
                  style={{ flex: 1 }}
                  onClick={pausaDesde ? alReanudar : alPausar}
                >
                  {pausaDesde ? 'Reanudar' : 'Pausar'}
                </button>
                <button className="boton primario" style={{ flex: 1 }} onClick={alTerminar}>
                  Terminar
                </button>
              </>
            )}
            {cerrado && paseo.estado !== 'cancelado' && (
              <div className="tarjeta centrado" style={{ flex: 1 }}>
                <span className="tenue">
                  Terminado · {duracionCorta(paseo.duracion_seg)}
                  {paseo.estado === 'cerrado_automaticamente' && ' (cerrado automáticamente)'}
                </span>
              </div>
            )}
          </div>

          {!cerrado && (
            <button className="boton peligro ancho" style={{ marginTop: 8 }} onClick={alCancelar}>
              Cancelar paseo
            </button>
          )}
        </>
      )}

      <h2 style={{ margin: '24px 0 10px' }}>Perros</h2>
      <div className="lista">
        {(paseo.paseo_perro ?? []).map((pp) => (
          <div key={pp.perro_id} className={`fila${pp.estado === 'cancelado' ? ' atenuado' : ''}`} style={{ cursor: 'default' }}>
            <Punto color={pp.perro?.color_hex} />
            <div className="crece">
              <div className={pp.estado === 'cancelado' ? 'tachado' : undefined}>{pp.perro?.nombre}</div>
              <div className="micro">
                {pp.perro?.cliente?.nombre}
                {pp.estado === 'cancelado' && pp.motivo_cancelacion ? ` · ${pp.motivo_cancelacion}` : ''}
              </div>
            </div>
            {!cerrado && pp.estado === 'programado' && (
              <button
                className="boton chico"
                onClick={() => alCancelarPerro(pp.perro_id, pp.perro?.nombre)}
              >
                No va
              </button>
            )}
          </div>
        ))}
      </div>

      <h2 style={{ margin: '24px 0 10px' }}>Accesos</h2>
      <div className="lista">
        {clientesDePaseo(paseo).map((c) => (
          <div key={c.id} className="tarjeta">
            <div style={{ fontSize: 14 }}>{c.nombre}</div>
            {c.direccion && <div className="micro">{c.direccion}</div>}
            {c.notas_acceso && <div className="micro" style={{ marginTop: 4 }}>{c.notas_acceso}</div>}
            {c.telefono && (
              <a className="boton chico" href={`tel:${c.telefono}`} style={{ marginTop: 8 }}>
                Llamar
              </a>
            )}
          </div>
        ))}
      </div>

      <p className="micro" style={{ marginTop: 20 }}>
        Este paseo suma {pesos((paseo.paseo_perro ?? [])
          .filter((pp) => pp.se_cobra)
          .reduce((t, pp) => t + pp.precio_cobrado, 0))} al cobro del mes.
      </p>
    </div>
  )
}

import { useEffect, useState, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useSesion } from '../lib/sesion'
import { periodoCerrado, periodoVecino, rangoPeriodo, nombrePeriodo } from '../lib/fechas'
import { pesos } from '../lib/formato'
import { Barra, Cargando, ErrorCarga, Vacio } from '../components/ui'

// Solo se cobra lo que efectivamente se realizó: la fila del perro tiene que
// estar completada y marcada como cobrable. Un paseo cancelado, por el motivo
// que sea, no entra en el total.
export const esCobrable = (pp) => pp.se_cobra && pp.estado === 'completado'

/** Consulta compartida con el detalle por cliente. */
export async function filasDelPeriodo(periodo) {
  const { desde, hasta } = rangoPeriodo(periodo)
  return supabase
    .from('paseo_perro')
    // `!inner` para poder filtrar por la fecha del paseo, que vive en la
    // tabla incrustada. Sin espacios: el parser de PostgREST los rechaza
    // entre paréntesis de cierre.
    .select(
      'precio_cobrado,se_cobra,estado,motivo_cancelacion,' +
      'paseo!inner(id,fecha,hora_programada,estado,duracion_seg,notas),' +
      'perro(id,nombre,cliente(id,nombre,tarifa_paseo))'
    )
    .gte('paseo.fecha', desde)
    .lte('paseo.fecha', hasta)
}

export default function Cobros() {
  const { paseadorId, config } = useSesion()
  // Abre en el mes cerrado, no en el actual: el mes en curso todavía no se
  // cobra y verlo primero invita a cobrar a medias.
  const [periodo, setPeriodo] = useState(periodoCerrado)
  const [filas, setFilas] = useState([])
  const [cobros, setCobros] = useState([])
  const [estado, setEstado] = useState('cargando')

  const cargar = useCallback(async () => {
    setEstado('cargando')
    const [resFilas, resCobros] = await Promise.all([
      filasDelPeriodo(periodo),
      supabase.from('cobro').select('*').eq('periodo', periodo)
    ])
    if (resFilas.error || resCobros.error) {
      console.error(resFilas.error ?? resCobros.error)
      setEstado('error')
      return
    }
    setFilas(resFilas.data ?? [])
    setCobros(resCobros.data ?? [])
    setEstado('ok')
  }, [periodo])

  useEffect(() => { cargar() }, [cargar])

  const porCliente = useMemo(() => {
    const mapa = new Map()
    for (const f of filas) {
      const c = f.perro?.cliente
      if (!c) continue
      if (!mapa.has(c.id)) {
        mapa.set(c.id, { cliente: c, monto: 0, paseos: 0, cancelados: 0 })
      }
      const entrada = mapa.get(c.id)
      if (esCobrable(f)) {
        entrada.monto += f.precio_cobrado
        entrada.paseos++
      } else if (f.estado === 'cancelado') {
        entrada.cancelados++
      }
    }

    const estadoDe = (clienteId) =>
      cobros.find((c) => c.cliente_id === clienteId)?.estado ?? 'pendiente'

    return [...mapa.values()]
      .filter((e) => e.monto > 0 || e.cancelados > 0)
      .map((e) => ({ ...e, estadoCobro: estadoDe(e.cliente.id) }))
      .sort((a, b) => {
        // Pendiente primero: lo cobrado ya no requiere trabajo.
        if (a.estadoCobro !== b.estadoCobro) return a.estadoCobro === 'pendiente' ? -1 : 1
        return b.monto - a.monto
      })
  }, [filas, cobros])

  const total = porCliente.reduce((t, e) => t + e.monto, 0)
  const porCobrar = porCliente
    .filter((e) => e.estadoCobro === 'pendiente')
    .reduce((t, e) => t + e.monto, 0)

  // El punto donde se atrapa el error de haber olvidado configurar una tarifa.
  const sinTarifa = porCliente.filter((e) => e.cliente.tarifa_paseo == null && e.monto > 0)

  async function marcar(entrada, nuevoEstado) {
    const { error } = await supabase.from('cobro').upsert({
      paseador_id: paseadorId,
      cliente_id: entrada.cliente.id,
      periodo,
      monto: entrada.monto,
      estado: nuevoEstado,
      fecha_pago: nuevoEstado === 'cobrado' ? new Date().toISOString().slice(0, 10) : null
    }, { onConflict: 'paseador_id,cliente_id,periodo' })
    if (error) { console.error(error); return }
    cargar()
  }

  async function compartirResumen() {
    const lineas = porCliente.map((e) =>
      `${e.cliente.nombre}: ${pesos(e.monto)} (${e.paseos} ${e.paseos === 1 ? 'paseo' : 'paseos'})`
    )
    const texto = `Paseos de ${nombrePeriodo(periodo)}\n\n${lineas.join('\n')}\n\nTotal: ${pesos(total)}`
    try {
      if (navigator.share) await navigator.share({ title: `Paseos ${nombrePeriodo(periodo)}`, text: texto })
      else await navigator.clipboard.writeText(texto)
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e)
    }
  }

  return (
    <div>
      <Barra
        titulo="Cobros"
        accion={
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="boton chico" onClick={() => setPeriodo(periodoVecino(periodo, -1))} aria-label="Mes anterior">←</button>
            <button
              className="boton chico"
              onClick={() => setPeriodo(periodoVecino(periodo, 1))}
              disabled={periodo >= periodoCerrado()}
              aria-label="Mes siguiente"
            >
              →
            </button>
          </div>
        }
      />
      <p className="micro" style={{ marginTop: -12, marginBottom: 14 }}>
        {nombrePeriodo(periodo)}
        {periodo === periodoCerrado() && ' · último mes cerrado'}
      </p>

      {estado === 'cargando' && <Cargando />}
      {estado === 'error' && <ErrorCarga />}

      {estado === 'ok' && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            <div className="tarjeta" style={{ flex: 1 }}>
              <div className="micro">Total del mes</div>
              <div className="mono" style={{ fontSize: 22 }}>{pesos(total)}</div>
            </div>
            <div className="tarjeta" style={{ flex: 1 }}>
              <div className="micro">Por cobrar</div>
              <div className="mono" style={{ fontSize: 22, color: porCobrar > 0 ? 'var(--rojo)' : 'inherit' }}>
                {pesos(porCobrar)}
              </div>
            </div>
          </div>

          {sinTarifa.length > 0 && (
            <div className="aviso" style={{ marginBottom: 14 }}>
              {sinTarifa.length === 1
                ? `${sinTarifa[0].cliente.nombre} está cobrando la tarifa por defecto`
                : `${sinTarifa.length} clientes están cobrando la tarifa por defecto`}
              {' '}({pesos(config?.tarifa_default)}). Si alguno debería tener precio propio,
              este es el momento de arreglarlo — los paseos ya cobrados no cambian.
            </div>
          )}

          {porCliente.length === 0
            ? <Vacio>Nada que cobrar en {nombrePeriodo(periodo)}.</Vacio>
            : (
              <div className="lista">
                {porCliente.map((e) => (
                  <div
                    key={e.cliente.id}
                    className={`fila${e.estadoCobro === 'cobrado' ? ' atenuado' : ''}`}
                    style={{ cursor: 'default' }}
                  >
                    <Link to={`/cobros/${e.cliente.id}/${periodo}`} className="crece" style={{ color: 'inherit', textDecoration: 'none' }}>
                      <div>{e.cliente.nombre}</div>
                      <div className="micro">
                        {e.paseos} {e.paseos === 1 ? 'paseo' : 'paseos'}
                        {e.cancelados > 0 && ` · ${e.cancelados} cancelado${e.cancelados === 1 ? '' : 's'}`}
                      </div>
                    </Link>
                    <div style={{ textAlign: 'right' }}>
                      <div className="mono">{pesos(e.monto)}</div>
                      <button
                        className="boton plano chico"
                        style={{ padding: 0 }}
                        onClick={() => marcar(e, e.estadoCobro === 'cobrado' ? 'pendiente' : 'cobrado')}
                      >
                        {e.estadoCobro === 'cobrado' ? 'Cobrado ✓' : 'Marcar cobrado'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

          {porCliente.length > 0 && (
            <button className="boton ancho" style={{ marginTop: 16 }} onClick={compartirResumen}>
              Compartir resumen
            </button>
          )}
        </>
      )}
    </div>
  )
}

import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { nombrePeriodo, fechaLarga, hora as soloHora, duracionCorta } from '../lib/fechas'
import { pesos } from '../lib/formato'
import { Barra, Cargando, ErrorCarga, Vacio } from '../components/ui'
import { filasDelPeriodo, esCobrable } from './Cobros'

export default function CobroDetalle() {
  const { clienteId, periodo } = useParams()
  const [cliente, setCliente] = useState(null)
  const [filas, setFilas] = useState([])
  const [estado, setEstado] = useState('cargando')

  useEffect(() => {
    async function cargar() {
      const [resCliente, resFilas] = await Promise.all([
        supabase.from('cliente').select('id, nombre, telefono, tarifa_paseo').eq('id', clienteId).single(),
        filasDelPeriodo(periodo)
      ])
      if (resCliente.error || resFilas.error) {
        console.error(resCliente.error ?? resFilas.error)
        setEstado('error')
        return
      }
      setCliente(resCliente.data)
      setFilas((resFilas.data ?? []).filter((f) => f.perro?.cliente?.id === clienteId))
      setEstado('ok')
    }
    cargar()
  }, [clienteId, periodo])

  if (estado === 'cargando') return <Cargando />
  if (estado === 'error') return <ErrorCarga />

  const ordenadas = [...filas].sort((a, b) =>
    (a.paseo.fecha + a.paseo.hora_programada).localeCompare(b.paseo.fecha + b.paseo.hora_programada)
  )
  const total = ordenadas.filter(esCobrable).reduce((t, f) => t + f.precio_cobrado, 0)

  async function compartir() {
    const lineas = ordenadas.filter(esCobrable).map((f) =>
      `${f.paseo.fecha} · ${f.perro?.nombre} · ${pesos(f.precio_cobrado)}`
    )
    const texto = `${cliente.nombre} — paseos de ${nombrePeriodo(periodo)}\n\n${lineas.join('\n')}\n\nTotal: ${pesos(total)}`
    try {
      if (navigator.share) await navigator.share({ title: `${cliente.nombre} · ${nombrePeriodo(periodo)}`, text: texto })
      else await navigator.clipboard.writeText(texto)
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e)
    }
  }

  return (
    <div>
      <Barra titulo={cliente.nombre} volver="/cobros" />
      <p className="micro" style={{ marginTop: -12, marginBottom: 14 }}>{nombrePeriodo(periodo)}</p>

      <div className="tarjeta" style={{ marginBottom: 16 }}>
        <div className="micro">Total del mes</div>
        <div className="mono" style={{ fontSize: 22 }}>{pesos(total)}</div>
      </div>

      {ordenadas.length === 0
        ? <Vacio>Sin paseos en este periodo.</Vacio>
        : (
          <div className="lista">
            {ordenadas.map((f) => {
              const cobrable = esCobrable(f)
              return (
                <div
                  key={`${f.paseo.id}-${f.perro?.id}`}
                  className={`fila${cobrable ? '' : ' atenuado'}`}
                  style={{ cursor: 'default' }}
                >
                  <div className="crece">
                    <div className={f.estado === 'cancelado' ? 'tachado' : undefined}>
                      {fechaLarga(f.paseo.fecha)} · {f.perro?.nombre}
                    </div>
                    <div className="micro">
                      {soloHora(f.paseo.hora_programada)}
                      {f.paseo.duracion_seg ? ` · ${duracionCorta(f.paseo.duracion_seg)} reales` : ''}
                      {f.estado === 'cancelado' && ` · ${f.motivo_cancelacion || 'cancelado'}`}
                      {f.estado === 'programado' && ' · todavía no se realiza'}
                    </div>
                  </div>
                  <span className="mono">
                    {cobrable ? pesos(f.precio_cobrado) : <span className="micro">no se cobra</span>}
                  </span>
                </div>
              )
            })}
          </div>
        )}

      <button className="boton ancho" style={{ marginTop: 16 }} onClick={compartir}>
        Compartir detalle
      </button>
      <p className="micro">
        Cada monto quedó congelado al crear el paseo. Cambiar la tarifa del cliente
        no altera lo ya cobrado.
      </p>
    </div>
  )
}

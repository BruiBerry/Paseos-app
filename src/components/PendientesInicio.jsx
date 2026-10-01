import { useEffect, useState } from 'react'
import { useSesion } from '../lib/sesion'
import { hoyISO } from '../lib/fechas'
import { estadoPush, activarPush } from '../lib/push'
import {
  esIOS, estaInstalada, instalacionDisponible, alCambiarInstalacion, pedirInstalacion,
  pendientesInicio, estaPospuesto, posponerHasta
} from '../lib/instalacion'

const CLAVE = 'pendientes_inicio_hasta'

// `localStorage` puede lanzar (ventana privada, datos bloqueados): la tarjeta
// tiene que seguir funcionando sin él, solo que no recuerda que se pospuso.
function leerPosposicion() {
  try { return localStorage.getItem(CLAVE) } catch { return null }
}
function guardarPosposicion(hasta) {
  try { localStorage.setItem(CLAVE, hasta) } catch { /* sin persistencia */ }
}

/**
 * Lo que hay que hacer una sola vez para dejar la app lista: instalarla y
 * activar los avisos. Hace de bienvenida en el primer arranque y de recordatorio
 * después, y se apaga sola cuando todo está hecho.
 *
 * Va compacta —una línea— porque Hoy es una pantalla de terreno y no debe
 * empujar la lista de paseos hacia abajo.
 */
export default function PendientesInicio() {
  const { paseadorId } = useSesion()
  const [push, setPush] = useState(null)
  const [hasta, setHasta] = useState(leerPosposicion)
  const [abierta, setAbierta] = useState(false)
  const [trabajando, setTrabajando] = useState(false)
  const [error, setError] = useState(null)
  const [, redibujar] = useState(0)

  useEffect(() => {
    estadoPush().then(setPush).catch((e) => { console.error(e); setPush('no-soportado') })
  }, [])

  // Chrome avisa tarde (o tras instalar) que ya se puede, o ya no, instalar.
  useEffect(() => alCambiarInstalacion(() => redibujar((n) => n + 1)), [])

  const instalada = estaInstalada()
  const pendientes = pendientesInicio({ instalada, estadoPush: push })

  if (push === null || !pendientes.length || estaPospuesto(hoyISO(), hasta)) return null

  async function instalar() {
    setTrabajando(true)
    try { await pedirInstalacion() } finally { setTrabajando(false) }
  }

  async function activar() {
    setTrabajando(true)
    setError(null)
    try {
      setPush(await activarPush(paseadorId))
    } catch (e) {
      console.error(e)
      setError('No se pudo activar. Intenta de nuevo.')
      setPush(await estadoPush())
    }
    setTrabajando(false)
  }

  function posponer() {
    const fecha = posponerHasta(hoyISO())
    guardarPosposicion(fecha)
    setHasta(fecha)
  }

  const n = pendientes.length

  return (
    <div className="aviso info" style={{ marginBottom: 12 }}>
      <button
        className="boton plano"
        style={{ width: '100%', justifyContent: 'space-between', padding: 0 }}
        onClick={() => setAbierta(!abierta)}
        aria-expanded={abierta}
      >
        <span>{n === 1 ? '1 paso' : `${n} pasos`} para dejar la app lista</span>
        <span aria-hidden="true">{abierta ? '▴' : '▾'}</span>
      </button>

      {abierta && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {pendientes.map((p) =>
            p.id === 'instalar' ? (
              <div key={p.id}>
                <div>Instala la app</div>
                {esIOS() ? (
                  <p className="micro">
                    En Safari toca Compartir → «Agregar a pantalla de inicio» y abre la app
                    desde ahí. Sin eso, en iPhone no llegan los avisos.
                  </p>
                ) : instalacionDisponible() ? (
                  <>
                    <p className="micro">Se abre sola, sin barra del navegador, y los avisos llegan mejor.</p>
                    <button className="boton chico" onClick={instalar} disabled={trabajando}>
                      Instalar
                    </button>
                  </>
                ) : (
                  <p className="micro">
                    Abre el menú del navegador (⋮) y toca «Instalar app» o «Agregar a la
                    pantalla de inicio».
                  </p>
                )}
              </div>
            ) : (
              <div key={p.id}>
                <div>Activa los avisos</div>
                {p.motivo === 'instalar' && <p className="micro">Primero instala la app.</p>}
                {p.motivo === 'denegado' && (
                  <p className="micro">
                    Están bloqueados para esta app. Actívalos en los ajustes del teléfono o
                    del navegador y vuelve aquí.
                  </p>
                )}
                {!p.motivo && (
                  <>
                    <p className="micro">
                      Te avisamos antes de cada paseo y cuando uno se pasa de su duración.
                    </p>
                    <button className="boton chico" onClick={activar} disabled={trabajando}>
                      Activar avisos
                    </button>
                    {error && <p className="error">{error}</p>}
                  </>
                )}
              </div>
            )
          )}
          <button className="boton plano chico" style={{ alignSelf: 'flex-start', padding: 0 }} onClick={posponer}>
            Ahora no
          </button>
        </div>
      )}
    </div>
  )
}

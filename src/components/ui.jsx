import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

/** Etiqueta + control. `pista` es para explicar los campos que pueden ir vacíos. */
export function Campo({ etiqueta, pista, children }) {
  return (
    <label className="campo">
      <span>{etiqueta}</span>
      {children}
      {pista && <div className="pista">{pista}</div>}
    </label>
  )
}

export function Cargando({ children = 'Cargando…' }) {
  return <p className="tenue">{children}</p>
}

export function Vacio({ children }) {
  return <p className="tenue" style={{ fontSize: 14, marginTop: 12 }}>{children}</p>
}

export function ErrorCarga({ children = 'No se pudo conectar con la base de datos.' }) {
  return <p className="error">{children} Revisa la consola del navegador.</p>
}

export function Punto({ color }) {
  return <span className="punto" style={{ background: color || '#B9B7AF' }} />
}

/** Encabezado de pantalla. Con `volver` muestra la flecha a la izquierda. */
export function Barra({ titulo, volver, accion }) {
  const navegar = useNavigate()
  return (
    <div className="barra">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        {volver && (
          <button
            className="boton plano"
            onClick={() => navegar(volver === true ? -1 : volver)}
            aria-label="Volver"
            style={{ marginLeft: -4 }}
          >
            ←
          </button>
        )}
        <h1 style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {titulo}
        </h1>
      </div>
      {accion}
    </div>
  )
}

/**
 * Hoja inferior para formularios. En celular sube desde abajo, que es donde
 * llega el pulgar; en pantalla ancha se centra.
 */
export function Hoja({ titulo, onCerrar, children }) {
  useEffect(() => {
    const alPresionar = (e) => e.key === 'Escape' && onCerrar()
    window.addEventListener('keydown', alPresionar)
    const overflowPrevio = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', alPresionar)
      document.body.style.overflow = overflowPrevio
    }
  }, [onCerrar])

  return (
    <div className="velo" onClick={onCerrar}>
      <div className="hoja" onClick={(e) => e.stopPropagation()}>
        <div className="barra">
          <h1>{titulo}</h1>
          <button className="boton plano" onClick={onCerrar} aria-label="Cerrar">Cerrar</button>
        </div>
        {children}
      </div>
    </div>
  )
}

import { NavLink } from 'react-router-dom'

const items = [
  { to: '/', label: 'Hoy' },
  { to: '/calendario', label: 'Calendario' },
  { to: '/clientes', label: 'Clientes' },
  { to: '/cobros', label: 'Cobros' },
  { to: '/ajustes', label: 'Ajustes' }
]

export default function BottomNav() {
  return (
    <nav
      style={{
        display: 'flex',
        borderTop: '0.5px solid var(--borde)',
        position: 'sticky',
        bottom: 0,
        background: 'var(--papel)',
        paddingBottom: 'env(safe-area-inset-bottom)'
      }}
    >
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          style={({ isActive }) => ({
            flex: 1,
            textAlign: 'center',
            padding: '10px 0',
            fontSize: 12,
            textDecoration: 'none',
            color: isActive ? 'var(--azul)' : 'var(--tinta-3)'
          })}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}

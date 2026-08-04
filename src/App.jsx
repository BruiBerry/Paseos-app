import { Routes, Route, Navigate } from 'react-router-dom'
import { useSesion } from './lib/sesion'
import Login from './pages/Login'
import Hoy from './pages/Hoy'
import Cronometro from './pages/Cronometro'
import Calendario from './pages/Calendario'
import Clientes from './pages/Clientes'
import Cliente from './pages/Cliente'
import Grupo from './pages/Grupo'
import Cobros from './pages/Cobros'
import CobroDetalle from './pages/CobroDetalle'
import Ajustes from './pages/Ajustes'
import BottomNav from './components/BottomNav'

export default function App() {
  const { sesion } = useSesion()

  if (sesion === undefined) return null // evita el parpadeo al cargar
  if (sesion === null) return <Login />

  return (
    <div style={{ maxWidth: 480, margin: '0 auto', minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, padding: 16 }}>
        <Routes>
          <Route path="/" element={<Hoy />} />
          <Route path="/paseo/:id" element={<Cronometro />} />
          <Route path="/calendario" element={<Calendario />} />
          <Route path="/clientes" element={<Clientes />} />
          <Route path="/clientes/:id" element={<Cliente />} />
          <Route path="/grupos/:id" element={<Grupo />} />
          <Route path="/cobros" element={<Cobros />} />
          <Route path="/cobros/:clienteId/:periodo" element={<CobroDetalle />} />
          <Route path="/ajustes" element={<Ajustes />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
      <BottomNav />
    </div>
  )
}

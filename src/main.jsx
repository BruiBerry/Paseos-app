import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import { ProveedorSesion } from './lib/sesion'
import { escucharInstalacion } from './lib/instalacion'
import './estilos.css'

// Antes de montar nada: `beforeinstallprompt` se dispara una sola vez, al poco
// de cargar, y la tarjeta de Hoy aparece mucho después.
escucharInstalacion()

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <ProveedorSesion>
        <App />
      </ProveedorSesion>
    </BrowserRouter>
  </React.StrictMode>
)

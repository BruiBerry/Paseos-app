import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  // Vite solo deja pasar al navegador las variables con prefijo `VITE_`.
  // La clave VAPID pública se llama `VAPID_PUBLIC_KEY` (Vercel no aceptó el
  // nombre con `VITE_`), así que se agrega ese prefijo a la lista. Es
  // `VAPID_PUBLIC_` y no `VAPID_`: con el segundo, la clave privada
  // (`VAPID_PRIVATE_KEY`) terminaría incrustada en el JavaScript público.
  envPrefix: ['VITE_', 'VAPID_PUBLIC_'],
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // El manejo de push va en un archivo aparte que el SW generado importa,
      // en vez de pasar a `injectManifest` y escribir el SW entero a mano.
      workbox: { importScripts: ['push-sw.js'] },
      manifest: {
        name: 'Paseos',
        short_name: 'Paseos',
        description: 'Gestión de paseos de perros',
        theme_color: '#0F6E56',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      }
    })
  ]
})

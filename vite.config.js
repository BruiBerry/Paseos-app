import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
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

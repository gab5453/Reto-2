import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    // Web progresiva (V2.19, D52). El service worker SOLO guarda la aplicación (precaché): no hay `runtimeCaching`, así que ninguna
    // respuesta de la API, token, pago o dato de administración llega a la caché. Los pases sin conexión están en lib/offline-trips.ts.
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'EcoAirlines',
        short_name: 'EcoAirlines',
        description: 'Reserva vuelos con emisiones compensadas y lleva tus pases de abordar sin conexión.',
        lang: 'es',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#1B5E20',
        background_color: '#ffffff',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        navigateFallback: '/index.html',
        // Lo que en la nube comparte dominio con la web no es la aplicación.
        navigateFallbackDenylist: [/^\/api\//, /^\/payment-api\//, /^\/grafana/, /^\/integraciones\//, /^\/oauth2\//, /^\/health/],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
})

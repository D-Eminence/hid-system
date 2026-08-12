import { defineConfig } from 'vite'
import legacy from '@vitejs/plugin-legacy'
import react from '@vitejs/plugin-react'
import { resolveDevelopmentPorts } from '../../scripts/ports.mjs'

const ports = resolveDevelopmentPorts()
const directWebMode = process.env.HID_WEB_DIRECT === 'true'
const webPort = directWebMode ? ports.webUi : ports.gateway

function isPackageModule(id: string, packageName: string) {
  return id.includes(`/node_modules/${packageName}/`)
}

export default defineConfig({
  // Only explicitly public Vite variables may cross into browser bundles.
  // Server-side HID_* configuration can contain credentials and must never be
  // admitted by a broad prefix during a production image build.
  envPrefix: ['VITE_'],
  resolve: { preserveSymlinks: true, dedupe: ['react', 'react-dom'] },
  plugins: [
    react(),
    {
      name: 'hid-app-entry-redirects',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url === '/ehr') {
            response.statusCode = 302
            response.setHeader('Location', '/ehr/')
            response.end()
            return
          }
          if (request.url === '/lab') {
            response.statusCode = 302
            response.setHeader('Location', '/lab/')
            response.end()
            return
          }
          if (request.url === '/pharmacy') {
            response.statusCode = 302
            response.setHeader('Location', '/pharmacy/')
            response.end()
            return
          }
          if (request.url === '/ocr') {
            response.statusCode = 302
            response.setHeader('Location', '/ocr/')
            response.end()
            return
          }
          if (request.url === '/admin') {
            response.statusCode = 302
            response.setHeader('Location', '/admin/')
            response.end()
            return
          }
          if (request.url === '/outreach') {
            response.statusCode = 302
            response.setHeader('Location', '/outreach/')
            response.end()
            return
          }
          next()
        })
      },
    },
    legacy({
      targets: ['defaults', 'Android >= 5', 'Chrome >= 49', 'Safari >= 10', 'iOS >= 10'],
      modernPolyfills: true,
      renderLegacyChunks: true,
    }),
  ],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/admin': {
        target: `http://127.0.0.1:${ports.adminUi}`,
        changeOrigin: true,
        ws: true,
      },
      '/ehr': {
        target: `http://127.0.0.1:${ports.ehrUi}`,
        changeOrigin: true,
        ws: true,
      },
      '/lab': {
        target: `http://127.0.0.1:${ports.labUi}`,
        changeOrigin: true,
        ws: true,
      },
      '/pharmacy': {
        target: `http://127.0.0.1:${ports.pharmacyUi}`,
        changeOrigin: true,
        ws: true,
      },
      '/ocr': {
        target: `http://127.0.0.1:${ports.ocrUi}`,
        changeOrigin: true,
        ws: true,
      },
      '/outreach': {
        target: `http://127.0.0.1:${ports.outreachUi}`,
        changeOrigin: true,
        ws: true,
      },
      '/api/v1/lab': {
        target: `http://127.0.0.1:${ports.labApi}`,
        changeOrigin: true,
      },
      '/api/v1/pharmacy': {
        target: `http://127.0.0.1:${ports.pharmacyApi}`,
        changeOrigin: true,
      },
      '/api/v1/ocr': {
        target: `http://127.0.0.1:${ports.ocrApi}`,
        changeOrigin: true,
      },
      '/api/v1/outreach': {
        target: `http://127.0.0.1:${ports.outreachApi}`,
        changeOrigin: true,
      },
      '/api/v1/auth': {
        target: `http://127.0.0.1:${ports.identityApi}`,
        changeOrigin: true,
      },
      '/api/v1/identity': {
        target: `http://127.0.0.1:${ports.identityApi}`,
        changeOrigin: true,
      },
      '/api/v1/audit': {
        target: `http://127.0.0.1:${ports.identityApi}`,
        changeOrigin: true,
      },
      '/api/v1/admin': {
        target: `http://127.0.0.1:${ports.identityApi}`,
        changeOrigin: true,
      },
      '/api': {
        target: `http://127.0.0.1:${ports.ehrApi}`,
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('/node_modules/@sentry/')) {
            return 'vendor-sentry'
          }
          if (isPackageModule(id, 'posthog-js')) {
            return 'vendor-posthog'
          }
          if (
            isPackageModule(id, 'react-router-dom') ||
            isPackageModule(id, 'react-router') ||
            id.includes('/node_modules/@remix-run/router/')
          ) {
            return 'vendor-router'
          }
          if (
            isPackageModule(id, 'react') ||
            isPackageModule(id, 'react-dom') ||
            isPackageModule(id, 'scheduler')
          ) {
            return 'vendor-react-core'
          }
          return undefined
        },
      },
    },
  },
})

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
// @ts-expect-error The shared development registry is plain ESM.
import { resolveDevelopmentPorts } from '../../scripts/ports.mjs'

const ports = resolveDevelopmentPorts()

export default defineConfig({
  base: process.env.HID_PUBLIC_BASE ?? '/lab/',
  resolve: {
    preserveSymlinks: true,
    dedupe: ['react', 'react-dom'],
    alias: { '@hid/api-client': resolve(import.meta.dirname, '../../packages/api-client/src/index.ts') },
  },
  plugins: [react()],
  // Keep linked workspace source out of Vite's optimized-dependency cache.
  optimizeDeps: { exclude: ['@hid/api-client', '@hid/identity-browser-client', '@hid/offline', '@hid/telemetry', '@hid/ui'] },
  server: { host: '127.0.0.1', port: ports.labUi, strictPort: true },
  preview: { host: '127.0.0.1', port: ports.labUi, strictPort: true },
})

import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
// @ts-expect-error Shared port registry is plain ESM.
import { resolveDevelopmentPorts } from '../../scripts/ports.mjs'

const ports = resolveDevelopmentPorts()

export default defineConfig({
  base: process.env.HID_PUBLIC_BASE ?? '/pharmacy/',
  plugins: [react()],
  resolve: {
    preserveSymlinks: true,
    dedupe: ['react', 'react-dom'],
    alias: { '@hid/api-client': resolve(import.meta.dirname, '../../packages/api-client/src/index.ts') },
  },
  optimizeDeps: { exclude: ['@hid/api-client', '@hid/identity-browser-client', '@hid/offline', '@hid/telemetry', '@hid/ui'] },
  server: { host: '127.0.0.1', port: ports.pharmacyUi, strictPort: true },
  preview: { host: '127.0.0.1', port: ports.pharmacyUi, strictPort: true },
})

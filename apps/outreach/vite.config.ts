import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
// @ts-expect-error The shared development registry is plain ESM.
import { resolveDevelopmentPorts } from '../../scripts/ports.mjs'

const ports = resolveDevelopmentPorts()

export default defineConfig({
  base: process.env.HID_PUBLIC_BASE ?? '/outreach/',
  resolve: {
    preserveSymlinks: true,
    dedupe: ['react', 'react-dom'],
    // The package's published CommonJS entry is for Node consumers. Browser
    // development needs its typed ESM source so named API-client imports keep
    // their real exports without an unstable prebundle intermediary.
    alias: { '@hid/api-client': resolve(import.meta.dirname, '../../packages/api-client/src/index.ts') },
  },
  plugins: [react()],
  // These are linked TypeScript workspace packages. Let Vite transform their
  // source rather than caching prebundled copies, which can go stale after a
  // package move and leave the browser with a 504 optimized-dependency URL.
  optimizeDeps: { exclude: ['@hid/api-client', '@hid/identity-browser-client', '@hid/ui'] },
  server: { host: '127.0.0.1', port: ports.outreachUi, strictPort: true },
  preview: { host: '127.0.0.1', port: ports.outreachUi, strictPort: true },
})

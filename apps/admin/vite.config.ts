import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// The shared runtime port registry is intentionally plain ESM so every app and
// orchestration script consumes the same defaults.
// @ts-expect-error The JavaScript registry has no generated declaration file.
import { resolveDevelopmentPorts } from '../../scripts/ports.mjs';

const ports = resolveDevelopmentPorts();
const publicBase = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.HID_PUBLIC_BASE ?? '/admin/';

export default defineConfig({
  base: publicBase,
  resolve: { dedupe: ['react', 'react-dom'] },
  plugins: [react()],
  // The shared client is a linked CommonJS workspace package. Explicitly
  // prebundle it so Vite development serves real ESM named exports instead of
  // exposing the raw CommonJS build to the browser.
  optimizeDeps: { include: ['@hid/api-client'] },
  server: { host: '127.0.0.1', port: ports.adminUi, strictPort: true },
  preview: { host: '127.0.0.1', port: ports.adminUi, strictPort: true },
});

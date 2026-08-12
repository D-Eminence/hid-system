import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'path';
import { resolveDevelopmentPorts } from '../../scripts/ports.mjs';

const canonicalEhrHtml = path.resolve(__dirname, './ehr.html');
const canonicalPlatformRuntime = path.resolve(__dirname, './src/canonical-platform-runtime.ts');
const ports = resolveDevelopmentPorts();

export default defineConfig(({ command }) => {
  const publicBase = process.env.HID_PUBLIC_BASE ?? '/ehr/';
  return ({
  base: publicBase,
  plugins: [
    react(),
    {
      name: 'hid-canonical-ehr-reference',
      transformIndexHtml() {
        return fs.readFileSync(canonicalEhrHtml, 'utf8')
          .replace('href="/ehr/manifest.webmanifest"', `href="${publicBase}manifest.webmanifest"`)
          .replace(
          '</head>',
          command === 'serve'
            ? '  <script type="module" src="/src/canonical-platform-runtime.ts"></script>\n</head>'
            : `  <script type="module" src="${publicBase}assets/canonical-platform-runtime.js"></script>\n</head>`,
        );
      },
    },
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    include: ['@hid/api-client'],
  },
  build: {
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, './index.html'),
        'canonical-platform-runtime': canonicalPlatformRuntime,
      },
      output: {
        entryFileNames: chunk => chunk.name === 'canonical-platform-runtime'
          ? 'assets/canonical-platform-runtime.js'
          : 'assets/[name]-[hash].js',
      },
    },
  },
  server: {
    port: ports.ehrUi,
    host: '127.0.0.1',
    strictPort: true,
  },
  preview: {
    port: ports.ehrUi,
    host: '127.0.0.1',
    strictPort: true,
  },
  });
});

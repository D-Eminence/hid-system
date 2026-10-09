import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: '/pharmacy/',
  resolve: { dedupe: ['react', 'react-dom'] },
  test: { environment: 'jsdom', globals: true, setupFiles: './src/test-setup.ts' },
})

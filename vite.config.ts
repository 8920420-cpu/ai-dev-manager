import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// Цель прокси для dev-режима: backend оркестратора (см. orchestrator-service/backend,
// PORT по умолчанию 4186). Меняется через VITE_API_PROXY без правки кода.
const API_PROXY = process.env.VITE_API_PROXY || 'http://localhost:4186';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Билд кладётся в dist/ — оттуда его забирает корневой Dockerfile (nginx) и
  // backend оркестратора (FRONTEND_DIR). НЕ редактировать dist вручную.
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 4186,
    // В dev все /api и /health проксируются на реальный backend оркестратора.
    proxy: {
      '/api': { target: API_PROXY, changeOrigin: true },
      '/health': { target: API_PROXY, changeOrigin: true },
    },
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web client talks to the Express analytics API. In dev, Vite proxies /api
// to the API server so the front end is served from a single origin.
export default defineConfig({
  root: 'src/web',
  publicDir: '../../public',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:5177',
        changeOrigin: true,
      },
    },
  },
});

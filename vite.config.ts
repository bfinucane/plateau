import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web client talks to the Express analytics API. In dev, Vite proxies /api
// to the API server so the front end is served from a single origin.
export default defineConfig({
  // Without the React plugin the client still builds (esbuild handles JSX), but
  // dev loses Fast Refresh and any future React-specific transform. Keeping the
  // dependency AND the plugin in step is the maintenance point: the import was
  // present while the plugin was not, which is how it went unnoticed.
  plugins: [react()],
  root: 'src/web',
  publicDir: '../../public',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    // The chart library dominates the bundle. Splitting it from application code
    // means an app-only change does not invalidate 1.1 MB of cached vendor JS, and
    // the app chunk's growth is measured on its own. The ECharts chunk is
    // inherently large; the limit acknowledges that rather than hiding it.
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts'],
          react: ['react', 'react-dom'],
        },
      },
    },
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

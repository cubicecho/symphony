import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** Every cubicecho app is served here, so it is at the same address on every device. */
const WEB_SERVER = { host: '0.0.0.0', port: 3000, strictPort: true };
/** Where `npm run dev:server` listens. */
const API_ORIGIN = 'http://localhost:8787';

export default defineConfig({
  root: 'web',
  plugins: [
    tanstackRouter({
      target: 'react',
      routesDirectory: fileURLToPath(new URL('./web/src/routes', import.meta.url)),
      generatedRouteTree: fileURLToPath(new URL('./web/src/route-tree.gen.ts', import.meta.url)),
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) },
  },
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    ...WEB_SERVER,
    // The server runs beside Vite in dev. The anchored patterns keep the app's own /modules pages
    // (`/modules/new`, `/modules/<id>`) out of the proxy: only compiled code (`.js`) goes through.
    proxy: {
      '^/graphql(\\?|$)': API_ORIGIN,
      '^/proxy/': API_ORIGIN,
      '^/modules/[^/]+/[^/]+\\.js$': API_ORIGIN,
      '^/mcp(\\?|/|$)': API_ORIGIN,
      '^/unified/': API_ORIGIN,
      '/healthz': API_ORIGIN,
    },
  },
  preview: WEB_SERVER,
});

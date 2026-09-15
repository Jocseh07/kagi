import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'

// The committed wrangler.jsonc is a template. A deployment's real values live
// in the gitignored wrangler.local.jsonc, used here and by `pnpm deploy`.
const localWranglerConfig = path.resolve(import.meta.dirname, 'wrangler.local.jsonc')
const wranglerConfigPath = fs.existsSync(localWranglerConfig) ? localWranglerConfig : undefined

export default defineConfig({
  plugins: [
    tailwindcss(),
    // Runs the app in workerd rather than Node, in dev as well as in the
    // build. This is what makes the D1 binding and the source proxies behave
    // the same on a laptop as they do deployed — the dev-only Node and curl
    // proxies this project used to carry existed precisely because they did
    // not.
    cloudflare({ viteEnvironment: { name: 'ssr' }, configPath: wranglerConfigPath }),
    // SPA mode: the app is client-only by construction — SQLite-WASM over
    // OPFS, a service worker, a theme read from localStorage before the first
    // paint — so only the shell is prerendered and every route renders in the
    // browser. Server routes (the proxies, /api/sync) still run on the Worker.
    tanstackStart({ spa: { enabled: true } }),
    // React's plugin must come after Start's.
    react(),
  ],
  // sqlite-wasm ships its own worker + wasm; prebundling breaks the OPFS VFS.
  optimizeDeps: {
    exclude: ['@sqlite.org/sqlite-wasm'],
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  worker: {
    format: 'es',
  },
})

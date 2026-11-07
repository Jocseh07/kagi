import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'

const CLOUDFLARE_WORKERS = 'cloudflare:workers'
const CLIENT_STUB_ID = '\0cloudflare-workers-client-stub'

// Dev only in effect: server modules that also export plain helpers reach
// effect/env.ts in the browser graph, and only the production build
// tree-shakes them.
function cloudflareWorkersClientStub(): Plugin {
  return {
    name: 'kagi:cloudflare-workers-client-stub',
    enforce: 'pre',
    applyToEnvironment: (environment) => environment.name === 'client',
    resolveId(id) {
      return id === CLOUDFLARE_WORKERS ? CLIENT_STUB_ID : undefined
    },
    load(id) {
      return id === CLIENT_STUB_ID ? 'export const env = {}' : undefined
    },
  }
}

// TanStack's prerender imports `<server input>.js`, but Alchemy emits the Worker entry as index.js.
// Remove once https://github.com/TanStack/router/pull/8172 ships.
function prerenderServerEntryAlias(): Plugin {
  return {
    name: 'kagi:prerender-server-entry-alias',
    applyToEnvironment: (environment) => environment.name === 'ssr',
    async writeBundle(options, bundle) {
      const entry = Object.values(bundle).find((chunk) => chunk.type === 'chunk' && chunk.isEntry)
      if (!options.dir || !entry || entry.fileName === 'server.js') return
      await copyFile(path.join(options.dir, entry.fileName), path.join(options.dir, 'server.js'))
    },
  }
}

export default defineConfig({
  plugins: [
    cloudflareWorkersClientStub(),
    tailwindcss(),
    // Alchemy appends its own Cloudflare plugin at build and dev time, so the
    // Worker runs in workerd on a laptop as it does deployed. That is what
    // makes the D1 binding and the source proxies behave the same in both —
    // the dev-only Node and curl proxies this project used to carry existed
    // precisely because they did not.
    //
    // SPA mode: the app is client-only by construction — SQLite-WASM over
    // OPFS, a service worker, a theme read from localStorage before the first
    // paint — so only the shell is prerendered and every route renders in the
    // browser. Server routes (the proxies, /api/sync) still run on the Worker.
    tanstackStart({ spa: { enabled: true } }),
    prerenderServerEntryAlias(),
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
  // workerd provides these modules. Alchemy's plugin resolves them on deploy
  // and in dev; a plain `vite build` needs to be told they are not packages.
  build: { rolldownOptions: { external: ['cloudflare:workers', 'cloudflare:sockets'] } },
})

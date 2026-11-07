/**
 * The `cloudflare:workers` module, declared narrowly on purpose.
 *
 * Installing `@cloudflare/workers-types` globally would declare this module
 * *and* the whole workerd global scope. That second half is unusable here:
 * workerd's globals merge with the DOM lib this project compiles against, and
 * its `Element.append(content: string | ReadableStream | Response)` overload
 * then wins over the DOM's `append(...nodes: Node[])` — measured, it breaks
 * every `document.head.append(style)` in src/lib/theme, src/lib/fonts and
 * src/lib/images.
 *
 * So only the module is declared, with `env` unknown-keyed: src/server/effect/
 * env.ts is the one reader and it gives the bindings their shape.
 */
declare module 'cloudflare:workers' {
  export const env: Record<string, unknown>
  export function waitUntil(promise: Promise<unknown>): void
}

/**
 * `caches.default`, the colo's own cache, declared here for the same reason
 * and in the same way: the DOM lib supplies `CacheStorage` without it, and
 * installing workerd's globals to get it would drag in the `Element.append`
 * overload this file exists to keep out. `src/server/proxy.ts` is the only
 * reader.
 */
interface CacheStorage {
  readonly default: Cache
}

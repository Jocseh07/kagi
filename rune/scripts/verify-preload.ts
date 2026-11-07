import { appendFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const endpoint = process.env.KAGI_VERIFY_PROVIDER_URL
const root = process.env.KAGI_VERIFY_RUN
if (!endpoint || !root) throw new Error('Verification preload requires an explicit fixture endpoint and scratch root')
const provider = new URL(endpoint)
if (provider.hostname !== '127.0.0.1' || !root.includes('/.tmp/stress-rune-native/')) throw new Error('Invalid offline verification boundary')
const destination = join(root, 'fetch-audit.jsonl')
const original = globalThis.fetch
let requests = 0
function audit(kind: string, url: URL): void {
  const record = JSON.stringify({ kind, origin: url.origin, path: url.pathname, pid: process.pid }) + '\n'
  if (existsSync(destination) && statSync(destination).size > 16 * 1024 * 1024) throw new Error('Offline fetch audit reached its fixed 16 MiB bound')
  appendFileSync(destination, record, { mode: 0o600 })
  if (kind === 'blocked') process.stderr.write(`KAGI_VERIFY_BLOCKED ${record}`)
}
const guarded: typeof fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  if (++requests > 50_000) throw new Error('Verification subprocess exceeded its hard request cap')
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.origin === provider.origin) return original(input, { ...init, redirect: 'error' })
  const api = url.origin === 'https://api.asurascans.com' && (/^\/api\/series(?:\?.*)?$/.test(url.pathname) || url.pathname === '/api/genres' || /^\/api\/series\/(?:native-download-fixture|native-mihon-fixture)(?:\/chapters(?:\/[1-3])?)?$/.test(url.pathname))
  const image = url.origin === 'https://cdn.asurascans.com' && /^\/asura-images\/native-fixture\/(?:cover|[1-3]-[0-2])\.png$/.test(url.pathname)
  if (api || image) {
    audit('fixture-rewrite', url)
    const local = new URL('/__source', provider)
    local.searchParams.set('url', url.toString())
    const options = input instanceof Request ? { method: input.method, headers: input.headers, signal: input.signal, ...init } : init
    return original(local, { ...options, redirect: 'error' })
  }
  audit('blocked', url)
  throw new Error(`Offline verification blocked an unregistered destination: ${url.origin}${url.pathname}`)
}, { preconnect: () => { throw new Error('Offline verification forbids speculative network preconnect') } })
globalThis.fetch = guarded

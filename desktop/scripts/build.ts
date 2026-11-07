import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const desktop = fileURLToPath(new URL('..', import.meta.url))
const envFile = join(desktop, '../.env.prod')

function envValue(key: string): string | undefined {
  if (process.env[key]) return process.env[key]
  if (!existsSync(envFile)) return undefined
  const line = readFileSync(envFile, 'utf8')
    .split('\n')
    .find((item) => item.startsWith(`${key}=`))
  return line?.slice(key.length + 1).trim().replace(/^["']|["']$/g, '') || undefined
}

const origin = envValue('APP_ORIGIN')?.replace(/\/+$/, '')
if (!origin) throw new Error('Set APP_ORIGIN in .env.prod or the environment: the packaged app opens that site.')

execFileSync('bun', ['run', 'bundle'], { cwd: desktop, stdio: 'inherit' })
writeFileSync(join(desktop, 'dist/config.json'), JSON.stringify({ url: origin }))
execFileSync('bunx', ['electron-builder', '--linux', '--publish', 'never'], { cwd: desktop, stdio: 'inherit' })

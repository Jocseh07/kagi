import { getSettings, setSetting } from '@/lib/db/repositories'
import { ADAPT_KEYS, GENERATION_MODES, resolveAdaptSettings } from '@/lib/adapt/settings-model'
import type { AdaptSettings } from '@/lib/adapt/settings'
import { getSecret, setSecret } from './preferences'
import { exclusive } from './database'

const CONNECTION_KEY = 'adapt.connection'
export interface AdaptConnection { endpoint: string; apiKey: string }

export async function readAdaptConnection(): Promise<AdaptConnection> {
  const raw = await getSecret(CONNECTION_KEY)
  if (!raw) return { endpoint: '', apiKey: '' }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || !('endpoint' in parsed) || typeof parsed.endpoint !== 'string' || !('apiKey' in parsed) || typeof parsed.apiKey !== 'string') throw new Error('The saved connection is unreadable. Reset it in Adapt settings.')
  return { endpoint: parsed.endpoint, apiKey: parsed.apiKey }
}

export async function writeAdaptConnection(connection: AdaptConnection): Promise<void> {
  const endpoint = connection.endpoint.trim().replace(/\/+$/, '')
  if (endpoint) {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP endpoint without credentials, query parameters, or a fragment.')
  }
  await setSecret(CONNECTION_KEY, JSON.stringify({ endpoint, apiKey: connection.apiKey }))
}

export async function readAdaptSettings(): Promise<AdaptSettings> {
  return exclusive(async () => {
    const keys = Object.values(ADAPT_KEYS).filter((key) => key !== ADAPT_KEYS.apiKey && key !== ADAPT_KEYS.endpoint)
    const stored = await getSettings(keys)
    const connection = await readAdaptConnection()
    stored.set(ADAPT_KEYS.endpoint, connection.endpoint)
    stored.set(ADAPT_KEYS.apiKey, connection.apiKey)
    return resolveAdaptSettings(stored)
  })
}

export async function writeAdaptSetting<K extends keyof AdaptSettings>(field: K, value: AdaptSettings[K]): Promise<void> {
  if (!Object.hasOwn(ADAPT_KEYS, field)) throw new Error('Unknown generation setting.')
  if (field === 'apiKey' || field === 'endpoint') {
    if (typeof value !== 'string') throw new Error('The connection value must be text.')
    const current = await readAdaptConnection()
    await writeAdaptConnection({ ...current, [field]: value })
    return
  }
  if (field === 'mode' && !GENERATION_MODES.some((mode) => mode === value)) throw new Error('Choose Fast, Balanced, or Custom mode.')
  if (field === 'priority' && typeof value !== 'boolean') throw new Error('Priority speed must be on or off.')
  if (['concurrency', 'chaptersAtOnce', 'scriptsAhead', 'readAhead'].includes(field) && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) throw new Error('Choose a positive whole generation limit.')
  await setSetting(ADAPT_KEYS[field], String(value))
}

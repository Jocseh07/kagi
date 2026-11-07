import { useQuery } from '@tanstack/react-query'

import { useDatabaseReady } from '@/lib/db/provider'
import { getSettings, setSetting } from '@/lib/db/repositories'
import { ADAPT_KEYS, resolveAdaptSettings } from './settings-model'

export type GenerationMode = 'fast' | 'balanced' | 'custom'

export interface AdaptSettings {
  mode?: GenerationMode
  endpoint: string
  apiKey: string
  planningModel: string
  scriptModel: string
  imageModel: string
  concurrency: number
  chaptersAtOnce: number
  scriptsAhead: number
  readAhead: number
  priority?: boolean
}


export const adaptSettingsQueryKey = ['db', 'setting', 'adapt'] as const


export async function readAdaptSettings(): Promise<AdaptSettings> {
  return resolveAdaptSettings(await getSettings(Object.values(ADAPT_KEYS)))
}

export async function writeAdaptSetting<K extends keyof AdaptSettings>(
  field: K,
  value: AdaptSettings[K],
): Promise<void> {
  await setSetting(ADAPT_KEYS[field], String(value))
}

export function useAdaptSettings() {
  const ready = useDatabaseReady()
  return useQuery({
    queryKey: adaptSettingsQueryKey,
    queryFn: readAdaptSettings,
    enabled: ready,
    staleTime: Infinity,
  })
}

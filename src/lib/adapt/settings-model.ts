import type { AdaptSettings, GenerationMode } from './settings'

export const ADAPT_DEFAULTS: AdaptSettings = {
  mode: 'custom',
  endpoint: '',
  apiKey: '',
  planningModel: 'gpt-6-sol(low)',
  scriptModel: 'gpt-6-sol(low)',
  imageModel: 'gpt-image-2.5-flare',
  concurrency: 32,
  chaptersAtOnce: 2,
  scriptsAhead: 3,
  readAhead: 3,
  priority: false,
}

export const GENERATION_MODES = ['fast', 'balanced', 'custom'] as const

const PRESETS: Record<Exclude<GenerationMode, 'custom'>, Pick<AdaptSettings,
  'planningModel' | 'scriptModel' | 'imageModel' | 'concurrency' | 'chaptersAtOnce' | 'scriptsAhead' | 'readAhead'
>> = {
  fast: {
    planningModel: 'gpt-6-luna',
    scriptModel: 'gpt-6-luna',
    imageModel: 'gpt-image-2.5-flare',
    concurrency: 32,
    chaptersAtOnce: 2,
    scriptsAhead: 1,
    readAhead: 1,
  },
  balanced: {
    planningModel: 'gpt-6-sol(low)',
    scriptModel: 'gpt-6-sol(low)',
    imageModel: 'gpt-image-2.5-flare',
    concurrency: 32,
    chaptersAtOnce: 2,
    scriptsAhead: 3,
    readAhead: 3,
  },
}

export function applyGenerationMode(settings: AdaptSettings): AdaptSettings {
  return settings.mode && settings.mode !== 'custom' ? { ...settings, ...PRESETS[settings.mode] } : settings
}

export const CONCURRENCY_CHOICES = [4, 8, 16, 24, 32] as const
export const CHAPTERS_AT_ONCE_CHOICES = [1, 2, 3, 5, 10] as const
export const SCRIPTS_AHEAD_CHOICES = [1, 3, 5, 10] as const
export const READ_AHEAD_CHOICES = [1, 3, 5, 10] as const

export const ADAPT_KEYS: Record<keyof AdaptSettings, string> = {
  mode: 'adapt.mode',
  endpoint: 'adapt.endpoint',
  apiKey: 'adapt.apiKey',
  planningModel: 'adapt.planningModel',
  scriptModel: 'adapt.scriptModel',
  imageModel: 'adapt.imageModel',
  concurrency: 'adapt.concurrency',
  chaptersAtOnce: 'adapt.chaptersAtOnce',
  scriptsAhead: 'adapt.scriptsAhead',
  readAhead: 'adapt.readAhead',
  priority: 'adapt.priority',
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

export function resolveAdaptSettings(stored: ReadonlyMap<string, string>): AdaptSettings {
  const savedMode = stored.get(ADAPT_KEYS.mode)
  const mode = GENERATION_MODES.find((choice) => choice === savedMode) ?? 'custom'
  const text = (field: 'planningModel' | 'scriptModel' | 'imageModel') =>
    stored.get(ADAPT_KEYS[field])?.trim() || ADAPT_DEFAULTS[field]
  return applyGenerationMode({
    mode,
    endpoint: (stored.get(ADAPT_KEYS.endpoint) ?? '').trim().replace(/\/+$/, ''),
    apiKey: stored.get(ADAPT_KEYS.apiKey) ?? '',
    planningModel: text('planningModel'),
    scriptModel: text('scriptModel'),
    imageModel: text('imageModel'),
    concurrency: positive(stored.get(ADAPT_KEYS.concurrency), ADAPT_DEFAULTS.concurrency),
    chaptersAtOnce: positive(stored.get(ADAPT_KEYS.chaptersAtOnce), ADAPT_DEFAULTS.chaptersAtOnce),
    scriptsAhead: positive(stored.get(ADAPT_KEYS.scriptsAhead), ADAPT_DEFAULTS.scriptsAhead),
    readAhead: positive(stored.get(ADAPT_KEYS.readAhead), ADAPT_DEFAULTS.readAhead),
    priority: stored.get(ADAPT_KEYS.priority) === 'true',
  })
}

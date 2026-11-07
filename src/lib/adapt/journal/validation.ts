import type { ChatOptions } from '../client'
import { normalizeBeatDraft } from '../beats'
import { validateCheckResult } from '../check'
import { normalizePlanDraft } from '../planner'
import { normalizeScriptDraft } from '../script'
import { jsonValue, recordValidation } from './runtime'
import type { GenerationRecord, GenerationStage, JsonValue } from './types'

export function validationValue(run: GenerationRecord): JsonValue {
  const output = run.output
  if (output && typeof output === 'object' && !Array.isArray(output) && output.journalValidated === 1) return output.value
  throw new Error('This generation has no validated replacement output.')
}

/** `context` is the run's validation resolved from its shared inputs. */
export function validateReplayOutput(run: GenerationRecord, context: JsonValue | undefined): JsonValue {
  if (run.stage === 'sheet' || run.stage === 'panel') return run.output ?? null
  const saved = run.output
  const raw = saved && typeof saved === 'object' && !Array.isArray(saved) && saved.journalValidated === 1 ? saved.raw : saved
  if (!context || typeof context !== 'object' || Array.isArray(context)) throw new Error('The original validation inputs are missing.')
  let value: unknown
  switch (run.stage) {
    case 'plan': value = normalizePlanDraft(raw, context); break
    case 'beats': value = normalizeBeatDraft(raw, context); break
    case 'script': value = normalizeScriptDraft(raw, context); break
    case 'check': value = validateCheckResult(raw); break
    case 'prompt': {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.prompt !== 'string' || !raw.prompt.trim()) {
        throw new Error('The prompt rewrite is empty or malformed.')
      }
      value = raw.prompt.trim()
      break
    }
  }
  return jsonValue({ journalValidated: 1, raw, value })
}

export interface ValidationCapture {
  options: ChatOptions
  finish(errors: readonly string[], output?: unknown): Promise<void>
  /** Records `value`, which the caller already validated and normalized from `raw`. */
  success(raw: unknown, value: unknown): Promise<void>
}

export function captureValidation(stage: GenerationStage, validation: unknown, options?: ChatOptions): ValidationCapture {
  let id: string | undefined
  const context = { ...options?.context, stage, validation: jsonValue(validation) }
  const captured: ChatOptions = {
    ...options,
    context,
    onRecord: (next) => { id = next; options?.onRecord?.(next) },
  }
  return {
    options: captured,
    async finish(errors: readonly string[], output?: unknown): Promise<void> {
      if (id) await recordValidation(id, errors, output === undefined ? undefined : jsonValue(output), options?.store)
    },
    async success(raw: unknown, value: unknown): Promise<void> {
      if (id) await recordValidation(id, [], jsonValue({ journalValidated: 1, raw, value }), options?.store)
    },
  }
}

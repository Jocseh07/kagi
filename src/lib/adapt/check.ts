import { captureValidation } from './journal/validation'
import type { ChatOptions } from './client'
import { MalformedReplyError, chatJson } from './client'
import type { ContentPart } from './client'
import { downscale } from './compose'
import type { AdaptSettings } from './settings'
import type { ScriptPanel } from './store'

/** Redraws a flagged panel gets before it is kept as it is and flagged for you. */
export const MAX_CHECK_REDRAWS = 2

export interface CheckReference {
  label: string
  blob: Blob
}

export interface CheckResult {
  ok: boolean
  issue?: string
}

export function validateCheckResult(reply: unknown): CheckResult {
  if (typeof reply !== 'object' || reply === null || Array.isArray(reply) || !('ok' in reply) || !('issue' in reply) ||
    typeof reply.ok !== 'boolean' || typeof reply.issue !== 'string') {
    throw new MalformedReplyError('Panel checker returned an incomplete result.')
  }
  const issue = reply.issue.trim()
  if ((!reply.ok && !/\p{L}/u.test(issue)) || (reply.ok && issue.length > 0)) {
    throw new MalformedReplyError('Panel checker must give a redraw instruction on failure and no issue on success.')
  }
  return reply.ok ? { ok: true } : { ok: false, issue }
}

const SYSTEM = `You check one drawn comic panel against its script and reference sheets before it is lettered.
Return only JSON: {"ok": boolean, "issue": string}.
Fail the panel (ok false) only for one of these:
- the number of people differs from the script's cast, counting only clearly visible people;
- a named character does not match their reference sheet (face, hair, outfit), or wears clothing other than the look the cast line names;
- the image contains text, letters, speech bubbles, captions or a watermark;
- a face, head or body sits in a corner reserved for lettering.
Ignore style, composition and small details. issue is one short instruction for the redraw, such as "Wen Yi's hair is black, not brown" or "remove the sign text", and "" when ok is true.
Never use em or en dashes.`

const ANCHORS = { tl: 'top left', tr: 'top right', bl: 'bottom left', br: 'bottom right' } as const

async function dataUrl(blob: Blob): Promise<string> {
  const small = await downscale(blob)
  const bytes = new Uint8Array(await small.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return `data:${small.type || 'image/png'};base64,${btoa(binary)}`
}

export async function checkPanel(
  settings: AdaptSettings,
  panel: ScriptPanel,
  cast: readonly string[],
  image: Blob,
  refs: readonly CheckReference[],
  signal?: AbortSignal,
  options?: ChatOptions,
): Promise<CheckResult> {
  const corners = panel.text.map((item) => ANCHORS[item.anchor]).join(' and ') || 'none'
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: `Script: ${panel.shot}. ${panel.prompt}\nCast on screen: ${cast.join(', ') || 'no named characters'}.\nCorners reserved for lettering: ${corners}.\nThe first image is the panel; the rest are, in order: ${refs.map((ref) => ref.label).join('; ') || 'no references'}.`,
    },
    { type: 'image_url', image_url: { url: await dataUrl(image) } },
  ]
  for (const ref of refs) parts.push({ type: 'image_url', image_url: { url: await dataUrl(ref.blob) } })
  const capture = captureValidation('check', { panel, cast }, options)
  const reply = await chatJson<unknown>(settings, settings.planningModel, SYSTEM, parts, signal, capture.options)
  try {
    const result = validateCheckResult(reply)
    await capture.success(reply, result)
    return result
  } catch (cause) {
    await capture.finish([cause instanceof Error ? cause.message : String(cause)], reply)
    throw cause
  }
}

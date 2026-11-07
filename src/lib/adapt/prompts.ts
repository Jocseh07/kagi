import { parseDocument } from '../text/document'
import { captureValidation } from './journal/validation'
import type { ChatOptions } from './client'
import { MalformedReplyError, chatJson } from './client'
import type { AdaptSettings } from './settings'
import type { AdaptStyle, Character, Look, Place, Prop, PropKind } from './store'

export const STYLE_PROMPTS: Record<AdaptStyle, string> = {
  manga:
    'Black and white Japanese manga: clean ink line art, screentone shading, expressive faces, consistent proportions in every image.',
  webtoon:
    'Full-colour Korean action webtoon (manhwa): crisp digital line art, cel shading with soft airbrushed gradients, restrained scene-consistent palette and lighting with readable faces, strong rim light and glow only for heightened action, detailed painterly backgrounds, camera angle chosen to suit the beat with eye level for calm scenes, consistent proportions in every image.',
  sketch:
    'Rough pencil storyboard sketch: loose confident lines, light grey shading, consistent proportions in every image.',
}

export function styleLine(style: AdaptStyle, notes: string): string {
  return notes.trim() ? `${STYLE_PROMPTS[style]} ${notes.trim()}` : STYLE_PROMPTS[style]
}

export function isMainLook(look: Look): boolean {
  return look.id.endsWith('@main')
}

/** The character's description for one look; a look's change replaces whatever the main description says about the same thing, such as the outfit. */
export function lookAppearance(character: Character, look: Look): string {
  return look.change
    ? `${character.appearance}\n${look.name} look, which wins wherever it differs from the description above. Clothing it names replaces the outfit above entirely: ${look.change}`
    : character.appearance
}

export function sheetPrompt(style: string, character: Character, look: Look): string {
  const variant = isMainLook(look)
    ? ''
    : `\nReference image 1 is ${character.name}'s main sheet. Keep the same face and identity, and apply only this look's changes, drawing its own clothing where it names any.`
  return `Character reference sheet for ${character.name} (${look.name}). ${style}
${lookAppearance(character, look)}${variant}
Layout: full-body front view, three-quarter view and side view standing in a row, plus three head close-ups showing neutral, smiling and determined expressions. Plain light grey background, even studio lighting, no text, no labels.`
}

const PROP_LAYOUTS: Record<PropKind, string> = {
  vehicle:
    'Layout: front three-quarter, side and rear three-quarter exterior views in a row, then the interior seen from the driver seat, plus a close-up of its key or key fob.',
  object:
    'Layout: front, side and back views laid flat in a row, plus a close-up of its most distinctive detail.',
  creature:
    'Layout: full-body front view, three-quarter view and side view standing in a row, plus three head close-ups showing calm, alert and angry expressions.',
}

export function propSheetPrompt(style: string, prop: Prop): string {
  return `Design reference sheet for ${prop.name}, a recurring ${prop.kind} in a comic. ${style}
${prop.description}
${PROP_LAYOUTS[prop.kind]} Drawn in that art style like a comic artist's model sheet, never a photograph or 3D render. The same design in every view. No people. Plain light grey background, even studio lighting, no text, no labels.`
}

export function placeSheetPrompt(style: string, place: Place): string {
  return `Design reference sheet for ${place.name}, a recurring place in a comic. ${style}
${place.description}
Layout: one wide exterior establishing view on top, then two interior views below: the main room seen from the entrance, and the reverse angle looking back at the entrance. Drawn in that art style like a comic artist's model sheet, never a photograph or 3D render. The same design in every view. No people. Thin white gutters between the views, neutral daylight, no text, no labels.`
}

const CLEAN_SYSTEM = `You rewrite image prompts for a comic panel or reference sheet so an all-ages image safety filter accepts them.
Keep: the art style line, the panel framing or sheet layout, the scene, the setting, the action, every character name, every reference image line, and the lettering line.
Describe everyone as fully and modestly clothed in everyday wear.
Remove: stated ages and age words (teenage, boy, girl, young), body-shape words (slender, figure, curves, legs, chest, skin, build), suggestive or revealing poses and outfits, undressing, bed or bath framing, and intimate contact.
Turn violence and injury into non-graphic action: no blood, no wounds, no self-harm, no weapon aimed at or touching anyone.
Reply with only {"prompt": "<the rewritten prompt>"}.`

/** Null when the model gives no usable rewrite. */
export async function cleanImagePrompt(
  settings: AdaptSettings,
  prompt: string,
  signal: AbortSignal,
  options?: ChatOptions,
): Promise<string | null> {
  const capture = captureValidation('prompt', { prompt }, options)
  try {
    const reply = await chatJson<{ prompt?: unknown }>(settings, settings.scriptModel, CLEAN_SYSTEM, prompt, signal, capture.options)
    const rewritten = typeof reply?.prompt === 'string' ? reply.prompt.trim() : ''
    if (rewritten) {
      await capture.success(reply, rewritten)
      return rewritten
    }
    await capture.finish(['The prompt rewrite is empty or malformed.'], reply)
    return null
  } catch (cause) {
    if (cause instanceof MalformedReplyError) return null
    throw cause
  }
}

/** Every look a script may reference, one per line, for the script prompt; a character with a set outfit lists only that look. */
export function castLines(characters: readonly Character[], wearing: Readonly<Record<string, string>> = {}): string {
  return characters
    .flatMap((character) =>
      character.looks
        .filter((look) => !wearing[character.id] || look.id === wearing[character.id])
        .map((look) => `${look.id}: ${character.name}, ${look.name}. ${lookAppearance(character, look)}`),
    )
    .join('\n')
}

/** The cast member a script's speaker refers to: by look id, full name, or first name. */
export function speakerCharacter(characters: readonly Character[], speaker: string | undefined): Character | undefined {
  const name = (value: string) => value.normalize('NFC').trim().toLowerCase()
  const wanted = speaker && name(speaker)
  if (!wanted) return undefined
  return (
    characters.find((character) => character.looks.some((look) => look.id.toLowerCase() === wanted)) ??
    characters.find((character) => name(character.name) === wanted) ??
    characters.find((character) => name(firstName(character.name)) === wanted)
  )
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

/** The text of chapter HTML, a blank line between paragraphs so quote pairing and passage cuts can see where each ends. */
export function plainText(html: string): string {
  const body = parseDocument(html, 'text/html').body
  for (const br of [...body.querySelectorAll('br')]) br.replaceWith('\n')
  for (const block of [...body.querySelectorAll('p, div, li, blockquote, h1, h2, h3, h4, h5, h6')]) block.append('\n\n')
  return (body.textContent ?? '').replace(/[^\S\n]*\n[^\S\n]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export function decodeDialoguePunctuation(text: string): string {
  return text.replace(/\\u([0-9a-f]{4})/gi, (escape, hex: string) => {
    const character = String.fromCharCode(Number.parseInt(hex, 16))
    return /\p{P}/u.test(character) ? character : escape
  })
}

export function clean(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/ ?[–—] ?/g, ', ')
    .trim()
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'character'
  )
}

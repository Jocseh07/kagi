import type { StoryboardInput } from '../src/lib/adapt/script'
import type { Adaptation, Beat, Character } from '../src/lib/adapt/store'

export const adaptation: Adaptation = {
  id: 'benchmark', sourceId: 'synthetic', novelUrl: '', title: 'The Brass Key',
  style: 'manga', styleNotes: '', novelChapterCount: 1, readThrough: 0, skipped: [],
  status: 'active', error: null, checkedAt: 0, createdAt: 0, skipPrologue: false, checkPanels: false,
}

export const characters: Character[] = [
  { id: 'mira', adaptationId: 'benchmark', name: 'Mira', role: 'courier',
    appearance: 'Mira is an adult courier with short black hair, brown eyes, a round face and a compact build. She wears a plain blue cotton jacket, dark trousers and brown boots. Her left sleeve has a square white patch. She carries a brass key on a red cord. Her hands have no gloves or jewellery.',
    firstNovelChapter: 1, looks: [{ id: 'mira@main', name: 'Main', change: '', sheetKey: null }] },
  { id: 'oren', adaptationId: 'benchmark', name: 'Oren', role: 'clock keeper',
    appearance: 'Oren is an adult clock keeper with curly grey hair, green eyes, a long face and a tall slender build. He wears a plain green wool vest over a cream cotton shirt, dark trousers and black boots. He has round brass spectacles. His sleeves are rolled to his elbows. Both hands are empty.',
    firstNovelChapter: 1, looks: [{ id: 'oren@main', name: 'Main', change: '', sheetKey: null }] },
]

const intro = `${characters.map((character) => character.appearance).join(' ')} They stand in the clock room, a small square stone room with one round window on the left and a wooden clock cabinet on the right. The brass key has a triangular bow and exactly two teeth.`
const scenes: { id: string; moments: string[]; lines: [string, string][][] }[] = [
  { id: 'short', moments: ['Mira enters the clock room carrying the key in her right hand.', 'Mira places the key on the table. Oren nods without touching it.', 'Mira leaves. The key stays on the table.'], lines: [[['Mira', 'I found the key.']], [['Oren', 'Leave it here.']], []] },
  { id: 'dialogue-heavy', moments: ['Mira shows Oren the key in her right hand.', 'Oren points at the cabinet without taking the key.', 'Mira places the key on the table and both step back.'], lines: [[['Mira', 'Is this your key?'], ['Oren', 'Yes, but do not turn it.']], [['Mira', 'What is inside?'], ['Oren', 'A clock that must stay stopped.']], [['Mira', 'Then it stays here.'], ['Oren', 'Thank you for listening.']]] },
  { id: 'action-heavy', moments: ['A gust opens the window. Mira catches the falling key with her right hand.', 'Oren closes the window with both empty hands while Mira steps away from the cabinet.', 'Mira sets the key on the table. Oren blocks the cabinet door with his body.'], lines: [[['Oren', 'Catch the key!']], [['Mira', 'I have it.']], [['Oren', 'Keep the cabinet shut.']]] },
]

export const fixtures = scenes.map((scene) => {
  const beats: Beat[] = scene.moments.map((moment, index) => ({ moment, weight: 'key', place: 'clock-room', cast: ['mira', 'oren'], lines: scene.lines[index] }))
  const input: StoryboardInput = {
    beats, memory: undefined, characters, style: 'manga',
    props: [{ id: 'brass-key', name: 'Brass key', kind: 'object', description: 'A brass key with a triangular bow and exactly two teeth, attached to a red cord.' }],
    places: [{ id: 'clock-room', name: 'Clock room', description: 'A small square stone room with one round window on the left, a table in the middle and a wooden clock cabinet on the right.' }],
  }
  return { id: scene.id, input, text: `${intro}\n${beats.map((beat) => `${beat.moment} ${beat.lines.map(([speaker, line]) => `${speaker} says, "${line}"`).join(' ')}`).join('\n')}` }
})

export const sheetPrompt = `A safe character reference sheet, two adult characters standing apart, front views, plain white background. Left: ${characters[0].appearance} Right: ${characters[1].appearance} Include the brass key with its triangular bow and exactly two teeth. Clean coloured comic line art. No text, labels, letters, logos, speech bubbles or watermark.`
export const panelPrompts = [
  'Exactly two adults. Mira stands left and holds the brass key in her right hand, left hand empty. Oren stands right with both hands empty. Medium two-shot in the clock room.',
  'Exactly two adults. Mira stands left placing the brass key on the table with her right hand, left hand empty. Oren stands right, both empty hands resting at his sides. Wide shot in the clock room.',
  'Exactly two adults. Mira stands left holding the brass key in her right hand, left hand empty. Oren stands right closing the round window with both empty hands. Wide shot in the clock room.',
].map((scene) => `Safe coloured comic panel. Match both adults and the key to the attached reference sheet exactly. ${scene} One round window on the left, wooden clock cabinet on the right. Leave the top left corner empty for later lettering. No text, labels, speech bubbles, logos, borders or watermark.`)

import type { GenerationState } from './store'

export function chapterId(adaptationId: string, number: number): string {
  return `${adaptationId}:${number}`
}

export function sheetKey(adaptationId: string, lookId: string): string {
  return `${adaptationId}/sheet/${lookId}`
}

export function propSheetKey(adaptationId: string, propId: string): string {
  return `${adaptationId}/prop/${propId}`
}

export function placeSheetKey(adaptationId: string, placeId: string): string {
  return `${adaptationId}/place/${placeId}`
}

export function pageKey(adaptationId: string, chapterNumber: number, page: number): string {
  return `${adaptationId}/page/${chapterNumber}/${page}`
}

export function panelKey(adaptationId: string, chapterNumber: number, page: number, panel: number): string {
  return `${adaptationId}/panel/${chapterNumber}/${page}-${panel}`
}

export function textKey(adaptationId: string, url: string): string {
  return `${adaptationId}/text/${url}`
}

export function generationStateIdentity(state: GenerationState): string {
  return JSON.stringify({
    adaptation: state.adaptation,
    chapters: state.chapters,
    characters: state.characters,
    blobs: [...state.blobs].map(([key, blob]) => [key, blob.size, blob.type]),
    texts: [...state.texts],
  })
}

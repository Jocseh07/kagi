export type DocumentType = 'text/html' | 'application/xml'

export const preserveFragmentIds = false
export const allowBlobImages = false

export function canParseDocuments(): boolean {
  return typeof DOMParser !== 'undefined'
}

export function parseDocument(text: string, type: DocumentType = 'text/html'): Document {
  return new DOMParser().parseFromString(text, type)
}

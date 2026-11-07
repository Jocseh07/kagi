import { DOMParser } from 'linkedom'
import type { DocumentType } from '../../../src/lib/text/document'

export const preserveFragmentIds = true
export const allowBlobImages = true

export function canParseDocuments(): boolean {
  return true
}

function isDocument(value: unknown): value is Document {
  return value !== null && typeof value === 'object' && 'nodeType' in value && value.nodeType === 9
    && 'querySelector' in value && typeof value.querySelector === 'function'
    && 'createElement' in value && typeof value.createElement === 'function'
    && 'documentElement' in value
}

export function parseDocument(text: string, type: DocumentType = 'text/html'): Document {
  const parser = new DOMParser()
  const parsed: unknown = parser.parseFromString(text, type === 'application/xml' ? 'text/xml' : type)
  if (!isDocument(parsed)) throw new Error('The document parser returned an invalid document.')
  if (type === 'application/xml' || parsed.documentElement?.localName === 'html') return parsed
  const fragment: unknown = parser.parseFromString(`<!doctype html><html><head></head><body>${text}</body></html>`, type)
  if (!isDocument(fragment)) throw new Error('The document parser could not read this chapter.')
  return fragment
}

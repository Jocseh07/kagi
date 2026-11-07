export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
export type Params = { [key: string]: Json }

export interface Action {
  id: string
  label: string
  method: string
  params?: Params
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  confirm?: string
  pick?: 'file' | 'folder' | 'save'
  accept?: string[]
  cancelable?: boolean
}

export interface Choice { value: string; label: string }
export interface Field {
  id: string
  label: string
  kind: 'text' | 'password' | 'number' | 'select' | 'toggle' | 'multiline'
  value: string
  hint?: string
  options?: Choice[]
  disabled?: boolean
}
export interface Tab { id: string; label: string; route: string; params?: Params; selected?: boolean }
export interface ImageRef {
  sourceId: string
  url: string
  index?: number
  descramble?: { tiles: number[]; cols: number; rows: number }
}
export interface Row {
  id: string
  title: string
  subtitle?: string
  detail?: string
  image?: string
  imageRef?: ImageRef
  badges?: string[]
  progress?: number
  actions?: Action[]
  selected?: boolean
}
export interface Section {
  id: string
  title?: string
  status?: 'loading' | 'ready' | 'error'
  error?: string
  empty?: string
  layout?: 'list' | 'grid' | 'form'
  rows?: Row[]
  fields?: Field[]
  actions?: Action[]
}
export interface Dialog { id: string; title: string; description?: string; fields?: Field[]; actions: Action[] }
export interface TextBlock {
  id: string
  kind: 'paragraph' | 'heading' | 'quote' | 'code' | 'list' | 'image' | 'rule'
  text?: string
  level?: number
  spans?: { text: string; bold?: boolean; italic?: boolean; mono?: boolean; underline?: boolean; href?: string }[]
  image?: string
  imageRef?: ImageRef
}
export interface Reader {
  seriesId: string
  chapterId: string
  kind: 'comic' | 'novel'
  mode: 'continuous' | 'paged-ltr' | 'paged-rtl'
  position: number
  pages?: { path?: string; width?: number; height?: number; imageRef?: ImageRef }[]
  blocks?: TextBlock[]
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  measure?: number
  fit?: 'width' | 'screen'
  gap?: boolean
  continuousStyle?: 'vertical' | 'webtoon'
  surface?: string
  justify?: boolean
  wordStarts?: 'off' | 'light' | 'medium' | 'strong'
  dimIdle?: boolean
}
export interface Screen {
  route: string
  routeKey: string
  title: string
  subtitle?: string
  tabs?: Tab[]
  actions?: Action[]
  sections: Section[]
  dialog?: Dialog
  reader?: Reader
  theme?: Record<string, string>
  fonts?: { family: string; path: string }[]
}
export interface Request { id: number; method: string; params?: Params }
export type Reply = { id: number; ok: true; result: Result } | { id: number; ok: false; error: { code: string; message: string } }
export interface Result { screen?: Screen; notice?: string; externalUrl?: string; exportPath?: string; dialog?: Dialog; navigate?: { route: string; params?: Params }; sections?: Section[]; [key: string]: unknown }
export type Event = { event: 'section'; routeKey: string; section: Section } | { event: 'reader'; routeKey: string; reader: Reader } | { event: 'notice'; message: string } | { event: 'changed'; topics: string[] }
export type Emit = (event: Event) => void

export function params(value: Json | undefined): Params {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.')
  return value
}
export function string(value: Json | undefined, fallback = ''): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error('Expected text.')
  return value
}
export function number(value: Json | undefined, fallback = 0): number {
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(parsed)) throw new Error('Expected a finite number.')
  return parsed
}
export function strings(value: Json | undefined): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new Error('Expected a text list.')
  return value
}
export function isRequest(value: unknown): value is Request {
  if (!value || typeof value !== 'object') return false
  return 'id' in value && typeof value.id === 'number' && Number.isSafeInteger(value.id) && value.id >= 0
    && 'method' in value && typeof value.method === 'string' && value.method.length > 0 && value.method.length <= 80
    && (!('params' in value) || (value.params !== null && typeof value.params === 'object' && !Array.isArray(value.params)))
}

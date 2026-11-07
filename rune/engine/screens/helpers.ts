import type { Action, Choice, Field, Params, Row, Section, Tab } from '../protocol'

export function action(label: string, method: string, params: Params = {}, options: Partial<Omit<Action, 'id' | 'label' | 'method' | 'params'>> = {}): Action {
  return { id: `${method}:${JSON.stringify(params)}`, label, method, params, ...options }
}

export function navigate(label: string, route: string, params: Params = {}, primary = false): Action {
  return action(label, 'navigate', { route, ...params }, { variant: primary ? 'primary' : 'secondary' })
}

export function field(id: string, label: string, value: string | number | boolean, kind: Field['kind'] = 'text', options?: Choice[], hint?: string): Field {
  return { id, label, value: String(value), kind, ...(options ? { options } : {}), ...(hint ? { hint } : {}) }
}

export function choices(values: readonly (string | number)[]): Choice[] {
  return values.map((value) => ({ value: String(value), label: String(value) }))
}

export function section(id: string, title: string, rows: Row[], empty: string, actions?: Action[], layout: Section['layout'] = 'list'): Section {
  return { id, title, status: 'ready', layout, rows, empty, ...(actions ? { actions } : {}) }
}

export function tabs(route: string, selected: string, entries: readonly [string, string][], params: Params = {}): Tab[] {
  return entries.map(([id, label]) => ({ id, label, route, params: { ...params, tab: id }, selected: id === selected }))
}

export function date(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString() : 'Date unavailable'
}

export function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`
}

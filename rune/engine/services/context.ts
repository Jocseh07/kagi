import type { Dialog, Params, Result, Screen } from '../protocol'

export interface MutationContext {
  screen: Screen
  params: Params
  signal: AbortSignal
  navigate(route: string, params?: Params): Promise<Result>
  refresh(): Promise<Result>
  dialog(dialog: Dialog): Result
  undo(label: string, restore: () => Promise<void>): void
}

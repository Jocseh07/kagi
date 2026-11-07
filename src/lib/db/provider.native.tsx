import * as React from 'react'
import { openDatabase } from './migrate'
import { applyStoredPreferences } from '@/lib/sources/preferences'
import { seedLedger } from '@/lib/sync/seed'

export type DbStatus = 'loading' | 'ready' | 'error'

export interface DbState {
  status: DbStatus
  error: Error | null
  retry: () => void
}

const DbContext = React.createContext<DbState>({ status: 'loading', error: null, retry: () => {} })

let boot: Promise<void> | undefined
let seeding: Promise<void> | null = null

export async function waitForDatabaseSeed(): Promise<void> {
  await seeding
}

function bootstrap(): Promise<void> {
  boot ??= (async () => {
    await openDatabase()
    await applyStoredPreferences()
    // Not awaited: stating an old library into the sync ledger can be thousands of writes.
    seeding = seedLedger().catch(() => undefined).finally(() => { seeding = null })
  })().catch((error: unknown) => {
    boot = undefined
    throw error
  })
  return boot
}

export function DatabaseProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = React.useState<{ status: DbStatus; error: Error | null }>({
    status: 'loading',
    error: null,
  })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    let live = true
    bootstrap().then(
      () => live && setState({ status: 'ready', error: null }),
      (error: unknown) =>
        live &&
        setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) })
    )
    return () => {
      live = false
    }
  }, [attempt])

  const retry = React.useCallback(() => {
    setState({ status: 'loading', error: null })
    setAttempt((n) => n + 1)
  }, [])

  const value = React.useMemo(() => ({ ...state, retry }), [state, retry])
  return <DbContext.Provider value={value}>{children}</DbContext.Provider>
}

export function useDatabase(): DbState {
  return React.useContext(DbContext)
}

export function useDatabaseReady(): boolean {
  return React.useContext(DbContext).status === 'ready'
}

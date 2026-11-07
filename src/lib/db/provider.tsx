import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { DatabaseZap } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { applyStoredPreferences } from '@/lib/sources/preferences'
import { persist } from '@/lib/storage/persist'
import { seedLedger } from '@/lib/sync/seed'
import { DbError } from './client'
import type { DbErrorCode } from './client'
import { openDatabase } from './migrate'

export type DbStatus = 'loading' | 'ready' | 'error'

export interface DbState {
  status: DbStatus
  error: Error | null
}

const DbContext = createContext<DbState>({ status: 'loading', error: null })

export function useDatabase(): DbState {
  return useContext(DbContext)
}

export function useDatabaseReady(): boolean {
  return useContext(DbContext).status === 'ready'
}

// One boot per page load, shared across StrictMode's double mount.
let boot: Promise<void> | undefined

function bootstrap(): Promise<void> {
  boot ??= (async () => {
    await openDatabase()
    await persist()
    // Reads persisted settings into live source instances, so the first browse
    // already reflects them rather than the defaults.
    await applyStoredPreferences()

    // Deliberately not awaited. A library that predates the sync ledger has to
    // be stated into it once, which for a large one is thousands of small
    // writes; blocking the app behind that would trade a working library for a
    // spinner. It is idempotent, it resumes if this page never finishes it, and
    // `runSync` waits for it before pushing anything.
    void seedLedger().catch(() => {
      // Reported by the sync panel if it matters. Nothing here is broken by it:
      // the library is intact and every screen reads the tables, not the ledger.
    })
  })()
  return boot
}

function asError(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}

function codeOf(error: Error | null): DbErrorCode | null {
  return error instanceof DbError ? error.code : null
}

export function DatabaseProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DbState>({ status: 'loading', error: null })

  useEffect(() => {
    let active = true
    bootstrap().then(
      () => {
        if (active) setState({ status: 'ready', error: null })
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', error: asError(error) })
      },
    )
    return () => {
      active = false
    }
  }, [])

  // Deliberately not gated on `status === 'loading'`. Every screen below reads
  // this status and draws its own skeleton while the database opens, and Browse
  // reads no database at all — so blocking the tree here replaced the real
  // shell, and a page that was ready to render, with a spinner that knew less.
  // `MULTI_TAB` still blocks, because there is no usable app behind it.
  if (codeOf(state.error) === 'MULTI_TAB') return <MultiTabBlock />

  return (
    <DbContext.Provider value={state}>
      {children}
    </DbContext.Provider>
  )
}

/**
 * Shown to whichever tab lost the race to open the library. The tab that holds
 * it is untouched and still working, so the way out is to go back to it — or
 * close it and reload here. Nothing is negotiated between tabs.
 */
function MultiTabBlock() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-6 text-center">
        <DatabaseZap aria-hidden className="mx-auto size-6 text-muted-foreground" />
        <h1 className="mt-3 text-base font-semibold text-foreground">
          Already open in another tab
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Only one tab can use your library at a time. Switch to that tab, or
          close it and reload this page.
        </p>
        <Button
          size="lg"
          className="mt-4"
          onClick={() => {
            window.location.reload()
          }}
        >
          Reload
        </Button>
      </div>
    </div>
  )
}


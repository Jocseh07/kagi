import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { FolderOpen, FolderSearch, MonitorX, ShieldAlert } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  chooseLocalLibrary,
  forgetLocalLibrary,
  reconnectLocalLibrary,
} from '@/lib/sources/local/library'
import { LOCAL_SOURCE_ID } from '@/lib/sources/local'
import { useLocalLibrary } from '@/lib/sources/local/use-local-library'
import { cn } from '@/lib/utils'

/**
 * Picks, reconnects or forgets the folder the local source reads.
 *
 * Every action here runs from a click on purpose: `showDirectoryPicker` and a
 * permission re-request both require a user gesture, so neither can be done
 * for the user on load.
 */
export function LocalFolderPicker({ className }: { className?: string }) {
  const state = useLocalLibrary()
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<unknown>) {
    setBusy(true)
    try {
      await action()
      // Everything already fetched from the old folder is now wrong.
      await queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes(LOCAL_SOURCE_ID),
      })
    } finally {
      setBusy(false)
    }
  }

  if (state.status === 'unsupported') {
    return (
      <Panel
        className={className}
        icon={<MonitorX className="size-4" />}
        title="Not supported in this browser"
      >
        Reading a folder from this device needs the File System Access API,
        which today only Chromium desktop browsers implement. Chrome, Edge or
        Brave on a desktop can use this source; Firefox and Safari cannot.
      </Panel>
    )
  }

  if (state.status === 'denied') {
    return (
      <Panel
        className={className}
        icon={<ShieldAlert className="size-4 text-destructive" />}
        title={`Permission to read "${state.folderName}" has lapsed`}
        actions={
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void run(reconnectLocalLibrary)}
            >
              Reconnect
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run(chooseLocalLibrary)}
            >
              Choose another folder
            </Button>
          </>
        }
      >
        The browser remembers the folder but not the permission to read it.
        Grant it again to carry on where you left off.
      </Panel>
    )
  }

  if (state.status === 'unset') {
    return (
      <Panel
        className={className}
        icon={<FolderSearch className="size-4" />}
        title="No library folder chosen"
        actions={
          <Button
            size="sm"
            disabled={busy}
            onClick={() => void run(chooseLocalLibrary)}
          >
            Choose folder
          </Button>
        }
      >
        Pick a folder holding one subfolder per series, each with its chapters
        as .cbz archives or as folders of images. Nothing is uploaded and
        nothing is copied.
      </Panel>
    )
  }

  return (
    <Panel
      className={className}
      icon={<FolderOpen className="size-4" />}
      title={state.folderName ?? 'Library folder'}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void run(chooseLocalLibrary)}
          >
            Change
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void run(forgetLocalLibrary)}
          >
            Forget
          </Button>
        </>
      }
    >
      Read straight from this folder. Forgetting it only drops the browser's
      access; the files are left alone.
    </Panel>
  )
}

function Panel({
  icon,
  title,
  actions,
  className,
  children,
}: {
  icon: ReactNode
  title: string
  actions?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <div
      role="group"
      aria-label="Local library folder"
      className={cn(
        'flex items-start gap-3 rounded-lg border border-border bg-card p-3',
        className,
      )}
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {children}
        </p>
        {actions && <div className="flex flex-wrap gap-2 pt-1.5">{actions}</div>}
      </div>
    </div>
  )
}

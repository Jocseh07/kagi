import { useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { chooseJournalFolder, exportJournal, getRecordingState, importJournal, reconnectJournalFolder, subscribeRecording, syncJournalFiles } from '@/lib/adapt/journal/files'
import type { RecordingState } from '@/lib/adapt/journal/files'
import { cn } from '@/lib/utils'

const serverRecordingState: RecordingState = { mode: 'local', status: 'unset', location: null }
export function ActionError({ title, error }: { title: string; error: Error | null }) {
  if (!error) return null
  return <Alert variant="destructive"><AlertTitle>{title}</AlertTitle><AlertDescription className="break-words">{error.message}</AlertDescription></Alert>
}

export function PendingLabel({ pending, children, className }: { pending: boolean; children: ReactNode; className?: string }) {
  return <span className={cn('relative inline-flex items-center justify-center', className)}><span className={pending ? 'opacity-0' : undefined}>{children}</span>{pending && <Spinner className="absolute" />}</span>
}

export function RecordingControls({ ids }: { ids?: readonly string[] }) {
  const [open, setOpen] = useState(false)
  const state = useSyncExternalStore(subscribeRecording, getRecordingState, () => serverRecordingState)
  const input = useRef<HTMLInputElement>(null)
  const action = useMutation({
    mutationFn: async (operation: 'export' | 'choose' | 'reconnect' | 'sync' | File) => {
      if (operation instanceof File) return `${await importJournal(operation)} generations imported.`
      if (operation === 'export') { await exportJournal(ids); return 'Journal bundle downloaded.' }
      if (operation === 'choose') await chooseJournalFolder()
      else if (operation === 'reconnect') await reconnectJournalFolder()
      else await syncJournalFiles()
      const current = getRecordingState()
      if (current.status === 'denied') throw new Error('Folder permission was not granted. Reconnect the folder to allow file access.')
      if (current.status === 'error') throw new Error(current.error ?? 'File sync failed. Reconnect the folder and try again.')
      return current.status === 'ready' ? 'Journal folder synchronized.' : 'No recording folder connected.'
    },
  })
  const busy = action.isPending
  return <div className="flex min-w-0 flex-col gap-3">
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" disabled={busy || ids?.length === 0} onClick={() => action.mutate('export')}><PendingLabel pending={busy && action.variables === 'export'}>Export journal</PendingLabel></Button>
      <Dialog open={open} onOpenChange={(next) => { if (!busy) setOpen(next) }}>
        <DialogTrigger asChild><Button type="button" variant="outline" disabled={busy}>{state.status === 'denied' || state.status === 'error' ? 'Recording needs attention' : 'Recording settings'}</Button></DialogTrigger>
        <DialogContent showCloseButton={!busy} className="max-h-dvh overflow-y-auto" onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }} onInteractOutside={(event) => { if (busy) event.preventDefault() }}>
          <DialogHeader><DialogTitle>Recording settings</DialogTitle><DialogDescription>Keep journal files accessible on this device.</DialogDescription></DialogHeader>
          <dl className="grid min-w-0 gap-2 text-sm">
            <dt className="text-muted-foreground">Storage</dt><dd>{state.mode === 'desktop' ? 'Desktop files' : state.mode === 'folder' ? 'Browser and chosen folder' : 'Browser storage'}</dd>
            <dt className="text-muted-foreground">Folder</dt><dd className="break-all">{state.location ?? 'No folder connected'}</dd>
            <dt className="text-muted-foreground">Access</dt><dd>{state.status === 'ready' ? 'Ready' : state.status === 'syncing' ? 'Synchronizing files' : state.status === 'denied' ? 'Permission required' : state.status === 'error' ? 'File sync failed' : 'Not connected'}</dd>
          </dl>
          {state.error && <Alert variant="destructive"><AlertTitle>Recording needs attention</AlertTitle><AlertDescription className="break-words">{state.error}</AlertDescription></Alert>}
          <p className="text-sm text-muted-foreground">Desktop saves files automatically. Browsers need folder permission or a downloaded bundle.</p>
          <p className="text-sm text-muted-foreground">Your agent can inspect and retry local files with the CLI. Import its result to compare and approve.</p>
          <p className="text-sm text-muted-foreground">Exports include prompts, responses, and images. Share them only with people you trust.</p>
          <div className="flex flex-wrap gap-2">
            {state.mode !== 'desktop' && <Button type="button" disabled={busy} onClick={() => action.mutate('choose')}><PendingLabel pending={busy && action.variables === 'choose'}>Choose folder</PendingLabel></Button>}
            {state.mode === 'folder' && <Button type="button" variant="outline" disabled={busy} onClick={() => action.mutate('reconnect')}><PendingLabel pending={busy && action.variables === 'reconnect'}>Reconnect folder</PendingLabel></Button>}
            <Button type="button" variant="outline" disabled={busy || state.mode === 'local'} onClick={() => action.mutate('sync')}><PendingLabel pending={busy && action.variables === 'sync'}>Sync files</PendingLabel></Button>
          </div>
          <Field><FieldLabel htmlFor="journal-import">Import journal bundle</FieldLabel><Input ref={input} id="journal-import" name="journal-import" type="file" accept=".zip,application/zip" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) action.mutate(file, { onSettled: () => { if (input.current) input.current.value = '' } }) }} /></Field>
          {busy && <p role="status" className="flex items-center gap-2"><Spinner />Working with journal files</p>}
          <ActionError title="File action failed" error={action.error} />
          {action.isSuccess && <p role="status">{action.data}</p>}
        </DialogContent>
      </Dialog>
    </div>
    {!open && <ActionError title="Export failed" error={action.error} />}
    {!open && action.isSuccess && <p role="status" className="text-sm text-muted-foreground">{action.data}</p>}
  </div>
}

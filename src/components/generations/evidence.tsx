import { useCallback, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { FileSearch } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorPanel } from '@/components/ui/error-panel'
import { Skeleton } from '@/components/ui/skeleton'
import { journalStore } from '@/lib/adapt/journal/store'
import type { GenerationRecord, JournalArtifact } from '@/lib/adapt/journal/types'
import { saveBlob } from '@/lib/images/download'

export function Payload({ value }: { value: string }) {
  return <pre className="max-h-96 min-w-0 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-4 text-sm leading-relaxed">{value}</pre>
}

export function EvidenceSkeleton() {
  return <div aria-busy="true" aria-label="Loading evidence" className="flex flex-col gap-3"><Skeleton className="h-6 w-1/3" /><Skeleton className="h-32 w-full" /></div>
}

function ArtifactBody({ artifact }: { artifact: JournalArtifact }) {
  const [imageError, setImageError] = useState(false)
  const image = artifact.mime.startsWith('image/')
  const text = useQuery({
    queryKey: ['generation-artifact-text', artifact.id, artifact.sha256],
    queryFn: () => artifact.blob.text(),
    enabled: !image,
  })
  const attachImage = useCallback((node: HTMLImageElement | null) => {
    if (!node) return
    const url = URL.createObjectURL(artifact.blob)
    node.src = url
    return () => URL.revokeObjectURL(url)
  }, [artifact.blob])
  return <div className="flex min-w-0 flex-col gap-3">
    {image ? imageError ? <EmptyState icon={FileSearch} title="Image cannot be displayed" description="Download the saved file to inspect it." /> : <img ref={attachImage} alt={artifact.name} className="h-auto w-full rounded-lg border" onError={() => setImageError(true)} /> : text.isPending ? <EvidenceSkeleton /> : text.isError ? <ErrorPanel error={text.error} onRetry={() => void text.refetch()} /> : <Payload value={text.data} />}
    <Button type="button" variant="outline" onClick={() => saveBlob(artifact.blob, artifact.name)}>Download file</Button>
  </div>
}

export function ArtifactView({ id }: { id: string }) {
  const artifact = useQuery({
    queryKey: ['generation-journal', 'artifact', id],
    queryFn: async () => (await journalStore.getArtifact(id)) ?? null,
  })
  if (artifact.isPending) return <EvidenceSkeleton />
  if (artifact.isError) return <ErrorPanel error={artifact.error} onRetry={() => void artifact.refetch()} />
  if (!artifact.data) return <EmptyState icon={FileSearch} title="Saved file missing" description="Import the complete journal bundle to restore this file." action={<Button type="button" variant="outline" onClick={() => void artifact.refetch()}>Check again</Button>} />
  return <ArtifactBody artifact={artifact.data} />
}

export function GenerationOutput({ run }: { run: GenerationRecord }) {
  return <div className="flex min-w-0 flex-col gap-3">
    {run.outputArtifactId && <ArtifactView id={run.outputArtifactId} />}
    {run.output !== undefined && <Payload value={typeof run.output === 'string' ? run.output : JSON.stringify(run.output, null, 2)} />}
    {!run.outputArtifactId && run.output === undefined && <p className="text-muted-foreground">{run.status === 'running' ? 'Waiting for output.' : 'No normalized output was saved. Inspect the raw response below.'}</p>}
  </div>
}

export function ArtifactInventory({ id }: { id: string }) {
  const artifacts = useQuery({ queryKey: ['generation-journal', 'artifacts', id], queryFn: () => journalStore.getArtifacts(id) })
  const [opened, setOpened] = useState<string[]>([])
  if (artifacts.isPending) return <EvidenceSkeleton />
  if (artifacts.isError) return <ErrorPanel error={artifacts.error} onRetry={() => void artifacts.refetch()} />
  if (!artifacts.data.length) return <p className="text-muted-foreground">No files recorded.</p>
  return <ul className="flex min-w-0 flex-col divide-y">
    {artifacts.data.map((artifact) => <li key={artifact.id} className="flex min-w-0 flex-col gap-3 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1"><p className="break-all font-medium">{artifact.name}</p><p className="break-all text-sm text-muted-foreground">{artifact.mime}, {artifact.size.toLocaleString()} bytes</p></div>
        <Button type="button" variant="outline" aria-expanded={opened.includes(artifact.id)} onClick={() => setOpened((current) => current.includes(artifact.id) ? current.filter((item) => item !== artifact.id) : [...current, artifact.id])}>{opened.includes(artifact.id) ? 'Hide file' : 'Inspect file'}</Button>
      </div>
      {opened.includes(artifact.id) && <ArtifactView id={artifact.id} />}
    </li>)}
  </ul>
}

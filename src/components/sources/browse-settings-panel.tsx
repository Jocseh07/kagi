/**
 * The Browse tab: what the source list offers, in the same shape as the
 * Appearance and Library tabs.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useDatabaseReady } from '@/lib/db/provider'
import { getFlag, setFlag } from '@/lib/db/repositories'
import {
  SETTING_HIDE_ADULT_SOURCES,
  hideAdultSourcesQueryKey,
} from '@/lib/sources/adult'

export function BrowseSettingsPanel() {
  const ready = useDatabaseReady()
  const queryClient = useQueryClient()

  const stored = useQuery({
    queryKey: hideAdultSourcesQueryKey,
    queryFn: () => getFlag(SETTING_HIDE_ADULT_SOURCES),
    enabled: ready,
    staleTime: Infinity,
  })

  const save = useMutation({
    mutationFn: (hide: boolean) => setFlag(SETTING_HIDE_ADULT_SOURCES, hide),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: hideAdultSourcesQueryKey }),
  })

  // The refetch confirming the write lags the press, so show the press.
  const hidden = save.isPending ? save.variables : (stored.data ?? false)

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-baseline gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Browse</h2>
      </header>

      <div className="divide-y divide-border">
        <div className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label htmlFor="show-adult-sources" className="font-normal">
              Show 18+ sources
            </Label>
            <p className="text-xs text-muted-foreground">
              Sources that carry adult work.
            </p>
            {save.isError && (
              <p className="text-xs text-destructive">
                Could not save that: {save.error.message}
              </p>
            )}
          </div>
          <div className="shrink-0">
            <Switch
              id="show-adult-sources"
              checked={!hidden}
              disabled={!ready || save.isPending}
              onCheckedChange={(checked) => save.mutate(!checked)}
            />
          </div>
        </div>
      </div>
    </section>
  )
}

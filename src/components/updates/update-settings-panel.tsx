import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { listCategories } from '@/lib/db/categories'
import { useDatabase } from '@/lib/db/provider'
import { dbKeys } from '@/lib/db/query-keys'
import {
  DEFAULT_UPDATE_PREFS,
  UPDATE_INTERVALS,
  loadUpdatePrefs,
  saveUpdatePrefs,
  updatePrefsQueryKey,
} from '@/lib/updates/update-manager'
import type {
  UpdateIntervalHours,
  UpdatePrefs,
  UpdateSkipRules,
} from '@/lib/updates/update-manager'

const ALL_CATEGORIES = 'all'

const SKIP_RULES: {
  key: keyof UpdateSkipRules
  title: string
  summary: string
}[] = [
  {
    key: 'withUnread',
    title: 'Skip entries with unread chapters',
    summary:
      'A series you are already behind on is not waiting on a check to give you something to read.',
  },
  {
    key: 'notStarted',
    title: 'Skip entries you have not started',
    summary:
      'Nothing has been opened, so the chapters already stored are new enough.',
  },
  {
    key: 'completed',
    title: 'Skip completed entries',
    summary: 'The source says the series has finished, so there is nothing to find.',
  },
]

export function UpdateSettingsPanel() {
  const { status } = useDatabase()
  const ready = status === 'ready'
  const queryClient = useQueryClient()

  const prefs = useQuery({
    queryKey: updatePrefsQueryKey,
    queryFn: loadUpdatePrefs,
    enabled: ready,
    staleTime: 0,
  })

  const categories = useQuery({
    queryKey: dbKeys.categories,
    queryFn: listCategories,
    enabled: ready,
    staleTime: 0,
  })

  const save = useMutation({
    mutationFn: (patch: Partial<UpdatePrefs>) => saveUpdatePrefs(patch),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: updatePrefsQueryKey }),
  })

  // The refetch that confirms a write lags the click, so an in-flight change
  // is shown as if it had already landed.
  const current: UpdatePrefs = {
    ...(prefs.data ?? DEFAULT_UPDATE_PREFS),
    ...(save.isPending ? save.variables : {}),
  }
  const disabled = !ready || prefs.isPending

  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="text-sm font-medium">Updates</h2>
        <span className="text-xs text-muted-foreground">
          Used by the check on the Updates page
        </span>
      </header>

      <div className="divide-y divide-border">
        <div className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label htmlFor="updates-interval" className="font-normal">
              Remind me to check
            </Label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Flags the Updates page when the last check is older than this.
              Nothing runs until you start it.
            </p>
          </div>
          <div className="shrink-0">
            <Select
              value={String(current.intervalHours)}
              disabled={disabled}
              onValueChange={(value) =>
                save.mutate({ intervalHours: intervalOf(value) })
              }
            >
              <SelectTrigger id="updates-interval" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UPDATE_INTERVALS.map((hours) => (
                  <SelectItem key={hours} value={String(hours)}>
                    {intervalLabel(hours)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center gap-4 px-4 py-3">
          <div className="min-w-0 flex-1 space-y-0.5">
            <Label htmlFor="updates-category" className="font-normal">
              Categories to check
            </Label>
            <p className="text-xs text-muted-foreground">
              Narrowing this is the cheapest way to keep a check short.
            </p>
          </div>
          <div className="shrink-0">
            <Select
              value={current.categoryId ?? ALL_CATEGORIES}
              disabled={disabled || categories.isPending}
              onValueChange={(value) =>
                save.mutate({
                  categoryId: value === ALL_CATEGORIES ? null : value,
                })
              }
            >
              <SelectTrigger id="updates-category" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CATEGORIES}>All categories</SelectItem>
                {(categories.data ?? []).map((category) => (
                  <SelectItem key={category.id} value={category.id}>
                    {category.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {SKIP_RULES.map((rule) => (
          <div key={rule.key} className="flex items-center gap-4 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-0.5">
              <Label htmlFor={`updates-${rule.key}`} className="font-normal">
                {rule.title}
              </Label>
              <p className="text-xs text-muted-foreground">{rule.summary}</p>
            </div>
            <div className="shrink-0">
              <Switch
                id={`updates-${rule.key}`}
                checked={current.rules[rule.key]}
                disabled={disabled}
                onCheckedChange={(checked) =>
                  save.mutate({
                    rules: { ...current.rules, [rule.key]: checked === true },
                  })
                }
              />
            </div>
          </div>
        ))}
      </div>

      {save.isError && (
        <p className="px-4 pb-3 text-xs text-destructive">
          Could not save: {save.error.message}
        </p>
      )}
    </section>
  )
}

function intervalLabel(hours: UpdateIntervalHours): string {
  if (hours === 0) return 'Never'
  if (hours === 168) return 'Weekly'
  if (hours === 24) return 'Daily'
  return `Every ${hours} hours`
}

function intervalOf(value: string): UpdateIntervalHours {
  const parsed = Number.parseInt(value, 10)
  const match = UPDATE_INTERVALS.find((hours) => hours === parsed)
  return match ?? DEFAULT_UPDATE_PREFS.intervalHours
}

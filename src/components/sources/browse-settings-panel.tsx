/**
 * The Browse tab: what the source list offers, and which sources the 18+
 * switch takes out of it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { SettingRow, SettingsGroup } from '@/components/settings/settings-group'
import { ContentRatingBadge } from '@/components/sources/content-rating-badge'
import { Switch } from '@/components/ui/switch'
import { useDatabaseReady } from '@/lib/db/provider'
import { getFlag, setFlag } from '@/lib/db/repositories'
import {
  SETTING_HIDE_ADULT_SOURCES,
  hideAdultSourcesQueryKey,
} from '@/lib/sources/adult'
import { listSources } from '@/lib/sources/registry'
import { isAdultRated, kindOf } from '@/lib/sources/types'
import { describeError } from '@/lib/ui/describe-error'

const ALL_SOURCES = listSources()
const TOTAL = ALL_SOURCES.length

/** Adult catalogues first, then comics before novels, then by name. */
const RATED = ALL_SOURCES.filter(isAdultRated).sort(
  (a, b) =>
    Number(b.contentRating === 'adult') - Number(a.contentRating === 'adult') ||
    kindOf(a).localeCompare(kindOf(b)) ||
    a.name.localeCompare(b.name),
)

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
    <>
      <SettingsGroup title="Sources">
        <SettingRow
          id="show-adult-sources"
          inline
          label="Show 18+ sources"
          hint={
            save.isError ? (
              <span className="text-destructive">
                Could not save that. {describeError(save.error)}
              </span>
            ) : (
              'Only the Browse list changes. Your library, history and search stay as they are.'
            )
          }
          control={
            <Switch
              id="show-adult-sources"
              checked={!hidden}
              disabled={!ready || save.isPending}
              onCheckedChange={(checked) => save.mutate(!checked)}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup
        title="Rated sources"
        description={`${RATED.length} of ${TOTAL} sources carry adult work. These leave Browse when the switch is off.`}
      >
        <ul className="grid divide-y divide-border @xl:grid-cols-2 @xl:gap-x-4 @xl:divide-y-0 @xl:px-4 @xl:py-1">
          {RATED.map((source) => (
            <li
              key={source.id}
              className="flex h-11 items-center gap-3 px-4 @xl:px-0"
            >
              <span className="min-w-0 flex-1 truncate text-sm">{source.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {kindOf(source) === 'novel' ? 'Novels' : 'Comics'}
              </span>
              <ContentRatingBadge rating={source.contentRating} />
            </li>
          ))}
        </ul>
      </SettingsGroup>
    </>
  )
}

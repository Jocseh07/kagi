import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { applyStyle, removeAdaptation } from '@/lib/adapt/pipeline'
import type { StyleScope } from '@/lib/adapt/pipeline'
import { updateAdaptation } from '@/lib/adapt/store'
import type { Adaptation, MangaChapter } from '@/lib/adapt/store'
import { notify } from '@/lib/ui/toast'
import { describeError } from '@/lib/ui/describe-error'

import { StylePicker } from './style-picker'

function scopeValue(scope: StyleScope): string {
  return typeof scope === 'number' ? `from-${scope}` : scope
}

function parseScope(value: string): StyleScope {
  return value.startsWith('from-') ? Number(value.slice(5)) : value === 'all' ? 'all' : 'new'
}

export function StyleTab({ adaptation, chapters }: { adaptation: Adaptation; chapters: readonly MangaChapter[] }) {
  const navigate = useNavigate()
  const [style, setStyle] = useState(adaptation.style)
  const [notes, setNotes] = useState(adaptation.styleNotes)
  const [scope, setScope] = useState<StyleScope>('new')
  const [confirming, setConfirming] = useState(false)

  const drawn = chapters.filter((chapter) => chapter.status === 'drawn')
  const affected = scope === 'new' ? [] : drawn.filter((chapter) => chapter.number >= (scope === 'all' ? 1 : scope))
  const pages = affected.reduce((sum, chapter) => sum + chapter.pageCount, 0)

  const save = useMutation({
    mutationFn: () => applyStyle(adaptation.id, style, notes, scope),
    onSuccess: () => {
      setScope('new')
      notify.success(affected.length ? `Style saved. Redrawing ${pages} pages.` : 'Style saved')
    },
  })
  const remove = useMutation({
    mutationFn: () => removeAdaptation(adaptation.id),
    onSuccess: () => void navigate({ to: '/library' }),
  })
  const checks = useMutation({
    mutationFn: (on: boolean) => updateAdaptation(adaptation.id, { checkPanels: on }),
  })

  const dirty = style !== adaptation.style || notes.trim() !== adaptation.styleNotes || scope !== 'new'
  const description =
    scope === 'new'
      ? 'Chapters already drawn keep their style.'
      : `Redraws ${pages} ${pages === 1 ? 'page' : 'pages'} in ${affected.length} ${affected.length === 1 ? 'chapter' : 'chapters'}${scope === 'all' ? ' and every sheet' : ''}. Storyboards stay.`

  return (
    <div className="flex max-w-xl flex-col gap-page">
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault()
          if (dirty) save.mutate()
        }}
      >
        <fieldset disabled={save.isPending} className="min-w-0">
          <FieldGroup>
            <Field>
              <FieldLabel>Art style</FieldLabel>
              <StylePicker value={style} onChange={setStyle} />
            </Field>
            <Field>
              <FieldLabel htmlFor="style-notes">Style notes</FieldLabel>
              <Textarea
                id="style-notes"
                rows={3}
                placeholder="Heavy screentone at night"
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="style-apply">Apply to</FieldLabel>
              <NativeSelect id="style-apply" className="w-full" value={scopeValue(scope)} onChange={(event) => setScope(parseScope(event.target.value))}>
                <NativeSelectOption value="new">Chapters not drawn yet</NativeSelectOption>
                {drawn.length ? <NativeSelectOption value="all">Redraw sheets and every chapter</NativeSelectOption> : null}
                {drawn.slice(1).map((chapter) => (
                  <NativeSelectOption key={chapter.id} value={`from-${chapter.number}`}>
                    Redraw from chapter {chapter.number}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription className="tabular-nums">{description}</FieldDescription>
            </Field>
          </FieldGroup>
        </fieldset>
        {save.isError ? <p className="text-sm text-destructive">Could not save. {describeError(save.error)}</p> : null}
        <Button type="submit" className="w-fit" disabled={!dirty || save.isPending}>
          {save.isPending ? <Spinner data-icon="inline-start" /> : null}
          Save style
        </Button>
      </form>

      <Field orientation="horizontal">
        <Switch
          id="check-panels"
          checked={checks.isPending ? checks.variables : adaptation.checkPanels}
          disabled={checks.isPending}
          onCheckedChange={(on) => checks.mutate(on)}
        />
        <FieldContent>
          <FieldLabel htmlFor="check-panels">Check every panel</FieldLabel>
          <FieldDescription>
            {checks.isError ? (
              <span className="text-destructive">Could not save. {describeError(checks.error)}</span>
            ) : (
              'Redraws panels that miss their sheet. Doubles text calls.'
            )}
          </FieldDescription>
        </FieldContent>
      </Field>

      <section className="flex flex-col items-start gap-2 border-t border-border pt-6">
        <p className="text-sm font-medium">Delete adaptation</p>
        <p className="text-sm text-muted-foreground">Removes its sheets and pages, and takes it out of your library.</p>
        <Button variant="destructive" onClick={() => setConfirming(true)}>
          <Trash2 data-icon="inline-start" />
          Delete adaptation
        </Button>
      </section>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Delete ${adaptation.title}?`}
        description="Its generation history is deleted too. You can’t undo this."
        confirmLabel="Delete"
        busyLabel="Deleting…"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  )
}

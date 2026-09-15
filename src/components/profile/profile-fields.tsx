/**
 * The profile form, shared by the welcome flow and the profile dialog.
 *
 * One component rather than two so the two screens cannot drift: the welcome
 * asks for exactly what the dialog later edits. It owns no storage — the caller
 * decides when a draft becomes a saved profile.
 */

import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ACCENTS, accentClass } from '@/components/profile/avatar-accent'
import { initialsOf } from '@/lib/profile/store'
import { cn } from '@/lib/utils'

export type ProfileDraft = {
  name: string
  email: string
  accent: string
}

type ProfileFieldsProps = {
  value: ProfileDraft
  onChange: (next: ProfileDraft) => void
  /** Where the fields sit under the preview instead of beside it. */
  layout?: 'stacked' | 'inline'
}

export function ProfileFields({ value, onChange, layout = 'inline' }: ProfileFieldsProps) {
  const initials = initialsOf(value.name)

  return (
    <div className="flex flex-col gap-4">
      <div
        className={cn(
          'flex gap-4',
          layout === 'inline' ? 'flex-col sm:flex-row sm:items-center' : 'flex-col items-center',
        )}
      >
        {/* Sized well above the header's own avatar: this is the one moment the
            user is deciding what it looks like, so it should read as the
            subject of the screen rather than as a field decoration. */}
        <Avatar size="lg" className="size-16 shrink-0">
          <AvatarFallback className={cn('text-xl font-medium', accentClass(value.accent))}>
            {initials}
          </AvatarFallback>
        </Avatar>

        <div className="flex min-w-0 flex-col gap-2">
          <Label htmlFor="profile-accent-group">Avatar colour</Label>
          <div
            id="profile-accent-group"
            role="radiogroup"
            aria-label="Avatar colour"
            className="flex flex-wrap gap-2"
          >
            {ACCENTS.map((accent) => {
              const active = accent.id === value.accent
              return (
                <button
                  key={accent.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={accent.label}
                  title={accent.label}
                  onClick={() => onChange({ ...value, accent: accent.id })}
                  className={cn(
                    'size-7 rounded-full ring-offset-2 ring-offset-background outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-6',
                    accent.className,
                    active && 'ring-2 ring-ring',
                  )}
                />
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="profile-name">Name</Label>
        <Input
          id="profile-name"
          name="name"
          value={value.name}
          autoComplete="name"
          placeholder="Your name"
          onChange={(event) => onChange({ ...value, name: event.target.value })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="profile-email">
          Email
          <span className="text-xs font-normal text-muted-foreground">Optional</span>
        </Label>
        <Input
          id="profile-email"
          name="email"
          type="email"
          value={value.email}
          autoComplete="email"
          placeholder="you@example.com"
          onChange={(event) => onChange({ ...value, email: event.target.value })}
        />
        <p className="text-xs text-muted-foreground">
          Shown beside your name. Nothing is sent anywhere — this browser is the
          only place it is kept, separate from any account you sign in with.
        </p>
      </div>
    </div>
  )
}

/**
 * Who is using this browser.
 *
 * The app has no sign-in, so this is a local identity rather than an account:
 * a name to greet, an optional email, and an avatar accent. It lives in
 * localStorage beside the theme rather than in the database because the header
 * renders before the database is ready, and a profile that arrives a beat later
 * would flash a placeholder avatar on every single load.
 */

export const PROFILE_KEY = 'kagi:profile'

export type Profile = {
  name: string
  email: string
  accent: string
  createdAt: number
}

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null
  } catch {
    // Private-mode storage refusal; treat as nothing stored.
    return null
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // The profile is already in memory for this session; only its persistence
    // is lost, which means the welcome runs again next time.
  }
}

function remove(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    // As above.
  }
}

/**
 * Up to two letters, taken from the first and last word.
 *
 * Derived rather than stored: a saved copy would be one more thing to keep in
 * step with the name, and it is a cheap string operation on a value that only
 * changes when the user types.
 */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return '?'

  const first = words[0]?.[0] ?? ''
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : ''
  return (first + last).toUpperCase()
}

export function readProfile(): Profile | null {
  const raw = read(PROFILE_KEY)
  if (!raw) return null

  try {
    const parsed = JSON.parse(raw) as Partial<Profile>
    // A profile without a name cannot greet anyone, so it counts as no profile
    // and the welcome runs again rather than saying hello to an empty string.
    if (typeof parsed?.name !== 'string' || parsed.name.trim() === '') return null

    return {
      name: parsed.name,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      accent: typeof parsed.accent === 'string' ? parsed.accent : 'blue',
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
    }
  } catch {
    return null
  }
}

export function writeProfile(profile: Profile): void {
  write(PROFILE_KEY, JSON.stringify(profile))
}

export function clearProfile(): void {
  remove(PROFILE_KEY)
}

export function hasProfile(): boolean {
  return readProfile() !== null
}

/**
 * Whether the welcome has been completed at all — by saving a local profile
 * *or* by signing in and skipping one.
 *
 * A separate marker rather than inferring from the profile, because the
 * signed-in path deliberately creates no profile: without this flag the index
 * redirect would see "no profile" and bounce a signed-in user back into the
 * welcome on every visit. Synchronous localStorage, same as the profile, so
 * the route guards can read it before first paint.
 */
export const ONBOARDED_KEY = 'kagi:onboarded'

export function markOnboarded(): void {
  write(ONBOARDED_KEY, '1')
}

export function hasOnboarded(): boolean {
  return read(ONBOARDED_KEY) !== null
}

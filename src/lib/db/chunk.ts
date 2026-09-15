/**
 * Rows per multi-row statement.
 *
 * The widest of them is the chapter upsert: drizzle materialises the columns
 * that have defaults, so a row binds thirteen parameters. Seventy rows plus the
 * conflict clause is 912, inside SQLite's 999-parameter limit on older builds
 * and far inside the 32766 of modern ones.
 *
 * Kept in a module of its own rather than beside the repositories that use it:
 * `queue-repository` needs only these two, and reaching them through
 * `repositories.ts` pulled that module — and everything it imports — into the
 * app shell.
 */
export const CHUNK_SIZE = 70

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = []
  for (let start = 0; start < items.length; start += size) {
    groups.push(items.slice(start, start + size))
  }
  return groups
}

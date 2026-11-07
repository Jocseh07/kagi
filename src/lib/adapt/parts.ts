/** A half-open range `[from, to)`: character offsets for beats, beat indexes for the storyboard. */
export interface Span {
  from: number
  to: number
}

export interface PartProgress extends Span {
  /** 1-based. */
  index: number
  /** Grows when a part is split. */
  total: number
}

/** A part used every try and still fails validation; the runner splits it or gives up. */
export class PartFailedError extends Error {
  readonly errors: string[]

  constructor(errors: string[]) {
    super(errors.join('; '))
    this.name = 'PartFailedError'
    this.errors = errors
  }
}

export interface RunPartsOptions<R extends Span> {
  /** Parts saved by an earlier run; one is reused when it starts where a pending part starts and fits inside it. */
  saved?: readonly R[]
  /** Where to split a failed part in two, or `undefined` once it is too small to split. */
  cut: (span: Span) => number | undefined
  /** The error to throw when a part that cannot be split fails. */
  fail: (progress: PartProgress, error: PartFailedError) => Error
  onSection?: (progress: PartProgress) => void
  onPart?: (part: R, done: readonly R[]) => void | Promise<void>
}

/** Writes parts in order; a part that fails is split in half and each half written on its own. */
export async function runParts<R extends Span>(
  initial: readonly Span[],
  write: (span: Span, done: readonly R[]) => Promise<R>,
  options: RunPartsOptions<R>,
): Promise<R[]> {
  const queue = [...initial]
  const done: R[] = []
  while (queue.length) {
    const span = queue.shift()!
    const reused = options.saved?.find((part) => part.from === span.from && part.to > part.from && part.to <= span.to)
    if (reused) {
      done.push(reused)
      if (reused.to < span.to) queue.unshift({ from: reused.to, to: span.to })
      continue
    }
    const progress = { ...span, index: done.length + 1, total: done.length + queue.length + 1 }
    options.onSection?.(progress)
    try {
      const part = await write(span, done)
      done.push(part)
      await options.onPart?.(part, done)
    } catch (error) {
      if (!(error instanceof PartFailedError)) throw error
      const middle = options.cut(span)
      if (middle === undefined || middle <= span.from || middle >= span.to) throw options.fail(progress, error)
      queue.unshift({ from: span.from, to: middle }, { from: middle, to: span.to })
    }
  }
  return done
}

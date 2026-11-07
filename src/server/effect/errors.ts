import * as Effect from 'effect/Effect'

import { AppError } from '../errors'

/** Whatever was thrown, as the one error type the failure channel carries. */
export function toAppError(cause: unknown, fallback: string): AppError {
  if (cause instanceof AppError) return cause
  console.error(fallback, cause)
  return new AppError(500, fallback)
}

/** A promise-returning call, with its rejection mapped to an `AppError`. */
export function attempt<A>(
  run: () => Promise<A>,
  fallback = 'Something went wrong. Try again.',
): Effect.Effect<A, AppError> {
  return Effect.tryPromise({ try: run, catch: (cause) => toAppError(cause, fallback) })
}

export const fail = (status: number, message: string): Effect.Effect<never, AppError> =>
  Effect.fail(new AppError(status, message))

/** A sync helper that may throw, with the throw carried as an `AppError`. */
export const sync = <A>(run: () => A): Effect.Effect<A, AppError> =>
  Effect.try({
    try: run,
    catch: (cause) => toAppError(cause, 'Something went wrong. Try again.'),
  })

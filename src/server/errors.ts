/**
 * Deliberately free of any Worker import.
 *
 * Route handlers and the sync protocol validators throw these, and the
 * validators are compiled into the client bundle as well as the Worker.
 * Keeping the error out of effect/env.ts is what stops the Worker-only
 * bindings module being dragged into the browser bundle behind it.
 */
export class AppError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'AppError'
    this.status = status
  }
}

/** Turns a thrown `AppError` into the response, and anything else into a 500. */
export function respondTo(error: unknown): Response {
  const status = error instanceof AppError ? error.status : 500
  const message = error instanceof AppError ? error.message : 'Unexpected sync failure.'
  return Response.json({ error: message }, { status })
}

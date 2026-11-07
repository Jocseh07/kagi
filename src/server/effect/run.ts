/**
 * The one boundary between Effect and the promise a route handler returns.
 *
 * An `AppError` in the failure channel is rethrown as the same instance, so
 * its status and message cross the wire exactly as before — `respondTo` in
 * server/errors.ts turns it into the response. Anything else is a defect:
 * logged in full here and answered with a sentence that says nothing.
 */

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import { AppError } from '../errors'
import { Auth } from './auth'
import { Billing } from './billing'
import { Database } from './database'
import { Env } from './env'
import { RateLimits } from './rate-limits'

export type AppServices = Env | Database | Auth | Billing | RateLimits

export const AppLayer = Layer.mergeAll(
  Env.layer,
  Database.layer,
  Auth.layer,
  Billing.layer,
  RateLimits.layer,
)

export async function runServer<A>(
  effect: Effect.Effect<A, AppError, AppServices>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect.pipe(Effect.provide(AppLayer)))
  if (Exit.isSuccess(exit)) return exit.value
  const failure = Cause.findErrorOption(exit.cause)
  if (Option.isSome(failure)) throw failure.value
  // A sync helper that threw an AppError inside a generator is a defect to
  // Effect but a refusal to the caller, so its status still crosses the wire.
  const defect = Cause.squash(exit.cause)
  if (defect instanceof AppError) throw defect
  console.error('server defect', Cause.pretty(exit.cause))
  throw new Error('Something went wrong. Try again.')
}

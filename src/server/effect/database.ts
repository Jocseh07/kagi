import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { drizzle } from 'drizzle-orm/d1'
import type { DrizzleD1Database } from 'drizzle-orm/d1'

import { syncSchema } from '@/lib/db/sync-schema'
import { AppError } from '../errors'
import { Env } from './env'
import { toAppError } from './errors'

export type SyncDb = DrizzleD1Database<typeof syncSchema>

export interface DatabaseShape {
  /** The drizzle client. Prefer `query`, which types the failure. */
  readonly client: Effect.Effect<SyncDb, AppError>
  /** One or more drizzle calls, with any rejection mapped to a 500. */
  readonly query: <A>(run: (client: SyncDb) => Promise<A>) => Effect.Effect<A, AppError>
}

export class Database extends Context.Service<Database, DatabaseShape>()('kagi/Database') {
  static readonly layer = Layer.effect(
    Database,
    Effect.gen(function* () {
      const env = yield* Env

      const client = Effect.suspend(() => {
        const { DB } = env
        if (!DB) return Effect.fail(new AppError(500, 'D1 binding DB is missing.'))
        // Cast because drizzle types the client against the ambient
        // workers-types globals, which this project deliberately does not
        // install. The runtime object is the same D1 binding either way.
        return Effect.succeed(drizzle(DB as never, { schema: syncSchema }))
      })

      const query = <A>(run: (client: SyncDb) => Promise<A>) =>
        Effect.flatMap(client, (c) =>
          Effect.tryPromise({
            try: () => run(c),
            catch: (cause) => toAppError(cause, 'The database is not available. Try again.'),
          }),
        )

      return { client, query } satisfies DatabaseShape
    }),
  ).pipe(Layer.provide(Env.layer))
}

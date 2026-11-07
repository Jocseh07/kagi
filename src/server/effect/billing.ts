/**
 * The Polar wiring, from env. Read here and nowhere else, so the names have
 * one home.
 */

import { Polar } from '@polar-sh/sdk'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'

import { AppError } from '../errors'
import { Env } from './env'

export interface PolarConfig {
  server: 'sandbox' | 'production'
  accessToken: string | null
  webhookSecret: string | null
  /** The Sync plan's product id. */
  productId: string | null
}

export interface BillingShape {
  readonly config: Effect.Effect<PolarConfig>
  readonly client: Effect.Effect<Polar, AppError>
  /** The webhook signing secret, or a 500 for a deployment that has none. */
  readonly webhookSecret: Effect.Effect<string, AppError>
  readonly productId: Effect.Effect<string, AppError>
}

export class Billing extends Context.Service<Billing, BillingShape>()('kagi/Billing') {
  static readonly layer = Layer.effect(
    Billing,
    Effect.gen(function* () {
      const env = yield* Env

      const config = Effect.sync(
        (): PolarConfig => ({
          server: env.POLAR_SERVER === 'sandbox' ? 'sandbox' : 'production',
          accessToken: env.POLAR_ACCESS_TOKEN ?? null,
          webhookSecret: env.POLAR_WEBHOOK_SECRET ?? null,
          productId: env.POLAR_PRODUCT_ID ?? null,
        }),
      )

      const client = Effect.flatMap(config, (c) =>
        c.accessToken
          ? Effect.succeed(new Polar({ accessToken: c.accessToken, server: c.server }))
          : Effect.fail(new AppError(500, 'Polar is not configured on this deployment.')),
      )

      const webhookSecret = Effect.flatMap(config, (c) =>
        c.webhookSecret
          ? Effect.succeed(c.webhookSecret)
          : Effect.fail(new AppError(500, 'POLAR_WEBHOOK_SECRET is unset.')),
      )

      const productId = Effect.flatMap(config, (c) =>
        c.productId
          ? Effect.succeed(c.productId)
          : Effect.fail(new AppError(500, 'POLAR_PRODUCT_ID is unset.')),
      )

      return { config, client, webhookSecret, productId } satisfies BillingShape
    }),
  ).pipe(Layer.provide(Env.layer))
}

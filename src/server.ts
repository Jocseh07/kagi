import * as Sentry from '@sentry/cloudflare'
import handler from '@tanstack/react-start/server-entry'

interface SentryEnv {
  SENTRY_DSN?: string
}

export default Sentry.withSentry<SentryEnv>(
  (env: SentryEnv | undefined) => ({
    dsn: env?.SENTRY_DSN || undefined,
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
  }),
  { fetch: handler.fetch },
)

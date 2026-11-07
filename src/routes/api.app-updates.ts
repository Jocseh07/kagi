import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/app-updates')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const [{ serveExpoUpdate }, { runServer }] = await Promise.all([
          import('@/server/app-update'),
          import('@/server/effect/run'),
        ])
        return runServer(serveExpoUpdate(request))
      },
    },
  },
})

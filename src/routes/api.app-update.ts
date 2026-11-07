import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/app-update')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const [{ serveUpdateCheck }, { runServer }] = await Promise.all([
          import('@/server/app-update'),
          import('@/server/effect/run'),
        ])
        return runServer(serveUpdateCheck(request))
      },
    },
  },
})

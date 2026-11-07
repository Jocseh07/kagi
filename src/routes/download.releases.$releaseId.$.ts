import { createFileRoute } from '@tanstack/react-router'

async function download({ request, params }: { request: Request; params: { releaseId: string; _splat?: string } }) {
  const [{ serveReleaseArtifact }, { runServer }] = await Promise.all([
    import('@/server/app-update'),
    import('@/server/effect/run'),
  ])
  return runServer(serveReleaseArtifact(request, params.releaseId, params._splat ?? ''))
}

export const Route = createFileRoute('/download/releases/$releaseId/$')({
  server: { handlers: { GET: download, HEAD: download } },
})

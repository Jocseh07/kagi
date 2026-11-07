import { Link } from '@tanstack/react-router'
import { Sparkles } from 'lucide-react'

import { mangaSlug } from '@/components/manga-grid'
import { MangaActionButton } from '@/components/manga/manga-action-row'
import { supportsAdaptations } from '@/lib/adapt/store'
import { useAdaptationForNovel } from '@/lib/adapt/use-adaptation'
import { ADAPTED_SOURCE_ID } from '@/lib/sources/adapted'
import type { SManga } from '@/lib/sources/types'

export function AdaptAction({
  sourceId,
  novel,
  chapterCount,
}: {
  sourceId: string
  novel: SManga
  chapterCount: number
}) {
  const existing = useAdaptationForNovel(sourceId, novel.url)

  if (!supportsAdaptations()) return null

  if (existing.data) {
    return (
      <MangaActionButton asChild icon={Sparkles} label="Adaptation" active>
        <Link to="/manga/$sourceId/$slug" params={{ sourceId: ADAPTED_SOURCE_ID, slug: existing.data.id }}>
          <Sparkles className="size-5 sm:size-4" />
          Adaptation
        </Link>
      </MangaActionButton>
    )
  }

  if (chapterCount === 0) {
    return <MangaActionButton icon={Sparkles} label="Adapt" disabled />
  }

  return (
    <MangaActionButton asChild icon={Sparkles} label="Adapt">
      <Link to="/adapt/start/$sourceId/$slug" params={{ sourceId, slug: mangaSlug(novel) }}>
        <Sparkles className="size-5 sm:size-4" />
        Adapt
      </Link>
    </MangaActionButton>
  )
}

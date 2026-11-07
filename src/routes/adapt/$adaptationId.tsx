import { createFileRoute, redirect } from '@tanstack/react-router'

import { ADAPTED_SOURCE_ID } from '@/lib/sources/adapted'

/** The adaptation lives on its series page now; old links land there. */
export const Route = createFileRoute('/adapt/$adaptationId')({
  beforeLoad: ({ params, search }) => {
    const { tab, chapter, who, item } = search as Record<string, unknown>
    throw redirect({
      to: '/manga/$sourceId/$slug',
      params: { sourceId: ADAPTED_SOURCE_ID, slug: params.adaptationId },
      search: {
        tab: tab === 'chapters' ? 'progress' : tab,
        chapter,
        who,
        item,
      } as Record<string, unknown>,
      replace: true,
    })
  },
})

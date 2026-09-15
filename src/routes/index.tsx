import { createFileRoute, redirect } from '@tanstack/react-router'

import { isOnline } from '@/lib/offline/use-online'
import { hasOnboarded, hasProfile } from '@/lib/profile/store'

export const Route = createFileRoute('/')({
  beforeLoad: () => {
    // First run lands on the welcome; every run after it goes where it always
    // did. "After it" means a saved local profile *or* the onboarded marker —
    // the signed-in path through the welcome creates no profile. Both are
    // synchronous localStorage reads, so this resolves before the first paint
    // rather than flashing Browse on the way.
    if (!hasProfile() && !hasOnboarded()) throw redirect({ to: '/welcome' })

    // Browse is the one page that cannot work without a source, so opening
    // the app offline lands on the library instead — the part of it that is
    // entirely on the device.
    throw redirect({ to: isOnline() ? '/browse' : '/library' })
  },
})

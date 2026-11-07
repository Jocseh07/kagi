import { useAuth } from '@clerk/expo'

export function useAccountAuth() {
  return useAuth({ treatPendingAsSignedOut: false })
}

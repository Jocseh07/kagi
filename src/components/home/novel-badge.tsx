import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Said only for novels: comics are the default and need no label. */
export function NovelBadge({ className }: { className?: string }) {
  return (
    <Badge variant="secondary" className={cn('shrink-0', className)}>
      Novel
    </Badge>
  )
}

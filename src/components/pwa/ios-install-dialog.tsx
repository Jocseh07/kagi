import { Plus, Share } from 'lucide-react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface IosInstallDialogProps {
  open: boolean
  onOpenChange(open: boolean): void
}

/**
 * The iOS install path, written out, because there is no API to open it.
 *
 * Two steps and nothing else. The icons match the ones on the buttons being
 * described, which is the whole reason this is a panel rather than a sentence.
 *
 * Neither step names Safari or a toolbar position: Chrome and Firefox on iOS
 * can add to the home screen too, but they keep Share behind their overflow
 * menu rather than in the bar.
 */
export function IosInstallDialog({ open, onOpenChange }: IosInstallDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Kagi to your home screen</DialogTitle>
          <DialogDescription>
            Kagi then opens like any other app.
          </DialogDescription>
        </DialogHeader>

        <ol className="space-y-3 text-sm">
          <li className="flex items-center gap-3">
            <Share aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span>Open the Share menu</span>
          </li>
          <li className="flex items-center gap-3">
            <Plus aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span>Choose Add to Home Screen, then tap Add</span>
          </li>
        </ol>
      </DialogContent>
    </Dialog>
  )
}

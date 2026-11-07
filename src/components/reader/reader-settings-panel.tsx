import { SettingsGroup } from '@/components/settings/settings-group'

import { ReaderPreview } from './reader-preview'
import {
  NovelTextRows,
  ReaderBehaviorRows,
  TextResetButton,
} from './reader-settings-controls'

/**
 * Every reader preference, in the one place they are set, with a preview that
 * sits beside the controls once there is room and above them until then.
 */
export function ReaderSettingsPanel() {
  return (
    <div className="@container">
      <div className="grid gap-6 @3xl:grid-cols-[minmax(0,1fr)_17rem] @3xl:items-start">
        <ReaderPreview className="@3xl:sticky @3xl:top-4 @3xl:order-2" />

        <div className="flex min-w-0 flex-col gap-6 @3xl:order-1">
          <SettingsGroup title="Reading" aside="Every series">
            <ReaderBehaviorRows />
          </SettingsGroup>

          <SettingsGroup title="Novel text" aside={<TextResetButton />}>
            <NovelTextRows />
          </SettingsGroup>
        </div>
      </div>
    </div>
  )
}

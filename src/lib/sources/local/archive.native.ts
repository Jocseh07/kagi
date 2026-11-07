/**
 * Archive access for the local source on native, over the app's own ZIP
 * reader rather than zip.js.
 */

import { localFileOf } from '@/lib/storage/native-files'
import { withZip } from '@/lib/storage/zip'

/**
 * One named entry of an archive, as text.
 *
 * Case-insensitive and root-only, as on the web: a `chapter/ComicInfo.xml`
 * nested inside is not the chapter's own metadata. Returns null when the
 * archive has no such entry, which is the common case and stays cheap.
 */
export async function readArchiveEntryText(
  file: File,
  entryName: string,
): Promise<string | null> {
  return withZip(localFileOf(file), (zip) => {
    const entry = zip.find(entryName, true)
    return entry ? zip.readText(entry) : null
  })
}

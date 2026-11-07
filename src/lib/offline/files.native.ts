import { Directory, File, Paths } from 'expo-file-system'

/**
 * Where saved chapter pages live on the device: one folder per chapter id,
 * one file per page index. The save side writes here and the reader reads
 * from here before it goes to the network.
 */
export function pagesRoot(): Directory {
  return new Directory(Paths.document, 'pages')
}

export function chapterDirectory(chapterId: string): Directory {
  return new Directory(pagesRoot(), encodeURIComponent(chapterId))
}

export function pageFile(chapterId: string, index: number): File {
  return new File(chapterDirectory(chapterId), String(index))
}

/** The saved page's file URI, or null when it is not on the device. */
export function savedPageUri(chapterId: string, index: number): string | null {
  const file = pageFile(chapterId, index)
  return file.exists ? file.uri : null
}

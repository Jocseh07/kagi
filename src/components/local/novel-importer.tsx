import { useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BookUp, Library, Trash2 } from 'lucide-react'

import { Panel } from '@/components/local/panel'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { dbKeys } from '@/lib/db/query-keys'
import { LOCAL_NOVEL_SOURCE_ID } from '@/lib/sources/local-novel'
import {
  deleteBook,
  importBooks,
  listBooks,
} from '@/lib/sources/local-novel/shelf'
import { notify } from '@/lib/ui/toast'

const SHELF_KEY = ['local-novel', 'shelf'] as const

/** Books are megabytes, not gigabytes: the download panel's formatter rounds them to "0 MB". */
function megabytes(size: number): string {
  return `${(size / 1_048_576).toFixed(1)} MB`
}

/**
 * Imports EPUB and text files into this browser and lists what is already
 * there.
 *
 * A file input rather than a folder picker, so the novel source works in every
 * browser: `showDirectoryPicker` is Chromium desktop only.
 */
export function NovelImporter({ className }: { className?: string }) {
  const queryClient = useQueryClient()
  const input = useRef<HTMLInputElement>(null)

  const shelf = useQuery({ queryKey: SHELF_KEY, queryFn: listBooks })
  const books = shelf.data ?? []

  async function refresh() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: SHELF_KEY }),
      queryClient.invalidateQueries({ queryKey: dbKeys.storageBreakdown }),
      queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.includes(LOCAL_NOVEL_SOURCE_ID),
      }),
    ])
  }

  const add = useMutation({
    mutationFn: (files: File[]) => importBooks(files),
    onSuccess: async ({ added, rejected }) => {
      if (added.length > 0) {
        notify.success(
          `Imported ${added.length} book${added.length === 1 ? '' : 's'}`,
        )
      }
      if (rejected.length > 0) {
        notify.error('Only .epub and .txt files can be imported')
      }
      await refresh()
    },
    onError: (error) => notify.error('Import failed', error),
  })

  const remove = useMutation({
    mutationFn: (name: string) => deleteBook(name),
    onSuccess: refresh,
    onError: (error) => notify.error('Could not remove that book', error),
  })

  const busy = add.isPending || remove.isPending
  const count = books.length

  return (
    <Panel
      className={className}
      label="Imported books"
      icon={
        count > 0 ? (
          <Library className="size-4" />
        ) : (
          <BookUp className="size-4" />
        )
      }
      title={
        count > 0
          ? `${count} book${count === 1 ? '' : 's'}`
          : 'No books imported'
      }
      actions={
        <>
          <input
            ref={input}
            type="file"
            accept=".epub,.txt,.text"
            multiple
            className="sr-only"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              // Reset first, so re-picking the same file fires again.
              event.target.value = ''
              if (files.length > 0) add.mutate(files)
            }}
          />
          <Button
            size="sm"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            Import books
          </Button>
        </>
      }
    >
      {shelf.isPending ? (
        <span className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-32" />
        </span>
      ) : count === 0 ? (
        'Import EPUB or .txt files to read them here. Nothing is uploaded.'
      ) : (
        <>
          Open them from the Local novels source.
          <span className="mt-1.5 flex flex-col">
            {books.map((book) => (
              <span
                key={book.name}
                className="flex items-center gap-2 border-t border-border py-1"
              >
                <span className="min-w-0 flex-1 truncate">{book.name}</span>
                <span className="shrink-0 tabular-nums">
                  {megabytes(book.size)}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  aria-label={`Remove "${book.name}"`}
                  onClick={() => remove.mutate(book.name)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </span>
            ))}
          </span>
        </>
      )}
    </Panel>
  )
}

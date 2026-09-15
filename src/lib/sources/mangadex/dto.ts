/**
 * The slices of MangaDex's API this source reads.
 *
 * The API is large and versioned; only the fields actually mapped are named
 * here. Everything arrives inside the same envelope, so that is modelled once
 * and reused rather than restated per endpoint.
 */

/** A localised string table. Keys are language codes; `en` is not guaranteed. */
export type LocalizedString = Record<string, string>

export interface Relationship {
  id: string
  type: string
  attributes?: {
    /** Authors, artists and scanlation groups. */
    name?: string
    /** Cover art. Relative to the manga's folder on the upload host. */
    fileName?: string
    /** Cover art. Volume the cover belongs to, as a decimal string. */
    volume?: string | null
  }
}

export interface Collection<T> {
  result: string
  data: T[]
  limit: number
  offset: number
  total: number
}

export interface Entity<T> {
  result: string
  data: T
}

export interface MangaAttributes {
  title: LocalizedString
  altTitles: LocalizedString[]
  description: LocalizedString
  originalLanguage?: string | null
  status?: string | null
  year?: number | null
  contentRating?: string | null
  publicationDemographic?: string | null
  tags: { attributes: { name: LocalizedString } }[]
}

export interface MangaDto {
  id: string
  attributes: MangaAttributes
  relationships: Relationship[]
}

export interface ChapterAttributes {
  volume?: string | null
  chapter?: string | null
  title?: string | null
  translatedLanguage?: string | null
  publishAt?: string | null
  pages?: number | null
  /**
   * Set when the chapter is hosted elsewhere and MangaDex only links to it.
   * Such a chapter has no page list and cannot be opened here.
   */
  externalUrl?: string | null
  isUnavailable?: boolean | null
}

export interface ChapterDto {
  id: string
  attributes: ChapterAttributes
  relationships: Relationship[]
}

/** `/at-home/server/<id>`: where this chapter's images are, for the next while. */
export interface AtHomeResponse {
  result: string
  baseUrl: string
  chapter: {
    hash: string
    data: string[]
    dataSaver: string[]
  }
}

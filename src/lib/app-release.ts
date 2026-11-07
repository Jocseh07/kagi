export interface AppRelease {
  version: string
  versionCode: number
  /** Object key of the APK in the releases bucket. */
  file: string
  size: number
  sha256: string
  publishedAt: string
}

export const APP_RELEASE_PATH = '/api/app/release'
export const ANDROID_DOWNLOAD_PATH = '/download/android'

const SHA256 = /^[0-9a-f]{64}$/

export function parseAppRelease(value: unknown): AppRelease | null {
  if (typeof value !== 'object' || value === null) return null
  const { version, versionCode, file, size, sha256, publishedAt } = value as Record<
    string,
    unknown
  >

  if (typeof version !== 'string' || version === '') return null
  if (typeof versionCode !== 'number' || !Number.isInteger(versionCode) || versionCode < 1) {
    return null
  }
  if (typeof file !== 'string' || file === '') return null
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null
  if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return null
  if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) return null

  return { version, versionCode, file, size, sha256, publishedAt }
}

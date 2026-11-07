export interface Artifact {
  path: string
  sha256: string
  sizeBytes: number
  contentType: string
}

export interface OtaRelease {
  id: string
  runtimeVersion: string
  manifest: Artifact
  signature: string
  sizeBytes: number
}

export interface NativeRelease {
  version: string
  build: number
  runtimeVersion: string
  embeddedUpdateIds: string[]
  ota?: OtaRelease
  apk?: Artifact
  storeUrl?: string
}

export interface ReleaseRecord {
  schemaVersion: 1
  id: string
  createdAt: string
  webSourceSha256: string
  mobileSourceSha256: string
  apiVersion: 1
  draftVersion: 1
  platforms: { android: NativeRelease; ios?: NativeRelease }
  artifacts: Record<string, Artifact>
  withdrawnReleaseIds?: string[]
}

export interface InstalledRelease {
  platform: 'android' | 'ios'
  build: number
  runtimeVersion: string
  updateId: string
  requiredReleaseId?: string
}

export type UpdateResponse =
  | { status: 'latest'; releaseId: string; withdrawnReleaseIds?: string[] }
  | { status: 'update'; releaseId: string; required: true; type: 'ota'; updateId: string; runtimeVersion: string; sizeBytes: number }
  | { status: 'update'; releaseId: string; required: true; type: 'full'; version: string; build: number; runtimeVersion: string; url: string; sizeBytes: number; sha256: string }
  | { status: 'update'; releaseId: string; required: true; type: 'full'; version: string; build: number; runtimeVersion: string; storeUrl: string }

const IDENTIFIER = /^[A-Za-z0-9._-]{1,128}$/
const HASH = /^[a-f0-9]{64}$/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const PATH = /^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,255}$/
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0
export const isReleaseId = (value: unknown): value is string => typeof value === 'string' && IDENTIFIER.test(value) && value !== '.' && value !== '..'
const isRuntime = (value: unknown): value is string => typeof value === 'string' && IDENTIFIER.test(value)

export function isArtifact(value: unknown): value is Artifact {
  return object(value) && typeof value.path === 'string' && PATH.test(value.path)
    && value.path.split('/').every((part) => part !== '.' && part !== '..' && part !== '')
    && typeof value.sha256 === 'string' && HASH.test(value.sha256) && positive(value.sizeBytes)
    && typeof value.contentType === 'string' && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(value.contentType)
}

function isNative(value: unknown, android: boolean): value is NativeRelease {
  if (!object(value) || typeof value.version !== 'string' || !/^[\w.+-]{1,32}$/.test(value.version)
    || !positive(value.build) || !isRuntime(value.runtimeVersion) || !Array.isArray(value.embeddedUpdateIds)
    || !value.embeddedUpdateIds.every((id) => typeof id === 'string' && UUID.test(id))) return false
  if (android && !isArtifact(value.apk)) return false
  if (value.apk !== undefined && !isArtifact(value.apk)) return false
  if (value.storeUrl !== undefined && (typeof value.storeUrl !== 'string' || !/^https:\/\/apps\.apple\.com\/[A-Za-z0-9/?=&._-]+$/.test(value.storeUrl))) return false
  if (value.ota === undefined) return true
  const ota = value.ota
  return object(ota) && typeof ota.id === 'string' && UUID.test(ota.id) && ota.runtimeVersion === value.runtimeVersion
    && isArtifact(ota.manifest) && typeof ota.signature === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(ota.signature)
    && positive(ota.sizeBytes)
}

export function parseReleaseRecord(value: unknown): ReleaseRecord | null {
  if (!object(value) || value.schemaVersion !== 1 || !isReleaseId(value.id)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || typeof value.webSourceSha256 !== 'string' || !HASH.test(value.webSourceSha256)
    || typeof value.mobileSourceSha256 !== 'string' || !HASH.test(value.mobileSourceSha256)
    || value.apiVersion !== 1 || value.draftVersion !== 1 || !object(value.platforms)
    || !isNative(value.platforms.android, true) || (value.platforms.ios !== undefined && !isNative(value.platforms.ios, false))
    || !object(value.artifacts) || Object.keys(value.artifacts).length === 0
    || !Object.entries(value.artifacts).every(([path, artifact]) => isArtifact(artifact) && artifact.path === path)
    || (value.withdrawnReleaseIds !== undefined && (!Array.isArray(value.withdrawnReleaseIds) || !value.withdrawnReleaseIds.every(isReleaseId)))) return null
  const record = value as unknown as ReleaseRecord
  for (const platform of Object.values(record.platforms)) {
    for (const artifact of [platform.apk, platform.ota?.manifest]) {
      if (!artifact) continue
      const declared = record.artifacts[artifact.path]
      if (!declared || declared.sha256 !== artifact.sha256 || declared.sizeBytes !== artifact.sizeBytes || declared.contentType !== artifact.contentType) return null
    }
  }
  return record
}

export function parseInstalledRelease(params: URLSearchParams): InstalledRelease | null {
  const platform = params.get('platform')
  const rawBuild = params.get('build')
  const build = Number(rawBuild)
  const runtimeVersion = params.get('runtimeVersion') ?? ''
  const updateId = params.get('updateId') ?? ''
  const requiredReleaseId = params.get('requiredReleaseId') ?? undefined
  if ((platform !== 'android' && platform !== 'ios') || !rawBuild || !/^\d+$/.test(rawBuild) || !positive(build)
    || (runtimeVersion !== '' && !isRuntime(runtimeVersion)) || (updateId !== '' && !UUID.test(updateId))
    || (requiredReleaseId !== undefined && !isReleaseId(requiredReleaseId))) return null
  return { platform, build, runtimeVersion, updateId, requiredReleaseId }
}

export function resolveUpdate(record: ReleaseRecord, installed: InstalledRelease, origin: string): UpdateResponse | null {
  const target = record.platforms[installed.platform]
  if (!target || installed.build > target.build) return null
  const sameRuntime = installed.runtimeVersion === target.runtimeVersion
  const currentOta = sameRuntime && target.ota?.id === installed.updateId
  const currentEmbedded = sameRuntime && installed.build === target.build && target.embeddedUpdateIds.includes(installed.updateId)
  if (currentOta || currentEmbedded) {
    const withdrawn = installed.requiredReleaseId && record.withdrawnReleaseIds?.includes(installed.requiredReleaseId)
      ? [installed.requiredReleaseId] : undefined
    return { status: 'latest', releaseId: record.id, ...(withdrawn ? { withdrawnReleaseIds: withdrawn } : {}) }
  }
  if (sameRuntime && target.ota) return {
    status: 'update', required: true, type: 'ota', releaseId: record.id,
    updateId: target.ota.id, runtimeVersion: target.runtimeVersion, sizeBytes: target.ota.sizeBytes,
  }
  if (installed.build >= target.build) return null
  if (installed.platform === 'android' && target.apk) return {
    status: 'update', required: true, type: 'full', releaseId: record.id, version: target.version,
    build: target.build, runtimeVersion: target.runtimeVersion,
    url: `${origin}/download/releases/${record.id}/${target.apk.path}`,
    sizeBytes: target.apk.sizeBytes, sha256: target.apk.sha256,
  }
  if (target.storeUrl) return {
    status: 'update', required: true, type: 'full', releaseId: record.id, version: target.version,
    build: target.build, runtimeVersion: target.runtimeVersion, storeUrl: target.storeUrl,
  }
  return null
}

import { spawnSync } from 'node:child_process'
import { X509Certificate, createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { AwsClient } from 'aws4fetch'
import { isReleaseId, parseReleaseRecord } from '../src/lib/app-update.ts'
import type { Artifact, NativeRelease, ReleaseRecord } from '../src/lib/app-update.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MOBILE = resolve(ROOT, '../kagi-mobile')
const RELEASES = join(ROOT, 'dist/releases')
const BUCKET = 'kagi-releases'
const PRIVATE_KEY = join(homedir(), '.local/share/kagi-release/private-key.pem')
const CERTIFICATE = join(MOBILE, 'certs/updates.pem')
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')

interface Prepared {
  releaseId: string
  files: Record<string, string>
  recordSha256: string
}

interface NativeMetadata {
  version: string
  versionCode: number
  build: number
  platform: string
  package: string
  runtimeVersion: string
  embeddedUpdateIds: string[]
  sha256: string
  sizeBytes: number
  signerSha256: string
  apkPath: string
}

function envFor(root: string, production = false): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['.env', '.env.local', ...(production ? ['.env.prod'] : [])]) {
    const file = join(root, name)
    if (existsSync(file)) Object.assign(env, parseEnv(readFileSync(file, 'utf8')))
  }
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value
  return env
}

const webEnv = envFor(ROOT, true)
Object.assign(webEnv, parseEnv(readFileSync(join(ROOT, '.env.prod'), 'utf8')))
const ORIGIN = webEnv.APP_ORIGIN?.replace(/\/+$/, '') ?? ''
const mobileEnv = envFor(MOBILE)

function run(command: string, args: string[], cwd: string, env: Record<string, string>, capture = false): string {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with ${result.status ?? result.signal}.`)
  return capture ? result.stdout : ''
}

function assertUpdateCertificate() {
  const details = run('openssl', ['x509', '-in', CERTIFICATE, '-noout', '-subject', '-issuer', '-ext', 'keyUsage,extendedKeyUsage'], ROOT, webEnv, true)
  const subject = details.match(/^subject=(.+)$/m)?.[1]
  const issuer = details.match(/^issuer=(.+)$/m)?.[1]
  if (!subject || subject !== issuer
    || !/X509v3 Key Usage:[^\n]*\n[^\n]*\bDigital Signature\b/.test(details)
    || !/X509v3 Extended Key Usage:[^\n]*\n[^\n]*\bCode Signing\b/.test(details)) {
    throw new Error('The OTA certificate must be self-signed with Digital Signature and Code Signing usages.')
  }
  // Checked in Node rather than with `openssl verify`: OpenSSL 3 refuses a self-signed
  // certificate without keyCertSign as its own trust anchor, and this one is code signing only.
  const certificate = new X509Certificate(readFileSync(CERTIFICATE))
  if (!certificate.verify(certificate.publicKey)) throw new Error('The OTA certificate is not validly self-signed.')
}

function androidTool(name: string) {
  const sdk = mobileEnv.ANDROID_HOME
  if (!sdk) throw new Error('Set ANDROID_HOME.')
  const tools = join(sdk, 'build-tools')
  const version = readdirSync(tools).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1)
  if (!version) throw new Error('Android build-tools are missing.')
  return join(tools, version, name)
}

async function publishedSigner(): Promise<string | undefined> {
  const response = await fetch(`${ORIGIN}/download/android`, { signal: AbortSignal.timeout(300_000) })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error('The installed signing baseline is unavailable.')
  mkdirSync(join(MOBILE, 'dist/release'), { recursive: true })
  const baseline = join(MOBILE, 'dist/release/signing-baseline.apk')
  writeFileSync(baseline, new Uint8Array(await response.arrayBuffer()))
  if (!run(androidTool('aapt2'), ['dump', 'badging', baseline], MOBILE, mobileEnv, true).includes("package: name='app.kagi.reader'")) throw new Error('The published APK belongs to a different application.')
  const signer = run(androidTool('apksigner'), ['verify', '--print-certs', baseline], MOBILE, mobileEnv, true).match(/certificate SHA-256 digest: ([a-f0-9]+)/i)?.[1]?.toLowerCase()
  if (!signer) throw new Error('The published signing identity could not be verified.')
  return signer
}

function sourceDigest(root: string, publicEnv: Record<string, string>): string {
  const excluded = new Set(['node_modules', 'dist', 'dist-ssr', '.output', '.git', '.expo', '.alchemy', '.tmp', '.tanstack', '.wrangler', '.idea', '.vscode', 'keystore', '__pycache__', 'build', '.gradle'])
  const files: string[] = []
  function walk(folder: string) {
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name) || entry.name.startsWith('.env') || entry.name.startsWith('.backup-') || entry.name.endsWith('.log') || entry.name.endsWith('.local') || entry.name.endsWith('.tsbuildinfo')) continue
      if (folder === root && root === MOBILE && ['android', 'ios'].includes(entry.name)) continue
      const file = join(folder, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) files.push(file)
    }
  }
  walk(root)
  const hash = createHash('sha256')
  for (const file of files) hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0')
  for (const [key, value] of Object.entries(publicEnv).sort(([a], [b]) => a.localeCompare(b))) hash.update(key).update('\0').update(value).update('\0')
  return hash.digest('hex')
}

function sourceHashes() {
  return {
    webSourceSha256: sourceDigest(ROOT, { VITE_CLERK_PUBLISHABLE_KEY: webEnv.VITE_CLERK_PUBLISHABLE_KEY ?? '', APP_ORIGIN: webEnv.APP_ORIGIN ?? '', APP_DOMAIN: webEnv.APP_DOMAIN ?? '' }),
    mobileSourceSha256: sourceDigest(MOBILE, {
      EXPO_PUBLIC_API_ORIGIN: mobileEnv.EXPO_PUBLIC_API_ORIGIN ?? '',
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: mobileEnv.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? '',
    }),
  }
}

function releaseId(flags: string[], required = false): string {
  const index = flags.indexOf('--release')
  const id = index >= 0 ? flags[index + 1] : required ? undefined : `${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '')}-${randomUUID().slice(0, 8)}`
  if (!isReleaseId(id)) throw new Error('Pass a valid --release ID. Prepare the release before publishing.')
  return id
}

function oauthProfile() {
  const profilePath = join(homedir(), '.alchemy/profiles/default/cloudflare.json')
  if (!existsSync(profilePath)) throw new Error('Alchemy Cloudflare authentication is missing. Run bun run plan.')
  const document = JSON.parse(readFileSync(profilePath, 'utf8')) as { values?: { access: string; expires: number | string; accountId: string } }
  const profile = document.values
  if (!profile) throw new Error('Alchemy Cloudflare profile format is unsupported.')
  const expiry = typeof profile.expires === 'number' ? profile.expires : Number(profile.expires) || Date.parse(profile.expires)
  if (!profile.access || !profile.accountId || !Number.isFinite(expiry) || (expiry < 1e12 ? expiry * 1000 : expiry) <= Date.now()) throw new Error('Alchemy authentication expired. Run bun run plan to refresh it.')
  return profile
}

function storage() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = webEnv
  const client = R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY
    ? new AwsClient({ accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' }) : undefined
  const profile = client ? undefined : oauthProfile()
  return {
    hasCustomMetadata: !!client,
    async request(key: string, init?: RequestInit) {
      const path = key.split('/').map(encodeURIComponent).join('/')
      if (client) return client.fetch(`https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${path}`, { ...init, signal: AbortSignal.timeout(300_000) })
      const headers = new Headers(init?.headers)
      headers.delete('x-amz-meta-sha256')
      headers.set('authorization', `Bearer ${profile!.access}`)
      return fetch(`https://api.cloudflare.com/client/v4/accounts/${profile!.accountId}/r2/buckets/${BUCKET}/objects/${path}`, { ...init, headers, signal: AbortSignal.timeout(300_000) })
    },
  }
}

async function readStoredRecord(id: string): Promise<ReleaseRecord> {
  if (!isReleaseId(id)) throw new Error('Invalid base release ID.')
  const response = await storage().request(`releases/${id}/record.json`)
  if (!response.ok) throw new Error(`Base release ${id} is unavailable (${response.status}).`)
  const record = parseReleaseRecord(await response.json())
  if (!record || record.id !== id) throw new Error('The base release record is invalid.')
  return record
}

function mime(extension: string) {
  const types: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', mp4: 'video/mp4', json: 'application/json' }
  return types[extension] ?? 'application/octet-stream'
}

async function prepare(flags: string[]) {
  const id = releaseId(flags)
  const folder = join(RELEASES, id)
  if (existsSync(folder)) throw new Error(`Release ${id} already exists. Use a new release ID.`)
  if (!existsSync(PRIVATE_KEY) || !existsSync(CERTIFICATE)) throw new Error('The OTA signing key and certificate must exist before preparation.')
  assertUpdateCertificate()
  if (!ORIGIN || mobileEnv.EXPO_PUBLIC_API_ORIGIN?.replace(/\/$/, '') !== ORIGIN) throw new Error('Mobile and web production origins must match.')
  const privateKey = createPrivateKey(readFileSync(PRIVATE_KEY))
  const certificate = createPublicKey(readFileSync(CERTIFICATE))
  const challenge = Buffer.from(id)
  if (!verify('RSA-SHA256', challenge, certificate, sign('RSA-SHA256', challenge, privateKey))) throw new Error('OTA key does not match the bundled certificate.')
  const otaOnly = flags.includes('--ota')
  let base: ReleaseRecord | undefined
  let native: NativeMetadata | undefined
  if (otaOnly) {
    const index = flags.indexOf('--base')
    const baseId = index >= 0 ? flags[index + 1] : undefined
    if (!baseId) throw new Error('OTA preparation requires --base ACTIVE_RELEASE_ID.')
    base = await readStoredRecord(baseId)
    const target = base.platforms.android
    const check = await fetch(`${ORIGIN}/api/app-update?${new URLSearchParams({ platform: 'android', build: String(target.build), runtimeVersion: target.runtimeVersion, updateId: target.ota?.id ?? target.embeddedUpdateIds[0] ?? '' })}`, { signal: AbortSignal.timeout(30_000), cache: 'no-store' })
    const active = check.ok ? await check.json() as { releaseId?: string } : null
    if (active?.releaseId !== baseId) throw new Error('The OTA base is not the active release. Use its release ID.')
  } else {
    const expectedSigner = await publishedSigner()
    const bumpIndex = flags.indexOf('--bump')
    const bump = bumpIndex >= 0 ? flags[bumpIndex + 1] : 'patch'
    if (!['patch', 'minor', 'major'].includes(bump)) throw new Error('Use --bump patch, minor or major.')
    run('bash', ['scripts/release-android.sh', '--no-upload', bump], MOBILE, mobileEnv)
    native = JSON.parse(readFileSync(join(MOBILE, 'dist/release/native.json'), 'utf8')) as NativeMetadata
    if (expectedSigner && native.signerSha256 !== expectedSigner) throw new Error('APK signing identity changed. Keep the existing signing key.')
    if (native.platform !== 'android' || native.package !== 'app.kagi.reader' || !/^[a-f0-9]{64}$/.test(native.signerSha256)) throw new Error('Native signing identity is invalid.')
  }
  const runtimeResult = JSON.parse(run('bunx', ['expo-updates', 'runtimeversion:resolve', '--platform', 'android', '--workflow', 'managed'], MOBILE, mobileEnv, true)) as { runtimeVersion: string }
  const runtimeVersion = runtimeResult.runtimeVersion
  const expected = native?.runtimeVersion ?? base?.platforms.android.runtimeVersion
  if (!runtimeVersion || runtimeVersion !== expected) throw new Error('The native runtime changed. Prepare a full native release.')
  const app = JSON.parse(readFileSync(join(MOBILE, 'app.json'), 'utf8')) as { expo: { android: { versionCode: number } } }
  if (base && app.expo.android.versionCode !== base.platforms.android.build) throw new Error('OTA source build number differs from the active native build.')
  mkdirSync(folder, { recursive: true })
  const exportFolder = join(folder, 'export')
  run('bunx', ['expo', 'export', '--platform', 'android', '--dump-assetmap', '--output-dir', exportFolder], MOBILE, mobileEnv)
  const metadata = JSON.parse(readFileSync(join(exportFolder, 'metadata.json'), 'utf8')) as { fileMetadata: { android: { bundle: string; assets: Array<{ path: string; ext: string }> } } }
  const androidExport = metadata.fileMetadata.android
  const files: Record<string, string> = {}
  const artifacts: Record<string, Artifact> = {}
  function add(path: string, file: string, contentType: string): Artifact {
    const bytes = readFileSync(file)
    const artifact = { path, sha256: sha256(bytes), sizeBytes: bytes.length, contentType }
    files[path] = file
    artifacts[path] = artifact
    return artifact
  }
  const apkPath = join(folder, 'kagi.apk')
  let android: NativeRelease
  if (native) {
    copyFileSync(native.apkPath, apkPath)
    const apk = add('kagi.apk', apkPath, 'application/vnd.android.package-archive')
    if (apk.sha256 !== native.sha256 || apk.sizeBytes !== native.sizeBytes) throw new Error('APK checksum differs from its native record.')
    android = { version: native.version, build: native.build, runtimeVersion, embeddedUpdateIds: native.embeddedUpdateIds, apk }
  } else {
    const previous = base!.platforms.android
    const previousApk = previous.apk!
    const response = await storage().request(`releases/${base!.id}/${previousApk.path}`)
    if (!response.ok) throw new Error('The compatible native APK is unavailable.')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (sha256(bytes) !== previousApk.sha256) throw new Error('Base APK checksum mismatch.')
    writeFileSync(apkPath, bytes)
    android = { ...previous, embeddedUpdateIds: [], apk: add('kagi.apk', apkPath, previousApk.contentType) }
  }
  function manifestAsset(path: string, extension: string, launch = false) {
    const file = resolve(exportFolder, path)
    if (!file.startsWith(`${exportFolder}/`)) throw new Error('Export asset escaped its directory.')
    const artifact = add(path, file, launch ? 'application/javascript' : mime(extension))
    return {
      key: basename(path).replace(/\.[^.]+$/, launch ? '' : '$&'),
      hash: createHash('sha256').update(readFileSync(file)).digest('base64url'),
      contentType: artifact.contentType,
      ...(launch ? {} : { fileExtension: `.${extension}` }),
      url: `${ORIGIN}/download/releases/${id}/${path}`,
    }
  }
  const config = JSON.parse(run('bunx', ['expo', 'config', '--type', 'public', '--json'], MOBILE, mobileEnv, true)) as Record<string, unknown>
  const otaId = randomUUID()
  const createdAt = new Date().toISOString()
  const manifest = {
    id: otaId, createdAt, runtimeVersion,
    launchAsset: manifestAsset(androidExport.bundle, 'js', true),
    assets: androidExport.assets.map((asset) => manifestAsset(asset.path, asset.ext)),
    metadata: { releaseid: id }, extra: { expoClient: config },
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  writeFileSync(join(folder, 'manifest.json'), manifestBytes)
  const manifestArtifact = add('manifest.json', join(folder, 'manifest.json'), 'application/json')
  android.ota = { id: otaId, runtimeVersion, manifest: manifestArtifact, signature: sign('RSA-SHA256', manifestBytes, privateKey).toString('base64'), sizeBytes: Object.values(artifacts).filter((artifact) => artifact.path !== 'kagi.apk' && artifact.path !== 'manifest.json').reduce((sum, artifact) => sum + artifact.sizeBytes, 0) }
  const withdrawnReleaseIds = flags.flatMap((flag, index) => flag === '--withdraw' ? [flags[index + 1]] : [])
  if (!withdrawnReleaseIds.every(isReleaseId)) throw new Error('Withdrawal requires a valid release ID.')
  run('bun', ['run', 'build'], ROOT, webEnv)
  const record: ReleaseRecord = { schemaVersion: 1, id, createdAt, ...sourceHashes(), apiVersion: 1, draftVersion: 1, platforms: { android }, artifacts, ...(withdrawnReleaseIds.length ? { withdrawnReleaseIds } : {}) }
  if (!parseReleaseRecord(record)) throw new Error('Prepared release failed record validation.')
  const recordBytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
  writeFileSync(join(folder, 'record.json'), recordBytes)
  const prepared: Prepared = { releaseId: id, files, recordSha256: sha256(recordBytes) }
  writeFileSync(join(folder, 'prepared.json'), `${JSON.stringify(prepared, null, 2)}\n`)
  console.log(`Prepared ${id}. Publish with: bun run release:publish --release ${id}`)
}

async function noPendingMigrations() {
  const profile = oauthProfile()
  const accountUrl = `https://api.cloudflare.com/client/v4/accounts/${profile.accountId}`
  async function api(path: string, init?: RequestInit) {
    const response = await fetch(`${accountUrl}${path}`, { ...init, headers: { authorization: `Bearer ${profile.access}`, 'content-type': 'application/json', ...init?.headers }, signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`Cloudflare preflight failed (${response.status}).`)
    const value = await response.json() as { success: boolean; result: unknown }
    if (!value.success) throw new Error('Cloudflare preflight was rejected.')
    return value.result
  }
  const databases = await api('/d1/database?name=kagi-sync&per_page=100') as Array<{ name: string; uuid: string }>
  const database = databases.find((item) => item.name === 'kagi-sync')
  if (!database) throw new Error('Production D1 kagi-sync is missing.')
  const query = async (sql: string) => {
    const results = await api(`/d1/database/${database.uuid}/query`, { method: 'POST', body: JSON.stringify({ sql }) }) as Array<{ success: boolean; results: Array<Record<string, unknown>> }>
    if (!results[0]?.success) throw new Error('Migration-history query failed.')
    return results[0].results
  }
  const tables = await query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('__alchemy_migrations', 'd1_migrations')")
  if (!tables.some((table) => table.name === '__alchemy_migrations')) throw new Error('Alchemy migration history is not established. Deployment might change schema; obtain migration approval separately.')
  const applied = await query('SELECT name, hash FROM __alchemy_migrations')
  const pending: string[] = []
  for (const name of readdirSync(join(ROOT, 'migrations')).filter((name) => name.endsWith('.sql')).sort()) {
    const file = join(ROOT, 'migrations', name)
    const match = applied.find((row) => row.name === name || row.name === name.replace(/\.sql$/, ''))
    if (!match) pending.push(name)
    else if (match.hash !== sha256(readFileSync(file))) throw new Error(`Applied migration ${name} differs from the local file.`)
  }
  if (pending.length) throw new Error(`Deployment would apply migrations: ${pending.join(', ')}. Obtain separate migration approval.`)
  console.log('Production D1 preflight: no pending migrations.')
}

async function publish(flags: string[]) {
  const id = releaseId(flags, true)
  const folder = join(RELEASES, id)
  const recordBytes = readFileSync(join(folder, 'record.json'))
  const prepared = JSON.parse(readFileSync(join(folder, 'prepared.json'), 'utf8')) as Prepared
  const record = parseReleaseRecord(JSON.parse(recordBytes.toString('utf8')))
  if (!record || record.id !== id || prepared.releaseId !== id || prepared.recordSha256 !== sha256(recordBytes)) throw new Error('Prepared release record changed or is invalid.')
  const current = sourceHashes()
  if (current.webSourceSha256 !== record.webSourceSha256 || current.mobileSourceSha256 !== record.mobileSourceSha256) throw new Error('Sources changed after preparation. Prepare a new release.')
  for (const artifact of Object.values(record.artifacts)) {
    const bytes = readFileSync(prepared.files[artifact.path])
    if (sha256(bytes) !== artifact.sha256 || bytes.length !== artifact.sizeBytes) throw new Error(`Prepared artifact ${artifact.path} changed.`)
  }
  await noPendingMigrations()
  const client = storage()
  async function upload(key: string, bytes: Uint8Array, contentType: string) {
    const hash = sha256(bytes)
    const existing = await client.request(key)
    if (existing.ok) {
      if (sha256(new Uint8Array(await existing.arrayBuffer())) !== hash) throw new Error(`Immutable object ${key} already contains different bytes.`)
    } else {
      if (existing.status !== 404) throw new Error(`Object preflight failed (${existing.status}).`)
      const response = await client.request(key, { method: 'PUT', body: bytes as BodyInit, headers: { 'content-type': contentType, 'x-amz-meta-sha256': hash, 'if-none-match': '*', 'cache-control': 'public, max-age=31536000, immutable' } })
      if (!response.ok) throw new Error(`Object upload failed (${response.status}). Activation stopped.`)
    }
    const verified = await client.request(key)
    if (!verified.ok || (client.hasCustomMetadata && verified.headers.get('x-amz-meta-sha256') !== hash) || sha256(new Uint8Array(await verified.arrayBuffer())) !== hash) throw new Error(`Stored verification failed for ${key}. Activation stopped.`)
  }
  for (const artifact of Object.values(record.artifacts)) await upload(`releases/${id}/${artifact.path}`, readFileSync(prepared.files[artifact.path]), artifact.contentType)
  await upload(`releases/${id}/record.json`, recordBytes, 'application/json')
  run('bun', ['run', 'deploy', '--', '--yes'], ROOT, { ...webEnv, APP_RELEASE_ID: id })
  const response = await fetch(`${ORIGIN}/api/app-update?${new URLSearchParams({ platform: 'android', build: String(record.platforms.android.build), runtimeVersion: record.platforms.android.runtimeVersion, updateId: record.platforms.android.embeddedUpdateIds[0] ?? record.platforms.android.ota!.id })}`, { cache: 'no-store', signal: AbortSignal.timeout(30_000) })
  const result = response.ok ? await response.json() as { releaseId?: string; status?: string } : null
  if (result?.releaseId !== id || result.status !== 'latest') throw new Error('Deployment finished, but release activation verification failed. Inspect the Worker before retrying.')
  const envPath = join(ROOT, '.env.prod')
  const currentEnv = readFileSync(envPath, 'utf8')
  const nextEnv = /^APP_RELEASE_ID=.*$/m.test(currentEnv)
    ? currentEnv.replace(/^APP_RELEASE_ID=.*$/m, `APP_RELEASE_ID=${id}`)
    : `${currentEnv.trimEnd()}\nAPP_RELEASE_ID=${id}\n`
  writeFileSync(envPath, nextEnv, { mode: 0o600 })
  console.log(`Published web and Android release ${id}. APK: ${ORIGIN}/download/android`)
}

const [command = 'help', ...flags] = process.argv.slice(2)
try {
  if (command === 'prepare') await prepare(flags)
  else if (command === 'publish') await publish(flags)
  else if (command === 'preflight') await noPendingMigrations()
  else if (command === 'release') {
    const id = releaseId(flags)
    await prepare([...flags, '--release', id])
    await publish(['--release', id])
  }
  else console.log('Usage: bun scripts/release.ts prepare [--release ID] [--ota --base ACTIVE_RELEASE_ID] [--clean] [--withdraw RELEASE_ID]\n       bun scripts/release.ts publish --release ID')
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Release command failed.')
  process.exitCode = 1
}

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { Agent, fetch, FormData } from 'undici'
import { LOOPBACK_HOSTS } from '../../src/lib/adapt/desktop-bridge'
import type { BridgeBody, BridgeRequest, BridgeResponse } from '../../src/lib/adapt/desktop-bridge'
import { createFileJournal } from './journal-store'
import { getBundle } from '../../src/lib/adapt/journal/store'
import { importBundle } from '../../src/lib/adapt/journal/helpers'
import type { ArtifactTransfer, DesktopNavState, JournalTransfer } from '../../src/lib/adapt/desktop-bridge'
import type { GenerationRecord, JournalEvent } from '../../src/lib/adapt/journal/types'

// The bundler bakes __dirname in as this source folder, so built files are found from the app root.
const dist = (file: string) => join(app.getAppPath(), 'dist', file)

// `bun run dev` serves here; the unpackaged app is a local desktop, whatever an earlier build left in dist.
const LOCAL_URL = 'http://localhost:3150'

// Node's fetch drops a reply that takes over 5 minutes; the page sets its own deadlines.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 })

function appUrl(): string | null {
  if (process.env.KAGI_URL) return process.env.KAGI_URL
  if (!app.isPackaged) return LOCAL_URL
  try {
    const config: unknown = JSON.parse(readFileSync(dist('config.json'), 'utf8'))
    return config && typeof config === 'object' && 'url' in config && typeof config.url === 'string' ? config.url : null
  } catch {
    return null
  }
}

function requestBody(body: BridgeBody | null): string | FormData | undefined {
  if (!body) return undefined
  if (body.kind === 'text') return body.text
  const form = new FormData()
  for (const entry of body.entries) {
    if ('bytes' in entry) form.append(entry.name, new Blob([entry.bytes], { type: entry.type }), entry.filename)
    else form.append(entry.name, entry.value)
  }
  return form
}

function openOutside(target: string): void {
  if (/^https?:/.test(target)) void shell.openExternal(target)
}

function navState(contents: Electron.WebContents): DesktopNavState {
  return { canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward() }
}

function serve(origin: string): void {
  const inflight = new Map<string, AbortController>()
  const journalRoot = join(app.getPath('userData'), 'generations')
  const journal = createFileJournal(journalRoot)
  const authorize = (event: Electron.IpcMainInvokeEvent) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || new URL(event.senderFrame.url).origin !== origin) {
      throw new Error('Refused: not the app page.')
    }
  }
  ipcMain.handle('kagi:journal:location', (event) => {
    authorize(event)
    return journalRoot
  })
  ipcMain.handle('kagi:journal:list', async (event) => {
    authorize(event)
    return (await journal).listRuns()
  })
  ipcMain.handle('kagi:journal:read', async (event, id: string): Promise<JournalTransfer> => {
    authorize(event)
    const bundle = await getBundle(await journal, id)
    return {
      ...bundle,
      artifacts: await Promise.all(bundle.artifacts.map(async ({ blob, ...artifact }) => ({ ...artifact, bytes: await blob.arrayBuffer() }))),
    }
  })
  ipcMain.handle('kagi:journal:write', async (event, bundle: JournalTransfer) => {
    authorize(event)
    await importBundle(await journal, {
      ...bundle,
      artifacts: bundle.artifacts.map(({ bytes, ...artifact }) => ({ ...artifact, blob: new Blob([bytes], { type: artifact.mime }) })),
    })
  })
  ipcMain.handle('kagi:journal:put-run', async (event, run: GenerationRecord) => {
    authorize(event)
    await (await journal).putRun(run)
  })
  ipcMain.handle('kagi:journal:put-event', async (event, entry: JournalEvent) => {
    authorize(event)
    await (await journal).putEvent(entry)
  })
  ipcMain.handle('kagi:journal:put-artifact', async (event, { bytes, ...artifact }: ArtifactTransfer) => {
    authorize(event)
    await (await journal).putArtifact({ ...artifact, blob: new Blob([bytes], { type: artifact.mime }) })
  })
  ipcMain.handle('kagi:journal:delete', async (event, id: string) => {
    authorize(event)
    await (await journal).deleteRun(id)
  })
  ipcMain.handle('kagi:nav:state', (event): DesktopNavState => {
    authorize(event)
    return navState(event.sender)
  })
  ipcMain.on('kagi:nav:back', (event) => {
    if (event.senderFrame === event.sender.mainFrame) event.sender.navigationHistory.goBack()
  })
  ipcMain.on('kagi:nav:forward', (event) => {
    if (event.senderFrame === event.sender.mainFrame) event.sender.navigationHistory.goForward()
  })

  ipcMain.handle('kagi:request', async (event, request: BridgeRequest): Promise<BridgeResponse> => {
    if (!event.senderFrame || new URL(event.senderFrame.url).origin !== origin) throw new Error('Refused: not the app page.')
    const url = new URL(request.url)
    if (!/^https?:$/.test(url.protocol) || LOOPBACK_HOSTS[url.hostname] !== true) {
      throw new Error(`Refused: ${url.host} is not a local endpoint.`)
    }
    const controller = new AbortController()
    inflight.set(request.id, controller)
    try {
      const response = await fetch(url, {
        method: request.method,
        headers: request.headers,
        body: requestBody(request.body),
        signal: controller.signal,
        dispatcher,
      })
      return { status: response.status, headers: [...response.headers.entries()], body: await response.text() }
    } finally {
      inflight.delete(request.id)
    }
  })

  ipcMain.on('kagi:abort', (_event, id: string) => inflight.get(id)?.abort())
}

function openWindow(url: string, origin: string): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    autoHideMenuBar: true,
    webPreferences: {
      preload: dist('preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Drawing runs in the page, so it must keep going while the window is hidden.
      backgroundThrottling: false,
    },
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin === origin) return
    event.preventDefault()
    openOutside(target)
  })
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    openOutside(target)
    return { action: 'deny' }
  })
  const publishNav = () => window.webContents.send('kagi:nav:changed', navState(window.webContents))
  window.webContents.on('did-navigate', publishNav)
  window.webContents.on('did-navigate-in-page', publishNav)
  void window.loadURL(url)
}

// A second window would start a second runner over the same stored adaptations.
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window?.isMinimized()) window.restore()
    window?.focus()
  })
  app.on('window-all-closed', () => app.quit())
  void app.whenReady().then(() => {
    const url = appUrl()
    if (!url) {
      dialog.showErrorBox('Kagi', 'No app URL. Set KAGI_URL, or build with APP_ORIGIN in .env.prod.')
      app.quit()
      return
    }
    const origin = new URL(url).origin
    serve(origin)
    openWindow(url, origin)
  })
}

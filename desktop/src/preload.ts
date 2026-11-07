import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopBridge, DesktopNavState } from '../../src/lib/adapt/desktop-bridge'

const bridge: DesktopBridge = {
  request: (request) => ipcRenderer.invoke('kagi:request', request),
  abort: (id) => ipcRenderer.send('kagi:abort', id),
  journal: {
    location: () => ipcRenderer.invoke('kagi:journal:location'),
    list: () => ipcRenderer.invoke('kagi:journal:list'),
    read: (id) => ipcRenderer.invoke('kagi:journal:read', id),
    write: (bundle) => ipcRenderer.invoke('kagi:journal:write', bundle),
    putRun: (run) => ipcRenderer.invoke('kagi:journal:put-run', run),
    putEvent: (event) => ipcRenderer.invoke('kagi:journal:put-event', event),
    putArtifact: (artifact) => ipcRenderer.invoke('kagi:journal:put-artifact', artifact),
    delete: (id) => ipcRenderer.invoke('kagi:journal:delete', id),
  },
  nav: {
    back: () => ipcRenderer.send('kagi:nav:back'),
    forward: () => ipcRenderer.send('kagi:nav:forward'),
    state: () => ipcRenderer.invoke('kagi:nav:state'),
    onChange: (listener) => {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopNavState) => listener(state)
      ipcRenderer.on('kagi:nav:changed', handle)
      return () => ipcRenderer.off('kagi:nav:changed', handle)
    },
  },
}

contextBridge.exposeInMainWorld('kagiDesktop', bridge)

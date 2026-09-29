import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from './contracts';

const bridge: DesktopBridge = {
  request: async (method, params) => {
    const response = await ipcRenderer.invoke('mongle:request', method, params);
    if (!response.ok) throw Object.assign(new Error(response.error.message), { code: response.error.code });
    return response.result;
  },
  subscribe: (listener) => {
    const callback = (_event: unknown, message: Parameters<typeof listener>[0]) => listener(message);
    ipcRenderer.on('mongle:event', callback);
    return () => ipcRenderer.removeListener('mongle:event', callback);
  },
  close: () => undefined,
  listHosts: () => ipcRenderer.invoke('mongle:hosts'),
  addHost: (host) => ipcRenderer.invoke('mongle:add-host', host),
  removeHost: (id) => ipcRenderer.invoke('mongle:remove-host', id),
  selectHost: (id) => ipcRenderer.invoke('mongle:select-host', id),
  selectDirectory: (currentPath) => ipcRenderer.invoke('mongle:select-directory', currentPath),
  readClipboard: () => ipcRenderer.invoke('mongle:clipboard-read'),
  writeClipboard: (text) => ipcRenderer.invoke('mongle:clipboard-write', text),
  getUpdateState: () => ipcRenderer.invoke('mongle:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('mongle:update-check'),
  installUpdate: () => ipcRenderer.invoke('mongle:update-install'),
  onUpdate: (listener) => {
    const callback = (_event: unknown, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('mongle:update', callback);
    return () => ipcRenderer.removeListener('mongle:update', callback);
  },
  onConnection: (listener) => {
    const callback = (_event: unknown, info: Parameters<typeof listener>[0]) => listener(info);
    ipcRenderer.on('mongle:connection', callback);
    // Subscribe before asking for the current value, so startup cannot lose its event.
    void ipcRenderer.invoke('mongle:connection-info').then(listener);
    return () => ipcRenderer.removeListener('mongle:connection', callback);
  },
};
contextBridge.exposeInMainWorld('mongle', Object.freeze(bridge));

import type { HostEvent, Transport } from '../../packages/protocol/index';

export interface SavedHost { id: string; name: string; url?: string; local: boolean; selected: boolean; hostId?: string; }
export interface ConnectionInfo { status: 'connecting' | 'connected' | 'pairing' | 'offline'; owner: boolean; hostId?: string; connectionId?: string; error?: string; }
export interface UpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  message?: string;
}
export interface DesktopBridge extends Transport {
  titleBarOverlay: boolean;
  setWindowTheme(theme: 'dark' | 'light'): Promise<void>;
  setUnsavedFiles(count: number): Promise<void>;
  listHosts(): Promise<SavedHost[]>;
  addHost(host: { name: string; url: string }): Promise<SavedHost>;
  removeHost(id: string): Promise<void>;
  selectHost(id: string): Promise<ConnectionInfo>;
  selectDirectory(currentPath?: string): Promise<string | null>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  installUpdate(): Promise<void>;
  onUpdate(listener: (state: UpdateState) => void): () => void;
  onConnection(listener: (info: ConnectionInfo) => void): () => void;
}
export type EventSubscriber = (message: HostEvent) => void;

import type { HostEvent, Transport } from '../../packages/protocol/index';

export interface SavedHost { id: string; name: string; url?: string; local: boolean; selected: boolean; hostId?: string; }
/** Mongle PCs the connected host found that this PC app can still add. */
export interface ComputerSearch { computers: { name: string; origin: string }[]; available: boolean; message?: string; alreadyAdded: number; }
export interface ConnectionInfo { status: 'connecting' | 'connected' | 'pairing' | 'offline'; owner: boolean; hostId?: string; connectionId?: string; error?: string; }
export interface UpdateState {
  status: 'unsupported' | 'idle' | 'checking' | 'downloading' | 'ready' | 'installing' | 'error';
  currentVersion: string;
  availableVersion?: string;
  progress?: number;
  /** Installation step while status is installing. Steps report real lifecycle events, never a percentage. 'checking' looks for a newer release first. */
  phase?: 'checking' | 'confirming' | 'saving' | 'launching';
  message?: string;
}
export interface DesktopBridge extends Transport {
  titleBarOverlay: boolean;
  setWindowTheme(theme: 'dark' | 'light'): Promise<void>;
  setUnsavedFiles(count: number): Promise<void>;
  listHosts(): Promise<SavedHost[]>;
  addHost(host: { name: string; url: string }): Promise<SavedHost>;
  findComputers(refresh: boolean): Promise<ComputerSearch>;
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

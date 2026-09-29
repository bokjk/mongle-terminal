import type { HostEvent, Transport } from '../../packages/protocol/index';

export interface SavedHost { id: string; name: string; url?: string; local: boolean; selected: boolean; hostId?: string; }
export interface ConnectionInfo { status: 'connecting' | 'connected' | 'pairing' | 'offline'; owner: boolean; hostId?: string; connectionId?: string; error?: string; }
export interface DesktopBridge extends Transport {
  listHosts(): Promise<SavedHost[]>;
  addHost(host: { name: string; url: string }): Promise<SavedHost>;
  removeHost(id: string): Promise<void>;
  selectHost(id: string): Promise<ConnectionInfo>;
  selectDirectory(currentPath?: string): Promise<string | null>;
  onConnection(listener: (info: ConnectionInfo) => void): () => void;
}
export type EventSubscriber = (message: HostEvent) => void;

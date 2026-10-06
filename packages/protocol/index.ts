import { z } from 'zod';
import { version } from '../../package.json';

export const PROTOCOL_VERSION = 1;
export const APP_VERSION = version;
/** A leaf is one split region. `tabs` holds its additional sessions in display order. */
export type LayoutLeaf = { type: 'leaf'; terminalId: string; tabs?: string[] };
export type LayoutNode = LayoutLeaf | { type: 'split'; axis: 'horizontal' | 'vertical'; ratio: number; first: LayoutNode; second: LayoutNode };
export interface Group { id: string; name: string; cwd: string; profileId: string; revision: number; layout: LayoutNode | null; repositoryIds?: string[]; /** Legacy single-repository association. */ repositoryId?: string; }
export function groupRepositoryIds(group: Group): string[] { return [...new Set([...(group.repositoryIds || []), ...(group.repositoryId ? [group.repositoryId] : [])])]; }
export interface Repository { id: string; commonDir: string; root: string; baseRef: string; worktreeRoot: string; checkedAt: number; error?: string; }
export interface Worktree { id: string; repositoryId: string; name: string; path: string; branch: string; head: string; main: boolean; managed: boolean; status: 'ready' | 'missing' | 'unsupported' | 'removing'; locked?: string; reason?: string; }
export interface ProjectInspection { commonDir: string; root: string; selectedPath: string; baseRef: string; branches: string[]; worktrees: Omit<Worktree, 'id' | 'repositoryId' | 'name' | 'managed'>[]; }
export interface WorktreeOperation { id: string; requestId: string; fingerprint: string; kind: 'create' | 'remove'; repositoryId: string; groupId: string; worktreeId: string; status: 'pending' | 'running' | 'succeeded' | 'failed' | 'attention'; createdAt: number; name?: string; path?: string; branch?: string; head?: string; terminalId?: string; message?: string; }
export interface ShellProfile { id: string; name: string; executable: string; args: string[]; kind: 'powershell' | 'cmd' | 'wsl' | 'bash'; }
export interface Controller { connectionId: string; deviceName: string; epoch: number; ready: boolean; }
export interface TerminalInfo { id: string; groupId: string; title: string; profileId: string; cwd: string; currentCwd?: string; generation: string; status: 'running' | 'exited' | 'interrupted'; cols: number; rows: number; pid?: number; exitCode?: number; controller?: Controller; historyAvailable?: boolean; resumeOnBoot?: boolean; restoreError?: string; worktreeId?: string; }
export interface HostSettings { name: string; recordHistory: boolean; scrollback: number; }
export interface HostState { hostId: string; bootId: string; name: string; version: string; protocolVersion: number; capabilities?: string[]; groups: Group[]; terminals: TerminalInfo[]; profiles: ShellProfile[]; settings: HostSettings; storageError?: string; repositories?: Repository[]; worktrees?: Worktree[]; worktreeOperations?: WorktreeOperation[]; }
export interface ConnectionContext { id: string; deviceId: string; deviceName: string; owner: boolean; }
export interface FileEntry { name: string; path: string; kind: 'directory' | 'file' | 'link' | 'other'; }
export interface DirectoryListing { root: string; path: string; absolutePath: string; entries: FileEntry[]; truncated: boolean; }
export interface FilePreview { path: string; absolutePath: string; text: string; truncated: boolean; encoding: 'UTF-8' | 'UTF-16LE' | 'UTF-16BE'; }
/** Editing is explicitly granted by the host for this connection and document. */
export interface FileDocument extends FilePreview { documentId?: string; version?: string; readOnlyReason?: string; }
export const FILE_EDIT_BYTES = 64 * 1024;
export const PDF_PREVIEW_BYTES = 8 * 1024 * 1024;
export const PDF_CHUNK_BYTES = 64 * 1024;
export interface PdfChunk { path: string; absolutePath: string; size: number; version: string; offset: number; contentBase64: string; }
export type GitStatusCode = '' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T';
export interface GitChange { path: string; originalPath?: string; index: GitStatusCode; worktree: GitStatusCode; untracked: boolean; conflicted: boolean; }
export type GitListing = { state: 'not-repository' | 'unavailable'; root: string; message: string } | { state: 'repository'; root: string; repositoryRoot: string; branch: string; detached: boolean; changes: GitChange[]; truncated: boolean };
export interface RpcRequest { type: 'request'; id: string; method: string; params: unknown; }
export type RpcResponse = { type: 'response'; id: string; ok: true; result: any } | { type: 'response'; id: string; ok: false; error: { code: string; message: string } };
export interface PresentationSnapshot { kind: 'presentation-v1'; data: string; cols: number; rows: number; modes: Record<string, unknown>; version: string; }
export interface SnapshotEvent { type: 'snapshot'; terminalId: string; generation: string; bootId: string; seq: number; snapshot: PresentationSnapshot; }
export type HostEvent = { type: 'state'; state: HostState } | SnapshotEvent | { type: 'pairings'; requests: unknown[] } | { type: 'notice'; code: string; message: string };
export type ServerMessage = RpcResponse | HostEvent;
export type Send = (message: ServerMessage) => void;
export interface Transport { request<T = any>(method: string, params?: unknown): Promise<T>; subscribe(listener: (message: HostEvent) => void): () => void; close(): void; }
export const requestSchema = z.object({ type: z.literal('request'), id: z.string().min(1).max(80), method: z.string().min(1).max(80), params: z.unknown().optional() }).strict();
export const idSchema = z.string().uuid();
export const dimensionSchema = z.object({ cols: z.number().int().min(20).max(400), rows: z.number().int().min(5).max(200) });
export class AppError extends Error { constructor(public code: string, message: string) { super(message); this.name = 'AppError'; } }
export function errorResult(error: unknown) { return error instanceof AppError ? { code: error.code, message: error.message } : error instanceof z.ZodError ? { code: 'INVALID_REQUEST', message: '요청 형식이 올바르지 않습니다.' } : { code: 'INTERNAL_ERROR', message: '작업을 완료하지 못했습니다.' }; }
export function leafIds(node: LayoutNode | null): string[] { return !node ? [] : node.type === 'leaf' ? [node.terminalId, ...(node.tabs || [])] : [...leafIds(node.first), ...leafIds(node.second)]; }
export function findLeaf(node: LayoutNode | null, id: string): LayoutLeaf | undefined {
  if (!node) return undefined;
  return node.type === 'leaf' ? leafIds(node).includes(id) ? node : undefined : findLeaf(node.first,id) || findLeaf(node.second,id);
}
export function removeLeaf(node: LayoutNode | null, id: string): LayoutNode | null {
  if (!node) return null;
  if (node.type === 'leaf') {
    if (!leafIds(node).includes(id)) return node;
    const ids=leafIds(node).filter(value=>value!==id);
    return ids.length ? {type:'leaf',terminalId:ids[0],...(ids.length>1?{tabs:ids.slice(1)}:{})} : null;
  }
  const a=removeLeaf(node.first,id), b=removeLeaf(node.second,id);
  return a && b ? {...node,first:a,second:b} : a || b;
}
export function appendTab(node: LayoutNode, target: string, id: string): LayoutNode {
  if (node.type === 'leaf') return leafIds(node).includes(target) ? {...node,tabs:[...(node.tabs || []),id]} : node;
  return {...node,first:appendTab(node.first,target,id),second:appendTab(node.second,target,id)};
}
export function splitLeaf(node: LayoutNode | null, target: string | undefined, id: string, axis: 'horizontal' | 'vertical'): LayoutNode {
  const next:LayoutNode={type:'leaf',terminalId:id};
  if (!node) return next;
  if (!target || node.type==='leaf' && leafIds(node).includes(target)) return {type:'split',axis,ratio:0.5,first:node,second:next};
  if (node.type==='split') return {...node,first:leafIds(node.first).includes(target)?splitLeaf(node.first,target,id,axis):node.first,second:leafIds(node.second).includes(target)?splitLeaf(node.second,target,id,axis):node.second};
  return node;
}

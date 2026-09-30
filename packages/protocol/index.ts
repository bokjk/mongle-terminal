import { z } from 'zod';
import { version } from '../../package.json';

export const PROTOCOL_VERSION = 1;
export const APP_VERSION = version;
export type LayoutNode = { type: 'leaf'; terminalId: string } | { type: 'split'; axis: 'horizontal' | 'vertical'; ratio: number; first: LayoutNode; second: LayoutNode };
export interface Group { id: string; name: string; cwd: string; profileId: string; revision: number; layout: LayoutNode | null; }
export interface ShellProfile { id: string; name: string; executable: string; args: string[]; kind: 'powershell' | 'cmd' | 'wsl' | 'bash'; }
export interface Controller { connectionId: string; deviceName: string; epoch: number; ready: boolean; }
export interface TerminalInfo { id: string; groupId: string; title: string; profileId: string; cwd: string; currentCwd?: string; generation: string; status: 'running' | 'exited' | 'interrupted'; cols: number; rows: number; pid?: number; exitCode?: number; controller?: Controller; historyAvailable?: boolean; resumeOnBoot?: boolean; restoreError?: string; }
export interface HostSettings { name: string; recordHistory: boolean; scrollback: number; }
export interface HostState { hostId: string; bootId: string; name: string; version: string; protocolVersion: number; capabilities?: string[]; groups: Group[]; terminals: TerminalInfo[]; profiles: ShellProfile[]; settings: HostSettings; storageError?: string; }
export interface ConnectionContext { id: string; deviceId: string; deviceName: string; owner: boolean; }
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
export function leafIds(node: LayoutNode | null): string[] { return !node ? [] : node.type === 'leaf' ? [node.terminalId] : [...leafIds(node.first), ...leafIds(node.second)]; }
export function removeLeaf(node: LayoutNode | null, id: string): LayoutNode | null { if (!node || node.type === 'leaf') return node?.terminalId === id ? null : node; const a = removeLeaf(node.first,id), b = removeLeaf(node.second,id); return a && b ? {...node, first:a, second:b} : a || b; }
export function splitLeaf(node: LayoutNode | null, target: string | undefined, id: string, axis: 'horizontal' | 'vertical'): LayoutNode { const next: LayoutNode = {type:'leaf', terminalId:id}; if (!node) return next; if (!target || node.type === 'leaf' && node.terminalId === target) return {type:'split',axis,ratio:0.5,first:node,second:next}; if (node.type === 'split') return {...node,first:leafIds(node.first).includes(target) ? splitLeaf(node.first,target,id,axis) : node.first, second:leafIds(node.second).includes(target) ? splitLeaf(node.second,target,id,axis) : node.second}; return node; }

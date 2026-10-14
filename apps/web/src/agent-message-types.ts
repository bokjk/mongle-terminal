// Types the agent message UI needs, kept in one place so the components stay easy to test.
export type { AgentHoldReason, HostState, TerminalInfo } from '../../../packages/protocol/index';
export type AppClientRequest = <T = unknown>(method: string, params?: unknown) => Promise<T>;

import { Terminal } from '@xterm/xterm';
import { BrowserPresentationAdapter } from '../../packages/terminal/browser.js';
import { terminalThemes, terminalMinimumContrast } from '../../apps/web/src/terminal-theme.js';

const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true, fontSize: 14 });
terminal.open(document.querySelector('#terminal') as HTMLElement);
const inputs: Array<[string, string]> = [];
const adapter = new BrowserPresentationAdapter(terminal, (data, encoding) => inputs.push([data, encoding]));
terminal.attachCustomKeyEventHandler(event=>adapter.handleKeyEvent(event));
(window as any).mongleTerminalTest = { terminal, adapter, inputs, terminalThemes, terminalMinimumContrast };

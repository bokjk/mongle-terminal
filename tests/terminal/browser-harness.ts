import { Terminal } from '@xterm/xterm';
import { BrowserPresentationAdapter } from '../../packages/terminal/browser.js';
import { terminalThemes, terminalMinimumContrast } from '../../apps/web/src/terminal-theme.js';

const terminal = new Terminal({ cols: 40, rows: 8, allowProposedApi: true, fontSize: 14 });
terminal.open(document.querySelector('#terminal') as HTMLElement);
const inputs: Array<[string, string]> = [];
const inputSources: Array<string | undefined> = [];
let touchScrollSpeed = 1;
let touchAckDelay = 0, touchPendingUntil = 0;
const adapter = new BrowserPresentationAdapter(terminal, (data, encoding, source) => {
  inputs.push([data, encoding]); inputSources.push(source);
  if (source === 'touch-scroll') touchPendingUntil = performance.now() + touchAckDelay;
}, { getTouchScrollSpeed: () => touchScrollSpeed, touchMomentumReady: () => performance.now() >= touchPendingUntil });
terminal.attachCustomKeyEventHandler(event=>adapter.handleKeyEvent(event));
(window as any).mongleTerminalTest = { terminal, adapter, inputs, inputSources, terminalThemes, terminalMinimumContrast,
  setTouchScrollSpeed: (value: number) => { touchScrollSpeed = value; },
  setTouchAckDelay: (value: number) => { touchAckDelay = value; touchPendingUntil = 0; },
};

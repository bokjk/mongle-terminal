import { performance } from 'node:perf_hooks';
import { TerminalEngine } from '../../packages/terminal/engine.js';

for (let trial = 1; trial <= 3; trial += 1) {
  const engine = new TerminalEngine({ cols: 80, rows: 24, onResponse() {} });
  try {
    const start = performance.now();
    await Promise.all(Array.from({ length: 1000 }, () => engine.write('x')));
    const elapsedMs = performance.now() - start;
    const snapshot = await engine.snapshot();
    console.log(JSON.stringify({ node: process.version, kind: 'small-chunk-burst', trial,
      chunks: 1000, bytes: 1000, elapsedMs: Number(elapsedMs.toFixed(2)), revision: snapshot.revision }));
  } finally { await engine.dispose(); }
}

for (const lines of [100, 1000, 5000]) {
  const engine = new TerminalEngine({ cols: 100, rows: 30, scrollback: 5000, onResponse() {} });
  try {
    await engine.write(Array.from({ length: lines }, (_, i) => `${i}: mongle terminal 한글 sample ${'a'.repeat(50)}\r\n`).join(''));
    const times: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 8; i += 1) {
      const start = performance.now();
      const snapshot = await engine.snapshot();
      times.push(performance.now() - start);
      bytes = Buffer.byteLength(JSON.stringify(snapshot));
    }
    times.sort((a, b) => a - b);
    console.log(JSON.stringify({ node: process.version, lines, cols: 100, rows: 30, frameBytes: bytes, medianMs: Number(times[4].toFixed(2)), maxMs: Number(times[7].toFixed(2)) }));
  } finally { await engine.dispose(); }
}

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, type Page } from '@playwright/test';
import { TerminalEngine } from '../../packages/terminal/engine.js';

const chrome = process.platform === 'win32' && existsSync('C:/Program Files/Google/Chrome/Application/chrome.exe');

const browserOptions = { skip: chrome ? false : 'Requires installed Windows Chrome for the real DOM check.', timeout: 30000 };

for (const direction of ['up', 'down'] as const) {
  test(`real Chrome: ${direction} drag scroll cannot be starved by rapid full frames`, browserOptions,
    async () => withTerminalBrowser(async (page, engine) => {
      await engine.write(Array.from({ length: 120 }, (_, i) => `line ${String(i).padStart(3, '0')} abcdefghijklmnopqrstuvwxyz`).join('\r\n'));
      const frame = await engine.snapshot();
      await page.evaluate(async snapshot => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(snapshot);
        h.terminal.element.style.margin = '100px';
        h.terminal.scrollToLine(60);
      }, frame);
      const rect = await page.locator('.xterm-screen').boundingBox(); assert.ok(rect);
      const x = rect.x + rect.width / 40 * 2.1;
      await page.mouse.move(x, rect.y + rect.height / 2);
      await page.mouse.down();
      await page.mouse.move(x, direction === 'up' ? rect.y - 30 : rect.y + rect.height + 30);
      const result = await page.evaluate(async snapshot => {
        const h = (window as any).mongleTerminalTest;
        const before = h.terminal.buffer.active.viewportY;
        const start = performance.now();
        let frames = 0;
        while (performance.now() - start < 600) {
          await h.adapter.applySnapshot(snapshot);
          frames++;
          await new Promise(resolve => setTimeout(resolve, 8));
        }
        return { before, after: h.terminal.buffer.active.viewportY, frames, selection: h.terminal.getSelection(), inputs: h.inputs };
      }, frame);
      await page.mouse.up();
      assert.ok(result.frames > 10, 'exercise a sustained stream of full frames');
      assert.ok(direction === 'up' ? result.after < result.before - 20 : result.after > result.before + 20,
        `selection must keep scrolling during output: ${JSON.stringify(result)}`);
      assert.ok(result.selection.includes(direction === 'up' ? 'line 040' : 'line 090'), 'intermediate rows are selected without gaps');
      assert.deepEqual(result.inputs, []);
      const released = await page.evaluate(async snapshot => {
        const h = (window as any).mongleTerminalTest;
        const before = { viewport: h.terminal.buffer.active.viewportY, text: h.terminal.getSelection() };
        await h.adapter.applySnapshot(snapshot);
        await new Promise(resolve => setTimeout(resolve, 120));
        return { before, after: { viewport: h.terminal.buffer.active.viewportY, text: h.terminal.getSelection() }, timer: h.terminal._core._selectionService._dragScrollIntervalTimer };
      }, frame);
      assert.deepEqual(released.after, released.before, 'release stops scrolling and preserves the copied range');
      assert.equal(released.timer, undefined, 'release cancels the replacement timer');
    }));
}

for (const direction of ['forward', 'reverse'] as const) {
  test(`real Chrome: active ${direction} selection keeps its anchor across output frames`, browserOptions,
    async () => withTerminalBrowser(async (page, engine) => {
      await engine.write('abcdefghijklmnopqrstuvwxyz\r\noutput');
      await page.evaluate(async snapshot => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(snapshot);
        h.adapter.setInputEnabled(true);
      }, await engine.snapshot());
      const cell = await terminalCellGeometry(page);
      const anchor = direction === 'forward' ? 2 : 12;
      const midpoint = direction === 'forward' ? 5 : 8;
      const endpoint = direction === 'forward' ? 12 : 2;
      await page.mouse.move(cell.x + (anchor + 0.1) * cell.width, cell.y);
      await page.mouse.down();
      await page.mouse.move(cell.x + (midpoint + 0.1) * cell.width, cell.y);
      assert.equal(await page.evaluate(() => (window as any).mongleTerminalTest.terminal.getSelection()),
        direction === 'forward' ? 'cde' : 'ijkl');
      await engine.write(' continues');
      await page.evaluate(async snapshot => {
        await (window as any).mongleTerminalTest.adapter.applySnapshot(snapshot);
      }, await engine.snapshot());
      await page.mouse.move(cell.x + (endpoint + 0.1) * cell.width, cell.y);
      await page.mouse.up();
      assert.deepEqual(await page.evaluate(() => {
        const h = (window as any).mongleTerminalTest;
        return { selected: h.terminal.getSelection(), inputs: h.inputs };
      }), { selected: 'cdefghijkl', inputs: [] }, 'output cannot end the drag or change its original anchor');
    }));
}

test('real Chrome: selection movement and release during a pending frame finish once without sticking', browserOptions,
  async () => withTerminalBrowser(async (page, engine) => {
    await engine.write('abcdefghijklmnopqrstuvwxyz\r\noutput');
    await page.evaluate(async snapshot => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(snapshot);
      h.adapter.setInputEnabled(true);
    }, await engine.snapshot());
    const cell = await terminalCellGeometry(page);
    await page.mouse.move(cell.x + 2.1 * cell.width, cell.y);
    await page.mouse.down();
    await page.mouse.move(cell.x + 5.1 * cell.width, cell.y);
    await engine.write(' continues');
    const finishFrame = await pauseFrameCompletion(page, await engine.snapshot());
    await page.mouse.move(cell.x + 12.1 * cell.width, cell.y);
    await page.mouse.up();
    await finishFrame();
    assert.equal(await page.evaluate(() => (window as any).mongleTerminalTest.terminal.getSelection()), 'cdefghijkl');
    await page.mouse.move(cell.x + 20.1 * cell.width, cell.y);
    assert.deepEqual(await page.evaluate(() => {
      const h = (window as any).mongleTerminalTest;
      return { selected: h.terminal.getSelection(), inputs: h.inputs };
    }), { selected: 'cdefghijkl', inputs: [] }, 'mouseup during parsing must not leave a drag listener active');
  }));

test('real Chrome: typing during a pending frame cancels old selection without swallowing the key', browserOptions,
  async () => withTerminalBrowser(async (page, engine) => {
    await engine.write('abcdefghijklmnopqrstuvwxyz\r\noutput');
    await page.evaluate(async snapshot => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(snapshot);
      h.adapter.setInputEnabled(true);
      h.terminal.focus();
    }, await engine.snapshot());
    const cell = await terminalCellGeometry(page);
    await page.mouse.move(cell.x + 2.1 * cell.width, cell.y);
    await page.mouse.down();
    await page.mouse.move(cell.x + 5.1 * cell.width, cell.y);
    await engine.write(' continues');
    const finishFrame = await pauseFrameCompletion(page, await engine.snapshot());
    await page.keyboard.press('x');
    await finishFrame();
    await page.mouse.move(cell.x + 12.1 * cell.width, cell.y);
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => {
      const h = (window as any).mongleTerminalTest;
      return { selected: h.terminal.getSelection(), inputs: h.inputs };
    }), { selected: '', inputs: [['x', 'utf8']] }, 'a frame must not resurrect selection cleared by deliberate typing');
  }));

test('real Chrome: a new mouse selection during a pending frame replaces the previous drag', browserOptions,
  async () => withTerminalBrowser(async (page, engine) => {
    await engine.write('abcdefghijklmnopqrstuvwxyz\r\noutput');
    await page.evaluate(async snapshot => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(snapshot);
      h.adapter.setInputEnabled(true);
    }, await engine.snapshot());
    const cell = await terminalCellGeometry(page);
    await page.mouse.move(cell.x + 2.1 * cell.width, cell.y);
    await page.mouse.down();
    await page.mouse.move(cell.x + 5.1 * cell.width, cell.y);
    await engine.write(' continues');
    const finishFrame = await pauseFrameCompletion(page, await engine.snapshot());
    await page.mouse.up();
    await page.mouse.move(cell.x + 15.1 * cell.width, cell.y);
    await page.mouse.down();
    await page.mouse.move(cell.x + 20.1 * cell.width, cell.y);
    assert.equal(await page.evaluate(() => (window as any).mongleTerminalTest.terminal.getSelection()), 'pqrst');
    await finishFrame();
    await page.mouse.move(cell.x + 23.1 * cell.width, cell.y);
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => {
      const h = (window as any).mongleTerminalTest;
      return { selected: h.terminal.getSelection(), inputs: h.inputs };
    }), { selected: 'pqrstuvw', inputs: [] }, 'restoring an older gesture cannot overwrite a new mouse selection');
  }));

test('real Chrome: changed text cancels an active selection instead of moving it to replacement output', browserOptions,
  async () => withTerminalBrowser(async (page, engine) => {
    await engine.write('abcdefghijklmnopqrstuvwxyz');
    await page.evaluate(async snapshot => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(snapshot);
      h.adapter.setInputEnabled(true);
    }, await engine.snapshot());
    const cell = await terminalCellGeometry(page);
    await page.mouse.move(cell.x + 2.1 * cell.width, cell.y);
    await page.mouse.down();
    await page.mouse.move(cell.x + 5.1 * cell.width, cell.y);
    await engine.write('\rABCDEFGHIJKLMNOPQRSTUVWXYZ');
    await page.evaluate(async snapshot => {
      await (window as any).mongleTerminalTest.adapter.applySnapshot(snapshot);
    }, await engine.snapshot());
    await page.mouse.move(cell.x + 12.1 * cell.width, cell.y);
    await page.mouse.up();
    assert.deepEqual(await page.evaluate(() => {
      const h = (window as any).mongleTerminalTest;
      return { selected: h.terminal.getSelection(), inputs: h.inputs };
    }), { selected: '', inputs: [] });
  }));

async function terminalCellGeometry(page: Page) {
  const rect = await page.locator('.xterm-screen').boundingBox();
  assert.ok(rect);
  return { x: rect.x, y: rect.y + rect.height / 16, width: rect.width / 40 };
}

/** Hold the write callback after parsing, so input races do not depend on timing. */
async function pauseFrameCompletion(page: Page, snapshot: Awaited<ReturnType<TerminalEngine['snapshot']>>) {
  await page.evaluate(frame => {
    const h = (window as any).mongleTerminalTest;
    const original = h.terminal.write;
    h.terminal.write = (data: string, done: () => void) => original.call(h.terminal, data, () => {
      h.finishFrameWrite = () => { h.terminal.write = original; done(); };
    });
    h.heldFrame = h.adapter.applySnapshot(frame);
  }, snapshot);
  await page.waitForFunction(() => typeof (window as any).mongleTerminalTest.finishFrameWrite === 'function');
  return async () => {
    await page.evaluate(async () => {
      const h = (window as any).mongleTerminalTest;
      h.finishFrameWrite();
      await h.heldFrame;
      delete h.finishFrameWrite;
      delete h.heldFrame;
    });
  };
}

test('real Chrome: composing Korean commits before one modified Enter and never replays after gate loss',browserOptions,async()=>withTerminalBrowser(async(page,engine)=>{
  await engine.write('\x1b[?9001h');
  await page.evaluate(async snapshot=>{const h=(window as any).mongleTerminalTest;await h.adapter.applySnapshot(snapshot);h.adapter.setInputEnabled(true);h.terminal.focus();},await engine.snapshot());
  const cdp=await page.context().newCDPSession(page);
  const compose=async()=>{
    await cdp.send('Input.imeSetComposition',{text:'한',selectionStart:1,selectionEnd:1});
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Process',code:'Enter',windowsVirtualKeyCode:229,nativeVirtualKeyCode:13,modifiers:8});
  };
  await compose();
  assert.deepEqual(await page.evaluate(()=>(window as any).mongleTerminalTest.inputs),[],'no input before composition commits');
  await cdp.send('Input.insertText',{text:'한'});
  await page.waitForTimeout(50);
  const expected='한\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_';
  assert.equal(await page.evaluate(()=>(window as any).mongleTerminalTest.inputs.map((v:string[])=>v[0]).join('')),expected);
  await page.evaluate(()=>{const h=(window as any).mongleTerminalTest;h.inputs.length=0;});
  await compose();
  await page.evaluate(()=>{const h=(window as any).mongleTerminalTest;h.adapter.setInputEnabled(false);h.adapter.setInputEnabled(true);});
  await cdp.send('Input.insertText',{text:'한'});await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(()=>(window as any).mongleTerminalTest.inputs),[],'gate loss cancels both composition and queued Enter');
  await compose();
  await page.evaluate(()=>(window as any).mongleTerminalTest.adapter.setFocused(false));
  await cdp.send('Input.insertText',{text:'한'});await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>(window as any).mongleTerminalTest.inputs.map((v:string[])=>v[0]).join('')),'한','selection loss cancels the deferred Enter');
  await page.evaluate(()=>{const h=(window as any).mongleTerminalTest;h.inputs.length=0;h.adapter.setFocused(true);});
  await cdp.send('Input.imeSetComposition',{text:'글',selectionStart:1,selectionEnd:1});
  await cdp.send('Input.insertText',{text:'글'});
  await page.keyboard.press('Shift+Enter');await page.waitForTimeout(50);
  assert.equal(await page.evaluate(()=>(window as any).mongleTerminalTest.inputs.map((v:string[])=>v[0]).join('')),expected.replace('한','글'),'post-composition Shift+Enter remains one newline');
  // A following key can arrive before xterm's composition commit timer. Keep
  // the newline between the committed syllable and that following key.
  await page.evaluate(()=>{
    const h=(window as any).mongleTerminalTest,textarea=h.terminal.textarea;
    h.inputs.length=0;textarea.value='';
    textarea.dispatchEvent(new CompositionEvent('compositionstart'));
    textarea.value='한';textarea.dispatchEvent(new CompositionEvent('compositionupdate',{data:'한'}));
  });
  await page.waitForTimeout(20);
  const fastInput=await page.evaluate(async()=>{
    const h=(window as any).mongleTerminalTest,textarea=h.terminal.textarea;
    textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',code:'Enter',keyCode:229,shiftKey:true,isComposing:true,bubbles:true}));
    textarea.dispatchEvent(new CompositionEvent('compositionend',{data:'한'}));
    textarea.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',code:'ArrowLeft',keyCode:37,bubbles:true}));
    await new Promise(resolve=>setTimeout(resolve,20));
    return h.inputs.map((v:string[])=>v[0]).join('');
  });
  assert.equal(fastInput,expected+'\x1b[D','the next key cannot cancel or overtake a committed composition newline');
  await cdp.detach();
}));

test('real Chrome: modified Enter preserves ConPTY modifiers across frames and respects input and IME gates',browserOptions,async()=>withTerminalBrowser(async(page,engine)=>{
  await engine.write('\x1b[?9001h');
  const frame=await engine.snapshot();
  await page.evaluate(async snapshot=>{const h=(window as any).mongleTerminalTest;await h.adapter.applySnapshot(snapshot);h.adapter.setInputEnabled(true);h.terminal.focus();},frame);
  await page.keyboard.press('Shift+Enter');await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(()=>(window as any).mongleTerminalTest.inputs.map((item:string[])=>item[0])),['\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_','\r']);
  await page.evaluate(async snapshot=>{const h=(window as any).mongleTerminalTest;await h.adapter.applySnapshot(snapshot);h.inputs.length=0;h.adapter.setInputEnabled(false);},frame);
  await page.keyboard.press('Shift+Enter');
  assert.deepEqual(await page.evaluate(()=>(window as any).mongleTerminalTest.inputs),[]);
  await page.evaluate(()=>{const h=(window as any).mongleTerminalTest;h.adapter.setInputEnabled(true);h.terminal.textarea.dispatchEvent(new CompositionEvent('compositionstart'));});
  await page.keyboard.press('Shift+Enter');
  assert.equal(await page.evaluate(()=>(window as any).mongleTerminalTest.inputs.some((item:string[])=>item[0].includes('[13;'))),false);
  await page.evaluate(()=>{const h=(window as any).mongleTerminalTest;h.terminal.textarea.dispatchEvent(new CompositionEvent('compositionend'));});
  await page.waitForTimeout(40);
  await engine.write('\x1b[?9001l');
  await page.evaluate(async snapshot=>{const h=(window as any).mongleTerminalTest;await h.adapter.applySnapshot(snapshot);h.inputs.length=0;},await engine.snapshot());
  await page.keyboard.press('Shift+Enter');
  assert.deepEqual(await page.evaluate(()=>(window as any).mongleTerminalTest.inputs.map((item:string[])=>item[0])),['\r']);
}));

test('real Chrome: light theme renders ANSI white, bright colors and true color with readable contrast', browserOptions, async () => withTerminalBrowser(async (page, engine) => {
  await engine.write(Array.from({ length: 16 }, (_, i) => `\x1b[${i < 8 ? 30 + i : 90 + i - 8}mX`).join('') + '\x1b[38;5;255mX\x1b[38;2;250;250;250mX');
  await page.evaluate(async snapshot => {
    const h = (window as any).mongleTerminalTest;
    h.terminal.options.theme = h.terminalThemes.light;
    h.terminal.options.minimumContrastRatio = h.terminalMinimumContrast;
    await h.adapter.applySnapshot(snapshot);
  }, await engine.snapshot());
  await page.waitForFunction(() => document.querySelector('.xterm-rows')?.textContent?.includes('XXXXXXXXXXXXXXXXXX'));
  const colors = await page.locator('.xterm-rows').evaluate(element => Array.from(element.querySelectorAll('span')).filter(span => span.textContent?.includes('X')).map(span => getComputedStyle(span).color));
  assert.equal(colors.length, 18);
  for (const color of colors) {
    const channels = color.match(/\d+/g)!.slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
    assert.ok(1.05 / (luminance + 0.05) >= 4.45, `low contrast: ${color}`);
  }
}));

test('real Chrome IME: consecutive Korean syllables survive host echo frames', browserOptions, async () => withTerminalBrowser(async (page, engine) => {
  const frame = await engine.snapshot();
  await page.evaluate(async snapshot => {
    const h = (window as any).mongleTerminalTest;
    await h.adapter.applySnapshot(snapshot);
    h.adapter.setInputEnabled(true); h.terminal.focus();
    h.frames = setInterval(() => { void h.adapter.applySnapshot(snapshot); }, 5);
  }, frame);
  const cdp = await page.context().newCDPSession(page);
  for (const syllable of ['한', '글', '입', '력']) {
    await cdp.send('Input.imeSetComposition', { text: syllable, selectionStart: 1, selectionEnd: 1 });
    await page.evaluate(snapshot => {
      const h = (window as any).mongleTerminalTest;
      clearInterval(h.frames); h.echoApplied = false;
      void h.adapter.applySnapshot({ ...snapshot, data: 'host echo' }).then(() => { h.echoApplied = true; });
    }, frame);
    await page.waitForFunction(() => (window as any).mongleTerminalTest.echoApplied, undefined, { timeout: 2000 });
    assert.equal(await page.locator('.composition-view').textContent(), syllable);
    await cdp.send('Input.insertText', { text: syllable });
    await page.waitForTimeout(30);
  }
  await page.evaluate(() => clearInterval((window as any).mongleTerminalTest.frames));
  const inputs = await page.evaluate(() => (window as any).mongleTerminalTest.inputs.map((item: string[]) => item[0]).join(''));
  assert.equal(inputs, '한글입력');
}));

test('real Chrome: a slow full-frame write never paints the reset or partial screen',
  browserOptions, async () => withTerminalBrowser(async (page, engine) => {
    await engine.write('old complete screen');
    const before = await engine.snapshot();
    await engine.write('\r\x1b[2Knew complete screen');
    const after = await engine.snapshot();
    await page.evaluate('window.__name = (value) => value');
    const result = await page.evaluate(async ({ before, after }) => {
      const { terminal, adapter } = (window as any).mongleTerminalTest;
      const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
      await adapter.applySnapshot(before);
      await tick(); await tick();
      const original = terminal.write.bind(terminal);
      // Exercise a parser yield across multiple display refreshes, as happens
      // with large history/full-screen updates on slower devices.
      terminal.write = (data: string, done: () => void) => {
        setTimeout(() => original(data.slice(0, 3), () => {
          setTimeout(() => original(data.slice(3), done), 80);
        }), 80);
      };
      const paints: string[] = [];
      const sub = terminal.onRender(() => {
        paints.push(terminal.element.querySelector('.xterm-rows').textContent);
      });
      await adapter.applySnapshot(after);
      await tick(); await tick();
      sub.dispose(); terminal.write = original;
      return { paints, final: terminal.element.querySelector('.xterm-rows').textContent };
    }, { before, after });
    assert.ok(result.paints.length > 0);
    assert.ok(result.paints.every(text => text.includes('new complete screen')), JSON.stringify(result.paints));
    assert.ok(result.final.includes('new complete screen'));
  }));

for (const buffer of ['normal history', 'alternate buffer'] as const) {
  test(`real Chrome: animation frames retain complete pictures during ${buffer} streaming`,
    browserOptions, async () => withTerminalBrowser(async (page, engine) => {
      await engine.write(Array.from({ length: 24 }, (_, index) => `history row ${index}\r\n`).join(''));
      if (buffer === 'alternate buffer') await engine.write('\x1b[?1049h\x1b[H');
      await engine.write('streamed answer 0');
      const frames = [await engine.snapshot()];
      for (let index = 1; index <= 3; index++) {
        await engine.write(`\r\x1b[2Kstreamed answer ${index}: ${'complete '.repeat(index)}`);
        frames.push(await engine.snapshot());
      }
      // Reset also activates the normal buffer, and serialized alternate frames
      // activate the alternate buffer again. Both paths clear DOM rows directly
      // without an onRender notification, so observe the actual DOM every RAF.
      await page.evaluate('window.__name = (value) => value');
      const result = await page.evaluate(async ({ frames, buffer }) => {
        const { terminal, adapter } = (window as any).mongleTerminalTest;
        const tick = () => new Promise(resolve => requestAnimationFrame(resolve));
        const picture = () => terminal.element.querySelector('.xterm-rows').textContent as string;
        const expected: string[] = [];
        for (const frame of frames) {
          await adapter.applySnapshot(frame);
          await tick(); await tick();
          expected.push(picture());
        }
        await adapter.applySnapshot(frames[0]);
        await tick(); await tick();
        // Preserve a real selection, exercising its independently scheduled DOM
        // redraw while a replacement presentation is still being parsed.
        terminal.select(0, terminal.buffer.active.viewportY + (buffer === 'normal history' ? 3 : 0), 3);
        await tick(); await tick();
        const original = terminal.write.bind(terminal);
        terminal.write = (data: string, done: () => void) => {
          setTimeout(() => original(data.slice(0, 3), () => {
            setTimeout(() => original(data.slice(3), done), 50);
          }), 50);
        };
        const invalid: Array<{ frame: number; text: string }> = [];
        const selectionMissing: number[] = [];
        let samples = 0;
        try {
          for (let index = 1; index < frames.length; index++) {
            let sampling = true;
            let handle = 0;
            const sample = () => {
              if (!sampling) return;
              const text = picture();
              samples++;
              if (text !== expected[index - 1] && text !== expected[index]) invalid.push({ frame: index, text });
              handle = requestAnimationFrame(sample);
            };
            handle = requestAnimationFrame(sample);
            await adapter.applySnapshot(frames[index]);
            if (!terminal.element.querySelector('.xterm-selection')?.children.length) selectionMissing.push(index);
            await tick(); await tick();
            sampling = false;
            cancelAnimationFrame(handle);
          }
        } finally { terminal.write = original; }
        return { samples, invalid, selectionMissing, final: picture(), expected: expected.at(-1) };
      }, { frames, buffer });
      assert.ok(result.samples >= frames.length - 1, 'sample each streamed presentation independently of xterm render events');
      assert.deepEqual(result.invalid, [], 'the DOM must keep the old picture until the complete next picture is ready');
      assert.deepEqual(result.selectionMissing, [], 'a completed frame retains the selection without waiting for another repaint');
      assert.equal(result.final, result.expected);
    }));
}

test('real Chrome: replay captured GJC output through host frames without blank paints',
  { ...browserOptions, skip: !process.env.MONGLE_GJC_CAPTURE || !chrome }, async () => withTerminalBrowser(async (page, engine) => {
    const chunks: Array<{ ms: number; data: string }> = JSON.parse(readFileSync(process.env.MONGLE_GJC_CAPTURE!, 'utf8'));
    await engine.resize(100, 30);
    await page.evaluate(() => {
      const h = (window as any).mongleTerminalTest;
      h.paints = 0; h.blankPaints = 0; h.seenContent = false;
      h.terminal.onRender(() => {
        const text = h.terminal.element.querySelector('.xterm-rows').textContent.trim();
        if (text) h.seenContent = true;
        if (h.seenContent && !text) h.blankPaints++;
        h.paints++;
      });
    });
    let inFlight = false;
    const tasks: Promise<void>[] = [];
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      tasks.push(engine.snapshot().then(frame => page.evaluate(async snapshot => {
        await (window as any).mongleTerminalTest.adapter.applySnapshot(snapshot);
      }, frame)).finally(() => { inFlight = false; }));
    }, 60);
    try {
      const start = Date.now();
      for (const chunk of chunks) {
        await new Promise(resolve => setTimeout(resolve, Math.max(0, chunk.ms - (Date.now() - start))));
        await engine.write(chunk.data);
      }
    } finally { clearInterval(timer); await Promise.all(tasks); }
    await page.evaluate(async snapshot => {
      await (window as any).mongleTerminalTest.adapter.applySnapshot(snapshot);
      await new Promise(resolve => requestAnimationFrame(resolve));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }, await engine.snapshot());
    const result = await page.evaluate(() => {
      const h = (window as any).mongleTerminalTest;
      return { paints: h.paints, blankPaints: h.blankPaints, text: h.terminal.element.querySelector('.xterm-rows').textContent };
    });
    assert.ok(result.paints > 10);
    assert.equal(result.blankPaints, 0);
    assert.ok(result.text.includes('flicker-check'));
  }));

async function withTerminalBrowser(check: (page: Page, engine: TerminalEngine) => Promise<void>, mobile = false) {
    const bundle = await build({ entryPoints: [fileURLToPath(new URL('./browser-harness.ts', import.meta.url))], bundle: true, write: false, format: 'iife', platform: 'browser' });
    const css = readFileSync(new URL('../../node_modules/@xterm/xterm/css/xterm.css', import.meta.url));
    const server = createServer((req, res) => {
      if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
      else if (req.url === '/xterm.css') { res.setHeader('Content-Type', 'text/css'); res.end(css); }
      else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><link rel="stylesheet" href="/xterm.css"></head><body><div id="terminal" style="width:600px;height:300px"></div><script src="/app.js"></script></body></html>'); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const engine = new TerminalEngine({ cols: 40, rows: 8, onResponse() {} });
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage(mobile ? { isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } } : {});
      await page.goto(`http://127.0.0.1:${address.port}`);
      await check(page, engine);
    } finally {
      await browser.close();
      await engine.dispose();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
}

test('real Chrome: repeated frames preserve typing, application cursor, selection and IME commit',
  browserOptions, async () => withTerminalBrowser(async (page, engine) => {
      await engine.write('select me\r\n몽글 terminal\x1b[?1h\x1b[?2004h');
      const frame = await engine.snapshot();
      await page.evaluate(async snapshot => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(snapshot);
        h.adapter.setInputEnabled(true);
        h.terminal.focus();
      }, frame);
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Control+c');
      await page.evaluate(snapshot => {
        const h = (window as any).mongleTerminalTest;
        h.frames = setInterval(() => { void h.adapter.applySnapshot(snapshot); }, 5);
      }, frame);
      await page.keyboard.type('keep-all-letters', { delay: 8 });
      await page.keyboard.insertText('몽글');
      await page.evaluate(() => clearInterval((window as any).mongleTerminalTest.frames));
      await page.evaluate(async snapshot => {
        const h = (window as any).mongleTerminalTest;
        await h.adapter.applySnapshot(snapshot);
        h.terminal.select(0, 0, 9);
        await h.adapter.applySnapshot(snapshot);
      }, frame);
      const result = await page.evaluate(() => {
        const h = (window as any).mongleTerminalTest;
        return { inputs: h.inputs, selected: h.terminal.getSelection() };
      });
      assert.equal(result.inputs.map((item: [string, string]) => item[0]).join(''), '\x1bOA\x03keep-all-letters몽글');
      assert.ok(result.inputs.every((item: [string, string]) => item[1] === 'utf8'));
      assert.equal(result.selected, 'select me');
      const composition = await page.evaluate(async snapshot => {
        const h = (window as any).mongleTerminalTest;
        h.terminal.clearSelection();
        const textarea = h.terminal.textarea;
        textarea.value = '';
        textarea.dispatchEvent(new CompositionEvent('compositionstart'));
        const applied = h.adapter.applySnapshot(snapshot);
        textarea.value = '한';
        textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '한' }));
        textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
        await applied;
        return h.inputs[h.inputs.length - 1];
      }, frame);
      assert.deepEqual(composition, ['한', 'utf8'], 'the deferred xterm IME commit runs before snapshot reset');
  }));

test('real Chrome mobile emulation: resize fences preserve the writable focused editor without replaying blocked input',
  browserOptions, async () => withTerminalBrowser(async (page, engine) => {
    await engine.write('mobile resize');
    const frame = await engine.snapshot();
    const initial = await page.evaluate(async snapshot => {
      const h = (window as any).mongleTerminalTest;
      await h.adapter.applySnapshot(snapshot);
      // A trusted acquire gesture must be able to open the keyboard before the
      // lease request/ACK returns, while transmission is still closed.
      h.adapter.setInputEnabled(false, { preserveKeyboard: true });
      h.terminal.focus();
      h.textarea = h.terminal.textarea;
      h.blurs = 0;
      h.readonlyMutations = 0;
      h.textarea.addEventListener('blur', () => { h.blurs += 1; });
      h.observer = new MutationObserver((records: MutationRecord[]) => {
        h.readonlyMutations += records.filter(record => record.attributeName === 'readonly').length;
      });
      h.observer.observe(h.textarea, { attributes: true });
      h.terminal.input('before acquire ACK', true);
      return { readonly: h.textarea.readOnly, focused: document.activeElement === h.textarea, inputs: h.inputs };
    }, frame);
    assert.deepEqual(initial, { readonly: false, focused: true, inputs: [] });
    await page.evaluate(() => (window as any).mongleTerminalTest.adapter.setInputEnabled(true));
    await page.keyboard.insertText('before');
    await page.evaluate(() => (window as any).mongleTerminalTest.adapter.setInputEnabled(false, { preserveKeyboard: true }));
    await page.setViewportSize({ width: 390, height: 460 });
    await page.keyboard.insertText('blocked');
    const gated = await page.evaluate(async snapshot => {
      const h = (window as any).mongleTerminalTest;
      for (let index = 0; index < 12; index += 1) {
        h.adapter.setInputEnabled(false, { preserveKeyboard: true });
        await h.adapter.applySnapshot({ ...snapshot, rows: index % 2 ? 8 : 6 });
        h.terminal.input('blocked native', true);
        h.terminal._core.coreService.triggerBinaryEvent('blocked binary');
        h.adapter.sendInput('\x03');
        h.adapter.sendKey('ArrowUp');
        h.adapter.paste('blocked paste');
      }
      return { readonly: h.textarea.readOnly, focused: document.activeElement === h.textarea,
        sameEditor: h.terminal.textarea === h.textarea, blurs: h.blurs,
        readonlyMutations: h.readonlyMutations, inputs: h.inputs };
    }, frame);
    assert.deepEqual(gated, { readonly: false, focused: true, sameEditor: true, blurs: 0,
      readonlyMutations: 0, inputs: [['before', 'utf8']] });
    await page.evaluate(() => (window as any).mongleTerminalTest.adapter.setInputEnabled(true));
    await page.keyboard.insertText('after');
    assert.deepEqual(await page.evaluate(() => (window as any).mongleTerminalTest.inputs),
      [['before', 'utf8'], ['after', 'utf8']], 'normal input resumes after the resize ACK');

    const composition = await page.evaluate(async snapshot => {
      const h = (window as any).mongleTerminalTest;
      const textarea = h.textarea;
      textarea.value = '';
      textarea.dispatchEvent(new CompositionEvent('compositionstart'));
      textarea.value = '한';
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '한' }));
      h.adapter.setInputEnabled(false, { preserveKeyboard: true });
      let rendered = false;
      const pending = h.adapter.applySnapshot(snapshot).then(() => { rendered = true; });
      await new Promise(resolve => setTimeout(resolve, 10));
      const during = { rendered, value: textarea.value, readonly: textarea.readOnly,
        focused: document.activeElement === textarea };
      h.adapter.setInputEnabled(true);
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '한' }));
      await pending;
      await new Promise(resolve => setTimeout(resolve, 10));
      // A fresh, fully authorized composition must still work.
      textarea.value = '';
      textarea.dispatchEvent(new CompositionEvent('compositionstart'));
      textarea.value = '새';
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '새' }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '새' }));
      await h.adapter.applySnapshot(snapshot);
      return { during, inputs: h.inputs, blurs: h.blurs, readonlyMutations: h.readonlyMutations };
    }, frame);
    assert.deepEqual(composition, {
      during: { rendered: true, value: '한', readonly: false, focused: true },
      inputs: [['before', 'utf8'], ['after', 'utf8'], ['새', 'utf8']], blurs: 0, readonlyMutations: 0,
    }, 'a gate does not reset a live IME; its stale commit is dropped and a fresh composition works');

    const lateInput = await page.evaluate(async () => {
      const h = (window as any).mongleTerminalTest;
      const textarea = h.textarea;
      h.adapter.setInputEnabled(false, { preserveKeyboard: true });
      textarea.value = '';
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }));
      textarea.value = '!';
      h.adapter.setInputEnabled(true);
      await new Promise(resolve => setTimeout(resolve, 10));
      h.adapter.setInputEnabled(false, { preserveKeyboard: true });
      textarea.value = '';
      textarea.dispatchEvent(new CompositionEvent('compositionstart'));
      textarea.value = '닫';
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '닫' }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '닫' }));
      h.adapter.setInputEnabled(true);
      await new Promise(resolve => setTimeout(resolve, 10));
      // Also quarantine an already scheduled composition commit across a hard
      // lease/uncertainty fence, even if a new ACK reopens it immediately.
      textarea.value = '';
      textarea.dispatchEvent(new CompositionEvent('compositionstart'));
      textarea.value = '늦';
      textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: '늦' }));
      textarea.dispatchEvent(new CompositionEvent('compositionend', { data: '늦' }));
      h.adapter.setInputEnabled(false);
      const hardReadonly = textarea.readOnly;
      h.adapter.setInputEnabled(true);
      await new Promise(resolve => setTimeout(resolve, 10));
      h.terminal.input('fresh', true);
      h.adapter.setInputEnabled(false);
      h.terminal.input('hard blocked', true);
      h.adapter.sendInput('hard blocked control');
      h.adapter.dispose();
      h.adapter.setInputEnabled(true, { preserveKeyboard: true });
      return { inputs: h.inputs, hardReadonly, disposedReadonly: textarea.readOnly };
    });
    assert.deepEqual(lateInput, { inputs: [['before', 'utf8'], ['after', 'utf8'], ['새', 'utf8'], ['fresh', 'utf8']],
      hardReadonly: true, disposedReadonly: true });
  }, true));

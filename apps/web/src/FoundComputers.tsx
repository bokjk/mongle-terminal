import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe2, LoaderCircle, Plus, RefreshCw } from 'lucide-react';
import type { ComputerSearch } from '../../../packages/client/index';

type Found = ComputerSearch['computers'][number];
type Scan = { status: 'loading' | 'done' | 'error'; result?: ComputerSearch; error?: string };

/**
 * Mongle PCs that the connected host found in the same tailnet. Choosing one adds it to the computer list
 * and connects, exactly like the address form below it; that PC then asks for its own connection approval.
 */
export function FoundComputers({find, adding, disabled, onChoose}: {find: (refresh: boolean) => Promise<ComputerSearch>; adding?: string; disabled: boolean; onChoose: (computer: Found) => void}) {
  const [scan, setScan] = useState<Scan>({status: 'loading'});
  const sequence = useRef(0);
  const section = useRef<HTMLElement>(null), refreshButton = useRef<HTMLButtonElement>(null);
  // The parent passes a new function on every render. Search once when the dialog opens, then only on request.
  const finder = useRef(find);
  finder.current = find;
  const load = useCallback(async (refresh: boolean) => {
    const id = ++sequence.current;
    setScan(previous => ({status: 'loading', result: previous.result}));
    try {
      const result = await finder.current(refresh);
      if (id !== sequence.current) return;
      // A PC can drop out of the new results. Move focus off its row first so Escape and Tab stay in the dialog.
      const focused = document.activeElement instanceof HTMLElement && section.current?.contains(document.activeElement) ? document.activeElement.dataset.origin : undefined;
      if (focused && !result.computers.some(computer => computer.origin === focused)) refreshButton.current?.focus();
      setScan({status: 'done', result});
    }
    catch (error) { if (id === sequence.current) setScan(previous => ({status: 'error', result: previous.result, error: error instanceof Error ? error.message : '다른 컴퓨터를 찾지 못했습니다.'})); }
  }, []);
  useEffect(() => { void load(false); return () => { sequence.current++; }; }, [load]);
  const computers = scan.result?.computers ?? [];
  const searching = scan.status === 'loading';
  // Buttons stay focusable while busy (aria-disabled) so Escape and Tab keep working inside the dialog.
  const blocked = disabled || Boolean(adding);
  const status = searching ? '같은 Tailscale에서 다른 몽글 PC를 찾는 중…'
    : scan.status === 'error' ? scan.error || '다른 컴퓨터를 찾지 못했습니다.'
    : scan.result && !scan.result.available ? `다른 PC를 찾지 못했습니다. ${scan.result.message ?? ''}`.trim()
    : computers.length ? `추가할 수 있는 몽글 PC ${computers.length}대를 찾았습니다.`
    : scan.result?.alreadyAdded ? '찾은 몽글 PC는 모두 컴퓨터 목록에 있습니다.'
    : '추가할 몽글 PC를 찾지 못했습니다. 그 PC의 몽글터미널과 원격 접속이 켜져 있는지 확인하거나, 아래에 주소를 직접 입력해 주세요.';
  return <section ref={section} className="found-computers panel-list" aria-labelledby="found-computers-title">
    <div className="found-computers-header">
      <h3 id="found-computers-title" className="settings-title">같은 Tailscale에서 찾은 PC</h3>
      <button ref={refreshButton} type="button" className="icon-button" aria-label={searching ? '찾는 중' : '다시 찾기'} title="다시 찾기" aria-disabled={searching || blocked} onClick={() => { if (!searching && !blocked) void load(true); }}>
        {searching ? <LoaderCircle size={15} className="spin" aria-hidden="true"/> : <RefreshCw size={15} aria-hidden="true"/>}
      </button>
    </div>
    {computers.map(computer => <div key={computer.origin} className="computer-row">
      <button type="button" className="device-row" data-origin={computer.origin} aria-label={`${computer.name} 추가하고 연결`} aria-disabled={blocked} onClick={() => { if (!blocked) onChoose(computer); }}>
        <Globe2 size={20}/><span className="device-info"><strong>{computer.name}</strong><small>{new URL(computer.origin).host}</small></span>
        {adding === computer.origin ? <LoaderCircle size={17} className="spin" aria-hidden="true"/> : <span className="found-computer-action" aria-hidden="true"><Plus size={13}/>추가</span>}
      </button>
    </div>)}
    <p className="hint computer-status" role="status"><span>{status}</span></p>
    <p className="hint">추가하면 그 PC의 연결 화면으로 넘어갑니다. 그 PC나 이미 연결된 휴대폰의 <strong>설정 → 원격 연결</strong>에서 연결 코드를 만들어 입력하고 승인하세요.</p>
  </section>;
}

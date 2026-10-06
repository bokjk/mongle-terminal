import { useRef, useState } from 'react';
import { Copy, RefreshCw, X } from 'lucide-react';

export interface CopyRecord { text:string; lineCount:number; truncated:boolean; capturedAt:number; }

/** A detached string: live terminal renders must never replace an active selection. */
export function TerminalCopyView({capture,onClose}:{capture():Promise<CopyRecord>;onClose():void}) {
  const [record,setRecord]=useState<CopyRecord>();
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [selected,setSelected]=useState(false);
  const text=useRef<HTMLTextAreaElement>(null);
  const request=useRef(0);
  async function load(){
    const id=++request.current;setBusy(true);setMessage('');
    try{const next=await capture();if(id===request.current){setRecord(next);setSelected(false);}}
    catch(error){if(id===request.current)setMessage(error instanceof Error?error.message:'기록을 가져오지 못했습니다.');}
    finally{if(id===request.current)setBusy(false);}
  }
  async function copy(all=false){
    const value=all?record?.text:text.current?.value.slice(text.current.selectionStart,text.current.selectionEnd);
    if(!value)return;
    try{if(window.mongle?.writeClipboard)await window.mongle.writeClipboard(value);else await navigator.clipboard.writeText(value);setMessage(all?'가져온 기록을 모두 복사했습니다.':'선택한 내용을 복사했습니다.');}
    catch{setMessage('복사하지 못했습니다. 내용을 선택한 뒤 Ctrl+C를 사용해 주세요.');}
  }
  return <aside className="terminal-copy-view" aria-label="기록 복사 보기">
    <header><strong>기록 복사 보기</strong><button className="icon-button" aria-label="기록 복사 보기 닫기" onClick={()=>{request.current++;onClose();}}><X size={15}/></button></header>
    <div className="copy-view-guide">
      <p>Claude 전체화면에서는 터미널에 <kbd>Ctrl+O</kbd> → <kbd>[</kbd>를 누른 뒤 기록을 가져오세요.</p>
      <p>가져온 뒤 터미널에서 <kbd>Esc</kbd>로 돌아가도 이곳의 내용은 유지됩니다. 새 출력은 자동으로 반영되지 않습니다.</p>
      <p>내용을 드래그한 뒤 <kbd>Ctrl+C</kbd> 또는 선택 복사를 누르세요.</p>
      <button className="button subtle" disabled={busy} onClick={()=>void load()}><RefreshCw size={13}/>{busy?'가져오는 중…':record?'현재 기록으로 새로 가져오기':'현재 기록 가져오기'}</button>
    </div>
    {record?<>
      <div className="copy-view-meta">{record.lineCount.toLocaleString()}줄 · {new Date(record.capturedAt).toLocaleTimeString()}에 가져옴</div>
      {record.truncated&&<p className="copy-view-warning" role="status">오래된 기록 일부가 생략됐을 수 있습니다. 가져온 범위를 확인하세요.</p>}
      <textarea ref={text} aria-label="복사할 기록" readOnly spellCheck={false} wrap="off" value={record.text} onSelect={event=>setSelected(event.currentTarget.selectionStart!==event.currentTarget.selectionEnd)} onKeyDown={event=>{
        if((event.ctrlKey||event.metaKey)&&event.shiftKey&&!event.altKey&&event.key.toLowerCase()==='c'){event.preventDefault();event.stopPropagation();void copy();}
      }}/>
      <div className="copy-view-actions"><button className="button subtle" disabled={!selected} onMouseDown={event=>event.preventDefault()} onClick={()=>void copy()}><Copy size={13}/>선택 복사</button><button className="button subtle" onClick={()=>void copy(true)}>전체 복사</button></div>
    </>:<div className="copy-view-empty">기록을 가져오면 새 출력에 방해받지 않고 드래그해 복사할 수 있습니다.</div>}
    {message&&<p className="copy-view-message" role="status">{message}</p>}
  </aside>;
}

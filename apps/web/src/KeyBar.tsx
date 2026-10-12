import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Keyboard } from 'lucide-react';
import { keyBarKey, type KeyBarArrow, type KeyBarModifier } from './key-bar';

const ARROWS: Record<KeyBarArrow, typeof ArrowLeft> = { left: ArrowLeft, down: ArrowDown, up: ArrowUp, right: ArrowRight };

/** What one key shows: its arrow icon or its short label. */
export function KeyCap({ id }: { id: string }) {
  const key = keyBarKey(id);
  if (!key) return null;
  if (key.kind === 'key' && key.arrow) { const Icon = ARROWS[key.arrow]; return <Icon size={17} aria-hidden="true"/>; }
  return <>{key.label}</>;
}

type Props = { ids: readonly string[]; modifiers: Record<KeyBarModifier, boolean>; onKey(data: string): void; onModifier(modifier: KeyBarModifier): void; onKeyboard(): void };

/** The bar above the phone keyboard. Buttons never take focus, so the on-screen keyboard stays open. */
export function MobileKeyBar({ ids, modifiers, onKey, onModifier, onKeyboard }: Props) {
  const hold = (event: React.PointerEvent) => event.preventDefault();
  return <div className="mobile-keys" aria-label="터미널 보조 키">
    <div className="mobile-keys-list">{ids.map(id => {
      const key = keyBarKey(id);
      if (!key) return null;
      if (key.kind === 'modifier') {
        const on = modifiers[key.modifier];
        return <button key={id} type="button" className={`key-button ${on ? 'latched' : ''}`} aria-pressed={on} onPointerDown={hold} onClick={() => onModifier(key.modifier)}>{key.label}</button>;
      }
      return <button key={id} type="button" className="key-button" aria-label={key.aria} onPointerDown={hold} onClick={() => onKey(key.data)}><KeyCap id={id}/></button>;
    })}</div>
    <button type="button" className="key-button key-keyboard" aria-label="키보드 열기" onPointerDown={hold} onClick={onKeyboard}><Keyboard size={18}/></button>
  </div>;
}

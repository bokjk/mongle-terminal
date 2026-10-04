import { useEffect, useRef } from 'react';
import { basicSetup, EditorView } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { historyField, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { python } from '@codemirror/lang-python';
import { isMarkdown } from './use-file-documents';

function language(path: string) {
  if (isMarkdown(path)) return markdown({ base: markdownLanguage });
  if (/\.[cm]?[jt]sx?$/i.test(path)) return javascript({ typescript: /\.tsx?$/i.test(path), jsx: /\.[jt]sx$/i.test(path) });
  if (/\.json$/i.test(path)) return json();
  if (/\.html?$/i.test(path)) return html();
  if (/\.css$/i.test(path)) return css();
  if (/\.py$/i.test(path)) return python();
  return [];
}
const highlighting = HighlightStyle.define([
  { tag: [tags.keyword, tags.heading], color: 'var(--editor-keyword)' },
  { tag: [tags.string, tags.attributeValue, tags.url], color: 'var(--editor-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--editor-number)' },
  { tag: tags.comment, color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: 'bold' }, { tag: tags.emphasis, fontStyle: 'italic' },
]);
export type EditorSession = { json?: ReturnType<EditorState['toJSON']>; scrollTop?: number; scrollLeft?: number };
type Props = { path: string; value: string; session: EditorSession; readOnly: boolean; active: boolean; onChange(value: string): void; onSave(): void };
export function CodeEditor(props: Props) {
  const parent = useRef<HTMLDivElement>(null), view = useRef<EditorView>(undefined);
  const callbacks = useRef(props); callbacks.current = props;
  const readOnly = useRef(new Compartment());
  const replacing = useRef(false);
  useEffect(() => {
    const config = { doc: props.value, extensions: [
      basicSetup, language(props.path), syntaxHighlighting(highlighting), EditorView.lineWrapping,
      EditorState.lineSeparator.of(props.value.includes('\r\n') ? '\r\n' : props.value.includes('\r') && !props.value.includes('\n') ? '\r' : '\n'),
      readOnly.current.of(EditorState.readOnly.of(props.readOnly)),
      EditorView.contentAttributes.of({ 'aria-label': `파일 내용: ${props.path}`, 'aria-multiline': 'true', spellcheck: 'false' }),
      keymap.of([{ key: 'Mod-s', run: () => { callbacks.current.onSave(); return true; } }, indentWithTab]),
      EditorView.updateListener.of(update => { if (update.docChanged && !replacing.current) callbacks.current.onChange(update.state.sliceDoc()); }),
      EditorView.theme({ '&': { height: '100%', backgroundColor: 'var(--terminal)', color: 'var(--text)' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--mono)', fontSize: '13px', lineHeight: '1.7' }, '.cm-content': { padding: '14px 0', caretColor: 'var(--text)' }, '.cm-gutters': { backgroundColor: 'var(--terminal)', color: 'var(--text-secondary)', border: 'none', paddingRight: '8px' }, '.cm-line': { padding: '0 16px 0 6px' }, '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--accent-dim)' }, '&.cm-focused': { outline: 'none' }, '.cm-cursor': { borderLeftColor: 'var(--text)' }, '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--editor-selection)' }, '.cm-panels, .cm-tooltip': { backgroundColor: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--border)' }, '.cm-textfield, .cm-button': { color: 'var(--text)', background: 'var(--surface-raised)', borderColor: 'var(--border)' } }),
    ] };
    // Restore data only, with fresh callbacks/compartments for this mounted view.
    const saved = props.session.json;
    const state = saved?.doc === props.value ? EditorState.fromJSON(saved, config, { history: historyField }) : EditorState.create(config);
    delete props.session.json;
    const editor = view.current = new EditorView({ parent: parent.current!, state });
    if (saved?.doc === props.value) editor.requestMeasure({ read: () => null, write: () => {
      editor.scrollDOM.scrollTop = props.session.scrollTop || 0;
      editor.scrollDOM.scrollLeft = props.session.scrollLeft || 0;
    } });
    return () => {
      props.session.json = editor.state.toJSON({ history: historyField });
      props.session.scrollTop = editor.scrollDOM.scrollTop; props.session.scrollLeft = editor.scrollDOM.scrollLeft;
      editor.destroy(); view.current = undefined;
    };
  }, [props.path, props.session]);
  useEffect(() => {
    const editor = view.current; if (!editor || editor.state.sliceDoc() === props.value) return;
    replacing.current = true;
    try { editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: props.value } }); }
    finally { replacing.current = false; }
  }, [props.value]);
  useEffect(() => { view.current?.dispatch({ effects: readOnly.current.reconfigure(EditorState.readOnly.of(props.readOnly)) }); }, [props.readOnly]);
  useEffect(() => { if (props.active) view.current?.requestMeasure(); }, [props.active]);
  return <div className="code-editor" ref={parent}/>;
}

import { useEffect, useRef } from 'react';
import { indentLess, indentMore } from '@codemirror/commands';
import { markdown, markdownKeymap } from '@codemirror/lang-markdown';
import { Compartment, EditorSelection, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { basicSetup } from 'codemirror';

type NoteEditorProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

function toggleInlineMarkup(view: EditorView, marker: string): boolean {
  const { state } = view;
  const range = state.selection.main;

  if (range.empty) {
    view.dispatch({
      changes: { from: range.from, insert: `${marker}${marker}` },
      selection: EditorSelection.cursor(range.from + marker.length),
    });
    return true;
  }

  const selectedText = state.doc.sliceString(range.from, range.to);
  const beforeFrom = range.from - marker.length;
  const afterTo = range.to + marker.length;
  const hasMarkup =
    beforeFrom >= 0 &&
    state.doc.sliceString(beforeFrom, range.from) === marker &&
    state.doc.sliceString(range.to, afterTo) === marker;

  if (hasMarkup) {
    view.dispatch({
      changes: [
        { from: beforeFrom, to: range.from },
        { from: afterTo - marker.length, to: afterTo },
      ],
      selection: EditorSelection.range(beforeFrom, beforeFrom + selectedText.length),
    });
    return true;
  }

  view.dispatch({
    changes: [
      { from: range.from, insert: marker },
      { from: range.to, insert: marker },
    ],
    selection: EditorSelection.range(range.from + marker.length, range.to + marker.length),
  });
  return true;
}

function insertMarkdownLink(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const linkText = range.empty ? 'text' : state.doc.sliceString(range.from, range.to);
  const link = `[${linkText}](url)`;
  const urlStart = range.from + link.length - 4;

  view.dispatch({
    changes: { from: range.from, to: range.to, insert: link },
    selection: EditorSelection.range(urlStart, urlStart + 3),
  });
  return true;
}

const shioriMarkdownKeymap = Prec.highest(
  keymap.of([
    ...markdownKeymap,
    { key: 'Tab', run: indentMore },
    { key: 'Shift-Tab', run: indentLess },
    { key: 'Mod-b', run: (view) => toggleInlineMarkup(view, '**') },
    { key: 'Mod-i', run: (view) => toggleInlineMarkup(view, '*') },
    { key: 'Mod-e', run: (view) => toggleInlineMarkup(view, '`') },
    { key: 'Mod-k', run: insertMarkdownLink },
  ]),
);

const shioriEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '0',
    backgroundColor: 'transparent',
    color: '#262522',
    fontSize: '17px',
  },
  '&.cm-focused': {
    outline: '0',
  },
  '.cm-scroller': {
    fontFamily: 'inherit',
    lineHeight: '1.75',
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: '#262522',
    padding: '0 0 40px',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-gutters': {
    display: 'none',
  },
  '.cm-activeLine': {
    backgroundColor: 'rgba(98, 129, 103, 0.08)',
  },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
    backgroundColor: 'rgba(98, 129, 103, 0.22)',
  },
  '.cm-placeholder': {
    color: '#8e887d',
  },
});

export function NoteEditor({ value, onChange, disabled = false }: NoteEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const isSyncingExternalValueRef = useRef(false);
  const editableCompartmentRef = useRef(new Compartment());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const editor = new EditorView({
      parent: container,
      doc: value,
      extensions: [
        basicSetup,
        markdown({ addKeymap: false }),
        shioriMarkdownKeymap,
        placeholder('Markdownで本文を入力'),
        shioriEditorTheme,
        editableCompartmentRef.current.of(EditorView.editable.of(!disabled)),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !isSyncingExternalValueRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
      ],
    });

    editorRef.current = editor;

    return () => {
      editor.destroy();
      editorRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    const currentValue = editor.state.doc.toString();
    if (currentValue === value) {
      return;
    }

    isSyncingExternalValueRef.current = true;
    try {
      editor.dispatch({
        changes: { from: 0, to: currentValue.length, insert: value },
      });
    } finally {
      isSyncingExternalValueRef.current = false;
    }
  }, [value]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    editor.dispatch({
      effects: editableCompartmentRef.current.reconfigure(EditorView.editable.of(!disabled)),
    });
  }, [disabled]);

  return <div className="note-editor" ref={containerRef} />;
}

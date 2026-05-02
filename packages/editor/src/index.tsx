type NoteEditorProps = {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
};

export function NoteEditor({ value, onChange, disabled = false }: NoteEditorProps) {
  return (
    <textarea
      className="note-editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
      spellCheck
    />
  );
}


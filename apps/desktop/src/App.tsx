import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { NoteEditor } from '@shiori/editor';
import {
  formatRelativeTime,
  normalizeTagName,
  uniqueTagNames,
  type LocalSyncSummary,
  type NoteWithTags,
  type SaveState,
  type SyncEvent,
  type Tag,
} from '@shiori/core';
import {
  Archive,
  Check,
  Circle,
  Cloud,
  Columns2,
  Eye,
  HelpCircle,
  FilePlus,
  LogIn,
  LogOut,
  Mail,
  Pencil,
  RefreshCw,
  Search,
  Tag as TagIcon,
  Trash,
  Trash2,
} from 'lucide-react';
import {
  getAuthSnapshot,
  sendMagicLink,
  signOut,
  subscribeToAuthChanges,
  type AuthSnapshot,
} from './auth';
import { syncWithSupabase } from './cloudSync';
import { LocalNoteStore, describeTags } from './storage';
import { useDebouncedEffect } from './useDebouncedEffect';

const store = new LocalNoteStore();

type SyncState = 'idle' | 'syncing' | 'synced' | 'failed';
type EditorMode = 'edit' | 'preview' | 'split';

const autoSyncIntervalMs = 30_000;
const autoSyncAfterChangeMs = 2_500;

function saveStateLabel(state: SaveState): string {
  switch (state) {
    case 'dirty':
      return '未保存の変更があります';
    case 'saving':
      return '保存中';
    case 'error':
      return '保存に失敗しました';
    case 'saved':
    default:
      return '保存済み';
  }
}

function authLabel(auth: AuthSnapshot): string {
  switch (auth.status) {
    case 'signed-in':
      return auth.userEmail ?? 'ログイン中';
    case 'unconfigured':
      return 'Supabase未設定';
    case 'signed-out':
    default:
      return '未ログイン';
  }
}

function syncStateLabel(state: SyncState): string {
  switch (state) {
    case 'syncing':
      return '同期中';
    case 'synced':
      return '同期済み';
    case 'failed':
      return '同期失敗';
    case 'idle':
    default:
      return '未同期を確認中';
  }
}

function syncEventLabel(type: SyncEvent['type']): string {
  switch (type) {
    case 'note.created':
      return '作成';
    case 'note.updated':
      return '更新';
    case 'note.restored':
      return '復元';
    case 'note.deleted':
      return '削除';
    case 'tags.updated':
      return 'タグ変更';
    default:
      return type;
  }
}

function noteSyncStatusLabel(status: NoteWithTags['syncStatus']): string {
  switch (status) {
    case 'pending':
      return '未同期';
    case 'syncing':
      return '同期中';
    case 'failed':
      return '失敗';
    case 'conflict':
      return '競合';
    case 'synced':
      return '同期済み';
    case 'local':
    default:
      return 'ローカル';
  }
}

function areTagNamesEqual(tags: Tag[], input: string): boolean {
  const current = tags.map((tag) => tag.name.toLocaleLowerCase()).sort();
  const next = uniqueTagNames(input)
    .map((name) => name.toLocaleLowerCase())
    .sort();

  return current.length === next.length && current.every((name, index) => name === next[index]);
}

function plainTextExcerpt(text: string): string {
  const normalized = text
    .replace(/```[\s\S]*?```/g, ' コード ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized || '本文はまだありません';
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function renderInline(text: string): ReactNode[] {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+]\([^)]+\))/g;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) {
      nodes.push(text.slice(cursor, match.index));
    }

    const token = match[0];
    const key = `${match.index}-${token}`;

    if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{renderInline(token.slice(2, -2))}</strong>);
    } else if (token.startsWith('*')) {
      nodes.push(<em key={key}>{renderInline(token.slice(1, -1))}</em>);
    } else {
      const link = /^\[([^\]]+)]\(([^)]+)\)$/.exec(token);
      const label = link?.[1] ?? token;
      const url = link?.[2] ?? '';
      nodes.push(
        isSafeUrl(url) ? (
          <a href={url} key={key} rel="noreferrer" target="_blank">
            {label}
          </a>
        ) : (
          label
        ),
      );
    }

    cursor = match.index + token.length;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return nodes;
}

function renderMarkdown(markdown: string): ReactNode[] {
  const lines = markdown.split('\n');
  const nodes: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim().startsWith('```')) {
      const code: string[] = [];
      index += 1;

      while (index < lines.length && !lines[index].trim().startsWith('```')) {
        code.push(lines[index]);
        index += 1;
      }

      nodes.push(
        <pre key={`code-${index}`}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
      index += 1;
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);

    if (heading) {
      const level = heading[1].length;
      const content = renderInline(heading[2]);

      nodes.push(
        level === 1 ? (
          <h1 key={`heading-${index}`}>{content}</h1>
        ) : level === 2 ? (
          <h2 key={`heading-${index}`}>{content}</h2>
        ) : (
          <h3 key={`heading-${index}`}>{content}</h3>
        ),
      );
      index += 1;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote: string[] = [];

      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }

      nodes.push(<blockquote key={`quote-${index}`}>{quote.map(renderInline)}</blockquote>);
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: ReactNode[] = [];

      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        const item = lines[index].replace(/^\s*[-*]\s+/, '');
        const checked = /^\[[xX ]]\s+/.exec(item);
        const text = item.replace(/^\[[xX ]]\s+/, '');
        items.push(
          <li className={checked ? 'task-item' : undefined} key={`item-${index}`}>
            {checked ? (
              <span className="task-check" aria-hidden="true">
                {/^\[[xX]\]/.test(item) ? <Check size={14} /> : null}
              </span>
            ) : null}
            <span>{renderInline(text)}</span>
          </li>,
        );
        index += 1;
      }

      nodes.push(<ul key={`list-${index}`}>{items}</ul>);
      continue;
    }

    nodes.push(<p key={`paragraph-${index}`}>{renderInline(line)}</p>);
    index += 1;
  }

  return nodes.length > 0 ? nodes : [<p key="empty">本文はまだありません</p>];
}

export function App() {
  const [notes, setNotes] = useState<NoteWithTags[]>([]);
  const [deletedNotes, setDeletedNotes] = useState<NoteWithTags[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [isTagInputFocused, setIsTagInputFocused] = useState(false);
  const [tagSuggestionIndex, setTagSuggestionIndex] = useState(0);
  const [query, setQuery] = useState('');
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [editorMode, setEditorMode] = useState<EditorMode>('edit');
  const [isTrashOpen, setIsTrashOpen] = useState(false);
  const [isShortcutHelpOpen, setIsShortcutHelpOpen] = useState(false);
  const [failedEvents, setFailedEvents] = useState<SyncEvent[]>([]);
  const [syncSummary, setSyncSummary] = useState<LocalSyncSummary>({
    pendingCount: 0,
    failedCount: 0,
    lastSyncedAt: null,
  });
  const [notice, setNotice] = useState('ローカル保存で利用できます');
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [auth, setAuth] = useState<AuthSnapshot>({
    status: 'unconfigured',
    session: null,
    userEmail: null,
  });
  const [authEmail, setAuthEmail] = useState('');
  const [isAuthPanelOpen, setIsAuthPanelOpen] = useState(false);
  const [isAuthBusy, setIsAuthBusy] = useState(false);
  const syncInFlightRef = useRef(false);
  const syncNowRef = useRef<((options?: { silent?: boolean }) => Promise<void>) | null>(null);
  const autoSyncTimerRef = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId],
  );
  const tagInputParts = useMemo(() => tagInput.split(','), [tagInput]);
  const currentTagToken = normalizeTagName(tagInputParts[tagInputParts.length - 1] ?? '');
  const existingTagNames = useMemo(
    () =>
      new Set(
        tagInputParts
          .slice(0, -1)
          .map((part) => normalizeTagName(part).toLocaleLowerCase())
          .filter(Boolean),
      ),
    [tagInputParts],
  );
  const tagSuggestions = useMemo(() => {
    if (!isTagInputFocused || currentTagToken.length === 0) {
      return [];
    }

    const current = currentTagToken.toLocaleLowerCase();

    return tags
      .filter((tag) => !existingTagNames.has(tag.name.toLocaleLowerCase()))
      .filter((tag) => tag.name.toLocaleLowerCase().includes(current))
      .slice(0, 6);
  }, [currentTagToken, existingTagNames, isTagInputFocused, tags]);
  const markdownPreview = useMemo(() => renderMarkdown(body), [body]);

  const reload = useCallback(async () => {
    const [nextNotes, nextDeletedNotes, nextTags, nextSync, nextPendingEvents] = await Promise.all([
      store.listNotes(query, selectedTagId),
      store.listDeletedNotes(),
      store.listTags(),
      store.getSyncSummary(),
      store.listPendingSyncEvents(),
    ]);

    setNotes(nextNotes);
    setDeletedNotes(nextDeletedNotes);
    setTags(nextTags);
    setSyncSummary(nextSync);
    setFailedEvents(nextPendingEvents.filter((event) => event.status === 'failed'));

    if (!selectedId && nextNotes.length > 0) {
      setSelectedId(nextNotes[0].id);
    }

    if (selectedTagId && !nextTags.some((tag) => tag.id === selectedTagId)) {
      setSelectedTagId(null);
    }
  }, [query, selectedId, selectedTagId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let isMounted = true;

    getAuthSnapshot()
      .then((snapshot) => {
        if (isMounted) {
          setAuth(snapshot);
        }
      })
      .catch((error) => {
        setNotice(error instanceof Error ? error.message : '認証状態を確認できませんでした');
      });

    const unsubscribe = subscribeToAuthChanges((snapshot) => {
      setAuth(snapshot);
      setNotice(snapshot.status === 'signed-in' ? 'ログインしました' : 'ログアウトしました');
    });

    return () => {
      isMounted = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!selectedNote) {
      setTitle('');
      setBody('');
      setTagInput('');
      return;
    }

    setTitle(selectedNote.title);
    setBody(selectedNote.body);
    setTagInput(describeTags(selectedNote.tags));
    setSaveState('saved');
  }, [selectedNote]);

  const scheduleAutoSync = useCallback(() => {
    if (autoSyncTimerRef.current !== null) {
      window.clearTimeout(autoSyncTimerRef.current);
    }

    autoSyncTimerRef.current = window.setTimeout(() => {
      autoSyncTimerRef.current = null;
      void syncNowRef.current?.({ silent: true });
    }, autoSyncAfterChangeMs);
  }, []);

  useEffect(() => {
    return () => {
      if (autoSyncTimerRef.current !== null) {
        window.clearTimeout(autoSyncTimerRef.current);
      }
    };
  }, []);

  const saveCurrent = useCallback(async () => {
    if (!selectedId) {
      return;
    }

    setSaveState('saving');

    try {
      await store.updateNote(selectedId, { title, body });
      if (!selectedNote || !areTagNamesEqual(selectedNote.tags, tagInput)) {
        await store.setNoteTags(selectedId, tagInput);
      }
      setSaveState('saved');
      setNotice('ローカルに保存しました');
      await reload();
      scheduleAutoSync();
    } catch (error) {
      setSaveState('error');
      setNotice(error instanceof Error ? error.message : '保存に失敗しました');
    }
  }, [body, reload, scheduleAutoSync, selectedId, selectedNote, tagInput, title]);

  useDebouncedEffect(
    () => {
      if (!selectedNote || saveState !== 'dirty') {
        return;
      }

      void saveCurrent();
    },
    [body, saveCurrent, saveState, selectedNote?.id, tagInput, title],
    1200,
  );

  const createNote = async () => {
    if (saveState === 'dirty') {
      await saveCurrent();
    }

    const note = await store.createNote();
    await reload();
    setSelectedId(note.id);
    setNotice('新しいノートを作成しました');
    scheduleAutoSync();
  };

  const selectNote = async (id: string) => {
    if (id === selectedId) {
      return;
    }

    if (saveState === 'dirty') {
      await saveCurrent();
    }

    setSelectedId(id);
  };

  const deleteNote = async () => {
    if (!selectedId) {
      return;
    }

    await store.softDeleteNote(selectedId);
    const remaining = notes.filter((note) => note.id !== selectedId);
    setSelectedId(remaining[0]?.id ?? null);
    setNotice('ノートを削除しました。同期用の削除情報は保持しています');
    await reload();
    scheduleAutoSync();
  };

  const restoreDeletedNote = async (id: string) => {
    await store.restoreNote(id);
    setIsTrashOpen(false);
    setSelectedId(id);
    setNotice('削除済みノートを復元しました');
    await reload();
    scheduleAutoSync();
  };

  const deleteTag = async (tag: Tag) => {
    const confirmed = window.confirm(
      `「${tag.name}」タグを削除します。このタグだけが外れ、ノート本文やタイトルは残ります。`,
    );

    if (!confirmed) {
      return;
    }

    await store.deleteTag(tag.id);

    if (selectedTagId === tag.id) {
      setSelectedTagId(null);
    }

    if (tagInput) {
      const nextInput = tagInput
        .split(',')
        .map(normalizeTagName)
        .filter((name) => name && name.toLocaleLowerCase() !== tag.name.toLocaleLowerCase())
        .join(', ');
      setTagInput(nextInput);
    }

    setNotice('タグを削除しました');
    await reload();
    scheduleAutoSync();
  };

  const syncNow = useCallback(
    async (options: { silent?: boolean } = {}) => {
      if (syncInFlightRef.current) {
        return;
      }

      if (auth.status !== 'signed-in') {
        if (options.silent) {
          return;
        }

        setIsAuthPanelOpen(true);
        setSyncState('idle');
        setNotice(
          auth.status === 'unconfigured'
            ? 'Supabase の接続情報を設定すると同期できます'
            : 'ログインすると同期できます',
        );
        return;
      }

      if (!navigator.onLine) {
        if (!options.silent) {
          setNotice('オフラインのため、オンライン復帰後に同期してください');
        }
        return;
      }

      syncInFlightRef.current = true;
      setSyncState('syncing');
      if (!options.silent) {
        setNotice('同期イベントを確認しています');
      }

      try {
        const next = await syncWithSupabase(store, auth.session);
        setSyncSummary(next);
        setSyncState('synced');
        if (!options.silent) {
          setNotice('同期しました');
        }
        await reload();
      } catch (error) {
        const next = await store.getSyncSummary();
        setSyncSummary(next);
        setSyncState('failed');
        if (!options.silent) {
          setNotice(error instanceof Error ? error.message : '同期に失敗しました');
        }
      } finally {
        syncInFlightRef.current = false;
      }
    },
    [auth, reload],
  );

  useEffect(() => {
    syncNowRef.current = syncNow;
  }, [syncNow]);

  useEffect(() => {
    if (auth.status !== 'signed-in') {
      return;
    }

    const syncQuietly = () => {
      if (document.visibilityState === 'hidden' || !navigator.onLine) {
        return;
      }

      void syncNow({ silent: true });
    };

    const intervalId = window.setInterval(syncQuietly, autoSyncIntervalMs);
    window.addEventListener('online', syncQuietly);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener('online', syncQuietly);
    };
  }, [auth.status, syncNow]);

  const requestMagicLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsAuthBusy(true);

    try {
      await sendMagicLink(authEmail);
      setNotice('ログイン用メールを送信しました');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'ログインメールを送信できませんでした');
    } finally {
      setIsAuthBusy(false);
    }
  };

  const logOut = async () => {
    setIsAuthBusy(true);

    try {
      await signOut();
      setIsAuthPanelOpen(false);
      setNotice('ログアウトしました');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'ログアウトできませんでした');
    } finally {
      setIsAuthBusy(false);
    }
  };

  const updateDraft = (next: { title?: string; body?: string; tags?: string }) => {
    if (next.title !== undefined) {
      setTitle(next.title);
    }

    if (next.body !== undefined) {
      setBody(next.body);
    }

    if (next.tags !== undefined) {
      setTagInput(next.tags);
    }

    setSaveState('dirty');
  };

  const applyTagSuggestion = (tag: Tag) => {
    const prefix = tagInputParts.slice(0, -1).map(normalizeTagName).filter(Boolean);
    const nextTags = [...prefix, tag.name];
    setTagInput(`${nextTags.join(', ')}, `);
    setSaveState('dirty');
    setTagSuggestionIndex(0);
    window.setTimeout(() => tagInputRef.current?.focus(), 0);
  };

  const handleTagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (tagSuggestions.length === 0) {
      return;
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setTagSuggestionIndex((index) => (index + 1) % tagSuggestions.length);
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setTagSuggestionIndex((index) => (index - 1 + tagSuggestions.length) % tagSuggestions.length);
      return;
    }

    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      applyTagSuggestion(tagSuggestions[tagSuggestionIndex] ?? tagSuggestions[0]);
      return;
    }

    if (event.key === 'Escape') {
      setIsTagInputFocused(false);
    }
  };

  useEffect(() => {
    setTagSuggestionIndex(0);
  }, [currentTagToken]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isEditable =
        target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
        event.preventDefault();
        void createNote();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveCurrent();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === '/') {
        event.preventDefault();
        setIsShortcutHelpOpen((value) => !value);
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Backspace' && !isEditable) {
        event.preventDefault();
        void deleteNote();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div>
            <h1>Shiori</h1>
            <p>ローカルファーストのノート</p>
          </div>
          <button className="icon-button primary" title="新規ノート" onClick={createNote}>
            <FilePlus size={18} />
          </button>
        </div>

        <label className="search-box">
          <Search size={16} />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="検索"
          />
        </label>

        <div className="tag-strip">
          <button
            className={!selectedTagId ? 'active' : ''}
            onClick={() => setSelectedTagId(null)}
            type="button"
          >
            すべて
          </button>
          {tags.map((tag) => (
            <span className={`tag-filter ${selectedTagId === tag.id ? 'active' : ''}`} key={tag.id}>
              <button onClick={() => setSelectedTagId(tag.id)} type="button">
                {tag.name}
              </button>
              <button
                aria-label={`${tag.name} タグを削除`}
                className="tag-delete-button"
                onClick={() => void deleteTag(tag)}
                title="タグを削除"
                type="button"
              >
                <Trash size={13} />
              </button>
            </span>
          ))}
        </div>

        <div className="sidebar-tools">
          <button
            className={`plain-button ${isTrashOpen ? 'active' : ''}`}
            onClick={() => setIsTrashOpen((value) => !value)}
            type="button"
          >
            <Trash2 size={16} />
            <span>削除済み {deletedNotes.length}</span>
          </button>
        </div>

        <div className="note-list">
          {(isTrashOpen ? deletedNotes : notes).map((note) => (
            <button
              className={`note-list-item ${note.id === selectedId ? 'selected' : ''}`}
              key={note.id}
              onClick={() => (isTrashOpen ? undefined : void selectNote(note.id))}
              type="button"
            >
              <span className="note-title">{note.title}</span>
              <span className="note-excerpt">{plainTextExcerpt(note.body)}</span>
              <span className="note-meta">
                {note.isConflictCopy ? (
                  <>
                    <span className="conflict-badge">競合コピー</span>
                    <Circle size={5} fill="currentColor" />
                  </>
                ) : null}
                {note.tags.length > 0 ? describeTags(note.tags) : 'タグなし'}
                <Circle size={5} fill="currentColor" />
                {isTrashOpen
                  ? `削除 ${formatRelativeTime(note.deletedAt)}`
                  : formatRelativeTime(note.updatedAt)}
              </span>
              <span className="note-badges">
                {!isTrashOpen ? (
                  <span className={`status-badge ${note.syncStatus}`}>
                    {noteSyncStatusLabel(note.syncStatus)}
                  </span>
                ) : (
                  <span
                    className="restore-link"
                    onClick={(event) => {
                      event.stopPropagation();
                      void restoreDeletedNote(note.id);
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    復元
                  </span>
                )}
              </span>
            </button>
          ))}

          {(isTrashOpen ? deletedNotes : notes).length === 0 ? (
            <div className="empty-state">
              <Archive size={22} />
              <p>{isTrashOpen ? '削除済みノートはありません' : '該当するノートはありません'}</p>
            </div>
          ) : null}
        </div>
      </aside>

      <section className="editor-pane">
        <header className="topbar">
          <div className="status-group">
            <span className={`save-pill ${saveState}`}>{saveStateLabel(saveState)}</span>
            <span className="muted">{notice}</span>
          </div>
          <div className="actions">
            {isAuthPanelOpen && auth.status !== 'signed-in' ? (
              auth.status === 'unconfigured' ? (
                <div className="auth-message">Supabase の環境変数が未設定です</div>
              ) : (
                <form className="auth-form" onSubmit={requestMagicLink}>
                  <Mail size={16} />
                  <input
                    value={authEmail}
                    onChange={(event) => setAuthEmail(event.target.value)}
                    placeholder="メールアドレス"
                    type="email"
                  />
                  <button className="plain-button" disabled={isAuthBusy} type="submit">
                    送信
                  </button>
                </form>
              )
            ) : null}
            {auth.status === 'signed-in' ? (
              <button
                className="plain-button"
                disabled={isAuthBusy}
                onClick={logOut}
                type="button"
                title="ログアウト"
              >
                <LogOut size={16} />
                <span>{authLabel(auth)}</span>
              </button>
            ) : (
              <button
                className="plain-button"
                onClick={() => setIsAuthPanelOpen((value) => !value)}
                type="button"
                title="ログイン"
              >
                <LogIn size={16} />
                <span>{authLabel(auth)}</span>
              </button>
            )}
            <button
              className="plain-button"
              disabled={syncState === 'syncing'}
              onClick={() => void syncNow()}
              type="button"
              title="同期"
            >
              <RefreshCw size={16} />
              <span>{syncState === 'failed' ? '再試行' : '同期'}</span>
            </button>
            <button
              className={`plain-button ${isShortcutHelpOpen ? 'active' : ''}`}
              onClick={() => setIsShortcutHelpOpen((value) => !value)}
              type="button"
              title="ショートカット"
            >
              <HelpCircle size={16} />
            </button>
          </div>
        </header>

        <div className={`shortcut-panel ${isShortcutHelpOpen ? '' : 'collapsed'}`}>
          {isShortcutHelpOpen ? (
            <>
              <span>⌘N 新規</span>
              <span>⌘F 検索</span>
              <span>⌘S 保存</span>
              <span>⌘/ 表示切替</span>
              <span>⌘⌫ 削除</span>
            </>
          ) : null}
        </div>

        {selectedNote ? (
          <div className="editor-layout">
            <div className="editor-mode-tabs" role="tablist" aria-label="Markdown表示">
              <button
                className={editorMode === 'edit' ? 'active' : ''}
                onClick={() => setEditorMode('edit')}
                title="編集"
                type="button"
              >
                <Pencil size={16} />
              </button>
              <button
                className={editorMode === 'preview' ? 'active' : ''}
                onClick={() => setEditorMode('preview')}
                title="プレビュー"
                type="button"
              >
                <Eye size={16} />
              </button>
              <button
                className={editorMode === 'split' ? 'active' : ''}
                onClick={() => setEditorMode('split')}
                title="分割表示"
                type="button"
              >
                <Columns2 size={16} />
              </button>
            </div>

            <div className="title-row">
              <input
                className="title-input"
                value={title}
                onChange={(event) => updateDraft({ title: event.target.value })}
                placeholder="タイトル"
              />
              <button
                className="icon-button danger"
                title="削除"
                onClick={deleteNote}
                type="button"
              >
                <Trash2 size={18} />
              </button>
            </div>

            <div className="tag-input-wrap">
              <label className="tag-input">
                <TagIcon size={16} />
                <input
                  ref={tagInputRef}
                  value={tagInput}
                  onBlur={() => window.setTimeout(() => setIsTagInputFocused(false), 120)}
                  onChange={(event) => {
                    setIsTagInputFocused(true);
                    updateDraft({ tags: event.target.value });
                  }}
                  onFocus={() => setIsTagInputFocused(true)}
                  onKeyDown={handleTagKeyDown}
                  placeholder="タグをカンマ区切りで入力"
                />
              </label>
              {tagSuggestions.length > 0 ? (
                <div className="tag-suggestions" role="listbox">
                  {tagSuggestions.map((tag, index) => (
                    <button
                      className={index === tagSuggestionIndex ? 'active' : ''}
                      key={tag.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => applyTagSuggestion(tag)}
                      type="button"
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <div className={`markdown-workspace ${editorMode}`}>
              {editorMode !== 'preview' ? (
                <NoteEditor value={body} onChange={(value) => updateDraft({ body: value })} />
              ) : null}
              {editorMode !== 'edit' ? (
                <article className="markdown-preview">{markdownPreview}</article>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="welcome-panel">
            <h2>ノートを選択してください</h2>
            <p>左上の新規作成から、すぐに書き始められます。</p>
            <button className="primary-button" onClick={createNote} type="button">
              <FilePlus size={18} />
              <span>新規ノート</span>
            </button>
          </div>
        )}

        <footer className="sync-footer">
          <span className={`sync-state ${syncState}`}>
            <Cloud size={15} />
            {syncStateLabel(syncState)}
          </span>
          <span>未同期 {syncSummary.pendingCount} 件</span>
          <span>失敗 {syncSummary.failedCount} 件</span>
          <span>最終同期 {formatRelativeTime(syncSummary.lastSyncedAt)}</span>
          <span className="sync-detail">
            {auth.status === 'unconfigured'
              ? 'Supabase未設定'
              : auth.status !== 'signed-in'
                ? '未ログイン'
                : !navigator.onLine
                  ? 'オフライン'
                  : syncState === 'failed'
                    ? '同期ボタンから再試行できます'
                    : '自動同期は30秒間隔です'}
          </span>
        </footer>
        {failedEvents.length > 0 ? (
          <div className="sync-error-list">
            {failedEvents.slice(0, 3).map((event) => (
              <span key={event.id}>
                {syncEventLabel(event.type)}: {event.error ?? '同期に失敗しました'}
              </span>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}

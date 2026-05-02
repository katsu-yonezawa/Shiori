import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { NoteEditor } from '@shiori/editor';
import {
  formatRelativeTime,
  type LocalSyncSummary,
  type NoteWithTags,
  type SaveState,
  type Tag
} from '@shiori/core';
import {
  Archive,
  Circle,
  Cloud,
  FilePlus,
  LogIn,
  LogOut,
  Mail,
  RefreshCw,
  Search,
  Tag as TagIcon,
  Trash2
} from 'lucide-react';
import {
  getAuthSnapshot,
  sendMagicLink,
  signOut,
  subscribeToAuthChanges,
  type AuthSnapshot
} from './auth';
import { syncWithSupabase } from './cloudSync';
import { LocalNoteStore, describeTags } from './storage';
import { useDebouncedEffect } from './useDebouncedEffect';

const store = new LocalNoteStore();

type SyncState = 'idle' | 'syncing' | 'synced' | 'failed';

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

export function App() {
  const [notes, setNotes] = useState<NoteWithTags[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [query, setQuery] = useState('');
  const [selectedTagId, setSelectedTagId] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [syncSummary, setSyncSummary] = useState<LocalSyncSummary>({
    pendingCount: 0,
    failedCount: 0,
    lastSyncedAt: null
  });
  const [notice, setNotice] = useState('ローカル保存で利用できます');
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [auth, setAuth] = useState<AuthSnapshot>({
    status: 'unconfigured',
    session: null,
    userEmail: null
  });
  const [authEmail, setAuthEmail] = useState('');
  const [isAuthPanelOpen, setIsAuthPanelOpen] = useState(false);
  const [isAuthBusy, setIsAuthBusy] = useState(false);
  const syncInFlightRef = useRef(false);

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId]
  );

  const reload = useCallback(async () => {
    const [nextNotes, nextTags, nextSync] = await Promise.all([
      store.listNotes(query, selectedTagId),
      store.listTags(),
      store.getSyncSummary()
    ]);

    setNotes(nextNotes);
    setTags(nextTags);
    setSyncSummary(nextSync);

    if (!selectedId && nextNotes.length > 0) {
      setSelectedId(nextNotes[0].id);
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

  const saveCurrent = useCallback(async () => {
    if (!selectedId) {
      return;
    }

    setSaveState('saving');

    try {
      await store.updateNote(selectedId, { title, body });
      await store.setNoteTags(selectedId, tagInput);
      setSaveState('saved');
      setNotice('ローカルに保存しました');
      await reload();
    } catch (error) {
      setSaveState('error');
      setNotice(error instanceof Error ? error.message : '保存に失敗しました');
    }
  }, [body, reload, selectedId, tagInput, title]);

  useDebouncedEffect(
    () => {
      if (!selectedNote || saveState !== 'dirty') {
        return;
      }

      void saveCurrent();
    },
    [body, saveCurrent, saveState, selectedNote?.id, tagInput, title],
    1200
  );

  const createNote = async () => {
    if (saveState === 'dirty') {
      await saveCurrent();
    }

    const note = await store.createNote();
    await reload();
    setSelectedId(note.id);
    setNotice('新しいノートを作成しました');
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
  };

  const syncNow = useCallback(async (options: { silent?: boolean } = {}) => {
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
          : 'ログインすると同期できます'
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
  }, [auth, reload]);

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

    const intervalId = window.setInterval(syncQuietly, 60_000);
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
            <button
              className={selectedTagId === tag.id ? 'active' : ''}
              key={tag.id}
              onClick={() => setSelectedTagId(tag.id)}
              type="button"
            >
              {tag.name}
            </button>
          ))}
        </div>

        <div className="note-list">
          {notes.map((note) => (
            <button
              className={`note-list-item ${note.id === selectedId ? 'selected' : ''}`}
              key={note.id}
              onClick={() => void selectNote(note.id)}
              type="button"
            >
              <span className="note-title">{note.title}</span>
              <span className="note-excerpt">{note.body || '本文はまだありません'}</span>
              <span className="note-meta">
                {note.isConflictCopy ? (
                  <>
                    <span className="conflict-badge">競合コピー</span>
                    <Circle size={5} fill="currentColor" />
                  </>
                ) : null}
                {note.tags.length > 0 ? describeTags(note.tags) : 'タグなし'}
                <Circle size={5} fill="currentColor" />
                {formatRelativeTime(note.updatedAt)}
              </span>
            </button>
          ))}

          {notes.length === 0 ? (
            <div className="empty-state">
              <Archive size={22} />
              <p>該当するノートはありません</p>
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
              <button className="plain-button" disabled={isAuthBusy} onClick={logOut} type="button" title="ログアウト">
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
          </div>
        </header>

        {selectedNote ? (
          <div className="editor-layout">
            <div className="title-row">
              <input
                className="title-input"
                value={title}
                onChange={(event) => updateDraft({ title: event.target.value })}
                placeholder="タイトル"
              />
              <button className="icon-button danger" title="削除" onClick={deleteNote} type="button">
                <Trash2 size={18} />
              </button>
            </div>

            <label className="tag-input">
              <TagIcon size={16} />
              <input
                value={tagInput}
                onChange={(event) => updateDraft({ tags: event.target.value })}
                placeholder="タグをカンマ区切りで入力"
              />
            </label>

            <NoteEditor value={body} onChange={(value) => updateDraft({ body: value })} />
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
          <span>
            未同期 {syncSummary.pendingCount} 件
          </span>
          <span>失敗 {syncSummary.failedCount} 件</span>
          <span>最終同期 {formatRelativeTime(syncSummary.lastSyncedAt)}</span>
        </footer>
      </section>
    </main>
  );
}

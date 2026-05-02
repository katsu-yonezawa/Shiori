import {
  createBlankNote,
  createId,
  formatTags,
  matchesNote,
  normalizeTagName,
  normalizeTitle,
  nowIso,
  summarizeSync,
  touchNote,
  uniqueTagNames,
  type LocalSyncSummary,
  type Note,
  type NoteWithTags,
  type SyncEvent,
  type SyncEventType,
  type Tag
} from '@shiori/core';
import { invoke } from '@tauri-apps/api/tauri';

type NoteTag = {
  id: string;
  noteId: string;
  tagId: string;
  createdAt: string;
};

const dbName = 'shiori-local';
const dbVersion = 1;
const lastSyncedKey = 'lastSyncedAt';

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

async function readAll<T>(store: IDBObjectStore): Promise<T[]> {
  return requestToPromise<T[]>(store.getAll());
}

type NoteStoreDriver = {
  listNotes(query?: string, tagId?: string | null): Promise<NoteWithTags[]>;
  listTags(): Promise<Tag[]>;
  createNote(): Promise<NoteWithTags>;
  updateNote(id: string, input: { title: string; body: string }): Promise<Note>;
  softDeleteNote(id: string): Promise<void>;
  setNoteTags(noteId: string, input: string): Promise<Tag[]>;
  getSyncSummary(): Promise<LocalSyncSummary>;
  markAllSynced(): Promise<LocalSyncSummary>;
};

function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_IPC__' in window;
}

class TauriNoteStore implements NoteStoreDriver {
  listNotes(query = '', tagId: string | null = null): Promise<NoteWithTags[]> {
    return invoke('list_notes', { query, tagId });
  }

  listTags(): Promise<Tag[]> {
    return invoke('list_tags');
  }

  createNote(): Promise<NoteWithTags> {
    return invoke('create_note');
  }

  updateNote(id: string, input: { title: string; body: string }): Promise<Note> {
    return invoke('update_note', { id, input });
  }

  softDeleteNote(id: string): Promise<void> {
    return invoke('soft_delete_note', { id });
  }

  setNoteTags(noteId: string, input: string): Promise<Tag[]> {
    return invoke('set_note_tags', { noteId, input });
  }

  getSyncSummary(): Promise<LocalSyncSummary> {
    return invoke('get_sync_summary');
  }

  markAllSynced(): Promise<LocalSyncSummary> {
    return invoke('mark_all_synced');
  }
}

class IndexedDbNoteStore implements NoteStoreDriver {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = this.open();
  }

  async listNotes(query = '', tagId: string | null = null): Promise<NoteWithTags[]> {
    const db = await this.dbPromise;
    const transaction = db.transaction(['notes', 'tags', 'noteTags'], 'readonly');
    const notes = await readAll<Note>(transaction.objectStore('notes'));
    const tags = await readAll<Tag>(transaction.objectStore('tags'));
    const noteTags = await readAll<NoteTag>(transaction.objectStore('noteTags'));
    await transactionDone(transaction);

    const tagById = new Map(tags.map((tag) => [tag.id, tag]));
    const tagsByNote = new Map<string, Tag[]>();

    for (const relation of noteTags) {
      const tag = tagById.get(relation.tagId);

      if (!tag) {
        continue;
      }

      const existing = tagsByNote.get(relation.noteId) ?? [];
      existing.push(tag);
      tagsByNote.set(relation.noteId, existing);
    }

    return notes
      .filter((note) => !note.deletedAt)
      .map((note) => ({
        ...note,
        tags: (tagsByNote.get(note.id) ?? []).sort((a, b) => a.name.localeCompare(b.name, 'ja'))
      }))
      .filter((note) => matchesNote(note, query))
      .filter((note) => !tagId || note.tags.some((tag) => tag.id === tagId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listTags(): Promise<Tag[]> {
    const db = await this.dbPromise;
    const transaction = db.transaction('tags', 'readonly');
    const tags = await readAll<Tag>(transaction.objectStore('tags'));
    await transactionDone(transaction);
    return tags.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  }

  async createNote(): Promise<NoteWithTags> {
    const note = createBlankNote();
    const db = await this.dbPromise;
    const transaction = db.transaction(['notes', 'syncEvents'], 'readwrite');
    transaction.objectStore('notes').put(note);
    this.enqueue(transaction, 'note.created', 'note', note.id, note);
    await transactionDone(transaction);
    return { ...note, tags: [] };
  }

  async updateNote(id: string, input: { title: string; body: string }): Promise<Note> {
    const db = await this.dbPromise;
    const transaction = db.transaction(['notes', 'syncEvents'], 'readwrite');
    const noteStore = transaction.objectStore('notes');
    const existing = await requestToPromise<Note | undefined>(noteStore.get(id));

    if (!existing) {
      throw new Error('保存対象のノートが見つかりません。');
    }

    const next = touchNote({
      ...existing,
      title: normalizeTitle(input.title, input.body),
      body: input.body
    });

    noteStore.put(next);
    this.enqueue(transaction, 'note.updated', 'note', next.id, next);
    await transactionDone(transaction);
    return next;
  }

  async softDeleteNote(id: string): Promise<void> {
    const db = await this.dbPromise;
    const transaction = db.transaction(['notes', 'syncEvents'], 'readwrite');
    const noteStore = transaction.objectStore('notes');
    const existing = await requestToPromise<Note | undefined>(noteStore.get(id));

    if (!existing) {
      return;
    }

    const next = touchNote({ ...existing, deletedAt: nowIso() });
    noteStore.put(next);
    this.enqueue(transaction, 'note.deleted', 'note', next.id, next);
    await transactionDone(transaction);
  }

  async setNoteTags(noteId: string, input: string): Promise<Tag[]> {
    const wantedNames = uniqueTagNames(input);
    const db = await this.dbPromise;
    const transaction = db.transaction(['tags', 'noteTags', 'syncEvents'], 'readwrite');
    const tagStore = transaction.objectStore('tags');
    const noteTagStore = transaction.objectStore('noteTags');
    const tags = await readAll<Tag>(tagStore);
    const noteTags = await readAll<NoteTag>(noteTagStore);
    const tagsByName = new Map(tags.map((tag) => [normalizeTagName(tag.name).toLocaleLowerCase(), tag]));
    const nextTags: Tag[] = [];

    for (const name of wantedNames) {
      const key = name.toLocaleLowerCase();
      const existing = tagsByName.get(key);

      if (existing) {
        nextTags.push(existing);
        continue;
      }

      const at = nowIso();
      const tag = { id: createId('tag'), name, createdAt: at, updatedAt: at };
      tagStore.put(tag);
      nextTags.push(tag);
      tagsByName.set(key, tag);
    }

    for (const relation of noteTags.filter((relation) => relation.noteId === noteId)) {
      noteTagStore.delete(relation.id);
    }

    for (const tag of nextTags) {
      noteTagStore.put({
        id: `${noteId}:${tag.id}`,
        noteId,
        tagId: tag.id,
        createdAt: nowIso()
      });
    }

    this.enqueue(transaction, 'tags.updated', 'note', noteId, {
      noteId,
      tags: nextTags.map((tag) => tag.name)
    });
    await transactionDone(transaction);
    return nextTags;
  }

  async getSyncSummary(): Promise<LocalSyncSummary> {
    const db = await this.dbPromise;
    const transaction = db.transaction(['syncEvents', 'meta'], 'readonly');
    const events = await readAll<SyncEvent>(transaction.objectStore('syncEvents'));
    const lastSyncedAt =
      (await requestToPromise<string | undefined>(transaction.objectStore('meta').get(lastSyncedKey))) ??
      null;
    await transactionDone(transaction);
    return summarizeSync(events, lastSyncedAt);
  }

  async markAllSynced(): Promise<LocalSyncSummary> {
    const at = nowIso();
    const db = await this.dbPromise;
    const transaction = db.transaction(['notes', 'syncEvents', 'meta'], 'readwrite');
    const noteStore = transaction.objectStore('notes');
    const eventStore = transaction.objectStore('syncEvents');
    const notes = await readAll<Note>(noteStore);
    const events = await readAll<SyncEvent>(eventStore);

    for (const note of notes) {
      if (note.syncStatus !== 'synced') {
        noteStore.put({ ...note, syncStatus: 'synced' });
      }
    }

    for (const event of events) {
      if (event.status !== 'sent') {
        eventStore.put({ ...event, status: 'sent', sentAt: at, error: null });
      }
    }

    transaction.objectStore('meta').put(at, lastSyncedKey);
    await transactionDone(transaction);
    return this.getSyncSummary();
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, dbVersion);

      request.onupgradeneeded = () => {
        const db = request.result;

        if (!db.objectStoreNames.contains('notes')) {
          db.createObjectStore('notes', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('tags')) {
          db.createObjectStore('tags', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('noteTags')) {
          db.createObjectStore('noteTags', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('syncEvents')) {
          db.createObjectStore('syncEvents', { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB を開けませんでした。'));
    });
  }

  private enqueue(
    transaction: IDBTransaction,
    type: SyncEventType,
    entityType: SyncEvent['entityType'],
    entityId: string,
    payload: unknown
  ) {
    const at = nowIso();
    const event: SyncEvent = {
      id: createId('sync'),
      type,
      entityId,
      entityType,
      payload,
      status: 'pending',
      createdAt: at,
      sentAt: null,
      error: null
    };

    transaction.objectStore('syncEvents').put(event);
  }
}

export class LocalNoteStore implements NoteStoreDriver {
  private driver: NoteStoreDriver;

  constructor() {
    this.driver = isTauriRuntime() ? new TauriNoteStore() : new IndexedDbNoteStore();
  }

  listNotes(query = '', tagId: string | null = null): Promise<NoteWithTags[]> {
    return this.driver.listNotes(query, tagId);
  }

  listTags(): Promise<Tag[]> {
    return this.driver.listTags();
  }

  createNote(): Promise<NoteWithTags> {
    return this.driver.createNote();
  }

  updateNote(id: string, input: { title: string; body: string }): Promise<Note> {
    return this.driver.updateNote(id, input);
  }

  softDeleteNote(id: string): Promise<void> {
    return this.driver.softDeleteNote(id);
  }

  setNoteTags(noteId: string, input: string): Promise<Tag[]> {
    return this.driver.setNoteTags(noteId, input);
  }

  getSyncSummary(): Promise<LocalSyncSummary> {
    return this.driver.getSyncSummary();
  }

  markAllSynced(): Promise<LocalSyncSummary> {
    return this.driver.markAllSynced();
  }
}

export function describeTags(tags: Tag[]): string {
  return formatTags(tags);
}

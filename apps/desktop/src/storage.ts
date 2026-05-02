import {
  createBlankNote,
  createConflictTitle,
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
  type Tag,
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
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

async function readAll<T>(store: IDBObjectStore): Promise<T[]> {
  return requestToPromise<T[]>(store.getAll());
}

type NoteStoreDriver = {
  listNotes(query?: string, tagId?: string | null): Promise<NoteWithTags[]>;
  listDeletedNotes(): Promise<NoteWithTags[]>;
  listTags(): Promise<Tag[]>;
  createNote(): Promise<NoteWithTags>;
  updateNote(id: string, input: { title: string; body: string }): Promise<Note>;
  softDeleteNote(id: string): Promise<void>;
  restoreNote(id: string): Promise<void>;
  deleteTag(id: string): Promise<void>;
  setNoteTags(noteId: string, input: string): Promise<Tag[]>;
  getSyncSummary(): Promise<LocalSyncSummary>;
  markAllSynced(): Promise<LocalSyncSummary>;
  listPendingSyncEvents(): Promise<SyncEvent[]>;
  markSyncEvents(ids: string[], status: SyncEvent['status'], error?: string | null): Promise<void>;
  applyRemoteNotes(notes: Note[]): Promise<void>;
};

function normalizedNameKeys(names: string[]): string[] {
  return names.map((name) => name.toLocaleLowerCase()).sort();
}

function haveSameNameSet(left: string[], right: string[]): boolean {
  const leftKeys = normalizedNameKeys(left);
  const rightKeys = normalizedNameKeys(right);

  return (
    leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index])
  );
}

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

  listDeletedNotes(): Promise<NoteWithTags[]> {
    return invoke('list_deleted_notes');
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

  restoreNote(id: string): Promise<void> {
    return invoke('restore_note', { id });
  }

  deleteTag(id: string): Promise<void> {
    return invoke('delete_tag', { id });
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

  listPendingSyncEvents(): Promise<SyncEvent[]> {
    return invoke('list_pending_sync_events');
  }

  markSyncEvents(
    ids: string[],
    status: SyncEvent['status'],
    error: string | null = null,
  ): Promise<void> {
    return invoke('mark_sync_events', { ids, status, error });
  }

  applyRemoteNotes(notes: Note[]): Promise<void> {
    return invoke('apply_remote_notes', { notes });
  }
}

class IndexedDbNoteStore implements NoteStoreDriver {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = this.open();
  }

  async listNotes(query = '', tagId: string | null = null): Promise<NoteWithTags[]> {
    const notes = await this.listNotesWithTags();

    return notes
      .filter((note) => !note.deletedAt)
      .filter((note) => matchesNote(note, query))
      .filter((note) => !tagId || note.tags.some((tag) => tag.id === tagId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listDeletedNotes(): Promise<NoteWithTags[]> {
    const notes = await this.listNotesWithTags();

    return notes
      .filter((note) => note.deletedAt)
      .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  }

  async listTags(): Promise<Tag[]> {
    const db = await this.dbPromise;
    const transaction = db.transaction(['tags', 'noteTags'], 'readonly');
    const tags = await readAll<Tag>(transaction.objectStore('tags'));
    const noteTags = await readAll<NoteTag>(transaction.objectStore('noteTags'));
    await transactionDone(transaction);
    const usedTagIds = new Set(noteTags.map((relation) => relation.tagId));

    return tags
      .filter((tag) => usedTagIds.has(tag.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
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

    const nextTitle = normalizeTitle(input.title, input.body);

    if (existing.title === nextTitle && existing.body === input.body) {
      await transactionDone(transaction);
      return existing;
    }

    const next = touchNote({
      ...existing,
      title: nextTitle,
      body: input.body,
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

  async restoreNote(id: string): Promise<void> {
    const db = await this.dbPromise;
    const transaction = db.transaction(['notes', 'syncEvents'], 'readwrite');
    const noteStore = transaction.objectStore('notes');
    const existing = await requestToPromise<Note | undefined>(noteStore.get(id));

    if (!existing) {
      return;
    }

    const next = touchNote({ ...existing, deletedAt: null });
    noteStore.put(next);
    this.enqueue(transaction, 'note.restored', 'note', next.id, next);
    await transactionDone(transaction);
  }

  async deleteTag(id: string): Promise<void> {
    const db = await this.dbPromise;
    const transaction = db.transaction(['notes', 'tags', 'noteTags', 'syncEvents'], 'readwrite');
    const noteStore = transaction.objectStore('notes');
    const tagStore = transaction.objectStore('tags');
    const noteTagStore = transaction.objectStore('noteTags');
    const noteTags = await readAll<NoteTag>(noteTagStore);
    const affectedNoteIds = new Set<string>();

    for (const relation of noteTags.filter((relation) => relation.tagId === id)) {
      affectedNoteIds.add(relation.noteId);
      noteTagStore.delete(relation.id);
    }

    tagStore.delete(id);

    for (const noteId of affectedNoteIds) {
      const note = await requestToPromise<Note | undefined>(noteStore.get(noteId));

      if (!note) {
        continue;
      }

      const next = touchNote(note);
      noteStore.put(next);
      this.enqueue(transaction, 'tags.updated', 'note', noteId, { noteId, tags: [] });
    }

    await transactionDone(transaction);
  }

  async setNoteTags(noteId: string, input: string): Promise<Tag[]> {
    const wantedNames = uniqueTagNames(input);
    const db = await this.dbPromise;
    const transaction = db.transaction(['notes', 'tags', 'noteTags', 'syncEvents'], 'readwrite');
    const noteStore = transaction.objectStore('notes');
    const tagStore = transaction.objectStore('tags');
    const noteTagStore = transaction.objectStore('noteTags');
    const tags = await readAll<Tag>(tagStore);
    const noteTags = await readAll<NoteTag>(noteTagStore);
    const tagsByName = new Map(
      tags.map((tag) => [normalizeTagName(tag.name).toLocaleLowerCase(), tag]),
    );
    const currentTags = noteTags
      .filter((relation) => relation.noteId === noteId)
      .map((relation) => tags.find((tag) => tag.id === relation.tagId))
      .filter((tag): tag is Tag => Boolean(tag))
      .sort((a, b) => a.name.localeCompare(b.name, 'ja'));

    if (
      haveSameNameSet(
        currentTags.map((tag) => tag.name),
        wantedNames,
      )
    ) {
      await transactionDone(transaction);
      return currentTags;
    }

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
        createdAt: nowIso(),
      });
    }

    await this.pruneUnusedTags(transaction);

    const note = await requestToPromise<Note | undefined>(noteStore.get(noteId));

    if (note) {
      noteStore.put(touchNote(note));
    }

    this.enqueue(transaction, 'tags.updated', 'note', noteId, {
      noteId,
      tags: nextTags.map((tag) => tag.name),
    });
    await transactionDone(transaction);
    return nextTags;
  }

  private async listNotesWithTags(): Promise<NoteWithTags[]> {
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

    return notes.map((note) => ({
      ...note,
      tags: (tagsByNote.get(note.id) ?? []).sort((a, b) => a.name.localeCompare(b.name, 'ja')),
    }));
  }

  private async pruneUnusedTags(transaction: IDBTransaction): Promise<void> {
    const tagStore = transaction.objectStore('tags');
    const noteTagStore = transaction.objectStore('noteTags');
    const tags = await readAll<Tag>(transaction.objectStore('tags'));
    const noteTags = await readAll<NoteTag>(noteTagStore);
    const usedTagIds = new Set(noteTags.map((relation) => relation.tagId));

    for (const tag of tags) {
      if (!usedTagIds.has(tag.id)) {
        tagStore.delete(tag.id);
      }
    }
  }

  async getSyncSummary(): Promise<LocalSyncSummary> {
    const db = await this.dbPromise;
    const transaction = db.transaction(['syncEvents', 'meta'], 'readonly');
    const events = await readAll<SyncEvent>(transaction.objectStore('syncEvents'));
    const lastSyncedAt =
      (await requestToPromise<string | undefined>(
        transaction.objectStore('meta').get(lastSyncedKey),
      )) ?? null;
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

  async listPendingSyncEvents(): Promise<SyncEvent[]> {
    const db = await this.dbPromise;
    const transaction = db.transaction('syncEvents', 'readonly');
    const events = await readAll<SyncEvent>(transaction.objectStore('syncEvents'));
    await transactionDone(transaction);
    return events
      .filter((event) => event.status === 'pending' || event.status === 'failed')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async markSyncEvents(
    ids: string[],
    status: SyncEvent['status'],
    error: string | null = null,
  ): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    const at = nowIso();
    const idSet = new Set(ids);
    const db = await this.dbPromise;
    const transaction = db.transaction(['notes', 'syncEvents', 'meta'], 'readwrite');
    const noteStore = transaction.objectStore('notes');
    const eventStore = transaction.objectStore('syncEvents');
    const events = await readAll<SyncEvent>(eventStore);

    for (const event of events.filter((event) => idSet.has(event.id))) {
      eventStore.put({
        ...event,
        status,
        sentAt: status === 'sent' ? at : event.sentAt,
        error: status === 'failed' ? error : null,
      });

      if (status === 'sent' && event.entityType === 'note') {
        const note = await requestToPromise<Note | undefined>(noteStore.get(event.entityId));

        if (note) {
          noteStore.put({ ...note, syncStatus: 'synced' });
        }
      }
    }

    if (status === 'sent') {
      transaction.objectStore('meta').put(at, lastSyncedKey);
    }

    await transactionDone(transaction);
  }

  async applyRemoteNotes(notes: Note[]): Promise<void> {
    if (notes.length === 0) {
      return;
    }

    const db = await this.dbPromise;
    const transaction = db.transaction(['notes', 'syncEvents'], 'readwrite');
    const noteStore = transaction.objectStore('notes');
    const localNotes = await readAll<Note>(noteStore);

    for (const remote of notes) {
      const existing = await requestToPromise<Note | undefined>(noteStore.get(remote.id));

      if (
        existing &&
        existing.syncStatus !== 'synced' &&
        (existing.title !== remote.title ||
          existing.body !== remote.body ||
          existing.deletedAt !== remote.deletedAt) &&
        existing.updatedAt !== remote.updatedAt &&
        existing.version !== remote.version &&
        !localNotes.some(
          (note) =>
            note.isConflictCopy &&
            note.conflictSourceId === existing.id &&
            note.title === existing.title &&
            note.body === existing.body &&
            note.deletedAt === existing.deletedAt,
        )
      ) {
        const at = nowIso();
        const conflictCopy: Note = {
          ...existing,
          id: createId('note'),
          title: createConflictTitle(existing.title),
          createdAt: at,
          updatedAt: at,
          version: 1,
          syncStatus: 'pending',
          isConflictCopy: true,
          conflictSourceId: existing.id,
        };

        noteStore.put(conflictCopy);
        localNotes.push(conflictCopy);
        this.enqueue(transaction, 'note.created', 'note', conflictCopy.id, conflictCopy);
      }

      noteStore.put({ ...remote, syncStatus: 'synced' });
    }

    await transactionDone(transaction);
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
    payload: unknown,
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
      error: null,
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

  listDeletedNotes(): Promise<NoteWithTags[]> {
    return this.driver.listDeletedNotes();
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

  restoreNote(id: string): Promise<void> {
    return this.driver.restoreNote(id);
  }

  deleteTag(id: string): Promise<void> {
    return this.driver.deleteTag(id);
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

  listPendingSyncEvents(): Promise<SyncEvent[]> {
    return this.driver.listPendingSyncEvents();
  }

  markSyncEvents(
    ids: string[],
    status: SyncEvent['status'],
    error: string | null = null,
  ): Promise<void> {
    return this.driver.markSyncEvents(ids, status, error);
  }

  applyRemoteNotes(notes: Note[]): Promise<void> {
    return this.driver.applyRemoteNotes(notes);
  }
}

export function describeTags(tags: Tag[]): string {
  return formatTags(tags);
}

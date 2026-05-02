import type { Session } from '@supabase/supabase-js';
import type { LocalSyncSummary, Note, NoteWithTags, SyncEvent, Tag } from '@shiori/core';
import { getSupabaseClient } from './auth';
import type { LocalNoteStore } from './storage';

type RemoteNote = {
  id: string;
  user_id: string;
  title: string;
  body: string;
  body_format: Note['bodyFormat'];
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
  device_id: string;
  sync_status: 'synced';
  is_conflict_copy: boolean;
  conflict_source_id: string | null;
};

type RemoteTag = {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

type RemoteNoteTag = {
  note_id: string;
  tag_id: string;
  user_id: string;
  created_at: string;
};

function toRemoteNote(note: Note, userId: string): RemoteNote {
  return {
    id: note.id,
    user_id: userId,
    title: note.title,
    body: note.body,
    body_format: note.bodyFormat,
    created_at: note.createdAt,
    updated_at: note.updatedAt,
    deleted_at: note.deletedAt,
    version: note.version,
    device_id: note.deviceId,
    sync_status: 'synced',
    is_conflict_copy: note.isConflictCopy,
    conflict_source_id: note.conflictSourceId
  };
}

function fromRemoteNote(note: RemoteNote): Note {
  return {
    id: note.id,
    userId: note.user_id,
    title: note.title,
    body: note.body,
    bodyFormat: note.body_format,
    createdAt: note.created_at,
    updatedAt: note.updated_at,
    deletedAt: note.deleted_at,
    version: note.version,
    deviceId: note.device_id,
    syncStatus: 'synced',
    isConflictCopy: note.is_conflict_copy,
    conflictSourceId: note.conflict_source_id
  };
}

function toRemoteTags(tags: Tag[], userId: string): RemoteTag[] {
  return tags.map((tag) => ({
    id: tag.id,
    user_id: userId,
    name: tag.name,
    created_at: tag.createdAt,
    updated_at: tag.updatedAt
  }));
}

function toRemoteNoteTags(note: NoteWithTags, userId: string): RemoteNoteTag[] {
  return note.tags.map((tag) => ({
    note_id: note.id,
    tag_id: tag.id,
    user_id: userId,
    created_at: new Date().toISOString()
  }));
}

async function throwIfError<T>(result: { data: T; error: { message: string } | null }): Promise<T> {
  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.data;
}

async function pushNote(note: NoteWithTags, userId: string): Promise<void> {
  const supabase = getSupabaseClient();

  if (!supabase) {
    throw new Error('Supabase の接続情報が未設定です。');
  }

  await throwIfError(await supabase.from('notes').upsert(toRemoteNote(note, userId)));

  if (note.tags.length === 0) {
    await throwIfError(await supabase.from('note_tags').delete().eq('note_id', note.id));
    return;
  }

  await throwIfError(await supabase.from('tags').upsert(toRemoteTags(note.tags, userId)));
  await throwIfError(await supabase.from('note_tags').delete().eq('note_id', note.id));
  await throwIfError(await supabase.from('note_tags').insert(toRemoteNoteTags(note, userId)));
}

async function pushDeleteEvent(event: SyncEvent): Promise<void> {
  const supabase = getSupabaseClient();

  if (!supabase) {
    throw new Error('Supabase の接続情報が未設定です。');
  }

  const payload = event.payload as { id?: string; deletedAt?: string };
  const noteId = payload.id ?? event.entityId;
  const deletedAt = payload.deletedAt ?? new Date().toISOString();

  await throwIfError(
    await supabase
      .from('notes')
      .update({
        deleted_at: deletedAt,
        updated_at: deletedAt,
        sync_status: 'synced'
      })
      .eq('id', noteId)
  );
}

async function pushSyncEvent(event: SyncEvent, userId: string): Promise<void> {
  const supabase = getSupabaseClient();

  if (!supabase) {
    throw new Error('Supabase の接続情報が未設定です。');
  }

  await throwIfError(
    await supabase.from('sync_events').upsert({
      id: event.id,
      user_id: userId,
      type: event.type,
      entity_id: event.entityId,
      entity_type: event.entityType,
      payload: event.payload,
      status: 'sent',
      created_at: event.createdAt,
      sent_at: new Date().toISOString(),
      error: null
    })
  );
}

async function pullRemoteNotes(store: LocalNoteStore, since: string | null): Promise<void> {
  const supabase = getSupabaseClient();

  if (!supabase) {
    throw new Error('Supabase の接続情報が未設定です。');
  }

  let query = supabase.from('notes').select('*').order('updated_at', { ascending: true });

  if (since) {
    query = query.gt('updated_at', since);
  }

  const rows = await throwIfError(await query);
  await store.applyRemoteNotes((rows as RemoteNote[]).map(fromRemoteNote));
}

export async function syncWithSupabase(
  store: LocalNoteStore,
  session: Session
): Promise<LocalSyncSummary> {
  const userId = session.user.id;
  const beforeSync = await store.getSyncSummary();
  const events = await store.listPendingSyncEvents();
  const eventIds = events.map((event) => event.id);
  const notes = await store.listNotes('', null);
  const noteById = new Map(notes.map((note) => [note.id, note]));

  if (eventIds.length > 0) {
    await store.markSyncEvents(eventIds, 'syncing');
  }

  try {
    for (const event of events) {
      if (event.type === 'note.deleted') {
        await pushDeleteEvent(event);
      } else if (event.entityType === 'note') {
        const note = noteById.get(event.entityId);

        if (note) {
          await pushNote(note, userId);
        }
      }

      await pushSyncEvent(event, userId);
    }

    await pullRemoteNotes(store, beforeSync.lastSyncedAt);

    if (eventIds.length > 0) {
      await store.markSyncEvents(eventIds, 'sent');
    } else {
      await store.markAllSynced();
    }

    return store.getSyncSummary();
  } catch (error) {
    if (eventIds.length > 0) {
      await store.markSyncEvents(
        eventIds,
        'failed',
        error instanceof Error ? error.message : '同期に失敗しました'
      );
    }

    throw error;
  }
}

import type { Note, NoteWithTags, SyncStatus, Tag } from './types';
import { createId, getDeviceId } from './id';

export function nowIso(): string {
  return new Date().toISOString();
}

export function normalizeTitle(title: string, body: string): string {
  const trimmed = title.trim();

  if (trimmed.length > 0) {
    return trimmed;
  }

  const firstBodyLine = body
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return firstBodyLine?.slice(0, 80) || '無題のノート';
}

export function normalizeTagName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

export function uniqueTagNames(input: string): string[] {
  const seen = new Set<string>();

  return input
    .split(',')
    .map(normalizeTagName)
    .filter(Boolean)
    .filter((name) => {
      const key = name.toLocaleLowerCase();

      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}

export function createBlankNote(): Note {
  const at = nowIso();

  return {
    id: createId('note'),
    userId: null,
    title: '無題のノート',
    body: '',
    bodyFormat: 'markdown',
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    version: 1,
    deviceId: getDeviceId(),
    syncStatus: 'pending',
    isConflictCopy: false,
    conflictSourceId: null
  };
}

export function touchNote(note: Note, status: SyncStatus = 'pending'): Note {
  return {
    ...note,
    updatedAt: nowIso(),
    version: note.version + 1,
    syncStatus: status
  };
}

export function matchesNote(note: NoteWithTags, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();

  if (!normalized) {
    return true;
  }

  const target = [note.title, note.body, ...note.tags.map((tag) => tag.name)]
    .join('\n')
    .toLocaleLowerCase();

  return target.includes(normalized);
}

export function formatRelativeTime(iso: string | null): string {
  if (!iso) {
    return '未同期';
  }

  return new Intl.DateTimeFormat('ja-JP', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(iso));
}

export function formatTags(tags: Tag[]): string {
  return tags.map((tag) => tag.name).join(', ');
}


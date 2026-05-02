import type { Note, SyncEvent } from './types';

export function summarizeSync(events: SyncEvent[], lastSyncedAt: string | null) {
  return {
    pendingCount: events.filter((event) => event.status === 'pending' || event.status === 'syncing')
      .length,
    failedCount: events.filter((event) => event.status === 'failed').length,
    lastSyncedAt
  };
}

export function shouldCreateConflictCopy(local: Note, remote: Note): boolean {
  if (local.deletedAt || remote.deletedAt) {
    return local.updatedAt !== remote.updatedAt && local.version !== remote.version;
  }

  return local.version !== remote.version && local.updatedAt !== remote.updatedAt;
}

export function createConflictTitle(title: string): string {
  const date = new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date());

  return `${title || '無題のノート'}（競合コピー ${date}）`;
}


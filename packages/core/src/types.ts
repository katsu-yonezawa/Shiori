export type BodyFormat = 'markdown' | 'plain_text';

export type SyncStatus = 'local' | 'pending' | 'syncing' | 'synced' | 'failed' | 'conflict';

export type SyncEventStatus = 'pending' | 'syncing' | 'sent' | 'failed';

export type SyncEventType =
  | 'note.created'
  | 'note.updated'
  | 'note.restored'
  | 'note.deleted'
  | 'tags.updated';

export type Note = {
  id: string;
  userId: string | null;
  title: string;
  body: string;
  bodyFormat: BodyFormat;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  version: number;
  deviceId: string;
  syncStatus: SyncStatus;
  isConflictCopy: boolean;
  conflictSourceId: string | null;
};

export type Tag = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
};

export type NoteWithTags = Note & {
  tags: Tag[];
};

export type SyncEvent = {
  id: string;
  type: SyncEventType;
  entityId: string;
  entityType: 'note' | 'tag';
  payload: unknown;
  status: SyncEventStatus;
  createdAt: string;
  sentAt: string | null;
  error: string | null;
};

export type LocalSyncSummary = {
  pendingCount: number;
  failedCount: number;
  lastSyncedAt: string | null;
};

export type SaveState = 'saved' | 'dirty' | 'saving' | 'error';

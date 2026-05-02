export const sqliteMigrations = [
  {
    id: '0001_initial',
    description: 'Create notes, tags, note_tags, sync_events, and FTS index.'
  }
] as const;

export type MigrationId = (typeof sqliteMigrations)[number]['id'];


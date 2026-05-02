export const sqliteMigrations = [
  {
    id: '0001_initial',
    description: 'Create notes, tags, note_tags, sync_events, and FTS index.'
  }
] as const;

export const supabaseMigrations = [
  {
    id: '001_initial',
    description: 'Create user-scoped notes, tags, note_tags, sync_events, indexes, and RLS policies.'
  }
] as const;

export type MigrationId = (typeof sqliteMigrations)[number]['id'];
export type SupabaseMigrationId = (typeof supabaseMigrations)[number]['id'];

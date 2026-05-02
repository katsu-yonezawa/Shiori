CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS public.notes (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  body_format text NOT NULL DEFAULT 'markdown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  device_id text NOT NULL,
  sync_status text NOT NULL DEFAULT 'synced',
  is_conflict_copy boolean NOT NULL DEFAULT false,
  conflict_source_id text
);

CREATE TABLE IF NOT EXISTS public.tags (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.note_tags (
  note_id text NOT NULL REFERENCES public.notes(id) ON DELETE CASCADE,
  tag_id text NOT NULL REFERENCES public.tags(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (note_id, tag_id)
);

CREATE TABLE IF NOT EXISTS public.sync_events (
  id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL,
  entity_id text NOT NULL,
  entity_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'sent',
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  error text
);

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.note_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sync_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage their notes"
  ON public.notes
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage their tags"
  ON public.tags
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can manage their note tags"
  ON public.note_tags
  USING (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.notes n
      WHERE n.id = note_id AND n.user_id = auth.uid()
    )
  )
  WITH CHECK (
    auth.uid() = user_id
    AND EXISTS (
      SELECT 1 FROM public.notes n
      WHERE n.id = note_id AND n.user_id = auth.uid()
    )
    AND EXISTS (
      SELECT 1 FROM public.tags t
      WHERE t.id = tag_id AND t.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can manage their sync events"
  ON public.sync_events
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_lower_name
  ON public.tags(user_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_notes_user_updated_at
  ON public.notes(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_notes_user_deleted_at
  ON public.notes(user_id, deleted_at);

CREATE INDEX IF NOT EXISTS idx_sync_events_user_status_created_at
  ON public.sync_events(user_id, status, created_at);

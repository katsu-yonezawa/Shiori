import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';

export type AuthSnapshot =
  | {
      status: 'unconfigured';
      session: null;
      userEmail: null;
    }
  | {
      status: 'signed-out';
      session: null;
      userEmail: null;
    }
  | {
      status: 'signed-in';
      session: Session;
      userEmail: string | null;
    };

type Env = {
  VITE_SUPABASE_URL?: string;
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_SUPABASE_ANON_KEY?: string;
};

const env = ((import.meta as unknown as { env?: Env }).env ?? {}) as Env;
const supabaseUrl = env.VITE_SUPABASE_URL?.trim() ?? '';
const supabaseKey =
  env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() || env.VITE_SUPABASE_ANON_KEY?.trim() || '';

let client: SupabaseClient | null = null;

export function isAuthConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseKey);
}

export function getSupabaseClient(): SupabaseClient | null {
  if (!isAuthConfigured()) {
    return null;
  }

  client ??= createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: true,
      detectSessionInUrl: true,
      persistSession: true,
      storageKey: 'shiori.supabase.auth'
    }
  });

  return client;
}

function snapshotFromSession(session: Session | null): AuthSnapshot {
  if (!isAuthConfigured()) {
    return {
      status: 'unconfigured',
      session: null,
      userEmail: null
    };
  }

  if (!session) {
    return {
      status: 'signed-out',
      session: null,
      userEmail: null
    };
  }

  return {
    status: 'signed-in',
    session,
    userEmail: session.user.email ?? null
  };
}

export async function getAuthSnapshot(): Promise<AuthSnapshot> {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return snapshotFromSession(null);
  }

  const { data, error } = await supabase.auth.getSession();

  if (error) {
    throw new Error(error.message);
  }

  return snapshotFromSession(data.session);
}

export function subscribeToAuthChanges(onChange: (snapshot: AuthSnapshot) => void): () => void {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return () => undefined;
  }

  const {
    data: { subscription }
  } = supabase.auth.onAuthStateChange((_event, session) => {
    onChange(snapshotFromSession(session));
  });

  return () => subscription.unsubscribe();
}

export async function sendMagicLink(email: string): Promise<void> {
  const supabase = getSupabaseClient();

  if (!supabase) {
    throw new Error('Supabase の接続情報が未設定です。');
  }

  const normalizedEmail = email.trim();

  if (!normalizedEmail) {
    throw new Error('メールアドレスを入力してください。');
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo: window.location.origin
    }
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function signOut(): Promise<void> {
  const supabase = getSupabaseClient();

  if (!supabase) {
    return;
  }

  const { error } = await supabase.auth.signOut();

  if (error) {
    throw new Error(error.message);
  }
}

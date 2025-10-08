-- supabase.sql
-- Idempotent schema for the PWA app
-- Drops legacy tables then recreates canonical tables, RLS policies, triggers and indexes.

-- DROP legacy tables (safe to run multiple times)
-- We use CASCADE to remove dependent objects like triggers/policies/functions that reference these tables.
DROP TABLE IF EXISTS public.players CASCADE;
DROP TABLE IF EXISTS public.coaches CASCADE;
DROP TABLE IF EXISTS public.sessions CASCADE;
DROP TABLE IF EXISTS public.payments CASCADE;
DROP TABLE IF EXISTS public.competitions CASCADE;
DROP TABLE IF EXISTS public.training_plans CASCADE;
DROP TABLE IF EXISTS public.devices CASCADE;
DROP TABLE IF EXISTS public.notes CASCADE;
DROP TABLE IF EXISTS public.shared_backups CASCADE;
DROP TABLE IF EXISTS public.backups CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;

-- -----------------------------------------------------------------
-- Create profiles table (users)
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  first_name text,
  last_name text,
  phone text,
  avatar_url text,
  email_verified boolean DEFAULT false,
  last_sync_at timestamptz,
  last_sync_device text,
  last_sync_payload jsonb,
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS and policy for profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_self'
  ) THEN
    EXECUTE '
      CREATE POLICY "profiles_self" ON public.profiles
        FOR ALL
        USING ( auth.role() = ''authenticated'' AND id = auth.uid() )
        WITH CHECK ( auth.role() = ''authenticated'' AND id = auth.uid() )
    ';
  END IF;
END$$;

-- -----------------------------------------------------------------
-- New entity tables
-- -----------------------------------------------------------------

-- players
CREATE TABLE IF NOT EXISTS public.players (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  phone text,
  birthdate text,
  join_date text,
  insurance_date text,
  photo text,
  category text,
  height integer,
  weight integer,
  gender text,
  scores jsonb,
  events jsonb,
  created_at timestamptz DEFAULT now(),
  last_modified timestamptz DEFAULT now()
);
ALTER TABLE public.players ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'players' AND policyname = 'players_self'
  ) THEN
    EXECUTE '
      CREATE POLICY "players_self" ON public.players
        FOR ALL
        USING ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
        WITH CHECK ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
    ';
  END IF;
END$$;

-- coaches
CREATE TABLE IF NOT EXISTS public.coaches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  name text,
  title text,
  phone text,
  photo text,
  created_at timestamptz DEFAULT now(),
  last_modified timestamptz DEFAULT now()
);
ALTER TABLE public.coaches ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'coaches' AND policyname = 'coaches_self'
  ) THEN
    EXECUTE '
      CREATE POLICY "coaches_self" ON public.coaches
        FOR ALL
        USING ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
        WITH CHECK ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
    ';
  END IF;
END$$;

-- sessions
CREATE TABLE IF NOT EXISTS public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  title text,
  date timestamptz,
  category text,
  coach_id uuid,
  attendances jsonb,
  created_at timestamptz DEFAULT now(),
  last_modified timestamptz DEFAULT now()
);
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'sessions' AND policyname = 'sessions_self'
  ) THEN
    EXECUTE '
      CREATE POLICY "sessions_self" ON public.sessions
        FOR ALL
        USING ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
        WITH CHECK ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
    ';
  END IF;
END$$;

-- payments
CREATE TABLE IF NOT EXISTS public.payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  player_id uuid,
  amount numeric,
  date timestamptz,
  payment_month text,
  payment_year text,
  type text,
  note text,
  created_at timestamptz DEFAULT now(),
  last_modified timestamptz DEFAULT now()
);
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'payments' AND policyname = 'payments_self'
  ) THEN
    EXECUTE '
      CREATE POLICY "payments_self" ON public.payments
        FOR ALL
        USING ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
        WITH CHECK ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
    ';
  END IF;
END$$;

-- competitions
CREATE TABLE IF NOT EXISTS public.competitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  title text,
  team_a text,
  team_b text,
  score_a int,
  score_b int,
  date timestamptz,
  time text,
  kind text,
  status text,
  venue text,
  sets jsonb,
  created_at timestamptz DEFAULT now(),
  last_modified timestamptz DEFAULT now()
);
ALTER TABLE public.competitions ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'competitions' AND policyname = 'competitions_self'
  ) THEN
    EXECUTE '
      CREATE POLICY "competitions_self" ON public.competitions
        FOR ALL
        USING ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
        WITH CHECK ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
    ';
  END IF;
END$$;

-- training_plans
CREATE TABLE IF NOT EXISTS public.training_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  title text,
  date timestamptz,
  time text,
  coach_id uuid,
  body text,
  reminder text,
  created_at timestamptz DEFAULT now(),
  last_modified timestamptz DEFAULT now()
);
ALTER TABLE public.training_plans ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'training_plans' AND policyname = 'training_plans_self'
  ) THEN
    EXECUTE '
      CREATE POLICY "training_plans_self" ON public.training_plans
        FOR ALL
        USING ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
        WITH CHECK ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
    ';
  END IF;
END$$;

-- devices
CREATE TABLE IF NOT EXISTS public.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id text NOT NULL,
  device_name text,
  last_seen timestamptz DEFAULT now()
);
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'devices' AND policyname = 'devices_self'
  ) THEN
    EXECUTE '
      CREATE POLICY "devices_self" ON public.devices
        FOR ALL
        USING ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
        WITH CHECK ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
    ';
  END IF;
END$$;

-- notes (simple key-value text storage for miscellaneous app data)
CREATE TABLE IF NOT EXISTS public.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id text,
  content text,
  revision bigint DEFAULT 1,
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'notes' AND policyname = 'notes_self'
  ) THEN
    EXECUTE '
      CREATE POLICY "notes_self" ON public.notes
        FOR ALL
        USING ( auth.uid() = user_id )
        WITH CHECK ( auth.uid() = user_id )
    ';
  END IF;
END$$;

-- shared_backups (group/email based)
CREATE TABLE IF NOT EXISTS public.shared_backups (
  id bigserial PRIMARY KEY,
  group_email text NOT NULL,
  data jsonb NOT NULL,
  device_id text,
  last_sync_at timestamptz DEFAULT now(),
  last_sync_device text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.shared_backups ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'shared_backups' AND policyname = 'shared_backups_group_email'
  ) THEN
    EXECUTE '
      CREATE POLICY "shared_backups_group_email" ON public.shared_backups
        FOR ALL
        USING ( auth.role() = ''authenticated'' AND lower(current_setting(''jwt.claims.email'', true)) = lower(group_email) )
        WITH CHECK ( auth.role() = ''authenticated'' AND lower(current_setting(''jwt.claims.email'', true)) = lower(group_email) )
    ';
  END IF;
END$$;

-- normalize group_email trigger/function
DO $$
BEGIN
  IF NOT EXISTS ( SELECT 1 FROM pg_proc WHERE proname = 'shared_backups_normalize_email' ) THEN
    EXECUTE $fn$
      CREATE FUNCTION public.shared_backups_normalize_email()
      RETURNS trigger AS $pl$
      BEGIN
        IF NEW.group_email IS NOT NULL THEN
          NEW.group_email := lower(NEW.group_email);
        END IF;
        RETURN NEW;
      END;
      $pl$ LANGUAGE plpgsql SECURITY DEFINER;
    $fn$;
  END IF;

  IF NOT EXISTS ( SELECT 1 FROM pg_trigger WHERE tgname = 'trg_shared_backups_normalize' ) THEN
    EXECUTE 'CREATE TRIGGER trg_shared_backups_normalize BEFORE INSERT OR UPDATE ON public.shared_backups FOR EACH ROW EXECUTE PROCEDURE public.shared_backups_normalize_email()';
  END IF;
END$$;

-- backups (per-user JSON snapshots); keep metadata for multi-device sync
CREATE TABLE IF NOT EXISTS public.backups (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  data jsonb NOT NULL,
  device_id text,
  operation text DEFAULT 'sync',
  revision bigint DEFAULT 1,
  updated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.backups ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'backups' AND policyname = 'backups_self'
  ) THEN
    EXECUTE '
      CREATE POLICY "backups_self" ON public.backups
        FOR ALL
        USING ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
        WITH CHECK ( auth.role() = ''authenticated'' AND user_id = auth.uid() )
    ';
  END IF;
END$$;

-- -----------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_players_user ON public.players (user_id);
CREATE INDEX IF NOT EXISTS idx_coaches_user ON public.coaches (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON public.sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON public.payments (user_id);
CREATE INDEX IF NOT EXISTS idx_competitions_user ON public.competitions (user_id);
CREATE INDEX IF NOT EXISTS idx_trainingplans_user ON public.training_plans (user_id);
CREATE INDEX IF NOT EXISTS idx_devices_user ON public.devices (user_id);
CREATE INDEX IF NOT EXISTS idx_notes_user ON public.notes (user_id);
CREATE INDEX IF NOT EXISTS idx_backups_user_created ON public.backups (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shared_backups_group_email ON public.shared_backups (group_email, last_sync_at DESC);

-- Create unique index on lower(group_email) to avoid duplicates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname='public' AND tablename='shared_backups' AND indexname='shared_backups_group_email_unique'
  ) THEN
    BEGIN
      EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS shared_backups_group_email_unique ON public.shared_backups (lower(group_email))';
    EXCEPTION WHEN others THEN
      -- ignore failures (may fail under RLS/deployment constraints)
      NULL;
    END;
  END IF;
END$$;

-- -----------------------------------------------------------------
-- Utility functions & triggers for auth integration
-- -----------------------------------------------------------------

-- ensure profiles row exists on auth.users insert (handle_new_user)
-- Create or replace the handle_new_user function (idempotent)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  -- Ensure a profile row exists for the new auth user (best-effort)
  BEGIN
    INSERT INTO public.profiles (id, email, updated_at)
    VALUES (NEW.id, COALESCE(NEW.email, (NEW.raw_user_meta_data->>'email')), now())
    ON CONFLICT (id) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  -- Try to ensure a shared_backups placeholder for the user's email (best-effort)
  BEGIN
    INSERT INTO public.shared_backups (group_email, data, device_id, last_sync_at, created_at)
    VALUES (lower(COALESCE(NEW.email, (NEW.raw_user_meta_data->>'email'))), '{}'::jsonb, NULL, now(), now())
    ON CONFLICT (group_email) DO NOTHING;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create the trigger if it doesn't already exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_created') THEN
    EXECUTE 'CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user()';
  END IF;
END$$;

-- keep profiles.email_verified in sync with auth.users.email_confirmed_at
-- Create or replace the sync_profile_email_verified function (idempotent)
CREATE OR REPLACE FUNCTION public.sync_profile_email_verified()
RETURNS trigger AS $$
BEGIN
  BEGIN
    UPDATE public.profiles SET email_verified = (NEW.email_confirmed_at IS NOT NULL)
    WHERE id = NEW.id;
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create the trigger if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'on_auth_user_updated') THEN
    EXECUTE 'CREATE TRIGGER on_auth_user_updated AFTER UPDATE ON auth.users FOR EACH ROW EXECUTE PROCEDURE public.sync_profile_email_verified()';
  END IF;
END$$;

-- -----------------------------------------------------------------
-- Best-effort consolidation of duplicate shared_backups rows
-- (Runs at deploy time; safe to run multiple times)
-- -----------------------------------------------------------------
DO $$
DECLARE
  rec RECORD;
  keeper_id bigint;
BEGIN
  FOR rec IN
    SELECT lower(group_email) AS email, COUNT(*) AS cnt
    FROM public.shared_backups
    GROUP BY lower(group_email)
    HAVING COUNT(*) > 1
  LOOP
    BEGIN
      SELECT id INTO keeper_id
      FROM public.shared_backups
      WHERE lower(group_email) = rec.email
      AND data IS NOT NULL
      AND data <> '{}'::jsonb
      ORDER BY coalesce(last_sync_at, created_at) DESC
      LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
      keeper_id := NULL;
    END;

    IF keeper_id IS NULL THEN
      SELECT id INTO keeper_id
      FROM public.shared_backups
      WHERE lower(group_email) = rec.email
      ORDER BY coalesce(last_sync_at, created_at) DESC
      LIMIT 1;
    END IF;

    IF keeper_id IS NOT NULL THEN
      BEGIN
        UPDATE public.shared_backups SET group_email = rec.email WHERE id = keeper_id;
      EXCEPTION WHEN OTHERS THEN NULL; END;
      BEGIN
        DELETE FROM public.shared_backups WHERE lower(group_email) = rec.email AND id <> keeper_id;
      EXCEPTION WHEN OTHERS THEN NULL; END;
    END IF;
  END LOOP;
EXCEPTION WHEN OTHERS THEN
  -- ignore consolidation errors
  NULL;
END$$;

-- -----------------------------------------------------------------
-- Backfill helpers (best-effort, idempotent)
-- -----------------------------------------------------------------
DO $$
BEGIN
  -- backfill shared_backups for existing profiles
  IF EXISTS (SELECT 1 FROM public.profiles) THEN
    EXECUTE $q$
      INSERT INTO public.shared_backups (group_email, data, device_id, last_sync_at, created_at)
      SELECT lower(p.email), '{}'::jsonb, NULL, now(), now()
      FROM public.profiles p
      WHERE p.email IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM public.shared_backups s WHERE lower(s.group_email) = lower(p.email)
        );
    $q$;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END$$;

-- -----------------------------------------------------------------
-- End of schema
-- -----------------------------------------------------------------

-- Notes:
-- 1) This script is intentionally defensive and idempotent so it can be run multiple times during deployment.
-- 2) Make sure the pgcrypto extension is enabled in the database for gen_random_uuid() (Supabase usually provides it).
-- 3) After deployment, run the app and call `window.syncHybrid.init()` in the client after auth to populate local state from server.

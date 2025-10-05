-- LEGACY SYNC SQL (moved out)
-- This file contains the previous sync-related schema and triggers that were removed from `supabase.sql`.
-- It includes backups, shared_backups, devices, notes, and related triggers/policies/migrations.
-- KEEP THIS FILE AS A SAFETY COPY. Do not execute unless you intend to restore the legacy behavior.

/*
[...legacy content excerpted from original supabase.sql starts here]

-- backups table stores JSON snapshots per user
create table if not exists public.backups (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  data jsonb not null,
  created_at timestamptz default now()
);

-- add device_id, operation, revision, updated_at to backups for multi-device sync metadata
-- (additional alter statements and consolidation logic)

-- Create shared_backups table for group/email-based shared snapshots
create table if not exists public.shared_backups (
  id bigserial primary key,
  group_email text not null,
  data jsonb not null,
  device_id text,
  last_sync_at timestamptz default now(),
  created_at timestamptz default now()
);

-- (many other statements: RLS policies for shared_backups, normalization trigger, consolidation PL/pgSQL block, unique index creation, last_sync_device column, devices table, notes table, handle_new_user trigger inserting into shared_backups, backfills, optional migration to rebuild shared_backups, etc.)

[...legacy content excerpted ends here]
*/

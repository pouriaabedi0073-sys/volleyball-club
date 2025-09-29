-- Supabase schema for profiles and backups

-- profiles table stores user public profile info
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  first_name text,
  last_name text,
  phone text,
  avatar_url text,
  updated_at timestamptz default now()
);

-- add last_sync metadata fields to profiles for client-side sync tracking
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='profiles' and column_name='last_sync_at'
  ) then
    execute 'alter table public.profiles add column last_sync_at timestamptz';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='profiles' and column_name='last_sync_device'
  ) then
    execute 'alter table public.profiles add column last_sync_device text';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='profiles' and column_name='last_sync_payload'
  ) then
    execute 'alter table public.profiles add column last_sync_payload jsonb';
  end if;
end$$;

-- backups table stores JSON snapshots per user
create table if not exists public.backups (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete cascade,
  data jsonb not null,
  created_at timestamptz default now()
);

-- enable Row Level Security
alter table public.profiles enable row level security;
alter table public.backups enable row level security;

-- profiles RLS: users can select/update their own profile
-- Create profiles policy only if it doesn't exist
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_self'
  ) then
    execute '
      create policy "profiles_self" on public.profiles
        for all
        using ( auth.role() = ''authenticated'' and id = auth.uid() )
        with check ( auth.role() = ''authenticated'' and id = auth.uid() )
    ';
  end if;
end$$;

-- backups RLS: users can insert/select their own backups
-- Create backups policy only if it doesn't exist
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='backups' and policyname='backups_self'
  ) then
    execute '
      create policy "backups_self" on public.backups
        for all
        using ( auth.role() = ''authenticated'' and user_id = auth.uid() )
        with check ( auth.role() = ''authenticated'' and user_id = auth.uid() )
    ';
  end if;
end$$;

-- Index for backups by user
-- Create index for backups by user only if `created_at` exists (idempotent)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='backups' and column_name='created_at'
  ) then
    execute 'create index if not exists backups_user_idx on public.backups (user_id, created_at desc)';
  end if;
end$$;

-- Add device_id, operation, revision, updated_at to backups for multi-device sync metadata
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='backups' and column_name='device_id'
  ) then
    execute 'alter table public.backups add column device_id text';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='backups' and column_name='operation'
  ) then
    execute 'alter table public.backups add column operation text default ''sync''';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='backups' and column_name='revision'
  ) then
    execute 'alter table public.backups add column revision bigint default 1';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='backups' and column_name='updated_at'
  ) then
    execute 'alter table public.backups add column updated_at timestamptz default now()';
  end if;
end$$;

-- Create shared_backups table for group/email-based shared snapshots
create table if not exists public.shared_backups (
  id bigserial primary key,
  group_email text not null,
  data jsonb not null,
  device_id text,
  last_sync_at timestamptz default now(),
  created_at timestamptz default now()
);

alter table public.shared_backups enable row level security;

-- Policy: allow authenticated users to operate on shared_backups for their email
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='shared_backups' and policyname='shared_backups_group_email'
  ) then
    execute '
      create policy "shared_backups_group_email" on public.shared_backups
        for all
        using ( auth.role() = ''authenticated'' and lower(current_setting(''jwt.claims.email'', true)) = lower(group_email) )
        with check ( auth.role() = ''authenticated'' and lower(current_setting(''jwt.claims.email'', true)) = lower(group_email) )
    ';
  end if;
end$$;

-- Ensure group_email is stored in lowercase: trigger function and trigger
do $$
begin
  if not exists ( select 1 from pg_proc where proname = 'shared_backups_normalize_email' ) then
    execute $fn$
      create function public.shared_backups_normalize_email()
      returns trigger as $pl$
      begin
        if new.group_email is not null then
          new.group_email := lower(new.group_email);
        end if;
        return new;
      end;
      $pl$ language plpgsql security definer;
    $fn$;
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_shared_backups_normalize') then
    execute 'create trigger trg_shared_backups_normalize before insert or update on public.shared_backups for each row execute procedure public.shared_backups_normalize_email()';
  end if;
end$$;

-- Index for fast lookup by group_email and recency
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='shared_backups' and column_name='group_email'
  ) then
    execute 'create index if not exists shared_backups_group_email_idx on public.shared_backups (group_email, last_sync_at desc)';
  end if;
end$$;

-- Create devices table for tracking client devices
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  device_id text not null,
  device_name text,
  last_seen timestamptz default now()
);

alter table public.devices enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='devices' and policyname='devices_self'
  ) then
    execute '
      create policy "devices_self" on public.devices
        for all
        using ( auth.role() = ''authenticated'' and user_id = auth.uid() )
        with check ( auth.role() = ''authenticated'' and user_id = auth.uid() )
    ';
  end if;
end$$;

-- Create a simple notes table for app data sync
create table if not exists public.notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  device_id text,
  content text,
  revision bigint default 1,
  updated_at timestamptz default now()
);

alter table public.notes enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='notes' and policyname='notes_self'
  ) then
    execute '
      create policy "notes_self" on public.notes
        for all
        using ( auth.uid() = user_id )
        with check ( auth.uid() = user_id )
    ';
  end if;
end$$;

-- Function to create profile on auth.user sign up (trigger)
create or replace function public.handle_new_user()
returns trigger as $$
begin
  -- Use the email column if present, otherwise try raw_user_meta_data
  insert into public.profiles (id, email, updated_at)
  values (new.id, coalesce(new.email, (new.raw_user_meta_data->>'email') ), now())
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer;

-- Create trigger only if it doesn't exist to avoid duplicate trigger errors
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'on_auth_user_created') then
    execute 'create trigger on_auth_user_created
      after insert on auth.users
      for each row execute procedure public.handle_new_user()';
  end if;
end$$;

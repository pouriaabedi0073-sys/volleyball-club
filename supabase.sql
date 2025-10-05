-- Clean Supabase schema: remove legacy sync objects and add domain tables for PWA app
-- NOTE: backup your database before applying.

-- profiles (keep minimal)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  first_name text,
  last_name text,
  phone text,
  avatar_url text,
  email_verified boolean default false,
  updated_at timestamptz default now()
);

-- Domain tables
create table if not exists public.players (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  phone text,
  team text,
  status text default 'active',
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.coaches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  phone text,
  role text,
  notes text,
  created_at timestamptz default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  player_id uuid references public.players(id) on delete cascade,
  amount bigint not null,
  paid_at timestamptz default now(),
  note text,
  created_at timestamptz default now()
);

create table if not exists public.attendances (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  player_id uuid references public.players(id) on delete cascade,
  session_date date not null,
  status text default 'present',
  note text,
  created_at timestamptz default now()
);

create table if not exists public.trainings (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  starts_at timestamptz,
  ends_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists public.settings (
  id text primary key,
  value jsonb,
  updated_at timestamptz default now()
);

-- enable Row Level Security
alter table public.profiles enable row level security;
alter table public.players enable row level security;
alter table public.coaches enable row level security;
alter table public.payments enable row level security;
alter table public.attendances enable row level security;
alter table public.trainings enable row level security;
alter table public.settings enable row level security;

-- Policies: profiles (owner only)
do $$
begin
  if not exists (
    select 1 from pg_policies where schemaname='public' and tablename='profiles' and policyname='profiles_self'
  ) then
    execute $pol$
      create policy profiles_self on public.profiles
        for all
        using ( auth.role() = 'authenticated' and id = auth.uid() )
        with check ( auth.role() = 'authenticated' and id = auth.uid() );
    $pol$;
  end if;
end$$;

-- Players: read for authenticated; modify if owner (user_id) or user_id is null (created by system)
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='players' and policyname='players_read') then
    execute $pol$ create policy players_read on public.players for select using ( auth.role() = 'authenticated' ); $pol$;
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='players' and policyname='players_modify_own') then
    execute $pol2$
      create policy players_modify_own on public.players
        for all
        using ( auth.role() = 'authenticated' and (user_id = auth.uid() or user_id is null) )
        with check ( auth.role() = 'authenticated' and (user_id = auth.uid() or user_id is null) );
    $pol2$;
  end if;
end$$;

-- Coaches policies
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='coaches' and policyname='coaches_read') then
    execute $pol3$ create policy coaches_read on public.coaches for select using ( auth.role() = 'authenticated' ); $pol3$;
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='coaches' and policyname='coaches_modify_own') then
    execute $pol4$
      create policy coaches_modify_own on public.coaches
        for all
        using ( auth.role() = 'authenticated' and (user_id = auth.uid() or user_id is null) )
        with check ( auth.role() = 'authenticated' and (user_id = auth.uid() or user_id is null) );
    $pol4$;
  end if;
end$$;

-- Payments: select for authenticated; inserts allowed by authenticated users setting user_id = auth.uid()
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='payments' and policyname='payments_read') then
    execute $pol5$ create policy payments_read on public.payments for select using ( auth.role() = 'authenticated' ); $pol5$;
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='payments' and policyname='payments_insert_own') then
    execute $pol6$
      create policy payments_insert_own on public.payments
        for insert
        with check ( auth.role() = 'authenticated' and user_id = auth.uid() )
        using ( auth.role() = 'authenticated' and user_id = auth.uid() );
    $pol6$;
  end if;
end$$;

-- Attendances policies
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='attendances' and policyname='attendances_read') then
    execute $pol7$ create policy attendances_read on public.attendances for select using ( auth.role() = 'authenticated' ); $pol7$;
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='attendances' and policyname='attendances_modify_own') then
    execute $pol8$
      create policy attendances_modify_own on public.attendances
        for all
        using ( auth.role() = 'authenticated' and user_id = auth.uid() )
        with check ( auth.role() = 'authenticated' and user_id = auth.uid() );
    $pol8$;
  end if;
end$$;

-- Trainings policies
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='trainings' and policyname='trainings_read') then
    execute $pol9$ create policy trainings_read on public.trainings for select using ( auth.role() = 'authenticated' ); $pol9$;
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='trainings' and policyname='trainings_modify_creator') then
    execute $pol10$
      create policy trainings_modify_creator on public.trainings for all
        using ( auth.role() = 'authenticated' and created_by = auth.uid() )
        with check ( auth.role() = 'authenticated' and created_by = auth.uid() );
    $pol10$;
  end if;
end$$;

-- Settings policies (read for authenticated; restrict updates)
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='settings' and policyname='settings_read') then
    execute $pol11$ create policy settings_read on public.settings for select using ( auth.role() = 'authenticated' ); $pol11$;
  end if;
end$$;

-- Trigger to update updated_at on players
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'players_set_updated_at') then
    execute 'create trigger players_set_updated_at before update on public.players for each row execute procedure public.set_updated_at()';
  end if;
end$$;

-- Indexes
create index if not exists players_user_idx on public.players (user_id);
create index if not exists payments_player_idx on public.payments (player_id);
-- Ensure there's a normalize function for shared_backups.group_email and a trigger that calls it
do $$
begin
  -- create function if it doesn't exist
  if not exists (select 1 from pg_proc where proname = 'shared_backups_normalize_email') then
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

  -- create the trigger if not already present
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

-- Consolidate any duplicate rows for the same lower(group_email) before creating a unique index.
-- Strategy: for each duplicated lower(group_email), choose a keeper row (prefer non-empty data, then newest last_sync_at/created_at),
-- update its group_email to canonical lower-case, and delete the other rows (best-effort).
do $$
declare
  rec record;
  keeper_id bigint;
  keeper_data jsonb;
  dup_email text;
begin
  for rec in
    select lower(group_email) as email, count(*) as cnt
    from public.shared_backups
    group by lower(group_email)
    having count(*) > 1
  loop
    dup_email := rec.email;
    -- Try to pick a keeper with non-empty data ordered by most recent last_sync_at/created_at
    begin
      select id, data into keeper_id, keeper_data
      from public.shared_backups
      where lower(group_email) = dup_email
        and data is not null
        and data <> '{}'::jsonb
      order by coalesce(last_sync_at, created_at) desc
      limit 1;
    exception when others then
      keeper_id := null; keeper_data := null;
    end;
    -- If none with non-empty data, pick the most recent row
    if keeper_id is null then
      select id, data into keeper_id, keeper_data
      from public.shared_backups
      where lower(group_email) = dup_email
      order by coalesce(last_sync_at, created_at) desc
      limit 1;
    end if;
    -- Canonicalize keeper's group_email to lower-case
    if keeper_id is not null then
      begin
        update public.shared_backups set group_email = dup_email where id = keeper_id;
      exception when others then end;
      -- Delete other rows for this email (best-effort; may fail under strict RLS)
      begin
        delete from public.shared_backups where lower(group_email) = dup_email and id <> keeper_id;
      exception when others then
        -- ignore deletion failures
        null;
      end;
    end if;
  end loop;
exception when others then
  -- don't fail deployment if consolidation can't run
  null;
end$$;

-- Ensure only one shared_backups row exists per lower(group_email)
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='shared_backups' and column_name='group_email'
  ) then
    -- create a unique index on the lowercased group_email to prevent duplicates created by concurrent inserts
    execute 'create unique index if not exists shared_backups_group_email_unique on public.shared_backups (lower(group_email))';
  end if;
end$$;

-- Add last_sync_device to shared_backups to store a human-friendly device name (idempotent)
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='shared_backups' and column_name='last_sync_device'
  ) then
    execute 'alter table public.shared_backups add column last_sync_device text';
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
  -- Ensure there's a placeholder shared_backups row for this email so
  -- cross-device discovery works immediately. This is idempotent and
  -- will not fail the user creation if the table doesn't exist or
  -- insertion fails for any reason.
  begin
    insert into public.shared_backups (group_email, data, device_id, last_sync_at, created_at)
    values (
      lower(coalesce(new.email, (new.raw_user_meta_data->>'email'))),
      '{}'::jsonb,
      null,
      now(),
      now()
    )
    on conflict (group_email) do nothing;
  exception when others then
    -- ignore; don't block user creation if shared_backups isn't present or insert fails
    null;
  end;
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

-- Keep profiles.email_verified in sync when auth.users changes (e.g., email confirmation)
create or replace function public.sync_profile_email_verified()
returns trigger as $$
begin
  begin
    update public.profiles set email_verified = coalesce(new.email_confirmed_at is not null, false)
    where id = new.id;
  exception when others then
    -- don't fail auth changes if profiles update cannot run
    null;
  end;
  return new;
end;
$$ language plpgsql security definer;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'on_auth_user_updated') then
    execute 'create trigger on_auth_user_updated
      after update on auth.users
      for each row execute procedure public.sync_profile_email_verified()';
  end if;
end$$;

-- Backfill: ensure existing profiles have a shared_backups placeholder (idempotent)
do $$
begin
  if exists (select 1 from public.profiles) then
    insert into public.shared_backups (group_email, data, device_id, last_sync_at, created_at)
    select lower(p.email), '{}'::jsonb, null, now(), now()
    from public.profiles p
    where p.email is not null
      and not exists (select 1 from public.shared_backups s where lower(s.group_email) = lower(p.email));
  end if;
exception when others then
  -- ignore errors during backfill to avoid blocking deployment
  null;
end$$;

-- Backfill profiles.email_verified from auth.users for existing users (idempotent)
do $$
begin
  update public.profiles p
  set email_verified = (u.email_confirmed_at is not null)
  from auth.users u
  where p.id = u.id
    and (p.email_verified is distinct from (u.email_confirmed_at is not null));
exception when others then
  null;
end$$;

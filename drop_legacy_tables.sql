-- Drop legacy tables and move to JSON-snapshot based backups
-- WARNING: This will delete all data in these tables. Make sure you have:
-- 1. Created a final backup of all data
-- 2. Verified the backup can be restored
-- 3. Have approval to proceed with dropping tables

BEGIN;

-- First drop any constraints/dependencies
ALTER TABLE IF EXISTS public.payments DROP CONSTRAINT IF EXISTS fk_payments_player_id;

-- Drop core app tables (data now lives in JSON snapshots)
DROP TABLE IF EXISTS public.players CASCADE;
DROP TABLE IF EXISTS public.sessions CASCADE;
DROP TABLE IF EXISTS public.payments CASCADE;
DROP TABLE IF EXISTS public.devices CASCADE;

-- Drop archive tables no longer needed
DROP TABLE IF EXISTS public.backups_duplicates CASCADE;

-- Drop old indexes if they exist
DROP INDEX IF EXISTS public.idx_players_group;

COMMIT;

-- Verify only our 3 core tables remain
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
AND table_type = 'BASE TABLE'
ORDER BY table_name;
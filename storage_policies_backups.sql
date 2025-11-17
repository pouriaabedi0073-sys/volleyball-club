-- storage_policies_backups.sql
-- Drop existing backup-related storage policies (if any) and create new ones
-- These policies assume files are uploaded to the `backups` bucket under a folder
-- whose name is the user's email with @ and . replaced by underscores, e.g.
--   backups/<email_replace>/backup_2025-...json
-- The policies compare the first folder component to the email claim inside the
-- authenticated JWT: replace('@' and '.').

-- WARNING: Run these in Supabase SQL Editor as a project admin.

-- Drop older policies if present
DROP POLICY IF EXISTS delete_old_backups ON storage.objects;
DROP POLICY IF EXISTS list_own_backups ON storage.objects;
DROP POLICY IF EXISTS upload_own_backup ON storage.objects;
-- Create INSERT policy (allow authenticated users to upload into their own user-id folder)
CREATE POLICY upload_own_backup
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'backups'::text
  AND (
    -- allow only if the first folder component equals the caller's auth.uid()
    (storage.foldername(name))[1] = auth.uid()::text
  )
);

-- Create SELECT policy (allow authenticated users to list/download files in their user-id folder)
CREATE POLICY list_own_backups
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'backups'::text
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
  )
);

-- Create DELETE policy (allow authenticated users to remove files in their user-id folder)
CREATE POLICY delete_old_backups
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'backups'::text
  AND (
    (storage.foldername(name))[1] = auth.uid()::text
  )
);

-- Notes:
-- 1) These policies use auth.jwt() ->> 'email' to read the email claim from the
--    user's JWT. Supabase includes the user's email in the JWT by default.
-- 2) If your upload code uses a different folder structure (for example user.id
--    instead of email), adjust the policies accordingly (compare to auth.uid()).
-- 3) After running, test by uploading from the browser client and ensure the
--    upload succeeds and that listing returns only files in the user's folder.

-- Quick test queries (run in SQL Editor as admin):
-- SELECT auth.jwt() ->> 'email';
-- SELECT storage.foldername('poria1111_1_gmail_com/backup_2025-11-16T21-57-54-319Z.json');
-- SELECT * FROM storage.objects WHERE bucket_id = 'backups' LIMIT 20;

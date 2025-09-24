Supabase Auth & Profile quick start

Files added / location:
- Supabase integration and auth UI have been inlined into `index.html` (no separate auth files).
- `supabase.sql` - SQL to create `profiles`, `backups` tables, RLS policies, trigger

Setup steps
1. Create a Supabase project using your existing project URL and anon key (already in `auth.js`).
2. In Supabase > Table editor > SQL, run the contents of `supabase.sql` to create the schema.
3. Create a public storage bucket named `avatars` with "Public" enabled (or adjust code to use signed URLs).
4. Serve the files locally in `project_fixed_` directory. Example using Python:

```powershell
python -m http.server 5500
```

5. Open `http://localhost:5500/index.html` in Chrome (emulator ok) and test:
- Sign up with email (or phone) and verify the flow
- Sign in with credentials
- Edit profile, upload avatar, click "ذخیره پروفایل"
- Verify `profiles` and `backups` tables in Supabase table editor

Notes & limitations
- The anon key cannot perform admin operations. Email uniqueness is enforced by Supabase auth; signup errors will report already-registered emails.
- Avatar upload uses a public storage bucket called `avatars`.
- For production, move keys to server-side env or use service_role carefully.

Want me to:
- Run the SQL in your Supabase project via the API? (requires service_role key — not safe to share)
- Tweak UI for accessibility or add stronger validation?
- Add a small Node/Express backend to handle server-side operations securely?

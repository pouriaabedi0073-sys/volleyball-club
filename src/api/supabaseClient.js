// src/api/supabaseClient.js
// Minimal shim to provide a module-friendly way to access the existing Supabase client.
export function getSupabaseClient() {
  if (typeof window.supabase !== 'undefined') return window.supabase;
  if (typeof window.supabaseClient !== 'undefined') return window.supabaseClient;
  // try UMD global 'supabase' variable
  if (typeof supabase !== 'undefined' && typeof supabase.createClient === 'function') {
    try { window.supabase = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY); return window.supabase; } catch(e) { /* ignore */ }
  }
  return null;
}
export default getSupabaseClient;

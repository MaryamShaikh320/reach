/* =====================================================================
   Reach configuration (loaded before app.js)

   GEOAPIFY_KEY powers ZIP lookup + nearby park search for any US ZIP.
   Get or manage keys at https://myprojects.geoapify.com

   Note: this key ships to the browser, so anyone who opens the site can see it.
   In the Geoapify dashboard, restrict it to your site's address
   (API key settings > allowed origins / HTTP referrers), and keep an eye on
   usage (free plan: 3,000 credits/day).

   Leave the key empty ('') to run with only the curated San Jose places.

   SUPABASE_URL / SUPABASE_ANON_KEY power Local Chat (README > Local Chat).
   Find both in Supabase: Project Settings > API ("Project URL" and the
   "anon public" key). The anon key is meant to be public: what it can do is
   limited by the rules in supabase/chat.sql. Never put the service_role key here.
   Leave them empty to hide chat behind a "not set up yet" notice.
   ===================================================================== */
window.GREENESCAPE_CONFIG = {
  GEOAPIFY_KEY: 'b53d6df2730548579ead381336cc6e5d',
  SUPABASE_URL: 'https://qwsyetswyaclapzwztzk.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF3c3lldHN3eWFjbGFwend6dHprIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTIyMDg4MTQsImV4cCI6MjEwNzc4NDgxNH0.vUqvEwIDemnzMIjtltCMPc-STAw3Tp3okjdrjAc981k',
};

# Supabase State Sync

Self Calendar can sync the whole app state as one JSON document in Supabase.

## 1. Create Table

Run this SQL in the Supabase SQL editor:

```sql
create table if not exists public.self_calendar_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
```

For a personal local server, the simplest option is to use the Supabase service role key in `.env`.
Do not put the service role key in frontend code or commit it to git.

## 2. Configure `.env`

```env
SUPABASE_URL=https://your-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_STATE_TABLE=self_calendar_state
SUPABASE_STATE_ID=default
```

## 3. How Sync Works

- `GET /api/state` reads local `data/state.json` and, if configured, Supabase.
- `POST /api/state` writes local `data/state.json` and, if configured, upserts Supabase.
- If cloud sync is not configured or fails, the local JSON file still works.
- The whole app state stays as one JSON document for now.

## 4. Future Mobile/APK Note

The current Supabase service role key approach is safe only behind the local Node server.
For a mobile APK or public PWA, use one of these instead:

- Supabase Auth + row-level security policies.
- A small private sync API that keeps the service role key on the server.
- A personal token endpoint with rate limiting.

-- =====================================================================
-- Reach Local Chat: database setup for Supabase
--
-- Run this once in your Supabase project: Dashboard > SQL Editor > New query,
-- paste this whole file, Run. It is safe to run again (idempotent).
--
-- What it creates:
--   chat_messages    public messages, one row per message, grouped by `room`
--   chat_reports     user reports (keeps a copy of the reported text)
--   chat_moderators  user ids allowed to remove messages and ban people
--   chat_bans        user ids that can no longer post
--
-- Rules enforced here (the browser can't get around them):
--   - you can only post as yourself (user_id is always auth.uid())
--   - names 2-24 characters, messages 1-500 characters
--   - at most 5 messages per 15 seconds and 30 per 5 minutes per person
--   - no posting the same text twice within a minute
--   - banned users can't post
--   - a message reported by 3 different people is removed automatically
--   - only moderators can remove messages or ban users
--
-- No locations are stored: a room is just a city slug like "san-jose-ca".
-- =====================================================================

-- ---------- Tables ----------
create table if not exists public.chat_messages (
  id          bigint generated always as identity primary key,
  room        text not null check (room ~ '^[a-z0-9-]{2,80}$'),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  username    text not null check (char_length(btrim(username)) between 2 and 24),
  body        text not null check (char_length(btrim(body)) between 1 and 500),
  created_at  timestamptz not null default now()
);
create index if not exists chat_messages_room_time on public.chat_messages (room, created_at desc);
create index if not exists chat_messages_user_time on public.chat_messages (user_id, created_at desc);

create table if not exists public.chat_reports (
  id           bigint generated always as identity primary key,
  message_id   bigint references public.chat_messages (id) on delete set null,
  reporter_id  uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reason       text check (reason is null or char_length(reason) <= 200),
  -- snapshot of the message, so moderators can review it after it's removed
  room         text,
  author_id    uuid,
  author_name  text,
  body         text,
  created_at   timestamptz not null default now(),
  unique (message_id, reporter_id)
);

create table if not exists public.chat_moderators (
  user_id  uuid primary key references auth.users (id) on delete cascade
);

create table if not exists public.chat_bans (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  reason      text,
  banned_by   uuid,
  created_at  timestamptz not null default now()
);

-- ---------- Helpers ----------
create or replace function public.chat_is_moderator()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.chat_moderators where user_id = auth.uid());
$$;

-- ---------- Spam protection: runs before every new message ----------
create or replace function public.chat_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  last_body text;
begin
  -- Never trust the client for identity or time
  new.user_id    := auth.uid();
  new.created_at := now();
  new.username   := btrim(new.username);
  new.body       := btrim(new.body);

  if new.user_id is null then
    raise exception 'Sign-in required' using errcode = '42501';
  end if;
  if exists (select 1 from public.chat_bans where user_id = new.user_id) then
    raise exception 'You have been removed from Local Chat' using errcode = '42501';
  end if;
  if (select count(*) from public.chat_messages
      where user_id = new.user_id and created_at > now() - interval '15 seconds') >= 5
     or (select count(*) from public.chat_messages
      where user_id = new.user_id and created_at > now() - interval '5 minutes') >= 30 then
    raise exception 'Slow down a little: you are sending messages too fast' using errcode = 'P0001';
  end if;
  select body into last_body from public.chat_messages
    where user_id = new.user_id and created_at > now() - interval '1 minute'
    order by created_at desc limit 1;
  if last_body is not null and lower(last_body) = lower(new.body) then
    raise exception 'You just sent that message' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

drop trigger if exists chat_before_insert on public.chat_messages;
create trigger chat_before_insert before insert on public.chat_messages
  for each row execute function public.chat_before_insert();

-- ---------- Reports: snapshot the message, auto-remove at 3 reports ----------
create or replace function public.chat_before_report()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m public.chat_messages;
begin
  new.reporter_id := auth.uid();
  new.created_at  := now();
  select * into m from public.chat_messages where id = new.message_id;
  if m.id is null then
    raise exception 'That message no longer exists' using errcode = 'P0001';
  end if;
  if m.user_id = new.reporter_id then
    raise exception 'You can''t report your own message' using errcode = 'P0001';
  end if;
  new.room := m.room; new.author_id := m.user_id; new.author_name := m.username; new.body := m.body;
  return new;
end;
$$;

create or replace function public.chat_after_report()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select count(distinct reporter_id) from public.chat_reports where message_id = new.message_id) >= 3 then
    delete from public.chat_messages where id = new.message_id;
  end if;
  return null;
end;
$$;

drop trigger if exists chat_before_report on public.chat_reports;
create trigger chat_before_report before insert on public.chat_reports
  for each row execute function public.chat_before_report();
drop trigger if exists chat_after_report on public.chat_reports;
create trigger chat_after_report after insert on public.chat_reports
  for each row execute function public.chat_after_report();

-- ---------- Moderator actions (called from the chat UI) ----------
create or replace function public.chat_remove_message(message_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.chat_is_moderator() then
    raise exception 'Moderators only' using errcode = '42501';
  end if;
  delete from public.chat_messages where id = message_id;
end;
$$;

-- Bans the author of a message and removes their recent messages (last 24 hours).
create or replace function public.chat_ban_author(message_id bigint, reason text default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  author uuid;
begin
  if not public.chat_is_moderator() then
    raise exception 'Moderators only' using errcode = '42501';
  end if;
  select user_id into author from public.chat_messages where id = message_id;
  if author is null then
    raise exception 'That message no longer exists' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.chat_moderators where user_id = author) then
    raise exception 'You can''t ban a moderator' using errcode = 'P0001';
  end if;
  insert into public.chat_bans (user_id, reason, banned_by) values (author, reason, auth.uid())
    on conflict (user_id) do nothing;
  delete from public.chat_messages where user_id = author and created_at > now() - interval '24 hours';
end;
$$;

revoke all on function public.chat_remove_message(bigint) from public, anon;
revoke all on function public.chat_ban_author(bigint, text) from public, anon;
grant execute on function public.chat_remove_message(bigint) to authenticated;
grant execute on function public.chat_ban_author(bigint, text) to authenticated;
grant execute on function public.chat_is_moderator() to authenticated;

-- ---------- Row Level Security ----------
-- Anonymous sign-ins use the `authenticated` role, so every visitor gets a
-- private user id without creating an account. The `anon` role gets nothing.
alter table public.chat_messages   enable row level security;
alter table public.chat_reports    enable row level security;
alter table public.chat_moderators enable row level security;
alter table public.chat_bans       enable row level security;

drop policy if exists "read messages"   on public.chat_messages;
drop policy if exists "post messages"   on public.chat_messages;
drop policy if exists "file reports"    on public.chat_reports;
drop policy if exists "mods read reports" on public.chat_reports;
drop policy if exists "see own mod role" on public.chat_moderators;
drop policy if exists "see own ban"     on public.chat_bans;

create policy "read messages" on public.chat_messages
  for select to authenticated using (true);
create policy "post messages" on public.chat_messages
  for insert to authenticated with check (user_id = auth.uid());
-- No update/delete policies: messages can't be edited, and removal goes through
-- chat_remove_message / chat_ban_author / the 3-report rule.

create policy "file reports" on public.chat_reports
  for insert to authenticated with check (reporter_id = auth.uid());
create policy "mods read reports" on public.chat_reports
  for select to authenticated using (public.chat_is_moderator());

create policy "see own mod role" on public.chat_moderators
  for select to authenticated using (user_id = auth.uid());
create policy "see own ban" on public.chat_bans
  for select to authenticated using (user_id = auth.uid());

-- Column-level: clients may only send room, username and body.
-- (revoke all first: projects with "Automatically expose new tables" on grant everything by default)
revoke all on public.chat_messages from anon, authenticated;
grant select on public.chat_messages to authenticated;
grant insert (room, username, body) on public.chat_messages to authenticated;
revoke all on public.chat_reports from anon, authenticated;
grant select on public.chat_reports to authenticated;
grant insert (message_id, reason) on public.chat_reports to authenticated;
revoke all on public.chat_moderators, public.chat_bans from anon, authenticated;
grant select on public.chat_moderators, public.chat_bans to authenticated;

-- ---------- Realtime: push new and removed messages to open chats ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end $$;

-- ---------- Making someone a moderator ----------
-- Open Local Chat, then the "..." menu > "Copy my chat ID". Then run:
--   insert into public.chat_moderators (user_id) values ('PASTE-ID-HERE');
-- Review reports:
--   select * from public.chat_reports order by created_at desc;
-- Unban:
--   delete from public.chat_bans where user_id = 'PASTE-ID-HERE';

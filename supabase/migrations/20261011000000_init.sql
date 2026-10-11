-- ASAP v1 schema (handoff §9).
--
-- Access model: every table has RLS enabled with NO policies, and anon/authenticated have no
-- grants. Supabase's public API keys therefore can't read or write anything. All access goes
-- through the Netlify Functions, which connect with a privileged role and apply the
-- organizer-vs-invitee privacy split (invitees only ever get paint_counts).

create extension if not exists pgcrypto;

create type meeting_state as enum
  ('OPEN', 'COMPUTING', 'PROPOSED', 'LOCKED', 'DESTABILIZED', 'RECOMPUTING', 'CLOSED');
create type paint_level as enum ('free', 'if_need_be');
create type participant_role as enum ('organizer', 'invitee');
create type graph_node_kind as enum ('person', 'artifact', 'blob');

create table meetings (
  id                       uuid primary key default gen_random_uuid(),
  title                    text not null check (char_length(title) between 1 and 200),
  duration_min             int  not null check (duration_min between 30 and 480 and duration_min % 30 = 0),
  tz                       text not null,             -- organizer's timezone; defines the window
  window_start             date not null,             -- first day, in tz
  window_days              int  not null check (window_days between 1 and 31),
  day_start_min            int  not null default 480  check (day_start_min between 0 and 1410),
  day_end_min              int  not null default 1200 check (day_end_min between 30 and 1440),
  state                    meeting_state not null default 'OPEN',
  quorum_mode              text not null default 'soft',
  organizer_participant_id uuid,
  created_at               timestamptz not null default now(),
  check (day_end_min > day_start_min)
);

create table participants (
  id               uuid primary key default gen_random_uuid(),
  meeting_id       uuid not null references meetings(id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 80),
  email            text check (email is null or char_length(email) <= 254),
  role             participant_role not null default 'invitee',
  is_dm            boolean not null default false,
  guest_token_hash text not null unique,
  claimed_user_id  uuid,
  home_city        text,
  tz               text,
  responded_at     timestamptz,
  created_at       timestamptz not null default now()
);
create index participants_meeting_idx on participants(meeting_id);

alter table meetings
  add constraint meetings_organizer_fk
  foreign key (organizer_participant_id) references participants(id) deferrable initially deferred;

create table paints (
  participant_id uuid not null references participants(id) on delete cascade,
  slot_ts        timestamptz not null,
  level          paint_level not null,
  primary key (participant_id, slot_ts)
);

-- The only paint data an invitee ever sees.
create view paint_counts as
  select pa.meeting_id, p.slot_ts,
         count(*) filter (where p.level = 'free')       as free_n,
         count(*) filter (where p.level = 'if_need_be') as inb_n
  from paints p join participants pa on pa.id = p.participant_id
  group by pa.meeting_id, p.slot_ts;

create table proposals (
  id              uuid primary key default gen_random_uuid(),
  meeting_id      uuid not null references meetings(id) on delete cascade,
  slot_ts         timestamptz not null,
  score           numeric not null,
  breakdown_json  jsonb not null,
  weights_version text not null,
  rank            int not null,
  status          text not null default 'proposed'
                  check (status in ('proposed', 'alternate', 'locked', 'superseded')),
  below_quorum    boolean not null default false,
  created_at      timestamptz not null default now()
);
create index proposals_meeting_idx on proposals(meeting_id);

create table locks (
  id             uuid primary key default gen_random_uuid(),
  meeting_id     uuid not null references meetings(id) on delete cascade,
  proposal_id    uuid not null references proposals(id),
  locked_at      timestamptz not null default now(),
  gcal_event_id  text,
  superseded_by  uuid references locks(id)
);
create index locks_meeting_idx on locks(meeting_id);

create table events (
  id         bigint generated always as identity primary key,
  meeting_id uuid not null references meetings(id) on delete cascade,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  at         timestamptz not null default now()
);
create index events_meeting_idx on events(meeting_id, at);

create table graph_nodes (
  id                uuid primary key default gen_random_uuid(),
  meeting_id        uuid not null references meetings(id) on delete cascade,
  kind              graph_node_kind not null,
  parent_meeting_id uuid references meetings(id) on delete set null,  -- v2 blob groundwork
  cluster_key       text,
  ref_id            uuid,
  created_at        timestamptz not null default now()
);
create index graph_nodes_meeting_idx on graph_nodes(meeting_id);

-- Lock everything down for Supabase's public API roles.
alter table meetings     enable row level security;
alter table participants enable row level security;
alter table paints       enable row level security;
alter table proposals    enable row level security;
alter table locks        enable row level security;
alter table events       enable row level security;
alter table graph_nodes  enable row level security;
alter view paint_counts set (security_invoker = true);

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      -- and for tables later migrations create
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
    end if;
  end loop;
end $$;

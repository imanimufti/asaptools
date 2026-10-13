-- Repairs (CUJ-4/5/6), the Required flag (D2) and the meeting space (CUJ-7).

alter table participants
  add column is_required boolean not null default false,   -- must attend, without being a decision maker
  add column optional    boolean not null default false,   -- organizer chose "invite as optional"
  add column declined_at timestamptz,                       -- organizer kept the meeting without them
  add column token_enc   text;                              -- link token, encrypted, so emails and "copy link" can show it again

-- One flex ask per blocking person (2f): the organizer asks, the person answers Sure / Can't.
create table flex_asks (
  id             uuid primary key default gen_random_uuid(),
  meeting_id     uuid not null references meetings(id) on delete cascade,
  participant_id uuid not null references participants(id) on delete cascade,
  slot_ts        timestamptz not null,
  status         text not null default 'pending' check (status in ('pending', 'sure', 'cant')),
  created_at     timestamptz not null default now(),
  answered_at    timestamptz
);
create index flex_asks_meeting_idx on flex_asks(meeting_id);

-- How a person attends, set by a semantic drop in the meeting space.
alter table graph_nodes
  add column mode text check (mode in ('home', 'in_person', 'remote_with')),
  add constraint graph_nodes_person_once unique (meeting_id, kind, ref_id);

alter table flex_asks enable row level security;

do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on flex_asks from %I', r);
    end if;
  end loop;
end $$;

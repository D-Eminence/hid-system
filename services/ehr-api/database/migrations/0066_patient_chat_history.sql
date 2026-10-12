-- Patient-owned chat history. Clinical chat text stays in encrypted RDS,
-- behind fresh self authorization and forced row-level security.
create table ehr.patient_chat_state (
  patient_id uuid primary key references identity.patients(id) on delete cascade,
  generation uuid not null default gen_random_uuid(),
  unique (patient_id, generation)
);
create table ehr.patient_chat_messages (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null,
  generation uuid not null,
  question text not null check (length(question) between 1 and 500),
  reply jsonb not null check (jsonb_typeof(reply)='object'
    and reply->>'status' in ('ready','preparing')
    and length(reply->>'answer') between 1 and 4000
    and jsonb_typeof(reply->'sources')='array'),
  source_bindings jsonb not null check (jsonb_typeof(source_bindings)='array'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (patient_id,generation) references ehr.patient_chat_state(patient_id,generation)
);
create index patient_chat_messages_patient_time on ehr.patient_chat_messages(patient_id,created_at desc,id desc);
alter table ehr.patient_chat_state enable row level security;
alter table ehr.patient_chat_state force row level security;
alter table ehr.patient_chat_messages enable row level security;
alter table ehr.patient_chat_messages force row level security;
create policy patient_chat_state_self on ehr.patient_chat_state
  using (ehr.patient_self_context(patient_id)) with check (ehr.patient_self_context(patient_id));
create policy patient_chat_messages_self on ehr.patient_chat_messages
  using (ehr.patient_self_context(patient_id)) with check (ehr.patient_self_context(patient_id));
-- Existing staging roles receive only these table privileges. Fresh databases
-- receive the same grants through runtime-grants.sql after roles are created.
do $$ begin
  if exists (select 1 from pg_roles where rolname='hid_ehr_runtime') then
    grant select,insert,update on ehr.patient_chat_state to hid_ehr_runtime;
    grant select,insert,delete on ehr.patient_chat_messages to hid_ehr_runtime;
  end if;
end $$;

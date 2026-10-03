-- Derived embeddings belong to EHR because only EHR owns the source notes.
-- They contain no note text; current revision joins prevent stale citations.
create extension if not exists vector with schema public;

alter table ehr.clinical_note_revisions
  add constraint clinical_note_revisions_ai_reference
  unique (clinical_note_id, revision_no, patient_id, facility_id);

create table ehr.patient_record_embeddings (
  note_id uuid not null,
  revision_no integer not null,
  patient_id uuid not null,
  facility_id uuid not null,
  content_sha256 char(64) not null,
  model_id text not null check (length(model_id) between 1 and 160),
  embedding public.vector(1024) not null,
  indexed_at timestamptz not null default clock_timestamp(),
  primary key (note_id, revision_no, model_id),
  foreign key (note_id, revision_no, patient_id, facility_id)
    references ehr.clinical_note_revisions
      (clinical_note_id, revision_no, patient_id, facility_id)
    on delete restrict
);

create index patient_record_embeddings_patient_idx
  on ehr.patient_record_embeddings (patient_id, model_id);

alter table ehr.patient_record_embeddings enable row level security;
alter table ehr.patient_record_embeddings force row level security;

create policy patient_record_embeddings_self_read
  on ehr.patient_record_embeddings for select
  using (ehr.patient_self_context(patient_id));

create policy patient_record_embeddings_self_insert
  on ehr.patient_record_embeddings for insert
  with check (ehr.patient_self_context(patient_id) and exists (
    select 1 from ehr.clinical_notes note
    join ehr.clinical_note_revisions revision
      on revision.clinical_note_id = note.id
      and revision.revision_no = note.current_revision_no
    where note.id = note_id and note.patient_id = patient_record_embeddings.patient_id
      and note.facility_id = patient_record_embeddings.facility_id
      and note.current_revision_no = patient_record_embeddings.revision_no
      and note.status in ('signed', 'amended')
      and revision.content_sha256 = patient_record_embeddings.content_sha256
  ));

create policy patient_record_embeddings_self_update
  on ehr.patient_record_embeddings for update
  using (ehr.patient_self_context(patient_id))
  with check (ehr.patient_self_context(patient_id));

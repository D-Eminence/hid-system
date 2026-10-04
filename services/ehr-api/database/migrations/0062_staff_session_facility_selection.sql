-- A workforce facility choice belongs to its HID session. Membership remains
-- authoritative and is checked again whenever the session is resolved.
alter table auth.sessions
  add column selected_facility_id uuid references identity.facilities(id) on delete restrict;

alter table auth.sessions
  add constraint patient_session_has_no_selected_facility
  check (session_kind = 'staff' or selected_facility_id is null);

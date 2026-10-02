-- Outreach campaign foreign-key support added after the accepted 0038 baseline.
-- Keep 0038 immutable and add the exact unique key required by its membership_id + facility_id foreign key.
create unique index staff_memberships_id_facility_uq
  on identity.staff_facility_memberships (id, facility_id);

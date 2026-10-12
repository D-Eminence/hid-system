-- Seed the purpose-of-use vocabulary with direct-care. 0003 created
-- identity.purpose_of_use_codes empty, and no migration, role bootstrap or
-- legacy importer ever inserted a row, yet every consent decision requires an
-- active code: identity.has_active_consent_grant (0012) returns false, the
-- standard access request and the clinician's grant close (0010) and
-- break-glass (0031) refuse with 22023, the patient access PIN (0033, 0079)
-- refuses with 22023 'Patient PIN access requires direct care', and the
-- consent directive trigger (0008) refuses with 23514. So on a database built
-- only from migrations every staff consent check failed closed; the
-- rollback-only suites and the runtime verifiers hid this by inserting the
-- codes themselves. Applied migrations 0001 through 0081 are immutable.
--
-- Only direct-care is seeded, as governed reference data in the way 0006
-- seeds auth.roles and 0039 platform.control_settings. Two codes the services
-- also name wait for product decisions and are not seeded: emergency, which
-- would make break-glass usable at once wherever the break_glass_enabled
-- control is on (its 0039 default), and healthcare-operations, which belongs
-- to the open OCR purpose-of-use decision. ON CONFLICT DO NOTHING keeps a row
-- an operator already inserted, or deliberately deactivated, exactly as it is.
--
-- The insert takes a ROW EXCLUSIVE lock on identity.purpose_of_use_codes
-- only. No grant changes.

insert into identity.purpose_of_use_codes (code, display, active, source_system)
values ('direct-care', 'Direct patient care', true, 'hid')
on conflict (code) do nothing;

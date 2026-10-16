-- Break-glass at launch, with limits (owner decision of 2026-10-14 on D9;
-- ADR-058 addendum). Applied migrations 0001 through 0096 are immutable.
--
-- ADR-058 re-enables a module only through a reviewed migration that grants
-- its permissions again; for break-glass it also needs the emergency purpose
-- and its control. This is that migration. It grants again only what 0091
-- withdrew for break-glass and seeds the purpose; it changes no control,
-- function, policy or grant to a database role.
--
-- 0. Precondition: break_glass_enabled is not on. 0091 set it off only where
--    the row was still exactly as 0039 seeded it, and kept a value an
--    administrator had set. Were it on, this migration would make break-glass
--    live at its commit, before staff MFA ships and the operator turns the
--    control on (P11). It is refused instead (55000 BREAK_GLASS_CONTROL_ON)
--    and nothing is changed: a platform administrator sets the control off
--    with POST /admin/controls and migrate runs again. The flag is read
--    through platform.control_enabled, as every guard reads it. Before the
--    first role bootstrap that function cannot see the row (forced row-level
--    security, an administrator that does not bypass it, as on RDS) and
--    raises PLATFORM_CONTROL_UNAVAILABLE; no runtime role exists yet, so no
--    administrator can have changed the control through the API, and it is
--    as 0091 left it: the migration goes on. A missing row raises the same,
--    and every activation then fails closed on it.
--
-- 1. Permission. 0010 granted identity.break-glass.write to doctor, clinician
--    and nurse, no later migration granted it to another role, and 0091
--    deleted it from every role (0084 never held it). Those three rows are
--    inserted again (ON CONFLICT DO NOTHING); no other role receives it, and
--    no other permission 0084 or 0091 withdrew is granted. The rest of the
--    path is already held by the three roles: identity.consent.write (the
--    activation route requires it with break-glass.write),
--    identity.patient.read (the lookup that opens the record) and
--    ehr.encounter.read and ehr.note.read (the emergency summary route; its
--    further categories need their own reads, which they hold).
--
-- 2. Emergency purpose. identity.activate_break_glass (0031) refuses unless
--    an active 'emergency' purpose of use exists, the access request and grant
--    it writes reference the code (0008), and identity.has_active_consent_grant
--    (0012) honours an emergency read only while the code is active. 0082
--    seeded only direct-care. 'emergency' ("Emergency treatment", active,
--    source hid) is inserted as 0082 inserted direct-care: ON CONFLICT (code)
--    DO NOTHING keeps a row an operator already inserted, or deactivated,
--    exactly as it is. healthcare-operations stays unseeded (N3). Standard
--    access requests and PIN grants still accept only their own purposes.
--
-- 3. Not changed: the control. break_glass_enabled stays off (0091 or an
--    administrator set it so; the precondition above refuses it on).
--    Identity checks it in the activation transaction before the command, so
--    after this migration break-glass still answers
--    423 BREAK_GLASS_DISABLED until a platform administrator
--    turns the control on with the audited POST /admin/controls, which the
--    release checklist makes an operator step after staff MFA ships (P11).
--    A migration has no actor for a control event (0084, 0091). Nor are the
--    limits changed: a break-glass grant authorizes only the emergency read
--    (0012); the emergency summary covers the activating facility only and
--    the chart routes stay closed to the emergency purpose (D9; Health-id
--    hand-off B1); the summary's vitals are as first recorded (D8; A11(a));
--    and the clinician's request list leaves break-glass grants out (0074),
--    so after a reload a grant is found again only by replaying the
--    activation (B11). The document list and download are not chart routes
--    and take the emergency purpose as before, so a break-glass grant reads
--    the activating facility's documents; whether it should is open (N3,
--    Health-id hand-off B1(c)) and must be decided before uploads come back.
--    Uploads are off (0091) and no import writes EHR documents, so a
--    database built for launch holds none.
--
-- The role bootstrap's assertions (runtime-roles.integration.sql) change with
-- this migration: they require exactly these three holders. The bootstrap of
-- this release must therefore run after it, and an earlier release's
-- bootstrap refuses a database that holds 0097.
--
-- Locks: ACCESS SHARE on platform.control_settings (the control read, taken
-- first, as an activation and the role bootstrap take that table first),
-- ROW EXCLUSIVE on auth.role_permissions and on
-- identity.purpose_of_use_codes, and the foreign keys' FOR KEY SHARE locks on
-- the three auth.roles rows and the auth.permissions row; at most four rows
-- are written and no table is scanned. Each lock waits at most the runner's
-- 5 s lock timeout; a timeout rolls 0097 back whole, and it can be run again.

-- 0. Precondition.
do $$
declare
  break_glass_on boolean;
begin
  begin
    break_glass_on := platform.control_enabled('break_glass_enabled');
  exception when sqlstate '55000' then
    if sqlerrm is distinct from 'PLATFORM_CONTROL_UNAVAILABLE' then
      raise;
    end if;
    break_glass_on := false;
  end;
  if break_glass_on then
    raise exception using errcode = '55000',
      message = 'BREAK_GLASS_CONTROL_ON: break_glass_enabled must be off before break-glass is granted again; '
        || 'set it off with POST /admin/controls (release checklist P11) and run migrate again',
      hint = 'Nothing was changed. 0091 kept a value an administrator had set. Turn the control on again only '
        || 'with the P11 operator step, after staff MFA ships.';
  end if;
end
$$;

-- 1. Permission.
insert into auth.role_permissions (role_code, permission_code)
select mapping.role_code, 'identity.break-glass.write'
  from (values ('doctor'), ('clinician'), ('nurse')) as mapping(role_code)
on conflict (role_code, permission_code) do nothing;

-- 2. Emergency purpose.
insert into identity.purpose_of_use_codes (code, display, active, source_system)
values ('emergency', 'Emergency treatment', true, 'hid')
on conflict (code) do nothing;

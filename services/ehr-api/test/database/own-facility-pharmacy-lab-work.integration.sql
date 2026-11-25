\set ON_ERROR_STOP on
-- 0133 (ORD-2 of the Akos EHR plan of 18 November 2026; finding F2):
-- activated prescriptions go to the hospital's own pharmacy by themselves,
-- and the facility's pharmacy and lab staff work on their own facility's
-- work items without a personal consent grant, never the chart.
-- Rollback-only. Through the exact runtime roles the services use
-- (hid_ehr_api_runtime, hid_pharmacy_api_runtime, hid_lab_api_runtime), in
-- the session the services set.
-- Cases:
--   1. structure: the new and replaced functions' bodies (md5), owner,
--      SECURITY DEFINER, volatility, search_path; who may execute each (each
--      kind's row's half its own runtime's only; D14's reader the Pharmacy
--      runtime's; the trigger functions nobody's); 0086's context_allows and
--      work_item_allows bodies unchanged; the 46 own-work policies (a read
--      policy on each work item table, 42 on the chain, and 0144's two on the
--      pharmacist acceptances, pharmacy.work_item_acceptances) and none on the
--      imported evidence tables; the sends table, D14's claims and D15's list
--      have no grant, row-level security on and not forced, no policy; the
--      two ehr.prescriptions policies name only the dispensing validator's
--      owner, no runtime role is its member, and the owner-run definer
--      functions that read ehr.prescriptions are the eight known ones (0144's
--      acceptance trigger function, pharmacy.validate_work_item_acceptance,
--      the eighth); D14's
--      replaced order-route send and resend flag are 0123's and 0086's text
--      with each D14 hunk once (without them, md5 0c2def2b and cd18f1a4),
--      their attributes and EXECUTE kept; pharmacy.work_items' only unique
--      key on the prescription is work_items_prescription_kind_uq; the six
--      D14 and D15 triggers are enabled always (the claim key's two among
--      them). 0148 (Q132 A, a change after dispensing reaches the pharmacy)
--      changes none of these counts: it adds a trigger on ehr.prescriptions
--      that fires after D8's (prescriptions_pharmacy_change_after_dispensing)
--      and reads D14's claims, a table of its own and a reader; no policy,
--      and no body that names ehr.prescriptions (S7 is unchanged by it);
--   2. the send: the prescriber's activated prescription becomes a work item
--      accepted by the prescriber with the fixed reason, one event, one
--      outbox event with pharmacy-api's own four payload keys (what the event
--      dispatcher admits), a sent row; a second send writes nothing; a failed
--      attempt leaves the prescription active and the send pending with the
--      SQLSTATE, and the next send sends it; not the prescriber, a draft, a
--      changed version, a facility with nobody to work on pharmacy items;
--      a receptionist, an emergency session and a missing session are
--      refused 42501;
--   2b. ehr.own_pharmacy_staffed (D7's no_pharmacy test for the list and
--      page): true at F1 (for the doctor and the pharmacist), false at F3
--      (nobody works on pharmacy items there), null for a member who may not
--      read prescriptions (the receptionist, the lab scientist) and without a
--      session; it writes nothing;
--   2c. that test (the staffed answer and D7's no_pharmacy) asks the full
--      permission check of the members holding a pharmacy role only: 200
--      more members at F3 add no check (counted with track_functions), and
--      the full check still decides (a disabled account, a revoked role: not
--      staffed; the two permissions through two roles: staffed, and D7 sends);
--   3. the pharmacist without a grant sees the item, its card and its
--      event, may work on it (own_work_access_for, basis 'own-work'), its
--      list basis is 'own-work', and dispenses it; it reads nothing of the chart
--      (ehr.context_allows is false, ehr.prescriptions is not readable);
--      a second work item for a sent prescription is refused (one item per
--      prescription), and so is accepting a prescription nobody sent;
--   4. not for: a nurse, an admin, a receptionist, a clinician and a doctor
--      without a grant (they hold the read permission but not the receive
--      one), a member whose role holds the receive permission but not the
--      read one, a lab scientist (pharmacy items), a pharmacist of another
--      facility, an emergency session, a patient with a deny directive (her
--      item and its events), an inactive patient; a pharmacist with a grant
--      keeps the basis 'consent', on the list and on every command
--      (own_work_access_for answers 'consent' for the action its grant
--      covers);
--   5. stopping after the send: the change itself marks the send withdrawn
--      (D8's trigger: an UPDATE of the prescription alone, as today's
--      ehr-api images make it, without calling the withdrawal), once; the
--      withdrawal answers that it stands withdrawn; the item reads withdrawn,
--      and dispensing it is refused (PRESCRIPTION_SOURCE_NOT_DISPENSABLE); a
--      sent prescription edited while active, or resumed after the hold, is
--      marked withdrawn too (the pharmacy keeps the version sent) and the
--      send answers superseded, never already_in_pharmacy; completing one
--      marks nothing;
--   5b. after a dispensing (case 7e, at the end, so the earlier cases keep
--      rx1 as it was): an edit of the dispensed rx1 is still recorded on its
--      send, but the withdrawal answers false, PH's states answer not
--      withdrawn and the send answers already_in_pharmacy (not superseded):
--      what was sent was dispensed;
--   6. lab: the facility's lab scientist without a grant sees the own lab
--      work item and its card, may work on it, its basis is 'own-work', and
--      accessions it; another facility's lab scientist, the nurse and an
--      emergency session do not;
--   7. item by item, never the imported evidence: at the same facility and
--      for the same patient, a route-backed Lab item's chain (its requested
--      test, accession, specimen requirement, specimen, execution and
--      result) and a route-backed Pharmacy item's dispensing stay hidden
--      from the own-work staff, who cannot write onto them either, while the
--      own items' chains are visible (and lockable for update where the API
--      updates); the patient's imported Lab and Pharmacy evidence stays
--      hidden from them (the nurse alike) and is read with a consent grant
--      only; Pharmacy's events about an own dispensing are written, about a
--      routed one refused;
--   7b. the Lab chain on the own-work basis, with lab-api's own statements
--      as LS and L3 (no grant): a second specimen requirement and specimen on
--      W1's accession, collect and receive (update, command key, event,
--      outbox), an execution started and completed, a result entered and
--      corrected, checked by L3 and released by LS; each row reads back for
--      LS and stays hidden from the nurse and from F2's lab scientist; none
--      of these writes reaches R1's chain (routed); the inserts the services
--      make with RETURNING (an accession, a dispensing, a reversal) answer
--      their row;
--   7c. the deny directive, scope by scope (D1, as consent's own test): the
--      facility (this one or another), the organization (this one or
--      another), the staff member (the pharmacist, not the lab scientist),
--      the directive's facility, its actions (read or write only), its
--      purposes (emergency only, direct care), not yet started or expired;
--   7d. 0125's prescription details still need the member's consent: none
--      for PH, the item's details for PG;
--   7f. another facility's pharmacist and lab member (P2, L2), at their
--      facility and claiming F1, get nothing of F1's own work from any
--      reader: no state or basis (D10), no event, dispensing or reversal, no
--      access through a dispensing or an accession (D9); PH and LS read the
--      same rows (each probe has rows to find);
--   7g. one statement cannot change its session halfway: LS and PH, after
--      the session's half has run, change app.membership_id or
--      app.facility_id within the same statement (a cursor fetched, then
--      set_config, then fetched again; set_config in the select list) and
--      read nothing more: not Bisi's work (her deny directive), not F2's,
--      on the work items and on a chain table, Lab and Pharmacy (D1's
--      halves are bound); the row's half called on its own answers false
--      for a membership that is not the session's, another facility's row,
--      no actor, a disabled account, a membership on hold and no purpose,
--      and answers for a receptionist's or nurse's own membership, whose
--      session's half is null (D11);
--   7h. today's images (no app.own_facility_work, 0133 D13): before any
--      session of this suite sets it, PH's session reads it unset and gets
--      no session membership; PH and LS without the switch read none of
--      the own items, cards, chain rows, states, bases or D9 access; another
--      value does not switch it on; PG, a pharmacist with grants, reads the
--      same items, cards and chain rows with or without it;
--   8. the owner-run definer functions that read ehr.prescriptions give the
--      pharmacist nothing more through the EHR runtime, in a session with the
--      switch set (as the new ehr-api sets it, 0133 D13): the order-route
--      send, the own-pharmacy send and the withdrawal refuse the pharmacist
--      first; 0144's acceptance trigger function runs only on an insert into
--      pharmacy.work_item_acceptances, which the EHR runtime may not make
--      (42501), and through the Pharmacy runtime it reads a prescription only
--      as the source of an own item sent automatically that the acceptance
--      names (the prescription D5 already lets the dispensing validator read
--      for that item), refusing before any read an acceptance that names no
--      such item. That the session may read that item holds under an owner
--      with neither superuser nor BYPASSRLS (production's): forced row-level
--      security then hides every other item from the trigger. A superuser or
--      BYPASSRLS owner (pgadmin on this cluster) reads every item, so the
--      trigger answers the step of an item the session may not read (a held
--      one: changed) before the policies refuse the row, as 0101's dispensing
--      validator does (its own suite, pharmacy-work-item-acceptance, shows
--      each refusal, and both kinds of owner);
--  10. D15, the own-work list (owner's Q122 A): the patients with own work
--      listed per kind and facility, one row per own item, replica inserts
--      included, route-backed items never, nothing undone;
--      a D7 send lists; a pending send and a refused acceptance list nobody,
--      an acceptance with a grant does; the row's halves called on their own
--      answer only for listed patients of their kind at the row's facility
--      (LS lab Dayo f, LS lab Efe f, PH pharmacy Dayo t, RC lab Dayo f, RC
--      pharmacy Dayo t, RC lab Efe f, NU lab Efe f, L2 at F2 lab Ada t, L2 lab
--      Dayo f), and each runtime may not call the other kind's (42501);
--      neither runtime reads or writes the list or the claims; an ordinary
--      UPDATE of an own item is refused, a replica-mode one lists the new
--      pair and keeps the old; D14's claim key: a replica-mode change of an
--      own item's prescription, route, facility or id, and of a dispensing's
--      work item (re-pointed to an item sent elsewhere), is refused (55000
--      PRESCRIPTION_CLAIM_KEY_IMMUTABLE; in origin mode 0023's trigger
--      answers first), a SET that leaves them as they are and a repair of
--      the item's patient go through, and the claims stay exact;
--  11. D14, sending to an outside pharmacy before this pharmacy dispensed it
--      (owner's Q121 A), F4 being an outside pharmacy and P4 its pharmacist:
--      a. today's ehr-api (no switch): ORDER_ROUTE_ORDER_IN_WORK, resend
--         false, nothing released;
--      b. the new ehr-api (the switch): the undispensed own item is
--         withdrawn with the route (its claim released by the route, the
--         route at the prescription's version); D10 and the withdrawn items
--         reader say sent_elsewhere (to any member with
--         pharmacy.work-item.read there; no patient), LS and P2 get nothing,
--         the Lab runtime may not call it; dispensing it is refused with
--         23514, detail sent_elsewhere, for PH with the switch and for PG (a
--         grant) with the switch and without; PH without the switch is
--         refused too (it cannot see the item: 42501, or 23514); P4 accepts
--         and dispenses at F4 (two items, one live,
--         one dispensing), F4 listed nowhere; D7 answers routed while the
--         route is live and once accepted; after a later hold the withdrawal
--         answers false and the reason stays sent_elsewhere;
--      c. after an own dispensing, and after its reversal: in work, nothing
--         released;
--      d. a route accepted and then ended (cannot complete): D7 routed, an
--         own acceptance refused (23505), resend false;
--      e. sent elsewhere and declined: resend true with the switch (and a
--         second send elsewhere goes), false without (and today's send is
--         ORDER_ROUTE_ORDER_IN_WORK: a work item here, released or not);
--         D7 routed; the own item never comes back (23505);
--      f. the claims refuse on their own: no claim (not_claimed), a
--         dispensed claim never released (CHECK), replica inserts of an own
--         and then a route-backed item (prescription_item_claims_live_uq),
--         a second item of either kind (work_items_prescription_kind_uq);
--      g. with a superuser owner (this cluster), D10 and the reader answer
--         the own item only: PH and P4 get no state and no withdrawn row for
--         the route-backed item, and neither does P4 with a consent grant
--         for Dayo at F4, where that item is (D10's order_route_id filter
--         decides that; the reader lists released claims and changed sends
--         only, and a route-backed item's claim is never released: the
--         claims' CHECK);
--   9. the undo order of 0133's header: the sends table dropped while the
--      withdrawal trigger stands breaks prescription changes (42P01); the
--      trigger and its function dropped first do not; 0148 is undone before
--      any step of 0133's (and before 0144's), in 0148's header order (its
--      trigger, its reader, its trigger function, its table): its reader
--      calls D1's halves and its trigger function reads D14's claims; with
--      0148 left in place, 0144's and 0133's header undo still lets a
--      prescription change go through (the claims stay) and 0148's reader
--      answers no row (or 42883 once D1's halves are gone), never a failure;
--      in the header's full
--      order 0123's send and 0086's resend flag come back first (md5
--      0c2def2b and cd18f1a4, ACLs kept), no function left reads the sends
--      table when it is dropped (0144 is undone first, in full, as its undo
--      says: while its two own-work policies on the pharmacist acceptances
--      stand, D1's pharmacy half cannot be dropped, 2BP01, even with 0133's
--      44 gone; and its steps reader and acceptance trigger function read
--      the sends table too),
--      the pharmacy list's states and withdrawn
--      readers are gone (42883), not failing; D14's claims and their
--      triggers stay, so a released own item still cannot be dispensed and
--      an outside acceptance while an own claim is live still ends in R10's
--      order_in_work; D15's list dropped while a list trigger stands breaks
--      own item inserts (42P01), its triggers and function dropped first do
--      not. At the end, the list and the claims are exact both ways.
-- Two sessions (own items of one patient written at the same time; a send
-- elsewhere against a "Send to pharmacy") cannot run in this one-session
-- suite: 0133's proof harness runs them.
-- Fixtures inserted as the suite runner with session_replication_role =
-- replica where the services would not write them (identity rows, the lab
-- work item). Synthetic values only; uuid prefix e133.
set plpgsql.variable_conflict = error;
begin;

create function pg_temp.expect(label text, got text, want text) returns void language plpgsql as $f$
begin
  if got is distinct from want then
    raise exception 'own facility work: %: got [%], want [%]', label, got, want;
  end if;
end
$f$;
grant execute on function pg_temp.expect(text, text, text) to public;

-- 0123's ehr.send_order_route and 0086's ehr.order_route_resend_allowed as
-- 0133 found them: a definition or body without 0133's D14 hunks (each hunk
-- taken out, and the two lines hunk C replaced put back).
create function pg_temp.without_d14(definition text) returns text language sql immutable as $f$
  select replace(replace(replace(replace(replace(definition,
    $h$  -- 0133 D14: the new rule only in a session of the new ehr-api (D13's switch).
  sends_elsewhere boolean := coalesce(current_setting('app.own_facility_work', true) = '0133', false);
  own_claim pharmacy.prescription_item_claims%rowtype;
$h$, ''),
    $h$  -- 0133 D14: this pharmacy's own item's claim, locked after the order and its
  -- routes (a dispensing locks the order or its route, then the claim).
  if requested_kind = 'prescription' and sends_elsewhere then
    select claim.* into own_claim from pharmacy.prescription_item_claims claim
     where claim.prescription_id = requested_order_id and claim.order_route_id is null
     for update;
  end if;
$h$, ''),
    $h$     or (requested_kind = 'prescription' and not sends_elsewhere
       and exists (select 1 from pharmacy.work_items item where item.source_ehr_prescription_id = requested_order_id))
     -- 0133 D14: with the switch, in work once dispensed here or accepted elsewhere.
     or (requested_kind = 'prescription' and sends_elsewhere
       and (own_claim.dispensed_at is not null
         or exists (select 1 from pharmacy.prescription_item_claims claim
                     where claim.prescription_id = requested_order_id and claim.order_route_id is not null))) then
$h$,
    $h$     or (requested_kind = 'prescription'
       and exists (select 1 from pharmacy.work_items item where item.source_ehr_prescription_id = requested_order_id)) then
$h$),
    $h$  -- 0133 D14: this pharmacy's own item, live and not dispensed, is withdrawn
  -- (sent elsewhere) in this transaction.
  if own_claim.work_item_id is not null and own_claim.released_at is null then
    update pharmacy.prescription_item_claims claim
       set released_at = sent_at, released_by_route_id = requested_route_id
     where claim.work_item_id = own_claim.work_item_id and claim.released_at is null and claim.dispensed_at is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ORDER_IN_WORK';
    end if;
  end if;
$h$, ''),
    $h$  -- 0133 D14: with the switch (the new ehr-api), as its send: not once
  -- dispensed here or accepted elsewhere.
  if coalesce(current_setting('app.own_facility_work', true) = '0133', false) then
    return not exists (select 1 from pharmacy.prescription_item_claims claim
                        where claim.prescription_id = requested_order_id
                          and (claim.dispensed_at is not null or claim.order_route_id is not null));
  end if;
$h$, '')
$f$;
-- How often each D14 hunk occurs in a body (A B C D, R).
create function pg_temp.d14_hunks(body text) returns text language sql immutable as $f$
  select string_agg(((length(body) - length(replace(body, hunk, ''))) / length(hunk))::text, ' ' order by n)
    from (values (1, $h$  -- 0133 D14: the new rule only in a session of the new ehr-api (D13's switch).
  sends_elsewhere boolean := coalesce(current_setting('app.own_facility_work', true) = '0133', false);
  own_claim pharmacy.prescription_item_claims%rowtype;
$h$), (2, $h$  -- 0133 D14: this pharmacy's own item's claim, locked after the order and its
  -- routes (a dispensing locks the order or its route, then the claim).
  if requested_kind = 'prescription' and sends_elsewhere then
    select claim.* into own_claim from pharmacy.prescription_item_claims claim
     where claim.prescription_id = requested_order_id and claim.order_route_id is null
     for update;
  end if;
$h$), (3, $h$     or (requested_kind = 'prescription' and not sends_elsewhere
       and exists (select 1 from pharmacy.work_items item where item.source_ehr_prescription_id = requested_order_id))
     -- 0133 D14: with the switch, in work once dispensed here or accepted elsewhere.
     or (requested_kind = 'prescription' and sends_elsewhere
       and (own_claim.dispensed_at is not null
         or exists (select 1 from pharmacy.prescription_item_claims claim
                     where claim.prescription_id = requested_order_id and claim.order_route_id is not null))) then
$h$), (4, $h$  -- 0133 D14: this pharmacy's own item, live and not dispensed, is withdrawn
  -- (sent elsewhere) in this transaction.
  if own_claim.work_item_id is not null and own_claim.released_at is null then
    update pharmacy.prescription_item_claims claim
       set released_at = sent_at, released_by_route_id = requested_route_id
     where claim.work_item_id = own_claim.work_item_id and claim.released_at is null and claim.dispensed_at is null;
    if not found then
      raise exception using errcode = 'P0001', message = 'ORDER_ROUTE_ORDER_IN_WORK';
    end if;
  end if;
$h$), (5, $h$  -- 0133 D14: with the switch (the new ehr-api), as its send: not once
  -- dispensed here or accepted elsewhere.
  if coalesce(current_setting('app.own_facility_work', true) = '0133', false) then
    return not exists (select 1 from pharmacy.prescription_item_claims claim
                        where claim.prescription_id = requested_order_id
                          and (claim.dispensed_at is not null or claim.order_route_id is not null));
  end if;
$h$))
         hunks(n, hunk)
$f$;

-- 1. Structure.
do $$
declare
  mismatch text;
  owner_oid oid := (select relowner from pg_class where oid = 'pharmacy.work_items'::regclass);
begin
  select string_agg(format('%s md5=%s owner=%s definer=%s volatile=%s strict=%s config=%s', expected.proc_name,
           coalesce(md5(proc.prosrc), 'none (missing)'), pg_get_userbyid(proc.proowner), proc.prosecdef,
           proc.provolatile, proc.proisstrict, proc.proconfig), '; ')
    into mismatch
    from (values
      ('identity.facility_work_member_allows(text,uuid,uuid,text)', '941d81ffe593640b321875ed329f65bb', 's'),
      ('identity.facility_work_session_membership(text)', '36de1f00307dd5602972253b23f22f9f', 's'),
      ('identity.pharmacy_work_patient_allows(uuid,uuid,uuid,text)', 'cfc636db0a3457b5661adde458d4d07a', 's'),
      ('identity.lab_work_patient_allows(uuid,uuid,uuid,text)', 'ef568a87ef2d6d35004638e12796f969', 's'),
      -- 0086's, unchanged: D2 is a policy of its own next to theirs.
      ('lab.work_item_allows(uuid,uuid,uuid,text)', 'b710e0c6b66ce87c8c4a059ad435b774', 's'),
      ('pharmacy.work_item_allows(uuid,uuid,uuid,text)', 'b710e0c6b66ce87c8c4a059ad435b774', 's'),
      ('lab.work_item_patient_cards(uuid[])', '97a221aa4faba22b5d2467dc42effc26', 's'),
      ('pharmacy.work_item_patient_cards(uuid[])', 'e0826b14dc552f54496fdc1e44fd0e15', 's'),
      ('pharmacy.own_work_source_prescription(uuid,uuid,uuid)', '41a9afd4ea6f708425b98d1fb6e6eb87', 's'),
      ('ehr.send_prescription_to_own_pharmacy(uuid,bigint)', '855676989596c6c9d56e0a37e8fb5136', 'v'),
      ('ehr.withdraw_own_pharmacy_send(uuid)', '6129ef2b33330849f41bfba6d518f22e', 'v'),
      ('ehr.own_pharmacy_send_withdrawn_on_change()', '455c027844f87eebde9dd836f75760cf', 'v'),
      ('ehr.own_pharmacy_staffed()', '9fe0a922c4c121616604e7c9c87ec202', 's'),
      ('pharmacy.own_work_access_for(text,uuid,text)', '5ddb078242919dd978d6312f5cd5aa77', 's'),
      ('lab.own_work_access_for(text,uuid,text)', '1c834e3ed17d864dadb27f3105cffa04', 's'),
      ('pharmacy.own_work_item_states(uuid[])', 'dd091ced7e74b0e6e2ffb9169a80aced', 's'),
      ('lab.own_work_item_bases(uuid[])', '19f42fb8eaabcdc98726e3929bf9ec3f', 's'),
      -- D14's claims (trigger functions) and reader, D15's list (trigger function).
      ('pharmacy.claim_prescription_work_item()', 'c60a03a6aed78900827fc4c7654dd593', 'v'),
      ('pharmacy.claim_prescription_dispensing()', '2c7f20d7c0df7c582bccc0291f452fdd', 'v'),
      ('identity.list_own_work_patient()', '4a5d85a1c4d6f22c1f289c0dba7ed143', 'v'),
      ('pharmacy.own_withdrawn_work_items()', '1d25a10b83c34e91e9104c448b98e8dd', 's'),
      ('pharmacy.refuse_claim_key_change()', '234d53aafb3653ce4732a0292d995432', 'v')) expected(proc_name, digest, volatility)
    left join pg_proc proc on proc.oid = to_regprocedure(expected.proc_name)
   where proc.oid is null or md5(proc.prosrc) <> expected.digest or proc.proowner <> owner_oid
      or not proc.prosecdef or proc.provolatile <> expected.volatility
      -- STRICT: the two row's halves only (a session with no own-work membership never calls them).
      or proc.proisstrict <> (expected.proc_name in ('identity.pharmacy_work_patient_allows(uuid,uuid,uuid,text)',
                                                      'identity.lab_work_patient_allows(uuid,uuid,uuid,text)'));
  if mismatch is not null then
    raise exception 'own facility work: the functions are not 0133''s: %', mismatch;
  end if;
  -- Who may execute each, through any membership.
  select string_agg(format('%s %s=%s', expected.proc_name, role_row.rolname,
           has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')), '; ') into mismatch
    from (values
      ('identity.facility_work_member_allows(text,uuid,uuid,text)', array[]::text[]),
      ('pharmacy.own_work_source_prescription(uuid,uuid,uuid)', array[]::text[]),
      ('ehr.own_pharmacy_send_withdrawn_on_change()', array[]::text[]),
      ('identity.facility_work_session_membership(text)', array['hid_lab_runtime', 'hid_lab_api_runtime',
        'hid_pharmacy_runtime', 'hid_pharmacy_api_runtime', 'hid_schema_test_runtime']),
      -- Each kind's row's half to that kind's runtime only (0133 D11).
      ('identity.pharmacy_work_patient_allows(uuid,uuid,uuid,text)', array['hid_pharmacy_runtime',
        'hid_pharmacy_api_runtime', 'hid_schema_test_runtime']),
      ('identity.lab_work_patient_allows(uuid,uuid,uuid,text)', array['hid_lab_runtime', 'hid_lab_api_runtime',
        'hid_schema_test_runtime']),
      ('pharmacy.own_withdrawn_work_items()', array['hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
        'hid_schema_test_runtime']),
      ('pharmacy.claim_prescription_work_item()', array[]::text[]),
      ('pharmacy.claim_prescription_dispensing()', array[]::text[]),
      ('pharmacy.refuse_claim_key_change()', array[]::text[]),
      ('identity.list_own_work_patient()', array[]::text[]),
      ('ehr.send_prescription_to_own_pharmacy(uuid,bigint)', array['hid_ehr_runtime', 'hid_ehr_api_runtime',
        'hid_schema_test_runtime']),
      ('ehr.withdraw_own_pharmacy_send(uuid)', array['hid_ehr_runtime', 'hid_ehr_api_runtime',
        'hid_schema_test_runtime']),
      ('ehr.own_pharmacy_staffed()', array['hid_ehr_runtime', 'hid_ehr_api_runtime', 'hid_schema_test_runtime']),
      ('pharmacy.own_work_access_for(text,uuid,text)', array['hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
        'hid_schema_test_runtime']),
      ('pharmacy.own_work_item_states(uuid[])', array['hid_pharmacy_runtime', 'hid_pharmacy_api_runtime',
        'hid_schema_test_runtime']),
      ('lab.own_work_access_for(text,uuid,text)', array['hid_lab_runtime', 'hid_lab_api_runtime',
        'hid_schema_test_runtime']),
      ('lab.own_work_item_bases(uuid[])', array['hid_lab_runtime', 'hid_lab_api_runtime',
        'hid_schema_test_runtime'])) expected(proc_name, allowed)
    cross join pg_roles role_row
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')
         <> (role_row.rolname = any(expected.allowed));
  if mismatch is not null then
    raise exception 'own facility work: EXECUTE differs: %', mismatch;
  end if;
  if exists (select 1 from pg_class relation, aclexplode(relation.relacl) acl
              where relation.oid in ('pharmacy.own_prescription_sends'::regclass,
                      'pharmacy.prescription_item_claims'::regclass, 'identity.own_work_patients'::regclass)
                and acl.grantee <> relation.relowner) then
    raise exception 'own facility work: the sends table, the claims or the own-work list has grants';
  end if;
  if (select count(*) from pg_policy policy_row
       where policy_row.polrelid = 'ehr.prescriptions'::regclass
         and policy_row.polname in ('prescriptions_own_pharmacy_source_read', 'prescriptions_own_pharmacy_source_lock')
         and policy_row.polroles = array[(select proowner from pg_proc
                                           where oid = 'pharmacy.validate_dispensing()'::regprocedure)]) <> 2 then
    raise exception 'own facility work: the ehr.prescriptions policies do not name only the validator''s owner';
  end if;
  if exists (select 1 from pg_roles role_row
              where role_row.rolname like 'hid\_%'
                and role_row.oid <> (select proowner from pg_proc where oid = 'pharmacy.validate_dispensing()'::regprocedure)
                and pg_has_role(role_row.oid, (select proowner from pg_proc
                                                where oid = 'pharmacy.validate_dispensing()'::regprocedure), 'MEMBER')) then
    raise exception 'own facility work: a hid_ role is a member of the validator''s owner';
  end if;
  -- 0086's chain policy functions are untouched (B1: the imported evidence
  -- keeps them as its only policies).
  if (select string_agg(md5(prosrc), ',' order by oid::regprocedure::text) from pg_proc
       where oid in ('lab.context_allows(uuid,uuid,text)'::regprocedure,
                     'pharmacy.context_allows(uuid,uuid,text)'::regprocedure))
     is distinct from '57e689661a6227e34d3bde9562468951,958a6e5cd2a534d158c82fe399b8f381' then
    raise exception 'own facility work: 0086''s context_allows bodies changed';
  end if;
  -- The own-work policies: 46, a read policy on each work item table, 42 on
  -- the work chain and 0144's read and insert policies on the pharmacist
  -- acceptances (pharmacy.work_item_acceptances, anchored on its work item as
  -- the chain's are), never on the imported evidence, the Lab outbox or the
  -- route reports.
  if (select count(*) from pg_policy policy_row where policy_row.polname like 'staff\_own\_work\_%') <> 46
     or (select string_agg(policy_row.polname::text || ':' || policy_row.polcmd::text, ' '
                  order by policy_row.polname::text collate "C")
           from pg_policy policy_row
          where policy_row.polname like 'staff\_own\_work\_%'
            and policy_row.polrelid = 'pharmacy.work_item_acceptances'::regclass)
        is distinct from 'staff_own_work_insert:a staff_own_work_read:r'
     or (select array_agg(policy_row.polname::text || ':' || policy_row.polcmd::text order by policy_row.polrelid)
           from pg_policy policy_row
          where policy_row.polname like 'staff\_own\_work\_%'
            and policy_row.polrelid in ('lab.work_items'::regclass, 'pharmacy.work_items'::regclass))
        is distinct from array['staff_own_work_read:r', 'staff_own_work_read:r']
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polname like 'staff\_own\_work\_%'
                   and policy_row.polrelid in ('lab.imported_evidence'::regclass, 'lab.imported_observations'::regclass,
                     'pharmacy.imported_medication_evidence'::regclass, 'lab.outbox_events'::regclass,
                     'lab.order_route_result_reports'::regclass, 'pharmacy.order_route_dispensing_reports'::regclass))
     or exists (select 1 from pg_policy policy_row
                 where policy_row.polrelid in ('lab.imported_evidence'::regclass, 'lab.imported_observations'::regclass,
                         'pharmacy.imported_medication_evidence'::regclass)
                   and coalesce(pg_get_expr(policy_row.polqual, policy_row.polrelid), '')
                       || coalesce(pg_get_expr(policy_row.polwithcheck, policy_row.polrelid), '') ~ 'own_work') then
    raise exception 'own facility work: the own-work policies are not 0133''s 44 on the work items and their chain and 0144''s two on the pharmacist acceptances';
  end if;
  -- S7: the owner-run SECURITY DEFINER functions that read ehr.prescriptions
  -- (each sees D5's rows in a pharmacist's session) are exactly these ten
  -- (0143's ehr.list_my_orders lists only the caller's own orders; 0145's
  -- identity.decide_unknown_patient only tests that a record has none, and
  -- only the Identity runtime may run it; 0144 added
  -- pharmacy.validate_work_item_acceptance, the acceptance's trigger
  -- function); case 8 shows each gives the pharmacist nothing more (the two
  -- validators in cases 3 and 5, and 0144's in its own suite,
  -- pharmacy-work-item-acceptance, too). A new one must be
  -- added here, and to case 8, by whoever writes it. The check matches a
  -- definer's own text only: an invoker helper that such a definer calls
  -- reads as the owner too (today ehr.order_belongs_to, called by
  -- ehr.list_order_routes_for_order and ehr.order_route_summaries after
  -- ehr.order_route_reader's read consent test; 0133 D5), so whoever adds
  -- one adds it to D5's analysis by hand. ADT-1's 0171 adds
  -- ehr.admission_prepare_discharge and ehr.admission_discharge (the medicines
  -- on discharge): each reads the stay's prescriptions only after
  -- ehr.context_allows(patient, facility, 'write_records') for the caller, under
  -- ehr.prescriptions' forced row-level security, and is checked in its own
  -- suite (inpatient-adt); they are left out of this list.
  if (select string_agg(proc.oid::regprocedure::text, ' ' order by proc.oid::regprocedure::text) from pg_proc proc
       where proc.prosecdef and proc.prosrc ~* 'ehr\.prescriptions'
         and proc.oid::regprocedure::text not like 'ehr.admission\_%'
         and proc.proowner = (select proowner from pg_proc where oid = 'pharmacy.validate_dispensing()'::regprocedure))
     is distinct from 'ehr.list_my_orders(text[],boolean,date,timestamp with time zone,text,uuid,integer) '
       || 'ehr.patient_list_order_routes() ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,'
       || 'character) ehr.send_prescription_to_own_pharmacy(uuid,bigint) ehr.withdraw_own_pharmacy_send(uuid) '
       || 'identity.decide_unknown_patient(uuid,text,bigint,text,text,text) '
       || 'identity.demo_story_install(text) pharmacy.validate_dispensing() pharmacy.validate_work_item() '
       || 'pharmacy.validate_work_item_acceptance()' then
    raise exception 'own facility work: the owner-run definer functions that read ehr.prescriptions changed: %',
      (select string_agg(proc.oid::regprocedure::text, ' ' order by proc.oid::regprocedure::text) from pg_proc proc
        where proc.prosecdef and proc.prosrc ~* 'ehr\.prescriptions');
  end if;
  if exists (select 1 from pg_roles role_row
              where role_row.rolname like 'hid\_%'
                and has_function_privilege(role_row.oid, 'identity.demo_story_install(text)', 'EXECUTE')) then
    raise exception 'own facility work: a hid_ role may execute identity.demo_story_install(text)';
  end if;
  -- D14's two replaced functions: 0123's send and 0086's resend flag, each
  -- hunk once, nothing else changed (their bodies without the hunks are
  -- 0123's and 0086's, byte for byte); the owner's, with their own
  -- attributes, and the sealed clauses kept.
  if (select format('%s %s %s %s %s %s', pg_temp.d14_hunks(proc.prosrc), md5(pg_temp.without_d14(proc.prosrc)),
            md5(proc.prosrc), proc.prosecdef, proc.provolatile, proc.proconfig::text)
        from pg_proc proc
       where proc.oid = 'ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)'::regprocedure
         and proc.proowner = owner_oid and position('sealed_qa_' in proc.prosrc) > 0
         and position('sealed_demo_' in proc.prosrc) > 0)
     is distinct from '1 1 1 1 0 0c2def2b530bcb3d68537ade52787b6b fef3bfda1239e5cd72a149f8db30ff64 t v '
       || '{"search_path=pg_catalog, ehr, identity, auth, lab, pharmacy, notification, platform, pg_temp"}'
     or (select format('%s %s %s %s %s %s', pg_temp.d14_hunks(proc.prosrc), md5(pg_temp.without_d14(proc.prosrc)),
               md5(proc.prosrc), proc.prosecdef, proc.provolatile, proc.proconfig::text)
           from pg_proc proc
          where proc.oid = 'ehr.order_route_resend_allowed(text,uuid)'::regprocedure and proc.proowner = owner_oid)
        is distinct from '0 0 0 0 1 cd18f1a4942694d04288ab5d54679dbd 2e00ab542fa82dd6863c573cf588e66d f s '
          || '{"search_path=pg_catalog, ehr, lab, pharmacy, pg_temp"}' then
    raise exception 'own facility work: the replaced order-route send or resend flag is not 0123''s and 0086''s with D14''s hunks: %',
      (select string_agg(format('%s: %s %s %s', proc.oid::regprocedure, pg_temp.d14_hunks(proc.prosrc),
         md5(pg_temp.without_d14(proc.prosrc)), md5(proc.prosrc)), '; ')
         from pg_proc proc where proc.proname in ('send_order_route', 'order_route_resend_allowed'));
  end if;
  select string_agg(format('%s %s=%s', expected.proc_name, role_row.rolname,
           has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')), '; ') into mismatch
    from (values
      ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)', array['hid_ehr_runtime',
        'hid_ehr_api_runtime', 'hid_schema_test_runtime']),
      ('ehr.order_route_resend_allowed(text,uuid)', array[]::text[])) expected(proc_name, allowed)
    cross join pg_roles role_row
   where role_row.rolname ~ '^hid_.*(runtime|worker|writer|dispatcher|commands|scanner)$'
     and has_function_privilege(role_row.oid, expected.proc_name::regprocedure, 'EXECUTE')
         <> (role_row.rolname = any(expected.allowed));
  if mismatch is not null then
    raise exception 'own facility work: EXECUTE on the replaced functions differs: %', mismatch;
  end if;
  -- D14's claims and D15's list: row-level security on and not forced, no
  -- policy (no grant: above); pharmacy.work_items' only unique key on the
  -- prescription is work_items_prescription_kind_uq; the six triggers
  -- enabled always.
  if exists (select 1 from pg_class relation
              where relation.oid in ('pharmacy.prescription_item_claims'::regclass, 'identity.own_work_patients'::regclass)
                and (not relation.relrowsecurity or relation.relforcerowsecurity or relation.relowner <> owner_oid
                  or exists (select 1 from pg_policy policy_row where policy_row.polrelid = relation.oid)))
     or (select string_agg(index_row.indexrelid::regclass::text, ',') from pg_index index_row
          where index_row.indrelid = 'pharmacy.work_items'::regclass and index_row.indisunique
            and index_row.indkey[0] = (select attribute_row.attnum from pg_attribute attribute_row
                                        where attribute_row.attrelid = 'pharmacy.work_items'::regclass
                                          and attribute_row.attname = 'source_ehr_prescription_id'))
        is distinct from 'pharmacy.work_items_prescription_kind_uq'
     or (select string_agg(trigger_row.tgrelid::regclass || ':' || trigger_row.tgname || ':' || trigger_row.tgenabled::text, ' '
                  order by trigger_row.tgrelid::regclass::text, trigger_row.tgname)
           from pg_trigger trigger_row
          where trigger_row.tgfoid in ('pharmacy.claim_prescription_work_item()'::regprocedure,
                  'pharmacy.claim_prescription_dispensing()'::regprocedure, 'identity.list_own_work_patient()'::regprocedure,
                  'pharmacy.refuse_claim_key_change()'::regprocedure))
        is distinct from 'lab.work_items:work_items_own_work_patient_listed:A '
          || 'pharmacy.dispensings:dispensings_claim_prescription:A '
          || 'pharmacy.dispensings:prescription_claim_key_immutable:A '
          || 'pharmacy.work_items:prescription_claim_key_immutable:A pharmacy.work_items:work_items_claim_prescription:A '
          || 'pharmacy.work_items:work_items_own_work_patient_listed:A' then
    raise exception 'own facility work: D14''s claims, D15''s list, the key or their triggers are not 0133''s';
  end if;
end $$;

-- Fixtures. Organization O (e1330000...01); facilities F1 "Own Work
-- Hospital" (e1330001...01), F2 "Own Work Annex" (...02), F3 "Own Work
-- Clinic" (...03, no pharmacy staff). Members (account e1330002...n, staff
-- e1330003...n, membership e1330004...n, role e1330005...n):
--   1 DR doctor F1   2 PH pharmacist F1   3 LS lab F1   4 NU nurse F1
--   5 AD admin F1    6 P2 pharmacist F2   7 RC receptionist F1
--   8 D2 doctor F1   9 D3 doctor F3       10 PG pharmacist F1 (with grants)
--   11 L2 lab F2     12 CL clinician F1   13 DN doctor F1 (no grant)
--   14 RO receive-only F1 (a synthetic role holding pharmacy.order-route.receive
--      and lab.order-route.receive, not the two read permissions)
--   15 L3 lab F1 (no grant; the second person who checks LS's result)
-- Patients (e1330006...n): 1 Ada (active), 2 Bisi (a deny directive later),
-- 3 Chike (made inactive later). DR, D2 and PG hold write grants for all
-- three at F1, D3 for Ada at F3.
set local session_replication_role = replica;
insert into identity.purpose_of_use_codes (code, display, source_system) values
  ('direct-care', 'Direct patient care', 'own-work-test'),
  ('emergency', 'Emergency treatment', 'own-work-test')
on conflict (code) do update set active = true;
insert into identity.organizations (id, name, slug) values
  ('e1330000-0000-4000-8000-000000000001', 'Own Work Test Organization', 'own-work-test-organization');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status)
select ('e1330001-0000-4000-8000-00000000000' || n)::uuid, 'e1330000-0000-4000-8000-000000000001', name,
       'OWN-WORK-' || n, 'Africa/Lagos', true, 'verified'
  from (values (1, 'Own Work Hospital'), (2, 'Own Work Annex'), (3, 'Own Work Clinic')) site(n, name);
create temporary table own_members (n integer primary key, code text, role_code text, site integer) on commit drop;
insert into own_members values (1, 'dr', 'doctor', 1), (2, 'ph', 'pharmacist', 1), (3, 'ls', 'lab', 1),
  (4, 'nu', 'nurse', 1), (5, 'ad', 'admin', 1), (6, 'p2', 'pharmacist', 2), (7, 'rc', 'receptionist', 1),
  (8, 'd2', 'doctor', 1), (9, 'd3', 'doctor', 3), (10, 'pg', 'pharmacist', 1), (11, 'l2', 'lab', 2),
  (12, 'cl', 'clinician', 1), (13, 'dn', 'doctor', 1), (14, 'ro', 'own_work_receive_only', 1), (15, 'l3', 'lab', 1);
grant select on own_members to public;
insert into auth.roles (code, description) values
  ('own_work_receive_only', 'Own work suite: the two receive permissions without the two read permissions');
insert into auth.role_permissions (role_code, permission_code) values
  ('own_work_receive_only', 'pharmacy.order-route.receive'), ('own_work_receive_only', 'lab.order-route.receive');
insert into auth.accounts (id, subject, email, display_name, status)
select ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'synthetic:own-work-' || code,
       'own-work-' || code || '@example.invalid', 'Own Work ' || upper(code), 'active'
  from own_members;
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
select ('e1330003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'Own Work ' || upper(code),
       'own-work-' || code || '@example.invalid', 'verified', role_code
  from own_members;
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
  membership_role, app_role, is_primary, active)
select ('e1330004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330003-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'e1330000-0000-4000-8000-000000000001',
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, role_code, role_code, true, true
  from own_members;
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
select ('e1330005-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, role_code, 'facility',
       ('e1330004-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, 'Own work suite role'
  from own_members;
insert into identity.patients (id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e1330006-0000-4000-8000-000000000001', 'HID-WRKAAA2', 'Ada', 'Own', 'Ada Own', 'female', '1990-04-05', 'active'),
  ('e1330006-0000-4000-8000-000000000002', 'HID-WRKBBB3', 'Bisi', 'Own', 'Bisi Own', 'female', '1985-01-02', 'active'),
  ('e1330006-0000-4000-8000-000000000003', 'HID-WRKCCC4', 'Chike', 'Own', 'Chike Own', 'male', '1979-09-30', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select gen_random_uuid(), ('e1330006-0000-4000-8000-00000000000' || patient)::uuid,
       ('e1330003-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, 'write_records', 'direct-care', 'active',
       'Synthetic own work consent', clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days'
  from (values (1, 1, 1), (1, 2, 1), (1, 3, 1), (8, 1, 1), (10, 1, 1), (10, 2, 1), (10, 3, 1), (9, 1, 3))
       consent(member, patient, site);
set local session_replication_role = origin;

-- The session the services set (DatabaseService.withTransaction). The new
-- lab-api, pharmacy-api and ehr-api images also set app.own_facility_work to
-- '0133' (0133 D13); switched => false is a session of today's images, which
-- do not.
create function pg_temp.as_member(member integer, site integer default null, purpose text default 'direct-care',
  correlation text default null, switched boolean default true) returns void language sql as $f$
  select set_config('app.own_facility_work', case when switched then '0133' else '' end, true),
         set_config('app.actor_subject', 'synthetic:own-work-' || (select code from own_members where n = member), true),
         set_config('app.facility_id', 'e1330001-0000-4000-8000-00000000000'
           || coalesce(site, (select own_members.site from own_members where n = member)), true),
         set_config('app.correlation_id', coalesce(correlation, 'own-work-' || substr(md5(random()::text), 1, 12)), true),
         set_config('app.membership_id', 'e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'), true),
         set_config('app.purpose_of_use', purpose, true);
$f$;
create function pg_temp.rx(n integer) returns uuid language sql immutable as $f$
  select ('e1330007-0000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid
$f$;
-- A statement's outcome: 'ok', or 'SQLSTATE message'.
create function pg_temp.try(statement text) returns text language plpgsql as $f$
begin
  execute statement;
  return 'ok';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The send's answer as text.
create function pg_temp.send(prescription uuid, version bigint) returns text language plpgsql as $f$
declare answer text;
begin
  select string_agg(sent.outcome || case when sent.work_item_id is null then '' else ':item' end, ',') into answer
    from ehr.send_prescription_to_own_pharmacy(prescription, version) sent;
  return answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- The prescription's own work item (0133 D14: a routed one may exist too).
create function pg_temp.work_item_of(prescription uuid) returns uuid language sql security definer as $f$
  select id from pharmacy.work_items where source_ehr_prescription_id = prescription and order_route_id is null
$f$;
-- pharmacy-api's dispensing INSERT (PharmacyService.dispense) by the session's member.
create function pg_temp.dispense_sql(work_item uuid, member integer) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.dispensings (
        id,work_item_id,work_item_version,patient_id,facility_id,medication_code_system,medication_code,
        medication_display,quantity_dispensed,quantity_unit,dispensed_by,dispensed_by_membership_id,
        reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,%L,%L,%L,%L,21,'capsule',%L,%L,'Dispensed to the patient',%L,%L,%L)$i$,
    gen_random_uuid(), w.id, w.patient_id, w.facility_id, w.medication_code_system, w.medication_code,
    w.medication_display, 'e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'),
    'e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'),
    'own-work-dispense-' || replace(gen_random_uuid()::text, '-', ''), repeat('d', 64),
    current_setting('app.correlation_id'))
  from pharmacy.work_items w where w.id = work_item
$f$;
-- pharmacy-api's acceptance INSERT (PharmacyService.accept) of prescription n
-- by the session's member, with the prescription's own values.
create function pg_temp.accept_sql(n integer, member integer) returns text language sql security definer as $f$
  select format($i$insert into pharmacy.work_items (
        id,patient_id,facility_id,ordering_facility_id,source_ehr_prescription_id,
        source_ehr_prescription_version,source_encounter_id,source_status,medication_code_system,
        medication_code,medication_display,dose_quantity,dose_unit,route_code,frequency,instructions,
        starts_on,ends_on,prescribed_by,prescribed_at,accepted_by,accepted_by_membership_id,
        acceptance_reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,%L,%L,%L,%s,%L,'active',%L,%L,%L,%s,%L,%L,%L,%L,%L,%L,%L,%L,%L,%L,
        'Accepted by the pharmacist',%L,%L,%L)$i$,
    gen_random_uuid(), p.patient_id, p.facility_id, p.facility_id, p.id, p.row_version, p.encounter_id,
    p.medication_code_system, p.medication_code, p.medication_display, p.dose_quantity, p.dose_unit, p.route_code,
    p.frequency, p.instructions, p.starts_on, p.ends_on, p.created_by, p.created_at,
    'e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'),
    'e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'),
    'own-work-accept-' || replace(gen_random_uuid()::text, '-', ''), repeat('a', 64),
    current_setting('app.correlation_id'))
  from ehr.prescriptions p where p.id = pg_temp.rx(n)
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', proc.signature);
  end loop;
end $$;

-- 7h, first part (the rest is case 7h below). Today's images never set
-- app.own_facility_work, so their sessions read it unset (null), not empty:
-- nothing in this session has set it yet. PH's session, as today's
-- pharmacy-api sets it, then with the switch the new image adds.
set local role hid_pharmacy_api_runtime;
select set_config('app.actor_subject', 'synthetic:own-work-ph', true),
       set_config('app.facility_id', 'e1330001-0000-4000-8000-000000000001', true),
       set_config('app.correlation_id', 'own-work-unset-switch', true),
       set_config('app.membership_id', 'e1330004-0000-4000-8000-000000000002', true),
       set_config('app.purpose_of_use', 'direct-care', true);
select pg_temp.expect('7h PH, today''s image: the switch is unset in its session (null, not empty)',
  coalesce(current_setting('app.own_facility_work', true), 'null'), 'null');
select pg_temp.expect('7h PH, today''s image (the switch unset): no session membership',
  coalesce(identity.facility_work_session_membership('pharmacy')::text, 'null'), 'null');
select set_config('app.own_facility_work', '0133', true);
select pg_temp.expect('7h PH, the new image (the switch set): its session membership',
  coalesce(identity.facility_work_session_membership('pharmacy')::text, 'null'), 'e1330004-0000-4000-8000-000000000002');
reset role;

-- The EHR rows, through the EHR runtime with the EHR API's statements, as
-- DR at F1: encounter E1 for Ada, E2 for Bisi, E3 for Chike; prescriptions
-- (draft, then activated as prescriptions.service.ts update does): 1, 2, 3,
-- 4, 6 for Ada, 7 for Bisi, 8 for Chike; 5 stays a draft. As D3 at F3: 9
-- for Ada.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e1330008-0000-4000-8000-00000000000' || n)::uuid, ('e1330006-0000-4000-8000-00000000000' || n)::uuid,
       'e1330001-0000-4000-8000-000000000001', 'e1330002-0000-4000-8000-000000000001',
       'e1330004-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp()
  from generate_series(1, 3) n;
create function pg_temp.prescribe(n integer, patient integer, member integer, site integer) returns void
language sql as $f$
  insert into ehr.prescriptions (id, encounter_id, patient_id, facility_id, created_by, created_by_membership_id,
    medication_code_system, medication_code, medication_display, dose_quantity, dose_unit, route_code, frequency,
    instructions, starts_on, ends_on, status)
  values (pg_temp.rx(n), ('e1330008-0000-4000-8000-00000000000' || case when site = 3 then 9 else patient end)::uuid,
    ('e1330006-0000-4000-8000-00000000000' || patient)::uuid, ('e1330001-0000-4000-8000-00000000000' || site)::uuid,
    ('e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
    ('e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid, 'http://www.whocc.no/atc', 'J01CA04',
    'Amoxicillin 500 mg capsule (' || n || ')', 1, 'capsule', 'oral', 'Every 8 hours', 'Take after food for 7 days',
    date '2026-11-18', date '2026-11-25', 'draft');
$f$;
create function pg_temp.set_status(n integer, new_status text, reason text) returns void language plpgsql as $f$
begin
  perform set_config('app.change_reason', reason, true);
  update ehr.prescriptions set status = new_status where id = pg_temp.rx(n);
  if not found then raise exception 'own work suite: prescription % not updated', n; end if;
end $f$;
grant execute on function pg_temp.prescribe(integer, integer, integer, integer),
  pg_temp.set_status(integer, text, text) to public;
select pg_temp.prescribe(n, patient, 1, 1)
  from (values (1, 1), (2, 1), (3, 1), (4, 1), (5, 1), (6, 1), (7, 2), (8, 3)) rx(n, patient);
select pg_temp.set_status(n, 'active', 'First activation (no reason needed)') from unnest(array[1, 2, 3, 4, 6, 7, 8]) n;
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(9);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
values ('e1330008-0000-4000-8000-000000000009', 'e1330006-0000-4000-8000-000000000001',
  'e1330001-0000-4000-8000-000000000003', 'e1330002-0000-4000-8000-000000000009',
  'e1330004-0000-4000-8000-000000000009', 'ambulatory', 'in_progress', clock_timestamp());
select pg_temp.prescribe(9, 1, 9, 3);
select pg_temp.set_status(9, 'active', 'First activation (no reason needed)');
reset role;

-- 2. The send, as DR through the EHR runtime.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('rx1 is sent', pg_temp.send(pg_temp.rx(1), 2), 'sent:item');
reset role;
select pg_temp.expect('rx1''s work item: accepted by the prescriber, the fixed reason, version 2, no route',
  (select format('%s/%s/%s/%s/%s', w.accepted_by = 'e1330002-0000-4000-8000-000000000001',
     w.accepted_by_membership_id = 'e1330004-0000-4000-8000-000000000001', w.acceptance_reason,
     w.source_ehr_prescription_version, w.order_route_id is null)
     from pharmacy.work_items w where w.source_ehr_prescription_id = pg_temp.rx(1)),
  't/t/Sent automatically when the prescription was activated/2/t');
select pg_temp.expect('rx1: one event, one outbox event with pharmacy-api''s four payload keys, a sent row',
  (select format('%s/%s/%s', (select count(*) from pharmacy.work_item_events e where e.work_item_id = w.id),
     (select string_agg(o.event_type || ':' || o.aggregate_type || ':' || o.aggregate_version || ':'
        || (select string_agg(key, ',' order by key) from jsonb_object_keys(o.payload) key) || ':'
        || (o.payload ->> 'status') || ':' || (o.payload ->> 'workItemId' = w.id::text) || ':'
        || (o.payload ->> 'sourceEhrPrescriptionId' = w.source_ehr_prescription_id::text) || ':'
        || (o.payload -> 'sourceEhrPrescriptionVersion')::text, ',')
        from pharmacy.outbox_events o where o.aggregate_id = w.id),
     (select s.state || ':' || s.attempts || ':' || (s.work_item_id = w.id) || ':' || coalesce(s.last_failure_sqlstate, '-')
        from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(1)))
     from pharmacy.work_items w where w.source_ehr_prescription_id = pg_temp.rx(1)),
  '1/PharmacyWorkItemCreated:pharmacy-work-item:1:sourceEhrPrescriptionId,sourceEhrPrescriptionVersion,status,'
  || 'workItemId:accepted:true:true:2/sent:1:true:-');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('a second send writes nothing', pg_temp.send(pg_temp.rx(1), 2), 'already_in_pharmacy:item');
select pg_temp.expect('a draft is not sent', pg_temp.send(pg_temp.rx(5), 1), 'not_active');
select pg_temp.expect('another version is not sent', pg_temp.send(pg_temp.rx(2), 1), 'changed');
select pg_temp.expect('an unknown prescription', pg_temp.send(gen_random_uuid(), 1), 'not_found');
select pg_temp.expect('a bad version', pg_temp.send(pg_temp.rx(2), 0), '22023 OWN_PHARMACY_SEND_INVALID');
-- A failed attempt (a correlation id the work item's CHECK refuses): the
-- prescription stays active, the send pending with the SQLSTATE, nothing else written.
select pg_temp.as_member(1, correlation => 'short');
select pg_temp.expect('a failed attempt is pending', pg_temp.send(pg_temp.rx(2), 2), 'pending');
reset role;
select pg_temp.expect('the pending send: no work item, the SQLSTATE, the prescription still active',
  (select format('%s/%s/%s/%s/%s', s.state, s.attempts, s.last_failure_sqlstate,
     (select count(*) from pharmacy.work_items w where w.source_ehr_prescription_id = pg_temp.rx(2)),
     (select p.status from ehr.prescriptions p where p.id = pg_temp.rx(2)))
     from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(2)),
  'pending/1/23514/0/active');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('the next send sends it', pg_temp.send(pg_temp.rx(2), 2), 'sent:item');
select pg_temp.expect('rx3, rx4, rx6, rx7, rx8 are sent', (select string_agg(pg_temp.send(pg_temp.rx(n), 2), ' ')
  from unnest(array[3, 4, 6, 7, 8]) n), 'sent:item sent:item sent:item sent:item sent:item');
-- Not the prescriber: D2 (a doctor with a grant for Ada).
select pg_temp.as_member(8);
select pg_temp.set_status(5, 'active', 'First activation (no reason needed)');
select pg_temp.expect('D2 does not send DR''s prescription', pg_temp.send(pg_temp.rx(5), 2), 'not_prescriber');
-- Refused sessions.
select pg_temp.as_member(7);
select pg_temp.expect('a receptionist is refused', pg_temp.send(pg_temp.rx(5), 2), '42501 OWN_PHARMACY_SEND_DENIED');
select pg_temp.as_member(1, purpose => 'emergency');
select pg_temp.expect('an emergency session is refused', pg_temp.send(pg_temp.rx(5), 2), '42501 OWN_PHARMACY_SEND_DENIED');
select set_config('app.membership_id', '', true);
select pg_temp.expect('a session without a membership is refused', pg_temp.send(pg_temp.rx(5), 2),
  '42501 OWN_PHARMACY_SEND_DENIED');
-- Nobody works on pharmacy items at F3.
select pg_temp.as_member(9);
select pg_temp.expect('F3 has no pharmacy staff', pg_temp.send(pg_temp.rx(9), 2), 'no_pharmacy');
reset role;
select pg_temp.expect('no send row for the refused and unsent', (select count(*)::text from pharmacy.own_prescription_sends
  where prescription_id in (pg_temp.rx(5), pg_temp.rx(9))), '0');

-- 2b. Whether a send can reach somebody here (the list's and page's flag).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('F1 has pharmacy staff, for DR', ehr.own_pharmacy_staffed()::text, 'true');
select pg_temp.as_member(2);
select pg_temp.expect('and for PH (who may read prescriptions)', ehr.own_pharmacy_staffed()::text, 'true');
select pg_temp.as_member(9);
select pg_temp.expect('F3 has none, for D3', ehr.own_pharmacy_staffed()::text, 'false');
select pg_temp.as_member(1, site => 3);
select pg_temp.expect('DR claiming F3 (no membership there) gets no answer', coalesce(ehr.own_pharmacy_staffed()::text, 'null'),
  'null');
select pg_temp.as_member(7);
select pg_temp.expect('the receptionist (no prescription read) gets no answer',
  coalesce(ehr.own_pharmacy_staffed()::text, 'null'), 'null');
select pg_temp.as_member(3);
select pg_temp.expect('the lab scientist (no prescription read) gets no answer',
  coalesce(ehr.own_pharmacy_staffed()::text, 'null'), 'null');
select set_config('app.facility_id', '', true);
select pg_temp.expect('no session, no answer', coalesce(ehr.own_pharmacy_staffed()::text, 'null'), 'null');
reset role;
select pg_temp.expect('the staffed test wrote no send row', (select count(*)::text from pharmacy.own_prescription_sends
  where prescription_id in (pg_temp.rx(5), pg_temp.rx(9))), '0');

-- 2c. The no_pharmacy test (the staffed answer and D7's) asks the full
-- permission check (auth.membership_has_permission, counted by
-- track_functions) of the members holding a pharmacy role here only, not of
-- every member: at F3, 200 more members (nurses) add no check to either,
-- and the staffed answer makes one (the session's own). The full check still
-- decides: a pharmacist whose account is disabled, or whose role was
-- revoked, does not staff F3; a member holding the two permissions through
-- two roles does, and D7 then sends. In a savepoint, rolled back.
savepoint staffed_scale;
set local track_functions = 'all';
create function pg_temp.permission_checks() returns bigint language sql as $f$
  select coalesce(pg_stat_get_xact_function_calls('auth.membership_has_permission(text,uuid,uuid,text)'::regprocedure), 0)
$f$;
grant execute on function pg_temp.permission_checks() to public;
-- Adds members at F3 numbered from first to last with one or more roles (as replica, as the suite's own).
create function pg_temp.add_f3_members(first integer, last integer, roles text[], account_status text default 'active')
returns void language plpgsql as $f$
begin
  insert into auth.accounts (id, subject, email, display_name, status)
  select ('e1339002-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'synthetic:own-work-f3-' || n,
         'own-work-f3-' || n || '@example.invalid', 'Own Work F3 ' || n, account_status
    from generate_series(first, last) n;
  insert into identity.staff (id, account_id, full_name, email, verification_status, default_role)
  select ('e1339003-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         ('e1339002-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'Own Work F3 ' || n,
         'own-work-f3-' || n || '@example.invalid', 'verified', roles[1]
    from generate_series(first, last) n;
  insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id,
    membership_role, app_role, is_primary, active)
  select ('e1339004-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         ('e1339003-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
         ('e1339002-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'e1330000-0000-4000-8000-000000000001',
         'e1330001-0000-4000-8000-000000000003', roles[1], roles[1], true, true
    from generate_series(first, last) n;
  insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason)
  select gen_random_uuid(), ('e1339002-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, role_code, 'facility',
         ('e1339004-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, 'e1330001-0000-4000-8000-000000000003',
         'Own work suite role'
    from generate_series(first, last) n cross join unnest(roles) role_code;
end $f$;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(9);
select set_config('own_work.checks', pg_temp.permission_checks()::text, true);
select pg_temp.expect('F3 is not staffed', ehr.own_pharmacy_staffed()::text, 'false');
select set_config('own_work.staffed_checks', (pg_temp.permission_checks()
  - current_setting('own_work.checks')::bigint)::text, true);
select set_config('own_work.checks', pg_temp.permission_checks()::text, true);
select pg_temp.expect('D7 at F3: no_pharmacy', pg_temp.send(pg_temp.rx(9), 2), 'no_pharmacy');
select set_config('own_work.send_checks', (pg_temp.permission_checks()
  - current_setting('own_work.checks')::bigint)::text, true);
reset role;
set local session_replication_role = replica;
select pg_temp.add_f3_members(1, 200, array['nurse']);
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(9);
select set_config('own_work.checks', pg_temp.permission_checks()::text, true);
select pg_temp.expect('F3 with 200 more members (nurses): still not staffed', ehr.own_pharmacy_staffed()::text, 'false');
select pg_temp.expect('the staffed answer asks the permission check once (the session''s), with or without them',
  current_setting('own_work.staffed_checks') || '/' || (pg_temp.permission_checks()
    - current_setting('own_work.checks')::bigint)::text, '1/1');
select set_config('own_work.checks', pg_temp.permission_checks()::text, true);
select pg_temp.expect('D7 at F3 with them: no_pharmacy', pg_temp.send(pg_temp.rx(9), 2), 'no_pharmacy');
select pg_temp.expect('D7''s no_pharmacy test asks no more permission checks with them',
  (pg_temp.permission_checks() - current_setting('own_work.checks')::bigint)::text,
  current_setting('own_work.send_checks'));
reset role;
set local session_replication_role = replica;
select pg_temp.add_f3_members(201, 201, array['pharmacist'], 'disabled');
select pg_temp.add_f3_members(202, 202, array['pharmacist']);
update auth.account_roles set granted_at = clock_timestamp() - interval '1 hour', revoked_at = clock_timestamp(),
       revoked_by = 'e1330002-0000-4000-8000-000000000009', revocation_reason = 'Own work suite: role revoked'
 where membership_id = 'e1339004-0000-4000-8000-000000000202';
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(9);
select pg_temp.expect('a pharmacist with a disabled account, or a revoked role, does not staff F3',
  ehr.own_pharmacy_staffed()::text || '/' || pg_temp.send(pg_temp.rx(9), 2), 'false/no_pharmacy');
reset role;
set local session_replication_role = replica;
select pg_temp.add_f3_members(203, 203, array['nurse', 'own_work_receive_only']);
set local session_replication_role = origin;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(9);
select pg_temp.expect('a member holding the read and the receive permission through two roles staffs F3, and D7 sends',
  ehr.own_pharmacy_staffed()::text || '/' || pg_temp.send(pg_temp.rx(9), 2), 'true/sent:item');
reset role;
rollback to savepoint staffed_scale;
select pg_temp.expect('2c is undone: F3 has no new member and rx9 no send', (select count(*)::text
  from identity.staff_facility_memberships where facility_id = 'e1330001-0000-4000-8000-000000000003')
  || '/' || (select count(*)::text from pharmacy.own_prescription_sends where prescription_id = pg_temp.rx(9)), '1/0');

-- 3. PH, the pharmacist at F1 without any grant, through pharmacy-api's runtime.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH sees the seven items sent (rx1-rx4, rx6, rx7, rx8)',
  (select count(*)::text from pharmacy.work_items), '7');
select pg_temp.expect('PH sees rx1''s card with the name',
  (select string_agg(card.patient_full_name || '/' || card.patient_health_id_last4, ',')
     from pharmacy.work_item_patient_cards(array[pg_temp.work_item_of(pg_temp.rx(1))]) card), 'Ada Own/AAA2');
select pg_temp.expect('PH may work on rx1''s item, on the own-work basis',
  (select string_agg(access.basis, ',') from pharmacy.own_work_access_for('work_item',
     pg_temp.work_item_of(pg_temp.rx(1)), 'write_records') access), 'own-work');
select pg_temp.expect('rx1''s basis for PH is own-work, not withdrawn',
  (select string_agg(state.basis || '/' || state.withdrawn, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(1))]) state), 'own-work/false');
select pg_temp.expect('PH reads rx1''s event', (select count(*)::text from pharmacy.work_item_events e
  where e.work_item_id = pg_temp.work_item_of(pg_temp.rx(1))), '1');
select pg_temp.expect('PH dispenses rx1', pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(1)), 2)), 'ok');
select pg_temp.expect('PH reads the dispensing', (select count(*)::text from pharmacy.dispensings d
  where d.work_item_id = pg_temp.work_item_of(pg_temp.rx(1))), '1');
-- One pharmacy item per prescription, and no acceptance without consent: a
-- second item for the sent rx1, and rx5 (active, never sent). On a database
-- whose owner bypasses row-level security the validator finds rx5 and the
-- work items' insert policy refuses it (0133's branch is for reads only);
-- under forced row-level security (production) the validator, reading as
-- its owner in PH's session, does not find rx5 at all.
select pg_temp.expect('PH: a second work item for rx1 is refused',
  pg_temp.try(pg_temp.accept_sql(1, 2)), '42501 new row violates row-level security policy for table "work_items"');
select pg_temp.expect('PH: accepting rx5 (never sent) without a grant is refused',
  pg_temp.try(pg_temp.accept_sql(5, 2)) in ('42501 new row violates row-level security policy for table "work_items"',
    '23514 PRESCRIPTION_SOURCE_NOT_FOUND')::text, 'true');
select pg_temp.expect('the Pharmacy runtime cannot read the chart',
  pg_temp.try('select count(*) from ehr.prescriptions'), '42501 permission denied for schema ehr');
select pg_temp.expect('PH: a Lab resource type is refused', pg_temp.try($s$select * from pharmacy.own_work_access_for(
  'accession', gen_random_uuid(), 'read_records')$s$), '22023 OWN_WORK_ACCESS_INVALID');
reset role;
-- PH's session through the EHR runtime: the chart's consent test (every EHR
-- table's policy) is still false for Ada, and no prescription, encounter or
-- version snapshot is readable.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH reads nothing of the chart through the EHR runtime',
  format('%s/%s/%s/%s', ehr.context_allows('e1330006-0000-4000-8000-000000000001',
      'e1330001-0000-4000-8000-000000000001', 'read_records'),
    (select count(*) from ehr.prescriptions), (select count(*) from ehr.encounters),
    (select count(*) from ehr.record_versions)), 'f/0/0/0');
reset role;

-- 4. Not for others.
create function pg_temp.pharmacy_view(member integer, site integer default null, purpose text default 'direct-care')
returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_member(member, site, purpose);
  select format('items=%s cards=%s access=%s', (select count(*) from pharmacy.work_items),
           (select count(*) from pharmacy.work_item_patient_cards(array[pg_temp.work_item_of(pg_temp.rx(3))])),
           (select count(*) from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(3)),
              'read_records')))
    into answer;
  return answer;
end $f$;
grant execute on function pg_temp.pharmacy_view(integer, integer, text) to public;
create function pg_temp.lab_view(member integer) returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_member(member);
  select format('items=%s cards=%s access=%s', (select count(*) from lab.work_items),
           (select count(*) from lab.work_item_patient_cards(array['e133000a-0000-4000-8000-000000000001'::uuid])),
           (select count(*) from lab.own_work_access_for('work_item', 'e133000a-0000-4000-8000-000000000001',
              'read_records')))
    into answer;
  return answer;
end $f$;
grant execute on function pg_temp.lab_view(integer) to public;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('NU (nurse) sees nothing', pg_temp.pharmacy_view(4), 'items=0 cards=0 access=0');
select pg_temp.expect('AD (admin) sees nothing', pg_temp.pharmacy_view(5), 'items=0 cards=0 access=0');
select pg_temp.expect('RC (receptionist) sees nothing', pg_temp.pharmacy_view(7), 'items=0 cards=0 access=0');
select pg_temp.expect('CL (clinician) sees nothing', pg_temp.pharmacy_view(12), 'items=0 cards=0 access=0');
select pg_temp.expect('DN (doctor without a grant) sees nothing', pg_temp.pharmacy_view(13), 'items=0 cards=0 access=0');
select pg_temp.expect('RO (receive permission without the read one) sees nothing', pg_temp.pharmacy_view(14),
  'items=0 cards=0 access=0');
select pg_temp.expect('LS (lab) sees no pharmacy item', pg_temp.pharmacy_view(3), 'items=0 cards=0 access=0');
select pg_temp.expect('P2 (pharmacist at F2) sees nothing of F1', pg_temp.pharmacy_view(6), 'items=0 cards=0 access=0');
select pg_temp.expect('P2''s membership in a session at F1 sees nothing', pg_temp.pharmacy_view(6, 1),
  'items=0 cards=0 access=0');
select pg_temp.expect('PH in an emergency session sees nothing', pg_temp.pharmacy_view(2, purpose => 'emergency'),
  'items=0 cards=0 access=0');
select pg_temp.as_member(10);
select pg_temp.expect('PG (pharmacist with grants) keeps the basis consent',
  (select string_agg(state.basis, ',') from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(1))]) state),
  'consent');
select pg_temp.expect('PG keeps the basis consent on the commands too (read, and the write its grant covers)',
  (select string_agg(access.basis, ',') from (
     select * from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(1)), 'read_records')
     union all
     select * from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(1)), 'write_records')) access),
  'consent,consent');
reset role;
-- Bisi's deny directive (facility F1, everyone) and Chike made inactive.
set local session_replication_role = replica;
insert into identity.consent_directives (id, patient_id) values
  ('e1330009-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000002');
insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
  grantee_type, facility_id, starts_at, source_reference, reason, content_sha256)
values (gen_random_uuid(), 'e1330009-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000002', 1, 'active',
  'deny', 'all', 'e1330001-0000-4000-8000-000000000001', clock_timestamp() - interval '1 minute', 'own-work-suite',
  'Synthetic deny directive', repeat('a', 64));
update identity.patients set status = 'inactive' where id = 'e1330006-0000-4000-8000-000000000003';
set local session_replication_role = origin;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: Bisi (deny directive) and Chike (inactive) are hidden now',
  (select string_agg(right(w.source_ehr_prescription_id::text, 2), ' ' order by w.source_ehr_prescription_id)
     from pharmacy.work_items w), '01 02 03 04 06');
select pg_temp.expect('PH may not work on Bisi''s item', (select count(*)::text from pharmacy.own_work_access_for(
  'work_item', pg_temp.work_item_of(pg_temp.rx(7)), 'write_records')), '0');
select pg_temp.expect('PH reads no event of Bisi''s or Chike''s items', (select count(*)::text
  from pharmacy.work_item_events e where e.work_item_id in (pg_temp.work_item_of(pg_temp.rx(7)),
    pg_temp.work_item_of(pg_temp.rx(8)))), '0');
select pg_temp.expect('PH sees no card for Bisi''s or Chike''s items', (select count(*)::text
  from pharmacy.work_item_patient_cards(array[pg_temp.work_item_of(pg_temp.rx(7)), pg_temp.work_item_of(pg_temp.rx(8))])),
  '0');
reset role;

-- 5. Stopping after the send: DR holds rx3; the send is withdrawn once, and
-- dispensing is refused.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('an active prescription is not withdrawn', ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text,
  'false');
select pg_temp.set_status(3, 'on_hold', 'Held by the prescriber');
reset role;
select set_config('own_work.rx3_withdrawn_at', (select s.withdrawn_at::text from pharmacy.own_prescription_sends s
  where s.prescription_id = pg_temp.rx(3)), true);
select pg_temp.expect('the hold alone marks rx3''s send withdrawn (D8''s trigger, no withdrawal call)',
  (current_setting('own_work.rx3_withdrawn_at') <> '')::text, 'true');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('the held prescription''s send stands withdrawn',
  ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text, 'true');
select pg_temp.expect('and stays so', ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text, 'true');
reset role;
select pg_temp.expect('marked once (the withdrawal time is the hold''s)', (select s.withdrawn_at::text
  from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(3)),
  current_setting('own_work.rx3_withdrawn_at'));
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.as_member(7);
select pg_temp.expect('a receptionist cannot withdraw', pg_temp.try(format(
  'select ehr.withdraw_own_pharmacy_send(%L)', pg_temp.rx(3))), '42501 OWN_PHARMACY_SEND_DENIED');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: rx3 reads withdrawn',
  (select string_agg(state.basis || '/' || state.withdrawn, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(3))]) state), 'own-work/true');
select pg_temp.expect('PH: dispensing rx3 is refused',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(3)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE');
select pg_temp.expect('PH: rx4 (still active) dispenses', pg_temp.try(pg_temp.dispense_sql(
  pg_temp.work_item_of(pg_temp.rx(4)), 2)), 'ok');
reset role;
-- A sent prescription changed after the send: DR edits rx6 (sent at version
-- 2) while it stays active, and resumes rx3 (held above). The pharmacy item
-- keeps the version sent, so the send is withdrawn and "Send to pharmacy"
-- answers superseded (never already_in_pharmacy). Completing rx4 marks nothing.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('rx6 at the version sent: the send answers already_in_pharmacy',
  pg_temp.send(pg_temp.rx(6), 2), 'already_in_pharmacy:item');
select pg_temp.expect('rx6 at the version sent is not withdrawn', ehr.withdraw_own_pharmacy_send(pg_temp.rx(6))::text,
  'false');
select set_config('app.change_reason', 'Changed the frequency', true);
update ehr.prescriptions set frequency = 'Every 12 hours' where id = pg_temp.rx(6);
select pg_temp.expect('the edited rx6 is active at version 3', (select p.status || '/' || p.row_version
  from ehr.prescriptions p where p.id = pg_temp.rx(6)), 'active/3');
reset role;
select pg_temp.expect('the edit alone marks rx6''s send withdrawn (D8''s trigger)', (select (s.withdrawn_at is not null)::text
  from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(6)), 'true');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('the edited rx6''s send stands withdrawn',
  ehr.withdraw_own_pharmacy_send(pg_temp.rx(6))::text || '/' || ehr.withdraw_own_pharmacy_send(pg_temp.rx(6))::text,
  'true/true');
select pg_temp.expect('Send to pharmacy for the edited rx6 answers superseded', pg_temp.send(pg_temp.rx(6), 3),
  'superseded:item');
select pg_temp.set_status(3, 'active', 'Resumed after review');
select pg_temp.expect('the resumed rx3 is active at version 4, its send withdrawn since the hold',
  (select p.status || '/' || p.row_version from ehr.prescriptions p where p.id = pg_temp.rx(3)) || '/'
    || ehr.withdraw_own_pharmacy_send(pg_temp.rx(3))::text, 'active/4/true');
select pg_temp.expect('Send to pharmacy for the resumed rx3 answers superseded', pg_temp.send(pg_temp.rx(3), 4),
  'superseded:item');
select pg_temp.set_status(4, 'completed', 'Course completed');
select pg_temp.expect('the completed rx4''s send is not withdrawn', ehr.withdraw_own_pharmacy_send(pg_temp.rx(4))::text,
  'false');
reset role;
select pg_temp.expect('rx3''s withdrawal time is still the hold''s', (select s.withdrawn_at::text
  from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(3)),
  current_setting('own_work.rx3_withdrawn_at'));
select pg_temp.expect('the sends: rx3 and rx6 withdrawn at their sent version 2, rx4 not',
  (select string_agg(right(s.prescription_id::text, 2) || ':' || s.prescription_version || ':' || (s.withdrawn_at is not null),
     ' ' order by s.prescription_id) from pharmacy.own_prescription_sends s
    where s.prescription_id in (pg_temp.rx(3), pg_temp.rx(4), pg_temp.rx(6))), '03:2:true 04:2:false 06:2:true');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: the edited rx6 and the resumed rx3 read withdrawn, rx4 not',
  (select string_agg(right(w.source_ehr_prescription_id::text, 2) || ':' || state.withdrawn, ' '
     order by w.source_ehr_prescription_id)
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(3)), pg_temp.work_item_of(pg_temp.rx(4)),
       pg_temp.work_item_of(pg_temp.rx(6))]) state join pharmacy.work_items w on w.id = state.work_item_id),
  '03:true 04:false 06:true');
select pg_temp.expect('PH: dispensing the edited rx6 is refused',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(6)), 2)), '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE');
select pg_temp.expect('PH: dispensing the resumed rx3 is refused',
  pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(3)), 2)), '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE');
reset role;

-- 6. Lab: an own lab work item for Ada at F1 and one at F2 (as replica, as
-- lab-api accepts them from the EHR).
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
  requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
select ('e133000a-0000-4000-8000-00000000000' || site)::uuid, 'e1330006-0000-4000-8000-000000000001',
       ('e1330001-0000-4000-8000-00000000000' || site)::uuid, ('e1330001-0000-4000-8000-00000000000' || site)::uuid,
       gen_random_uuid(), 1, gen_random_uuid(), 'accepted', 'routine', 'http://loinc.org', '718-7', 'Haemoglobin',
       'e1330002-0000-4000-8000-000000000001', clock_timestamp(), 'e1330002-0000-4000-8000-000000000001',
       'e1330004-0000-4000-8000-000000000001', 'own-work-lab-item-' || site || '-key', repeat('b', 64),
       'own-work-suite-lab-' || site
  from generate_series(1, 2) site;
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('LS sees F1''s own lab item and its card',
  (select format('%s/%s/%s/%s', (select count(*) from lab.work_items),
     (select string_agg(card.patient_full_name, ',') from lab.work_item_patient_cards(
        array['e133000a-0000-4000-8000-000000000001'::uuid, 'e133000a-0000-4000-8000-000000000002'::uuid]) card),
     (select count(*) from lab.own_work_access_for('work_item', 'e133000a-0000-4000-8000-000000000001', 'write_records')),
     (select string_agg(basis, ',') from lab.own_work_item_bases(array['e133000a-0000-4000-8000-000000000001'::uuid])))),
  '1/Ada Own/1/own-work');
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
values ('e133000b-0000-4000-8000-000000000001', 'e133000a-0000-4000-8000-000000000001',
  'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'routine',
  'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003', 'own-work-accession-0001',
  repeat('c', 64), current_setting('app.correlation_id'));
select pg_temp.expect('LS may work on its accession', (select count(*)::text from lab.own_work_access_for('accession',
  'e133000b-0000-4000-8000-000000000001', 'write_records')), '1');
select pg_temp.as_member(11);
select pg_temp.expect('L2 (lab at F2) sees only F2''s item', (select string_agg(right(id::text, 1), ',') from lab.work_items),
  '2');
select pg_temp.as_member(4);
select pg_temp.expect('NU (nurse) sees no lab item', (select count(*)::text from lab.work_items), '0');
select pg_temp.expect('AD (admin) sees no lab item', pg_temp.lab_view(5), 'items=0 cards=0 access=0');
select pg_temp.expect('RC (receptionist) sees no lab item', pg_temp.lab_view(7), 'items=0 cards=0 access=0');
select pg_temp.expect('CL (clinician) sees no lab item', pg_temp.lab_view(12), 'items=0 cards=0 access=0');
select pg_temp.expect('DN (doctor without a grant) sees no lab item', pg_temp.lab_view(13), 'items=0 cards=0 access=0');
select pg_temp.expect('RO (receive permission without the read one) sees no lab item', pg_temp.lab_view(14),
  'items=0 cards=0 access=0');
select pg_temp.as_member(3, purpose => 'emergency');
select pg_temp.expect('LS in an emergency session sees no lab item', (select count(*)::text from lab.work_items), '0');
reset role;

-- 7. Item by item, never the imported evidence. Fixtures as replica, as the
-- services would have written them: for Ada at F1, the own lab item's chain
-- (W1: requested test, specimen requirement, specimen, execution, result on
-- LS's accession of case 6); a route-backed lab item (R1, an order from F3;
-- its route is unknown here, so its route branch is false) with the same
-- chain; a route-backed pharmacy item (RP, from F3) with a dispensing; and
-- the patient's imported Lab and Pharmacy evidence (OCR-imported outside
-- records).
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, order_route_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
  requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e133000a-0000-4000-8000-000000000003', 'e1330006-0000-4000-8000-000000000001',
  'e1330001-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000003', gen_random_uuid(), gen_random_uuid(), 1,
  gen_random_uuid(), 'accepted', 'routine', 'http://loinc.org', '2345-7', 'Glucose (routed)',
  'e1330002-0000-4000-8000-000000000009', clock_timestamp(), 'e1330002-0000-4000-8000-000000000003',
  'e1330004-0000-4000-8000-000000000003', 'own-work-routed-lab-item-key', repeat('b', 64), 'own-work-suite-routed');
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
values ('e133000b-0000-4000-8000-000000000003', 'e133000a-0000-4000-8000-000000000003',
  'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'routine',
  'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003', 'own-work-routed-accession',
  repeat('c', 64), 'own-work-suite-routed');
-- n = 1: W1 (own, accession e133000b...01); n = 3: R1 (routed, accession e133000b...03).
insert into lab.work_item_requested_tests (id, work_item_id, facility_id, patient_id, ordinal, code_system, code, name)
select ('e133000c-0000-4000-8000-00000000000' || n)::uuid, ('e133000a-0000-4000-8000-00000000000' || n)::uuid,
       'e1330001-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000001', 1, 'http://loinc.org', '718-7',
       'Haemoglobin'
  from unnest(array[1, 3]) n;
insert into lab.specimen_requirements (id, accession_id, patient_id, facility_id, ordinal, specimen_type)
select ('e133000d-0000-4000-8000-00000000000' || n)::uuid, ('e133000b-0000-4000-8000-00000000000' || n)::uuid,
       'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 1, 'blood'
  from unnest(array[1, 3]) n;
insert into lab.specimens (id, specimen_identifier, requirement_id, accession_id, patient_id, facility_id,
  collection_ordinal, specimen_type)
select ('e133000e-0000-4000-8000-00000000000' || n)::uuid, 'OWN-WORK-SPECIMEN-' || n,
       ('e133000d-0000-4000-8000-00000000000' || n)::uuid, ('e133000b-0000-4000-8000-00000000000' || n)::uuid,
       'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 1, 'blood'
  from unnest(array[1, 3]) n;
insert into lab.test_executions (id, accession_id, specimen_id, requested_test_id, patient_id, facility_id,
  started_by, started_by_membership_id, started_at, idempotency_key, request_sha256, correlation_id)
select ('e133000f-0000-4000-8000-00000000000' || n)::uuid, ('e133000b-0000-4000-8000-00000000000' || n)::uuid,
       ('e133000e-0000-4000-8000-00000000000' || n)::uuid, ('e133000c-0000-4000-8000-00000000000' || n)::uuid,
       'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001',
       'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003', clock_timestamp(),
       'own-work-execution-' || n, repeat('f', 64), 'own-work-suite-chain'
  from unnest(array[1, 3]) n;
insert into lab.results (id, execution_id, patient_id, facility_id, created_by, created_by_membership_id)
select ('e1330010-0000-4000-8000-00000000000' || n)::uuid, ('e133000f-0000-4000-8000-00000000000' || n)::uuid,
       'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001',
       'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003'
  from unnest(array[1, 3]) n;
insert into pharmacy.work_items (id, patient_id, facility_id, ordering_facility_id, order_route_id,
  source_ehr_prescription_id, source_ehr_prescription_version, source_encounter_id, source_status, medication_display,
  frequency, instructions, prescribed_by, prescribed_at, accepted_by, accepted_by_membership_id, acceptance_reason,
  idempotency_key, request_sha256, correlation_id)
values ('e1330011-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000001',
  'e1330001-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000003', gen_random_uuid(), gen_random_uuid(), 1,
  gen_random_uuid(), 'active', 'Metformin 500 mg tablet (routed)', 'Twice a day', 'Take with food',
  'e1330002-0000-4000-8000-000000000009', clock_timestamp(), 'e1330002-0000-4000-8000-000000000002',
  'e1330004-0000-4000-8000-000000000002', 'Accepted from Own Work Clinic', 'own-work-routed-pharmacy-key',
  repeat('b', 64), 'own-work-suite-routed');
insert into pharmacy.dispensings (id, work_item_id, work_item_version, patient_id, facility_id, medication_display,
  quantity_dispensed, quantity_unit, dispensed_by, dispensed_by_membership_id, reason, idempotency_key, request_sha256,
  correlation_id)
values ('e1330012-0000-4000-8000-000000000001', 'e1330011-0000-4000-8000-000000000001', 1,
  'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'Metformin 500 mg tablet (routed)',
  60, 'tablet', 'e1330002-0000-4000-8000-000000000002', 'e1330004-0000-4000-8000-000000000002',
  'Dispensed to the patient', 'own-work-routed-dispensing', repeat('d', 64), 'own-work-suite-routed');
insert into lab.imported_evidence (patient_id, facility_id, source_document_id, reviewed_by, created_by,
  created_by_membership_id, idempotency_key, request_sha256, correlation_id, external_lab_name)
values ('e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', gen_random_uuid(),
  'e1330002-0000-4000-8000-000000000001', 'e1330002-0000-4000-8000-000000000001', 'e1330004-0000-4000-8000-000000000001',
  'own-work-imported-lab-0001', repeat('e', 64), 'own-work-suite-imported', 'Synthetic Outside Lab');
insert into pharmacy.imported_medication_evidence (patient_id, facility_id, source_document_id, ocr_job_id,
  extraction_id, validation_id, validation_version, publication_id, medication_text, reviewed_by, created_by,
  created_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, gen_random_uuid(), 'Synthetic imported medicine',
  'e1330002-0000-4000-8000-000000000001', 'e1330002-0000-4000-8000-000000000001', 'e1330004-0000-4000-8000-000000000001',
  'own-work-imported-medication-0001', repeat('e', 64), 'own-work-suite-imported');
set local session_replication_role = origin;
-- The chain of lab item n (1: W1, 3: R1) as the session reads it, and as it
-- may lock it for update (what the API's updates need).
create function pg_temp.lab_chain(n integer) returns text language plpgsql as $f$
declare answer text;
begin
  select format('tests=%s accessions=%s requirements=%s specimens=%s executions=%s results=%s locked=%s/%s/%s',
           (select count(*) from lab.work_item_requested_tests where id = ('e133000c-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from lab.accessions where id = ('e133000b-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from lab.specimen_requirements where id = ('e133000d-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from lab.specimens where id = ('e133000e-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from lab.test_executions where id = ('e133000f-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from lab.results where id = ('e1330010-0000-4000-8000-00000000000' || n)::uuid),
           (select count(*) from (select 1 from lab.specimens
               where id = ('e133000e-0000-4000-8000-00000000000' || n)::uuid for update) locked),
           (select count(*) from (select 1 from lab.test_executions
               where id = ('e133000f-0000-4000-8000-00000000000' || n)::uuid for update) locked),
           (select count(*) from (select 1 from lab.results
               where id = ('e1330010-0000-4000-8000-00000000000' || n)::uuid for update) locked))
    into answer;
  return answer;
end $f$;
grant execute on function pg_temp.lab_chain(integer) to public;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('LS: W1''s chain is visible and lockable', pg_temp.lab_chain(1),
  'tests=1 accessions=1 requirements=1 specimens=1 executions=1 results=1 locked=1/1/1');
select pg_temp.expect('LS: R1 (routed, same patient and facility) and its chain stay hidden',
  (select count(*) from lab.work_items where id = 'e133000a-0000-4000-8000-000000000003') || ' ' || pg_temp.lab_chain(3),
  '0 tests=0 accessions=0 requirements=0 specimens=0 executions=0 results=0 locked=0/0/0');
select pg_temp.expect('LS: R1''s accession, execution and result give no own work item',
  (select count(*)::text from (select * from lab.own_work_access_for('accession', 'e133000b-0000-4000-8000-000000000003',
     'read_records') union all select * from lab.own_work_access_for('execution', 'e133000f-0000-4000-8000-000000000003',
     'read_records') union all select * from lab.own_work_access_for('result', 'e1330010-0000-4000-8000-000000000003',
     'read_records')) found), '0');
select pg_temp.expect('LS cannot write an accession onto R1',
  (pg_temp.try($i$insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by,
    created_by_membership_id, idempotency_key, request_sha256, correlation_id)
    values (gen_random_uuid(), 'e133000a-0000-4000-8000-000000000003', 'e1330006-0000-4000-8000-000000000001',
    'e1330001-0000-4000-8000-000000000001', 'routine', 'e1330002-0000-4000-8000-000000000003',
    'e1330004-0000-4000-8000-000000000003', 'own-work-routed-accession-2', repeat('c', 64),
    current_setting('app.correlation_id'))$i$) ~ '^(42501|23514) ')::text, 'true');
select pg_temp.expect('LS cannot write a specimen event onto R1''s accession',
  (pg_temp.try($i$insert into lab.specimen_events (specimen_id, accession_id, patient_id, facility_id, event_version,
    event_type, actor_id, actor_membership_id, reason, correlation_id)
    values ('e133000e-0000-4000-8000-000000000003', 'e133000b-0000-4000-8000-000000000003',
    'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 1, 'collected',
    'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003', 'Collected',
    current_setting('app.correlation_id'))$i$) ~ '^(42501|23514) ')::text, 'true');
select pg_temp.expect('LS (no grant) reads none of Ada''s imported Lab evidence',
  (select count(*)::text from lab.imported_evidence), '0');
select pg_temp.as_member(4);
select pg_temp.expect('NU reads none of it and none of W1''s chain',
  (select count(*) from lab.imported_evidence) || ' ' || pg_temp.lab_chain(1),
  '0 tests=0 accessions=0 requirements=0 specimens=0 executions=0 results=0 locked=0/0/0');
select pg_temp.as_member(11);
select pg_temp.expect('L2 (lab at F2) in a session at F1 reads nothing of W1''s chain',
  (select count(*) from lab.imported_evidence) || ' ' || pg_temp.lab_chain(1),
  '0 tests=0 accessions=0 requirements=0 specimens=0 executions=0 results=0 locked=0/0/0');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: the own dispensings visible, RP and its dispensing hidden',
  format('%s/%s/%s', (select count(*) from pharmacy.dispensings d
     where d.work_item_id in (pg_temp.work_item_of(pg_temp.rx(1)), pg_temp.work_item_of(pg_temp.rx(4)))),
    (select count(*) from pharmacy.work_items where id = 'e1330011-0000-4000-8000-000000000001'),
    (select count(*) from pharmacy.dispensings where id = 'e1330012-0000-4000-8000-000000000001')), '2/0/0');
select pg_temp.expect('PH: RP''s dispensing gives no own work item', (select count(*)::text
  from pharmacy.own_work_access_for('dispensing', 'e1330012-0000-4000-8000-000000000001', 'read_records')), '0');
select pg_temp.expect('PH (no grant) reads none of Ada''s imported medication evidence',
  (select count(*)::text from pharmacy.imported_medication_evidence), '0');
select pg_temp.expect('PH writes Pharmacy''s event about its own dispensing of rx1',
  (select pg_temp.try(format($i$insert into pharmacy.outbox_events (event_type, aggregate_type, aggregate_id,
     aggregate_version, facility_id, patient_id, correlation_id, payload) values ('MedicationDispensed',
     'medication-dispensing', %L, 1, 'e1330001-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000001',
     current_setting('app.correlation_id'), jsonb_build_object('dispensingId', %L::uuid, 'workItemId', %L::uuid,
     'status', 'dispensed'))$i$, d.id, d.id, d.work_item_id))
     from pharmacy.dispensings d where d.work_item_id = pg_temp.work_item_of(pg_temp.rx(1))), 'ok');
select pg_temp.expect('PH cannot write an event about RP''s dispensing',
  pg_temp.try($i$insert into pharmacy.outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version,
    facility_id, patient_id, correlation_id, payload) values ('MedicationDispensed', 'medication-dispensing',
    'e1330012-0000-4000-8000-000000000001', 1, 'e1330001-0000-4000-8000-000000000001',
    'e1330006-0000-4000-8000-000000000001', current_setting('app.correlation_id'),
    '{"status": "dispensed"}')$i$), '42501 new row violates row-level security policy for table "outbox_events"');
select pg_temp.expect('PH cannot write an event of another kind about its own work item',
  pg_temp.try(format($i$insert into pharmacy.outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version,
    facility_id, patient_id, correlation_id, payload) values ('PharmacyImportedMedicationEvidenceCreated',
    'pharmacy-imported-medication-evidence', %L, 1, 'e1330001-0000-4000-8000-000000000001',
    'e1330006-0000-4000-8000-000000000001', current_setting('app.correlation_id'), '{"status": "created"}')$i$,
    pg_temp.work_item_of(pg_temp.rx(1)))), '42501 new row violates row-level security policy for table "outbox_events"');
select pg_temp.expect('PH cannot dispense RP',
  (pg_temp.try(pg_temp.dispense_sql('e1330011-0000-4000-8000-000000000001', 2)) ~ '^(42501|23514) ')::text, 'true');
select pg_temp.as_member(10);
select pg_temp.expect('PG (pharmacist with a grant for Ada) reads her imported medication evidence (consent)',
  (select count(*)::text from pharmacy.imported_medication_evidence), '1');
reset role;

-- 7b. LS (and L3, the second person) works W1's chain with lab-api's own
-- statements (LabAccessionsService, LabExecutionsService), without a grant.
-- A statement's rows changed, or 'SQLSTATE message'.
create function pg_temp.changed(statement text) returns text language plpgsql as $f$
declare answer bigint;
begin
  execute 'with changed as (' || statement || ') select count(*) from changed' into answer;
  return 'rows=' || answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
grant execute on function pg_temp.changed(text) to public;
-- The ids: W1's accession A1 e133000b...01 and requested test T1
-- e133000c...01; new requirement e133000d...02, specimen e133000e...02,
-- execution e133000f...02, result e1330010...02. Ada at F1; LS member 3, L3 15.
create function pg_temp.lab_sql(step text) returns text language sql immutable as $f$
  select case step
    when 'requirement' then $i$insert into lab.specimen_requirements(id,accession_id,patient_id,facility_id,ordinal,
      specimen_type,container_type,notes) values('e133000d-0000-4000-8000-000000000002','e133000b-0000-4000-8000-000000000001',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',2,'urine',null,null)$i$
    when 'specimen' then $i$insert into lab.specimens(id,requirement_id,accession_id,patient_id,facility_id,specimen_type,
      container_type) values('e133000e-0000-4000-8000-000000000002','e133000d-0000-4000-8000-000000000002',
      'e133000b-0000-4000-8000-000000000001','e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',
      'urine',null) returning id$i$
    when 'collect' then $i$update lab.specimens set status='collected',collected_at=clock_timestamp(),
      collected_by='e1330002-0000-4000-8000-000000000003',collected_by_membership_id='e1330004-0000-4000-8000-000000000003',
      collection_notes=null,row_version=row_version+1 where id='e133000e-0000-4000-8000-000000000002'
      and accession_id='e133000b-0000-4000-8000-000000000001' and facility_id='e1330001-0000-4000-8000-000000000001'
      and row_version=1 returning id$i$
    when 'receive' then $i$update lab.specimens set status='received',received_at=clock_timestamp(),
      received_by='e1330002-0000-4000-8000-000000000003',received_by_membership_id='e1330004-0000-4000-8000-000000000003',
      receipt_condition=null,row_version=row_version+1 where id='e133000e-0000-4000-8000-000000000002'
      and accession_id='e133000b-0000-4000-8000-000000000001' and facility_id='e1330001-0000-4000-8000-000000000001'
      and row_version=2 returning id$i$
    when 'start' then $i$insert into lab.test_executions(id,accession_id,specimen_id,requested_test_id,patient_id,facility_id,
      method,started_by,started_by_membership_id,started_at,idempotency_key,request_sha256,correlation_id)
      values('e133000f-0000-4000-8000-000000000002','e133000b-0000-4000-8000-000000000001',
      'e133000e-0000-4000-8000-000000000002','e133000c-0000-4000-8000-000000000001','e1330006-0000-4000-8000-000000000001',
      'e1330001-0000-4000-8000-000000000001',null,'e1330002-0000-4000-8000-000000000003',
      'e1330004-0000-4000-8000-000000000003',clock_timestamp(),'own-work-start-0002',repeat('f',64),
      current_setting('app.correlation_id')) returning id$i$
    when 'complete' then $i$update lab.test_executions set status='completed',completed_at=clock_timestamp(),
      completed_by='e1330002-0000-4000-8000-000000000003',completed_by_membership_id='e1330004-0000-4000-8000-000000000003',
      completion_notes=null,completed_idempotency_key='own-work-complete-0002',completed_request_sha256=repeat('f',64),
      row_version=row_version+1 where id='e133000f-0000-4000-8000-000000000002' and status='in_progress' and row_version=1
      returning id$i$
    when 'result' then $i$insert into lab.results(id,execution_id,patient_id,facility_id,created_by,created_by_membership_id)
      values('e1330010-0000-4000-8000-000000000002','e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001','e1330002-0000-4000-8000-000000000003',
      'e1330004-0000-4000-8000-000000000003') returning id$i$
    when 'revision1' then $i$insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,
      result_type,numeric_value,text_value,unit,reference_range,abnormal_flag,entered_by,entered_by_membership_id,
      correction_reason,idempotency_key,request_sha256,correlation_id,revision_kind,supersedes_version)
      values('e1330010-0000-4000-8000-000000000002','e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',1,'numeric',1.015,null,null,
      '1.005-1.030','normal','e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003',null,
      'own-work-result-0002',repeat('9',64),current_setting('app.correlation_id'),'original',null) returning id$i$
    when 'correct' then $i$update lab.results set current_version=current_version+1
      where id='e1330010-0000-4000-8000-000000000002' and execution_id='e133000f-0000-4000-8000-000000000002'
      and current_version=1 and (not exists(select 1 from lab.result_releases
        where result_id='e1330010-0000-4000-8000-000000000002' and result_version=1) or false)
      returning current_version$i$
    when 'revision2' then $i$insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,
      result_type,numeric_value,text_value,unit,reference_range,abnormal_flag,entered_by,entered_by_membership_id,
      correction_reason,idempotency_key,request_sha256,correlation_id,revision_kind,supersedes_version)
      values('e1330010-0000-4000-8000-000000000002','e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',2,'numeric',1.020,null,null,
      '1.005-1.030','normal','e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003',
      'Read again after calibration','own-work-result-0003',repeat('9',64),current_setting('app.correlation_id'),
      'correction',1) returning id$i$
    when 'verify' then $i$insert into lab.result_verifications(result_id,execution_id,patient_id,facility_id,result_version,
      verified_by,verified_by_membership_id,verified_at,reason,idempotency_key,request_sha256,correlation_id)
      values('e1330010-0000-4000-8000-000000000002','e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',2,
      'e1330002-0000-4000-8000-000000000015','e1330004-0000-4000-8000-000000000015',clock_timestamp(),'Checked',
      'own-work-verify-0002',repeat('8',64),current_setting('app.correlation_id')) returning id$i$
    when 'release' then $i$insert into lab.result_releases(verification_id,result_id,execution_id,patient_id,facility_id,
      result_version,released_by,released_by_membership_id,released_at,reason,idempotency_key,request_sha256,correlation_id)
      select verification.id,'e1330010-0000-4000-8000-000000000002','e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',2,
      'e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003',clock_timestamp(),'Released',
      'own-work-release-0002',repeat('7',64),current_setting('app.correlation_id')
      from lab.result_verifications verification
      where verification.result_id='e1330010-0000-4000-8000-000000000002' and verification.result_version=2
      returning id$i$
  end
$f$;
-- A specimen, execution or result event as lab-api writes it, and its outbox event.
create function pg_temp.lab_event_sql(kind text, version integer, event_type text) returns text language sql immutable as $f$
  select case kind
    when 'specimen' then format($i$insert into lab.specimen_events(specimen_id,accession_id,patient_id,facility_id,
      event_version,event_type,actor_id,actor_membership_id,reason,correlation_id)
      values('e133000e-0000-4000-8000-000000000002','e133000b-0000-4000-8000-000000000001',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',%s,%L,
      'e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003','Own work suite',
      current_setting('app.correlation_id')) returning id$i$, version, event_type)
    when 'command' then format($i$insert into lab.specimen_command_idempotency(facility_id,patient_id,actor_id,
      idempotency_key,operation,specimen_id,request_sha256,result_version)
      values('e1330001-0000-4000-8000-000000000001','e1330006-0000-4000-8000-000000000001',
      'e1330002-0000-4000-8000-000000000003',%L,%L,'e133000e-0000-4000-8000-000000000002',repeat('a',64),%s)
      returning specimen_id$i$, 'own-work-' || event_type || '-0002', event_type, version)
    when 'execution' then format($i$insert into lab.execution_events(execution_id,patient_id,facility_id,event_version,
      event_type,actor_id,actor_membership_id,reason,correlation_id) values('e133000f-0000-4000-8000-000000000002',
      'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',%s,%L,
      'e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003','Own work suite',
      current_setting('app.correlation_id')) returning execution_id$i$, version, event_type)
    when 'result' then format($i$insert into lab.result_events(result_id,execution_id,patient_id,facility_id,event_version,
      event_type,actor_id,actor_membership_id,reason,correlation_id) values('e1330010-0000-4000-8000-000000000002',
      'e133000f-0000-4000-8000-000000000002','e1330006-0000-4000-8000-000000000001',
      'e1330001-0000-4000-8000-000000000001',%s,%L,'e1330002-0000-4000-8000-000000000003',
      'e1330004-0000-4000-8000-000000000003','Own work suite',current_setting('app.correlation_id')) returning result_id$i$,
      version, event_type)
    when 'outbox' then format($i$insert into lab.outbox_events(event_type,aggregate_id,aggregate_version,facility_id,
      patient_id,correlation_id,payload) values(%L,'e133000e-0000-4000-8000-000000000002',%s,
      'e1330001-0000-4000-8000-000000000001','e1330006-0000-4000-8000-000000000001',current_setting('app.correlation_id'),
      '{"status":"own-work-suite"}'::jsonb) returning id$i$, event_type, version)
  end
$f$;
-- W1's chain rows as the session reads them (counts per table, new rows only).
create function pg_temp.lab_chain_written() returns text language sql as $f$
  select format('requirements=%s specimens=%s specimen_events=%s commands=%s executions=%s execution_events=%s '
      || 'results=%s revisions=%s result_events=%s verifications=%s releases=%s',
    (select count(*) from lab.specimen_requirements where id = 'e133000d-0000-4000-8000-000000000002'),
    (select string_agg(status || ':' || row_version, ',') from lab.specimens where id = 'e133000e-0000-4000-8000-000000000002'),
    (select count(*) from lab.specimen_events where specimen_id = 'e133000e-0000-4000-8000-000000000002'),
    (select count(*) from lab.specimen_command_idempotency where specimen_id = 'e133000e-0000-4000-8000-000000000002'),
    (select string_agg(status || ':' || row_version, ',') from lab.test_executions
      where id = 'e133000f-0000-4000-8000-000000000002'),
    (select count(*) from lab.execution_events where execution_id = 'e133000f-0000-4000-8000-000000000002'),
    (select string_agg(current_version::text, ',') from lab.results where id = 'e1330010-0000-4000-8000-000000000002'),
    (select count(*) from lab.result_revisions where result_id = 'e1330010-0000-4000-8000-000000000002'),
    (select count(*) from lab.result_events where result_id = 'e1330010-0000-4000-8000-000000000002'),
    (select count(*) from lab.result_verifications where result_id = 'e1330010-0000-4000-8000-000000000002'),
    (select count(*) from lab.result_releases where result_id = 'e1330010-0000-4000-8000-000000000002'))
$f$;
grant execute on function pg_temp.lab_sql(text), pg_temp.lab_event_sql(text, integer, text),
  pg_temp.lab_chain_written() to public;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('LS: a second specimen requirement and specimen on W1''s accession, with their event',
  format('%s %s %s', pg_temp.try(pg_temp.lab_sql('requirement')), pg_temp.changed(pg_temp.lab_sql('specimen')),
    pg_temp.changed(pg_temp.lab_event_sql('specimen', 1, 'specimen_required'))), 'ok rows=1 rows=1');
select pg_temp.expect('LS collects it: the update, its command key, its event and its outbox event',
  format('%s %s %s %s', pg_temp.changed(pg_temp.lab_sql('collect')), pg_temp.changed(pg_temp.lab_event_sql('command', 2,
    'collect')), pg_temp.changed(pg_temp.lab_event_sql('specimen', 2, 'specimen_collected')),
    pg_temp.changed(pg_temp.lab_event_sql('outbox', 2, 'LabSpecimenCollected'))), 'rows=1 rows=1 rows=1 rows=1');
select pg_temp.expect('LS receives it',
  format('%s %s %s', pg_temp.changed(pg_temp.lab_sql('receive')), pg_temp.changed(pg_temp.lab_event_sql('command', 3,
    'receive')), pg_temp.changed(pg_temp.lab_event_sql('specimen', 3, 'specimen_received'))), 'rows=1 rows=1 rows=1');
select pg_temp.expect('LS starts and completes an execution on it, with their events',
  format('%s %s %s %s', pg_temp.changed(pg_temp.lab_sql('start')),
    pg_temp.changed(pg_temp.lab_event_sql('execution', 1, 'execution_started')), pg_temp.changed(pg_temp.lab_sql('complete')),
    pg_temp.changed(pg_temp.lab_event_sql('execution', 2, 'execution_completed'))), 'rows=1 rows=1 rows=1 rows=1');
select pg_temp.expect('LS enters a result and corrects it (the head''s update), with their events',
  format('%s %s %s %s %s %s', pg_temp.changed(pg_temp.lab_sql('result')), pg_temp.changed(pg_temp.lab_sql('revision1')),
    pg_temp.changed(pg_temp.lab_event_sql('result', 1, 'result_entered')), pg_temp.changed(pg_temp.lab_sql('correct')),
    pg_temp.changed(pg_temp.lab_sql('revision2')), pg_temp.changed(pg_temp.lab_event_sql('result', 2, 'result_corrected'))),
  'rows=1 rows=1 rows=1 rows=1 rows=1 rows=1');
select pg_temp.expect('LS may not check its own result (0021, two people)',
  (split_part(pg_temp.changed(pg_temp.lab_sql('verify')), ' ', 1) <> 'rows=1')::text, 'true');
select pg_temp.as_member(15);
select pg_temp.expect('L3 (no grant) checks it', pg_temp.changed(pg_temp.lab_sql('verify')), 'rows=1');
select pg_temp.as_member(3);
select pg_temp.expect('LS releases it', pg_temp.changed(pg_temp.lab_sql('release')), 'rows=1');
select pg_temp.expect('LS reads back every row it wrote', pg_temp.lab_chain_written(),
  'requirements=1 specimens=received:3 specimen_events=3 commands=2 executions=completed:2 execution_events=2 '
  || 'results=2 revisions=2 result_events=2 verifications=1 releases=1');
select pg_temp.expect('LS cannot change R1''s specimen or execution (routed): nothing is updated',
  format('%s %s', pg_temp.changed($u$update lab.specimens set row_version=row_version+1
      where id='e133000e-0000-4000-8000-000000000003' returning id$u$),
    pg_temp.changed($u$update lab.test_executions set row_version=row_version+1
      where id='e133000f-0000-4000-8000-000000000003' returning id$u$)), 'rows=0 rows=0');
select pg_temp.expect('LS cannot write a result revision onto R1''s result (routed)',
  (pg_temp.changed($i$insert into lab.result_revisions(result_id,execution_id,patient_id,facility_id,version,result_type,
    numeric_value,unit,abnormal_flag,entered_by,entered_by_membership_id,idempotency_key,request_sha256,correlation_id,
    revision_kind) values('e1330010-0000-4000-8000-000000000003','e133000f-0000-4000-8000-000000000003',
    'e1330006-0000-4000-8000-000000000001','e1330001-0000-4000-8000-000000000001',1,'numeric',5.5,'mmol/L','normal',
    'e1330002-0000-4000-8000-000000000003','e1330004-0000-4000-8000-000000000003','own-work-routed-result',
    repeat('9',64),current_setting('app.correlation_id'),'original') returning id$i$) ~ '^(42501|23514) ')::text, 'true');
select pg_temp.as_member(4);
select pg_temp.expect('NU (nurse) reads none of it', pg_temp.lab_chain_written(),
  'requirements=0 specimens= specimen_events=0 commands=0 executions= execution_events=0 results= '
  || 'revisions=0 result_events=0 verifications=0 releases=0');
select pg_temp.as_member(11, 1);
select pg_temp.expect('L2 (lab at F2) in a session at F1 reads none of it', pg_temp.lab_chain_written(),
  'requirements=0 specimens= specimen_events=0 commands=0 executions= execution_events=0 results= '
  || 'revisions=0 result_events=0 verifications=0 releases=0');
reset role;
-- The services' inserts that answer the new row (RETURNING, so the row must
-- also pass the read policies): LS's accession of a new own lab item W4,
-- PH's dispensing of rx2 and its reversal, exactly as lab-api and
-- pharmacy-api write them.
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
  requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e133000a-0000-4000-8000-000000000004', 'e1330006-0000-4000-8000-000000000001',
  'e1330001-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', gen_random_uuid(), 1,
  gen_random_uuid(), 'accepted', 'routine', 'http://loinc.org', '2160-0', 'Creatinine',
  'e1330002-0000-4000-8000-000000000001', clock_timestamp(), 'e1330002-0000-4000-8000-000000000001',
  'e1330004-0000-4000-8000-000000000001', 'own-work-lab-item-4-key', repeat('b', 64), 'own-work-suite-lab-4');
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('LS accessions W4 with lab-api''s statement, answering the row',
  pg_temp.changed($i$insert into lab.accessions(work_item_id,patient_id,facility_id,priority,created_by,
    created_by_membership_id,idempotency_key,request_sha256,correlation_id)
    values('e133000a-0000-4000-8000-000000000004','e1330006-0000-4000-8000-000000000001',
    'e1330001-0000-4000-8000-000000000001','routine','e1330002-0000-4000-8000-000000000003',
    'e1330004-0000-4000-8000-000000000003','own-work-accession-0004',repeat('c',64),current_setting('app.correlation_id'))
    returning id::text,accession_number,work_item_id::text,patient_id::text,facility_id::text,status,priority,
    row_version::text,created_at,request_sha256$i$), 'rows=1');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH dispenses rx2 with pharmacy-api''s statement, answering the row',
  pg_temp.changed(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(2)), 2) || ' returning *'), 'rows=1');
select pg_temp.expect('PH reverses it with pharmacy-api''s statement, answering the row',
  (select pg_temp.changed(format($i$insert into pharmacy.dispensing_reversals (
        id,dispensing_id,dispensing_version,work_item_id,patient_id,facility_id,reversed_by,
        reversed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,%L,%L,'e1330002-0000-4000-8000-000000000002','e1330004-0000-4000-8000-000000000002',
        'Dispensed to the wrong patient','own-work-reverse-0002',repeat('e',64),current_setting('app.correlation_id'))
      returning *$i$, gen_random_uuid(), d.id, d.work_item_id, d.patient_id, d.facility_id))
     from pharmacy.dispensings d where d.work_item_id = pg_temp.work_item_of(pg_temp.rx(2))), 'rows=1');
reset role;

-- 7c. The deny directive, scope by scope. One directive for Ada at a time,
-- written as replica and undone (a subtransaction rolled back on purpose),
-- each answered as PH's and LS's sessions would see rx1's pharmacy item and
-- W1 through D9 (D1 is consent's own deny test, so the same scope rules).
create function pg_temp.deny_scope(grantee_kind text, grantee uuid, site uuid, deny_actions text[], deny_purposes text[],
  starts interval default interval '-1 hour', ends interval default null) returns text language plpgsql as $f$
declare answer text;
begin
  begin
    if grantee_kind is null then
      raise exception using errcode = 'P0002', message = 'own work suite: no directive';
    end if;
    perform set_config('session_replication_role', 'replica', true);
    insert into identity.consent_directives (id, patient_id, current_version)
    values ('e1330009-0000-4000-8000-000000000002', 'e1330006-0000-4000-8000-000000000001', 1);
    insert into identity.consent_directive_versions (id, directive_id, patient_id, version_no, status, provision_type,
      grantee_type, grantee_id, facility_id, purposes, actions, starts_at, expires_at, source_reference, reason,
      content_sha256)
    values (gen_random_uuid(), 'e1330009-0000-4000-8000-000000000002', 'e1330006-0000-4000-8000-000000000001', 1,
      'active', 'deny', grantee_kind, grantee, site, deny_purposes, deny_actions, clock_timestamp() + starts,
      clock_timestamp() + ends, 'own-work-suite', 'Synthetic scoped deny directive', repeat('c', 64));
    perform set_config('session_replication_role', 'origin', true);
    answer := pg_temp.own_work_answers();
    raise exception using errcode = 'P0001', message = 'own work suite: undo the directive';
  exception
    when sqlstate 'P0001' then
      null;
    when sqlstate 'P0002' then
      answer := pg_temp.own_work_answers();
  end;
  return answer;
end $f$;
-- PH's and LS's answers from D9 on rx1's pharmacy item and W1, in their sessions.
create function pg_temp.own_work_answers() returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_member(2);
  answer := format('PH read=%s write=%s',
    (select count(*) from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(1)), 'read_records')),
    (select count(*) from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(1)), 'write_records')));
  perform pg_temp.as_member(3);
  answer := answer || format(' LS read=%s', (select count(*) from lab.own_work_access_for('work_item',
    'e133000a-0000-4000-8000-000000000001', 'read_records')));
  return answer;
end $f$;
select pg_temp.expect('without a directive both work on Ada''s items',
  pg_temp.deny_scope(null, null, null, '{}', '{}'), 'PH read=1 write=1 LS read=1');
-- A directive on reads only: D9 also answers no write where the schema's
-- owner is under forced row-level security (production), since it cannot
-- read the item; where the owner bypasses it, D9 answers the write. The APIs
-- read the item first either way, so the case reads "either".
select pg_temp.expect('each scope of a deny directive for Ada',
  regexp_replace((select string_agg(label || ': ' || pg_temp.deny_scope(kind, grantee, site, deny_actions, deny_purposes,
     starts, ends), '; ' order by n)
     from (values
       (0, 'everyone', 'all', null, null, '{}', '{}', interval '-1 hour', null),
       (1, 'this facility', 'facility', 'e1330001-0000-4000-8000-000000000001'::uuid, null::uuid, '{}'::text[], '{}'::text[],
         interval '-1 hour', null::interval),
       (2, 'another facility', 'facility', 'e1330001-0000-4000-8000-000000000002', null, '{}', '{}', interval '-1 hour', null),
       (3, 'this organization', 'organization', 'e1330000-0000-4000-8000-000000000001', null, '{}', '{}', interval '-1 hour',
         null),
       (4, 'another organization', 'organization', gen_random_uuid(), null, '{}', '{}', interval '-1 hour', null),
       (5, 'PH as staff', 'staff', 'e1330003-0000-4000-8000-000000000002', null, '{}', '{}', interval '-1 hour', null),
       (6, 'everyone at F2 only', 'all', null, 'e1330001-0000-4000-8000-000000000002', '{}', '{}', interval '-1 hour', null),
       (7, 'everyone at F1 only', 'all', null, 'e1330001-0000-4000-8000-000000000001', '{}', '{}', interval '-1 hour', null),
       (8, 'writes only', 'all', null, null, '{write_records}', '{}', interval '-1 hour', null),
       (9, 'reads only', 'all', null, null, '{read_records}', '{}', interval '-1 hour', null),
       (10, 'emergency only', 'all', null, null, '{}', '{emergency}', interval '-1 hour', null),
       (11, 'direct care', 'all', null, null, '{}', '{direct-care}', interval '-1 hour', null),
       (12, 'not yet started', 'all', null, null, '{}', '{}', interval '1 hour', null),
       (13, 'expired', 'all', null, null, '{}', '{}', interval '-2 hours', interval '-1 hour'))
       scope(n, label, kind, grantee, site, deny_actions, deny_purposes, starts, ends)),
    'reads only: PH read=0 write=[01]', 'reads only: PH read=0 write=either'),
  'everyone: PH read=0 write=0 LS read=0; '
  || 'this facility: PH read=0 write=0 LS read=0; another facility: PH read=1 write=1 LS read=1; '
  || 'this organization: PH read=0 write=0 LS read=0; another organization: PH read=1 write=1 LS read=1; '
  || 'PH as staff: PH read=0 write=0 LS read=1; everyone at F2 only: PH read=1 write=1 LS read=1; '
  || 'everyone at F1 only: PH read=0 write=0 LS read=0; writes only: PH read=1 write=0 LS read=1; '
  || 'reads only: PH read=0 write=either LS read=0; emergency only: PH read=1 write=1 LS read=1; '
  || 'direct care: PH read=0 write=0 LS read=0; not yet started: PH read=1 write=1 LS read=1; '
  || 'expired: PH read=1 write=1 LS read=1');
select pg_temp.expect('the directives were undone', (select count(*)::text from identity.consent_directives
  where id = 'e1330009-0000-4000-8000-000000000002'), '0');

-- 7d. 0125's prescription details read the chart's version snapshots, so
-- they still need the member's consent: none for PH, rx1's for PG.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH (own work, no grant) reads no prescription details', (select count(*)::text
  from pharmacy.work_item_prescription_details(array[pg_temp.work_item_of(pg_temp.rx(1))])), '0');
select pg_temp.as_member(10);
select pg_temp.expect('PG (a grant for Ada) reads rx1''s details', (select count(*)::text
  from pharmacy.work_item_prescription_details(array[pg_temp.work_item_of(pg_temp.rx(1))])), '1');
reset role;

-- 7e. (5b) A change after the dispensing: PH dispensed rx1 in case 3; DR now
-- edits it while it stays active. D8's trigger still records the change on
-- the send, but neither the withdrawal's answer nor D10's flag reports it:
-- the pharmacy dispensed what was sent and has nothing left to dispense.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('rx1 is dispensed and sent at version 2, not withdrawn', ehr.withdraw_own_pharmacy_send(pg_temp.rx(1))::text,
  'false');
select set_config('app.change_reason', 'Changed the frequency after dispensing', true);
update ehr.prescriptions set frequency = 'Every 8 hours' where id = pg_temp.rx(1);
select pg_temp.expect('the edited rx1 is active at version 3', (select p.status || '/' || p.row_version
  from ehr.prescriptions p where p.id = pg_temp.rx(1)), 'active/3');
select pg_temp.expect('the withdrawal answers false for the dispensed rx1',
  ehr.withdraw_own_pharmacy_send(pg_temp.rx(1))::text, 'false');
select pg_temp.expect('Send to pharmacy for the dispensed and edited rx1 answers already_in_pharmacy, not superseded',
  pg_temp.send(pg_temp.rx(1), 3), 'already_in_pharmacy:item');
reset role;
select pg_temp.expect('the change is still recorded on rx1''s send', (select (s.withdrawn_at is not null)::text
  from pharmacy.own_prescription_sends s where s.prescription_id = pg_temp.rx(1)), 'true');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: the dispensed and edited rx1 does not read withdrawn',
  (select string_agg(state.basis || '/' || state.withdrawn, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(1))]) state), 'own-work/false');
select pg_temp.expect('PH: the held rx3 (never dispensed) still reads withdrawn',
  (select string_agg(state.basis || '/' || state.withdrawn, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(3))]) state), 'own-work/true');
reset role;

-- 7f. Another facility's staff, through every reader of the own work: P2
-- (F2's pharmacist) and L2 (F2's lab member), at F2 and claiming F1, get no
-- state or basis, no chain row (events, dispensings, reversals; the Lab
-- chain is case 7b's) and no access through a dispensing or an accession of
-- F1's own items; PH and LS, at F1, read the same (so each probe has rows to
-- find). Ada's dispensed items rx1, rx2 (reversed) and rx4, and W1.
create function pg_temp.dispensing_of(prescription uuid) returns uuid language sql security definer as $f$
  select d.id from pharmacy.dispensings d where d.work_item_id = pg_temp.work_item_of(prescription)
$f$;
create function pg_temp.pharmacy_chain_view(member integer, site integer default null, switched boolean default true)
returns text language plpgsql as $f$
declare
  items uuid[] := array[pg_temp.work_item_of(pg_temp.rx(1)), pg_temp.work_item_of(pg_temp.rx(2)),
    pg_temp.work_item_of(pg_temp.rx(4))];
  answer text;
begin
  perform pg_temp.as_member(member, site, switched => switched);
  select format('states=%s events=%s dispensings=%s reversals=%s access=%s',
           (select count(*) from pharmacy.own_work_item_states(items)),
           (select count(*) from pharmacy.work_item_events e where e.work_item_id = any(items)),
           (select count(*) from pharmacy.dispensings d where d.work_item_id = any(items)),
           (select count(*) from pharmacy.dispensing_reversals r where r.work_item_id = any(items)),
           (select count(*) from pharmacy.own_work_access_for('dispensing', pg_temp.dispensing_of(pg_temp.rx(1)),
              'read_records')) + (select count(*) from pharmacy.own_work_access_for('dispensing',
              pg_temp.dispensing_of(pg_temp.rx(2)), 'write_records')))
    into answer;
  return answer;
end $f$;
create function pg_temp.lab_basis_view(member integer, site integer default null, switched boolean default true)
returns text language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_member(member, site, switched => switched);
  select format('bases=%s access=%s',
           (select coalesce(string_agg(right(basis.work_item_id::text, 1) || ':' || basis.basis, ','
              order by basis.work_item_id), '-') from lab.own_work_item_bases(array[
              'e133000a-0000-4000-8000-000000000001'::uuid, 'e133000a-0000-4000-8000-000000000002'::uuid]) basis),
           (select count(*) from lab.own_work_access_for('work_item', 'e133000a-0000-4000-8000-000000000001',
              'read_records')) + (select count(*) from lab.own_work_access_for('accession',
              'e133000b-0000-4000-8000-000000000001', 'write_records')))
    into answer;
  return answer;
end $f$;
grant execute on function pg_temp.dispensing_of(uuid), pg_temp.pharmacy_chain_view(integer, integer, boolean),
  pg_temp.lab_basis_view(integer, integer, boolean) to public;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('PH (F1) reads the three dispensed items'' states and chain',
  pg_temp.pharmacy_chain_view(2), 'states=3 events=3 dispensings=3 reversals=1 access=2');
select pg_temp.expect('P2 (pharmacist at F2) reads none of it', pg_temp.pharmacy_chain_view(6),
  'states=0 events=0 dispensings=0 reversals=0 access=0');
select pg_temp.expect('P2''s membership in a session at F1 reads none of it', pg_temp.pharmacy_chain_view(6, 1),
  'states=0 events=0 dispensings=0 reversals=0 access=0');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.expect('LS (F1) has W1''s basis and access', pg_temp.lab_basis_view(3), 'bases=1:own-work access=2');
select pg_temp.expect('L2 (lab at F2) has only F2''s own item, nothing of W1', pg_temp.lab_basis_view(11),
  'bases=2:own-work access=0');
select pg_temp.expect('L2''s membership in a session at F1 has nothing', pg_temp.lab_basis_view(11, 1),
  'bases=- access=0');
reset role;

-- 7g. One statement cannot change its session halfway (D1's halves are
-- bound). An own lab item and its accession for Bisi at F1 (her deny
-- directive covers everyone at F1); and, for Pharmacy, copies of PH's own
-- item (at F1 and at F2) and of Bisi's, with an event each, under fixed ids
-- that sort after the row fetched first, so each switch probe below reads
-- the hidden row after the switch (no sort, no filter pushed below it). As
-- replica, inside a savepoint undone at the end of the case.
savepoint own_work_switch;
set local session_replication_role = replica;
insert into lab.work_items (id, patient_id, facility_id, ordering_facility_id, source_ehr_order_id,
  source_ehr_order_version, source_encounter_id, status, priority, test_code_system, test_code, test_name,
  requested_by, requested_at, accepted_by, accepted_by_membership_id, idempotency_key, request_sha256, correlation_id)
values ('e133000a-0000-4000-8000-0000000000c1', 'e1330006-0000-4000-8000-000000000002',
  'e1330001-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', gen_random_uuid(), 1,
  gen_random_uuid(), 'accepted', 'routine', 'http://loinc.org', '718-7', 'Haemoglobin',
  'e1330002-0000-4000-8000-000000000001', clock_timestamp(), 'e1330002-0000-4000-8000-000000000001',
  'e1330004-0000-4000-8000-000000000001', 'own-work-switch-key', repeat('b', 64), 'own-work-suite-switch');
insert into lab.accessions (id, work_item_id, patient_id, facility_id, priority, created_by, created_by_membership_id,
  idempotency_key, request_sha256, correlation_id)
values ('e133000b-0000-4000-8000-0000000000c1', 'e133000a-0000-4000-8000-0000000000c1',
  'e1330006-0000-4000-8000-000000000002', 'e1330001-0000-4000-8000-000000000001', 'routine',
  'e1330002-0000-4000-8000-000000000003', 'e1330004-0000-4000-8000-000000000003', 'own-work-switch-accession',
  repeat('c', 64), 'own-work-suite-switch');
insert into pharmacy.work_items
select (jsonb_populate_record(null::pharmacy.work_items, to_jsonb(item) || jsonb_build_object('id', copy.id,
    'source_ehr_prescription_id', gen_random_uuid(), 'idempotency_key', 'own-work-switch-' || copy.tag,
    'facility_id', coalesce(copy.site, item.facility_id),
    'ordering_facility_id', coalesce(copy.site, item.ordering_facility_id)))).*
  from (values ('e133000d-0000-4000-8000-000000000001'::uuid, 'ph-0001', pg_temp.rx(1), null::uuid),
               ('e133000d-0000-4000-8000-000000000002'::uuid, 'ph-0002', pg_temp.rx(1),
                'e1330001-0000-4000-8000-000000000002'::uuid),
               ('e133000d-0000-4000-8000-0000000000c1'::uuid, 'ph-00c1', pg_temp.rx(7), null::uuid))
         as copy(id, tag, rx, site)
  join pharmacy.work_items item on item.source_ehr_prescription_id = copy.rx;
insert into pharmacy.work_item_events (id, work_item_id, patient_id, facility_id, event_version, event_type, actor_id,
  actor_membership_id, reason, correlation_id, occurred_at)
select ('e133000e' || substr(item.id::text, 9))::uuid, item.id, item.patient_id, item.facility_id, 1,
  'prescription_accepted', item.accepted_by, item.accepted_by_membership_id, 'Own work switch probe',
  'own-work-suite-switch', clock_timestamp()
  from pharmacy.work_items item
 where item.id in ('e133000d-0000-4000-8000-000000000001', 'e133000d-0000-4000-8000-0000000000c1');
set local session_replication_role = origin;
-- QUERY's rows (ids, last 4 characters, sorted): the first fetched in the
-- member's own session; then SETTING is changed to VALUE in the same
-- statement and the rest are fetched.
create function pg_temp.switch_after_first(query text, setting text, switched text) returns text
language plpgsql as $f$
declare
  rows_cursor refcursor;
  fetched record;
  seen text[] := '{}';
begin
  open rows_cursor for execute query;
  fetch rows_cursor into fetched;
  if found then
    seen := seen || right(fetched.id::text, 4);
  end if;
  perform set_config(setting, switched, true);
  loop
    fetch rows_cursor into fetched;
    exit when not found;
    seen := seen || right(fetched.id::text, 4);
  end loop;
  close rows_cursor;
  return coalesce(array_to_string(array(select x from unnest(seen) x order by x), ' '), '');
end $f$;
grant execute on function pg_temp.switch_after_first(text, text, text) to public;
-- The fixtures are in place, so no probe below passes for want of its hidden
-- row.
select pg_temp.expect('7g fixtures: Bisi''s lab item and accession, the three Pharmacy copies and their two events',
  format('%s %s %s %s', (select count(*) from lab.work_items where id = 'e133000a-0000-4000-8000-0000000000c1'),
    (select count(*) from lab.accessions where id = 'e133000b-0000-4000-8000-0000000000c1'),
    (select count(*) from pharmacy.work_items where id in ('e133000d-0000-4000-8000-000000000001',
       'e133000d-0000-4000-8000-000000000002', 'e133000d-0000-4000-8000-0000000000c1')),
    (select count(*) from pharmacy.work_item_events where id in ('e133000e-0000-4000-8000-000000000001',
       'e133000e-0000-4000-8000-0000000000c1'))), '1 1 3 2');
-- Every switch probe reads its rows by one index scan, in id order (no
-- sequential or bitmap scan, so no sort before the first fetch and no
-- hashed path built before the switch, whatever the statistics or
-- cursor_tuple_fraction), so the row fetched first is decided before the
-- switch and the hidden row after it. (A UNION ALL of one scan per row
-- would prove nothing: each scan asks the session's half on its own, after
-- the switch.) Undone after the last probe.
set local enable_seqscan = off;
set local enable_bitmapscan = off;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('7g LS''s own lab items in its own session (Bisi''s hidden by her deny directive, F2''s not F1''s)',
  (select string_agg(right(id::text, 4), ' ' order by id) from lab.work_items
    where id in ('e133000a-0000-4000-8000-000000000001', 'e133000a-0000-4000-8000-000000000002',
                 'e133000a-0000-4000-8000-0000000000c1')), '0001');
select pg_temp.expect('7g a cursor fetched, then app.membership_id changed: nothing more (not Bisi''s item)',
  pg_temp.switch_after_first($q$select id from lab.work_items
    where id in ('e133000a-0000-4000-8000-000000000001', 'e133000a-0000-4000-8000-0000000000c1') order by id$q$,
    'app.membership_id', 'e133ffff-0000-4000-8000-000000000099'), '0001');
select pg_temp.as_member(3);
select pg_temp.expect('7g a cursor fetched, then app.facility_id changed to F2: nothing more (not F2''s item)',
  pg_temp.switch_after_first($q$select id from lab.work_items
    where id in ('e133000a-0000-4000-8000-000000000001', 'e133000a-0000-4000-8000-000000000002') order by id$q$,
    'app.facility_id', 'e1330001-0000-4000-8000-000000000002'), '0001');
select pg_temp.as_member(3);
select pg_temp.expect('7g set_config in the select list (membership): not Bisi''s item',
  (select string_agg(right(switched.id::text, 4), ' ' order by switched.id) from (
     select w.id, set_config('app.membership_id', 'e133ffff-0000-4000-8000-000000000099', true)
       from lab.work_items w
      where w.id in ('e133000a-0000-4000-8000-000000000001', 'e133000a-0000-4000-8000-0000000000c1')) switched),
  '0001');
select pg_temp.as_member(3);
select pg_temp.expect('7g set_config in the select list (facility F2): not F2''s item',
  (select string_agg(right(switched.id::text, 4), ' ' order by switched.id) from (
     select w.id, set_config('app.facility_id', 'e1330001-0000-4000-8000-000000000002', true)
       from lab.work_items w
      where w.id in ('e133000a-0000-4000-8000-000000000001', 'e133000a-0000-4000-8000-000000000002')) switched),
  '0001');
select pg_temp.as_member(3);
select pg_temp.expect('7g the chain (accessions), a cursor fetched, then app.membership_id changed: not Bisi''s',
  pg_temp.switch_after_first($q$select id from lab.accessions
    where id in ('e133000b-0000-4000-8000-000000000001', 'e133000b-0000-4000-8000-0000000000c1') order by id$q$,
    'app.membership_id', 'e133ffff-0000-4000-8000-000000000099'), '0001');
select pg_temp.as_member(3);
select pg_temp.expect('7g the chain (accessions), set_config in the select list: not Bisi''s',
  (select string_agg(right(switched.id::text, 4), ' ' order by switched.id) from (
     select a.id, set_config('app.membership_id', 'e133ffff-0000-4000-8000-000000000099', true)
       from lab.accessions a
      where a.id in ('e133000b-0000-4000-8000-000000000001', 'e133000b-0000-4000-8000-0000000000c1')) switched),
  '0001');
-- The row's half on its own (lab and pharmacy runtimes may call it, as the
-- policies do): only for the session's own membership, of the session's
-- actor's active account, at the row's facility. It does not ask the
-- member's roles again (the session's half asked them once): for RC's or
-- NU's own membership it answers whether the patient is active and
-- uncovered (0133's D11), while the session's half gives them nothing, so
-- no policy lets them read own work.
select pg_temp.as_member(3);
select pg_temp.expect('7g the row''s half for LS: Ada yes, Bisi (deny) no, F2''s row no, another membership no',
  format('%s %s %s %s',
    identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000003',
      'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'read_records'),
    identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000003',
      'e1330006-0000-4000-8000-000000000002', 'e1330001-0000-4000-8000-000000000001', 'read_records'),
    identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000003',
      'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000002', 'read_records'),
    identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000015',
      'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'read_records')),
  't f f f');
select pg_temp.as_member(7);
select pg_temp.expect('7g RC (receptionist): no session membership; the row''s half answers for RC''s own (D11), never as LS',
  format('%s %s %s', coalesce(identity.facility_work_session_membership('lab')::text, 'null'),
    identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000007',
      'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'read_records'),
    identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000003',
      'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'read_records')),
  'null t f');
select pg_temp.as_member(4);
select pg_temp.expect('7g NU''s own session (a nurse): no session membership; the row''s half answers for NU''s own (D11)',
  format('%s %s', coalesce(identity.facility_work_session_membership('lab')::text, 'null'),
    identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000004',
      'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'read_records')), 'null t');
-- The row's half asks for a valid session of that member: the actor's
-- subject, an active account and membership (as has_active_membership).
select pg_temp.as_member(3);
select set_config('app.actor_subject', '', true);
select pg_temp.expect('7g LS''s membership with no actor: the row''s half false',
  identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000003',
    'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'read_records')::text, 'false');
reset role;
savepoint own_work_invalid_member;
update auth.accounts set status = 'disabled' where id = 'e1330002-0000-4000-8000-000000000003';
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('7g LS with a disabled account: the row''s half false',
  identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000003',
    'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'read_records')::text, 'false');
reset role;
rollback to savepoint own_work_invalid_member;
update auth.accounts set disabled_until = clock_timestamp() + interval '1 day'
 where id = 'e1330002-0000-4000-8000-000000000003';
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('7g LS''s account disabled until tomorrow (its status active): the row''s half false',
  identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000003',
    'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'read_records')::text, 'false');
reset role;
rollback to savepoint own_work_invalid_member;
set local session_replication_role = replica;
update identity.staff_facility_memberships set migration_hold_reason = 'own-work-suite'
 where id = 'e1330004-0000-4000-8000-000000000003';
set local session_replication_role = origin;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('7g LS''s membership on hold: the row''s half false',
  identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000003',
    'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'read_records')::text, 'false');
reset role;
rollback to savepoint own_work_invalid_member;
set local role hid_lab_api_runtime;
-- No purpose (an empty app.purpose_of_use): the row's half is false, never
-- null, so D9 refuses too (it returns early only on false).
select pg_temp.as_member(3, purpose => '');
select pg_temp.expect('7g LS with no purpose: the row''s half false, D9 nothing',
  format('%s %s', identity.lab_work_patient_allows('e1330004-0000-4000-8000-000000000003',
      'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001', 'read_records'),
    (select count(*) from lab.own_work_access_for('work_item', 'e133000a-0000-4000-8000-000000000001',
       'write_records'))), 'f 0');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('7g PH''s own pharmacy items in its own session (Bisi''s hidden by her deny directive, F2''s not F1''s)',
  (select string_agg(right(id::text, 4), ' ' order by id) from pharmacy.work_items
    where id in ('e133000d-0000-4000-8000-000000000001', 'e133000d-0000-4000-8000-000000000002',
                 'e133000d-0000-4000-8000-0000000000c1')), '0001');
select pg_temp.expect('7g PH, a cursor fetched, then app.membership_id changed: nothing more (not Bisi''s item)',
  pg_temp.switch_after_first($q$select id from pharmacy.work_items
    where id in ('e133000d-0000-4000-8000-000000000001', 'e133000d-0000-4000-8000-0000000000c1') order by id$q$,
    'app.membership_id', 'e133ffff-0000-4000-8000-000000000099'), '0001');
select pg_temp.as_member(2);
select pg_temp.expect('7g PH, a cursor fetched, then app.facility_id changed to F2: nothing more (not F2''s item)',
  pg_temp.switch_after_first($q$select id from pharmacy.work_items
    where id in ('e133000d-0000-4000-8000-000000000001', 'e133000d-0000-4000-8000-000000000002') order by id$q$,
    'app.facility_id', 'e1330001-0000-4000-8000-000000000002'), '0001');
select pg_temp.as_member(2);
select pg_temp.expect('7g PH, set_config in the select list (membership): not Bisi''s item',
  (select string_agg(right(switched.id::text, 4), ' ' order by switched.id) from (
     select w.id, set_config('app.membership_id', 'e133ffff-0000-4000-8000-000000000099', true)
       from pharmacy.work_items w
      where w.id in ('e133000d-0000-4000-8000-000000000001', 'e133000d-0000-4000-8000-0000000000c1')) switched),
  '0001');
select pg_temp.as_member(2);
select pg_temp.expect('7g PH, set_config in the select list (facility F2): not F2''s item',
  (select string_agg(right(switched.id::text, 4), ' ' order by switched.id) from (
     select w.id, set_config('app.facility_id', 'e1330001-0000-4000-8000-000000000002', true)
       from pharmacy.work_items w
      where w.id in ('e133000d-0000-4000-8000-000000000001', 'e133000d-0000-4000-8000-000000000002')) switched),
  '0001');
select pg_temp.as_member(2);
select pg_temp.expect('7g PH, the chain (work item events), a cursor fetched, then app.membership_id changed: not Bisi''s',
  pg_temp.switch_after_first($q$select id from pharmacy.work_item_events
    where id in ('e133000e-0000-4000-8000-000000000001', 'e133000e-0000-4000-8000-0000000000c1') order by id$q$,
    'app.membership_id', 'e133ffff-0000-4000-8000-000000000099'), '0001');
select pg_temp.as_member(2);
select pg_temp.expect('7g PH, the chain (work item events), set_config in the select list: not Bisi''s',
  (select string_agg(right(switched.id::text, 4), ' ' order by switched.id) from (
     select e.id, set_config('app.membership_id', 'e133ffff-0000-4000-8000-000000000099', true)
       from pharmacy.work_item_events e
      where e.id in ('e133000e-0000-4000-8000-000000000001', 'e133000e-0000-4000-8000-0000000000c1')) switched),
  '0001');
set local enable_seqscan = on;
set local enable_bitmapscan = on;
select pg_temp.as_member(2, purpose => '');
select pg_temp.expect('7g PH with no purpose: D9 nothing',
  (select count(*)::text from pharmacy.own_work_access_for('work_item', pg_temp.work_item_of(pg_temp.rx(1)),
     'write_records')), '0');
reset role;
-- The own-work read policy is asked first on each of its tables (0133's
-- THE COST: PostgreSQL ORs permissive policies in reverse name order). PH
-- reads its four Pharmacy tables, the consent checks counted; then the same
-- reads with the own-work read policies renamed to sort first, so asked
-- last: the same rows, and more consent checks.
set local track_functions = 'all';
select set_config('hid.test.consent_oid', 'identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)'
  ::regprocedure::oid::text, true);
create function pg_temp.consent_calls() returns bigint language sql as $f$
  select coalesce(pg_stat_get_xact_function_calls(current_setting('hid.test.consent_oid')::oid), 0)
$f$;
create function pg_temp.pharmacy_reads() returns text language sql as $f$
  select format('%s/%s/%s/%s', (select count(*) from pharmacy.work_items), (select count(*) from pharmacy.work_item_events),
    (select count(*) from pharmacy.dispensings), (select count(*) from pharmacy.dispensing_reversals))
$f$;
grant execute on function pg_temp.consent_calls(), pg_temp.pharmacy_reads() to public;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select set_config('hid.test.consent_before', pg_temp.consent_calls()::text, true);
select set_config('hid.test.rows_first', pg_temp.pharmacy_reads(), true);
select set_config('hid.test.consent_first', (pg_temp.consent_calls()
  - current_setting('hid.test.consent_before')::bigint)::text, true);
reset role;
savepoint own_work_order;
alter policy staff_own_work_read on pharmacy.work_items rename to aaa_own_work_read;
alter policy staff_own_work_read on pharmacy.work_item_events rename to aaa_own_work_read;
alter policy staff_own_work_read on pharmacy.dispensings rename to aaa_own_work_read;
alter policy staff_own_work_read on pharmacy.dispensing_reversals rename to aaa_own_work_read;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select set_config('hid.test.consent_before', pg_temp.consent_calls()::text, true);
select set_config('hid.test.rows_last', pg_temp.pharmacy_reads(), true);
select pg_temp.expect('7g PH: the same rows, and fewer consent checks with the own-work policies asked first',
  format('%s %s', current_setting('hid.test.rows_last') = current_setting('hid.test.rows_first'),
    current_setting('hid.test.consent_first')::bigint
      < pg_temp.consent_calls() - current_setting('hid.test.consent_before')::bigint),
  't t');
reset role;
rollback to savepoint own_work_order;
rollback to savepoint own_work_switch;

-- 7h. Today's images (0133 D13, owner's Q120 B): a session that does not set
-- app.own_facility_work to '0133' (today's pharmacy-api and lab-api never
-- do) gets nothing of the own work: no own item, card, chain row, state,
-- basis or D9 access for PH and LS, who hold no grant, as on 0001-0127;
-- another value does not switch it on; PG, who holds grants, reads the same
-- items, cards and chain rows with the switch or without it (0086's consent
-- policies, 0124's cards). The unset case (null) is checked before the
-- fixtures' first session, where nothing has set it yet.
create function pg_temp.own_items_view(member integer, kind text, switched boolean) returns text
language plpgsql as $f$
declare answer text;
begin
  perform pg_temp.as_member(member, switched => switched);
  if kind = 'pharmacy' then
    select format('session=%s items=%s cards=%s', coalesce(identity.facility_work_session_membership('pharmacy')::text, 'null'),
             (select count(*) from pharmacy.work_items where facility_id = 'e1330001-0000-4000-8000-000000000001'),
             (select count(*) from pharmacy.work_item_patient_cards(array(select pg_temp.work_item_of(pg_temp.rx(n))
                from generate_series(1, 4) n))))
      into answer;
  else
    select format('session=%s items=%s cards=%s', coalesce(identity.facility_work_session_membership('lab')::text, 'null'),
             (select count(*) from lab.work_items where facility_id = 'e1330001-0000-4000-8000-000000000001'),
             (select count(*) from lab.work_item_patient_cards(array['e133000a-0000-4000-8000-000000000001'::uuid])))
      into answer;
  end if;
  return answer;
end $f$;
grant execute on function pg_temp.own_items_view(integer, text, boolean) to public;
-- The rows a pharmacy member reads through today's readers: items and cards
-- (own_items_view without its session part), events, dispensings and
-- reversals (pharmacy_chain_view without D10's states and D9's access).
create function pg_temp.granted_view(member integer, switched boolean) returns text language sql as $f$
  select regexp_replace(pg_temp.own_items_view(member, 'pharmacy', switched), '^session=\S+ ', '') || ' '
    || regexp_replace(pg_temp.pharmacy_chain_view(member, null, switched), '^states=\d+ (.*) access=\d+$', '\1')
$f$;
grant execute on function pg_temp.granted_view(integer, boolean) to public;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('7h PH, the new image (the switch set): its own items and cards',
  (pg_temp.own_items_view(2, 'pharmacy', true) ~ '^session=e1330004-0000-4000-8000-000000000002 items=[1-9][0-9]* cards=[1-9]')::text,
  'true');
select pg_temp.expect('7h PH, today''s image (no switch): nothing of the own work', pg_temp.own_items_view(2, 'pharmacy', false),
  'session=null items=0 cards=0');
select pg_temp.expect('7h PH, today''s image: no state, chain row or access', pg_temp.pharmacy_chain_view(2, null, false),
  'states=0 events=0 dispensings=0 reversals=0 access=0');
select pg_temp.as_member(2);
select set_config('app.own_facility_work', 'on', true);
select pg_temp.expect('7h PH with another value than 0133: no session membership',
  coalesce(identity.facility_work_session_membership('pharmacy')::text, 'null'), 'null');
-- PG, a pharmacist at F1 holding grants: what its grants give (0086's
-- consent policies, 0124's cards) does not depend on the switch. Only the
-- rows of the tables and cards today's images read are compared; the
-- states and the access check (D10, D9) are the new images' own readers.
select pg_temp.expect('7h PG (a pharmacist with grants), today''s image: what its grants give',
  pg_temp.granted_view(10, false), 'items=7 cards=4 events=3 dispensings=3 reversals=1');
select pg_temp.expect('7h PG: the same with the switch',
  (pg_temp.granted_view(10, false) = pg_temp.granted_view(10, true))::text, 'true');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.expect('7h LS, the new image: its own items and card',
  (pg_temp.own_items_view(3, 'lab', true) ~ '^session=e1330004-0000-4000-8000-000000000003 items=[1-9][0-9]* cards=1$')::text,
  'true');
select pg_temp.expect('7h LS, today''s image (no switch): nothing of the own work', pg_temp.own_items_view(3, 'lab', false),
  'session=null items=0 cards=0');
select pg_temp.expect('7h LS, today''s image: no basis or access', pg_temp.lab_basis_view(3, null, false), 'bases=- access=0');
reset role;

-- 8. The owner-run definer functions that read ehr.prescriptions (case 1
-- lists them) give PH nothing more through the EHR runtime: each refuses
-- the pharmacist before it reads (the two validators are cases 3 and 5).
create function pg_temp.rows_of(statement text) returns text language plpgsql as $f$
declare answer bigint;
begin
  execute 'select count(*) from (' || statement || ') listed' into answer;
  return 'rows=' || answer;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
grant execute on function pg_temp.rows_of(text) to public;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: ehr.send_order_route refuses', pg_temp.try(format($s$select * from ehr.send_order_route(
  gen_random_uuid(), 'prescription', 'e1330006-0000-4000-8000-000000000001', %L, 'e1330008-0000-4000-8000-000000000001',
  2, 'e1330001-0000-4000-8000-000000000002', 'v1', 'own-work-route-probe', repeat('a', 64))$s$, pg_temp.rx(4))),
  '42501 ORDER_ROUTE_PERMISSION_DENIED');
select pg_temp.expect('PH: the own-pharmacy send refuses',
  pg_temp.send(pg_temp.rx(4), 2), '42501 OWN_PHARMACY_SEND_DENIED');
select pg_temp.expect('PH: the withdrawal refuses', pg_temp.try(format(
  'select ehr.withdraw_own_pharmacy_send(%L)', pg_temp.rx(4))), '42501 OWN_PHARMACY_SEND_DENIED');
-- (The list is the patient's own: a staff session is refused.)
select pg_temp.expect('PH: the patient''s own route list answers nothing for a staff session',
  pg_temp.rows_of('select * from ehr.patient_list_order_routes()'), '42501 PATIENT_SESSION_REQUIRED');
-- 0143: "Ordered by me" lists only orders this membership created; PH created none.
select pg_temp.expect('PH: my orders lists none of the hospital''s prescriptions', pg_temp.rows_of(
  'select * from ehr.list_my_orders(array[''prescription''], false, current_date - 30, null, null, null, 50) where order_id is not null'),
  'rows=0');
-- 0145: the unknown record's decision is the Identity runtime's alone.
select pg_temp.expect('PH: the unknown record''s decision is not the EHR runtime''s', pg_temp.try(format(
  'select * from identity.decide_unknown_patient(%L, %L, 1, %L, %L, %L)', pg_temp.rx(4), 'cancel',
  'Own work probe reason', 'own-work-unknown-probe', repeat('a', 64))),
  '42501 permission denied for function decide_unknown_patient');
-- 0144's acceptance trigger function (the tenth) runs only on an insert
-- into pharmacy.work_item_acceptances, which the EHR runtime may not make.
select pg_temp.expect('PH: the EHR runtime may not write a pharmacist acceptance',
  left(pg_temp.try(format($s$insert into pharmacy.work_item_acceptances (work_item_id, patient_id, facility_id,
      accepted_by, accepted_by_membership_id, accepted_with, idempotency_key, request_sha256, correlation_id)
    values (%L, 'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001',
      'e1330002-0000-4000-8000-000000000002', 'e1330004-0000-4000-8000-000000000002', 'accept',
      'own-work-acceptance-probe-1', repeat('c', 64), 'own-work-acceptance-probe')$s$,
    pg_temp.work_item_of(pg_temp.rx(7)))), 5), '42501');
reset role;
-- Through the Pharmacy runtime it reads a prescription only as the source of
-- the own item sent automatically that the acceptance names (one the session
-- may read, under an owner with neither superuser nor BYPASSRLS; see the
-- header): an acceptance naming a prescription (rx5, active, never sent, no
-- work item) or nothing is refused before any read, with the same answer.
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('PH: an acceptance naming rx5''s prescription instead of a work item, and one naming nothing, '
    || 'are refused before any read',
  (select string_agg(pg_temp.try(format($s$insert into pharmacy.work_item_acceptances (work_item_id, patient_id,
      facility_id, accepted_by, accepted_by_membership_id, accepted_with, idempotency_key, request_sha256,
      correlation_id)
    values (%L, 'e1330006-0000-4000-8000-000000000001', 'e1330001-0000-4000-8000-000000000001',
      'e1330002-0000-4000-8000-000000000002', 'e1330004-0000-4000-8000-000000000002', 'accept',
      'own-work-acceptance-probe-2', repeat('c', 64), 'own-work-acceptance-probe')$s$, named)), ' / ')
     from unnest(array[pg_temp.rx(5), gen_random_uuid()]) named),
  '23514 Pharmacist acceptance does not match its work item and actor context / '
  || '23514 Pharmacist acceptance does not match its work item and actor context');
reset role;

-- Fixtures of cases 10 and 11 (0133 D14 and D15), as replica: patient 4 Dayo
-- (an active account, so an order route can reach her; DR and PG hold write
-- grants for her at F1; she gets own pharmacy work at F1 below, never lab
-- work) and patient 5 Efe (no work anywhere; DR's and PG's grants at F1); an
-- outside pharmacy, organization O4 "Own Work Outside Pharmacy Ltd" (a
-- governed, approved pharmacy) with facility F4 and its pharmacist P4
-- (member 16, no grant); orders between facilities switched on (as the route
-- suites, control_settings readable by a non-superuser owner).
do $$
begin
  if not (select role_row.rolsuper or role_row.rolbypassrls from pg_proc proc
            join pg_roles role_row on role_row.oid = proc.proowner
           where proc.oid = 'platform.control_enabled(text)'::regprocedure) then
    alter table platform.control_settings no force row level security;
  end if;
end $$;
set local session_replication_role = replica;
update platform.control_settings set enabled = true
 where control_key in ('cross_facility_orders_enabled', 'cross_facility_route_access_enabled');
insert into identity.organizations (id, name, slug) values
  ('e1330000-0000-4000-8000-000000000004', 'Own Work Outside Pharmacy Ltd', 'own-work-outside-pharmacy');
insert into identity.facilities (id, organization_id, name, code, timezone, active, lifecycle_status) values
  ('e1330001-0000-4000-8000-000000000004', 'e1330000-0000-4000-8000-000000000004', 'Own Work Outside Pharmacy',
   'OWN-WORK-4', 'Africa/Lagos', true, 'verified');
insert into identity.organization_applications (id, product_code, organization_name, organization_type,
  cac_registration_number, administrator_name, administrator_email, status, verification_result, provider_reference,
  verified_at, organization_id, facility_id, reviewed_by_account_id, review_reason, reviewed_at,
  verified_organization_name, verified_entity_type, verified_registration_date, verified_address, verified_registry_status)
values ('e1330013-0000-4000-8000-000000000004', 'pharmacy', 'Own Work Outside Pharmacy Ltd', 'pharmacy', 'RC9913304',
  'Own Work Outside Admin', 'admin@own-work-outside.invalid', 'approved', 'verified', '913304', clock_timestamp(),
  'e1330000-0000-4000-8000-000000000004', 'e1330001-0000-4000-8000-000000000004', 'e1330002-0000-4000-8000-000000000005',
  'Governed approval for the own work suite', clock_timestamp(), 'Own Work Outside Pharmacy Ltd',
  'Private Company Limited by Shares', '2019-05-01', '4 Outside Road, Ikeja, Lagos', 'active');
insert into identity.organization_products (organization_id, product_code, facility_id, status, source_application_id)
values ('e1330000-0000-4000-8000-000000000004', 'pharmacy', 'e1330001-0000-4000-8000-000000000004', 'active',
  'e1330013-0000-4000-8000-000000000004');
insert into own_members values (16, 'p4', 'pharmacist', 4);
insert into auth.accounts (id, subject, email, display_name, status) values
  ('e1330002-0000-4000-8000-000000000016', 'synthetic:own-work-p4', 'own-work-p4@example.invalid', 'Own Work P4', 'active'),
  ('e1330015-0000-4000-8000-000000000004', 'synthetic:own-work-patient-dayo', 'own-work-dayo@example.invalid', 'Dayo Own',
   'active');
insert into identity.staff (id, account_id, full_name, email, verification_status, default_role) values
  ('e1330003-0000-4000-8000-000000000016', 'e1330002-0000-4000-8000-000000000016', 'Own Work P4',
   'own-work-p4@example.invalid', 'verified', 'pharmacist');
insert into identity.staff_facility_memberships (id, staff_id, account_id, organization_id, facility_id, membership_role,
  app_role, is_primary, active)
values ('e1330004-0000-4000-8000-000000000016', 'e1330003-0000-4000-8000-000000000016',
  'e1330002-0000-4000-8000-000000000016', 'e1330000-0000-4000-8000-000000000004', 'e1330001-0000-4000-8000-000000000004',
  'pharmacist', 'pharmacist', true, true);
insert into auth.account_roles (id, account_id, role_code, scope_type, membership_id, facility_id, grant_reason) values
  ('e1330005-0000-4000-8000-000000000016', 'e1330002-0000-4000-8000-000000000016', 'pharmacist', 'facility',
   'e1330004-0000-4000-8000-000000000016', 'e1330001-0000-4000-8000-000000000004', 'Own work suite role');
insert into identity.patients (id, account_id, hid_code, first_name, last_name, full_name, gender, dob, status) values
  ('e1330006-0000-4000-8000-000000000004', 'e1330015-0000-4000-8000-000000000004', 'HID-WRKDDD5', 'Dayo', 'Own',
   'Dayo Own', 'male', '1992-03-04', 'active'),
  ('e1330006-0000-4000-8000-000000000005', null, 'HID-WRKEEE6', 'Efe', 'Own', 'Efe Own', 'female', '1988-06-07', 'active');
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
select gen_random_uuid(), ('e1330006-0000-4000-8000-00000000000' || patient)::uuid,
       ('e1330003-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330002-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       ('e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'))::uuid,
       'e1330001-0000-4000-8000-000000000001', 'write_records', 'direct-care', 'active', 'Synthetic own work consent',
       clock_timestamp() - interval '1 hour', clock_timestamp() + interval '30 days'
  from (values (1, 4), (10, 4), (1, 5), (10, 5)) consent(member, patient);
set local session_replication_role = origin;
select set_config('own_work.attestation', (select text_row.version from ehr.order_route_attestation_texts text_row
  where text_row.kind = 'prescription' order by text_row.created_at desc, text_row.version desc limit 1), true);
-- Dayo's encounter E4 and Efe's E5 at F1, and DR's prescriptions, activated:
-- rx10-rx15 for Dayo, rx20 for Efe.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
insert into ehr.encounters (id, patient_id, facility_id, created_by, created_by_membership_id, encounter_type, status,
  started_at)
select ('e1330008-0000-4000-8000-00000000000' || n)::uuid, ('e1330006-0000-4000-8000-00000000000' || n)::uuid,
       'e1330001-0000-4000-8000-000000000001', 'e1330002-0000-4000-8000-000000000001',
       'e1330004-0000-4000-8000-000000000001', 'ambulatory', 'in_progress', clock_timestamp()
  from generate_series(4, 5) n;
select pg_temp.prescribe(n, patient, 1, 1)
  from (values (10, 4), (11, 4), (12, 4), (13, 4), (14, 4), (15, 4), (20, 5)) rx(n, patient);
select pg_temp.set_status(n, 'active', 'First activation (no reason needed)')
  from unnest(array[10, 11, 12, 13, 14, 15, 20]) n;
reset role;
-- D15's list as 'kind facility patient items' per kind, facility and
-- patient (the facility's and patient's last digit; each listed item: its
-- prescription, or the lab item's last 4 characters).
create function pg_temp.listed(filter text default null) returns text language sql security definer as $f$
  select coalesce(string_agg(format('%s F%s P%s %s', grouped.kind, right(grouped.facility_id::text, 1),
           right(grouped.patient_id::text, 1), grouped.items), ', '
           order by grouped.kind, grouped.facility_id, grouped.patient_id), 'none')
    from (select listed.kind, listed.facility_id, listed.patient_id,
                 string_agg(coalesce('rx' || ltrim(right(item.source_ehr_prescription_id::text, 2), '0'),
                              right(listed.work_item_id::text, 4)), ' '
                            order by coalesce(item.source_ehr_prescription_id, listed.work_item_id)) as items
            from identity.own_work_patients listed
            left join pharmacy.work_items item on listed.kind = 'pharmacy' and item.id = listed.work_item_id
           where filter is null or right(listed.patient_id::text, 1) = filter
           group by listed.kind, listed.facility_id, listed.patient_id) grouped
$f$;
-- Whether the list is exact both ways: every own item listed with its kind,
-- facility and patient, and every row founded on an own item of that kind
-- with that id, facility and patient; and every pharmacy work item claimed,
-- every claim an item's with its prescription, route and facility (D14).
create function pg_temp.exact() returns text language sql security definer as $f$
  select format('unlisted=%s unfounded=%s unclaimed=%s orphaned=%s',
    (select count(*) from (select 'lab' as kind, item.id, item.facility_id, item.patient_id from lab.work_items item
                            where item.order_route_id is null
                           union all
                           select 'pharmacy', item.id, item.facility_id, item.patient_id from pharmacy.work_items item
                            where item.order_route_id is null) own
      where not exists (select 1 from identity.own_work_patients listed where listed.kind = own.kind
                          and listed.facility_id = own.facility_id and listed.patient_id = own.patient_id
                          and listed.work_item_id = own.id)),
    (select count(*) from identity.own_work_patients listed
      where not exists (select 1 from lab.work_items item where listed.kind = 'lab' and item.id = listed.work_item_id
                          and item.order_route_id is null and item.facility_id = listed.facility_id
                          and item.patient_id = listed.patient_id)
        and not exists (select 1 from pharmacy.work_items item where listed.kind = 'pharmacy'
                          and item.id = listed.work_item_id and item.order_route_id is null
                          and item.facility_id = listed.facility_id and item.patient_id = listed.patient_id)),
    (select count(*) from pharmacy.work_items item
      where not exists (select 1 from pharmacy.prescription_item_claims claim where claim.work_item_id = item.id
                          and claim.prescription_id = item.source_ehr_prescription_id
                          and claim.order_route_id is not distinct from item.order_route_id
                          and claim.facility_id = item.facility_id
                          and (claim.dispensed_at is not null) = exists (select 1 from pharmacy.dispensings dispensing
                                                                          where dispensing.work_item_id = item.id))),
    (select count(*) from pharmacy.prescription_item_claims claim
      where not exists (select 1 from pharmacy.work_items item where item.id = claim.work_item_id)))
$f$;
-- A prescription's claims, owner SQL: 'own|routed:live|released|dispensed', in id order of kind.
create function pg_temp.claims(n integer) returns text language sql security definer as $f$
  select coalesce(string_agg(case when claim.order_route_id is null then 'own' else 'routed' end || ':'
           || case when claim.released_at is not null then 'released'
                   when claim.dispensed_at is not null then 'dispensed' else 'live' end, ' '
           order by claim.order_route_id is not null), 'none')
    from pharmacy.prescription_item_claims claim where claim.prescription_id = pg_temp.rx(n)
$f$;
-- The outcome with the error's DETAIL: 'ok', or 'SQLSTATE message / detail'.
create function pg_temp.try_detail(statement text) returns text language plpgsql as $f$
declare failure_detail text;
begin
  execute statement;
  return 'ok';
exception when others then
  get stacked diagnostics failure_detail = pg_exception_detail;
  return sqlstate || ' ' || sqlerrm || ' / ' || coalesce(nullif(failure_detail, ''), '-');
end
$f$;
-- DR's order-route send of prescription n to F4's pharmacy, as ehr-api calls
-- it, with the switch (the new ehr-api) or without (today's): 'sent' (the
-- route kept as own_work.route_<n>), or 'SQLSTATE message'.
create function pg_temp.route_send(n integer, switched boolean default true) returns text language plpgsql as $f$
declare
  source ehr.prescriptions%rowtype;
  sent record;
  key text := 'own-work-route-' || replace(gen_random_uuid()::text, '-', '');
begin
  perform pg_temp.as_member(1, switched => switched);
  select prescription.* into source from ehr.prescriptions prescription where prescription.id = pg_temp.rx(n);
  select * into sent from ehr.send_order_route(gen_random_uuid(), 'prescription', source.patient_id, source.id,
    source.encounter_id, source.row_version, 'e1330001-0000-4000-8000-000000000004',
    current_setting('own_work.attestation'), key, encode(sha256(key::bytea), 'hex'));
  perform set_config('own_work.route_' || n, sent.route_id::text, true);
  return 'sent';
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
-- P4's acceptance of prescription n's route at F4 (pharmacy-api's call): the
-- answer, and the route-backed item kept as own_work.routed_<n>.
create function pg_temp.route_accept(n integer) returns text language plpgsql as $f$
declare accepted record;
begin
  perform pg_temp.as_member(16);
  select * into accepted from pharmacy.accept_order_route(current_setting('own_work.route_' || n)::uuid,
    (select route.row_version from pg_temp.route_row(n) route), 'health_id', 'HID-WRKDDD5',
    'Patient collected the prescription', 'own-work-route-accept-' || n || '-' || substr(md5(random()::text), 1, 8),
    repeat('a', 64));
  perform set_config('own_work.routed_' || n, coalesce(accepted.work_item_id::text, ''), true);
  return accepted.result;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end
$f$;
create function pg_temp.route_row(n integer) returns setof ehr.order_routes language sql security definer as $f$
  select * from ehr.order_routes where id = nullif(current_setting('own_work.route_' || n, true), '')::uuid
$f$;
-- ehr.order_route_resend_allowed (the owner's; its definer callers run it in
-- the EHR runtime's session) for prescription n, with or without the switch.
create function pg_temp.resend(n integer, switched boolean) returns text language plpgsql as $f$
begin
  perform set_config('app.own_facility_work', case when switched then '0133' else '' end, true);
  return ehr.order_route_resend_allowed('prescription', pg_temp.rx(n))::text;
end
$f$;
do $$
declare proc record;
begin
  for proc in select p.oid::regprocedure as signature from pg_proc p where p.pronamespace = pg_my_temp_schema() loop
    execute format('grant execute on function %s to public', proc.signature);
  end loop;
end $$;

-- 10. D15, the own-work list (owner's Q122 A). The fixtures so far list each
-- patient with own work, at its facility and for its kind, with each own
-- item: Ada's lab work at F1 (W1, W4) and at F2 (W2), inserted as replica
-- (the trigger fires always); Ada's, Bisi's and Chike's pharmacy work at F1
-- (rx1-rx4 and rx6, rx7, rx8, sent by D7); never a route-backed item (R1,
-- RP) and nothing undone (case 2c's rx9, case 7g's copies). The list is
-- exact.
select pg_temp.expect('10 the list after the fixtures', pg_temp.listed(),
  'lab F1 P1 0001 0004, lab F2 P1 0002, pharmacy F1 P1 rx1 rx2 rx3 rx4 rx6, pharmacy F1 P2 rx7, pharmacy F1 P3 rx8');
select pg_temp.expect('10 exact both ways', pg_temp.exact(), 'unlisted=0 unfounded=0 unclaimed=0 orphaned=0');
-- DR sends Dayo's rx10 to F1's pharmacy: Dayo listed with rx10's item; a
-- second send adds nothing. Efe's rx20: a failed send (pending) and PH's
-- refused acceptance (no grant) list nobody; PG's acceptance (a grant) lists
-- her, undone.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('10 rx10 is sent', pg_temp.send(pg_temp.rx(10), 2), 'sent:item');
select pg_temp.expect('10 a second send of rx10', pg_temp.send(pg_temp.rx(10), 2), 'already_in_pharmacy:item');
select pg_temp.as_member(1, correlation => 'short');
select pg_temp.expect('10 a failed send of Efe''s rx20 is pending', pg_temp.send(pg_temp.rx(20), 2), 'pending');
reset role;
select pg_temp.expect('10 Dayo listed with rx10''s item; Efe not listed', pg_temp.listed('4') || '; ' || pg_temp.listed('5'),
  'pharmacy F1 P4 rx10; none');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('10 PH (no grant for Efe) cannot accept rx20',
  (pg_temp.try(pg_temp.accept_sql(20, 2)) ~ '^(42501|23514) ')::text, 'true');
reset role;
select pg_temp.expect('10 Efe still not listed', pg_temp.listed('5'), 'none');
savepoint own_work_list_accept;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(10);
select pg_temp.expect('10 PG (a grant for Efe) accepts rx20', pg_temp.try(pg_temp.accept_sql(20, 10)), 'ok');
reset role;
select pg_temp.expect('10 PG''s acceptance lists Efe', pg_temp.listed('5'), 'pharmacy F1 P5 rx20');
rollback to savepoint own_work_list_accept;
-- The row's halves called on their own (D11): each answers only for a patient
-- on the list for its kind at the row's facility; LS (the lab runtime) for
-- lab work, PH, RC and NU for their own memberships; L2 at F2.
create function pg_temp.row_half(kind text, member integer, patient integer, site integer default null) returns text
language plpgsql as $f$
declare answer boolean;
begin
  perform pg_temp.as_member(member, site);
  execute format('select identity.%I(%L, %L, %L, ''read_records'')', kind || '_work_patient_allows',
    'e1330004-0000-4000-8000-0000000000' || lpad(member::text, 2, '0'), 'e1330006-0000-4000-8000-00000000000' || patient,
    current_setting('app.facility_id'))
    into answer;
  return case when answer then 't' else 'f' end;
exception when others then
  return sqlstate;
end $f$;
grant execute on function pg_temp.row_half(text, integer, integer, integer) to public;
set local role hid_lab_api_runtime;
select pg_temp.expect('10 the lab row''s half: LS Ada t, LS Dayo f, LS Efe f, RC Dayo f, RC Efe f, NU Efe f, L2 at F2 Ada t, L2 Dayo f',
  concat_ws(' ', pg_temp.row_half('lab', 3, 1), pg_temp.row_half('lab', 3, 4), pg_temp.row_half('lab', 3, 5),
    pg_temp.row_half('lab', 7, 4), pg_temp.row_half('lab', 7, 5), pg_temp.row_half('lab', 4, 5),
    pg_temp.row_half('lab', 11, 1), pg_temp.row_half('lab', 11, 4)), 't f f f f f t f');
select pg_temp.expect('10 the Lab runtime may not call the pharmacy row''s half (42501), for LS or RC',
  pg_temp.row_half('pharmacy', 3, 4) || ' ' || pg_temp.row_half('pharmacy', 7, 4), '42501 42501');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('10 the pharmacy row''s half: PH Dayo t, PH Ada t, PH Efe f, RC Dayo t, RC Efe f, P2 at F2 Ada f',
  concat_ws(' ', pg_temp.row_half('pharmacy', 2, 4), pg_temp.row_half('pharmacy', 2, 1), pg_temp.row_half('pharmacy', 2, 5),
    pg_temp.row_half('pharmacy', 7, 4), pg_temp.row_half('pharmacy', 7, 5), pg_temp.row_half('pharmacy', 6, 1)),
  't t f t f f');
select pg_temp.expect('10 the Pharmacy runtime may not call the lab row''s half (42501), for PH or RC',
  pg_temp.row_half('lab', 2, 1) || ' ' || pg_temp.row_half('lab', 7, 1), '42501 42501');
-- Neither runtime reads or writes the list or the claims.
select pg_temp.expect('10 the Pharmacy runtime reads and writes neither the list nor the claims',
  concat_ws(' ', left(pg_temp.try('select count(*) from identity.own_work_patients'), 5),
    left(pg_temp.try($i$insert into identity.own_work_patients (kind, facility_id, patient_id, work_item_id)
      values ('pharmacy', 'e1330001-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000005',
      gen_random_uuid())$i$), 5),
    left(pg_temp.try('select count(*) from pharmacy.prescription_item_claims'), 5),
    left(pg_temp.try($u$update pharmacy.prescription_item_claims set released_at = null$u$), 5)),
  '42501 42501 42501 42501');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('10 the Lab runtime reads and writes neither the list nor the claims',
  concat_ws(' ', left(pg_temp.try('select count(*) from identity.own_work_patients'), 5),
    left(pg_temp.try($i$insert into identity.own_work_patients (kind, facility_id, patient_id, work_item_id)
      values ('lab', 'e1330001-0000-4000-8000-000000000001', 'e1330006-0000-4000-8000-000000000005',
      gen_random_uuid())$i$), 5),
    left(pg_temp.try('select count(*) from pharmacy.prescription_item_claims'), 5)),
  '42501 42501 42501');
reset role;
-- An UPDATE: an ordinary session's is refused by the work items' own trigger
-- before the list's (nothing listed); a replica-mode change of an own item's
-- patient (a superuser's repair) lists the new pair and keeps the old one.
-- Undone.
savepoint own_work_list_update;
select pg_temp.expect('10 an ordinary UPDATE of an own lab item is refused',
  left(pg_temp.try($u$update lab.work_items set patient_id = 'e1330006-0000-4000-8000-000000000005'
    where id = 'e133000a-0000-4000-8000-000000000004'$u$), 5), '55000');
select pg_temp.expect('10 the list unchanged', pg_temp.listed('5'), 'none');
set local session_replication_role = replica;
update lab.work_items set patient_id = 'e1330006-0000-4000-8000-000000000005'
 where id = 'e133000a-0000-4000-8000-000000000004';
set local session_replication_role = origin;
select pg_temp.expect('10 a replica-mode UPDATE lists the new pair and keeps the old',
  pg_temp.listed('5') || '; ' || pg_temp.listed('1'),
  'lab F1 P5 0004; lab F1 P1 0001 0004, lab F2 P1 0002, pharmacy F1 P1 rx1 rx2 rx3 rx4 rx6');
rollback to savepoint own_work_list_update;
-- D14's claim key (0133 D14): a replica-mode change of what a claim was made
-- from (a superuser's repair) is refused: an own item's prescription (to
-- Efe's rx20, which has no item, so the key on the prescription would let
-- it through), route, facility or id, and a dispensing's work item (rx1's
-- dispensing re-pointed to rx10's item, sent elsewhere: its claim released
-- here as the send releases it). In origin mode 0023's trigger still answers
-- first. A SET that leaves them as they are, and a repair of the item's
-- patient (D15 lists the new pair), go through. The claims stay exact.
-- Undone.
savepoint own_work_claim_key;
update pharmacy.prescription_item_claims set released_at = clock_timestamp(), released_by_route_id = gen_random_uuid()
 where work_item_id = pg_temp.work_item_of(pg_temp.rx(10));
select pg_temp.expect('10 origin mode: 0023''s trigger answers a dispensing''s re-pointing first',
  pg_temp.try(format($u$update pharmacy.dispensings set work_item_id = %L where work_item_id = %L$u$,
    pg_temp.work_item_of(pg_temp.rx(10)), pg_temp.work_item_of(pg_temp.rx(1)))),
  '55000 Pharmacy clinical operational evidence is append-only');
set local session_replication_role = replica;
select pg_temp.expect('10 replica: an own item''s prescription, route, facility and id cannot change',
  concat_ws(' | ',
    pg_temp.try_detail(format($u$update pharmacy.work_items set source_ehr_prescription_id = %L where id = %L$u$,
      pg_temp.rx(20), pg_temp.work_item_of(pg_temp.rx(10)))),
    pg_temp.try(format($u$update pharmacy.work_items set order_route_id = gen_random_uuid() where id = %L$u$,
      pg_temp.work_item_of(pg_temp.rx(1)))),
    pg_temp.try(format($u$update pharmacy.work_items set facility_id = 'e1330001-0000-4000-8000-000000000002'
      where id = %L$u$, pg_temp.work_item_of(pg_temp.rx(1)))),
    pg_temp.try(format($u$update pharmacy.work_items set id = gen_random_uuid() where id = %L$u$,
      pg_temp.work_item_of(pg_temp.rx(1))))),
  '55000 PRESCRIPTION_CLAIM_KEY_IMMUTABLE / pharmacy.work_items | 55000 PRESCRIPTION_CLAIM_KEY_IMMUTABLE | '
    || '55000 PRESCRIPTION_CLAIM_KEY_IMMUTABLE | 55000 PRESCRIPTION_CLAIM_KEY_IMMUTABLE');
select pg_temp.expect('10 replica: a dispensing cannot be re-pointed to an item sent elsewhere',
  pg_temp.try_detail(format($u$update pharmacy.dispensings set work_item_id = %L where work_item_id = %L$u$,
    pg_temp.work_item_of(pg_temp.rx(10)), pg_temp.work_item_of(pg_temp.rx(1)))),
  '55000 PRESCRIPTION_CLAIM_KEY_IMMUTABLE / pharmacy.dispensings');
select pg_temp.expect('10 replica: a SET that leaves the key as it is goes through',
  pg_temp.try(format($u$update pharmacy.work_items set source_ehr_prescription_id = source_ehr_prescription_id,
    order_route_id = order_route_id, facility_id = facility_id, id = id where id = %L$u$,
    pg_temp.work_item_of(pg_temp.rx(1)))) || ' '
  || pg_temp.try(format($u$update pharmacy.dispensings set work_item_id = work_item_id where work_item_id = %L$u$,
    pg_temp.work_item_of(pg_temp.rx(1)))), 'ok ok');
select pg_temp.expect('10 the claims stay exact: rx10 released, rx1 dispensed, rx20 none; one dispensing of rx1',
  concat_ws(' ', pg_temp.exact(), pg_temp.claims(10), pg_temp.claims(1), pg_temp.claims(20),
    (select count(*) from pharmacy.dispensings dispensing
      where dispensing.work_item_id = pg_temp.work_item_of(pg_temp.rx(1))),
    (select count(*) from pharmacy.dispensings dispensing
      where dispensing.work_item_id = pg_temp.work_item_of(pg_temp.rx(10)))),
  'unlisted=0 unfounded=0 unclaimed=0 orphaned=0 own:released own:dispensed none 1 0');
select pg_temp.expect('10 replica: a repair of an own pharmacy item''s patient goes through and lists the new pair',
  pg_temp.try(format($u$update pharmacy.work_items set patient_id = 'e1330006-0000-4000-8000-000000000005'
    where id = %L$u$, pg_temp.work_item_of(pg_temp.rx(10)))) || ' ' || pg_temp.listed('5'),
  'ok pharmacy F1 P5 rx10');
set local session_replication_role = origin;
rollback to savepoint own_work_claim_key;

-- 11. D14, sending to an outside pharmacy before this pharmacy has dispensed
-- (owner's Q121 A). Dayo's rx10 is in F1's pharmacy (case 10).
-- 11a. Today's ehr-api (no app.own_facility_work): 0123's and 0086's rule,
-- unchanged: the send is ORDER_ROUTE_ORDER_IN_WORK, the resend flag false,
-- nothing released.
set local role hid_ehr_api_runtime;
select pg_temp.expect('11a today''s ehr-api: rx10 (in F1''s pharmacy) cannot be sent elsewhere',
  pg_temp.route_send(10, switched => false), 'P0001 ORDER_ROUTE_ORDER_IN_WORK');
reset role;
select pg_temp.expect('11a today''s ehr-api: resend false; rx10''s claim live',
  pg_temp.resend(10, false) || ' ' || pg_temp.claims(10), 'false own:live');
-- 11b. The new ehr-api (the switch): the undispensed own item is withdrawn
-- (sent elsewhere) with the route, in one transaction.
select pg_temp.expect('11b the new ehr-api: resend true while the own item is undispensed', pg_temp.resend(10, true),
  'true');
set local role hid_ehr_api_runtime;
select pg_temp.expect('11b the new ehr-api: rx10 is sent to F4', pg_temp.route_send(10), 'sent');
select pg_temp.expect('11b D7 answers routed while the route is live', pg_temp.send(pg_temp.rx(10), 2), 'routed');
reset role;
select pg_temp.expect('11b rx10''s own claim released by the route, at its creation; the route at rx10''s version',
  (select format('%s %s %s %s', pg_temp.claims(10), claim.released_by_route_id = route.id,
     claim.released_at = route.created_at, route.source_order_version = prescription.row_version)
     from pharmacy.prescription_item_claims claim, pg_temp.route_row(10) route, ehr.prescriptions prescription
    where claim.work_item_id = pg_temp.work_item_of(pg_temp.rx(10)) and prescription.id = pg_temp.rx(10)),
  'own:released t t t');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('11b PH: rx10 reads withdrawn, sent elsewhere (D10)',
  (select string_agg(state.basis || '/' || state.withdrawn || '/' || state.withdrawn_reason, ',')
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(10))]) state), 'own-work/true/sent_elsewhere');
select pg_temp.expect('11b PH: the withdrawn items reader lists rx10 (sent_elsewhere) and the changed rx3, rx6',
  (select string_agg(coalesce('rx' || ltrim(right(w.source_ehr_prescription_id::text, 2), '0'), '?') || ':'
     || withdrawn.withdrawn_reason, ' ' order by w.source_ehr_prescription_id)
     from pharmacy.own_withdrawn_work_items() withdrawn join pharmacy.work_items w on w.id = withdrawn.work_item_id),
  'rx3:changed rx6:changed rx10:sent_elsewhere');
select pg_temp.expect('11b PH dispensing rx10 (with the switch): refused, sent elsewhere',
  pg_temp.try_detail(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(10)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / sent_elsewhere');
select pg_temp.as_member(2, switched => false);
select pg_temp.expect('11b PH dispensing rx10 as today''s pharmacy-api (no grant): refused',
  (pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(10)), 2)) ~ '^(42501|23514) ')::text, 'true');
select pg_temp.as_member(10, switched => false);
select pg_temp.expect('11b PG (a grant for Dayo) dispensing rx10 as today''s pharmacy-api: refused, sent elsewhere',
  pg_temp.try_detail(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(10)), 10)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / sent_elsewhere');
select pg_temp.as_member(10);
select pg_temp.expect('11b PG with the switch: refused, sent elsewhere',
  pg_temp.try_detail(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(10)), 10)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / sent_elsewhere');
select pg_temp.as_member(3);
select pg_temp.expect('11b a member without pharmacy.work-item.read (LS) gets nothing from the reader',
  (select count(*)::text from pharmacy.own_withdrawn_work_items()), '0');
select pg_temp.as_member(4);
select pg_temp.expect('11b the nurse, who holds pharmacy.work-item.read at F1, gets the same ids and reasons (no patient: '
    || 'the reader answers only the two columns)',
  (select count(*)::text from pharmacy.own_withdrawn_work_items()) || ' '
  || pg_get_function_result('pharmacy.own_withdrawn_work_items()'::regprocedure),
  '3 TABLE(work_item_id uuid, withdrawn_reason text)');
select pg_temp.as_member(6, 1);
select pg_temp.expect('11b P2 (F2''s membership) claiming F1 gets nothing',
  (select count(*)::text from pharmacy.own_withdrawn_work_items()), '0');
reset role;
set local role hid_lab_api_runtime;
select pg_temp.as_member(3);
select pg_temp.expect('11b the Lab runtime may not call the reader',
  left(pg_temp.try('select count(*) from pharmacy.own_withdrawn_work_items()'), 5), '42501');
reset role;
-- P4 accepts at F4: two items for rx10, one live; F4 dispenses its own.
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('11b P4 accepts rx10''s route at F4', pg_temp.route_accept(10), 'accepted');
select pg_temp.as_member(16);
select pg_temp.expect('11b P4 dispenses the route-backed item',
  pg_temp.try(pg_temp.dispense_sql(current_setting('own_work.routed_10')::uuid, 16)), 'ok');
reset role;
select pg_temp.expect('11b rx10: two items (own released, routed dispensed), one dispensing; F1''s listing kept, '
    || 'no F4 listing (a route-backed item)',
  format('%s; items=%s dispensings=%s; %s', pg_temp.claims(10),
    (select count(*) from pharmacy.work_items item where item.source_ehr_prescription_id = pg_temp.rx(10)),
    (select count(*) from pharmacy.dispensings dispensing join pharmacy.work_items item on item.id = dispensing.work_item_id
      where item.source_ehr_prescription_id = pg_temp.rx(10)), pg_temp.listed('4')),
  'own:released routed:dispensed; items=2 dispensings=1; pharmacy F1 P4 rx10');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('11b D7 answers routed once accepted elsewhere', pg_temp.send(pg_temp.rx(10), 2), 'routed');
select pg_temp.expect('11b a send to F4 again: already sent', pg_temp.route_send(10), 'P0001 ORDER_ROUTE_ALREADY_SENT');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(10);
select pg_temp.expect('11b an own acceptance of rx10 while its route is accepted: refused (0100)',
  pg_temp.try(pg_temp.accept_sql(10, 10)), '23514 PRESCRIPTION_ROUTED');
-- 11g. On this cluster the definer functions bypass row-level security (a
-- superuser owner): D10 and the reader still answer F1's own item only.
select pg_temp.as_member(2);
select pg_temp.expect('11g PH: D10 for both of rx10''s items answers the own one only, and the reader lists no F4 item',
  (select count(*) || '/' || bool_and(state.work_item_id = pg_temp.work_item_of(pg_temp.rx(10)))
     from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(10)),
       current_setting('own_work.routed_10')::uuid]) state) || ' '
  || (select count(*) from pharmacy.own_withdrawn_work_items() withdrawn
       where withdrawn.work_item_id = current_setting('own_work.routed_10')::uuid), '1/true 0');
select pg_temp.as_member(16);
select pg_temp.expect('11g P4 at F4: no own-work state and no withdrawn item',
  (select count(*) from pharmacy.own_work_item_states(array[current_setting('own_work.routed_10')::uuid])) || '/'
  || (select count(*) from pharmacy.own_withdrawn_work_items()), '0/0');
reset role;
-- With a grant: P4 holds no own-work membership and no grant above, so D10
-- would drop the item anyway. Given a consent grant for Dayo at F4, where the
-- route-backed item is, P4 still gets no state for it: a route-backed item is
-- never an own work item (D10's order_route_id filter decides here; without
-- it the grant would answer 'consent'). Undone, so P4 keeps no grant.
savepoint own_work_routed_grant;
set local session_replication_role = replica;
insert into identity.consent_grants (id, patient_id, staff_id, account_id, membership_id, facility_id, scope,
  purpose_of_use, status, reason, starts_at, expires_at)
values (gen_random_uuid(), 'e1330006-0000-4000-8000-000000000004', 'e1330003-0000-4000-8000-000000000016',
  'e1330002-0000-4000-8000-000000000016', 'e1330004-0000-4000-8000-000000000016', 'e1330001-0000-4000-8000-000000000004',
  'write_records', 'direct-care', 'active', 'Synthetic own work consent', clock_timestamp() - interval '1 hour',
  clock_timestamp() + interval '30 days');
set local session_replication_role = origin;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(16);
select pg_temp.expect('11g P4 with a grant for Dayo at F4: the grant holds, yet no state and no withdrawn row for the '
    || 'route-backed item',
  identity.has_active_consent_grant('e1330006-0000-4000-8000-000000000004'::uuid, 'synthetic:own-work-p4',
    'e1330004-0000-4000-8000-000000000016'::uuid, 'e1330001-0000-4000-8000-000000000004'::uuid, 'read_records',
    'direct-care')::text || ' '
  || (select count(*) from pharmacy.own_work_item_states(array[current_setting('own_work.routed_10')::uuid])) || '/'
  || (select count(*) from pharmacy.own_withdrawn_work_items()), 'true 0/0');
reset role;
rollback to savepoint own_work_routed_grant;
-- A later hold: D8's trigger records it, but the withdrawal answers false
-- (this pharmacy no longer holds the item), and D10 still says sent_elsewhere.
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.set_status(10, 'on_hold', 'Held by the prescriber');
select pg_temp.expect('11b after a later hold the withdrawal answers false', ehr.withdraw_own_pharmacy_send(pg_temp.rx(10))::text,
  'false');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('11b PH: still sent elsewhere, not changed, after the hold',
  (select string_agg(state.withdrawn_reason, ',') from pharmacy.own_work_item_states(array[pg_temp.work_item_of(pg_temp.rx(10))]) state)
  || ' ' || (select string_agg(withdrawn.withdrawn_reason, ',') from pharmacy.own_withdrawn_work_items() withdrawn
       where withdrawn.work_item_id = pg_temp.work_item_of(pg_temp.rx(10))), 'sent_elsewhere sent_elsewhere');
reset role;
-- 11c. After an own dispensing, and after its reversal: in work, nothing
-- released (rx11, sent and dispensed at F1).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('11c rx11 is sent', pg_temp.send(pg_temp.rx(11), 2), 'sent:item');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('11c PH dispenses rx11', pg_temp.try(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(11)), 2)),
  'ok');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.expect('11c the new ehr-api: the dispensed rx11 is in work', pg_temp.route_send(11),
  'P0001 ORDER_ROUTE_ORDER_IN_WORK');
reset role;
select pg_temp.expect('11c resend false either way; the claim dispensed, nothing released',
  pg_temp.resend(11, true) || ' ' || pg_temp.resend(11, false) || ' ' || pg_temp.claims(11), 'false false own:dispensed');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('11c PH reverses the dispensing of rx11',
  (select pg_temp.changed(format($i$insert into pharmacy.dispensing_reversals (
        id,dispensing_id,dispensing_version,work_item_id,patient_id,facility_id,reversed_by,
        reversed_by_membership_id,reason,idempotency_key,request_sha256,correlation_id
      ) values (%L,%L,1,%L,%L,%L,'e1330002-0000-4000-8000-000000000002','e1330004-0000-4000-8000-000000000002',
        'Dispensed to the wrong patient','own-work-reverse-0011',repeat('e',64),current_setting('app.correlation_id'))
      returning id$i$, gen_random_uuid(), d.id, d.work_item_id, d.patient_id, d.facility_id))
     from pharmacy.dispensings d where d.work_item_id = pg_temp.work_item_of(pg_temp.rx(11))), 'rows=1');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.expect('11c after the reversal: still in work', pg_temp.route_send(11), 'P0001 ORDER_ROUTE_ORDER_IN_WORK');
reset role;
select pg_temp.expect('11c the claim still dispensed', pg_temp.claims(11), 'own:dispensed');
-- 11d. A route accepted, then ended (F4 cannot complete it): rx12, never in
-- F1's pharmacy. D7 answers routed, an own acceptance is refused (the routed
-- item's claim stays live), the resend flag is false.
set local role hid_ehr_api_runtime;
select pg_temp.expect('11d rx12 is sent to F4', pg_temp.route_send(12), 'sent');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('11d P4 accepts it', pg_temp.route_accept(12), 'accepted');
select pg_temp.as_member(16);
select pg_temp.expect('11d P4 cannot complete it', (select ended.result from pharmacy.cannot_complete_order_route(
    current_setting('own_work.route_12')::uuid, (select route.row_version from pg_temp.route_row(12) route), 'out_of_stock',
    'own-work-unable-0012-' || substr(md5(random()::text), 1, 8), repeat('b', 64)) ended), 'ended');
reset role;
select pg_temp.expect('11d the route ended', (select route.state || '/' || route.ended_kind from pg_temp.route_row(12) route),
  'cancelled/receiving_unable');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('11d D7 answers routed after the route ended', pg_temp.send(pg_temp.rx(12), 2), 'routed');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(10);
select pg_temp.expect('11d an own acceptance of rx12 is refused', left(pg_temp.try(pg_temp.accept_sql(12, 10)), 5), '23505');
reset role;
select pg_temp.expect('11d resend false with the switch and without; one live routed claim',
  pg_temp.resend(12, true) || ' ' || pg_temp.resend(12, false) || ' ' || pg_temp.claims(12), 'false false routed:live');
-- 11e. Sent elsewhere, then declined (rx13, in F1's pharmacy): with the
-- switch the resend flag is true and a second send elsewhere succeeds (the
-- own claim is already released); without it, both as 0086 and 0123; D7
-- answers routed (the own item never comes back).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('11e rx13 is sent to F1''s pharmacy', pg_temp.send(pg_temp.rx(13), 2), 'sent:item');
select pg_temp.expect('11e and then to F4', pg_temp.route_send(13), 'sent');
select set_config('own_work.first_route_13', current_setting('own_work.route_13'), true);
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(16);
select pg_temp.expect('11e P4 declines it', (select declined.state from pharmacy.decline_order_route(
  current_setting('own_work.route_13')::uuid, 1, 'medicine_unavailable') declined), 'declined');
reset role;
select pg_temp.expect('11e after the decline: resend true with the switch, false without; the own claim released',
  pg_temp.resend(13, true) || ' ' || pg_temp.resend(13, false) || ' ' || pg_temp.claims(13), 'true false own:released');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('11e the route summary (the new ehr-api) offers a resend',
  (select summary.summary ->> 'resendAllowed' from ehr.order_route_summaries('prescription',
     'e1330006-0000-4000-8000-000000000004', array[pg_temp.rx(13)]) summary), 'true');
select pg_temp.as_member(1, switched => false);
select pg_temp.expect('11e the route summary (today''s ehr-api) does not',
  (select summary.summary ->> 'resendAllowed' from ehr.order_route_summaries('prescription',
     'e1330006-0000-4000-8000-000000000004', array[pg_temp.rx(13)]) summary), 'false');
select pg_temp.as_member(1);
select pg_temp.expect('11e D7 answers routed after the decline', pg_temp.send(pg_temp.rx(13), 2), 'routed');
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(10);
select pg_temp.expect('11e an own acceptance after the decline is refused: the own item never comes back',
  pg_temp.try(pg_temp.accept_sql(13, 10)), '23505 duplicate key value violates unique constraint "work_items_prescription_kind_uq"');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.expect('11e today''s ehr-api: no second send', pg_temp.route_send(13, switched => false),
  'P0001 ORDER_ROUTE_ORDER_IN_WORK');
select pg_temp.expect('11e the new ehr-api: a second send elsewhere', pg_temp.route_send(13), 'sent');
reset role;
select pg_temp.expect('11e two routes, the second live; the own claim released by the first',
  (select string_agg(route.state, ' ' order by route.created_at, route.id) from ehr.order_routes route
    where route.source_prescription_id = pg_temp.rx(13)) || ' / '
  || (select (claim.released_by_route_id = current_setting('own_work.first_route_13')::uuid)::text
        from pharmacy.prescription_item_claims claim where claim.prescription_id = pg_temp.rx(13)),
  'declined sent / true');
-- 11f. The claims trigger refuses on its own (owner SQL, each undone): a
-- dispensing whose item has no claim (not_claimed); a dispensed claim cannot
-- be released (its CHECK); replica-mode inserts (the ALWAYS triggers fire)
-- of an own item, then a route-backed one, of one prescription
-- (prescription_item_claims_live_uq), and a second item of either kind
-- (work_items_prescription_kind_uq).
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select pg_temp.expect('11f rx14 is sent', pg_temp.send(pg_temp.rx(14), 2), 'sent:item');
reset role;
savepoint own_work_claims;
delete from pharmacy.prescription_item_claims where work_item_id = pg_temp.work_item_of(pg_temp.rx(14));
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('11f no claim: the dispensing is refused, not claimed',
  pg_temp.try_detail(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(14)), 2)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / not_claimed');
reset role;
rollback to savepoint own_work_claims;
select pg_temp.expect('11f a dispensed claim cannot be released',
  left(pg_temp.try(format($u$update pharmacy.prescription_item_claims set released_at = clock_timestamp(),
    released_by_route_id = gen_random_uuid() where work_item_id = %L$u$, pg_temp.work_item_of(pg_temp.rx(1)))), 5), '23514');
savepoint own_work_claims;
set local session_replication_role = replica;
create temporary table own_work_copies on commit drop as
  select (jsonb_populate_record(null::pharmacy.work_items, to_jsonb(item) || jsonb_build_object('id', copy.id,
           'source_ehr_prescription_id', 'e133ffff-0000-4000-8000-0000000000aa', 'idempotency_key', 'own-work-copy-' || copy.tag,
           'order_route_id', copy.route, 'facility_id', coalesce(copy.site, item.facility_id)))).*
    from (values ('e133000d-0000-4000-8000-0000000000a1'::uuid, 'own-0001', null::uuid, null::uuid),
                 ('e133000d-0000-4000-8000-0000000000a2'::uuid, 'routed-0002', gen_random_uuid(),
                  'e1330001-0000-4000-8000-000000000004'::uuid),
                 ('e133000d-0000-4000-8000-0000000000a3'::uuid, 'own-0003', null::uuid, null::uuid))
           as copy(id, tag, route, site)
    join pharmacy.work_items item on item.id = pg_temp.work_item_of(pg_temp.rx(4));
select pg_temp.expect('11f replica: an own item claims the prescription',
  pg_temp.try($i$insert into pharmacy.work_items select * from own_work_copies where id = 'e133000d-0000-4000-8000-0000000000a1'$i$),
  'ok');
select pg_temp.expect('11f replica: a route-backed item while the own claim is live: the live claim refuses it',
  pg_temp.try($i$insert into pharmacy.work_items select * from own_work_copies where id = 'e133000d-0000-4000-8000-0000000000a2'$i$),
  '23505 duplicate key value violates unique constraint "prescription_item_claims_live_uq"');
select pg_temp.expect('11f replica: a second own item: the key refuses it',
  pg_temp.try($i$insert into pharmacy.work_items select * from own_work_copies where id = 'e133000d-0000-4000-8000-0000000000a3'$i$),
  '23505 duplicate key value violates unique constraint "work_items_prescription_kind_uq"');
update pharmacy.prescription_item_claims set released_at = clock_timestamp(), released_by_route_id = gen_random_uuid()
 where work_item_id = 'e133000d-0000-4000-8000-0000000000a1';
select pg_temp.expect('11f replica: once the own claim is released, the route-backed item is accepted',
  pg_temp.try($i$insert into pharmacy.work_items select * from own_work_copies where id = 'e133000d-0000-4000-8000-0000000000a2'$i$),
  'ok');
select pg_temp.expect('11f replica: a second route-backed item: the key refuses it',
  pg_temp.try($i$insert into pharmacy.work_items select (jsonb_populate_record(null::pharmacy.work_items, to_jsonb(copy)
    || jsonb_build_object('id', gen_random_uuid(), 'order_route_id', gen_random_uuid(),
       'idempotency_key', 'own-work-copy-routed-0004'))).* from own_work_copies copy
    where copy.id = 'e133000d-0000-4000-8000-0000000000a2'$i$),
  '23505 duplicate key value violates unique constraint "work_items_prescription_kind_uq"');
set local session_replication_role = origin;
rollback to savepoint own_work_claims;

-- 9. The undo order (0133's header). With the withdrawal trigger left in
-- place, dropping the sends table succeeds (plpgsql records no dependency)
-- and every later change of a prescription's status or version fails with
-- 42P01; dropping the trigger and its function first leaves prescription
-- changes working. Each in a savepoint, rolled back.
savepoint undo_table_first;
drop table pharmacy.own_prescription_sends;
select pg_temp.expect('the trigger is still there', (select count(*)::text from pg_trigger
  where tgname = 'prescriptions_own_pharmacy_send_withdrawn'), '1');
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Undo order probe', true);
select pg_temp.expect('the sends table dropped first: a prescription change fails',
  pg_temp.try(format($s$update ehr.prescriptions set frequency = 'Every 6 hours' where id = %L$s$, pg_temp.rx(6))),
  '42P01 relation "pharmacy.own_prescription_sends" does not exist');
reset role;
rollback to savepoint undo_table_first;
savepoint undo_trigger_first;
drop trigger prescriptions_own_pharmacy_send_withdrawn on ehr.prescriptions;
drop function ehr.own_pharmacy_send_withdrawn_on_change();
drop table pharmacy.own_prescription_sends;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Undo order probe', true);
select pg_temp.expect('the trigger and its function dropped first: the change goes through',
  pg_temp.try(format($s$update ehr.prescriptions set frequency = 'Every 6 hours' where id = %L$s$, pg_temp.rx(6))),
  'ok');
reset role;
rollback to savepoint undo_trigger_first;
-- 0144 first, in full (its undo, minus restoring 0077's event validator,
-- whose text this suite does not hold; the replaced validator reads the
-- acceptances only for a pharmacist_accepted event, which nothing writes
-- here): while its two own-work policies on pharmacy.work_item_acceptances
-- stand, 0133's order stops at D1's halves (2BP01), even with 0133's own 44
-- policies gone.
savepoint undo_0144_kept;
do $$
declare policy_row record;
begin
  for policy_row in select polname, polrelid::regclass as relation from pg_policy
                     where polname like 'staff\_own\_work\_%'
                       and polrelid <> 'pharmacy.work_item_acceptances'::regclass loop
    execute format('drop policy %I on %s', policy_row.polname, policy_row.relation);
  end loop;
end $$;
select pg_temp.expect('0144 not undone: with 0133''s 44 own-work policies gone, D1''s pharmacy half cannot be dropped',
  pg_temp.try('drop function identity.pharmacy_work_patient_allows(uuid, uuid, uuid, text)'),
  '2BP01 cannot drop function identity.pharmacy_work_patient_allows(uuid,uuid,uuid,text) because other objects '
  || 'depend on it');
select pg_temp.expect('with 0144''s two dropped too, it can be',
  pg_temp.try('drop policy staff_own_work_read on pharmacy.work_item_acceptances') || ' '
  || pg_temp.try('drop policy staff_own_work_insert on pharmacy.work_item_acceptances') || ' '
  || pg_temp.try('drop function identity.pharmacy_work_patient_allows(uuid, uuid, uuid, text)'), 'ok ok ok');
rollback to savepoint undo_0144_kept;
-- 0148 kept: 0144's and 0133's header undo (below) with 0148 left in place.
-- 0148's trigger reads only D14's claims, which 0133's undo keeps, so a
-- prescription change still goes through; its reader then answers no row
-- for an item with nothing recorded (rx6, never dispensed), or 42883 had
-- D1's halves been dropped too: never a failure the services cannot read
-- as "no notice".
savepoint undo_0148_kept;
drop function pharmacy.own_work_item_steps(uuid[]);
drop trigger pharmacy_work_item_acceptance_validate on pharmacy.work_item_acceptances;
drop function pharmacy.validate_work_item_acceptance();
drop table pharmacy.work_item_acceptances;
do $$
begin
  execute pg_temp.without_d14(pg_get_functiondef(
    'ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)'::regprocedure));
  execute pg_temp.without_d14(pg_get_functiondef('ehr.order_route_resend_allowed(text,uuid)'::regprocedure));
end $$;
drop function pharmacy.own_withdrawn_work_items();
drop trigger prescriptions_own_pharmacy_send_withdrawn on ehr.prescriptions;
drop function ehr.own_pharmacy_send_withdrawn_on_change();
drop function ehr.send_prescription_to_own_pharmacy(uuid, bigint);
drop function ehr.withdraw_own_pharmacy_send(uuid);
drop function pharmacy.own_work_item_states(uuid[]);
drop table pharmacy.own_prescription_sends;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Undo order probe', true);
select set_config('own_work.undo_0148_change',
  pg_temp.try(format($s$update ehr.prescriptions set frequency = 'Every 6 hours' where id = %L$s$, pg_temp.rx(6))), true);
reset role;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select set_config('own_work.undo_0148_reader', pg_temp.try(format($s$do $d$ begin
    if exists (select 1 from pharmacy.work_item_changes_after_dispensing(%L::uuid[])) then
      raise exception 'a row';
    end if;
  end $d$$s$, array[pg_temp.work_item_of(pg_temp.rx(6))]::text)), true);
select pg_temp.expect('0148 kept: 0133''s header undo order still lets a prescription change go through (the claims stay)',
  current_setting('own_work.undo_0148_change') || ' '
  || case when current_setting('own_work.undo_0148_reader') = 'ok'
            or left(current_setting('own_work.undo_0148_reader'), 5) = '42883' then '42883 or no row'
          else current_setting('own_work.undo_0148_reader') end
  || ' ' || (to_regclass('pharmacy.prescription_item_claims') is not null)::text, 'ok 42883 or no row true');
reset role;
rollback to savepoint undo_0148_kept;
-- The header's full order, once 0148 and then 0144 are undone in full
-- (0148's trigger, reader, trigger function and table; 0144's reader, its
-- trigger and function, then its table). D14 first: 0123's order-route send
-- and 0086's resend flag are restored (the live bodies without the D14
-- hunks), so nothing new is released. Then the withdrawn items reader, the
-- withdrawal trigger, its function and the three other functions that read
-- the sends table, so none is left to fail with 42P01 once the table is
-- dropped;
-- pharmacy-api then finds no states or withdrawn reader (42883: a schema
-- without 0133) instead of a failing one. D14's claims, its two trigger
-- functions and both ALWAYS triggers stay (as its key): with them, a
-- released own item still cannot be dispensed (rx13), and an outside
-- acceptance while an own claim is live still ends in R10's order_in_work
-- (rx15: sent to F4 by 0123's send, then taken by F1's pharmacy, as replica).
savepoint undo_header_order;
-- 0148 (Q132 A) first, in its header's order: the trigger on
-- ehr.prescriptions (plpgsql records no dependency on the table it writes,
-- so the table dropped first would make every change of an active or held
-- prescription fail with 42P01), its reader, its trigger function, its
-- table. 0148 is undone before 0133: its reader calls D1's halves and its
-- trigger function reads D14's claims, which 0133's undo keeps.
drop trigger if exists prescriptions_pharmacy_change_after_dispensing on ehr.prescriptions;
drop function if exists pharmacy.work_item_changes_after_dispensing(uuid[]);
drop function if exists pharmacy.prescription_change_after_dispensing();
drop table if exists pharmacy.prescription_changes_after_dispensing;
drop function pharmacy.own_work_item_steps(uuid[]);
drop trigger pharmacy_work_item_acceptance_validate on pharmacy.work_item_acceptances;
drop function pharmacy.validate_work_item_acceptance();
drop table pharmacy.work_item_acceptances;
do $$
begin
  execute pg_temp.without_d14(pg_get_functiondef(
    'ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)'::regprocedure));
  execute pg_temp.without_d14(pg_get_functiondef('ehr.order_route_resend_allowed(text,uuid)'::regprocedure));
end $$;
select pg_temp.expect('the undo restores 0123''s send and 0086''s resend flag, ACLs kept',
  (select string_agg(md5(proc.prosrc) || ':' || replace(proc.proacl::text, pg_get_userbyid(proc.proowner), 'owner'), ' '
            order by proc.proname) from pg_proc proc
    where proc.oid in ('ehr.send_order_route(uuid,text,uuid,uuid,uuid,bigint,uuid,text,text,character)'::regprocedure,
      'ehr.order_route_resend_allowed(text,uuid)'::regprocedure)),
  'cd18f1a4942694d04288ab5d54679dbd:{owner=X/owner} '
  || '0c2def2b530bcb3d68537ade52787b6b:{owner=X/owner,hid_ehr_runtime=X/owner,hid_schema_test_runtime=X/owner}');
drop function pharmacy.own_withdrawn_work_items();
drop trigger prescriptions_own_pharmacy_send_withdrawn on ehr.prescriptions;
drop function ehr.own_pharmacy_send_withdrawn_on_change();
drop function ehr.send_prescription_to_own_pharmacy(uuid, bigint);
drop function ehr.withdraw_own_pharmacy_send(uuid);
drop function pharmacy.own_work_item_states(uuid[]);
select pg_temp.expect('no function left reads the sends table', (select coalesce(string_agg(oid::regprocedure::text, ', '),
  'none') from pg_proc where prosrc like '%own\_prescription\_sends%'), 'none');
drop table pharmacy.own_prescription_sends;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(2);
select pg_temp.expect('the pharmacy list''s states and withdrawn readers are gone (42883), not failing',
  left(pg_temp.try(format('select * from pharmacy.own_work_item_states(array[%L]::uuid[])',
    pg_temp.work_item_of(pg_temp.rx(3)))), 5) || ' '
  || left(pg_temp.try('select * from pharmacy.own_withdrawn_work_items()'), 5), '42883 42883');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.as_member(1);
select set_config('app.change_reason', 'Undo order probe', true);
select pg_temp.expect('the header''s order: a prescription change goes through',
  pg_temp.try(format($s$update ehr.prescriptions set frequency = 'Every 6 hours' where id = %L$s$, pg_temp.rx(6))),
  'ok');
reset role;
select pg_temp.expect('the claims, their three functions and four triggers stay, with the key',
  (select count(*) from pg_trigger trigger_row where trigger_row.tgenabled = 'A'
     and trigger_row.tgname in ('work_items_claim_prescription', 'dispensings_claim_prescription',
       'prescription_claim_key_immutable'))
  || ' ' || (to_regclass('pharmacy.prescription_item_claims') is not null)
  || ' ' || (to_regclass('pharmacy.work_items_prescription_kind_uq') is not null), '4 true true');
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(10);
select pg_temp.expect('after the undo: the released own item of rx13 still cannot be dispensed',
  pg_temp.try_detail(pg_temp.dispense_sql(pg_temp.work_item_of(pg_temp.rx(13)), 10)),
  '23514 PRESCRIPTION_SOURCE_NOT_DISPENSABLE / sent_elsewhere');
reset role;
set local role hid_ehr_api_runtime;
select pg_temp.expect('after the undo: 0123''s send sends rx15 (no work item yet) to F4, with the switch or not',
  pg_temp.route_send(15), 'sent');
reset role;
set local session_replication_role = replica;
select pg_temp.as_member(10);
select pg_temp.expect('after the undo: F1''s pharmacy takes rx15 as the route is sent (replica: the claim is live)',
  pg_temp.try(pg_temp.accept_sql(15, 10)) || ' ' || pg_temp.claims(15), 'ok own:live');
set local session_replication_role = origin;
set local role hid_pharmacy_api_runtime;
select pg_temp.expect('after the undo: F4''s acceptance meets the live claim: R10, order_in_work',
  pg_temp.route_accept(15), 'order_in_work');
reset role;
select pg_temp.expect('after the undo: the route withdrawn (order_in_work), nothing at F4, one live own claim',
  (select route.state || '/' || route.ended_kind from pg_temp.route_row(15) route) || ' '
  || (select count(*) from pharmacy.work_items item where item.source_ehr_prescription_id = pg_temp.rx(15)
        and item.order_route_id is not null) || ' ' || pg_temp.claims(15),
  'withdrawn/order_in_work 0 own:live');
rollback to savepoint undo_header_order;
select pg_temp.expect('both undone: the sends table and the trigger are back',
  (select (to_regclass('pharmacy.own_prescription_sends') is not null)::text || '/' || count(*)::text from pg_trigger
    where tgname = 'prescriptions_own_pharmacy_send_withdrawn'), 'true/1');
-- D15's list goes after D1's halves (which read it): with a list trigger
-- left, dropping the list makes every own item insert fail with 42P01
-- (here PG's acceptance of rx15), whichever image; with both triggers and
-- their function dropped first, it goes through.
savepoint undo_list_first;
drop table identity.own_work_patients;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(10);
select pg_temp.expect('the list dropped while its triggers stand: an own item insert fails',
  pg_temp.try(pg_temp.accept_sql(15, 10)), '42P01 relation "identity.own_work_patients" does not exist');
reset role;
rollback to savepoint undo_list_first;
savepoint undo_list_triggers_first;
drop trigger work_items_own_work_patient_listed on lab.work_items;
drop trigger work_items_own_work_patient_listed on pharmacy.work_items;
drop function identity.list_own_work_patient();
drop table identity.own_work_patients;
set local role hid_pharmacy_api_runtime;
select pg_temp.as_member(10);
select pg_temp.expect('the list''s triggers and function dropped first: the insert goes through',
  pg_temp.try(pg_temp.accept_sql(15, 10)), 'ok');
reset role;
rollback to savepoint undo_list_triggers_first;

-- At the end: D15's list and D14's claims are exact both ways.
select pg_temp.expect('the list and the claims are exact at the end', pg_temp.exact(),
  'unlisted=0 unfounded=0 unclaimed=0 orphaned=0');

rollback;

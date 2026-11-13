-- Cross-facility imported records on a patient's share (owner decision Q64,
-- option A, 2026-11-13: "Q64 option A, sensitive excluded, DPO sign-off").
-- The number 0124 is a placeholder; the coordinator assigns the real one at
-- merge. It is ordered after 0123 (sealed QA tenant) in the release, and it
-- uses 0123's QA seal when 0123 is present (section 4).
--
-- WHAT IT DOES
-- Until now every read of a patient's imported paper records (lab imports,
-- 0017; pharmacy imports, 0023) was confined to the facility that imported
-- them: lab.context_allows and pharmacy.context_allows require the row's
-- facility to be the session's. 0085 lists "cross-facility imported records"
-- as a known limit. This migration lets a patient choose, on a share, "also
-- show my paper records from other facilities":
--   * identity.patient_share_scopes: one row per share for which the patient
--     chose it (include_other_facilities), and whether the patient also chose
--     to include sensitive records (include_sensitive). Default off: a share
--     without a row, every share made before this migration and every share
--     made by invitation, stays facility-only. Immutable; a change is a new
--     share, which replaces the old one (0095 D5) and so ends its scope.
--   * identity.create_my_consent_share_scoped: 0095's create_my_consent_share
--     (called, not replaced) plus the scope, in one transaction.
--   * lab.patient_imports_other_facilities and
--     pharmacy.patient_imports_other_facilities: the patient's imported
--     records from every OTHER facility, read by staff at the share's
--     facility, only:
--       - under an active share of this patient to the caller's own membership
--         at the session facility, with include_other_facilities chosen;
--       - for purpose direct-care (a share's purpose); never under
--         break-glass (an emergency grant has no share), a PIN grant or an
--         approved access request (neither is a share);
--       - with identity.has_active_consent_grant also allowing read_records
--         (so a deny directive, a held grant or an inactive account refuses);
--       - from source facilities on the patient's side of the seal (real,
--         0098's demo, 0123's QA);
--       - without sensitive records (HIV/ARV, TB, psychiatric, sickle cell;
--         section 3) unless the patient chose include_sensitive. A record is
--         withheld whole when any text it returns matches, including its
--         external laboratory, its reference, its units and ranges and its
--         source facility's name.
--     Each read writes one audit row (ids and counts only) in the caller's
--     transaction, so the read and its audit row commit or roll back
--     together. A refusal (no qualifying share) writes one count-only denied
--     audit row (who, which patient, the reason code), sets the transaction
--     setting hid.other_facilities_refused to OTHER_FACILITIES_NOT_SHARED
--     and returns nothing; it does not raise, so the denied row is kept
--     when the caller commits. Lab and Pharmacy answer 403 after commit.
--     An id that is no patient answers the same, its row without a patient
--     id; a session whose membership is not active at its facility is
--     refused the same way but writes no row (it cannot be attributed).
--   * Row-level security: the two functions run as the owner of the import
--     tables, which in production bypasses neither superuser nor row-level
--     security checks (release checklist P8). The existing read policies
--     admit only the session's facility, so each function writes a row for
--     its own transaction and patient in a marker table just before its read
--     and deletes it just after; a new SELECT policy for that owner only
--     admits the marked patient's rows while the marker exists (the pattern
--     of 0119's quality summary). No runtime role gains any read.
--   * Entered-in-error lab imports are never shown across facilities.
--
-- NOT CHANGED: the existing facility-scoped reads, context_allows, the share
-- commands, the invitation flow, consent_grants and every existing body.
--
-- Run as one transaction by the migration runner. Locks: ACCESS EXCLUSIVE
-- (NOWAIT, bounded at 5 seconds, else 55P03) on lab.imported_evidence,
-- lab.imported_observations and pharmacy.imported_medication_evidence for
-- the new policies.

-- 0. Preconditions.
do $$
declare
  mismatch text;
begin
  if to_regclass('identity.patient_consent_shares') is null
     or to_regclass('lab.imported_evidence') is null or to_regclass('lab.imported_observations') is null
     or to_regclass('pharmacy.imported_medication_evidence') is null
     or to_regprocedure('identity.create_my_consent_share(text,uuid,uuid,text,text,text,text)') is null
     or to_regprocedure('identity.has_active_consent_grant(uuid,text,uuid,uuid,text,text,timestamptz)') is null
     or to_regprocedure('identity.share_audit(text,text,uuid,uuid,uuid,uuid,text,text,text,uuid,text,jsonb)') is null
     or to_regprocedure('identity.sealed_demo_facility(uuid)') is null
     or to_regprocedure('identity.sealed_demo_patient(uuid)') is null then
    raise exception using errcode = '55000', message = '0124: a prerequisite object is missing (0095, 0098, 0017, 0023)';
  end if;
  if to_regclass('identity.patient_share_scopes') is not null
     or to_regclass('lab.other_facility_import_reads') is not null
     or to_regclass('pharmacy.other_facility_import_reads') is not null then
    raise exception using errcode = '55000', message = '0124: already applied';
  end if;
  -- The import tables' policies are exactly 0017's and 0023's.
  select string_agg(format('%s.%s', policy_row.polrelid::regclass, policy_row.polname), ', ') into mismatch
    from (select polrelid, polname from pg_policy
           where polrelid in ('lab.imported_evidence'::regclass, 'lab.imported_observations'::regclass,
                              'pharmacy.imported_medication_evidence'::regclass)
          except
          select * from (values ('lab.imported_evidence'::regclass, 'lab_imported_evidence_read'::name),
                                ('lab.imported_evidence'::regclass, 'lab_imported_evidence_insert'::name),
                                ('lab.imported_observations'::regclass, 'lab_imported_observations_read'::name),
                                ('lab.imported_observations'::regclass, 'lab_imported_observations_insert'::name),
                                ('pharmacy.imported_medication_evidence'::regclass, 'pharmacy_imports_read'::name),
                                ('pharmacy.imported_medication_evidence'::regclass, 'pharmacy_imports_insert'::name))
                 expected(polrelid, polname)) policy_row;
  if mismatch is not null or (select count(*) from pg_policy
       where polrelid in ('lab.imported_evidence'::regclass, 'lab.imported_observations'::regclass,
                          'pharmacy.imported_medication_evidence'::regclass)) <> 6 then
    raise exception using errcode = '55000',
      message = '0124: the import tables'' policies are not 0017''s and 0023''s: ' || coalesce(mismatch, 'missing');
  end if;
  -- The share tables' owner also owns identity.patients (the audit helper
  -- reads a patient's existence as that owner, which RLS does not filter).
  if (select relowner from pg_class where oid = 'identity.patient_consent_shares'::regclass)
       <> (select relowner from pg_class where oid = 'identity.patients'::regclass) then
    raise exception using errcode = '55000',
      message = '0124: identity.patient_consent_shares and identity.patients have different owners';
  end if;
  -- Both lab tables have one owner (0017); every import table forces row-level security.
  if (select relowner from pg_class where oid = 'lab.imported_evidence'::regclass)
       <> (select relowner from pg_class where oid = 'lab.imported_observations'::regclass)
     or exists (select 1 from pg_class
                 where oid in ('lab.imported_evidence'::regclass, 'lab.imported_observations'::regclass,
                               'pharmacy.imported_medication_evidence'::regclass)
                   and not (relrowsecurity and relforcerowsecurity)) then
    raise exception using errcode = '55000',
      message = '0124: the import tables do not share 0017''s owner or do not force row-level security';
  end if;
end
$$;

-- 1. The share's scope.
create table identity.patient_share_scopes (
  consent_grant_id uuid primary key references identity.patient_consent_shares(consent_grant_id) on delete restrict,
  patient_id uuid not null references identity.patients(id) on delete restrict,
  include_other_facilities boolean not null check (include_other_facilities),
  include_sensitive boolean not null,
  created_at timestamptz not null default clock_timestamp()
);

comment on table identity.patient_share_scopes is
  '0124 (Q64 option A): the patient chose, on this share, to also show their imported paper records from other facilities (include_other_facilities, always true: a share without a row is facility-only) and whether sensitive records (HIV/ARV, TB, psychiatric, sickle cell) are included (include_sensitive). Written once with the share by identity.create_my_consent_share_scoped; immutable.';

create function identity.patient_share_scopes_immutable()
returns trigger language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  raise exception using errcode = '55000', message = 'PATIENT_SHARE_SCOPE_IMMUTABLE';
end
$$;

create trigger patient_share_scopes_immutable
  before update or delete on identity.patient_share_scopes
  for each row execute function identity.patient_share_scopes_immutable();

alter table identity.patient_share_scopes enable row level security;
alter table identity.patient_share_scopes force row level security;

-- 2. Markers for the cross-facility reads (one row per transaction).
create table lab.other_facility_import_reads (
  transaction_id xid8 primary key,
  patient_id uuid not null,
  started_at timestamptz not null default clock_timestamp()
);
create table pharmacy.other_facility_import_reads (
  transaction_id xid8 primary key,
  patient_id uuid not null,
  started_at timestamptz not null default clock_timestamp()
);
alter table lab.other_facility_import_reads enable row level security;
alter table lab.other_facility_import_reads force row level security;
alter table pharmacy.other_facility_import_reads enable row level security;
alter table pharmacy.other_facility_import_reads force row level security;

comment on table lab.other_facility_import_reads is
  '0124: a cross-facility read of one patient''s lab imports in progress, one row for its transaction, written by lab.patient_imports_other_facilities just before its read and deleted just after. The policies lab_imported_evidence_other_facilities and lab_imported_observations_other_facilities admit the import tables'' owner to that patient''s rows only while the row exists.';
comment on table pharmacy.other_facility_import_reads is
  '0124: a cross-facility read of one patient''s pharmacy imports in progress, one row for its transaction, written by pharmacy.patient_imports_other_facilities just before its read and deleted just after. The policy pharmacy_imports_other_facilities admits the import table''s owner to that patient''s rows only while the row exists.';

-- 3. The four sensitive classes (HIV/ARV, TB, psychiatric, sickle cell):
-- hid.ocr.sensitive/v2's three lists (ocr-api's sensitive-classes.ts, #237's
-- ocr.learning_value_sensitive) widened with the HIV, TB, psychiatric and
-- sickle-cell fragments of the patient-results policy (ehr-api's
-- patient-evidence.policy.ts) and Nigerian lab shorthand (HIV1/2, VL, MTB,
-- Xpert, sickling, HbS). A generic name or stem anywhere in the text, or a
-- word pattern, abbreviation or brand as a whole word, any case. Each
-- pattern is a constant, so PostgreSQL compiles it once per session. It
-- errs towards withholding (for example "Rh" or "art" as a word).
create function identity.cross_facility_text_sensitive(requested_value text)
returns boolean
language sql immutable
set search_path = pg_catalog, pg_temp
as $$
  select requested_value is not null and (
    -- generics (and stems such as sickl-, antiretrovir-, mycobacter-) anywhere in the text
    lower(requested_value) ~ ('(abacavir|atazanavir|bictegravir|cabotegravir|darunavir|didanosine|dolutegravir|efavirenz|emtricitabine|etravi'
    || 'rine|lamivudine|lopinavir|nevirapine|raltegravir|rilpivirine|ritonavir|stavudine|tenofovir|tenofovir disoproxi'
    || 'l|tenofovir alafenamide|zidovudine|doravirine|fostemsavir|maraviroc|enfuvirtide|indinavir|saquinavir|nelfinavi'
    || 'r|fosamprenavir|isoniazid|rifampicin|rifampin|rifapentine|rifabutin|pyrazinamide|ethambutol|streptomycin|bedaq'
    || 'uiline|delamanid|pretomanid|cycloserine|terizidone|ethionamide|prothionamide|para-aminosalicylic acid|aminosal'
    || 'icylic acid|capreomycin|kanamycin|clofazimine|thioacetazone|haloperidol|chlorpromazine|fluphenazine|olanzapine'
    || '|risperidone|quetiapine|aripiprazole|clozapine|trifluoperazine|flupentixol|zuclopenthixol|sulpiride|amisulprid'
    || 'e|paliperidone|ziprasidone|pimozide|perphenazine|thioridazine|lithium|lithium carbonate|diazepam|lorazepam|alp'
    || 'razolam|bromazepam|chlordiazepoxide|clonazepam|nitrazepam|temazepam|zolpidem|zopiclone|amitriptyline|imipramin'
    || 'e|clomipramine|nortriptyline|fluoxetine|sertraline|paroxetine|citalopram|escitalopram|fluvoxamine|mirtazapine|'
    || 'venlafaxine|duloxetine|trazodone|methylphenidate|atomoxetine|hydroxycarbamide|hydroxyurea|voxelotor|crizanlizu'
    || 'mab|l-glutamine|antiretrovir|retrovir|immunodeficiency|mycobacter|sickl|drepanocyt)')
    -- word patterns, abbreviations and brand names as whole words
    or lower(requested_value) ~ ('(^|[^a-z0-9])(aids|plhiv|pvh|retroviral|rvs|r[/-]?v[/-]?d|haart|art|arvs?|cd4|viral load|prep|pep|pre-exposure'
    || '|post-exposure|tdf|3tc|dtg|efv|nvp|azt|lpv|atv|tld|tle|ftc|tb|ptb|eptb|tuberculo[a-z]*|genexpert|gene xpert|af'
    || 'b|acid[- ]fast|mantoux|tuberculin|rhze|rhz|rh|inh|dots|psych[a-z]*|schizo[a-z]*|bipolar|depressi[a-z]*|mania|m'
    || 'anic|anxiety|ssri|antipsychotic[a-z]*|sickle[a-z]*|scd|sca|hbss|hb ss|genotype|electrophoresis|hiv[a-z0-9]*|h['
    || ' .]+i[ .]+v|human[ -]*immuno[ -]*deficiency|vl|viral[ -]?loads?|cd[ -]?4[a-z0-9]*|rvd|rvi|plwha|pmtct|taf|zdv|'
    || 'drv|rpv|mtb|xpert|lam|lf[ -]?lam|ipt|3hp|psychos[a-z]*|psychotic|suicid[a-z]*|self[ -]?harm|mental|ptsd|ocd|ph'
    || 'q[ -]?[0-9]*|gad[ -]?[0-9]+|dementia|neurosis|neurotic|catatoni[a-z]*|hbs|hb[ -]?s[ -]?s|hb[ -]?s[ -]?c|hb[ -]'
    || '?a[ -]?s|hb[ -]?electrophoresis|ha?emoglobin[ -]?electrophoresis|genotyp[a-z]*|atripla|truvada|descovy|kaletra'
    || '|aluvia|biktarvy|triumeq|combivir|trizivir|symfi|symfi[ -]?lo|odefsey|genvoya|stribild|juluca|dovato|complera|'
    || 'eviplera|epzicom|kivexa|epivir|retrovir|viread|vemlidy|emtriva|ziagen|sustiva|stocrin|viramune|isentress|tivic'
    || 'ay|prezista|prezcobix|reyataz|evotaz|norvir|intelence|edurant|selzentry|celsentri|fuzeon|rukobia|cabenuva|voca'
    || 'bria|apretude|delstrigo|pifeltro|symtuza|cimduo|temixys|triomune|duovir|duovir[ -]?n|lamivir|viraday|teevir|ac'
    || 'riptega|avonza|tenvir|tenvir[ -]?em|ricovir|ricovir[ -]?em|rifinah|rifater|rimactane|rifadin|myambutol|sirturo'
    || '|deltyba|priftin|mycobutin|akurit|akurit[ -]?4|forecox|voractiv|rimstar|rifafour|dovprela|lamprene|trecator|la'
    || 'rgactil|haldol|serenace|modecate|zyprexa|risperdal|seroquel|abilify|clozaril|stelazine|depixol|fluanxol|clopix'
    || 'ol|invega|geodon|orap|melleril|priadel|camcolit|valium|ativan|xanax|lexotan|librium|rivotril|klonopin|mogadon|'
    || 'restoril|stilnox|ambien|imovane|tryptizol|elavil|tofranil|anafranil|prozac|zoloft|paxil|seroxat|celexa|ciprami'
    || 'l|lexapro|cipralex|luvox|faverin|remeron|effexor|cymbalta|desyrel|ritalin|concerta|strattera|hydrea|siklos|dro'
    || 'xia|oxbryta|adakveo|endari|niprisan|nicosan|ciklavit)($|[^a-z0-9])'))
$$;

comment on function identity.cross_facility_text_sensitive(text) is
  '0124: whether a text names a sensitive class (HIV/ARV, TB, psychiatric, sickle cell; hid.ocr.sensitive/v2''s lists widened with the patient-results policy''s fragments and Nigerian lab shorthand: generic names and stems anywhere, word patterns, abbreviations and brands as whole words, any case). A cross-facility imported record with any such text is withheld unless the patient chose include_sensitive. Granted to no runtime role.';

-- 4. A source facility's name, when it is on the patient's side of the seal
-- (0098's demo always, 0123's QA when 0123 is applied: it is ordered before
-- this migration in the release; until then there is no QA side); null
-- otherwise.
create function identity.cross_facility_source_name(requested_patient_id uuid, requested_facility_id uuid)
returns text
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  qa_same boolean := true;
begin
  if requested_patient_id is null or requested_facility_id is null
     or identity.sealed_demo_facility(requested_facility_id)
          is distinct from identity.sealed_demo_patient(requested_patient_id) then
    return null;
  end if;
  if to_regprocedure('identity.sealed_qa_facility(uuid)') is not null
     and to_regprocedure('identity.sealed_qa_patient(uuid)') is not null then
    execute 'select identity.sealed_qa_facility($1) is not distinct from identity.sealed_qa_patient($2)'
      into qa_same using requested_facility_id, requested_patient_id;
  end if;
  if not coalesce(qa_same, false) then
    return null;
  end if;
  return (select facility.name from identity.facilities facility where facility.id = requested_facility_id);
end
$$;

comment on function identity.cross_facility_source_name(uuid, uuid) is
  '0124: a facility''s name when it is on the same side of the seal as the patient (real, 0098''s demo, and 0123''s QA when present), else null. Granted to no runtime role.';

-- 5. The share that opens other facilities' imports to the caller, if any:
-- an active patient share (0108's criterion: a share row, patient-granted,
-- no request, no authorization method) of this patient to this membership at
-- this facility, direct-care, not break-glass, with a scope row; and
-- has_active_consent_grant allows read_records. Returns include_sensitive.
create function identity.share_other_facilities_access(
  requested_patient_id uuid, requested_subject text, requested_membership_id uuid, requested_facility_id uuid,
  requested_purpose text
) returns table (consent_grant_id uuid, include_sensitive boolean)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select grant_row.id, scope.include_sensitive
    from identity.consent_grants grant_row
    join identity.patient_consent_shares share on share.consent_grant_id = grant_row.id
                                              and share.patient_id = grant_row.patient_id
                                              and share.membership_id = grant_row.membership_id
    join identity.patient_share_scopes scope on scope.consent_grant_id = grant_row.id
                                            and scope.patient_id = grant_row.patient_id
    join auth.accounts account_row on account_row.id = grant_row.account_id
   where requested_purpose = 'direct-care'
     and grant_row.patient_id = requested_patient_id
     and grant_row.membership_id = requested_membership_id
     and grant_row.facility_id = requested_facility_id
     and account_row.subject = requested_subject
     and grant_row.purpose_of_use = 'direct-care'
     and grant_row.status = 'active'
     and grant_row.migration_hold_reason is null
     and grant_row.starts_at <= clock_timestamp()
     and grant_row.expires_at > clock_timestamp()
     and grant_row.scope in ('read_records', 'write_records')
     and not grant_row.break_glass
     and grant_row.request_id is null
     and grant_row.authorization_method is null
     and grant_row.granted_by_patient_id = grant_row.patient_id
     and scope.include_other_facilities
     and identity.has_active_consent_grant(requested_patient_id, requested_subject, requested_membership_id,
       requested_facility_id, 'read_records', requested_purpose, clock_timestamp())
   order by grant_row.starts_at desc, grant_row.id
   limit 1
$$;

comment on function identity.share_other_facilities_access(uuid, text, uuid, uuid, text) is
  '0124: the active patient share (not break-glass, not a PIN grant, not an approved request) of this patient to this membership at this facility, for direct-care, for which the patient chose to include other facilities'' imported records, and whether sensitive records are included; none otherwise. Also requires identity.has_active_consent_grant to allow read_records. Granted to no runtime role.';

-- One audit row for a cross-facility read (ids and counts only).
create function identity.cross_facility_read_audit(
  requested_action text, requested_resource_type text, requested_patient_id uuid, requested_consent_grant_id uuid,
  requested_outcome text, requested_details jsonb
) returns void
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if requested_action not in ('lab.import.other-facilities.list', 'pharmacy.import.other-facilities.list')
     or requested_resource_type not in ('lab-imported-evidence-other-facilities',
                                        'pharmacy-imported-medication-other-facilities')
     or requested_outcome is null or requested_outcome not in ('success', 'denied') then
    raise exception using errcode = '22023', message = 'CROSS_FACILITY_AUDIT_INVALID';
  end if;
  -- A session whose membership is not its subject's active membership at its
  -- facility cannot be attributed (the audit row's keys would refuse it); it
  -- reads nothing, and no row is written rather than a failure.
  if not coalesce(identity.has_active_membership(platform.current_actor_subject(), platform.current_membership_id(),
       platform.current_facility_id()), false) then
    return;
  end if;
  -- A refusal for an id that is no patient keeps no patient id (the audit
  -- row's key), so it answers exactly as any other refusal.
  if requested_outcome = 'denied' and not exists (select 1 from identity.patients patient
                                                   where patient.id = requested_patient_id) then
    requested_patient_id := null;
  end if;
  perform identity.share_audit('staff', platform.current_actor_subject(), platform.current_account_id(),
    platform.current_membership_id(), platform.current_facility_id(), requested_patient_id, requested_action,
    requested_outcome, requested_resource_type, requested_consent_grant_id, platform.current_purpose_of_use(),
    requested_details);
end
$$;

comment on function identity.cross_facility_read_audit(text, text, uuid, uuid, text, jsonb) is
  '0124: the one audit row of a cross-facility imported-records read (success: the share''s consent grant as the resource, ids and counts only) or refusal (denied: no resource, the reason code only), with the reader''s session and the patient (none for an id that is no patient). No row for a session whose membership is not active at its facility. Granted to no runtime role.';

-- 6. The patient's command: a share, and its scope when chosen.
create function identity.create_my_consent_share_scoped(
  requested_subject text, requested_session uuid, requested_membership_id uuid, requested_level text,
  requested_duration text, requested_include_other_facilities boolean, requested_include_sensitive boolean,
  requested_idempotency_key text, requested_request_sha256 text
) returns table (consent_grant_id uuid, membership_id uuid, scope text, level text, duration_preset text,
  starts_at timestamptz, expires_at timestamptz, clinician_name text, facility_name text,
  replaced_consent_grant_id uuid, replayed boolean, notify_email text, include_other_facilities boolean,
  include_sensitive boolean)
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  written record;
  existing identity.patient_share_scopes%rowtype;
  patient_id_value uuid;
  account_id_value uuid;
begin
  if requested_include_other_facilities is null or requested_include_sensitive is null
     or (requested_include_sensitive and not requested_include_other_facilities) then
    raise exception using errcode = '22023', message = 'SHARE_REQUEST_INVALID';
  end if;
  select * into written
    from identity.create_my_consent_share(requested_subject, requested_session, requested_membership_id,
      requested_level, requested_duration, requested_idempotency_key, requested_request_sha256) created;
  select share.patient_id, patient.account_id into patient_id_value, account_id_value
    from identity.patient_consent_shares share
    join identity.patients patient on patient.id = share.patient_id
   where share.consent_grant_id = written.consent_grant_id;
  select * into existing from identity.patient_share_scopes scope_row
   where scope_row.consent_grant_id = written.consent_grant_id;
  if written.replayed then
    -- The request digest covers the scope; a replay must name the same one.
    if coalesce(existing.include_other_facilities, false) is distinct from requested_include_other_facilities
       or coalesce(existing.include_sensitive, false) is distinct from requested_include_sensitive then
      raise exception using errcode = '22023', message = 'SHARE_REQUEST_INVALID';
    end if;
  elsif requested_include_other_facilities then
    insert into identity.patient_share_scopes (consent_grant_id, patient_id, include_other_facilities,
      include_sensitive)
    values (written.consent_grant_id, patient_id_value, true, requested_include_sensitive);
    perform identity.share_audit('patient', requested_subject, account_id_value, null, null, patient_id_value,
      'identity.consent-grant.patient-share-scope', 'success', 'consent-grant', written.consent_grant_id,
      'patient-self',
      jsonb_build_object('includeOtherFacilities', true, 'includeSensitive', requested_include_sensitive));
  end if;
  return query select written.consent_grant_id, written.membership_id, written.scope, written.level,
    written.duration_preset, written.starts_at, written.expires_at, written.clinician_name, written.facility_name,
    written.replaced_consent_grant_id, written.replayed, written.notify_email, requested_include_other_facilities,
    requested_include_sensitive;
end
$$;

comment on function identity.create_my_consent_share_scoped(text, uuid, uuid, text, text, boolean, boolean, text, text) is
  '0124 (Q64 option A): the patient''s share (identity.create_my_consent_share, unchanged) and, when chosen, its scope: also show the patient''s imported paper records from other facilities, and whether sensitive records are included (only with other facilities). Default off. A replay must name the same scope (22023 SHARE_REQUEST_INVALID).';

-- The patient's own share scopes (for "who can see my records").
create function identity.list_my_share_scopes(requested_subject text, requested_session uuid)
returns table (consent_grant_id uuid, include_other_facilities boolean, include_sensitive boolean)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  patient_id_value uuid := identity.patient_self_session(requested_subject, requested_session);
begin
  if patient_id_value is null then
    raise exception using errcode = '42501', message = 'Patient self session is required';
  end if;
  return query select scope_row.consent_grant_id, scope_row.include_other_facilities, scope_row.include_sensitive
    from identity.patient_share_scopes scope_row
    join identity.consent_grants grant_row on grant_row.id = scope_row.consent_grant_id
   where scope_row.patient_id = patient_id_value and grant_row.status = 'active'
     and grant_row.expires_at > clock_timestamp()
   order by scope_row.created_at, scope_row.consent_grant_id;
end
$$;

comment on function identity.list_my_share_scopes(text, uuid) is
  '0124: the calling patient''s active shares that include other facilities'' imported records, and whether sensitive records are included.';

-- 7. The cross-facility reads.
create function lab.patient_imports_other_facilities(
  requested_patient_id uuid, requested_before_received_at timestamptz, requested_before_id uuid,
  requested_limit integer
) returns table (import_id uuid, source_facility_id uuid, source_facility_name text, status text,
  external_lab_name text, external_reference text, collected_at timestamptz, reported_at timestamptz,
  received_at timestamptz, created_at timestamptz, observations jsonb)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  session_facility uuid := platform.current_facility_id();
  session_membership uuid := platform.current_membership_id();
  session_subject text := platform.current_actor_subject();
  session_purpose text := platform.current_purpose_of_use();
  access_row record;
  page jsonb;
  page_limit integer := least(greatest(coalesce(requested_limit, 20), 1), 50);
begin
  perform set_config('hid.other_facilities_refused', '', true);
  if requested_patient_id is null or session_facility is null or session_membership is null
     or session_subject is null or platform.current_account_id() is null
     or (requested_before_received_at is null) <> (requested_before_id is null) then
    raise exception using errcode = '22023', message = 'OTHER_FACILITIES_REQUEST_INVALID';
  end if;
  select * into access_row from identity.share_other_facilities_access(requested_patient_id, session_subject,
    session_membership, session_facility, session_purpose) access;
  if access_row.consent_grant_id is null then
    -- Refused: one count-only denied audit row, kept (no exception), the
    -- refusal flagged for the caller, nothing returned.
    perform identity.cross_facility_read_audit('lab.import.other-facilities.list',
      'lab-imported-evidence-other-facilities', requested_patient_id, null, 'denied',
      jsonb_build_object('reason', 'OTHER_FACILITIES_NOT_SHARED'));
    perform set_config('hid.other_facilities_refused', 'OTHER_FACILITIES_NOT_SHARED', true);
    return;
  end if;
  insert into lab.other_facility_import_reads (transaction_id, patient_id)
  values (pg_current_xact_id(), requested_patient_id);
  select coalesce(jsonb_agg(jsonb_build_object('importId', picked.id, 'sourceFacilityId', picked.facility_id,
           'sourceFacilityName', picked.facility_name, 'status', picked.status,
           'externalLabName', picked.external_lab_name, 'externalReference', picked.external_reference,
           'collectedAt', picked.collected_at, 'reportedAt', picked.reported_at, 'receivedAt', picked.received_at,
           'createdAt', picked.created_at, 'observations', picked.observations)
           order by picked.received_at desc, picked.id desc), '[]'::jsonb)
    into page
    from (
  select evidence.id, evidence.facility_id, facility.name as facility_name, evidence.status,
         evidence.external_lab_name, evidence.external_reference, evidence.collected_at, evidence.reported_at,
         evidence.received_at, evidence.created_at,
         coalesce((select jsonb_agg(jsonb_build_object('ordinal', observation.ordinal,
                     'testCode', observation.test_code, 'testName', observation.test_name,
                     'value', observation.value, 'valueText', observation.value_text, 'unit', observation.unit,
                     'referenceRange', observation.reference_range, 'abnormalFlag', observation.abnormal_flag,
                     'reportedAt', observation.reported_at) order by observation.ordinal)
                     from lab.imported_observations observation
                    where observation.import_id = evidence.id and observation.patient_id = evidence.patient_id
                      and observation.facility_id = evidence.facility_id), '[]'::jsonb) as observations
    from lab.imported_evidence evidence
    cross join lateral (select identity.cross_facility_source_name(requested_patient_id, evidence.facility_id)
                          as name) facility
   where evidence.patient_id = requested_patient_id
     and evidence.facility_id <> session_facility
     and evidence.status <> 'entered_in_error'
     and facility.name is not null
     and (requested_before_received_at is null
          or (evidence.received_at, evidence.id) < (requested_before_received_at, requested_before_id))
     and (access_row.include_sensitive or not (
          identity.cross_facility_text_sensitive(facility.name)
          or identity.cross_facility_text_sensitive(evidence.external_lab_name)
          or identity.cross_facility_text_sensitive(evidence.external_reference)
          or exists (select 1 from lab.imported_observations observation
                      where observation.import_id = evidence.id and observation.patient_id = evidence.patient_id
                        and observation.facility_id = evidence.facility_id
                        and (identity.cross_facility_text_sensitive(observation.test_code)
                             or identity.cross_facility_text_sensitive(observation.test_name)
                             or identity.cross_facility_text_sensitive(observation.value)
                             or identity.cross_facility_text_sensitive(observation.value_text)
                             or identity.cross_facility_text_sensitive(observation.unit)
                             or identity.cross_facility_text_sensitive(observation.reference_range)))))
   order by evidence.received_at desc, evidence.id desc
   limit page_limit) picked;
  delete from lab.other_facility_import_reads read_row where read_row.transaction_id = pg_current_xact_id();
  perform identity.cross_facility_read_audit('lab.import.other-facilities.list',
    'lab-imported-evidence-other-facilities', requested_patient_id, access_row.consent_grant_id, 'success',
    jsonb_build_object('returnedCount', jsonb_array_length(page),
      'importIds', coalesce((select jsonb_agg(item -> 'importId' order by position)
                               from jsonb_array_elements(page) with ordinality listed(item, position)), '[]'::jsonb),
      'sourceFacilityIds', coalesce((select jsonb_agg(distinct item -> 'sourceFacilityId')
                                       from jsonb_array_elements(page) listed(item)), '[]'::jsonb),
      'includeSensitive', access_row.include_sensitive, 'paged', requested_before_id is not null));
  return query select (item ->> 'importId')::uuid, (item ->> 'sourceFacilityId')::uuid, item ->> 'sourceFacilityName',
    item ->> 'status', item ->> 'externalLabName', item ->> 'externalReference',
    (item ->> 'collectedAt')::timestamptz, (item ->> 'reportedAt')::timestamptz, (item ->> 'receivedAt')::timestamptz,
    (item ->> 'createdAt')::timestamptz, item -> 'observations'
    from jsonb_array_elements(page) with ordinality listed(item, position)
   order by position;
end
$$;

comment on function lab.patient_imports_other_facilities(uuid, timestamptz, uuid, integer) is
  '0124 (Q64 option A): a page (1-50, newest first, cursor received_at and id) of the patient''s lab imports from other facilities on the patient''s side of the seal, for staff at the facility of an active patient share to their membership that includes other facilities (identity.share_other_facilities_access), purpose direct-care; never break-glass. Entered-in-error imports are left out, and sensitive ones unless the patient included them. One audit row per read; a refusal writes one denied audit row, sets hid.other_facilities_refused to OTHER_FACILITIES_NOT_SHARED and returns nothing.';

create function pharmacy.patient_imports_other_facilities(
  requested_patient_id uuid, requested_before_created_at timestamptz, requested_before_id uuid,
  requested_limit integer
) returns table (import_id uuid, source_facility_id uuid, source_facility_name text, medication_text text,
  strength_text text, dose_text text, frequency_text text, historical_context text, activity_status text,
  created_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
#variable_conflict use_column
declare
  session_facility uuid := platform.current_facility_id();
  session_membership uuid := platform.current_membership_id();
  session_subject text := platform.current_actor_subject();
  session_purpose text := platform.current_purpose_of_use();
  access_row record;
  page jsonb;
  page_limit integer := least(greatest(coalesce(requested_limit, 50), 1), 100);
begin
  perform set_config('hid.other_facilities_refused', '', true);
  if requested_patient_id is null or session_facility is null or session_membership is null
     or session_subject is null or platform.current_account_id() is null
     or (requested_before_created_at is null) <> (requested_before_id is null) then
    raise exception using errcode = '22023', message = 'OTHER_FACILITIES_REQUEST_INVALID';
  end if;
  select * into access_row from identity.share_other_facilities_access(requested_patient_id, session_subject,
    session_membership, session_facility, session_purpose) access;
  if access_row.consent_grant_id is null then
    perform identity.cross_facility_read_audit('pharmacy.import.other-facilities.list',
      'pharmacy-imported-medication-other-facilities', requested_patient_id, null, 'denied',
      jsonb_build_object('reason', 'OTHER_FACILITIES_NOT_SHARED'));
    perform set_config('hid.other_facilities_refused', 'OTHER_FACILITIES_NOT_SHARED', true);
    return;
  end if;
  insert into pharmacy.other_facility_import_reads (transaction_id, patient_id)
  values (pg_current_xact_id(), requested_patient_id);
  select coalesce(jsonb_agg(jsonb_build_object('importId', picked.id, 'sourceFacilityId', picked.facility_id,
           'sourceFacilityName', picked.facility_name, 'medicationText', picked.medication_text,
           'strengthText', picked.strength_text, 'doseText', picked.dose_text, 'frequencyText', picked.frequency_text,
           'historicalContext', picked.historical_context, 'activityStatus', picked.activity_status,
           'createdAt', picked.created_at)
           order by picked.created_at desc, picked.id desc), '[]'::jsonb)
    into page
    from (
  select evidence.id, evidence.facility_id, facility.name as facility_name, evidence.medication_text,
         evidence.strength_text, evidence.dose_text, evidence.frequency_text, evidence.historical_context,
         evidence.activity_status, evidence.created_at
    from pharmacy.imported_medication_evidence evidence
    cross join lateral (select identity.cross_facility_source_name(requested_patient_id, evidence.facility_id)
                          as name) facility
   where evidence.patient_id = requested_patient_id
     and evidence.facility_id <> session_facility
     and facility.name is not null
     and (requested_before_created_at is null
          or (evidence.created_at, evidence.id) < (requested_before_created_at, requested_before_id))
     and (access_row.include_sensitive or not (
          identity.cross_facility_text_sensitive(facility.name)
          or identity.cross_facility_text_sensitive(evidence.medication_text)
          or identity.cross_facility_text_sensitive(evidence.strength_text)
          or identity.cross_facility_text_sensitive(evidence.dose_text)
          or identity.cross_facility_text_sensitive(evidence.frequency_text)
          or identity.cross_facility_text_sensitive(evidence.historical_context)))
   order by evidence.created_at desc, evidence.id desc
   limit page_limit) picked;
  delete from pharmacy.other_facility_import_reads read_row where read_row.transaction_id = pg_current_xact_id();
  perform identity.cross_facility_read_audit('pharmacy.import.other-facilities.list',
    'pharmacy-imported-medication-other-facilities', requested_patient_id, access_row.consent_grant_id, 'success',
    jsonb_build_object('returnedCount', jsonb_array_length(page),
      'importIds', coalesce((select jsonb_agg(item -> 'importId' order by position)
                               from jsonb_array_elements(page) with ordinality listed(item, position)), '[]'::jsonb),
      'sourceFacilityIds', coalesce((select jsonb_agg(distinct item -> 'sourceFacilityId')
                                       from jsonb_array_elements(page) listed(item)), '[]'::jsonb),
      'includeSensitive', access_row.include_sensitive, 'paged', requested_before_id is not null));
  return query select (item ->> 'importId')::uuid, (item ->> 'sourceFacilityId')::uuid, item ->> 'sourceFacilityName',
    item ->> 'medicationText', item ->> 'strengthText', item ->> 'doseText', item ->> 'frequencyText',
    item ->> 'historicalContext', item ->> 'activityStatus', (item ->> 'createdAt')::timestamptz
    from jsonb_array_elements(page) with ordinality listed(item, position)
   order by position;
end
$$;

comment on function pharmacy.patient_imports_other_facilities(uuid, timestamptz, uuid, integer) is
  '0124 (Q64 option A): a page (1-100, newest first, cursor created_at and id) of the patient''s pharmacy imports from other facilities on the patient''s side of the seal, for staff at the facility of an active patient share to their membership that includes other facilities (identity.share_other_facilities_access), purpose direct-care; never break-glass. Sensitive ones are left out unless the patient included them. One audit row per read; a refusal writes one denied audit row, sets hid.other_facilities_refused to OTHER_FACILITIES_NOT_SHARED and returns nothing.';

-- 8. Owners, policies, ACLs.
do $$
declare
  identity_owner name := (select pg_get_userbyid(relowner) from pg_class
                           where oid = 'identity.patient_consent_shares'::regclass);
  lab_owner name := (select pg_get_userbyid(relowner) from pg_class where oid = 'lab.imported_evidence'::regclass);
  pharmacy_owner name := (select pg_get_userbyid(relowner) from pg_class
                           where oid = 'pharmacy.imported_medication_evidence'::regclass);
  signature text;
begin
  if identity_owner <> current_user then
    execute format('alter table identity.patient_share_scopes owner to %I', identity_owner);
    foreach signature in array array['identity.patient_share_scopes_immutable()',
        'identity.cross_facility_text_sensitive(text)', 'identity.cross_facility_source_name(uuid,uuid)',
        'identity.share_other_facilities_access(uuid,text,uuid,uuid,text)',
        'identity.cross_facility_read_audit(text,text,uuid,uuid,text,jsonb)',
        'identity.create_my_consent_share_scoped(text,uuid,uuid,text,text,boolean,boolean,text,text)',
        'identity.list_my_share_scopes(text,uuid)'] loop
      execute format('alter function %s owner to %I', signature, identity_owner);
    end loop;
  end if;
  if lab_owner <> current_user then
    execute format('alter table lab.other_facility_import_reads owner to %I', lab_owner);
    execute format('alter function lab.patient_imports_other_facilities(uuid,timestamptz,uuid,integer) owner to %I',
      lab_owner);
  end if;
  if pharmacy_owner <> current_user then
    execute format('alter table pharmacy.other_facility_import_reads owner to %I', pharmacy_owner);
    execute format('alter function pharmacy.patient_imports_other_facilities(uuid,timestamptz,uuid,integer) '
      || 'owner to %I', pharmacy_owner);
  end if;
  execute format('create policy patient_share_scopes_owner on identity.patient_share_scopes for all '
    || 'using (current_user = %L) with check (current_user = %L)', identity_owner, identity_owner);
  execute format('create policy other_facility_import_reads_owner on lab.other_facility_import_reads for all to %I '
    || 'using (true) with check (true)', lab_owner);
  execute format('create policy other_facility_import_reads_owner on pharmacy.other_facility_import_reads '
    || 'for all to %I using (true) with check (true)', pharmacy_owner);
  -- The two reads' owners call the Identity helpers (granted to no runtime role).
  foreach signature in array array['identity.cross_facility_text_sensitive(text)',
      'identity.cross_facility_source_name(uuid,uuid)',
      'identity.share_other_facilities_access(uuid,text,uuid,uuid,text)',
      'identity.cross_facility_read_audit(text,text,uuid,uuid,text,jsonb)'] loop
    execute format('revoke all on function %s from public', signature);
    if lab_owner <> identity_owner then
      execute format('grant execute on function %s to %I', signature, lab_owner);
    end if;
    if pharmacy_owner <> identity_owner and pharmacy_owner <> lab_owner then
      execute format('grant execute on function %s to %I', signature, pharmacy_owner);
    end if;
  end loop;
end
$$;

-- The reads of other facilities' rows: for the import tables' owner only,
-- for the marked patient, while this transaction holds its marker.
-- ACCESS EXCLUSIVE for the policies, bounded.
do $$
declare
  lab_owner name := (select pg_get_userbyid(relowner) from pg_class where oid = 'lab.imported_evidence'::regclass);
  pharmacy_owner name := (select pg_get_userbyid(relowner) from pg_class
                           where oid = 'pharmacy.imported_medication_evidence'::regclass);
  attempt integer := 0;
begin
  loop
    attempt := attempt + 1;
    begin
      lock table lab.imported_evidence, lab.imported_observations, pharmacy.imported_medication_evidence
        in access exclusive mode nowait;
      exit;
    exception when lock_not_available then
      if attempt >= 500 then
        raise exception using errcode = '55P03',
          message = '0124: the import tables stayed busy for 5 seconds; run the release again later';
      end if;
      perform pg_sleep(0.01);
    end;
  end loop;
  execute format('create policy lab_imported_evidence_other_facilities on lab.imported_evidence for select to %I '
    || 'using (exists (select 1 from lab.other_facility_import_reads read_row '
    || 'where read_row.transaction_id = pg_current_xact_id_if_assigned() '
    || 'and read_row.patient_id = imported_evidence.patient_id))', lab_owner);
  execute format('create policy lab_imported_observations_other_facilities on lab.imported_observations '
    || 'for select to %I using (exists (select 1 from lab.other_facility_import_reads read_row '
    || 'where read_row.transaction_id = pg_current_xact_id_if_assigned() '
    || 'and read_row.patient_id = imported_observations.patient_id))', lab_owner);
  execute format('create policy pharmacy_imports_other_facilities on pharmacy.imported_medication_evidence '
    || 'for select to %I using (exists (select 1 from pharmacy.other_facility_import_reads read_row '
    || 'where read_row.transaction_id = pg_current_xact_id_if_assigned() '
    || 'and read_row.patient_id = imported_medication_evidence.patient_id))', pharmacy_owner);
end
$$;

comment on policy lab_imported_evidence_other_facilities on lab.imported_evidence is
  '0124: the import tables'' owner reads one patient''s lab imports at every facility only while this transaction holds that patient''s row in lab.other_facility_import_reads, which only lab.patient_imports_other_facilities writes, for its read alone.';
comment on policy lab_imported_observations_other_facilities on lab.imported_observations is
  '0124: as lab_imported_evidence_other_facilities, for the imports'' observations.';
comment on policy pharmacy_imports_other_facilities on pharmacy.imported_medication_evidence is
  '0124: the import table''s owner reads one patient''s pharmacy imports at every facility only while this transaction holds that patient''s row in pharmacy.other_facility_import_reads, which only pharmacy.patient_imports_other_facilities writes, for its read alone.';

revoke all on identity.patient_share_scopes, lab.other_facility_import_reads,
  pharmacy.other_facility_import_reads from public;
revoke all on function identity.patient_share_scopes_immutable(),
  identity.create_my_consent_share_scoped(text,uuid,uuid,text,text,boolean,boolean,text,text),
  identity.list_my_share_scopes(text,uuid),
  lab.patient_imports_other_facilities(uuid,timestamptz,uuid,integer),
  pharmacy.patient_imports_other_facilities(uuid,timestamptz,uuid,integer) from public;

-- Grants (here and in runtime-grants.sql).
do $$
declare
  role_name text;
begin
  foreach role_name in array array['hid_identity_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant execute on function '
        || 'identity.create_my_consent_share_scoped(text,uuid,uuid,text,text,boolean,boolean,text,text), '
        || 'identity.list_my_share_scopes(text,uuid) to %I', role_name);
    end if;
  end loop;
  foreach role_name in array array['hid_lab_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant execute on function lab.patient_imports_other_facilities(uuid,timestamptz,uuid,integer) '
        || 'to %I', role_name);
    end if;
  end loop;
  foreach role_name in array array['hid_pharmacy_runtime', 'hid_schema_test_runtime'] loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('grant execute on function '
        || 'pharmacy.patient_imports_other_facilities(uuid,timestamptz,uuid,integer) to %I', role_name);
    end if;
  end loop;
end
$$;

-- 9. Post-checks.
do $$
begin
  if exists (select 1 from pg_roles role_row
              where role_row.rolname like 'hid\_%' and role_row.rolname <> current_user
                and (has_table_privilege(role_row.oid, 'identity.patient_share_scopes', 'select,insert,update,delete')
                     or has_table_privilege(role_row.oid, 'lab.other_facility_import_reads', 'select,insert,update,delete')
                     or has_table_privilege(role_row.oid, 'pharmacy.other_facility_import_reads',
                          'select,insert,update,delete')
                     or has_function_privilege(role_row.oid, 'identity.share_other_facilities_access(uuid,text,uuid,uuid,text)', 'execute')
                     or has_function_privilege(role_row.oid, 'identity.cross_facility_read_audit(text,text,uuid,uuid,text,jsonb)', 'execute')
                     or has_function_privilege(role_row.oid, 'identity.cross_facility_source_name(uuid,uuid)', 'execute'))) then
    raise exception using errcode = '55000', message = '0124: a runtime role holds a privilege it must not';
  end if;
  if (select count(*) from pg_policy
       where polrelid in ('lab.imported_evidence'::regclass, 'lab.imported_observations'::regclass,
                          'pharmacy.imported_medication_evidence'::regclass)) <> 9
     or exists (select 1 from pg_policy
                 where polname in ('lab_imported_evidence_other_facilities', 'lab_imported_observations_other_facilities',
                                   'pharmacy_imports_other_facilities')
                   and (polcmd <> 'r' or cardinality(polroles) <> 1 or not polpermissive)) then
    raise exception using errcode = '55000', message = '0124: the new policies are not as written';
  end if;
end
$$;

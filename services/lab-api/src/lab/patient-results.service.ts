import { Injectable } from '@nestjs/common';
import { IdentityApiClient,IdentityApiProblem } from '@hid/api-client';
import { AuditService } from '../audit/audit.service';
import { LabWorkloadIdentityService } from '../auth/lab-workload-identity.service';
import { getEnvironment } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { DomainProblem } from '../common/problem';
import { requireRequestContext } from '../common/request-context';
import type { HidRequest } from '../common/request-context';

// Staff chat: every released current version, with the correction reason.
export const STAFF_LAB_QUERY = `select r.id, r.current_version::text||':'||rel.id::text version,t.name title,
 rel.released_at as "recordedAt",s.collected_at as "effectiveAt",
 jsonb_build_object('test',t.name,'codeSystem',t.code_system,'code',t.code,
 'specimen',s.specimen_type,'resultType',v.result_type,'numericValue',v.numeric_value::text,
 'textValue',v.text_value,'unit',v.unit,'referenceRange',v.reference_range,'recordedFlag',v.abnormal_flag,
 'revisionKind',v.revision_kind,'correctionReason',v.correction_reason,
 'collectedAt',s.collected_at,'releasedAt',rel.released_at,'verification','exact-version manually verified and released') fields
 from lab.results r join lab.result_revisions v on v.result_id=r.id and v.version=r.current_version
 and v.patient_id=r.patient_id and v.facility_id=r.facility_id
 join lab.result_releases rel on rel.result_id=r.id and rel.result_version=r.current_version
 and rel.patient_id=r.patient_id and rel.facility_id=r.facility_id
 join lab.result_verifications ver on ver.id=rel.verification_id and ver.result_id=r.id and ver.result_version=r.current_version
 and ver.patient_id=r.patient_id and ver.facility_id=r.facility_id
 join lab.test_executions e on e.id=r.execution_id and e.patient_id=r.patient_id and e.facility_id=r.facility_id
 join lab.work_item_requested_tests t on t.id=e.requested_test_id and t.patient_id=r.patient_id and t.facility_id=r.facility_id
 join lab.specimens s on s.id=e.specimen_id and s.patient_id=r.patient_id and s.facility_id=r.facility_id
 where r.patient_id=$1 and r.id::text>$2 and not exists(select 1 from lab.result_invalidations i
 where i.result_id=r.id and i.result_version=r.current_version and i.patient_id=r.patient_id)
 order by r.id::text limit 201`;

/*
 * Sensitive tests (S4), left out of the patient's own chat until a clinician
 * has discussed them. A constant default list for Ola to approve; it matches
 * the test pattern of ehr-api's patient-evidence.policy.ts, which filters the
 * same names again. No value from a request is interpolated.
 * SENSITIVE_LOINC_CODES (identical to ehr-api's) are left out when the code
 * system is LOINC, whatever the name: HIV 1+2 Ab/Ag and HIV 1 Ab, HIV 1 RNA
 * viral load, CD4 count, HBsAg, HCV Ab, hCG, PSA, AFP, CEA and CA-125. The
 * code system is LOINC by name or URL, or by its OID (LOINC_SYSTEM_SQL_PATTERN,
 * identical to ehr-api's).
 *
 * SENSITIVE_TEST_INITIALISMS, dottedInitialism and initialismForm are
 * ehr-api's, letter for letter: each initialism is also matched however its
 * letters are set apart, by dots, hyphens, spaces or any other mark, or by
 * nothing ("R.V.S.", "C.D.4", "H-I-V"), then digits only ("H.I.V1"), so "Hb
 * value" is not read as H-B-V. Only the plain fragments take letters after
 * them ("HIVAb"). Where a name has two or more parts, any marks or none may
 * set them apart ('[^a-z0-9]*'). The list is in ehr-api's order: the
 * fragments ehr-api also reads in a diagnosis's name, the initialism forms,
 * then the fragments it reads in test names only. So both services build one
 * pattern string: patient-results.query.spec.ts checks it is ehr-api's
 * string, and it and ehr-api's patient-evidence.query.spec.ts pin the same
 * sha256.
 */
export const SENSITIVE_TEST_INITIALISMS=[
  'hiv','aids','rvs','cd4','vl','hbv','hcv','hsv','hpv','vdrl','rpr','tpha','sti','std','hcg','bhcg','upt',
  'psa','afp','cea','phq','brca',
] as const;
/** An initialism with any run of marks that are not letters or digits, or none, between its letters: 'rvs' gives 'r[^a-z0-9]*v[^a-z0-9]*s'. */
export const dottedInitialism=(letters:string):string=>[...letters].join('[^a-z0-9]*');
/** dottedInitialism, then digits only: 'hiv' gives 'h[^a-z0-9]*i[^a-z0-9]*v[0-9]*'. */
export const initialismForm=(letters:string):string=>`${dottedInitialism(letters)}[0-9]*`;
export const SENSITIVE_TEST_SQL_PATTERN = '(^|[^a-z0-9])(?:'+[
  // "Anti" or "rapid" glued to HIV or HCV, and a kit's name glued to HIV, each by name: never '[a-z]*hiv' ("Archive").
  '(?:anti|rapid)?hiv[a-z0-9]*','(?:unigold|statpak|oraquick|determine)hiv[a-z0-9]*','aids','rvs','retro[^a-z0-9]*vir[a-z]*',
  'cd[^a-z0-9]*4[a-z0-9]*','viral[^a-z0-9]*loads?',
  'hepatit[a-z]*','hbsag','hbeag','anti[^a-z0-9]*hbc','hbc[^a-z0-9]*ab','hbv[a-z]*','(?:anti|rapid)?hcv[a-z]*',
  'syph[a-z]*','vdrls?','rprs?','tphas?','treponem[a-z]*','chlam[a-z]*','gonor[a-z]*','gonococc[a-z]*',
  'herpes','hsv[a-z0-9]*','trich?omon[a-z]*','stis?','stds?',
  '(?:beta|b|urine|serum)?hcgs?','upts?',
  '[ft]?psas?','afps?','ceas?','ca[^a-z0-9]*125','ca[^a-z0-9]*19[^a-z0-9]*9','ca[^a-z0-9]*15[^a-z0-9]*3','tumou?r[^a-z0-9]*markers?',
  'biops[a-z]*','histolog[a-z]*','histopath[a-z]*','cytolog[a-z]*','pap','pap[^a-z0-9]*smears?',
  'karyotyp[a-z]*','brca[0-9]*s?','genetic[a-z]*','genotyp[a-z]*',
  'phq[^a-z0-9]*[0-9]*','gad[^a-z0-9]*[27]','psych[a-z]*',
  // GAD only as the anxiety scales GAD-2 and GAD-7 ("G.A.D.-7"); "GAD", "GAD65" and "Anti-GAD65 antibody" stay shown.
  'g[^a-z0-9]*a[^a-z0-9]*d[^a-z0-9]*[27]',
  'vls?','hb[^a-z0-9]*electrophoresis','ha?emoglobin[^a-z0-9]*electrophoresis',
  'prostate[^a-z0-9]*specific','[a-z]*fetoprotein','carcino[^a-z0-9]*embryonic','cancer[^a-z0-9]*(?:ag|antigen)','chorionic',
  'choriogonadotrop[a-z]*','human[^a-z0-9]*immuno[^a-z0-9]*deficiency','hep[^a-z0-9]*[bc](?:[^a-z0-9]*[sec])?(?:[^a-z0-9]*a[gb])?',
  'hbs[^a-z0-9]*ag',
  // HIV rapid-test kits named alone (Determine, Uni-Gold and Stat-Pak: Nigeria's serial HIV algorithm; OraQuick:
  // self-testing). A facility's own test (0155) is hidden by its name only. "Determine" may run on into letters or
  // digits ("DetermineHIV"); the parts of the others may be set apart by any marks or none ("Uni.Gold", "Stat Pack").
  'determine[a-z0-9]*','uni[^a-z0-9]*gold','stat[^a-z0-9]*pac?k','ora[^a-z0-9]*quick',
  // Names that were missed (Ola, #258, 27 Nov 2026): hepatitis B markers; syphilis, CT/NG and HPV; cancer pathology
  // and tumour markers written out; HIV programme tests; panels, drug screens and paternity tests.
  'hbs[^a-z0-9]*ab','anti[^a-z0-9]*hbs','hbe[^a-z0-9]*ab','anti[^a-z0-9]*hbe','hbc[^a-z0-9]*igm','hbc[^a-z0-9]*ag',
  'tppas?','tp[^a-z0-9]*pa','t[^a-z0-9]*pallidum','fta[^a-z0-9]*abs','ct[^a-z0-9]*ng','hpv[a-z0-9]*',
  'fnac?s?','ihcs?','er[^a-z0-9]*pr','her[^a-z0-9]*2','frozen[^a-z0-9]*sections?',
  'alpha[^a-z0-9]*foe?to[^a-z0-9]*proteins?','ca[^a-z0-9]*72[^a-z0-9]*4',
  'eids?','recency','double[^a-z0-9]*check[^a-z0-9]*gold','insti',
  'pre[^a-z0-9]*marital','ante[^a-z0-9]*natal[^a-z0-9]*(?:profile|panel|screen[a-z]*)','anc[^a-z0-9]*(?:profile|panel)',
  'booking[^a-z0-9]*bloods?','drugs?[^a-z0-9]*(?:of[^a-z0-9]*abuse|screen[a-z]*)','urine[^a-z0-9]*drug[a-z]*','paternity',
  ...SENSITIVE_TEST_INITIALISMS.map(initialismForm),
  // Test wording only (ehr-api does not read these in a diagnosis's name): a pregnancy test however it is spelt, and
  // the genotype tests.
  'preg[a-z]*','sickl[a-z]*[^a-z0-9]*(?:cell[^a-z0-9]*)?(?:test|screen[a-z]*)','hb[^a-z0-9]*s[^a-z0-9]*solubility',
  'hgb[^a-z0-9]*electrophoresis','hb[^a-z0-9]*typing',
].join('|')+')($|[^a-z0-9])';
export const SENSITIVE_LOINC_CODES=[
  '75622-1','56888-1','7917-8','68961-2','20447-9','24467-3','5196-1','5195-3','16128-1','13955-0',
  '2106-3','21198-7','2119-6','2857-1','35741-8','1834-1','19176-1','2039-6','10334-1',
  '7918-6','29893-5','31201-7','5221-7','10351-5','25836-8','2118-8','19080-2',
] as const;
export const LOINC_SYSTEM_SQL_PATTERN='(loinc|(^|[^0-9.])2[.]16[.]840[.]1[.]113883[.]6[.]1($|[^0-9.]))';
/** Codes hold only digits and a hyphen, so the quoted list cannot break out of the SQL. */
export const SENSITIVE_LOINC_SQL_LIST=SENSITIVE_LOINC_CODES.map(code=>`'${code}'`).join(',');

/*
 * The patient's own released results. The latest release of each result is
 * found first. When it is the current version, the row is as staff see it,
 * less the lab's correction reason. When a correction is pending (the current
 * version is not released yet), the patient gets a placeholder that says the
 * lab is correcting the result and carries no value. A result whose current or
 * last released version was entered in error is left out, and so is a
 * sensitive test.
 */
export const PATIENT_SELF_LAB_QUERY = `select r.id,
 case when rel.result_version=r.current_version then r.current_version::text||':'||rel.id::text
 else r.current_version::text||':pending:'||rel.id::text end version,t.name title,
 rel.released_at as "recordedAt",s.collected_at as "effectiveAt",
 case when rel.result_version=r.current_version then jsonb_build_object('test',t.name,'codeSystem',t.code_system,'code',t.code,
 'specimen',s.specimen_type,'resultType',v.result_type,'numericValue',v.numeric_value::text,
 'textValue',v.text_value,'unit',v.unit,'referenceRange',v.reference_range,'recordedFlag',v.abnormal_flag,
 'revisionKind',v.revision_kind,
 'collectedAt',s.collected_at,'releasedAt',rel.released_at,'verification','exact-version manually verified and released')
 else jsonb_build_object('test',t.name,'codeSystem',t.code_system,'code',t.code,'specimen',s.specimen_type,
 'collectedAt',s.collected_at,'correctionPending',true,'status','The lab is correcting this result.') end fields
 from lab.results r
 join lateral(select x.id,x.result_version,x.released_at,x.verification_id from lab.result_releases x
 where x.result_id=r.id and x.patient_id=r.patient_id and x.facility_id=r.facility_id
 order by x.result_version desc limit 1) rel on true
 join lab.result_revisions v on v.result_id=r.id and v.version=rel.result_version
 and v.patient_id=r.patient_id and v.facility_id=r.facility_id
 join lab.result_verifications ver on ver.id=rel.verification_id and ver.result_id=r.id and ver.result_version=rel.result_version
 and ver.patient_id=r.patient_id and ver.facility_id=r.facility_id
 join lab.test_executions e on e.id=r.execution_id and e.patient_id=r.patient_id and e.facility_id=r.facility_id
 join lab.work_item_requested_tests t on t.id=e.requested_test_id and t.patient_id=r.patient_id and t.facility_id=r.facility_id
 join lab.specimens s on s.id=e.specimen_id and s.patient_id=r.patient_id and s.facility_id=r.facility_id
 where r.patient_id=$1 and r.id::text>$2 and not exists(select 1 from lab.result_invalidations i
 where i.result_id=r.id and i.result_version=r.current_version and i.patient_id=r.patient_id)
 and not exists(select 1 from lab.result_invalidations i
 where i.result_id=r.id and i.result_version=rel.result_version and i.patient_id=r.patient_id)
 and coalesce(t.name,'') !~* '${SENSITIVE_TEST_SQL_PATTERN}'
 and not (btrim(coalesce(t.code_system,'')) ~* '${LOINC_SYSTEM_SQL_PATTERN}' and btrim(coalesce(t.code,'')) in (${SENSITIVE_LOINC_SQL_LIST}))
 order by r.id::text limit 201`;

@Injectable()
export class PatientResultsService {
  private readonly identity:IdentityApiClient;
  constructor(private readonly database:DatabaseService,workload:LabWorkloadIdentityService,private readonly audit:AuditService) {
    this.identity=new IdentityApiClient({baseUrl:getEnvironment().IDENTITY_API_URL,caller:'lab-api',timeoutMs:5000,workloadHeaders:()=>workload.identityHeaders()});
  }
  async readStaff(request:HidRequest,patientId:string,cursor='') {
    if(cursor&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(cursor))
      throw new DomainProblem(400,'INVALID_CURSOR','Invalid record cursor');
    if(request.actor?.kind==='patient'||!request.actor?.sessionId||!request.actor.permissions.includes('lab.result.released.read'))
      throw new DomainProblem(403,'PERMISSION_DENIED','Required Lab permission is missing');
    if(request.header('x-purpose-of-use')!=='direct-care') throw new DomainProblem(400,'PURPOSE_OF_USE_REQUIRED','Direct care is required');
    const context=requireRequestContext(request,'direct-care');
    const decision=await this.identity.authorizeStaffRecordRead(patientId,{
      correlationId:request.correlationId,facilityId:context.facilityId,purposeOfUse:'direct-care',
      authorization:context.authorization,cookie:context.userCookie,csrfToken:context.csrfToken,origin:context.origin,
    }).catch(error=>{if(error instanceof IdentityApiProblem)throw new DomainProblem(error.status,error.code??'PATIENT_ACCESS_DENIED',error.message);
      throw new DomainProblem(503,'IDENTITY_SERVICE_UNAVAILABLE','Patient authorization is unavailable');});
    if(!decision.allowed||decision.breakGlass||decision.patientId!==patientId||decision.facilityId!==context.facilityId
      ||decision.membershipId!==context.membershipId) throw new DomainProblem(403,'PATIENT_ACCESS_DENIED','Patient access is not authorized');
    return this.database.withTransaction(context,async client=>{
      const rows=(await client.query(STAFF_LAB_QUERY,[patientId,cursor])).rows;
      const records=rows.slice(0,200);
      await this.audit.recordWithClient(client,{correlationId:request.correlationId,actorType:'staff',actorSubject:context.actor.subject,
        actorAccountId:context.actor.accountId,actorMembershipId:context.membershipId,facilityId:context.facilityId,
        organizationId:context.actor.facility?.organizationId,patientId,action:'lab.staff.chat.released-results.read',
        resourceType:'released-result-collection',outcome:'success',purposeOfUse:'direct-care',details:{recordCount:records.length}});
      return {records,nextCursor:rows.length>200?records.at(-1)!.id:null};
    });
  }
  async read(request:HidRequest,cursor='') {
    if (cursor && !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(cursor)) throw new DomainProblem(400,'INVALID_CURSOR','Invalid record cursor');
    const actor=request.actor;
    if (actor?.kind!=='patient'||!actor.patientId||!actor.sessionId) throw new DomainProblem(403,'PATIENT_SESSION_REQUIRED','An active patient session is required');
    const auth=await this.identity.authorizePatientSelf({correlationId:request.correlationId,
      authorization:request.header('authorization'),cookie:request.header('cookie'),origin:request.header('origin')})
      .catch(error=>{if(error instanceof IdentityApiProblem)throw new DomainProblem(error.status,error.code??'PATIENT_ACCESS_DENIED',error.message);
        throw new DomainProblem(503,'IDENTITY_SERVICE_UNAVAILABLE','Patient authorization is unavailable');});
    if(auth.patientId!==actor.patientId||auth.accountId!==actor.accountId||auth.subject!==actor.subject||auth.sessionId!==actor.sessionId)
      throw new DomainProblem(403,'PATIENT_ACCESS_DENIED','Patient authorization changed');
    return this.database.withPatientTransaction(auth,request.correlationId,async client=>{
      const rows=(await client.query(PATIENT_SELF_LAB_QUERY,[auth.patientId,cursor])).rows;
      const records=rows.slice(0,200);
      await this.audit.recordWithClient(client,{correlationId:request.correlationId,actorType:'patient',actorSubject:auth.subject,
        actorAccountId:auth.accountId,patientId:auth.patientId,action:'lab.patient.released-results.read',resourceType:'released-result-collection',
        outcome:'success',purposeOfUse:'patient-self',details:{recordCount:records.length}});
      return {records,nextCursor:rows.length>200?records.at(-1)!.id:null};
    });
  }
}

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
 * SENSITIVE_TEST_FRAGMENTS in ehr-api's patient-evidence.policy.ts, which
 * filters the same names again. No value from a request is interpolated.
 * SENSITIVE_LOINC_CODES (identical to ehr-api's) are left out when the code
 * system is LOINC, whatever the name: HIV 1+2 Ab/Ag and HIV 1 Ab, HIV 1 RNA
 * viral load, CD4 count, HBsAg, HCV Ab, hCG, PSA, AFP, CEA and CA-125; Q28:
 * HPV DNA, HCV RNA and its viral load, ethanol, MMSE, AUDIT and AUDIT-C. The
 * code system is LOINC by name or URL, or by its OID (LOINC_SYSTEM_SQL_PATTERN,
 * identical to ehr-api's).
 */
export const SENSITIVE_TEST_SQL_PATTERN = '(^|[^a-z0-9])(?:'+[
  'hiv[a-z0-9]*','aids','rvs','retrovir[a-z]*','cd[ -]?4[a-z0-9]*','viral[ -]?loads?',
  'hepatitis','hbsag','hbeag','anti[ -]?hbc','hbc[ -]?ab','hbv[a-z]*','hcv[a-z]*',
  'syphili[a-z]*','vdrl','rpr','tpha','treponem[a-z]*','chlamydi[a-z]*','gonorr[a-z]*','gonococc[a-z]*',
  'herpes','hsv[a-z0-9]*','trichomon[a-z]*','sti','std',
  'b?hcg','pregnan[a-z]*','upt',
  'psa','afp','cea','ca[ .-]?125','ca[ .-]?19[ .-]?9','ca[ .-]?15[ .-]?3','tumou?r[ -]?markers?',
  'biops[a-z]*','histolog[a-z]*','histopath[a-z]*','cytolog[a-z]*','pap','pap[ -]?smears?',
  'karyotyp[a-z]*','brca[0-9]*','genetic[a-z]*','genotyp[a-z]*',
  'phq[ -]?[0-9]*','gad[ -]?[0-9]+','psych[a-z]*',
  'vl','hb[ -]?electrophoresis','ha?emoglobin[ -]?electrophoresis',
  'prostate[ -]specific','[a-z]*fetoprotein','carcinoembryonic','cancer[ -]?(?:ag|antigen)','chorionic','choriogonadotrop[a-z]*',
  'human[ -]*immuno[ -]*deficiency','hep[ .-]*[bc](?:[ .-]*[sec])?(?:[ .-]*a[gb])?','hbs[ -]?ag','h[ .]+i[ .]+v',
  // Q28 (Ola): HPV DNA, Mycoplasma genitalium, urine drug screens and blood alcohol, prenatal screening (NIPT),
  // bone marrow and flow cytometry, AUDIT, CAGE and MMSE. HBV DNA and HCV RNA are caught above; TB tests stay off.
  'hpv[a-z0-9]*','(?:human[ -]?)?papilloma[ -]?virus[a-z]*','genitalium','mgen',
  'papanicolaou','h[ .]*p[ .]*v','m[ .]+gen','r[ .]+v[ .]+s',
  // ehr-api's TEST_NAME_ONLY_FRAGMENTS (matched for tests only there, never in diagnosis text), with the lab menu spellings:
  'drugs?[ -]+(?:of[ -]+abuse[ -]*)?screen[a-z]*','drugs?[ -]+of[ -]+abuse','toxicolog[a-z]*','tox[ -]?screen[a-z]*','uds',
  'benzodiazepines?','opiates?','opioids?','cannabi[a-z]*','thc','(?:meth)?amphetamines?','cocaine','benzoylecgonine',
  'ethanol','(?:blood|serum|plasma|breath|urine)[ -]+alcohol','alcohol[ -]+(?:level|screen[a-z]*|test)',
  'drugs?[ -]+(?:tests?|testing|panel[a-z]*)','urine[ -]+for[ -]+drugs?','codeine','tramadol','morphine','methadone','buprenorphine',
  'fentanyl','barbiturates?','marijuana','indian[ -]+hemp','mdma','ecstasy','ketamine','alcohol[ ,-]+(?:blood|serum|plasma|breath|urine)',
  'bac','etoh',
  'nipt','non[ -]?invasive[ -]+pre[ -]?natal','cell[ -]?free[ -]+(?:fetal[ -]+|foetal[ -]+)?dna','cf[ -]?dna','trisom[a-z]*',
  'aneuploid[a-z]*','pre[ -]?natal[ -]+screen[a-z]*','pre[ -]?natal','ante[ -]?natal[a-z]*',
  'anc[ -]+(?:profile|panel|screen[a-z]*|bloods?|booking|tests?)','down(?:[^a-z0-9 ]?s)?[ -]+syndrome[ -]+(?:screen[a-z]*|risk|tests?)',
  'quad(?:ruple)?[ -]+(?:tests?|screen[a-z]*|markers?)','triple[ -]+(?:tests?|screen[a-z]*|markers?)',
  'harmony[ -]+(?:tests?|prenatal|screen[a-z]*)','trimester','nuchal[a-z]*',
  'bone[ -]?marrow','marrow','bma','bmat','bmb','bm[ -]+(?:aspirat[a-z]*|biops[a-z]*|trephine|exam[a-z]*)','trephine',
  'flow[ -]?cytometr[a-z]*','immunophenotyp[a-z]*',
  'audit(?:[ -]?c)?','cage','mmse','mini[ -]?mental[a-z]*','lbc',
].join('|')+')($|[^a-z0-9])';
export const SENSITIVE_LOINC_CODES=[
  '75622-1','56888-1','7917-8','68961-2','20447-9','24467-3','5196-1','5195-3','16128-1','13955-0',
  '2106-3','21198-7','2119-6','2857-1','35741-8','1834-1','19176-1','2039-6','10334-1',
  '7918-6','29893-5','31201-7','5221-7','10351-5','25836-8','2118-8','19080-2',
  '21440-3','30167-1','11259-9','11011-4','5640-8','5643-2','72107-6','75624-7','75626-2',
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
 * last released version was entered in error is left out.
 *
 * Patient chat part 2 (0107, owner Q24): lab.patient_self_result_gates gives,
 * for each of the patient's results, its last released version, whether its
 * visit is finished and whether a clinician's "Discussed with the patient"
 * mark is active on that version. Only results from a finished visit are read
 * (a completed encounter, a request that is active, on hold or completed, and
 * a route that did not end wrong_patient or entered_in_error). A gated result
 * (a sensitive test by the list above, or a critical result, both judged on
 * the last released version `v`) is read only while that version is marked
 * discussed; `_discussed` tells ehr-api's policy so. The staff query is
 * unchanged and keeps full access.
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
 'collectedAt',s.collected_at,'correctionPending',true,'status','The lab is correcting this result.') end
 ||jsonb_build_object('_discussed',g.discussed) fields
 from lab.results r
 join lateral(select x.id,x.result_version,x.released_at,x.verification_id from lab.result_releases x
 where x.result_id=r.id and x.patient_id=r.patient_id and x.facility_id=r.facility_id
 order by x.result_version desc limit 1) rel on true
 join lab.patient_self_result_gates($1) g on g.result_id=r.id and g.released_version=rel.result_version
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
 and g.finished_visit
 and (g.discussed or not (coalesce(t.name,'') ~* '${SENSITIVE_TEST_SQL_PATTERN}'
 or (btrim(coalesce(t.code_system,'')) ~* '${LOINC_SYSTEM_SQL_PATTERN}' and btrim(coalesce(t.code,'')) in (${SENSITIVE_LOINC_SQL_LIST}))
 or v.abnormal_flag='critical_candidate'))
 order by r.id::text limit 201`;

const SENSITIVE_TEST=new RegExp(SENSITIVE_TEST_SQL_PATTERN,'i');
const LOINC_SYSTEM=new RegExp(LOINC_SYSTEM_SQL_PATTERN,'i');
const LOINC_CODES=new Set<string>(SENSITIVE_LOINC_CODES);
const text=(value:unknown)=>typeof value==='string'?value:'';
/**
 * Whether a result is held back from the patient chat until a clinician marks
 * it "Discussed with the patient": a sensitive test (the same list as the
 * patient query; the code is also matched, as ehr-api's isSensitiveTest does,
 * so every result either service holds back can be marked) or a critical
 * result. Judged on the last released version.
 */
export function isGatedLabResult(name:unknown,code:unknown,codeSystem:unknown,abnormalFlag:unknown):{sensitive:boolean;critical:boolean} {
  const sensitive=SENSITIVE_TEST.test(text(name))||SENSITIVE_TEST.test(text(code))
    ||(LOINC_SYSTEM.test(text(codeSystem).trim())&&LOINC_CODES.has(text(code).trim()));
  return {sensitive,critical:abnormalFlag==='critical_candidate'};
}

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

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
 * sha256. Like ehr-api's, the fragments use only syntax that means the same
 * in PostgreSQL and JavaScript, {m,n} and one look-ahead, (?!ydophila),
 * included.
 */
export const SENSITIVE_TEST_INITIALISMS=[
  'hiv','aids','rvs','rvst','cd4','vl','hbv','hcv','hsv','hpv','vdrl','rpr','tpha','sti','std','hcg','bhcg','upt',
  'psa','afp','cea','phq','brca','pmtct',
] as const;
/** An initialism with any run of marks that are not letters or digits, or none, between its letters: 'rvs' gives 'r[^a-z0-9]*v[^a-z0-9]*s'. */
export const dottedInitialism=(letters:string):string=>[...letters].join('[^a-z0-9]*');
/** dottedInitialism, then digits only: 'hiv' gives 'h[^a-z0-9]*i[^a-z0-9]*v[0-9]*'. */
export const initialismForm=(letters:string):string=>`${dottedInitialism(letters)}[0-9]*`;
export const SENSITIVE_TEST_SQL_PATTERN = '(^|[^a-z0-9])(?:'+[
  // "Anti" or "rapid" glued to HIV or HCV, and a kit's name glued to HIV, each by name: never '[a-z]*hiv' ("Archive").
  '(?:anti|rapid)?hiv[a-z0-9]*','(?:unigold|statpak|oraquick|determine)hiv[a-z0-9]*','aids','rvs','retro[^a-z0-9]*vir[a-z]*',
  'cd[^a-z0-9]*4[a-z0-9]*','viral[^a-z0-9]*loa?ds?',
  'hepatit[a-z]*','hbsag','hbe[^a-z0-9]*ag','anti[^a-z0-9]*hbc','hbc[^a-z0-9]*ab','hbv[a-z]*','(?:anti|rapid)?hcv[a-z]*',
  // 'chlam' is not read in "Chlamydophila", a cause of pneumonia ('(?!ydophila)' looks ahead, the same in SQL and JS).
  'syph[a-z]*','vdrls?','rprs?','tphas?','treponem[a-z]*','chlam(?!ydophila)[a-z]*','gonor[a-z]*','gonococc[a-z]*',
  'herpes','hsv[a-z0-9]*','trich?omon[a-z]*','stis?','stds?',
  '(?:beta|b|urine|serum)?hcgs?','upts?',
  '[ft]?psas?','afps?','ceas?','ca[^a-z0-9]*125','ca[^a-z0-9]*19[^a-z0-9]*9','ca[^a-z0-9]*15[^a-z0-9]*3','tumou?r[^a-z0-9]*markers?',
  // Pap smear: "Pap", "Paps", "PAP's", and a Pap or Paps smear or test with any marks or none between ("Paps smear").
  'biops[a-z]*','histolog[a-z]*','histopath[a-z]*','cytolog[a-z]*','paps?','paps?[^a-z0-9]*(?:smears?|tests?)',
  'karyotyp[a-z]*','brca[0-9]*s?','genetic[a-z]*','genotyp[a-z]*',
  'phq[^a-z0-9]*[0-9]*','gad[^a-z0-9]*[27]','psych[a-z]*',
  // GAD only as the anxiety scales GAD-2 and GAD-7 ("G.A.D.-7"); "GAD", "GAD65" and "Anti-GAD65 antibody" stay shown.
  'g[^a-z0-9]*a[^a-z0-9]*d[^a-z0-9]*[27]',
  'vls?','hb[^a-z0-9]*electrophoresis','ha?emoglobin[^a-z0-9]*electrophoresis',
  'prostate[^a-z0-9]*specific','[a-z]*fetoprotein','carcino[^a-z0-9]*embryonic','cancer[^a-z0-9]*(?:ag|antigen|screen[a-z]*)',
  'chorionic','choriogonadotrop[a-z]*','human[^a-z0-9]*immuno[^a-z0-9]*deficiency',
  // Hep A to Hep E, with any marks or none ("Hep A", "Hep-B", "HepC", "Hep. B s Ag").
  'hep[^a-z0-9]*[abcde](?:[^a-z0-9]*[sec])?(?:[^a-z0-9]*a[gb])?',
  'hbs[^a-z0-9]*ag',
  // HIV rapid-test kits named alone (Determine, Uni-Gold and Stat-Pak: Nigeria's serial HIV algorithm; OraQuick:
  // self-testing). A facility's own test (0155) is hidden by its name only. "Determine" may run on into letters or
  // digits ("DetermineHIV"); the parts of the others may be set apart by any marks or none ("Uni.Gold", "Stat Pack").
  'determine[a-z0-9]*','uni[^a-z0-9]*gold','stat[^a-z0-9]*pac?k','ora[^a-z0-9]*quick',
  // Names that were missed (Ola, #258, 27 Nov 2026): hepatitis B markers; syphilis, CT/NG and HPV; cancer pathology
  // and tumour markers written out; HIV programme tests; panels, drug screens and paternity tests.
  'hbs[^a-z0-9]*ab','anti[^a-z0-9]*hbs','hbe[^a-z0-9]*ab','anti[^a-z0-9]*hbe','hbc[^a-z0-9]*igm','hbc[^a-z0-9]*ag',
  // TP-PA takes only a space, dot or hyphen, so "TP & PA" and "TP/PA" (two tests side by side) are shown.
  'tppas?','tp[ .-]?pa','t[^a-z0-9]*pallidum','fta[^a-z0-9]*abs','ct[^a-z0-9]*(?:ng|gc)','(?:ng|gc)[^a-z0-9]*ct',
  'hpv[a-z0-9]*',
  'fnac?s?','ihcs?','er[^a-z0-9]*pr','her[^a-z0-9]*2(?:[^a-z0-9]*neu)?','frozen[^a-z0-9]*sections?',
  'alpha[^a-z0-9]*fo?e?to[^a-z0-9]*proteins?','ca[^a-z0-9]*72[^a-z0-9]*4',
  'eids?','recency','double[^a-z0-9]*check[^a-z0-9]*gold','insti',
  // An antenatal, prenatal, ANC, booking or obstetric panel, with up to three words between its first and last words.
  'pre[^a-z0-9]*marital',
  '(?:(?:ante|pre)[^a-z0-9]*natal|anc|booking|obstetric[a-z]*)(?:[^a-z0-9]+(?:[a-z0-9]+[^a-z0-9]+){0,3})?'
    +'(?:profiles?|panels?|screen[a-z]*|tests?|investigations?|labs?|bloods?|booking)',
  'drugs?[^a-z0-9]*(?:(?:of[^a-z0-9]*)?abuse(?:[^a-z0-9]*(?:screen[a-z]*|panels?))?|screen[a-z]*)','urine[^a-z0-9]*drug[a-z]*','paternity',
  // Ola's second list (#258, 27 Nov 2026), as in ehr-api: every name of a national lab test the list already hid by
  // another name (bone marrow aspirate, cervical smear, "Cyto stain", TORCH, T helper cells); hepatitis misspelt, A, D
  // and E, HBs and HBe antigens set apart, Australia antigen; HIV typos and tests, CrAg and TB-LAM (advanced HIV
  // disease) and the other names of those two national tests; other STIs; pregnancy screening; cancer tests. Ola's
  // third list (27 Nov) added bone marrow (or BM) trephine and biopsy, and hides a wet mount or prep only when it is
  // vaginal (vaginal, HVS or high vaginal swab before it, or vaginal, HVS or TV up to two words before or after it):
  // a stool, urine, skin, semen or KOH wet mount is shown, and so are "Wet mount", "Wet prep" and "Saline wet mount".
  '(?:bone[^a-z0-9]*marrow|bm)[^a-z0-9]*(?:aspirat[a-z]*|trephines?|biops[a-z]*)','bmas?',
  'cervi(?:cal|x)[^a-z0-9]*(?:smears?|screen[a-z]*)','cyto[^a-z0-9]*stain[a-z]*','torch','t[^a-z0-9]*helper',
  '(?:vaginal|hvs|high[^a-z0-9]*vaginal(?:[^a-z0-9]*swab)?)[^a-z0-9]*(?:(?:saline|koh)[^a-z0-9]*)?wet[^a-z0-9]*(?:mount|prep[a-z]*)',
  '(?:vaginal|hvs|tv)(?:[^a-z0-9]+[a-z]+){1,2}[^a-z0-9]+wet[^a-z0-9]*(?:mount|prep[a-z]*)',
  'tv[^a-z0-9]*wet[^a-z0-9]*(?:mount|prep[a-z]*)',
  'wet[^a-z0-9]*(?:mount|prep[a-z]*)(?:[^a-z0-9]+[a-z]+){0,2}[^a-z0-9]+(?:vaginal|hvs|tv)',
  'hep[a-z]{0,3}t[aiy]t[aiy]s','(?:anti)?h[ade]v(?:ab|ag|igg|igm|rna)?','hb[^a-z0-9]*s[^a-z0-9]*ag',
  'australia[^a-z0-9]*(?:antigen|ag)',
  'h[1l]v[a-z0-9]*','retro[^a-z0-9]*(?:screen[a-z]*|tests?)','p[^a-z0-9]*24[^a-z0-9]*(?:antigen|ag)','western[^a-z0-9]*blots?',
  'lag[^a-z0-9]*avidity','infant[^a-z0-9]*dna[^a-z0-9]*pcr','cr[^a-z0-9]*ags?','(?:tb|lf)[^a-z0-9]*lam',
  'cryptococ[a-z]*(?:[^a-z0-9]+[a-z]+)?[^a-z0-9]+(?:antigen|ag)','lipoarabinomannan',
  // Ola's third list: AlereLAM, urine LAM ("LAM" alone is a test-only word below), crypto Ag or antigen, CSF crypto...,
  // and India ink (LAB-0087).
  '(?:alere|urine)[^a-z0-9]*lam','crypto[^a-z0-9]*(?:antigen|ag)','csf[^a-z0-9]*crypto[a-z]*','india[^a-z0-9]*ink',
  's[iy][pf]h?[iy]l[a-z]*','vener[a-z]*','v[^a-z0-9]*d[^a-z0-9]*screen[a-z]*','gc[^a-z0-9]*cultures?','clamyd[a-z]*',
  '(?:c[^a-z0-9]*)?trachomatis','t[^a-z0-9]*vaginalis','human[^a-z0-9]*papilloma[^a-z0-9]*vir[a-z]*',
  'nipts?','triple[^a-z0-9]*tests?','quad(?:ruple)?[^a-z0-9]*(?:screen[a-z]*|tests?)','papp[^a-z0-9]*a',
  'immuno[^a-z0-9]*histochem[a-z]*','fine[^a-z0-9]*needle[^a-z0-9]*aspirat[a-z]*','o?estrogen[^a-z0-9]*receptors?',
  'progesterone[^a-z0-9]*receptors?','hormone[^a-z0-9]*receptors?[^a-z0-9]*status','er[^a-z0-9]*status','ki[^a-z0-9]*67',
  'ca[^a-z0-9]*27[^a-z0-9]*29','cytopath[a-z]*','bcr[^a-z0-9]*abl[0-9]*',
  'bence[^a-z0-9]*jones?','bjps?','cell[^a-z0-9]*blocks?','lbcs?','malignan[a-z]*[^a-z0-9]*screen[a-z]*',
  // Ola's third list (#258, 27 Nov 2026), as in ehr-api. Flow cytometry alone is shown (it also counts reticulocytes
  // and platelets). VIA screening: VIA/VILI, VILI, a VIA screen; VIA alone and "Glucose via test strip" are shown.
  'via[^a-z0-9]*(?:and[^a-z0-9]*)?vili','vili','via[^a-z0-9]*screen[a-z]*',
  // Tumour markers (not beta-2 microglobulin): HE4, ROMA, NSE, Cyfra 21-1, SCC antigen, CA 242, chromogranin (A),
  // immunophenotyping, a leukaemia or lymphoma panel, free light chains.
  'he[^a-z0-9]*4','roma','nse','cyfra(?:[^a-z0-9]*21[^a-z0-9]*1)?','scc[^a-z0-9]*(?:antigen|ag)','ca[^a-z0-9]*242',
  'chromogranin(?:[^a-z0-9]*a)?','immuno[^a-z0-9]*phenotyp[a-z]*','(?:leuka?emia|lymphoma)[^a-z0-9]*panels?',
  'free[^a-z0-9]*light[^a-z0-9]*chains?',
  // HIV programme tests: PrEP labs, screening, monitoring or baseline ("KOH prep" is shown); ART monitoring or
  // (baseline) labs; HTS, VCT and PITC as whole words.
  'prep[^a-z0-9]*(?:labs?|screen[a-z]*|monitoring|baseline)','art[^a-z0-9]*(?:baseline[^a-z0-9]*)?(?:monitoring|labs?)',
  'hts','vct','pitc',
  // Relationship and assault tests: maternity, sibling and kinship DNA tests, sexual assault, rape kit, forensic swabs.
  'maternity[^a-z0-9]*(?:dna[^a-z0-9]*)?tests?','sibling[^a-z0-9]*dna','dna[^a-z0-9]*(?:relationship|kinship)',
  'kinship[^a-z0-9]*(?:dna|tests?|analysis)','sexual[^a-z0-9]*assault','rape[^a-z0-9]*kits?','forensic[^a-z0-9]*swabs?',
  ...SENSITIVE_TEST_INITIALISMS.map(initialismForm),
  // Test wording only (ehr-api does not read these in a diagnosis's name): pregnancy tests ("preg" as a word,
  // pregnan..., misspellings, "Serum PT" and "Urine PT"; "Pregnenolone" is shown, and so is "PT" alone, which is
  // prothrombin time to every clinician); "LAM" alone (urine TB LAM); the genotype tests; DBS; mental health and drug
  // tests by their test names; lithium and clozapine levels.
  'preg','pregnan[a-z]*','pr[ae]g?n?[ae]n?cy[a-z]*','(?:serum|urine)[^a-z0-9]*p[^a-z0-9]*t',
  'lam',
  'sickl(?:ing|edex)(?:[^a-z0-9]*(?:preps?|tests?))?','sickl[a-z]*[^a-z0-9]*(?:cell[^a-z0-9]*)?(?:tests?|screen[a-z]*|status)',
  '(?:sickl[a-z]*|h(?:a?emoglobin|gb|b)[^a-z0-9]*s)(?:[^a-z0-9]+[a-z]+){0,5}[^a-z0-9]*solubility',
  'hgb[^a-z0-9]*electrophoresis','hb[^a-z0-9]*typing','h(?:a?emoglobin|gb|b)[^a-z0-9]*(?:variants?|hplc|pattern)',
  'ha?emoglobinopath[a-z]*[^a-z0-9]*(?:screen[a-z]*|tests?)',
  'dbs(?:[^a-z0-9]*pcr)?',
  '(?:depression|anxiety)[^a-z0-9]*screen[a-z]*','epds','hads','mental[^a-z0-9]*status','tox(?:icology)?[^a-z0-9]*screen[a-z]*',
  'urine[^a-z0-9]*tox(?:icology)?','uds','doas?',
  '(?:cannabis|thc|opiates?|cocaine|amphetamines?|benzodiazepines?)[^a-z0-9]*(?:screen[a-z]*|tests?)',
  'lithium[^a-z0-9]*(?:levels?|assay)','clozapine(?:[^a-z0-9]*levels?)?',
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

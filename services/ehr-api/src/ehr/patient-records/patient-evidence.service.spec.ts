import type { PoolClient } from 'pg';
import { PatientEvidenceService } from './patient-evidence.service';
import { PATIENT_EVIDENCE_QUERY } from './patient-evidence.query';
import { NOT_CHECKED_LINE, sourceView } from './patient-chat-safety';

// PATIENT_ENTRIES_ENABLED (0116), off unless a test turns it on.
let mockEntriesEnabled=false;
jest.mock('../patient-entries/patient-entries.flag',()=>({patientEntriesEnabled:()=>mockEntriesEnabled}));
afterEach(()=>{mockEntriesEnabled=false;});

const patientId='11111111-1111-4111-8111-111111111111';
const auth={patientId,subject:'subject-a',accountId:'account-a',sessionId:'session-a',expiresAt:new Date(Date.now()+30000).toISOString()};
const row=(kind:string,id:string,origin_hint:string|null)=>({kind,id,version:'1',title:`Synthetic ${kind}`,recorded_at:new Date('2026-10-01T00:00:00Z'),
  effective_at:null,provenance:'Synthetic provenance',quality:'recorded',fields:{text:'Synthetic content',...(kind==='note'?{_encounterStatus:'completed'}:{})},origin_hint,patient_id:patientId});
function setup(rows:unknown[],profile:Record<string,unknown>={patientId,version:3}) {
  const query=jest.fn().mockResolvedValue({rows});
  const database={withPatientTransaction:async(_a:unknown,_c:string,work:(c:PoolClient)=>Promise<unknown>)=>work({query} as unknown as PoolClient)};
  const records={authorizeSelf:jest.fn().mockResolvedValue(auth)};
  const lab={patientReleasedResults:jest.fn().mockResolvedValue({records:[{id:'33333333-3333-4333-8333-333333333333',version:'1',title:'Synthetic result',
    recordedAt:'2026-10-02T00:00:00.000Z',effectiveAt:null,fields:{numericValue:'1'}}],nextCursor:null})};
  const attachments={read:jest.fn().mockResolvedValue({records:[],pending:0,complete:true})};
  const identity={patientProfile:jest.fn().mockResolvedValue(profile)};
  const service=new PatientEvidenceService(database as never,records as never,lab as never,{recordWithClient:jest.fn()} as never,
    attachments as never,identity as never);
  return {service,query,lab,attachments};
}
const request={correlationId:'synthetic-origin'} as never;

describe('PatientEvidenceService origin', () => {
  it('gives every source the origin worked out from its row, and answers a source with its label in the patient\'s words', async () => {
    const note='22222222-2222-4222-8222-000000000001',scanned='22222222-2222-4222-8222-000000000002';
    const provider='22222222-2222-4222-8222-000000000003',reported='22222222-2222-4222-8222-000000000004';
    const s=setup([row('note',note,null),row('note',scanned,'scanned_paper'),row('import',provider,'provider-authored'),
      row('import',reported,'patient-provided'),row('health_profile',patientId,null)]);
    const snapshot=await s.service.snapshot(request);
    const origin=(kind:string,id:string)=>snapshot.records.find(r=>r.kind===kind&&r.id===id)?.origin;
    expect(origin('note',note)).toBe('health_worker');
    expect(origin('note',scanned)).toBe('scanned_paper');
    expect(origin('import',provider)).toBe('health_worker');
    expect(origin('import',reported)).toBe('patient');
    expect(origin('health_profile',patientId)).toBe('patient');
    expect(origin('profile',patientId)).toBe('health_id_profile');
    expect(origin('lab_result','33333333-3333-4333-8333-333333333333')).toBe('health_worker');
  });

  it('reads with the patient query and refuses a row of anyone else', async () => {
    const s=setup([{...row('note','22222222-2222-4222-8222-000000000005',null),patient_id:'99999999-9999-4999-8999-999999999999'}]);
    await expect(s.service.snapshot(request)).rejects.toMatchObject({code:'PATIENT_ACCESS_DENIED',status:403});
    expect(s.query.mock.calls[0][0]).toBe(PATIENT_EVIDENCE_QUERY);
    expect(s.query.mock.calls[0][1]).toEqual([patientId,'','']);
  });
});

describe('PatientEvidenceService patient policy', () => {
  // Fictional patient and records only.
  const profile={patientId,version:4,firstName:'Adaeze',lastName:'Okafor',fullName:'Adaeze Okafor',dateOfBirth:'1994-03-12',gender:'female',
    country:'NG',state:'Lagos'};
  const local=(kind:string,id:string,fields:Record<string,unknown>,title=`Synthetic ${kind}`)=>({...row(kind,id,null),title,fields,patient_id:patientId});
  const rows=[
    local('diagnosis','22222222-2222-4222-8222-000000000011',{codeSystem:'ICD-10',code:'I10',condition:'Essential hypertension',verificationStatus:'confirmed',notes:'Synthetic working note'}),
    local('diagnosis','22222222-2222-4222-8222-000000000012',{codeSystem:'ICD-10',code:'E11',condition:'Type 2 diabetes',verificationStatus:'refuted',notes:'Synthetic refuted note'}),
    local('note','22222222-2222-4222-8222-000000000013',{_encounterStatus:'in_progress',noteType:'consultation',text:'Synthetic open-visit note'}),
    local('note','22222222-2222-4222-8222-000000000014',{_encounterStatus:'completed',noteType:'summary',text:'Adaeze Okafor, call 0803 123 4567.'}),
  ];

  it('cleans every record before anything downstream sees it, and counts only what remains', async () => {
    const s=setup(rows,profile);
    s.lab.patientReleasedResults.mockResolvedValue({records:[
      {id:'33333333-3333-4333-8333-000000000001',version:'2:pending:release-a',title:'Haemoglobin',recordedAt:'2026-10-02T00:00:00.000Z',effectiveAt:null,
        fields:{test:'Haemoglobin',correctionPending:true,status:'The lab is correcting this result.',numericValue:'99.9'}},
      {id:'33333333-3333-4333-8333-000000000002',version:'1:release-b',title:'HIV 1/2 antibody',recordedAt:'2026-10-02T00:00:00.000Z',effectiveAt:null,
        fields:{test:'HIV 1/2 antibody',textValue:'Synthetic sensitive value'}}],nextCursor:null});
    s.attachments.read.mockResolvedValue({records:[],pending:0,complete:true});
    const snapshot=await s.service.snapshot(request);
    const text=JSON.stringify(snapshot);
    expect(snapshot.records.map(r=>r.kind).sort()).toEqual(['diagnosis','lab_result','note','profile']);
    expect(snapshot.coverage.recordCount).toBe(4);
    expect(text).not.toMatch(/Adaeze|Okafor|1994|0803|Synthetic working note|Synthetic refuted note|Synthetic open-visit note|99\.9|HIV|Synthetic sensitive value|Lagos/);
    expect(snapshot.records.find(r=>r.kind==='profile')).toMatchObject({title:'Age and sex',fields:{ageYears:expect.any(Number),sex:'female'},origin:'health_id_profile'});
    expect(snapshot.records.find(r=>r.kind==='lab_result')!.fields).toMatchObject({correctionPending:true,status:'The lab is correcting this result.'});
  });

  it('gives the same records and hashes for two snapshots of the same data', async () => {
    const a=await setup(rows,profile).service.snapshot(request),b=await setup(rows,profile).service.snapshot(request);
    expect(a.records.map(r=>[r.kind,r.id,r.version,r.hash])).toEqual(b.records.map(r=>[r.kind,r.id,r.version,r.hash]));
  });

  it('reads the records the patient added only while the setting is on, labelled "You added this"', async () => {
    const entry='22222222-2222-4222-8222-000000000005';
    const off=setup([row('note','22222222-2222-4222-8222-000000000001',null)]);
    await off.service.snapshot(request);
    expect(off.query.mock.calls[0]![0]).toBe(PATIENT_EVIDENCE_QUERY);
    mockEntriesEnabled=true;
    const on=setup([{...row('patient_entry',entry,null),fields:{type:'test',place:'Lagoon Lab',date:'2026-10-01',notes:null}}]);
    const snapshot=await on.service.snapshot(request);
    expect(on.query.mock.calls[0]![0]).toContain("from ehr.patient_entries pe where pe.status='active'");
    expect(on.query.mock.calls[0]![0]).toContain('origin_hint,patient_id from sources');
    const record=snapshot.records.find(r=>r.kind==='patient_entry'&&r.id===entry)!;
    expect(record).toMatchObject({origin:'patient',provenance:'Synthetic provenance',fields:{type:'test',place:'Lagoon Lab',date:'2026-10-01',notes:null}});
    expect(sourceView(record)).toMatchObject({kindLabel:'Record you added',originLabel:'You added this'});
    expect(sourceView(record).notices).toContain(NOT_CHECKED_LINE);
  });

  it('applies the patient-chat policy to the records the patient added: refuses another patient\'s, cleans identifiers, hides sensitive ones', async () => {
    mockEntriesEnabled=true;
    const entry=(id:string,title:string,fields:Record<string,unknown>)=>({...row('patient_entry',id,null),title,fields});
    const other=setup([{...entry('22222222-2222-4222-8222-000000000021','Malaria test',{type:'test'}),patient_id:'99999999-9999-4999-8999-999999999999'}],profile);
    await expect(other.service.snapshot(request)).rejects.toMatchObject({code:'PATIENT_ACCESS_DENIED',status:403});
    const s=setup([
      entry('22222222-2222-4222-8222-000000000022','Clinic visit with Adaeze Okafor',{type:'visit',place:'Okafor family clinic',date:'2026-10-01',
        notes:'Adaeze Okafor, born 12/03/1994, call 0803 123 4567, HID-AB2CD3EF.',extra:'Synthetic extra field',_internal:'x'}),
      entry('22222222-2222-4222-8222-000000000023','HIV test',{type:'test',place:null,date:'2026-10-02',notes:null}),
      entry('22222222-2222-4222-8222-000000000024','Tenofovir',{type:'medicine',place:null,date:'2026-10-02',notes:null}),
      entry('22222222-2222-4222-8222-000000000025','Breast cancer',{type:'other',place:null,date:'2026-10-02',notes:null}),
    ],profile);
    s.lab.patientReleasedResults.mockResolvedValue({records:[],nextCursor:null});
    const snapshot=await s.service.snapshot(request);
    const entries=snapshot.records.filter(r=>r.kind==='patient_entry');
    expect(entries.map(r=>r.id)).toEqual(['22222222-2222-4222-8222-000000000022']);
    expect(Object.keys(entries[0]!.fields).sort()).toEqual(['date','notes','place','type']);
    expect(JSON.stringify(entries[0])).not.toMatch(/Adaeze|Okafor|1994|0803|AB2CD3EF|Synthetic extra field/);
    expect(JSON.stringify(snapshot)).not.toMatch(/HIV|Tenofovir|Breast cancer/);
  });
});

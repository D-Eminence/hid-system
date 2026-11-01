import type { PoolClient } from 'pg';
import { PatientEvidenceService } from './patient-evidence.service';

const patientId='11111111-1111-4111-8111-111111111111';
const auth={patientId,subject:'subject-a',accountId:'account-a',sessionId:'session-a',expiresAt:new Date(Date.now()+30000).toISOString()};
const row=(kind:string,id:string,origin_hint:string|null)=>({kind,id,version:'1',title:`Synthetic ${kind}`,recorded_at:new Date('2026-10-01T00:00:00Z'),
  effective_at:null,provenance:'Synthetic provenance',quality:'recorded',fields:{text:'Synthetic content'},origin_hint});
function setup(rows:unknown[]) {
  const query=jest.fn().mockResolvedValue({rows});
  const database={withPatientTransaction:async(_a:unknown,_c:string,work:(c:PoolClient)=>Promise<unknown>)=>work({query} as unknown as PoolClient)};
  const records={authorizeSelf:jest.fn().mockResolvedValue(auth)};
  const lab={patientReleasedResults:jest.fn().mockResolvedValue({records:[{id:'33333333-3333-4333-8333-333333333333',version:'1',title:'Synthetic result',
    recordedAt:'2026-10-02T00:00:00.000Z',effectiveAt:null,fields:{numericValue:'1'}}],nextCursor:null})};
  const attachments={read:jest.fn().mockResolvedValue({records:[],pending:0,complete:true})};
  const identity={patientProfile:jest.fn().mockResolvedValue({patientId,version:3})};
  const service=new PatientEvidenceService(database as never,records as never,lab as never,{recordWithClient:jest.fn()} as never,
    attachments as never,identity as never);
  return {service,query};
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
    await expect(s.service.source(request,'import',reported)).resolves.toMatchObject({origin:'patient',originLabel:'You added this'});
    await expect(s.service.source(request,'note',scanned)).resolves.toMatchObject({originLabel:'From a scanned paper record'});
    await expect(s.service.source(request,'profile',patientId)).resolves.toMatchObject({originLabel:'Your Health ID profile'});
  });
});

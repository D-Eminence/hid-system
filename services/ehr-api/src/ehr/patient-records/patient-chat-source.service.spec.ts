import { PatientChatSourceService } from './patient-chat-source.service';
import { evidence,binding,evidenceKey,type Evidence,type EvidenceBinding } from './patient-evidence.types';

// Fictional data only.
const patientId='11111111-1111-4111-8111-111111111111';
const auth={patientId,subject:'subject-a',accountId:'account-a',sessionId:'session-a'};
const request={correlationId:'synthetic-source'} as never;
const lab=evidence({kind:'lab_result',id:'33333333-3333-4333-8333-000000000001',version:'2',title:'Haemoglobin',
  recordedAt:'2026-10-05T10:00:00.000Z',effectiveAt:'2026-10-05T09:00:00.000Z',provenance:'Released laboratory result',quality:'verified and released',
  fields:{test:'Haemoglobin',numericValue:'12.5',unit:'g/dL',specimen:'Blood',correctionPending:false,_encounterId:'66666666-6666-4666-8666-000000000001'}});
const pending=evidence({kind:'lab_result',id:'33333333-3333-4333-8333-000000000002',version:'3:pending:44444444-4444-4444-8444-000000000001',
  title:'Fasting glucose',recordedAt:'2026-10-04T10:00:00.000Z',effectiveAt:null,provenance:'Released laboratory result',quality:'verified and released',
  fields:{test:'Fasting glucose',collectedAt:'2026-10-03',correctionPending:true,status:'The lab is correcting this result.'}});
const diagnosis=evidence({kind:'diagnosis',id:'33333333-3333-4333-8333-000000000003',version:'1',title:'Hypertension',recordedAt:null,effectiveAt:null,
  provenance:'Clinician recorded condition',quality:'confirmed',fields:{condition:'Hypertension',verificationStatus:'confirmed'}});
const note=evidence({kind:'note',id:'33333333-3333-4333-8333-000000000004',version:'1',title:'Clinical note',recordedAt:null,effectiveAt:null,
  provenance:'Signed clinical note',quality:'released',fields:{noteType:'progress',text:'Synthetic review; blood pressure stable.'}});
const doc=evidence({kind:'document',id:'33333333-3333-4333-8333-000000000005',version:'1',title:'Clinical document',recordedAt:null,effectiveAt:null,
  provenance:'Machine extracted clinical document; not clinician verified',quality:'machine extracted',fields:{text:'Synthetic scanned letter'}});
const profile=evidence({kind:'profile',id:patientId,version:'3',title:'Age and sex',recordedAt:null,effectiveAt:null,
  provenance:'Health ID patient profile',quality:'recorded',fields:{ageYears:36,sex:'female'}});
const otherPatientNote='77777777-7777-4777-8777-000000000001';

function setup(records:Evidence[],cited:EvidenceBinding[],unavailable:string[]=[]) {
  const authorizeSelf=jest.fn().mockResolvedValue(auth);
  // One snapshot, built inside citedBindings, serves the cited check and the lookup.
  const citedBindings=jest.fn().mockResolvedValue({cited:new Map(cited.map(b=>[evidenceKey(b),b])),records,unavailable});
  const recordWithClient=jest.fn();
  const database={withPatientTransaction:jest.fn(async(_a:unknown,_c:string,work:(client:unknown)=>Promise<unknown>)=>work({}))};
  const service=new PatientChatSourceService({authorizeSelf} as never,{citedBindings} as never,database as never,{recordWithClient} as never);
  return {service,authorizeSelf,citedBindings,recordWithClient};
}
const all=[lab,pending,diagnosis,note,doc,profile];

describe('B4 patient chat source viewer',()=>{
  it('returns the safe view of a cited source: no hash, content, raw fields or encounter id',async()=>{
    const s=setup(all,[binding(lab)]);
    const view=await s.service.view(request,'lab_result',lab.id);
    expect(Object.keys(view).sort()).toEqual(['effectiveAt','id','items','kind','kindLabel','notices','originLabel','provenance','recordedAt','title']);
    expect(view).toMatchObject({kind:'lab_result',id:lab.id,kindLabel:'Lab result',title:'Haemoglobin',originLabel:'Recorded by a health worker',
      notices:['Talk to your doctor about what this result means.']});
    expect(view.items).toEqual(expect.arrayContaining([{label:'Test',value:'Haemoglobin'},{label:'Value',value:'12.5'},{label:'Unit',value:'g/dL'}]));
    const text=JSON.stringify(view);
    for(const secret of [lab.hash,'66666666-6666-4666-8666-000000000001','"fields"','"content"','correctionPending'])expect(text).not.toContain(secret);
    expect(s.recordWithClient.mock.calls[0][1]).toMatchObject({action:'ehr.patient.chat.source.read',details:{kind:'lab_result',sourceId:lab.id}});
    expect(JSON.stringify(s.recordWithClient.mock.calls)).not.toContain('Haemoglobin');
  });
  it('shows a placeholder without any value and with the correcting notice',async()=>{
    const view=await setup(all,[binding(pending)]).service.view(request,'lab_result',pending.id);
    expect(view.notices).toEqual(['The lab is correcting this result.']);
    expect(view.items.map(i=>i.label)).toEqual(['Test','Collected']);
  });
  it('labels diagnoses, documents and the age-and-sex profile for the patient',async()=>{
    const cited=[binding(diagnosis),binding(doc),binding(profile)];
    const s=setup(all,cited);
    expect(await s.service.view(request,'diagnosis',diagnosis.id)).toMatchObject({kindLabel:'Diagnosis',notices:['Talk to your doctor about what this diagnosis means.']});
    expect(await s.service.view(request,'document',doc.id)).toMatchObject({kindLabel:'Clinical document',title:'Clinical document',notices:['Not checked by a clinician.']});
    expect(s.citedBindings).toHaveBeenLastCalledWith(request,[doc.id]);
    expect(await s.service.view(request,'profile',patientId)).toMatchObject({kindLabel:'Age and sex',items:[{label:'Age (years)',value:'36'},{label:'Sex',value:'female'}]});
  });
  it('says where the source came from in the patient\'s words (origin set by the server)',async()=>{
    const reported=evidence({kind:'import',id:'33333333-3333-4333-8333-000000000006',version:'1',title:'Reported medicine',recordedAt:null,effectiveAt:null,
      provenance:'Patient reported imported history',quality:'imported',fields:{record:'Synthetic medicine'},originHint:'patient-provided'});
    const scanned=evidence({...note,id:'33333333-3333-4333-8333-000000000007',originHint:'scanned_paper'});
    const s=setup([reported,scanned],[binding(reported),binding(scanned)]);
    expect(await s.service.view(request,'import',reported.id)).toMatchObject({kindLabel:'Imported history',originLabel:'You added this',notices:['Not checked by a clinician.']});
    expect(await s.service.view(request,'note',scanned.id)).toMatchObject({kindLabel:'Clinic note',originLabel:'From a scanned paper record'});
  });
  it('returns 404 for a source in the snapshot that no current answer cites',async()=>{
    const s=setup(all,[binding(lab)]);
    await expect(s.service.view(request,'note',note.id)).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
  });
  it('builds one snapshot per view, and opens a cited note while Lab is down',async()=>{
    const s=setup(all.filter(r=>r.kind!=='lab_result'),[binding(note)],['Laboratory results are temporarily unavailable']);
    expect(await s.service.view(request,'note',note.id)).toMatchObject({kindLabel:'Clinic note'});
    expect(s.citedBindings).toHaveBeenCalledTimes(1);expect(s.citedBindings).toHaveBeenCalledWith(request,[]);
    await expect(s.service.view(request,'lab_result',lab.id)).rejects.toMatchObject({code:'CHAT_HISTORY_SOURCE_UNAVAILABLE'});
  });
  it('returns 404 for a source that changed since it was cited',async()=>{
    const changed=evidence({...note,fields:{...note.fields,text:'Changed synthetic review.'}});
    await expect(setup([changed],[binding(note)]).service.view(request,'note',note.id)).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
    await expect(setup([{...note,version:'2'}],[binding(note)]).service.view(request,'note',note.id)).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
  });
  it('returns 404 for another patient\'s record id, and for a cited source no longer in the snapshot',async()=>{
    await expect(setup(all,[binding(lab)]).service.view(request,'note',otherPatientNote)).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
    await expect(setup(all.filter(r=>r!==note),[binding(note)]).service.view(request,'note',note.id)).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
  });
  it('returns 404 for the profile unless it was cited',async()=>{
    await expect(setup(all,[binding(lab)]).service.view(request,'profile',patientId)).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
  });
  it('returns 404 for an unknown kind before reading anything',async()=>{
    const s=setup(all,[binding(lab)]);
    for(const kind of ['constructor','__proto__','staff_note','LAB_RESULT'])await expect(s.service.view(request,kind,lab.id)).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
    expect(s.citedBindings).not.toHaveBeenCalled();
  });
  it('returns 404 when the authorized patient changes during the request, and propagates a revoked session',async()=>{
    const s=setup(all,[binding(lab)]);s.authorizeSelf.mockResolvedValueOnce(auth).mockResolvedValue({...auth,patientId:'99999999-9999-4999-8999-999999999999'});
    await expect(s.service.view(request,'lab_result',lab.id)).rejects.toMatchObject({code:'CHAT_SOURCE_UNAVAILABLE'});
    expect(s.recordWithClient).not.toHaveBeenCalled();
    const revoked=setup(all,[binding(lab)]);revoked.authorizeSelf.mockRejectedValue(new Error('revoked'));
    await expect(revoked.service.view(request,'lab_result',lab.id)).rejects.toThrow('revoked');expect(revoked.citedBindings).not.toHaveBeenCalled();
  });
});

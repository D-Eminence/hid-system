import React, { useEffect, useState } from 'react';
import { Card, Badge, Button, Input, SectionHeader, PageHead } from './primitives';
import { MODULE_AVAILABILITY } from '@/config/moduleAvailability';
import { labApi, newIdempotencyKey } from '@/api/client';

/*
 * Operational modules are intentionally fail-closed during the backend migration.
 * A module must not be marked available until it has an authenticated, facility-
 * isolated, audited API contract. There are no browser database calls or simulated
 * success paths in this file.
 */

const MigrationUnavailable = ({ moduleId }) => {
  const module = MODULE_AVAILABILITY[moduleId];
  return (
    <div className="fade-in">
      <PageHead title={module.title} sub={module.description} />
      <Card pad>
        <SectionHeader title="Controlled migration status" action={<Badge variant="neutral">Unavailable</Badge>} />
        <div
          role="status"
          style={{
            marginTop: 'var(--space-400)',
            padding: 'var(--space-500)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--surface-muted)',
            color: 'var(--text-body)',
            lineHeight: 1.6,
          }}
        >
          {module.migrationNote} No operation was performed and no patient data was loaded.
        </div>
      </Card>
    </div>
  );
};

const LabModule = () => {
  const [items,setItems]=useState([]); const [selected,setSelected]=useState(null);
  const [specimenType,setSpecimenType]=useState(''); const [containerType,setContainerType]=useState('');
  const [reason,setReason]=useState(''); const [error,setError]=useState(''); const [loading,setLoading]=useState(false);
  const [execution,setExecution]=useState(null); const [resultValue,setResultValue]=useState(''); const [unit,setUnit]=useState('');
  const load=async()=>{setLoading(true);setError('');try{const value=await labApi.listWorkItems();setItems(value.items||[]);
    if(selected?.id){const current=(value.items||[]).find((item)=>item.id===selected.id);if(current?.accessionId)setSelected(await labApi.getAccession(current.accessionId));}}
    catch(e){setError(e instanceof Error?e.message:'Lab queue could not be loaded.');}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  const accession=async(item)=>{if(!specimenType.trim()||!reason.trim()){setError('Specimen type and accession reason are required.');return;}
    setLoading(true);setError('');try{const value=await labApi.createAccession(item.id,{requirements:[{specimenType:specimenType.trim(),containerType:containerType.trim()||undefined}],reason:reason.trim()},newIdempotencyKey());setSelected(value);await load();}
    catch(e){setError(e instanceof Error?e.message:'Accession could not be created.');}finally{setLoading(false);}};
  const transition=async(specimen,action)=>{setLoading(true);setError('');try{const now=new Date().toISOString();
    if(action==='collect')await labApi.collectSpecimen(specimen.accessionId,specimen.id,{expectedVersion:specimen.version,collectedAt:now},newIdempotencyKey());
    else if(action==='receive')await labApi.receiveSpecimen(specimen.accessionId,specimen.id,{expectedVersion:specimen.version,receivedAt:now,condition:'Received condition recorded'},newIdempotencyKey());
    else {const rejection=reason.trim();if(!rejection)throw new Error('Enter a rejection reason first.');await labApi.rejectSpecimen(specimen.accessionId,specimen.id,{expectedVersion:specimen.version,reason:rejection},newIdempotencyKey());}
    setSelected(await labApi.getAccession(specimen.accessionId));await load();}catch(e){setError(e instanceof Error?e.message:'Specimen command failed.');}finally{setLoading(false);}};
  const openExecution=async specimen=>{setLoading(true);try{const list=await labApi.listExecutions(specimen.id);setExecution(list.items?.[0]||null);if(!list.items?.[0])setExecution(await labApi.startExecution(specimen.id,{expectedSpecimenVersion:specimen.version,startedAt:new Date().toISOString(),reason:'Manual analytical execution started'},newIdempotencyKey()));}catch(e){setError(e instanceof Error?e.message:'Execution could not be opened.');}finally{setLoading(false);}};
  const complete=async()=>{setLoading(true);try{setExecution(await labApi.completeExecution(execution.id,{expectedVersion:execution.version,completedAt:new Date().toISOString()},newIdempotencyKey()));}catch(e){setError(e instanceof Error?e.message:'Execution could not be completed.');}finally{setLoading(false);}};
  const saveResult=async correction=>{setLoading(true);try{const numeric=Number(resultValue);const isNumeric=resultValue.trim()!==''&&Number.isFinite(numeric);const input={expectedExecutionVersion:execution.version,resultType:isNumeric?'numeric':'text',numericValue:isNumeric?numeric:undefined,textValue:isNumeric?undefined:resultValue.trim(),unit:unit.trim()||undefined,abnormalFlag:'unknown',...(correction?{expectedResultVersion:execution.result.currentVersion,reason:reason.trim()||'Corrected manual entry'}:{})};const result=correction?await labApi.correctResult(execution.id,execution.result.id,input,newIdempotencyKey()):await labApi.enterResult(execution.id,input,newIdempotencyKey());setExecution({...execution,result});}catch(e){setError(e instanceof Error?e.message:'Unverified result could not be saved.');}finally{setLoading(false);}};
  const governResult=async action=>{setLoading(true);setError('');try{const input={expectedResultVersion:execution.result.currentVersion,occurredAt:new Date().toISOString(),reason:reason.trim()||`Manual result ${action}`};const result=action==='verified'?await labApi.verifyResult(execution.result.id,input,newIdempotencyKey()):await labApi.releaseResult(execution.result.id,input,newIdempotencyKey());setExecution({...execution,result});}catch(e){setError(e instanceof Error?e.message:`Result could not be ${action}.`);}finally{setLoading(false);}};
  return <div className="fade-in"><PageHead title="Laboratory operations" sub="Custody, execution and manual unverified result entry — no verification or release" />
    {error&&<div role="alert" style={{color:'var(--color-danger)',marginBottom:'var(--space-300)'}}>{error}</div>}
    <Card pad><SectionHeader title="Lab work queue" action={<Button size="sm" variant="secondary" loading={loading} onClick={load}>Refresh</Button>} />
      <div className="ehr-grid-2" style={{margin:'var(--space-400) 0'}}><Input placeholder="Required specimen type" value={specimenType} onChange={e=>setSpecimenType(e.target.value)} /><Input placeholder="Container type (optional)" value={containerType} onChange={e=>setContainerType(e.target.value)} /><Input placeholder="Operational reason / rejection reason" value={reason} onChange={e=>setReason(e.target.value)} /></div>
      <div style={{display:'grid',gap:'var(--space-300)'}}>{items.map(item=><div key={item.id} style={{padding:'var(--space-400)',border:'1px solid var(--border-subtle)',borderRadius:'var(--radius-md)'}}>
        <strong>{item.testName}</strong> <Badge variant="neutral">{item.accessionNumber?'Accessioned':'Accepted by Lab'}</Badge>
        <div className="mono" style={{fontSize:12,margin:'8px 0'}}>{item.accessionNumber||item.id}</div>
        {item.accessionId?<Button size="sm" onClick={async()=>setSelected(await labApi.getAccession(item.accessionId))}>View specimens</Button>:<Button size="sm" loading={loading} onClick={()=>accession(item)}>Create accession</Button>}
      </div>)}</div>{!loading&&items.length===0&&<p>No authorized accepted Lab work is currently visible.</p>}</Card>
    {selected&&<Card pad style={{marginTop:'var(--space-400)'}}><SectionHeader title={`Accession ${selected.accessionNumber}`} sub="Accession does not mean collection; receipt does not mean testing." />
      {(selected.specimens||[]).map(specimen=><div key={specimen.id} style={{padding:'var(--space-400)',borderBottom:'1px solid var(--border-subtle)'}}><strong>{specimen.specimenType}</strong> <Badge variant="neutral">{specimen.status}</Badge>
        <div className="mono" style={{fontSize:12,margin:'8px 0'}}>{specimen.specimenIdentifier}</div>
        {specimen.status==='required'&&<Button size="sm" loading={loading} onClick={()=>transition(specimen,'collect')}>Record collection</Button>}
        {specimen.status==='collected'&&<><Button size="sm" loading={loading} onClick={()=>transition(specimen,'receive')}>Record receipt</Button> <Button size="sm" variant="secondary" loading={loading} onClick={()=>transition(specimen,'reject')}>Reject specimen</Button></>}
        {specimen.status==='received'&&<Button size="sm" loading={loading} onClick={()=>openExecution(specimen)}>Open test execution</Button>}
      </div>)}</Card>}
    {execution&&<Card pad style={{marginTop:'var(--space-400)'}}><SectionHeader title={execution.test?.name||'Requested test execution'} sub="Execution completion is not result verification." />
      <p><Badge variant="neutral">{execution.status.replaceAll('_',' ')}</Badge> <span className="mono">{execution.test?.code}</span></p>
      {execution.status==='in_progress'&&<Button loading={loading} onClick={complete}>Complete analytical execution</Button>}
      {execution.status==='completed'&&<><div className="ehr-grid-2" style={{margin:'var(--space-400) 0'}}><Input placeholder="Manual numeric or text result" value={resultValue} onChange={e=>setResultValue(e.target.value)} /><Input placeholder="Unit (optional)" value={unit} onChange={e=>setUnit(e.target.value)} /></div>
        <Badge variant="neutral">{execution.result?.status?.replaceAll('_',' ')||'No result entered'}</Badge> <Button loading={loading} onClick={()=>saveResult(Boolean(execution.result))}>{execution.result?'Create corrected revision':'Enter unverified result'}</Button>
        {execution.result?.status==='entered_unverified'&&<Button loading={loading} onClick={()=>governResult('verified')}>Verify version {execution.result.currentVersion}</Button>}
        {execution.result?.status==='verified_not_released'&&<Button loading={loading} onClick={()=>governResult('released')}>Release version {execution.result.currentVersion}</Button>}
        {execution.result&&<div style={{marginTop:'var(--space-300)'}}><strong>Unverified result history</strong>{execution.result.revisions.map(revision=><div key={revision.version}>v{revision.version}: {revision.numericValue??revision.textValue} {revision.unit||''} — unverified manual</div>)}</div>}</>}
    </Card>}</div>;
};
const RadiologyModule = () => <MigrationUnavailable moduleId="radiology" />;
const PharmacyModule = () => <MigrationUnavailable moduleId="pharmacy" />;
const BillingModule = () => <MigrationUnavailable moduleId="billing" />;
const ReportsModule = () => <MigrationUnavailable moduleId="reports" />;
const StaffModule = () => <MigrationUnavailable moduleId="staff" />;

const SetupModule = ({ config }) => (
  <div className="fade-in">
    <PageHead title="Modular Hospital Setup & Dynamic Configuration" sub="Current local presentation configuration" />
    <Card pad>
      <SectionHeader title="Current Configuration" />
      <div className="ehr-grid-2" style={{ marginTop: 'var(--space-400)' }}>
        <div>
          <div className="ehr-record-label">Facility Name</div>
          <div className="ehr-record-value">{config.name}</div>
        </div>
        <div>
          <div className="ehr-record-label">Active Departments</div>
          <div className="ehr-record-value">{config.departments.length} Departments Enabled</div>
        </div>
      </div>
    </Card>
  </div>
);

export { LabModule, RadiologyModule, PharmacyModule, BillingModule, ReportsModule, SetupModule, StaffModule };

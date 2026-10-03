import {useEffect,useState} from 'react';
import {createPlatformControlsApi,type PlatformControl,type PlatformControlKey} from '@hid/api-client';
import {api} from './api';

const labels: Record<PlatformControlKey,string>={maintenance_mode:'Maintenance mode',patient_portal_enabled:'Patient portal',
  provider_portal_enabled:'Provider portals',outreach_portal_enabled:'Outreach portal',break_glass_enabled:'Break glass',uploads_enabled:'File uploads'};
const controlsApi=createPlatformControlsApi(async<T,>(path:string,init:RequestInit={})=>{
  const response=await api<T|{data:T}>(path.substring('/api/v1'.length),{
    method:init.method,body:typeof init.body==='string'?JSON.parse(init.body):undefined,
    version:Number(new Headers(init.headers).get('If-Match')?.replaceAll('"',''))||undefined,
  });
  return response&&typeof response==='object'&&'data' in response?response.data:response as T;
});
export function PlatformControls({canManage}:{canManage:boolean}){
  const [rows,setRows]=useState<PlatformControl[]|null>(null),[changes,setChanges]=useState<Partial<Record<PlatformControlKey,boolean>>>({});
  const [reason,setReason]=useState(''),[busy,setBusy]=useState(true),[error,setError]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null);
  useEffect(()=>{let active=true;void controlsApi.list().then(value=>{if(active)setRows(value);})
    .catch(()=>{if(active)setError('Platform controls are unavailable. Reload to try again.');})
    .finally(()=>{if(active)setBusy(false);});return()=>{active=false;};},[]);
  async function reload(){
    setBusy(true);setRows(null);setChanges({});setMessage(null);
    try{setRows(await controlsApi.list());setError(null);}catch{setError('Platform controls are unavailable. Reload to try again.');}finally{setBusy(false);}
  }
  async function save(){
    if(!rows||!canManage)return;setBusy(true);setError(null);setMessage(null);
    try{setRows(await controlsApi.save(rows,changes,reason));setChanges({});setReason('');setMessage('Platform controls saved.');}
    catch(caught){setRows(null);setChanges({});setError(caught instanceof Error?caught.message:'Controls could not be saved. Reload before trying again.');}
    finally{setBusy(false);}
  }
  return <section className="platform-controls-page" aria-labelledby="controls-heading"><h1 id="controls-heading">Platform controls</h1>
    <p>Manage portal access, maintenance, uploads and emergency access.</p>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
    {!rows&&!error&&<p>Loading controls…</p>}
    {rows&&<div className="panel controls-list">{rows.map(row=><label key={row.controlKey}>
      <input type="checkbox" checked={changes[row.controlKey]??row.enabled} disabled={!canManage||busy}
        onChange={event=>setChanges(current=>({...current,[row.controlKey]:event.target.checked}))}/>
      {labels[row.controlKey]}<small> Last change: {row.reason}</small>
    </label>)}</div>}
    <p>Patient signup, hospital signup, outreach signup and HID Migrate switches are unavailable here.</p>
    {canManage&&<><label>Reason for changes<input value={reason} minLength={8} maxLength={500} disabled={busy}
      onChange={event=>setReason(event.target.value)}/></label>
      <button onClick={()=>void save()} disabled={busy||!rows||reason.trim().length<8||!rows.some(row=>changes[row.controlKey]!==undefined&&changes[row.controlKey]!==row.enabled)}>Save controls</button></>}
    <button onClick={()=>void reload()} disabled={busy}>Reload controls</button>
    {!canManage&&<p>You have read access to platform controls.</p>}
  </section>;
}

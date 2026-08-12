import React,{useCallback,useEffect,useState}from'react'
import{Button,EmptyState,PageLoader,showToast}from'../../../components/ui'
import type{MigrationProjectAccess}from'../domain'
import{importCommand,listImports,type ImportJob,type ImportItem}from'../api/migrationImports'
import{MigrationStatusBadge}from'./MigrationStatusBadge'
export function ImportWorkspace({project}:{project:MigrationProjectAccess}){
 const[jobs,setJobs]=useState<ImportJob[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false)
 const load=useCallback(async()=>{setLoading(true);try{setJobs((await listImports(project.id)).data)}catch(e){showToast(e instanceof Error?e.message:'Import queue could not be loaded.','error')}finally{setLoading(false)}},[project.id])
 useEffect(()=>{void load()},[load])
 const run=async(action:string,payload:Record<string,unknown>={})=>{setBusy(true);try{await importCommand(project.id,action,payload);showToast('Import operation completed.','success');await load()}catch(e){showToast(e instanceof Error?e.message:'Import operation failed.','error')}finally{setBusy(false)}}
 if(loading)return <PageLoader label="Loading import jobs..."/>
 const actionFor=(item:ImportItem)=>item.status==='imported'&&!item.verified_at?'verify_item':item.status==='ready'?'execute_item':['failed','verification_failed'].includes(item.status)?'retry_item':null
 return <><div className="migrate-pagehead"><div><h1>Bulk import</h1><p>Idempotent, per-folder canonical writes with independent retry and verification.</p></div><Button disabled={busy} onClick={()=>void run('create_job',{idempotency_key:`manual:${project.id}:${new Date().toISOString().slice(0,10)}`})}>Create import job</Button></div>
 {jobs.length===0?<EmptyState icon={<span>→</span>} title="No import jobs" description="Create a job after patient matches have final link decisions."/>:jobs.map(job=><section key={job.id} className="migrate-card migrate-section"><div className="migrate-section-head"><h2 className="migrate-mono">{job.id.slice(0,8)}</h2><MigrationStatusBadge status={job.status}/></div>{job.items.map(item=>{const action=actionFor(item);return <div className="migrate-attention" key={item.id}><div><strong className="migrate-mono">{item.source_folder_id.slice(0,8)}</strong><small>{item.last_error_message||`${item.target_record_ids.length} canonical records · ${item.attempt_count} attempts`}</small></div><MigrationStatusBadge status={item.verified_at?'verified':item.status} positive={!!item.verified_at}/>{action&&<Button disabled={busy} onClick={()=>void run(action,{item_id:item.id})}>{action==='verify_item'?'Verify':action==='retry_item'?'Retry':'Import'}</Button>}</div>})}</section>)}</>
}

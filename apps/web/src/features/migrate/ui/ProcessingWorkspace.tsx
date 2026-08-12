import React,{useCallback,useEffect,useState} from 'react'
import {Button,EmptyState,PageLoader,showToast} from '../../../components/ui'
import type{MigrationProjectAccess}from'../domain'
import{listProcessing,processingCommand,type ProcessingFolder,type ProcessingJob}from'../api/migrationProcessing'
import{MigrationStatusBadge}from'./MigrationStatusBadge'
export function ProcessingWorkspace({project}:{project:MigrationProjectAccess}){
 const[jobs,setJobs]=useState<ProcessingJob[]>([]),[folders,setFolders]=useState<ProcessingFolder[]>([]),[loading,setLoading]=useState(true)
 const canRetry=project.capabilities.includes('processing.retry')
 const load=useCallback(async()=>{setLoading(true);try{const[j,f]=await Promise.all([listProcessing<ProcessingJob>(project.id),listProcessing<ProcessingFolder>(project.id,'folders')]);setJobs(j.data);setFolders(f.data)}catch(e){showToast(e instanceof Error?e.message:'Queue could not be loaded.','error')}finally{setLoading(false)}},[project.id])
 useEffect(()=>{void load()},[load])
 async function enqueue(folderId:string){try{await processingCommand(project.id,'enqueue_folder',{source_folder_id:folderId});showToast('Folder queued for security and processing.','success');await load()}catch(e){showToast(e instanceof Error?e.message:'Folder could not be queued.','error')}}
 async function retry(jobId:string){try{await processingCommand(project.id,'retry_job',{job_id:jobId});showToast('Job queued for retry.','success');await load()}catch(e){showToast(e instanceof Error?e.message:'Job could not be retried.','error')}}
 if(loading)return <PageLoader label="Loading processing queue..."/>
 return <><div className="migrate-pagehead"><div><h1>Processing queue</h1><p>Security scanning, deterministic image processing and provider-neutral OCR.</p></div><Button variant="outline" onClick={()=>void load()}>Refresh</Button></div>
 {folders.length>0&&<section className="migrate-card migrate-section"><div className="migrate-section-head"><h2>Uploaded folders</h2><span>Ready to queue</span></div>{folders.map(folder=><div className="migrate-attention" key={folder.id}><div><strong className="migrate-mono">{folder.folder_reference}</strong><small>{folder.assets.length} source assets · {folder.assets.filter(a=>a.status==='quarantined').length} quarantined</small></div>{canRetry&&<Button size="sm" onClick={()=>void enqueue(folder.id)}>Queue processing</Button>}</div>)}</section>}
 <div style={{height:16}}/>{jobs.length===0?<EmptyState icon={<span>0</span>} title="No processing jobs" description="Upload and queue a source folder to begin processing."/>:<div className="migrate-card migrate-table-wrap"><table className="migrate-table"><thead><tr><th>Created</th><th>Job</th><th>Status</th><th>Attempts</th><th>Provider</th><th>Error</th><th></th></tr></thead><tbody>{jobs.map(job=><tr key={job.id}><td>{new Date(job.created_at).toLocaleString()}</td><td>{job.job_type.replace(/_/g,' ')}</td><td><MigrationStatusBadge status={job.status}/></td><td>{job.attempt_count} / {job.max_attempts}</td><td>{job.provider||'Adapter pending'}</td><td>{job.last_error_code||'-'}<br/><small>{job.last_error_message}</small></td><td>{canRetry&&['dead_letter','retry_scheduled'].includes(job.status)&&<Button size="sm" variant="ghost" onClick={()=>void retry(job.id)}>Retry</Button>}</td></tr>)}</tbody></table></div>}</>
}

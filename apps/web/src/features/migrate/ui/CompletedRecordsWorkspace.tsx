import React,{useCallback,useEffect,useMemo,useState}from'react'
import{Button,EmptyState,PageLoader,showToast}from'../../../components/ui'
import type{MigrationProjectAccess}from'../domain'
import{listImports,type ImportItem}from'../api/migrationImports'
import{MigrationStatusBadge}from'./MigrationStatusBadge'
export function CompletedRecordsWorkspace({project,onOpenPatient}:{project:MigrationProjectAccess;onOpenPatient:(hidCode:string)=>void}){
 const[items,setItems]=useState<ImportItem[]>([]),[loading,setLoading]=useState(true)
 const load=useCallback(async()=>{setLoading(true);try{const jobs=(await listImports(project.id)).data;setItems(jobs.flatMap(job=>job.items))}catch(e){showToast(e instanceof Error?e.message:'Completed records could not be loaded.','error')}finally{setLoading(false)}},[project.id])
 useEffect(()=>{void load()},[load]);const completed=useMemo(()=>items.filter(item=>item.status==='imported'),[items])
 if(loading)return <PageLoader label="Loading completed records..."/>
 if(!completed.length)return <EmptyState icon={<span>✓</span>} title="No completed imports" description="Verified canonical records appear here after import."/>
 return <><div className="migrate-pagehead"><div><h1>Completed records</h1><p>Canonical HID patients and records; Migrate retains only workflow and source lineage.</p></div></div><section className="migrate-card migrate-section">{completed.map(item=><div className="migrate-attention" key={item.id}><div><strong>{item.patient?.full_name||'Canonical patient'}</strong><small><span className="migrate-mono">{item.patient?.hid_code||'HID unavailable'}</span> · {item.target_record_ids.length} imported record{item.target_record_ids.length===1?'':'s'}</small></div><MigrationStatusBadge status={item.verified_at?'verified import':'imported'} positive/><Button disabled={!item.patient?.hid_code} onClick={()=>item.patient&&onOpenPatient(item.patient.hid_code)}>Open patient record</Button></div>)}</section></>
}

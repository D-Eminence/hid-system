import React,{useEffect,useRef,useState} from 'react'
import {Button,EmptyState,Input,showToast} from '../../../components/ui'
import type {MigrationProjectAccess} from '../domain'
import {createCaptureFolder,finishCaptureFolder,startCaptureSession,uploadCapturePage} from '../api/migrationCapture'

type QueuedPage={id:string;file:File;status:'queued'|'uploading'|'quarantined'|'failed';error?:string}

export function CaptureWorkspace({project}:{project:MigrationProjectAccess}){
 const [sessionId,setSessionId]=useState('')
 const [folderReference,setFolderReference]=useState('')
 const [folder,setFolder]=useState<{id:string;documentId:string}|null>(null)
 const [pages,setPages]=useState<QueuedPage[]>([])
 const [busy,setBusy]=useState(false)
 const input=useRef<HTMLInputElement>(null)
 const allowed=project.capabilities.includes('capture.write')
 useEffect(()=>{if(!allowed)return;const key=`hid-migrate-session:${project.id}`;let client=localStorage.getItem(key);if(!client){client=crypto.randomUUID();localStorage.setItem(key,client)}
  void startCaptureSession(project.id,client,navigator.userAgent.slice(0,120)).then(value=>setSessionId(value.id)).catch(error=>showToast(error.message,'error'))
 },[allowed,project.id])

 async function beginFolder(){
  setBusy(true);try{const result=await createCaptureFolder(project.id,sessionId,folderReference);setFolder({id:result.folder.id,documentId:result.document.id});showToast('Folder capture started.','success')}
  catch(error){showToast(error instanceof Error?error.message:'Folder could not be started.','error')}finally{setBusy(false)}
 }
 async function upload(item:QueuedPage){
  setPages(current=>current.map(page=>page.id===item.id?{...page,status:'uploading'}:page))
  try{await uploadCapturePage(project.id,folder!.id,folder!.documentId,item.file);setPages(current=>current.map(page=>page.id===item.id?{...page,status:'quarantined',error:undefined}:page))}
  catch(error){setPages(current=>current.map(page=>page.id===item.id?{...page,status:'failed',error:error instanceof Error?error.message:'Upload failed'}:page))}
 }
 function addFiles(files:FileList|null){if(!files)return;const added=Array.from(files).map(file=>({id:crypto.randomUUID(),file,status:'queued' as const}));setPages(current=>[...current,...added]);added.forEach(item=>void upload(item))}
 async function finish(){setBusy(true);try{await finishCaptureFolder(project.id,folder!.id);showToast('Folder submitted. Originals are quarantined for security scanning.','success');setFolder(null);setPages([]);setFolderReference('')}catch(error){showToast(error instanceof Error?error.message:'Folder could not be submitted.','error')}finally{setBusy(false)}}
 if(!allowed)return <EmptyState icon={<span>!</span>} title="Capture access required" description="Your active project role cannot scan or upload source records."/>
 return <><div className="migrate-pagehead"><div><h1>Patient folder capture</h1><p>Private page-by-page capture with checksum lineage and retry states.</p></div></div>
 {!folder?<section className="migrate-card migrate-section" style={{maxWidth:560}}><Input label="Physical folder reference" value={folderReference} onChange={event=>setFolderReference(event.target.value)} placeholder="UI-04471"/>
  <div className="migrate-actions" style={{marginTop:14}}><Button loading={busy} disabled={!sessionId||!folderReference.trim()} onClick={()=>void beginFolder()}>Start folder</Button></div></section>:
 <div className="migrate-grid-2"><section className="migrate-camera"><div className="migrate-camera-frame"><div><strong>Capture or select source pages</strong><br/><small>JPEG, PNG, WebP or PDF · maximum 50 MB each</small></div></div>
  <input ref={input} hidden type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple capture="environment" onChange={event=>addFiles(event.target.files)}/>
  <div className="migrate-actions" style={{justifyContent:'center',marginTop:18}}><Button onClick={()=>input.current?.click()}>Capture / select pages</Button></div></section>
  <section className="migrate-card migrate-section"><div className="migrate-section-head"><h2>Current folder</h2><span className="migrate-mono">{folderReference}</span></div>
  {pages.length===0?<p style={{color:'var(--t3)'}}>No pages captured.</p>:pages.map((page,index)=><div className="migrate-attention" key={page.id}><div><strong>Page {index+1} · {page.file.name}</strong><small>{page.status}{page.error?` · ${page.error}`:''}</small></div>{page.status==='failed'&&<Button size="sm" onClick={()=>void upload(page)}>Retry</Button>}</div>)}
  <div className="migrate-actions" style={{marginTop:16}}><Button variant="outline" onClick={()=>input.current?.click()}>Add pages</Button><Button loading={busy} disabled={pages.length===0||pages.some(page=>page.status==='uploading'||page.status==='queued'||page.status==='failed')} onClick={()=>void finish()}>Finish folder</Button></div></section></div>}</>
}

import React,{useCallback,useEffect,useState}from'react'
import{EmptyState,PageLoader,showToast}from'../../../components/ui'
import type{MigrationProjectAccess}from'../domain'
import{listProcessing}from'../api/migrationProcessing'
import{MigrationStatusBadge}from'./MigrationStatusBadge'
type Field={value:unknown;confidence:number|null;source_spans:Array<{page_id:string;start:number;end:number}>}
type DocumentIntel={id:string;document_reference:string;title:string|null;classifications:Array<{id:string;selected_category:string;confidence:number|null;provider:string;model:string}>;extractions:Array<{id:string;schema_name:string;schema_version:string;overall_confidence:number|null;fields:Record<string,Field>;provider:string;model:string}>}
export function IntelligenceWorkspace({project}:{project:MigrationProjectAccess}){
 const[documents,setDocuments]=useState<DocumentIntel[]>([]),[loading,setLoading]=useState(true),[selected,setSelected]=useState<string|null>(null)
 const load=useCallback(async()=>{setLoading(true);try{const result=await listProcessing<DocumentIntel>(project.id,'intelligence');setDocuments(result.data);setSelected(current=>current??result.data[0]?.id??null)}catch(e){showToast(e instanceof Error?e.message:'Intelligence results could not be loaded.','error')}finally{setLoading(false)}},[project.id])
 useEffect(()=>{void load()},[load]);if(loading)return <PageLoader label="Loading extracted documents..."/>
 const doc=documents.find(item=>item.id===selected),classification=doc?.classifications.slice().sort((a,b)=>b.id.localeCompare(a.id))[0],extraction=doc?.extractions.slice().sort((a,b)=>b.id.localeCompare(a.id))[0]
 if(!doc)return <EmptyState icon={<span>AI</span>} title="No extraction results" description="Documents appear here only after security, image and OCR processing succeeds."/>
 return <><div className="migrate-pagehead"><div><h1>Document intelligence</h1><p>Versioned classification and schema-bound fields with source lineage.</p></div></div>
 <div className="migrate-validation"><aside className="migrate-card migrate-section">{documents.map(item=><button key={item.id} onClick={()=>setSelected(item.id)} className="migrate-attention" style={{width:'100%',border:0,background:item.id===selected?'var(--soft-blue)':'transparent',textAlign:'left'}}><div><strong>{item.title||item.document_reference}</strong><small>{item.document_reference}</small></div></button>)}</aside>
 <section className="migrate-card migrate-section"><div className="migrate-section-head"><h2>{doc.title||doc.document_reference}</h2>{classification&&<MigrationStatusBadge status={classification.selected_category}/>}</div>
 {!extraction?<p style={{color:'var(--t3)'}}>Classification is available; structured extraction is still processing.</p>:<><div className="migrate-source"><div><small>Schema</small><strong>{extraction.schema_name} · v{extraction.schema_version}</strong></div><div><small>Model</small><strong>{extraction.provider} / {extraction.model}</strong></div><div><small>Overall confidence</small><strong>{extraction.overall_confidence==null?'-':`${Math.round(extraction.overall_confidence*100)}%`}</strong></div></div>
 <div style={{height:14}}/>{Object.entries(extraction.fields).map(([name,field])=><div className="migrate-attention" key={name}><div><strong>{name.replace(/_/g,' ')}</strong><small>{String(field.value??'')} · {field.source_spans.map(span=>`page ${span.page_id.slice(0,8)} [${span.start}:${span.end}]`).join(', ')}</small></div><span className="migrate-mono">{field.confidence==null?'-':`${Math.round(field.confidence*100)}%`}</span></div>)}</>}
 </section></div></>
}

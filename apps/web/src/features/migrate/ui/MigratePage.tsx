import React,{useMemo,useState}from'react'
import{useLocation,useNavigate}from'react-router-dom'
import{HIDLogo}from'../../../components/HIDLogo'
import{EmptyState}from'../../../components/ui'
import{migratePath}from'../../../lib/migrateRoutes'
import type{MigrationAccessContext,MigrationRole}from'../domain'
import{MigrationAccessGate}from'../auth/MigrationAccessGate'
import{PersistentProjectDetail,PersistentProjects,PersistentTeam,ProjectSetup}from'./ProjectOperations'
import{CaptureWorkspace}from'./CaptureWorkspace'
import{ProcessingWorkspace}from'./ProcessingWorkspace'
import{ReviewWorkspace}from'./ReviewWorkspace'
import{MatchingWorkspace}from'./MatchingWorkspace'
import{ImportWorkspace}from'./ImportWorkspace'
import{CompletedRecordsWorkspace}from'./CompletedRecordsWorkspace'
import{OperationsWorkspace}from'./OperationsWorkspace'
import'./Migrate.css'

const roles:Record<MigrationRole,{label:string;nav:string[]}>={
 project_manager:{label:'Migration Project Manager',nav:['dashboard','projects','team','validation','imports','reports','settings']},
 medical_records_officer:{label:'Medical Records Officer',nav:['dashboard','projects','scanning','processing','validation','matching','folders']},
 scanner_operator:{label:'Scanner Operator',nav:['dashboard','projects','scanning','uploads']},
 validation_officer:{label:'Data Validation Officer',nav:['dashboard','validation','low-confidence','unclassified','completed']},
 qa_reviewer:{label:'Quality Assurance Reviewer',nav:['dashboard','qa','rejected','audits','reports']},
 migration_administrator:{label:'HID Migration Administrator',nav:['dashboard','projects','processing','validation','matching','imports','folders','team','audits','reports','settings']},
}
const labels:Record<string,string>={dashboard:'Dashboard',projects:'Migration Projects',scanning:'Scanning',uploads:'Uploads',processing:'Processing Queue',validation:'Validation',matching:'Patient Matching',imports:'Bulk Import',folders:'Completed Records',team:'Team',qa:'QA Queue',rejected:'Returned QA',audits:'Audit',reports:'Reports',settings:'Settings','low-confidence':'Low Confidence',unclassified:'Unclassified',completed:'Completed'}

function Unavailable({section}:{section:string}){return <EmptyState icon={<span>-</span>} title={`${labels[section]??section} unavailable`} description="This control requires an approved environment-specific configuration before it can be enabled."/>}

function Workspace({context}:{context:MigrationAccessContext}){
 const location=useLocation(),navigate=useNavigate(),current=location.pathname.split('/')[2]||'dashboard'
 const[activeProjectId,setActiveProjectId]=useState(context.projects[0].id)
 const activeProject=context.projects.find(project=>project.id===activeProjectId)??context.projects[0],role=activeProject.migration_role
 const nav=useMemo(()=>roles[role].nav.map(id=>({id,label:labels[id]??id})),[role])
 const go=(section:string)=>navigate(migratePath(section))
 let content:React.ReactNode
 if(current==='dashboard')content=<OperationsWorkspace project={activeProject}/>
 else if(current==='projects')content=<PersistentProjects context={context} onOpen={id=>{setActiveProjectId(id);go('project')}}/>
 else if(current==='project')content=<PersistentProjectDetail project={activeProject}/>
 else if(current==='processing')content=<ProcessingWorkspace project={activeProject}/>
 else if(current==='scanning'||current==='uploads')content=<CaptureWorkspace project={activeProject}/>
 else if(current==='validation'||current==='low-confidence'||current==='unclassified')content=<ReviewWorkspace project={activeProject} type="validation"/>
 else if(current==='qa'||current==='rejected')content=<ReviewWorkspace project={activeProject} type="qa"/>
 else if(current==='matching')content=<MatchingWorkspace project={activeProject}/>
 else if(current==='imports')content=<ImportWorkspace project={activeProject}/>
 else if(current==='folders'||current==='completed')content=<CompletedRecordsWorkspace project={activeProject} onOpenPatient={hidCode=>navigate(`/hospital/patient-records/${encodeURIComponent(hidCode)}`)}/>
 else if(current==='team')content=<PersistentTeam project={activeProject}/>
 else if(current==='audits')content=<OperationsWorkspace project={activeProject} mode="audit"/>
 else if(current==='reports')content=<OperationsWorkspace project={activeProject} mode="reports"/>
 else content=<Unavailable section={current}/>
 return <div className="migrate-shell"><aside className="migrate-sidebar"><div className="migrate-brand"><HIDLogo size="sm"/><span className="migrate-brand-name">Migrate</span></div><nav className="migrate-nav">{nav.map(item=><button key={item.id} className={current===item.id?'active':''} onClick={()=>go(item.id)}>{item.label}</button>)}</nav><div className="migrate-sidebar-foot"><div style={{fontSize:11,color:'var(--t3)'}}>{activeProject.organization_name}</div><strong style={{fontSize:12}}>{activeProject.facility_name}</strong></div></aside>
 <main className="migrate-main"><header className="migrate-topbar"><div className="migrate-mobile-brand"><HIDLogo size="sm"/><span>HID Migrate</span></div><div className="migrate-search"><span>{activeProject.project_reference} · protected project workspace</span></div><select className="migrate-role" aria-label="Active migration project" value={activeProject.id} onChange={event=>{setActiveProjectId(event.target.value);go('dashboard')}}>{context.projects.map(project=><option key={project.id} value={project.id}>{project.name} · {roles[project.migration_role].label}</option>)}</select></header><div className="migrate-content"><div className="migrate-project-context"><label>Active migration project</label><select value={activeProject.id} onChange={event=>{setActiveProjectId(event.target.value);go('dashboard')}}>{context.projects.map(project=><option key={project.id} value={project.id}>{project.name} · {project.project_reference}</option>)}</select></div>{content}</div></main>
 <nav className="migrate-mobile-nav">{nav.slice(0,4).map(item=><button key={item.id} className={current===item.id?'active':''} onClick={()=>go(item.id)}>{item.label}</button>)}<button onClick={()=>go('dashboard')}>More</button></nav></div>
}

export default function MigratePage(){return <MigrationAccessGate>{context=>context.projects.length?<Workspace context={context}/>:<ProjectSetup context={context}/>}</MigrationAccessGate>}

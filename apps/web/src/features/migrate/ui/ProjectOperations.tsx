import React, { useCallback, useEffect, useState } from 'react'
import { Button, EmptyState, Input, Modal, PageLoader, Select, showToast } from '../../../components/ui'
import { listMigrationResource, runMigrationOperation } from '../api/migrationOperations'
import type {
  MigrationAccessContext,
  MigrationBatchRecord,
  MigrationProjectAccess,
  MigrationProjectMemberRecord,
  MigrationProjectRecord,
  MigrationRole,
  MigrationWorkAssignmentRecord,
} from '../domain'
import { MigrationStatusBadge } from './MigrationStatusBadge'

type EligibleStaff = {
  id: string
  staff_account_id: string
  staff: { full_name: string; email: string; role: string; active: boolean; deleted_at: string | null } | null
}

const roleOptions = [
  ['migration_administrator', 'Migration Administrator'],
  ['project_manager', 'Project Manager'],
  ['medical_records_officer', 'Medical Records Officer'],
  ['scanner_operator', 'Scanner Operator'],
  ['validation_officer', 'Validation Officer'],
  ['qa_reviewer', 'QA Reviewer'],
].map(([value, label]) => ({ value, label }))

function SectionTitle({ title, description, action }: { title: string; description: string; action?: React.ReactNode }) {
  return <div className="migrate-pagehead"><div><h1>{title}</h1><p>{description}</p></div>{action && <div className="migrate-actions">{action}</div>}</div>
}

export function ProjectSetup({ context }: { context: MigrationAccessContext }) {
  return <div className="migrate-content" style={{ maxWidth: 760, margin: '0 auto' }}>
    <PersistentProjects context={context} />
  </div>
}

export function PersistentProjects({ context, onOpen }: { context: MigrationAccessContext; onOpen?: (projectId: string) => void }) {
  const [projects, setProjects] = useState<MigrationProjectRecord[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const scopes = context.creation_scopes ?? []
  const [form, setForm] = useState({
    scope: scopes[0] ? `${scopes[0].organization_id}|${scopes[0].facility_id}` : '',
    project_reference: '', name: '', record_location: '', estimated_patients: '0',
    estimated_folders: '0', start_date: '', expected_completion: '',
  })

  const load = useCallback(async (cursor: string | null = null) => {
    setLoading(true)
    try {
      const result = await listMigrationResource<MigrationProjectRecord>('projects', undefined, cursor)
      setProjects(current => cursor ? [...current, ...result.data] : result.data)
      setNextCursor(result.page.next_cursor)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Projects could not be loaded.', 'error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(null) }, [load])

  async function createProject() {
    const [organization_id, facility_id] = form.scope.split('|')
    setSaving(true)
    try {
      await runMigrationOperation('create_project', {
        organization_id, facility_id, project_reference: form.project_reference, name: form.name,
        record_location: form.record_location, estimated_patients: Number(form.estimated_patients),
        estimated_folders: Number(form.estimated_folders), start_date: form.start_date || null,
        expected_completion: form.expected_completion || null,
      })
      showToast('Migration project created.', 'success')
      setOpen(false)
      window.location.reload()
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Project could not be created.', 'error')
    } finally {
      setSaving(false)
    }
  }

  async function setStatus(project: MigrationProjectRecord, status: MigrationProjectRecord['status']) {
    try {
      await runMigrationOperation('set_project_status', { project_id: project.id, status })
      showToast(`Project ${status}.`, 'success')
      await load(null)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Project status could not be changed.', 'error')
    }
  }

  const canCreate = scopes.length > 0
  return <>
    <SectionTitle title="Migration projects" description="Persistent project setup, lifecycle and operational estimates."
      action={canCreate ? <Button onClick={() => setOpen(true)}>Create project</Button> : undefined} />
    {loading ? <PageLoader label="Loading migration projects..." /> : projects.length === 0 ? <EmptyState
      icon={<span style={{ fontSize: 28 }}>HID</span>} title="No migration projects"
      description={canCreate ? 'Create the first project for an approved facility.' : 'No active project is assigned to this account.'}
      action={canCreate ? <Button onClick={() => setOpen(true)}>Create project</Button> : undefined}
    /> : <div className="migrate-card migrate-table-wrap"><table className="migrate-table"><thead><tr>
      <th>Project</th><th>Location</th><th>Est. patients</th><th>Est. folders</th><th>Expected</th><th>Status</th><th>Lifecycle</th>
    </tr></thead><tbody>{projects.map(project => <tr key={project.id}>
      <td><strong>{project.name}</strong><br/><span className="migrate-mono">{project.project_reference}</span></td>
      <td>{project.record_location || 'Not specified'}</td><td>{project.estimated_patients.toLocaleString()}</td>
      <td>{project.estimated_folders.toLocaleString()}</td><td>{project.expected_completion || 'Not set'}</td>
      <td><MigrationStatusBadge status={project.status} /></td><td><div className="migrate-actions">
        {project.status !== 'active' && project.status !== 'completed' && project.status !== 'cancelled' && <Button size="sm" onClick={() => void setStatus(project, 'active')}>Start</Button>}
        {project.status === 'active' && <Button size="sm" variant="outline" onClick={() => void setStatus(project, 'paused')}>Pause</Button>}
        {project.status === 'paused' && <Button size="sm" onClick={() => void setStatus(project, 'active')}>Resume</Button>}
        {!['completed','cancelled'].includes(project.status) && <Button size="sm" variant="ghost" onClick={() => void setStatus(project, 'completed')}>Complete</Button>}
        {onOpen && <Button size="sm" variant="ghost" onClick={() => onOpen(project.id)}>Open</Button>}
      </div></td>
    </tr>)}</tbody></table>{nextCursor && <div style={{padding:16,textAlign:'center'}}><Button variant="outline" loading={loading} onClick={()=>void load(nextCursor)}>Load more projects</Button></div>}</div>}
    <Modal open={open} onClose={() => setOpen(false)} title="Create migration project" width={620}>
      <div style={{ display: 'grid', gap: 14 }}>
        <Select label="Organization and facility" value={form.scope} onChange={event => setForm({...form, scope:event.target.value})}
          options={scopes.map(scope => ({ value:`${scope.organization_id}|${scope.facility_id}`, label:`${scope.organization_name} - ${scope.facility_name}` }))} />
        <Input label="Project reference" value={form.project_reference} onChange={event => setForm({...form, project_reference:event.target.value})} placeholder="MIG-PRJ-2041" />
        <Input label="Project name" value={form.name} onChange={event => setForm({...form, name:event.target.value})} />
        <Input label="Record location" value={form.record_location} onChange={event => setForm({...form, record_location:event.target.value})} />
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
          <Input label="Estimated patients" type="number" min="0" value={form.estimated_patients} onChange={event => setForm({...form, estimated_patients:event.target.value})} />
          <Input label="Estimated folders" type="number" min="0" value={form.estimated_folders} onChange={event => setForm({...form, estimated_folders:event.target.value})} />
          <Input label="Start date" type="date" value={form.start_date} onChange={event => setForm({...form, start_date:event.target.value})} />
          <Input label="Expected completion" type="date" value={form.expected_completion} onChange={event => setForm({...form, expected_completion:event.target.value})} />
        </div>
        <div className="migrate-actions"><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button loading={saving} onClick={() => void createProject()}>Create project</Button></div>
      </div>
    </Modal>
  </>
}

export function PersistentProjectDetail({ project }: { project: MigrationProjectAccess }) {
  const [batches, setBatches] = useState<MigrationBatchRecord[]>([])
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ batch_reference:'', name:'', estimated_folders:'0' })
  const canManage = project.capabilities.includes('project.manage')
  const load = useCallback(async () => {
    try { setBatches((await listMigrationResource<MigrationBatchRecord>('batches', project.id)).data) }
    catch (error) { showToast(error instanceof Error ? error.message : 'Batches could not be loaded.', 'error') }
  }, [project.id])
  useEffect(() => { void load() }, [load])

  async function createBatch() {
    try {
      await runMigrationOperation('create_batch', {
        project_id:project.id, batch_reference:form.batch_reference, name:form.name,
        estimated_folders:Number(form.estimated_folders),
      })
      showToast('Migration batch created.', 'success'); setOpen(false); await load()
    } catch (error) { showToast(error instanceof Error ? error.message : 'Batch could not be created.', 'error') }
  }

  return <>
    <SectionTitle title={project.name} description={`${project.project_reference} · ${project.organization_name} · ${project.facility_name}`}
      action={canManage ? <Button onClick={()=>setOpen(true)}>Create batch</Button> : undefined}/>
    <div className="migrate-source">
      <div><small>Organization</small><strong>{project.organization_name}</strong></div>
      <div><small>Facility</small><strong>{project.facility_name}</strong></div>
      <div><small>Your role</small><strong>{project.migration_role.replace(/_/g,' ')}</strong></div>
      <div><small>Project reference</small><strong className="migrate-mono">{project.project_reference}</strong></div>
    </div>
    <div style={{height:18}}/><section className="migrate-card migrate-section"><div className="migrate-section-head"><h2>Migration batches</h2><span>{batches.length} batches</span></div>
      {batches.length===0?<p style={{color:'var(--t3)'}}>No batches have been created.</p>:batches.map(batch=><div className="migrate-attention" key={batch.id}><div><strong>{batch.name}</strong><small className="migrate-mono">{batch.batch_reference} · {batch.estimated_folders.toLocaleString()} estimated folders</small></div><MigrationStatusBadge status={batch.status}/></div>)}
    </section>
    <Modal open={open} onClose={()=>setOpen(false)} title="Create migration batch">
      <div style={{display:'grid',gap:14}}><Input label="Batch reference" value={form.batch_reference} onChange={event=>setForm({...form,batch_reference:event.target.value})} placeholder="MIG-BAT-0001"/>
        <Input label="Batch name" value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/>
        <Input label="Estimated folders" type="number" min="0" value={form.estimated_folders} onChange={event=>setForm({...form,estimated_folders:event.target.value})}/>
        <div className="migrate-actions"><Button variant="outline" onClick={()=>setOpen(false)}>Cancel</Button><Button onClick={()=>void createBatch()}>Create batch</Button></div></div>
    </Modal>
  </>
}

export function PersistentTeam({ project }: { project: MigrationProjectAccess }) {
  const [members, setMembers] = useState<MigrationProjectMemberRecord[]>([])
  const [assignments, setAssignments] = useState<MigrationWorkAssignmentRecord[]>([])
  const [eligible, setEligible] = useState<EligibleStaff[]>([])
  const [loading, setLoading] = useState(true)
  const [memberOpen, setMemberOpen] = useState(false)
  const [assignmentOpen, setAssignmentOpen] = useState(false)
  const [staffMembershipId, setStaffMembershipId] = useState('')
  const [role, setRole] = useState<MigrationRole>('scanner_operator')
  const [assignment, setAssignment] = useState({ member_id:'', title:'', priority:'3', due_at:'' })
  const canManageMembers = project.capabilities.includes('member.manage')
  const canAssign = project.capabilities.includes('assignment.manage')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [memberResult, assignmentResult, eligibleResult] = await Promise.all([
        listMigrationResource<MigrationProjectMemberRecord>('members', project.id),
        listMigrationResource<MigrationWorkAssignmentRecord>('assignments', project.id),
        canManageMembers ? listMigrationResource<EligibleStaff>('eligible_staff', project.id) : Promise.resolve({data:[],page:{next_cursor:null}}),
      ])
      setMembers(memberResult.data); setAssignments(assignmentResult.data); setEligible(eligibleResult.data)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Team data could not be loaded.', 'error')
    } finally { setLoading(false) }
  }, [canManageMembers, project.id])
  useEffect(() => { void load() }, [load])

  async function addMember() {
    const candidate = eligible.find(item => item.id === staffMembershipId)
    if (!candidate) return
    try {
      await runMigrationOperation('upsert_member', {
        project_id:project.id, staff_account_id:candidate.staff_account_id,
        staff_membership_id:candidate.id, migration_role:role, active:true,
      })
      showToast('Project member saved.', 'success'); setMemberOpen(false); await load()
    } catch (error) { showToast(error instanceof Error ? error.message : 'Member could not be saved.', 'error') }
  }

  async function changeMemberAccess(member: MigrationProjectMemberRecord) {
    try {
      await runMigrationOperation('set_member_active', { project_id:project.id, project_member_id:member.id, active:!member.active })
      showToast('Member access updated.', 'success'); await load()
    } catch (error) { showToast(error instanceof Error ? error.message : 'Member access could not be updated.', 'error') }
  }

  async function createAssignment() {
    try {
      await runMigrationOperation('create_assignment', {
        project_id:project.id, project_member_id:assignment.member_id, title:assignment.title,
        priority:Number(assignment.priority), due_at:assignment.due_at || null,
      })
      showToast('Work assigned.', 'success'); setAssignmentOpen(false); await load()
    } catch (error) { showToast(error instanceof Error ? error.message : 'Work could not be assigned.', 'error') }
  }

  if (loading) return <PageLoader label="Loading project team..." />
  return <>
    <SectionTitle title="Project team" description={`${project.name} · roles, access and current work ownership.`} action={<>
      {canAssign && <Button variant="outline" onClick={() => setAssignmentOpen(true)}>Assign work</Button>}
      {canManageMembers && <Button onClick={() => setMemberOpen(true)}>Add team member</Button>}
    </>} />
    <div className="migrate-card migrate-table-wrap"><table className="migrate-table"><thead><tr><th>Staff member</th><th>HID role</th><th>Migrate role</th><th>Access</th><th></th></tr></thead>
      <tbody>{members.map(member => <tr key={member.id}><td><strong>{member.staff?.full_name ?? 'Unknown staff'}</strong><br/><small>{member.staff?.email}</small></td>
        <td>{member.staff?.role}</td><td>{member.migration_role.replace(/_/g,' ')}</td><td><MigrationStatusBadge status={member.active ? 'active' : 'cancelled'} /></td>
        <td>{canManageMembers && <Button size="sm" variant="ghost" onClick={() => void changeMemberAccess(member)}>{member.active ? 'Revoke' : 'Restore'}</Button>}</td></tr>)}</tbody>
    </table></div>
    <div style={{height:18}}/><section className="migrate-card migrate-section"><div className="migrate-section-head"><h2>Work assignments</h2><span>{assignments.length} current records</span></div>
      {assignments.length === 0 ? <p style={{color:'var(--t3)'}}>No work has been assigned yet.</p> : assignments.map(item => <div className="migrate-attention" key={item.id}><div><strong>{item.title}</strong><small>Priority {item.priority} · {item.due_at ? new Date(item.due_at).toLocaleDateString() : 'No due date'}</small></div><MigrationStatusBadge status={item.status} /></div>)}
    </section>
    <Modal open={memberOpen} onClose={() => setMemberOpen(false)} title="Add project member">
      <div style={{display:'grid',gap:14}}><Select label="Eligible HID staff" value={staffMembershipId} onChange={event=>setStaffMembershipId(event.target.value)}
        options={eligible.filter(item=>item.staff?.active&&!item.staff?.deleted_at).map(item=>({value:item.id,label:`${item.staff?.full_name} - ${item.staff?.email}`}))}/>
        <Select label="Migration role" value={role} onChange={event=>setRole(event.target.value as MigrationRole)} options={roleOptions}/>
        <div className="migrate-actions"><Button variant="outline" onClick={()=>setMemberOpen(false)}>Cancel</Button><Button onClick={()=>void addMember()}>Save member</Button></div></div>
    </Modal>
    <Modal open={assignmentOpen} onClose={() => setAssignmentOpen(false)} title="Assign project work">
      <div style={{display:'grid',gap:14}}><Select label="Team member" value={assignment.member_id} onChange={event=>setAssignment({...assignment,member_id:event.target.value})}
        options={members.filter(item=>item.active).map(item=>({value:item.id,label:item.staff?.full_name ?? item.id}))}/>
        <Input label="Assignment title" value={assignment.title} onChange={event=>setAssignment({...assignment,title:event.target.value})}/>
        <Select label="Priority" value={assignment.priority} onChange={event=>setAssignment({...assignment,priority:event.target.value})}
          options={[1,2,3,4,5].map(value=>({value:String(value),label:`${value}${value===1?' - highest':''}`}))}/>
        <Input label="Due date" type="datetime-local" value={assignment.due_at} onChange={event=>setAssignment({...assignment,due_at:event.target.value})}/>
        <div className="migrate-actions"><Button variant="outline" onClick={()=>setAssignmentOpen(false)}>Cancel</Button><Button onClick={()=>void createAssignment()}>Assign work</Button></div></div>
    </Modal>
  </>
}

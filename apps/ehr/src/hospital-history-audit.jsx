import React from 'react';
import { Icon, Card, Badge, SectionHeader, Status, TabBar, Input } from './primitives';
import { PATIENT, MEDICATIONS, VITALS_HISTORY, LAB_RESULTS, ENCOUNTERS, IMMUNISATIONS, AUDIT_LOG } from './hospital-data';
import { MedicationsPanel, VitalsPanel } from './hospital-components';

/* hospital-history-audit.jsx - PatientHistory & ActivityLog */

const PatientHistory = ({
  patient = PATIENT,
  encounters = ENCOUNTERS,
  medications = MEDICATIONS,
  labResults = LAB_RESULTS,
  vitalsHistory = VITALS_HISTORY,
  immunisations = IMMUNISATIONS
}) => {
  const [tab, setTab] = React.useState('encounters');

  const tabs = [
    { id: 'encounters', label: 'Encounters', icon: 'fileText', count: encounters.length },
    { id: 'medications', label: 'Medications', icon: 'pill', count: medications.length },
    { id: 'labs', label: 'Lab Results', icon: 'flask', count: labResults.length },
    { id: 'vitals', label: 'Vitals', icon: 'activity', count: vitalsHistory.length },
    { id: 'immunisations', label: 'Vaccines', icon: 'shield', count: immunisations.length },
  ];

  return (
    <div className="fade-in">
      <TabBar tabs={tabs} active={tab} onChange={setTab} />

      {/* Encounters Tab */}
      {tab === 'encounters' && (
        <div className="ehr-timeline" style={{ marginTop: 'var(--space-500)' }}>
          {encounters.map(enc => (
            <div key={enc.id} className="ehr-timeline-item">
              <div className="ehr-timeline-dot">
                <Icon name="fileText" size={12} />
              </div>
              <div className="ehr-timeline-content">
                <Card pad style={{ marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-300)' }}>
                    <div>
                      <span style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--text-heading)' }}>{enc.dept} Consultation</span>
                      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', marginLeft: 8 }}>by {enc.provider}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Badge variant="blue">{enc.type}</Badge>
                      <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>{enc.date}</span>
                    </div>
                  </div>

                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-body)', marginBottom: 'var(--space-300)' }}>
                    <strong>Chief Complaint:</strong> {enc.chiefComplaint}
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 'var(--space-300)' }}>
                    {enc.diagnosis.map((dx, idx) => (
                      <Badge key={idx} variant="neutral">{dx}</Badge>
                    ))}
                  </div>

                  <div style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', background: 'var(--surface-muted)', padding: 'var(--space-300)', borderRadius: 'var(--radius-md)' }}>
                    {enc.notes}
                  </div>

                  {enc.followUp && (
                    <div style={{ marginTop: 'var(--space-300)', fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <Icon name="calendar" size={12} /> Follow-up scheduled for: <strong>{enc.followUp}</strong>
                    </div>
                  )}
                </Card>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Medications Tab */}
      {tab === 'medications' && (
        <div style={{ marginTop: 'var(--space-500)' }}>
          <MedicationsPanel medications={medications} />
        </div>
      )}

      {/* Labs Tab */}
      {tab === 'labs' && (
        <div style={{ marginTop: 'var(--space-500)', display: 'flex', flexDirection: 'column', gap: 'var(--space-400)' }}>
          {labResults.map(lab => (
            <Card key={lab.id} pad>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--space-400)' }}>
                <div>
                  <span style={{ fontSize: 'var(--fs-md)', fontWeight: 700, color: 'var(--text-heading)' }}>{lab.panel}</span>
                  <span className="mono" style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)', marginLeft: 8 }}>{lab.id}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Status status={lab.status} />
                  <span style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>Ordered: {lab.ordered}</span>
                </div>
              </div>

              {lab.results.length > 0 ? (
                <div className="ehr-table-wrap">
                  <table className="ehr-table">
                    <thead>
                      <tr>
                        <th>Test Parameter</th>
                        <th>Observed Value</th>
                        <th>Unit</th>
                        <th>Reference Interval</th>
                        <th>Flag</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lab.results.map((res, idx) => (
                        <tr key={idx}>
                          <td style={{ fontWeight: 600 }}>{res.test}</td>
                          <td className="mono" style={{ fontWeight: 700, color: res.flag ? 'var(--danger-500)' : 'var(--text-heading)' }}>
                            {res.value}
                          </td>
                          <td>{res.unit}</td>
                          <td>{res.ref}</td>
                          <td>{res.flag ? <Badge variant="danger">HIGH ({res.flag})</Badge> : <Badge variant="neutral">Normal</Badge>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ padding: 'var(--space-400)', background: 'var(--surface-muted)', borderRadius: 'var(--radius-md)', fontSize: 'var(--fs-sm)', color: 'var(--text-secondary)', textAlign: 'center' }}>
                  Sample collected - Laboratory processing in progress
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Vitals Tab */}
      {tab === 'vitals' && (
        <div style={{ marginTop: 'var(--space-500)' }}>
          <VitalsPanel vitalsHistory={vitalsHistory} />
        </div>
      )}

      {/* Immunisations Tab */}
      {tab === 'immunisations' && (
        <div style={{ marginTop: 'var(--space-500)' }}>
          <div className="ehr-table-wrap">
            <table className="ehr-table">
              <thead>
                <tr>
                  <th>Vaccine / Immunisation</th>
                  <th>Date Administered</th>
                  <th>Anatomical Site</th>
                  <th>Batch / Lot No</th>
                  <th>Administered By</th>
                  <th>Next Booster Due</th>
                </tr>
              </thead>
              <tbody>
                {immunisations.map(imm => (
                  <tr key={imm.id}>
                    <td style={{ fontWeight: 700, color: 'var(--text-heading)' }}>{imm.vaccine}</td>
                    <td>{imm.date}</td>
                    <td>{imm.site}</td>
                    <td className="mono">{imm.lot}</td>
                    <td>{imm.givenBy}</td>
                    <td>{imm.nextDue ? <Badge variant="blue">{imm.nextDue}</Badge> : 'N/A'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

const ActivityLog = ({ auditLog = AUDIT_LOG }) => {
  const [filter, setFilter] = React.useState('');

  const filtered = auditLog.filter(log =>
    log.actor.toLowerCase().includes(filter.toLowerCase()) ||
    log.action.toLowerCase().includes(filter.toLowerCase()) ||
    log.resource.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <Card pad className="fade-in">
      <SectionHeader
        title="System Access & Medico-Legal Audit Log"
        sub="Append-only, immutable record of all patient chart views, break-glass events and clinical transactions."
      />

      <div style={{ marginTop: 'var(--space-400)', marginBottom: 'var(--space-500)' }}>
        <Input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter audit entries by clinician, action, or resource..."
          icon="search"
        />
      </div>

      <div className="ehr-table-wrap">
        <table className="ehr-table">
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Clinician / Actor</th>
              <th>Role</th>
              <th>Action Performed</th>
              <th>Resource / Patient</th>
              <th>IP Address</th>
              <th>Governance</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map(entry => (
              <tr key={entry.id} style={{ background: entry.breakGlass ? 'var(--danger-50)' : undefined }}>
                <td className="mono" style={{ fontSize: 'var(--fs-caption)' }}>
                  {new Date(entry.ts).toLocaleString()}
                </td>
                <td style={{ fontWeight: 600 }}>{entry.actor}</td>
                <td><Badge variant="neutral">{entry.role}</Badge></td>
                <td>{entry.action}</td>
                <td className="mono">{entry.resource}</td>
                <td className="mono" style={{ fontSize: 'var(--fs-caption)', color: 'var(--text-secondary)' }}>{entry.ip}</td>
                <td>
                  {entry.breakGlass ? (
                    <Badge variant="danger" icon="alertTriangle">BREAK-GLASS</Badge>
                  ) : (
                    <Badge variant="blue">Standard</Badge>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
};



export { PatientHistory, ActivityLog };

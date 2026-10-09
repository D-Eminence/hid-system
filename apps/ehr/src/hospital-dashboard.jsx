import React from 'react';
import { Button, Card, Badge, SectionHeader, KPICard, Status } from './primitives';

/* Legacy hospital dashboard widgets. All values come from caller-provided records. */

const HospitalDashboardWidgets = ({ appointments = [], beds = [], metrics = {}, onNavigate }) => {
  const occupiedBeds = beds.filter((bed) => bed.status === 'occupied').length;
  const openAppointments = appointments.filter((appointment) => appointment.status !== 'completed' && appointment.status !== 'cancelled').length;
  const navigate = (target) => () => onNavigate?.(target);
  const navigationAvailable = typeof onNavigate === 'function';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-600)' }}>
      <div className="ehr-grid-4">
        <KPICard label="Outpatient visits" value={String(metrics.outpatientVisits ?? 0)} icon="users" footer="Recorded for the selected period" />
        <KPICard label="Occupied beds" value={`${occupiedBeds} / ${beds.length}`} icon="bed" footer="Derived from current bed records" />
        <KPICard label="Emergency admissions" value={String(metrics.emergencyAdmissions ?? 0)} icon="zap" footer="Recorded for the selected period" />
        <KPICard label="Open appointments" value={String(openAppointments)} icon="calendar" footer="Derived from appointment records" />
      </div>

      <div className="ehr-quick-actions">
        <Button variant="primary" icon="user" onClick={navigate('identity_link')} disabled={!navigationAvailable}>Link Existing HID</Button>
        <Button variant="secondary" icon="activity" onClick={navigate('triage')} disabled={!navigationAvailable}>Record Vitals</Button>
        <Button variant="secondary" icon="calendar" onClick={navigate('appointments')} disabled={!navigationAvailable}>Book Appointment</Button>
        <Button variant="secondary" icon="flask" onClick={navigate('laboratory')} disabled={!navigationAvailable}>Order Lab Test</Button>
      </div>

      <div className="ehr-grid-2">
        <Card pad>
          <SectionHeader title="Clinic schedule" action={<Badge variant="blue">{openAppointments} open</Badge>} />
          {appointments.length === 0 ? (
            <p style={{ marginTop: 'var(--space-300)', color: 'var(--text-secondary)' }}>No appointment records are available.</p>
          ) : (
            <div className="ehr-table-wrap" style={{ marginTop: 'var(--space-300)' }}>
              <table className="ehr-table">
                <thead><tr><th>Time</th><th>Patient</th><th>Department</th><th>Status</th></tr></thead>
                <tbody>
                  {appointments.map((appointment) => (
                    <tr key={appointment.id}>
                      <td className="mono">{appointment.time || appointment.scheduledAt || 'Not entered'}</td>
                      <td style={{ fontWeight: 600 }}>{appointment.patientName || appointment.patient || 'Not entered'}</td>
                      <td>{appointment.dept || appointment.department || 'Not entered'}</td>
                      <td><Status status={appointment.status || 'unknown'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <Card pad>
          <SectionHeader title="Ward occupancy" action={<Badge variant="neutral">{occupiedBeds} / {beds.length} occupied</Badge>} />
          {beds.length === 0 ? (
            <p style={{ marginTop: 'var(--space-300)', color: 'var(--text-secondary)' }}>No bed records are available.</p>
          ) : (
            <div className="ehr-table-wrap" style={{ marginTop: 'var(--space-300)' }}>
              <table className="ehr-table">
                <thead><tr><th>Ward</th><th>Bed</th><th>Patient</th><th>Status</th></tr></thead>
                <tbody>
                  {beds.map((bed) => (
                    <tr key={bed.id || `${bed.ward}-${bed.bedNo}`}>
                      <td>{bed.ward || 'Not entered'}</td>
                      <td className="mono">{bed.bedNo || bed.bed || 'Not entered'}</td>
                      <td style={{ fontWeight: 600 }}>{bed.patientName || bed.patient || 'Unassigned'}</td>
                      <td><Status status={bed.status || 'unknown'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

export { HospitalDashboardWidgets };

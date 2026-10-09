import React from 'react';
import { Button, Card, PageHead, SectionHeader } from './primitives';

/* The production dashboard contains no fixture clinical or operational metrics. */
const RoleDashboard = ({ role, config, onNavigate }) => {
  const canLookupPatient = (role.nav || []).includes('patients');
  return (
    <div className="fade-in">
      <PageHead
        title={`Welcome, ${role.who}`}
        sub={`${role.label} • ${config.name}`}
      />
      <Card pad>
        <SectionHeader title="Secure clinical workflow" />
        <p style={{ color: 'var(--text-secondary)', lineHeight: 1.6, margin: 'var(--space-400) 0' }}>
          Patient information is loaded only after exact-HID lookup, active-facility authorization, and consent verification.
          Operational metrics remain unavailable until their audited aggregate API is connected.
        </p>
        {canLookupPatient && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-300)' }}>
            <Button variant="primary" icon="search" onClick={() => onNavigate('patients')}>Find Patient by HID</Button>
          </div>
        )}
      </Card>
    </div>
  );
};

export { RoleDashboard };

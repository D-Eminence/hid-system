import React from 'react';
import { Badge } from '@/components/ui/Primitives';

export type EhrWorkflowStep = 'lookup' | 'authorization' | 'encounter' | 'records';

interface WorkflowRailProps {
  active: EhrWorkflowStep;
}

const steps: ReadonlyArray<{ id: EhrWorkflowStep; label: string; description: string }> = [
  { id: 'lookup', label: '1. Find patient', description: 'Exact HID search' },
  { id: 'authorization', label: '2. Verify access', description: 'Identity + facility authorization' },
  { id: 'encounter', label: '3. Open encounter', description: 'Create or select a visit' },
  { id: 'records', label: '4. Record care', description: 'Notes, vitals, orders, documents' },
];

export const WorkflowRail: React.FC<WorkflowRailProps> = ({ active }) => (
  <div
    aria-label="EHR workflow"
    className="ehr-workflow-rail"
    style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
      gap: 'var(--space-300)',
      marginBottom: 'var(--space-500)',
    }}
  >
    {steps.map((step) => {
      const isActive = step.id === active;
      const isComplete = steps.findIndex((item) => item.id === step.id)
        < steps.findIndex((item) => item.id === active);
      return (
        <div
          key={step.id}
          style={{
            minWidth: 0,
            padding: 'var(--space-300)',
            border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border-subtle)'}`,
            borderRadius: 'var(--radius-lg)',
            background: isActive ? 'var(--surface-info)' : 'var(--surface)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-200)' }}>
            <span style={{ fontWeight: 'var(--fw-semibold)', color: 'var(--text-heading)', fontSize: 'var(--fs-sm)' }}>{step.label}</span>
            {isComplete && <Badge variant="blue">Done</Badge>}
            {isActive && <Badge variant="blue">Current</Badge>}
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--fs-caption)', marginTop: 4 }}>{step.description}</div>
        </div>
      );
    })}
  </div>
);

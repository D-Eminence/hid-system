import React from 'react';

interface StatusProps {
  status: string;
  label?: string;
}

export const Status: React.FC<StatusProps> = ({ status, label }) => {
  const map: Record<string, string> = {
    active: 'active', admitted: 'active', open: 'active', dispensed: 'active', paid: 'active',
    pending: 'pending', processing: 'pending', 'in-progress': 'pending',
    critical: 'critical', emergency: 'critical', overdue: 'critical', rejected: 'critical',
    inactive: 'inactive', discharged: 'inactive', closed: 'inactive', cancelled: 'inactive',
  };
  const cls = map[status] || 'inactive';
  return (
    <span className={`ehr-status ehr-status-${cls}`}>
      {label || status}
    </span>
  );
};

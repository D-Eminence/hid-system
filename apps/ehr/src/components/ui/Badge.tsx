import React from 'react';
import { Icon, IconName } from './Icon';

interface BadgeProps {
  children: React.ReactNode;
  variant?: 'blue' | 'neutral' | 'dark' | 'danger' | 'success' | 'warning';
  icon?: IconName;
}

export const Badge: React.FC<BadgeProps> = ({ children, variant = 'blue', icon }) => (
  <span className={`hid-badge hid-badge-${variant}`}>
    {icon && <Icon name={icon} size={10} />}
    {children}
  </span>
);

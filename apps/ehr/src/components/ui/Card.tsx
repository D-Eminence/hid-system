import React from 'react';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  pad?: boolean;
}

export const Card: React.FC<CardProps> = ({ children, className = '', style, onClick, pad = true }) => (
  <div
    className={['hid-card', pad ? 'hid-card-pad' : '', className].filter(Boolean).join(' ')}
    style={{ cursor: onClick ? 'pointer' : undefined, ...style }}
    onClick={onClick}
  >
    {children}
  </div>
);

import React, { useState } from 'react';
import { Icon } from '@/components/ui/Primitives';
import { NAV_ITEMS } from '@/config/ehr';
import type { EhrFacilityContext, EhrStaffRole } from '@/types/ehr.types';

// ---------------------------------------------------------------------------
// TopBar
// ---------------------------------------------------------------------------

interface TopBarProps {
  role: EhrStaffRole;
  facility: EhrFacilityContext;
  onSearch?: (query: string) => void;
  onNotifications?: () => void;
  onLogout: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  role,
  facility,
  onSearch,
  onNotifications,
  onLogout,
}) => {
  const [showRoleMenu, setShowRoleMenu] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearchSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (searchQuery.trim() && onSearch) {
      onSearch(searchQuery);
    }
  };

  return (
    <header className="ehr-topbar">
      {/* EHR product and active facility context */}
      <a
        href="#"
        className="ehr-topbar-brand"
        onClick={(e) => e.preventDefault()}
      >
        <div
          style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--radius-md)',
            background: 'var(--accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#fff',
            fontWeight: 800,
            fontSize: 14,
          }}
        >
          HID
        </div>
        <div>
          <div className="ehr-topbar-brand-name">HID EHR</div>
          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', lineHeight: 1 }}>
            {facility.name}
          </div>
        </div>
      </a>

      {/* Global Patient Search */}
      <form onSubmit={handleSearchSubmit} className="ehr-topbar-search">
        <input
          type="text"
          className="ehr-topbar-search-input"
          placeholder="Enter exact HID to verify patient access..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <span className="ehr-topbar-search-icon">
          <Icon name="search" size={16} />
        </span>
      </form>

      {/* Right Actions and verified staff session */}
      <div className="ehr-topbar-actions">
        <button type="button" className="ehr-topbar-icon-btn" aria-label="Notifications" title={onNotifications ? 'Notifications' : 'Notifications are unavailable'} onClick={onNotifications} disabled={!onNotifications}>
          <Icon name="bell" size={17} />
        </button>
        <div className="ehr-role-dropdown">
          <button
            type="button"
            className="ehr-avatar-chip"
            aria-expanded={showRoleMenu}
            aria-haspopup="menu"
            onClick={() => setShowRoleMenu(!showRoleMenu)}
          >
            <div className="ehr-avatar-initials">{role.initials}</div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left' }}>
              <span style={{ fontSize: 'var(--fs-sm)', fontWeight: 600, lineHeight: 1.2 }}>{role.label}</span>
              <span style={{ fontSize: '10px', color: 'var(--text-secondary)', fontWeight: 400 }}>{role.who}</span>
            </div>
            <Icon name="chevronDown" size={14} />
          </button>

          {showRoleMenu && (
            <div className="ehr-role-menu">
              <div className="ehr-role-menu-head">Verified Staff Session</div>
              <div style={{ padding: 'var(--space-300)', fontSize: 'var(--fs-sm)' }}>
                <div style={{ fontWeight: 600 }}>{role.who}</div>
                <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{role.label}</div>
                <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{facility.name}</div>
                {facility.code && <div className="mono" style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{facility.code}</div>}
              </div>
              <div style={{ borderTop: '1px solid var(--border-subtle)', padding: 'var(--space-200)' }}>
                <button
                  className="ehr-role-menu-item"
                  onClick={onLogout}
                  style={{ color: 'var(--danger-500)' }}
                >
                  <Icon name="logOut" size={14} />
                  <span>Sign Out</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};

// ---------------------------------------------------------------------------
// TopNav
// ---------------------------------------------------------------------------

interface TopNavProps {
  nav: string;
  onNavChange: (id: string) => void;
  role: EhrStaffRole;
}

export const TopNav: React.FC<TopNavProps> = ({ nav, onNavChange, role }) => {
  const items = NAV_ITEMS.filter((item) => role.nav.includes(item.id));

  return (
    <nav className="ehr-topnav" aria-label="EHR navigation">
      <span className="ehr-topnav-label">Workspace</span>
      {items.map((item) => {
        const isActive = nav === item.id;
        return (
          <button
            key={item.id}
            className={`ehr-topnav-item ${isActive ? 'active' : ''}`}
            onClick={() => onNavChange(item.id)}
            aria-current={isActive ? 'page' : undefined}
          >
            <Icon name={item.icon as Parameters<typeof Icon>[0]['name']} size={16} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
};

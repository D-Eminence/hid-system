import React from 'react';
import { Icon } from './primitives';
import { NAV_ITEMS, enabledModules } from '@/config/ehr';

/* ehr-shell.jsx - TopBar, TopNav, role switcher & main application chrome */

const TopBar = ({ role, config, onSearch, onNotifications, onLogout }) => {
  const [showRoleMenu, setShowRoleMenu] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState('');

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (searchQuery.trim() && onSearch) {
      onSearch(searchQuery);
    }
  };

  return (
    <header className="ehr-topbar">
      {/* Brand & Hospital Name */}
      <a href="#" className="ehr-topbar-brand" onClick={(e) => { e.preventDefault(); }}>
        <div style={{
          width: 32, height: 32, borderRadius: 'var(--radius-md)', background: 'var(--accent)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
          fontWeight: 800, fontSize: 14
        }}>
          HID
        </div>
        <div>
          <div className="ehr-topbar-brand-name">{config.name}</div>
          <div style={{ fontSize: '10px', color: 'var(--text-secondary)', lineHeight: 1 }}>{config.type.replace('_', ' ').toUpperCase()}</div>
        </div>
      </a>

      {/* Exact HID lookup only; patient identifiers are submitted in a protected request body. */}
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

      {/* Right Actions & Role Switcher */}
      <div className="ehr-topbar-actions">
        {/* Notifications */}
        <button type="button" className="ehr-topbar-icon-btn ehr-notif-badge" title={onNotifications ? 'Notifications' : 'Notifications are unavailable'} onClick={onNotifications} disabled={!onNotifications}>
          <Icon name="bell" size={18} />
        </button>

        {/* Verified staff session. Roles cannot be changed in the browser. */}
        <div className="ehr-role-dropdown">
          <button type="button" className="ehr-avatar-chip" onClick={() => setShowRoleMenu(!showRoleMenu)}>
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
                <div style={{ color: 'var(--text-secondary)', marginTop: 2 }}>{config.name}</div>
              </div>
              <div style={{ borderTop: '1px solid var(--border-subtle)', padding: 'var(--space-200)' }}>
                <button className="ehr-role-menu-item" onClick={onLogout} style={{ color: 'var(--danger-500)' }}>
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

const TopNav = ({ nav, onNavChange, role, config }) => {
  // Filter nav items by role.nav AND enabledModules(config.departments)
  const enabledMods = enabledModules(config.departments);
  const visibleNavIds = (role.nav || []).filter(id => enabledMods.has(id));

  const items = NAV_ITEMS.filter(n => visibleNavIds.includes(n.id));

  return (
    <nav className="ehr-topnav">
      {items.map(item => {
        const isActive = nav === item.id;
        return (
          <button
            key={item.id}
            className={`ehr-topnav-item ${isActive ? 'active' : ''}`}
            onClick={() => onNavChange(item.id)}
          >
            <Icon name={item.icon} size={16} />
            <span>{item.label}</span>
          </button>
        );
      })}
    </nav>
  );
};



export { TopBar, TopNav };

update platform.control_settings
set enabled = false,
    reason = 'Initial platform control state',
    row_version = row_version + 1,
    updated_by = null,
    updated_at = clock_timestamp()
where control_key = 'maintenance_mode'
  and enabled = true
  and reason = 'Initial platform control state';

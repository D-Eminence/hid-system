# Database configuration conversion: code trace and remaining gaps

Staging update, 2026-10-04: the source rows are preserved and reconciled. The
supported catalogue and six native controls were imported and verified on
staging. Public pricing and six-control browser connections are deployed.
The remaining operational gaps are billing settings, editable staff flags,
dynamic AI routing, and four unsupported signup/HID Migrate switches.
Operator steps and validation: `SUPPORTED_CONFIGURATION_MIGRATION.md`.

Updated 2026-10-03 after tracing the application branch at c4b5445. Full evidence,
field mappings, consumers and route gaps are in
`DATABASE_CONFIGURATION_TRACE.md`. Product/price fields, six native controls
and membership-role aliases are defined in code; do not ask the developer to
restate those contracts. Actual protected source rows and target baselines are
were used to prepare and verify their supported staging mappings.

The migration preserves the exact existing source rows. The current backend
does not define working destinations for all legacy configuration. Completing
operational conversion requires the application's target schema; infrastructure
work must not invent business behavior.

| Existing source | Current application destination | Missing developer contract |
| --- | --- | --- |
| `hid_platform_billing_settings` | No working billing-settings counterpart | Target table/columns and existing application reader for currency, trial/grace days, proration, fees and restrictions, or confirmation that exact retained values are sufficient for this release |
| `hid_staff_role_policies` | `auth.roles`, `auth.permissions`, `auth.role_permissions` provide a different permission vocabulary | Source role and each legacy boolean's target permission(s), including false/deny behavior; migration must not infer additional grants |
| `hid_ai_workload_routes` | No corresponding working workload/model route table | Target fields or existing runtime configuration contract, source model UUID-to-target identifier mapping, processing/fallback semantics, or explicit preservation-only disposition |
| `hid_commercial_products`, `hid_commercial_prices` | `platform.commercial_products`, `platform.commercial_prices`; supported staging mappings verified | No missing supported mapping. Unsupported source subscription/availability values remain in the immutable archive |
| `hid_platform_controls` | Six conversions and their enforcement are defined in `platform.control_settings`; actual values imported | The four separate signup/HID Migrate flags lack equivalent behavior and need an implementation or release disposition |

Evidence in the checked-in schema:

- `services/ehr-api/database/migrations/0039_platform_control_settings.sql`
  constrains the six working controls.
- `services/ehr-api/database/migrations/0043_authoritative_product_pricing.sql`
  defines the current product/price fields and constraints.
- `services/ehr-api/database/migrations/0002_auth_and_canonical_identity.sql`
  defines the role and permission tables.
- `services/ehr-api/database/migrations/0062_customer_history_access.sql`
  preserves unsupported source values in an immutable archive. It does not
  introduce a billing engine, permission crosswalk or AI routing implementation.

The trace also found older browser calls to unserved `/api/v1/functions/*`
routes. Public pricing and six controls have current REST APIs to connect to;
the old billing, editable staff-policy and AI admin behaviors lack complete
counterparts. A database mapping file alone cannot repair these route/service
gaps. The developer should supply the original feature implementations or
confirm their release dispositions. Unsupported values stay preserved and
pending activation. No customer data entry or invented business rules are
requested.

The supported product/price/control mapper already requires exact source and
target hashes, matching product relationships, an authorized existing actor,
audit events and repeat/no-overwrite checks. Its current mapping format is
documented in `CUSTOMER_DATA_COMPLETION.md`. New actions can be implemented
against the developer's supplied contract when it arrives.

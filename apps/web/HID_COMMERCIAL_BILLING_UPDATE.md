# HID commercial architecture and platform billing update

Status: implemented application and database contracts; production database deployment pending.

## Public experience

- Canonical positioning: “One Health Identity. Connected Care. Accessible Records.”
- Product, solution, developer, pricing and EHR configuration routes.
- HID EHR presented as the modular core hospital subscription.
- Laboratory, Pharmacy and Migrate clearly support add-on and standalone contexts.
- Configurator captures facility type, departments and add-ons into the sales request.
- Pricing reads the public, RLS-controlled catalog view and falls back to contact-sales language until configured.
- HID Migrate usage pricing is seeded at an editable NGN 500 per file; it is not embedded in frontend code.

## Platform Admin

- Dedicated `/eminence/billing` module preserves the existing dashboard.
- Product catalog and multiple pricing contexts.
- Plans, organization subscriptions, entitlements, invoices, payments and platform billing settings.
- Trial, active, past-due, grace-period, restricted, suspended, cancelled and expired states.
- Progressive restriction settings explicitly preserve critical clinical workflows.
- Product, price and subscription changes are written to the append-only HID audit stream.

## Deployment boundary

Apply `20260722220000_platform_billing_subscriptions.sql` and deploy `admin-billing` before enabling live admin mutations. Payment-provider collection, tax rules and automated recurring invoicing remain provider decisions and are not fabricated by this implementation.

# 0162 undo: the billing roles and codes

Not in the migration ledger and never run by the release. Only with the owner's approval, on a database where
every later BILL-1 file has been undone first (this file's undo follows 0163's undo), in one transaction, after a backup.
Every billing row (bills, payments, receipts, till days, stock) is lost by an undo: export what the facility needs
first. Undoing does not reverse what staff did with the money; it only removes the schema.

```sql
begin;
-- Only while no membership holds cashier or billing_officer (SX-4 removes them first; the sealed QA logins are
-- ended by support). Then, with the role table checked by hand: the eight roles still hold every code 0162's
-- release_c_codes lists, and the rows of the 17 codes are the 58 0162 pins (rows_md5). Codes other release lanes
-- added to the shared roles are not 0162's and stay.
delete from auth.role_permissions where permission_code like 'billing.%'
   or permission_code in ('pharmacy.walk-in.create', 'pharmacy.stock.read', 'pharmacy.stock.manage');
delete from auth.roles where code in ('cashier', 'billing_officer');
delete from auth.permissions where code like 'billing.%'
   or code in ('pharmacy.walk-in.create', 'pharmacy.stock.read', 'pharmacy.stock.manage');
-- identity.staff_invitable_roles and the SX-4 role functions: re-create them from 0151's tree
-- (git show 95fa1e52:services/ehr-api/database/migrations/<the file that last made each>), md5 as 0162 pins "before".
drop schema commercial;
delete from migration.schema_migrations where version = '0162_billing_roles_and_codes.sql';
commit;
```

Audit rows 0162 wrote stay (append-only).

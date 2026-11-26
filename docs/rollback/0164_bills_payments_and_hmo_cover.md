# 0164 undo: bills, payments and HMO cover

Not in the migration ledger and never run by the release. Only with the owner's approval, on a database where
every later BILL-1 file has been undone first (this file's undo follows 0165's undo), in one transaction, after a backup.
Every billing row (bills, payments, receipts, till days, stock) is lost by an undo: export what the facility needs
first. Undoing does not reverse what staff did with the money; it only removes the schema.

```sql
begin;
-- Every function 0164 made (list them with:
--   select oid::regprocedure from pg_proc where pronamespace = 'commercial'::regnamespace
--     and prosrc is not null and oid::regprocedure::text ~ '^commercial\.(bill|staff_source|patient_card|resolve_health_id|hmo_|outstanding|work_item_bills)')
-- then:
drop table commercial.bill_events, commercial.hmo_covers, commercial.payments, commercial.bill_lines, commercial.bills;
delete from migration.schema_migrations where version = '0164_bills_payments_and_hmo_cover.sql';
commit;
```

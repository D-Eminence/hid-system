# 0167 undo: the billing and stock hooks

Not in the migration ledger and never run by the release. Only with the owner's approval, on a database where
every later BILL-1 file has been undone first (this file's undo follows nothing (0167 is the last)), in one transaction, after a backup.
Every billing row (bills, payments, receipts, till days, stock) is lost by an undo: export what the facility needs
first. Undoing does not reverse what staff did with the money; it only removes the schema.

```sql
begin;
drop trigger zz_billing_check_in on ehr.visit_queue;
drop trigger zz_billing_triage on ehr.visit_queue;
drop trigger zz_billing_acceptance on pharmacy.work_item_acceptances;
drop trigger zz_billing_lab_work_item on lab.work_items;
drop trigger zz_billing_stock_and_gate on pharmacy.dispensings;
drop trigger zz_billing_reversal on pharmacy.dispensing_reversals;
drop trigger zz_billing_collect_gate on lab.specimens;
drop function commercial.hook_check_in(), commercial.hook_triage(), commercial.hook_pharmacy_acceptance(),
  commercial.hook_lab_work_item(), commercial.hook_dispensing(), commercial.hook_dispensing_reversal(),
  commercial.hook_specimen_collected(), commercial.work_item_line(uuid, uuid, text, uuid, text, text, text, numeric, text),
  commercial.pay_before_refusal(uuid, text, uuid), commercial.hook_facility(uuid);
delete from migration.schema_migrations where version = '0167_billing_and_stock_hooks.sql';
commit;
```

Dispensings, reversals, check-ins, acceptances and specimen collections then work exactly as in Release C.

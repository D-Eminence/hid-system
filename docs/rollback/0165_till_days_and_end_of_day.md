# 0165 undo: till days and the money commands

Not in the migration ledger and never run by the release. Only with the owner's approval, on a database where
every later BILL-1 file has been undone first (this file's undo follows 0166's undo), in one transaction, after a backup.
Every billing row (bills, payments, receipts, till days, stock) is lost by an undo: export what the facility needs
first. Undoing does not reverse what staff did with the money; it only removes the schema.

```sql
begin;
alter table commercial.payments drop constraint payments_till_day_fk, drop constraint payments_void_till_day_fk;
drop function commercial.payment_record_online(uuid, bigint, text), commercial.receipt(uuid, uuid),
  commercial.payment_void(uuid, uuid, text, bigint, uuid, text, text),
  commercial.payment_confirm(uuid, uuid, bigint, text, text), commercial.payment_record(uuid, jsonb, bigint, text, text),
  commercial.day_list(date, boolean), commercial.day_close(uuid, bigint, text, bigint, text, text),
  commercial.day_open(uuid, bigint, text, text), commercial.day_current(uuid), commercial.day_json(uuid),
  commercial.counter_staff_only(uuid), commercial.open_day(uuid, text, uuid, uuid),
  commercial.open_day_locked(uuid, text, uuid, uuid),
  commercial.day_scope(uuid, uuid, uuid), commercial.till_day_closed_guard() cascade;
drop table commercial.till_days;
delete from migration.schema_migrations where version = '0165_till_days_and_end_of_day.sql';
commit;
```

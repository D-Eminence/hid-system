# 0163 undo: payment settings and the price list

Not in the migration ledger and never run by the release. Only with the owner's approval, on a database where
every later BILL-1 file has been undone first (this file's undo follows 0164's undo), in one transaction, after a backup.
Every billing row (bills, payments, receipts, till days, stock) is lost by an undo: export what the facility needs
first. Undoing does not reverse what staff did with the money; it only removes the schema.

```sql
begin;
-- Every function left in schema commercial (0163's helpers and F2), then:
drop table commercial.unpriced_code_hits, commercial.commands, commercial.number_counters, commercial.catalogue_events,
  commercial.catalogue_item_prices, commercial.catalogue_items, commercial.tills, commercial.facility_hmos,
  commercial.payment_settings;
delete from migration.schema_migrations where version = '0163_billing_settings_and_price_list.sql';
commit;
```

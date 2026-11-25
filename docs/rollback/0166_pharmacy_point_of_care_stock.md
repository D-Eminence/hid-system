# 0166 undo: pharmacy point-of-care stock

Not in the migration ledger and never run by the release. Only with the owner's approval, on a database where
every later BILL-1 file has been undone first (this file's undo follows 0167's undo), in one transaction, after a backup.
Every billing row (bills, payments, receipts, till days, stock) is lost by an undo: export what the facility needs
first. Undoing does not reverse what staff did with the money; it only removes the schema.

```sql
begin;
drop function pharmacy.stock_for_codes(jsonb), pharmacy.sale_hand_over(uuid, bigint, text, text),
  pharmacy.counter_sale_create(jsonb, text, text), pharmacy.stock_movement_list(uuid, integer),
  pharmacy.stock_adjust(jsonb, text, text), pharmacy.stock_receive(jsonb, text, text),
  pharmacy.stock_settings_put(uuid, text, integer, bigint, text, text), pharmacy.stock_list(text, text, integer),
  pharmacy.stock_ledger_agrees(uuid), pharmacy.stock_item_for_code(uuid, text, text),
  pharmacy.take_stock_expiry_first(uuid, uuid, integer, uuid, text, uuid, uuid, uuid), pharmacy.stock_line_json(uuid);
-- The tables refuse TRUNCATE and DELETE; DROP TABLE is not refused.
drop table pharmacy.stock_movements, pharmacy.stock_adjustments, pharmacy.stock_receipt_lines,
  pharmacy.stock_receipts, pharmacy.stock_batches, pharmacy.stock_items;
update commercial.catalogue_items set stock_kept = false where stock_kept;  -- only if 0163 stays
delete from migration.schema_migrations where version = '0166_pharmacy_point_of_care_stock.sql';
commit;
```

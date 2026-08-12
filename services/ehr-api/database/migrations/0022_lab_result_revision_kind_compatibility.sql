-- Preserve compatibility for governed callers that predate explicit revision classification.
create or replace function lab.default_result_revision_kind()
returns trigger
language plpgsql
as $$
begin
  if new.revision_kind is null then
    new.revision_kind := case when new.version = 1 then 'original' else 'correction' end;
  end if;
  if new.version > 1 and new.supersedes_version is null then
    new.supersedes_version := new.version - 1;
  end if;
  return new;
end
$$;

create trigger lab_result_revision_kind_default
before insert on lab.result_revisions
for each row execute function lab.default_result_revision_kind();

comment on function lab.default_result_revision_kind() is
  'Compatibility derivation only; explicit amendment classification remains available to governed API callers.';

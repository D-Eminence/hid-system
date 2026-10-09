-- The claim function returns a column named provider. Resolve unqualified names
-- in its stale-lease query as table columns, rather than PL/pgSQL output variables.
-- Migration 0014 is already applied and remains immutable.

alter function ocr.claim_worker_job(text, integer)
  set plpgsql.variable_conflict = 'use_column';

## Summary

- What changed?
- Why was it needed?

## Validation

- [ ] `npm run build`
- [ ] `npm run security:audit`
- [ ] Manual smoke test completed for the changed area

## Risk Check

- [ ] No secrets were committed
- [ ] No production URLs or auth settings were changed unintentionally
- [ ] PostgreSQL migration, constraint, and RLS impact was reviewed if SQL changed
- [ ] NestJS auth, authorization, consent, and audit impact was reviewed if backend code changed

## Deploy Notes

- [ ] Safe for preview deploy
- [ ] Safe for production after merge to `main`
- [ ] Requires env or secret changes

If env or secret changes are required, list them clearly.

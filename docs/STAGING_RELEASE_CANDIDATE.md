# Staging release candidate preparation

Preparation date: 2026-10-04. Scope: the current integration derived from
`c4b5445ed589217bb8b4529d69e268ca56842609`, including the additive migration,
medical/history access, supported configuration APIs and release-check fixes.
The exact candidate commit and artifact hashes are recorded by the workspace
build receipts. A local candidate commit is not release approval.

## Corrections made during preparation

- Normalize Windows paths in secret, container, frontend and convergence
  checks. Frontend source checks now examine the same files on Windows/Linux;
  existing storage allowances and immutable-migration exclusions remain exact.
- The retired Supabase API-host check now uses a domain boundary. It still
  rejects `.supabase.co` runtime dependencies; the read-only migration exporter
  may validate the separate `.supabase.com` PostgreSQL source.
- Build disposable rehearsal URLs with the URL API. Random local database
  passwords remain generated at execution and are not mistaken for source
  literals by the secret checker.
- The workspace frontend builder preserves native warnings and checks the
  actual process exit code on Windows PowerShell.

## Checks and evidence

Workspace evidence is retained outside Git in
`tmp/release-preparation-20261004/`. The seven frontends build with the confirmed
public staging configuration and same-origin API routing. Static verification
includes secret checks, the immutable 64-file migration ledger, frontend and
container contracts, offline/telemetry, cloud infrastructure synthesis and
policy checks. Release contracts are validated separately.

Publication security tests run inside disposable, network-disabled Linux
containers because their Unix ownership, modes and symlink checks are required
by Linux deployment. Windows does not support those assertions on this host.
No tests are skipped and no permission check is weakened for Windows.

The PostgreSQL rehearsal uses invented source inputs, a non-superuser migration
login and a separate local security administrator for grants. It proves a
clean installation, immutable 34-to-64 upgrade, dry-run rollback, repeat safety,
PIN preservation, Google mismatch rejection, private medical/history access,
configuration preservation and excluded operational outreach. Actual staging
copy rehearsal and actual source imports remain separate work.

## Publication remains blocked

RF-005 has no patched official CDK bundle at the current registry check.
RF-006 requires the security owner's recorded historical exposure disposition.
See `RELEASE_FINDINGS.md` and `STAGING_RELEASE_DISPOSITION_REQUEST.md`.
Local builds, reports or a clean commit do not close these findings. Keep the
publication guards and protected signing/admission requirements intact.

No runtime rollout, database mutation, DNS change, Git push or publication is
part of this local candidate preparation.

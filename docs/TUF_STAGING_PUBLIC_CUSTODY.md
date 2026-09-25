# Staging public custody intake

The [public intake template](../release/config/staging-public-custody.template.json)
records the public trust inputs that cannot be inferred from cloud discovery or a
successful build. It contains no invented keys or approvals. This is local input
validation; every result remains `NOT_READY`, `NOT_AUTHORIZED`, and
`deployment_authorized: false`, including a complete cryptographically valid input.

| Input | Source and next action |
| --- | --- |
| Three root and three targets key assignments, custodian aliases and hardware provider | The actual approved offline custody process. Supply public information only; retain private keys, PINs and recovery material with custodians. Three assignments per role do not introduce a second GitHub developer requirement. |
| Public custody and staging-root provenance evidence digests | Compute hashes of actual public ceremony/review documents. An entered hash only identifies evidence; a reviewer must obtain and authenticate the evidence independently. Do not substitute a test receipt or a success claim. |
| Versioned public root file and independently confirmed root digest | Receive from the established ceremony. The checker derives the file digest, version, ten canonical TUF key IDs and ten SPKI fingerprints. Compare against the independently supplied public pin. The root contains public keys and signatures only. |
| Four online snapshot/timestamp keys and SPKI bindings | Discover public data from the reviewed staging KMS resources after their separately authorized creation. Compare that data to the four online keys in the public root. This checker does not create keys or prove non-exportability. |
| AWS/Cloudflare resource IDs, roles, workflow pins, secret version references | Discover or derive during the existing account-bound plan and protected build. Record them in [staging-identifiers.template.json](../release/config/staging-identifiers.template.json) and use its existing validator. They are not public values the user must invent. |
| Source/artifact digests, metadata and release versions | Derive from the reviewed successor source, protected builds, actual release artifacts and signed metadata. Use the existing candidate admission and protected publisher; do not generate replacement trust keys. |

Copy the template to a review location and populate only the public fields that
are known. Leave missing fields `null`. Custodian aliases and hardware provider
labels are bounded plain text; evidence references are lowercase SHA-256 digests.
No URLs, private key fields, JWK private parameters, secret fields or approval
flags are accepted. The public documents themselves remain in the reviewed
ceremony evidence location; this intake does not upload or fetch them.

Check the incomplete template structure from the repository root:

```sh
node release/scripts/validate-staging-public-custody.mjs --check-template \
  /absolute/review/staging-public-custody.json
```

After obtaining the public root, validate the complete input against its exact
bytes. The root filename must match its signed version, such as `1.root.json`.
Both paths must be absolute, canonical, regular files, without symlinks:

```sh
node release/scripts/validate-staging-public-custody.mjs \
  /absolute/review/staging-public-custody.json \
  /absolute/review/1.root.json
```

The normal command exits nonzero for missing, malformed or mismatched input.
`--check-template` may exit zero with missing inputs; inspect `missing` and
`status`. Neither exit zero nor `valid: true` is a release approval. Diagnostics
omit supplied free-text values, and the tool writes no files. Its additive helper
reuses the existing repository metadata parser, P-256 role policy, root signature
threshold and publication freshness checks. Existing publication validation is
unchanged. No new dependency, signing implementation or trust store is introduced.

The bare TUF root has no environment field. Labeling an intake `staging` cannot
prove that its keys were never used for production. Staging provenance, hardware
custody, evidence authenticity, recovery separation, online KMS bindings and
staging/production key separation still require the established independent
review. The tool deliberately reports these as unverified even for synthetic
test metadata with valid signatures. A root newer than version one also requires
the retained sequential rotation chain during existing repository admission;
this intake verifies only its current self-signature.

Once the real custody inputs are available, continue the existing
[candidate admission](TUF_STAGING_CANDIDATE_ADMISSION.md), account-specific trust
resource plan, exact owner approval and protected publisher workflow. Immutable
retention decisions and final live deployment/restore/rollback/application checks
remain separate gates in [staging execution](TUF-STAGING-EXECUTION.md). Do not use
this intake as evidence that any of those actions occurred.

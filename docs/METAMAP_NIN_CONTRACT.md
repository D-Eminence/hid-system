# Superseded MetaMap NIN research

This file is retained only so historic staging evidence and release records keep
their links. It is not an approved HID integration contract and must not be used
to configure credentials, provider transport, callback handling, or deployment.

At the time of this superseded research, QoreID had no HID adapter. The current
repository now has a disabled-by-default server-only QoreID evidence adapter
for patient NIN and existing-organization CAC checks; it does not replace the
legacy governed NIN flow or create a CAC organization domain. See the current
[QoreID verification contract](QOREID_VERIFICATION_CONTRACT.md).

## Staging boundary

The historic staging plan deferred NIN with `NIN_PROVIDER_MODE=deferred`; no
MetaMap credential, provider request, secret entry, or NIN acceptance claim was
required for ordinary staging. That safety boundary remains in effect. QoreID
has its own disabled-by-default activation and privacy gates and is likewise
outside the ordinary staging acceptance scope.

Historical evidence is preserved under `docs/evidence/staging-acceptance/`; it
does not represent current provider configuration or authorization.

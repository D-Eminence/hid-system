# Staging image build preparation

The reusable [build workflow](../.github/workflows/tuf-build.yml) and
[adapter](../release/scripts/build-staging-images.mjs) prepare the existing
release build capability for staging. They have not been installed remotely or
run against AWS. No Docker build, image push, infrastructure creation or
deployment was performed during this preparation. Production remains locked.

The protected `staging-build` environment must approve the exact configuration
bytes and their SHA-256 hash. Repository and owner IDs, protected caller branch,
source commit, reusable workflow commit, caller workflow path, first run attempt,
GitHub-hosted runner, capability environment and staging AWS role are checked
before credentials are assumed. The reusable workflow and source commits can
differ: the caller pins installed workflow code by immutable SHA and builds its
separately approved source SHA. AWS STS, rather than the local claim decoder,
verifies the OIDC signature and immutable workflow role trust.

The existing owner-review policy is retained: owner `D-Eminence` is the single
required reviewer under the approved solo-owner exception, administrators cannot
bypass review, and only protected branches may use the environment. No static
AWS credentials are required.

## Prepared build modes

| Mode | Output | Build inputs |
| --- | --- | --- |
| `applications` | 12 OCI image digest records in 11 exact `staging/hid/*` repositories | Existing service and gateway Dockerfiles; `database-migration` uses the EHR Dockerfile's `migration` target and the EHR repository with a distinct immutable tag. |
| `signing-broker` | One image digest record in `hid-staging-tuf-signing-broker` | Existing signing-broker Dockerfile, with its two required digest-pinned Go and Lambda base images. |

All repositories must already exist in account `659225405023`, region
`eu-west-1`, with immutable tags and scan-on-push enabled. Application repository
encryption remains AES-256; broker repository encryption remains KMS. The
adapter checks every repository before starting Docker. The build role has
scoped push/read permissions and cannot create repositories, change repository
policies, deploy stacks or update ECS services. The extra application repository
permissions are synthesized only for staging; production policy is unchanged.

Docker builds only the separate, clean source checkout. Credentials are neither
build arguments nor build context files. Application and migration builds request
`linux/arm64`, matching every existing ECS task definition; the signing broker
requests `linux/amd64`, matching its existing Lambda/Dockerfile contract. The
required caller `build_kind` selects the native `ubuntu-24.04-arm` or `ubuntu-24.04`
GitHub-hosted runner, and must equal the owner-approved configuration. The runner
architecture and local image platform/source are checked before pushing. No
emulation or infrastructure architecture change is introduced.
[GitHub runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
The adapter obtains each output digest and size from ECR after the push; it never
substitutes a tag or placeholder for a release image URI. It uses unique
source/component/run tags and rejects workflow reruns. A later failure may leave
already-pushed immutable images, but cannot emit a successful complete receipt.

The artifact `tuf-staging-image-build-<source-sha>-<run-id>` contains the image
receipt, configuration hash, source and workflow commits, run identity and exact
digest URIs. It explicitly reports `release_admission: NOT_PERFORMED` and
`deployment_authorized: false`. SBOM, vulnerability scan and provenance evidence
must still satisfy the existing release contract; this receipt does not replace
them. Frontend archives and their confirmed public Turnstile configuration are
separate prerequisites. NIN remains deferred; this build workflow supplies no NIN
credentials and activates no NIN provider.

## Inputs required before execution

Start with [the configuration template](../release/config/staging-build.template.json).
The placeholders are intentional and are rejected by the validator. After
reviewed source/workflow installation and actual staging trust provisioning,
derive the real role ARN from stack outputs and populate these protected
`staging-build` variables:

- `TUF_BUILD_SOURCE_SHA`: the reviewed protected caller/source commit.
- `TUF_BUILD_WORKFLOW_SHA`: the installed reusable workflow commit pinned by that caller.
- `TUF_BUILD_ROLE_ARN`: the actual staging BuildRole ARN.
- `TUF_BUILD_CONFIG_JSON`: the exact reviewed JSON bytes, with the staging caller path and chosen build mode.
- `TUF_BUILD_CONFIG_SHA256`: SHA-256 of those exact JSON bytes, without adding a newline.

A caller must use
`D-Eminence/hid-system/.github/workflows/tuf-build.yml@<actual-reviewed-40-character-commit>`
and pass the approved `source_sha` and matching `build_kind`. Do not install a caller with a guessed SHA,
grant it publication/signing authority, or dispatch it before those inputs and
the source are reviewed. A successful build does not authorize deployment.
The Fargate quota request is separate; no deployment may proceed while it is
pending, even if image preparation later succeeds.

Run the local guard tests without cloud access:

```sh
node --test --test-isolation=none release/test/staging-image-build.test.mjs
```

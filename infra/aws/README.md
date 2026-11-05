# HID AWS CDK application

**Not the production source.** Production AWS (account `659225405023`,
`eu-west-1`) is the Terraform on this repository's `dev` branch:
`infra/terraform`, which converted this regional CDK design, operated as
`infra/DEVOPS_HANDOVER.md` there describes. Never run `cdk deploy` or
`cdk destroy` against account `659225405023`: it would create or change
resources beside the live ones, outside Terraform's state. Make an
infrastructure change in `dev`'s Terraform instead.

A backend release from `staging-novu-ci-20261005` changes only each
component's container image in its live task definition
(`docs/MAIN_TO_NOVU_PORT.md`, Infrastructure). This application is still built,
type-checked and tested by the local gates (`npm --prefix infra/aws test`).

**The workload issuer copy is retired as a production source.**
`runtime/workload-issuer/issuer.mjs` refuses more than six callers, and
`src/staging-workload-identity.ts` binds exactly six task roles. Both belong to
this CDK design only. They stay as the September 2026 staging acceptance
recorded them (`docs/evidence/staging-acceptance/implementation-2026-09-10.json`
pins their hashes), and `services/workload-token-agent`'s tests use this copy as
a reference issuer. The live issuer is
`infra/terraform/modules/application/runtime/workload-issuer/issuer.mjs` on
`dev`. It accepts one to eight callers, and the document scan bridge Lambda's
role becomes the seventh when document scanning is switched on (see
`docs/AWS_IAM_MATRIX.md`, Workload identity). Do not raise this copy's limit or
add the scanner here; change `dev`'s Terraform instead.

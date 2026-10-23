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

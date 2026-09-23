# Infrastructure reconciliation

Status: review only. No Terraform or CDK application stack has been deployed by this repository review.

Reviewed on 2026-09-23 against `origin/review/staging-prerequisites-20260915` (`7b47728`) and the Terraform on `dev` (`626696d`). The AWS region agreed in conversation is Ireland (`eu-west-1`). The application review branch is the most recently updated application branch visible in the remote; the development team must confirm which branch is authoritative before an infrastructure change is proposed.

## Finding

The application already has an AWS CDK implementation under `infra/aws` and Cloudflare Worker definitions under `infra/cloudflare`. Its CDK describes eleven independent ECS services, eleven ECR repositories, a separate migration task, PostgreSQL, private documents, events, queues, regional ingress, and per-service roles. The Terraform on `dev` was drafted before those branches were discovered and describes one ECS application and one ECR repository. It cannot deploy the current application as designed.

| Area | Application branch | Terraform `dev` | Consequence |
| --- | --- | --- | --- |
| Runtime | Eleven independently deployed ECS services plus migration task | One ECS service | Missing service boundaries, images, roles, and deployment sequence |
| Network ranges | Development `10.20.0.0/16`, staging `10.30.0.0/16`, production `10.40.0.0/16` | Development example `10.40.0.0/16` | Terraform development overlaps the CDK production plan |
| Ingress | Cloudflare Workers serve seven frontends and proxy API traffic through regional WAF and an API-only gateway | One Cloudflare CNAME to the ALB and one application target | Different public routing and frontend ownership |
| Integration | Application gateway and service-owned APIs | Optional API Gateway HTTP API | Different external API contract and extra infrastructure |
| Data and events | Service-specific database roles, document storage, EventBridge, SQS/DLQ, Textract | One general database and document bucket | Missing current runtime dependencies and isolation model |
| AI | No AI service in the present application deployment; the SoW AI workstream is later | Optional OpenSearch and Bedrock permissions | Do not activate before the retrieval and access-control design is agreed |
| Delivery | CDK/CloudFormation, application release checks, and Cloudflare Worker definitions | Terraform S3 state and a separate manual apply workflow | Two infrastructure owners could create duplicate or incompatible resources |

**Recommendation:** use the application's CDK and Cloudflare definitions as the provisional infrastructure baseline, subject to the developer confirming the authoritative branch. Keep Terraform apply disabled in practice; do not configure its AWS deployment secrets or run its manual apply. Retain the Terraform draft for comparison until the team decides whether any part should be adapted. A Terraform state backend is unnecessary for resources ultimately owned by CDK.

## Live-state checks still needed

- **AWS:** The operator reports that only AWS Budgets is provisioned. The application branch's `docs/STAGING_AWS_CHECKPOINT.md` (dated 2026-09-22) instead records an existing CDK bootstrap, certificates, some secret containers, and a pending Fargate quota request, while saying the staging regional stack, database, cluster, and application ECR repositories are absent. Verify the current account and region read-only before planning or creating resources. The checkpoint is repository evidence, not a live inventory.
- **Cloudflare:** The branch's 2026-09-22 inventory reports an active zone but no matching staging DNS records, Worker routes, or Custom Domains at that time. Recheck current DNS, Workers, custom domains, TLS, and Turnstile configuration. Do not publish or change DNS during inventory.
- **Supabase:** Identify the live project, schema, Auth configuration, storage, functions, backups, and application dependencies. Inspect metadata and counts without exporting patient records into this repository.
- **Vercel:** Identify deployed projects, domains, Git branches, server functions, and environment variable names. Confirm which workloads still receive live traffic. Do not copy secret values into this repository.

## Decisions for the developer and client

1. Confirm the authoritative application branch and whether the CDK deployment is the intended source of truth.
2. Confirm which AWS account resources exist now, including bootstrap, certificates, secrets, and the quota request.
3. Confirm the current Vercel, Supabase, and Cloudflare traffic path and the staging target.
4. Approve the `eu-west-1` patient-data residency and transfer decision before migration.
5. Choose a cost and capacity profile for development and staging after reviewing the application's actual service topology.

No AWS, Cloudflare, Supabase, or Vercel dashboard was available to this session during this review, so the live-state items remain unverified.

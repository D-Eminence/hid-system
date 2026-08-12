# HID Engineering Standards

## 1. General

Write production-quality code.

Do not optimize for generating the most code.

Optimize for:

* clarity
* safety
* testability
* maintainability
* explicit domain boundaries

## 2. TypeScript

Where TypeScript is used:

* enable strict typing
* avoid `any`
* validate external input
* separate transport DTOs from domain logic where useful
* keep compiler warnings clean
* use consistent imports
* remove unused code

## 3. Domain Ownership

Do not copy another service's business logic.

If shared technical code is required, extract a focused reusable package.

Domain behavior remains in its owning service.

## 4. UI

UI never accesses databases directly.

UI calls API clients.

Shared UI belongs in `packages/ui`.

## 5. API Clients

Prefer typed service clients.

Extracted services must not import another service's controller, provider, or
repository implementation. Propagated user authentication and internal
workload identity are separate evidence. A service must not gain foreign-schema
SQL access to avoid defining a narrow typed owner-service contract. Health
readiness probes only mandatory startup dependencies, not optional workers or
external providers.

Centralize:

* base URLs
* correlation IDs
* authentication integration
* error parsing
* retries where safe

Do not duplicate raw `fetch` wrappers throughout the repository.

The transport-only foundation in `packages/api-client/` is the approved
starting point for shared HTTP behavior. Applications retain ownership of
authentication/session state and domain response validation; do not move domain
logic into the package merely to eliminate a local import.

## 6. Validation

Validate all untrusted input.

Use allowlists where appropriate.

Reject unknown unsafe fields for clinical APIs.

## 7. Error Handling

Use consistent problem details.

Do not expose internals.

## 8. Correlation

Propagate correlation IDs through:

* Gateway
* service calls
* event messages
* audit
* logs

## 9. Logging

Use structured logging.

Never log:

* passwords
* secrets
* tokens
* raw NIN
* unnecessary PHI

## 10. Database

Respect service ownership.

No cross-service writes.

Use transactions for operations that must atomically persist clinical state and audit state.

## 11. Migrations

Migrations must be deterministic.

Never edit or delete already-applied migrations merely to make the folder cleaner.

Use follow-up migrations.

Test migration order.

## 12. Cleanup

Before deleting code:

* search references
* check runtime use
* check tests
* check build
* check dynamic imports
* check scripts

Delete only verified dead code.

## 13. Duplication

Actively identify:

* duplicate DTOs
* duplicate types
* duplicate models
* duplicate utilities
* duplicate API clients
* duplicate service implementations
* duplicate patient logic
* duplicate authorization logic

Consolidate safely.

## 14. Tests

Every new feature requires appropriate:

* unit tests
* integration tests
* API contract tests

Critical healthcare workflows require end-to-end tests.

## 15. CI/CD

Every deployable service should independently support:

* lint
* typecheck
* test
* build
* Docker build

## 16. Documentation

Architecture changes update documentation in the same work.

## 17. Deprecations

Do not suppress framework warnings without understanding them.

Migrate deprecated code safely.

Example:

NestJS wildcard route warnings must be corrected using syntax compatible with the installed NestJS and `path-to-regexp` versions.

## 18. Refactoring

Prefer small verifiable refactors.

Do not move hundreds of files simply to create a prettier folder structure.

Establish the target structure incrementally.

## 19. Security

Follow `SECURITY.md`.

## 20. Offline

Follow `OFFLINE.md` for local state and synchronization.

## 21. Completion

Before completion:

* lint
* typecheck
* tests
* build
* inspect diff
* run relevant service
* run health checks
* review security boundaries
* review duplicate/dead code

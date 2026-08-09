# Property Platform — CRM

The CRM service for the property listing platform: domain model, business logic, and the APIs consumed by the scraper and the web/Flutter clients.

**➜ New here? Start with the [Developer Guide](docs/developer-guide.md)** — run it locally in five commands, then jump to your team's integration section.

## Status

**Built.** All modules implemented and tested (85 tests): contacts, properties & ingest, pipelines & matching, appointments, agent registry, dispatch (atomic claim), notifications, comms (compliance gate), privacy/GDPR, portfolio, reporting — plus CI, synthetic seeds, and the frozen v1 API contract.

## Deliverables map

| # | Deliverable | Document | What's in it |
|---|---|---|---|
| 1 | Domain model & ERD | [domain-model.md](docs/domain-model.md) | module map, per-module ERDs, the four state machines, cross-cutting mechanics, flagged legal/architectural risks |
| 2 | Migration set | [migration-plan.md](docs/migration-plan.md) | SQL-first tooling, migration sequence, index plan justified against the dispatch & availability hot paths, partitioning, DB roles |
| 3 | Module implementation | [module-plan.md](docs/module-plan.md) | build order & dependencies, per-module scope and definition of done, shared kernel rules |
| 4 | API specification | **[api/openapi/](api/openapi/) (contract of record)** + [api-specification.md](docs/api-specification.md) | frozen OpenAPI 3.1 contracts — [`crm-v1.yaml`](api/openapi/crm-v1.yaml) (client team), [`ingest-v1.yaml`](api/openapi/ingest-v1.yaml) (scraper team); change policy & mock-server workflow in [api/README.md](api/README.md) |
| 5 | Event catalogue | [event-catalogue.md](docs/event-catalogue.md) | outbox/webhook envelope, PII-minimal payload policy, full event list with triggers and consumers, consumer obligations |
| 6 | Test suite | [test-strategy.md](docs/test-strategy.md) | pyramid & tooling, concrete designs for the seven mandated scenarios, CI gates |
| 7 | Operational runbook | [runbook.md](docs/runbook.md) | dispatch tuning parameters, job & retention schedules, 72-hour breach procedure, restore-with-erasure-consistency, alert thresholds |

**For the scraper team:** start with the [ingest contract](docs/api-specification.md#4--ingest-contract-scraper-team) and the ingest events in the [event catalogue](docs/event-catalogue.md).
**For the client team:** start with the [client contract](docs/api-specification.md#5--client-contract-web--flutter-team--surface-map), [delta sync](docs/api-specification.md#7--delta-sync--offline-writes), and the [event catalogue](docs/event-catalogue.md) consumer obligations.

## Locked decisions

| Decision | Choice |
|---|---|
| Stack | TypeScript / NestJS · PostgreSQL + PostGIS · Redis + BullMQ |
| Identity provider | Keycloak (CRM stores only the opaque subject ID) |
| Exclusivity & attribution | Exclusive window, sole credit (touches snapshotted for future split policies) |
| Operating model | Hybrid — staff-mediated until owner verification, then self-serve |

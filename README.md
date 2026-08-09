# Property Platform — CRM

The CRM service for the property listing platform: domain model, business logic, and the APIs consumed by the scraper and the web/Flutter clients.

**➜ New here? Start with the [Developer Guide](docs/developer-guide.md)** — run it locally in five commands, then jump to your team's integration section.

## State of the project

**Engineering complete — launch-blocked only on credentials and legal sign-offs.** All domain modules are implemented and tested (116 tests, CI-gated incl. lint, contract-conformance e2e, and live adapter tests): contacts & identity, properties & ingest, pipelines & matching, appointments, agent registry, dispatch with the atomic claim, notifications, comms with the pre-send compliance gate, privacy/GDPR, portfolio, reporting & staff ops, delta sync / bootstrap / iCal / media, worker runtime, and signed webhook fan-out. All seven mandated test scenarios pass.

**Real adapters are built and config-gated** — each binds the moment its env vars exist, with safe defaults otherwise: Keycloak admin (realm config in `keycloak/`, imported by compose), envelope-KMS crypto-shredding with real field-level encryption (agent payout IBAN, national id), S3-compatible storage (MinIO in dev/CI), SMTP + Twilio + FCM messaging with a normalized delivery/bounce webhook, and a Nominatim geocoder. Deployment ships as a multi-stage `Dockerfile` + `docker-compose.prod.yml` + [`.env.production.example`](.env.production.example).

## TODO — launch

Everything buildable is built. What remains is **provisioning, credentials,
and counsel sign-offs**, tracked with owners and self-verification steps in
**[docs/launch-checklist.md](docs/launch-checklist.md)**:

- [ ] §1 Credentials & accounts: managed Postgres/Redis, Keycloak deployment (realm JSON ready), KMS-held keys, S3 bucket, SMTP/Twilio/Firebase accounts, self-hosted Nominatim, domain+TLS+registry+host, monitoring & backups
- [ ] §2 Legal: LIA, Art 26 arrangement, retention sign-off, per-country ePrivacy rows (block-all is the safe launch state), breach-notice copy, supervisory-authority confirmation
- [ ] §3 Teammates: scraper against production; mobile app built from the design package + store submissions

Deferred by design (post-launch): media thumbnailing/EXIF/virus-scan post-processing adapters behind the uploaded state.

**Product depth — ALL DONE (2026-08-09):**
- [x] Appointment reminders (T-24h / T-2h) and automatic re-dispatch on agent cancellation/no-show
- [x] Open-house capacity & waitlist service logic with auto-promotion
- [x] Agent scorecard materialised view feeding dispatch ranking
- [x] Template merge-field rendering + locale fallback in the sequencer
- [x] DSR access/portability export assembly with subject-only download
- [x] Calendar sync port (claim push, withdrawal removal, busy-import → absences; OAuth adapter at deploy)
- [x] Account recovery (dual distinct approval + payout cooldown), bulk-export watermarking, session revocation via IdP port
- [x] Breach-incident workflow: state machine, timeline, T-12h deadline warning, subject notices (templates pending counsel)
- [x] ESLint (bare-`new Date()` ban enforcing the Clock doctrine, module boundaries) + contract-conformance e2e

**Legal / organisational (flagged in [docs/domain-model.md §15](docs/domain-model.md) — not engineering):**
- [ ] LIA for scraped data (counsel) — referenced by the Art 30 register
- [ ] Art 26 / controller-to-controller arrangement for agents, attached to the versioned T&Cs
- [ ] DPO sign-off on retention clocks (defaults live in `privacy.retention_policy`)
- [ ] Per-country ePrivacy decisions → `core.channel_policy` rows (default is BLOCK)
- [ ] Confirm lead supervisory authority (assumed BE) in the breach procedure

## Deliverables map

| # | Deliverable | Document | What's in it |
|---|---|---|---|
| 1 | Domain model & ERD | [domain-model.md](docs/domain-model.md) | module map, per-module ERDs, the four state machines, cross-cutting mechanics, flagged legal/architectural risks |
| 2 | Migration set | [migration-plan.md](docs/migration-plan.md) + `db/migrations/` | SQL-first tooling, index plan justified against the dispatch & availability hot paths, partitioning, DB roles |
| 3 | Module implementation | [module-plan.md](docs/module-plan.md) + `src/modules/` | build order & dependencies, per-module scope and definition of done, shared kernel rules |
| 4 | API specification | **[api/openapi/](api/openapi/) (contract of record)** + [api-specification.md](docs/api-specification.md) | frozen OpenAPI 3.1 contracts — [`crm-v1.yaml`](api/openapi/crm-v1.yaml) (client team), [`ingest-v1.yaml`](api/openapi/ingest-v1.yaml) (scraper team); change policy & mock-server workflow in [api/README.md](api/README.md) |
| 5 | Event catalogue | [event-catalogue.md](docs/event-catalogue.md) | outbox/webhook envelope, PII-minimal payload policy, full event list, consumer obligations |
| 6 | Test suite | [test-strategy.md](docs/test-strategy.md) + `test/` | pyramid & tooling, the seven mandated scenarios, CI gates |
| 7 | Operational runbook | [runbook.md](docs/runbook.md) | dispatch tuning parameters, job & retention schedules, 72-hour breach procedure, restore-with-erasure-consistency, alert thresholds |
| — | Developer guide | [developer-guide.md](docs/developer-guide.md) | local setup, integration guides per team, extension conventions, deploy-time configuration |

**For the scraper team:** start with the [ingest contract](docs/api-specification.md#4--ingest-contract-scraper-team) and the ingest events in the [event catalogue](docs/event-catalogue.md).
**For the client team:** start with the [client contract](docs/api-specification.md#5--client-contract-web--flutter-team--surface-map), [delta sync](docs/api-specification.md#7--delta-sync--offline-writes), and the [event catalogue](docs/event-catalogue.md) consumer obligations.

## Locked decisions

| Decision | Choice |
|---|---|
| Stack | TypeScript / NestJS · PostgreSQL + PostGIS · Redis + BullMQ |
| Identity provider | Keycloak (CRM stores only the opaque subject ID) |
| Exclusivity & attribution | Exclusive window, sole credit (touches snapshotted for future split policies) |
| Operating model | Hybrid — staff-mediated until owner verification, then self-serve |
| API | Contract-first; `api/openapi/*.yaml` is frozen at v1.2 — implementation conforms to it |
| Valuation | Adaptive-radius comps: same kind, ±30% area, 2→5 km, 12-month recency, min 5 comps, median €/m² |

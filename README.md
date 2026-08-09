# Property Platform — CRM

The CRM service for the property listing platform: domain model, business logic, and the APIs consumed by the scraper and the web/Flutter clients.

**➜ New here? Start with the [Developer Guide](docs/developer-guide.md)** — run it locally in five commands, then jump to your team's integration section.

## State of the project

**Feature-complete against the spec's CRM scope; not yet deployed.** All domain modules are implemented and tested (93 tests, CI-gated): contacts & identity, properties & ingest (provenance, suppression, quarantine, geocoding port), pipelines & matching, appointments (tz-correct slots, holds, exclusion-constraint booking), agent registry, dispatch with the atomic claim, notifications (ACK-driven fallback chains), comms (pre-send compliance gate, Art 14), privacy/GDPR (DSR queue, erasure orchestration, purpose-bound grants, retention), portfolio (client-team scope), reporting & staff ops actions, delta sync / bootstrap / iCal / media endpoints, BullMQ worker runtime, and signed webhook fan-out.

All seven mandated test scenarios pass: concurrent claim (exactly one winner, soak-tested), idempotent re-ingest, erasure propagation incl. suppression, SLA timer expiry, availability conflicts incl. DST edges, notification fallback escalation, and purpose-bound access expiry.

External integrations are **ports with safe defaults**: providers and the geocoder no-op until configured; the IdP and KMS adapters throw loudly so no legal obligation is ever silently skipped.

## TODO — before production

**Adapters & infrastructure (bounded tasks; every seam is built and tested):**
- [ ] Push/SMS/email provider adapters (`ProviderRegistry`, `MessageProviderRegistry`) — FCM/APNs + an SMS/email vendor, plus their inbound delivery/bounce webhooks
- [ ] Keycloak: production realm (roles `agent`/`staff`/`ingest`, ACR levels for step-up) + admin adapter (`IdpAdminPort`) for erasure propagation
- [ ] KMS adapter (`KmsPort`) + write paths for field-level encryption of national ID / IBAN (`contact_sensitive` columns exist; envelope encryption not wired)
- [ ] EU geocoder adapter (`GeocoderPort`) — add vendor to the processor register
- [ ] Object storage adapter (`StoragePort`) + thumbnailing/EXIF-strip/virus-scan post-processing
- [ ] Deployment: environments, secrets (incl. KMS-held suppression HMAC key), backups per runbook §4, monitoring/alerting per runbook §5

**Product depth (spec items built thin or deferred):**
- [ ] Appointment reminders (T-24h / T-2h) and automatic re-dispatch on agent cancellation/no-show
- [ ] Open-house capacity & waitlist service logic (tables exist)
- [ ] Agent scorecard materialised view feeding dispatch ranking (rating currently neutral)
- [ ] Template merge-field rendering + locale fallback in the sequencer
- [ ] DSR access/portability export assembly (erasure/restriction are complete)
- [ ] Two-way Google/Outlook calendar sync (outbound iCal feed is live)
- [ ] Account recovery queue (dual approval), bulk-export controls/watermarking, per-device session revocation
- [ ] Breach-incident workflow tooling beyond the log table; localized breach-notice templates
- [ ] ESLint + module-boundary lint rules; e2e contract-conformance tests against the OpenAPI docs

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
| API | Contract-first; `api/openapi/*.yaml` is frozen at v1.1 — implementation conforms to it |
| Valuation | Adaptive-radius comps: same kind, ±30% area, 2→5 km, 12-month recency, min 5 comps, median €/m² |

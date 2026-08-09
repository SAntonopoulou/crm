# Developer Guide

The one document to start from, whichever of the three components you work on.
It shows you how to run the CRM, how to integrate against it, and how to extend
it — and links to the deep-dive docs instead of duplicating them.

| You are… | Read | Then |
|---|---|---|
| The **scraper** developer | [§2 Running the CRM](#2--running-the-crm-locally), [§4 Scraper integration](#4--scraper-integration) | [`api/openapi/ingest-v1.yaml`](../api/openapi/ingest-v1.yaml) |
| The **web/Flutter** developer | [§2](#2--running-the-crm-locally), [§5 Client integration](#5--client-integration) | [`api/openapi/crm-v1.yaml`](../api/openapi/crm-v1.yaml), [event catalogue](event-catalogue.md) |
| Working **on the CRM itself** | [§3 Architecture](#3--architecture-in-five-minutes), [§6 Extending the CRM](#6--extending-the-crm) | [domain model](domain-model.md), [test strategy](test-strategy.md) |
| **Operating** it | [runbook.md](runbook.md) | — |

---

## 1 · What this system is

The CRM owns the domain model, all business logic, and the APIs the scraper and
client apps consume. The product loop it implements: scraped/submitted
properties enter the supply pipeline → owners are reached and verified →
listings go live → buyers match, book viewings → registered agents race to
**claim** the showing (an atomic, exactly-one-winner operation) → post-visit
outcomes feed back into the demand pipeline. GDPR machinery (provenance,
consent, suppression, erasure, purpose-bound access) is structural, not
bolted on.

Decisions that are **locked** (don't relitigate in PRs): NestJS + PostgreSQL/
PostGIS + Redis/BullMQ; Keycloak for identity (the CRM stores only the opaque
subject id); exclusive-window sole-credit attribution (30 days from showing);
hybrid ops model; contract-first API. History: [README](../README.md),
[client reconciliation](client-reconciliation.md).

## 2 · Running the CRM locally

```bash
git clone git@github.com:SAntonopoulou/crm.git && cd crm
cp .env.example .env            # defaults match docker-compose
docker compose up -d postgres redis --wait
npm ci
npm run migrate up              # all migrations, groups 000–110
npm run codegen                 # regenerate Kysely types (checked in)
npm run seed                    # synthetic Brussels data: agents, listings, buyers
npm run build && npm start      # http://localhost:3000/health
npm test                        # full suite (~85 tests, wipes volatile tables first!)
```

Gotchas:
- Compose maps Postgres to host port **54321** (5432 is often taken) and
  Keycloak to **8082**. `.env` already points there.
- `npm test` truncates all volatile domain tables first (`test/global-setup.ts`)
  — never point `DATABASE_URL` at anything you care about.
- Keycloak is optional for local API poking: `docker compose --profile auth
  up -d` starts it (admin/admin), but tests never need it — they sign JWTs
  with a local key and inject the JWKS.
- No auth token? Every `/v1/*` route 401s. Fastest way to a token in dev:
  create a realm `crm` in Keycloak with a public client, or lift the pattern
  from `test/contacts.spec.ts` (local JWKS + signed JWT) into a scratch script.

## 3 · Architecture in five minutes

```
src/shared/          the kernel — every module obeys it
  database/          Kysely + Db.tx(): domain write + outbox event = one transaction
  outbox/            relay → webhooks; at-least-once; consumers dedupe by event id
  audit/             append-only PII access log (reads AND writes); @PiiAccess
  provenance/        single write path for scraped/owner/staff values
  jobs/              BullMQ + injected Clock; NO `new Date()` in domain code
  auth/              Keycloak JWT guard, @Roles, @StepUp, version gate
  state-machine.ts   typed transition tables; illegal moves throw
src/modules/         contacts · properties · pipelines · appointments ·
                     agents · dispatch · notifications · comms · privacy ·
                     portfolio · reporting
db/migrations/       raw SQL, node-pg-migrate, numbered by module group
api/openapi/         THE CONTRACT (frozen; see change policy)
```

Modules communicate **forward** via the job registry and outbox events, never
by importing against the dependency arrow (e.g. booking an appointment
schedules `dispatch.start`; dispatch never imports appointments' internals
beyond its public service). Full ERDs and state machines: [domain model](domain-model.md).

Non-negotiables the kernel enforces (and reviews reject):
1. Every domain write goes through `db.tx()`; events via `ctx.emit()` in the
   same transaction. No bare inserts to `outbox_event`, ever.
2. Provenance-bearing fields go through `ProvenanceResolver` — owner-confirmed
   beats scraped, losers park as candidates.
3. PII reads by non-subjects get audited (`AuditLog` / `@PiiAccess`); reveals
   need a reason. The audit table physically rejects UPDATE/DELETE.
4. Anything with >2 states is a `StateMachine` with a transition table.
5. Time comes from the injected `Clock`; timers are `JobScheduler` jobs with
   dedupe ids. That's what makes every SLA/TTL testable.
6. `suppression_entry` is checked before any ingest entity write.

## 4 · Scraper integration

Contract: [`ingest-v1.yaml`](../api/openapi/ingest-v1.yaml) (mock it:
`npx @stoplight/prism-cli mock api/openapi/ingest-v1.yaml -p 4011`).

- **Auth**: OAuth2 client-credentials against Keycloak; your service account
  carries the `ingest` realm role and reaches only `/v1/ingest/*`.
- **Batching**: ≤500 records per batch, batch `Idempotency-Key` header plus a
  per-record `idempotency_key` unique within your source. Replaying either is
  always safe: recorded outcomes come back, zero side effects. Same batch key
  with a *different* payload → `409 idempotency_key_reuse`.
- **Provenance is required** per record (`collected_at`, `method`,
  `confidence`; optionally per-field). It decides whether your value applies
  or parks as a review candidate — owner-confirmed data always wins over a
  re-scrape.
- **Outcomes** (`GET /v1/ingest/batches/{id}`): `created / updated / unchanged /
  quarantined / failed / suppressed`. Treat `suppressed` as "stop re-sending
  this record" and nothing more — you cannot learn who is on the suppression
  list, by design, and bulk stats fold it into `ok`.
- **Quarantine** happens for incomplete addresses (need country + street +
  number + postcode) and `confidence < 0.3`. Staff resolve; you can
  `POST …/replay` after fixing upstream (410 once payloads hit the 30-day
  retention purge).
- **EPC**: send the raw label; the CRM normalises to `A++…G` and parks
  unparseable raws. Don't pre-normalise.
- Useful events on the webhook stream: `ingest.batch_completed`,
  `ingest.record_processed`, `ingest.quarantine_resolved`,
  `property.merged` (remap your dedupe keys).

## 5 · Client integration

Contract: [`crm-v1.yaml`](../api/openapi/crm-v1.yaml) (mock:
`npx @stoplight/prism-cli mock api/openapi/crm-v1.yaml -p 4010`; codegen
commands in [`api/README.md`](../api/README.md)). Semantics cheat-sheet lives
there too. The parts people trip on:

- **Identity**: Authorization Code + PKCE against Keycloak. First
  authenticated call auto-provisions the contact — there is no separate
  "create user" endpoint. `GET /v1/me` is your session bootstrap for profile
  data; `GET /v1/bootstrap` for flags/config/version verdict.
- **Errors**: branch on `problem.code`, never on HTTP status alone
  (`already_claimed`, `slot_conflict`, `min_notice`, `hold_expired`,
  `state_conflict`, `claims_online_only`, `step_up_required`, …).
- **Booking flow**: `GET /listings/{id}/viewing-slots` → pick →
  `POST /appointments/holds` (TTL ~10 min, `expires_at` is server truth) →
  `POST /appointments` with the hold id. A listed slot can still 409 —
  slots are availability, not reservations; keep a retry-with-next-slot path.
- **The claim** (`POST /agent/offers/{id}/claim`): online-only — never queue
  it offline (server rejects `X-Offline-Replay` with `claims_online_only`).
  Winner retries are idempotent. Losers get `409 already_claimed` with no
  winner details. TTL countdowns in the offer payload are cosmetic;
  `ttl_expires_at` is authoritative.
- **ACK obligation**: when the app renders a `dispatch_offer` push, call
  `POST /notifications/{id}/ack` immediately. No ACK within 90 s and the
  server assumes the push died and escalates to SMS, then email — the agent
  gets duplicate noise and your app looks broken.
- **Masking is the normal case**: party contact details are masked except
  inside the post-claim reveal window (`contact_reveal_window_ends_at` on the
  claim result). Design the UI for the masked shape.
- **Delta sync**: `GET /v1/sync?since=<seq>` returns changes + tombstones by
  the global sequence; follow `next_since` while `has_more`. On the
  `privacy.erased` event you are contractually required to purge local caches
  for that aggregate within 72 h.
- **Offline writes**: replay with `Idempotency-Key` + `X-Offline-Replay: 1`.
  State-machine resources are server-authoritative — reconcile on
  `409 state_conflict` (current resource rides in `problem.current`).
  Free text is last-write-wins. Claims: never.
- **Money**: decimal strings on the wire. Display in floats if you like, but
  echo the original strings back on writes (portfolio figures) — float
  round-trips get rejected by validation.
- **Portfolio**: `GET/POST /me/portfolio`, `PATCH/DELETE
  /me/portfolio/{propertyId}`. `current_value_estimate` is server-computed and
  **absent** (not null-as-zero) until ≥5 comps exist; methodology is in the
  [client reconciliation](client-reconciliation.md).

## 6 · Extending the CRM

Adding a module (the pattern is identical in all eleven existing ones):

1. **Contract first.** If the feature has an API surface, amend
   `api/openapi/crm-v1.yaml` in the same PR under the
   [change policy](../api/README.md#change-policy-frozen-contract) —
   additive with the `contract-additive` label; breaking = `/v2` + all-team
   sign-off. CI runs `oasdiff` and will fail you otherwise.
2. **Migration.** Next free group number, raw SQL in `db/migrations/`
   (`NNNN_name.sql`, `-- Up Migration` / `-- Down Migration`). Add `sync_seq
   DEFAULT nextval('core.sync_seq')` + the `stamp_sync` BEFORE UPDATE trigger
   to anything the clients sync. Run `npm run migrate up && npm run codegen`
   and commit the regenerated `db.d.ts`.
3. **Service.** Constructor takes `Db`, `Clock`, optional `JobScheduler` (+
   ports for external systems — see `IdpAdminPort`/`KmsPort` in privacy for
   the pattern; tests inject fakes). Writes in `db.tx()`, events via
   `ctx.emit()` (register new event types in the
   [catalogue](event-catalogue.md)), timers via `jobs.schedule(name, payload,
   runAt, { dedupeId })`.
4. **Module class** registers job handlers in `onModuleInit` via
   `JobRegistry`; wire into `AppModule`.
5. **Controller** with class-validator DTOs; `@Roles()`/`@StepUp()` where the
   contract demands; resolve the caller with
   `contacts.resolveOrProvision(req.auth!.sub)`.
6. **Tests before moving on** (`test/<module>.spec.ts`): construct services
   manually with `TestClock` + `InlineJobScheduler` + `JobRegistry`; drive
   timers with `clock.advance()` + `scheduler.drainDue()`; hit the real
   Postgres. Failure paths and concurrency are the point — see
   `test/dispatch.spec.ts` for the barrier-claim pattern and
   [test-strategy.md](test-strategy.md) for the doctrine. If another module's
   booking path schedules your job in its tests, register a no-op handler
   there.

Review checklist (what I will look for in your PR): kernel rules §3 all
honoured; migration has a working Down; events in the catalogue; no `.only`/
`.skip`; contract diff clean or labelled; PII never in event payloads or
report outputs.

## 7 · Jobs, ops, and the bits that run on a schedule

Job handlers registered today (wire as BullMQ repeatables at deploy; the
schedule table with owners lives in [runbook §2](runbook.md#2--scheduled-jobs)):
`pipeline.sla_breach`, `matching.evaluate_listing`, `appointment.hold_expire`,
`dispatch.start`, `dispatch.offer_ttl`, `notification.deliver/escalate/
dispatch_offer`, `comms.sequence_step`, `agents.doc_lapse_check`,
`privacy.dsr_escalation`, `privacy.grant_revoke`, `privacy.retention_sweep`.

Deploy-time configuration you must provide in production: Keycloak issuer +
admin adapter (`IdpAdminPort`), KMS adapter (`KmsPort`), suppression HMAC key
(KMS-held), push/SMS/email provider adapters (`ProviderRegistry`,
`MessageProviderRegistry`), dispatch tuning flags. The defaults either no-op
safely (providers) or **throw loudly** (IdP/KMS) so nothing silently skips a
legal obligation.

## 8 · Where everything else lives

| Topic | Document |
|---|---|
| Entities, ERDs, state machines | [domain-model.md](domain-model.md) |
| Index/migration rationale | [migration-plan.md](migration-plan.md) |
| Module build order & DoD | [module-plan.md](module-plan.md) |
| API semantics & rationale | [api-specification.md](api-specification.md) |
| Events & webhook contract | [event-catalogue.md](event-catalogue.md) |
| Test doctrine | [test-strategy.md](test-strategy.md) |
| Ops, tuning, breach procedure | [runbook.md](runbook.md) |
| Contract change policy & mocks | [api/README.md](../api/README.md) |
| Client-team decisions log | [client-reconciliation.md](client-reconciliation.md) |

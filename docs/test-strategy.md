# Deliverable 6 — Test Strategy

**Status: awaiting review.** The spec mandates seven scenarios by name; each gets a concrete design below. Beyond those, the strategy is: **the failure paths are the product** — concurrency, expiry, and privacy guarantees get first-class tests, not just the happy path.

---

## 1 · Pyramid & tooling

| Layer | Tooling | Scope | Speed budget |
|---|---|---|---|
| Unit | Vitest | state-machine guards, ranking scorers, precedence resolver logic, policy calculators (notice periods, cancellation penalties, quiet hours) | ms, no I/O |
| Integration | Vitest + **Testcontainers** (Postgres/PostGIS + Redis) | everything the database enforces: exclusion constraints, atomic claim, suppression, sync_seq, audit role grants, migrations | the core layer — the guarantees live in Postgres, so mocking Postgres would test nothing |
| Contract / e2e | supertest against a booted app + generated OpenAPI validation | API semantics, auth/step-up, version gate, webhook signatures | smoke-level, not exhaustive |

Global rules: injected `Clock` (no real waiting — timers fire by advancing the clock and draining the BullMQ queue in-process); fixture factories generate **synthetic personal data only** (faker with a fixed seed, `.example` domains, +32 470 reserved test ranges); every module PR runs its migrations from zero in CI.

## 2 · The seven mandated scenarios

### 2.1 Concurrent claim resolution

*Setup:* one dispatch in `offering` with 8 offers.
*Act:* 8 real parallel DB connections issue the claim UPDATE simultaneously (barrier-synchronised), plus a 9th duplicate request from the eventual winner.
*Assert:* exactly one `200`; seven `409 already_claimed`; the duplicate gets `200` (idempotent replay, no second agreement); exactly one `assignment_agreement`, one `access_grant`, one `dispatch.claimed` outbox event; sibling offers all `withdrawn`.
*Repeat* 100× in CI (race bugs are probabilistic); also run one pass at `SERIALIZABLE` isolation to prove no dependency on isolation level.

### 2.2 Idempotent re-ingest

*Setup:* batch of 50 mixed records (creates, updates, one malformed, one quarantine-worthy).
*Act:* POST the identical batch three times; then once more with the same `Idempotency-Key` but one mutated record.
*Assert:* runs 2–3 return recorded outcomes byte-identical to run 1; row counts unchanged; no duplicate outbox events; the mutated-payload replay returns `409 idempotency_key_reuse`. Property-based variant: shuffled record order within a batch never changes per-record outcomes.

### 2.3 Erasure propagation including suppression

*Setup:* contact with channels, a property link, messages, an active match profile; Keycloak admin API stubbed.
*Act:* complete an erasure DSR; then re-ingest a scrape batch containing the erased person's email, phone, and address.
*Assert:* contact row pseudonymised; DEK destroyed (encrypted fields unreadable — assert decryption fails); suppression HMACs present; Keycloak deletion called; `erasure_propagation` rows all `confirmed`; re-ingest records come back `suppressed` with **zero** entity writes; `privacy.erased` event emitted; timeline/report queries no longer return the subject.

### 2.4 SLA timer expiry

*Setup:* inbound inquiry creates a pipeline item with `first_response_due_at` = now + 15 min; a stage SLA of 2 days on the same item.
*Act:* advance clock 14 min → staff reply (case A); or advance 16 min with no reply (case B).
*Assert:* A: timer cleared, no escalation. B: escalation task created, `pipeline.sla_breached` emitted exactly once (re-running the sweep is idempotent), assignee notified. Same harness reused for offer TTL expiry and slot-hold release.

### 2.5 Availability conflict resolution

*Setup:* one property (Europe/Brussels), one agent with travel buffer 30 min, tenanted access rule `min_notice_hours: 48`.
*Act & assert:*
- overlapping booking on same property/agent → rejected by exclusion constraint, surfaced as `409 slot_conflict` (assert it is the DB, not app logic, by attempting the raw insert too);
- booking at notice-boundary minus 1 minute → rejected; plus 1 minute → accepted, **computed in property-local time**;
- DST edges: bookings across the spring-forward and fall-back transitions resolve to the correct UTC instants (fixtures pinned to the last Sunday of March/October);
- hold TTL expiry releases the range and a waiting booking then succeeds;
- adjacent appointment inside the travel buffer → rejected for that agent, accepted for another.

### 2.6 Notification fallback escalation

*Setup:* dispatch offer to an agent with an active device; `critical_ack` chain push(90 s) → SMS(120 s) → email.
*Act & assert:*
- no ACK: advancing the clock walks the chain in order, one `delivery_attempt` per step, `notification.chain_exhausted` after email step lapses;
- ACK after SMS step: chain halts, no email attempt, `notification.acknowledged` emitted, dispatch informed;
- provider returns `Unregistered`: token pruned, push step skipped instantly (no 90 s wait), SMS proceeds;
- quiet hours: `critical_ack` ignores them; a `normal` category message queued at 23:00 recipient-local defers to the morning window.

### 2.7 Purpose-bound access expiry

*Setup:* agent claims a showing (grant window = appointment ± buffer).
*Act & assert:*
- inside window: contact endpoint returns full details; a `read` row lands in `pii_access_log`;
- clock past window end + revocation sweep: same call returns masked values; a reveal-on-click without reason → `422`; with reason → unmasked once + `reveal` audit row;
- audit immutability: as `crm_app`, `UPDATE`/`DELETE` on `pii_access_log` raises `insufficient_privilege` (asserted in the same suite);
- a second appointment for the same contact creates a **new** grant — expiry of one never bleeds into the other.

## 3 · Beyond the mandated seven

- **State-machine sweep**: for every machine (listing, dispatch, offer, appointment, agent, account, DSR), a generated test asserts each illegal transition is rejected with a typed error — the transition table in code is the source, so a new state without tests fails the build.
- **Provenance resolver**: property-based tests — for any sequence of writes, the surviving value is always from the highest-precedence method, and losers are always recoverable as candidates.
- **Compliance gate**: architecture test that no provider adapter is importable outside the gate module; behavioural tests for blocked-by-default countries, Art 14 attach-on-first-outreach, stop-on-reply.
- **Outbox relay**: kill the relay mid-batch, restart, assert no loss and no duplicate `seq` on the consumer side.
- **Restriction freeze**: with `processing_restricted` set, matcher/sequencer/dispatcher/exporter all skip the subject (one parameterised test per engine).
- **Load smoke (hot path)**: candidate ranking against 1 000 synthetic agents / 10 000 appointments — p95 < 150 ms in CI hardware terms; regression-tracked, not just asserted once.

## 4 · CI gates

1. Migrations from zero + codegen drift check (fail = schema and types disagree).
2. Unit + integration suites (Testcontainers) — the seven mandated scenarios are tagged `@mandated` and cannot be skipped or quarantined.
3. OpenAPI diff vs. `main` — breaking change without version bump fails.
4. Coverage floor on `src/modules/**` domain logic: 90 % branches; no floor on controllers/DTOs (they're covered by contract tests).
5. Concurrency suite (2.1) runs its 100 iterations nightly as well as per-PR (10 iterations per-PR for speed).

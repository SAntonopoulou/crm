# Deliverable 2 — Migration & Index Plan

**Status: awaiting review.** Companion to the approved [domain model](domain-model.md); the actual SQL migration files land in `db/migrations/` as this plan is executed.

---

## 1 · Tooling decision

**Migrations are raw SQL, run by `node-pg-migrate`** (SQL-file mode, one directory, forward-only in deployed environments, `down` scripts maintained only for local development). Rationale: the schema depends on Postgres features that ORM-generated DDL handles poorly or not at all — GiST **exclusion constraints**, **range types**, **PostGIS** columns, **declarative partitioning**, **triggers** (the `sync_seq` stamp), and **role-level grants** (the insert-only audit role). An ORM diffing tool would fight every one of these.

Runtime data access is **Kysely** with types generated from the live schema (`kysely-codegen` in CI), so the type system tracks the migrations rather than the other way round. This is the one stack refinement not yet locked with the team — flagged here for confirmation, everything else in this plan is independent of it.

## 2 · Extensions & database roles

```sql
CREATE EXTENSION IF NOT EXISTS postgis;      -- geo points, coverage polygons
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- scalar + range in one exclusion constraint
CREATE EXTENSION IF NOT EXISTS pg_trgm;      -- fuzzy contact/property dedupe
CREATE EXTENSION IF NOT EXISTS pgcrypto;     -- gen_random_uuid
```

| Role | Grants | Used by |
|---|---|---|
| `crm_migrate` | DDL owner | migration runner only |
| `crm_app` | CRUD on `core.*`; **INSERT-only** on `audit.pii_access_log`; no DDL | NestJS service |
| `crm_readonly` | SELECT on reporting views, pseudonymised analytics schema | reporting, BI |

The application role being physically unable to UPDATE/DELETE audit rows is the enforcement mechanism for "append-only" — not convention.

## 3 · Migration sequence

Numbered groups mirror the module build order, so each module's migrations ship with the module (spec working rule: tests before moving on). Within each group: tables → constraints → indexes → triggers → seeds.

| Group | Contents |
|---|---|
| `000` foundation | extensions, roles, schemas (`core`, `audit`, `privacy`), `sync_seq` global sequence + stamp trigger function, `outbox_event`, `idempotency_key`, `tombstone` |
| `010` contacts | `contact`, `contact_role`, `contact_channel`, `contact_sensitive`, `organisation`, `org_membership`, `contact_relationship`, `contact_merge` |
| `020` properties | `property`, `listing`, `listing_change`, `property_party`, `property_document`, `media_asset`, `property_merge` |
| `030` ingest | `source`, `ingest_run`, `ingest_record`, `quarantine_item`, `field_provenance`, `field_precedence_rule`, `suppression_entry` |
| `040` pipelines | `pipeline`, `pipeline_stage`, `pipeline_item`, `stage_transition`, `task`, `activity`, matching (`requirement_profile`, `match`) |
| `050` appointments | `property_access_rule`, `slot_hold`, `appointment`, `attendance_proof`, `appointment_feedback`, `viewing_outcome`, `waitlist_entry`, `calendar_link` + exclusion constraints |
| `060` agents | `agent_profile`, `agent_document`, `coverage_area`, `agent_absence`, `terms_version`, `terms_acceptance` + scorecard materialised view |
| `070` dispatch | `dispatch`, `dispatch_candidate`, `dispatch_offer`, `assignment_agreement`, `lead_touch`, `attribution`, `dispute`, `commission_statement` |
| `080` comms & notifications | `conversation`, `message`, `compliance_check`, `template`, `template_version`, `sequence`, `sequence_enrollment`, `disclosure`, `device`, `notification`, `delivery_attempt`, `fallback_policy`, `notification_preference` |
| `090` privacy & audit | `processing_activity`, `lawful_basis_record`, `consent_wording`, `consent`, `dsr`, `erasure_propagation`, `retention_policy`, `purge_log`, `breach_incident`, `processor`, partitioned `audit.pii_access_log`, `access_grant`, `role_binding`, `export_request`, `recovery_request`, `step_up_policy` |
| `100` platform & reporting | `webhook_subscription`, `webhook_delivery`, `feature_flag`, `app_version_gate`, reporting views, seed/fixture data (synthetic only) |

## 4 · Index plan, justified against the hot paths

The spec names two hot paths: **dispatch candidate ranking** and **availability resolution**. Everything else is indexed for its dominant query, not speculatively.

### 4.1 Dispatch candidate ranking (latency-sensitive)

The ranking query is: *given a property point and appointment window, find active agents whose coverage contains the point, who are inside working hours and not absent, under capacity, ranked by distance / load / rating / language / fairness.*

| Index | Serves |
|---|---|
| `coverage_area USING gist (area)` | `ST_Covers(area, property.geo_point)` — the primary filter, must be index-driven |
| `agent_profile (state) WHERE state = 'active'` (partial) | candidate pool restriction; suspension removes agents from this index automatically |
| `agent_absence USING gist (agent_id, during)` | anti-join: absent agents drop out on the same index shape as the overlap test |
| `appointment USING gist (agent_id, during) WHERE state IN ('booked','confirmed','in_progress')` | current-load count and conflict check in one shot — this is the exclusion-constraint index reused as a query index |
| `dispatch_offer (agent_id, created_at DESC)` | recent-allocation fairness component |
| `dispatch_offer (dispatch_id) INCLUDE (state)` | offer fan-out and "withdraw siblings on claim" |
| `dispatch (state) WHERE state IN ('pending','offering')` (partial) | live dispatch board, escalation sweep |

Rating/scorecard joins hit the **materialised view** (`agent_scorecard`), refreshed on schedule — never computed in the ranking query.

### 4.2 Availability resolution

Exclusion constraints created with the tables (group `050`) are GiST indexes; the planner reuses them for reads:

```sql
-- created as constraints, usable as indexes:
appointment  EXCLUDE USING gist (agent_id WITH =,   during WITH &&) WHERE (state IN ('booked','confirmed','in_progress'))
appointment  EXCLUDE USING gist (property_id WITH =, during WITH &&) WHERE (state IN ('booked','confirmed','in_progress'))
slot_hold    EXCLUDE USING gist (property_id WITH =, during WITH &&) WHERE (state = 'held')
```

Slot generation reads `property_access_rule` (PK lookup) + blackout JSONB — no extra index needed. `slot_hold (expires_at) WHERE state = 'held'` (partial) serves the TTL release sweep.

### 4.3 The rest, by dominant query

| Table | Index | Dominant query |
|---|---|---|
| `contact_channel` | `(value_normalised)` + `gin (value_normalised gin_trgm_ops)` | inbound routing exact match; fuzzy dedupe |
| `contact` | `(idp_subject_id)` unique | every authenticated request |
| `property` | `(canonical_key)` unique; `gist (geo_point)` | ingest dedupe; radius search & matching |
| `listing` | `(property_id, channel) WHERE state NOT IN ('sold','let','withdrawn','expired')` unique partial | "one active listing per channel" invariant + lookup |
| `listing` | `(state, state_entered_at)` | pipeline sweeps, staleness reports |
| `ingest_record` | `(source_id, idempotency_key)` unique | replay/idempotency check |
| `suppression_entry` | `(value_hmac)` unique | per-record ingest check — must be O(1) |
| `field_provenance` | `(entity_type, entity_id, field_name)` | resolver read-modify-write |
| `pipeline_item` | `(sla_due_at) WHERE sla_due_at IS NOT NULL`; `(first_response_due_at) WHERE first_response_due_at IS NOT NULL` (partial) | SLA breach sweeps scan only items with live timers |
| `pipeline_item` | `(assigned_to, stage_id)` | staff work queues |
| `activity` | `(contact_id, occurred_at DESC)`; `(property_id, occurred_at DESC)` | the two timeline views |
| `requirement_profile` | `gist (areas) WHERE active` | match engine: listing point → profiles |
| `match` | `(profile_id, state)`; `(listing_id)` | alert fan-out, feedback updates |
| `message` | `(conversation_id, sent_at)`; `(provider_message_id)` | thread view; inbound webhook resolution |
| `notification` | `(state, created_at) WHERE state IN ('pending','delivering')` (partial) | fallback escalation sweep |
| `delivery_attempt` | `(next_escalation_at) WHERE next_escalation_at IS NOT NULL` (partial) | ACK-timeout scan |
| `outbox_event` | `(published_at) WHERE published_at IS NULL` (partial); PK `seq` | relay poll; consumer cursor reads |
| every synced table | `(sync_seq)` | `updated_since` delta queries |
| `access_grant` | `(grantee_agent_id, subject_contact_id) WHERE revoked_at IS NULL` (partial) | per-request masking decision — on the auth hot path |
| `dsr` | `(due_at) WHERE state NOT IN ('completed','refused')` (partial) | one-month SLA escalation sweep |

### 4.4 Partitioning & big-table strategy

- **`audit.pii_access_log`**: declarative range partitions by month; BRIN index on `at`; B-tree `(subject_contact_id, at DESC)` per partition for "who saw this person" queries. Partitions are created ahead by the scheduler and never dropped (append-only obligation) — old partitions move to cold storage.
- **`activity`** and **`outbox_event`**: start unpartitioned; monthly partitioning is pre-declared in naming/PK shape (`seq` + timestamp) so it can be adopted online when volume demands, without key changes.
- **`ingest_record.payload`**: raw payloads are bulky and short-lived — the retention purge (see runbook) nulls the payload column after the quarantine window rather than deleting rows, preserving run statistics.

## 5 · Conventions

- **Zero-downtime by default:** additive migrations first; backfill in batches via job, then `NOT NULL`/constraint in a follow-up migration; all index builds `CONCURRENTLY`; no table rewrites inside a deploy window.
- **Every table**: `id uuid DEFAULT gen_random_uuid()`, `created_at`/`updated_at` (trigger-maintained), `sync_seq bigint` stamped by the shared trigger on INSERT/UPDATE for delta sync.
- **State columns** are `text` + `CHECK` constraints (not Postgres enums — enum alteration is operationally painful); the authoritative transition tables live in code, the CHECK guards the value set.
- **Money** is `numeric(12,2)` + `char(3)` currency; **never** float.
- **Timestamps** are `timestamptz` exclusively; `tstzrange` for every interval; IANA zone names stored as `text` where a local-time rule applies (property notice periods, quiet hours).
- **Migration tests in CI:** every PR runs the full chain on a scratch database, then `kysely-codegen` — a schema/typings drift fails the build; groups `050`/`070` additionally run the exclusion-constraint and atomic-claim concurrency tests against the migrated schema.

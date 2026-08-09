# Deliverable 5 — Event Catalogue

**Status: awaiting review.** The outbox/webhook stream consumed by the client layer (and, for a small subset, the scraper). Written to `outbox_event` in the same transaction as the domain change; relayed to webhooks and available for replay by sequence range.

---

## 1 · Envelope

```json
{
  "seq": 184223,
  "id": "01J9F7…",
  "type": "dispatch.offer_sent",
  "occurred_at": "2026-08-09T14:03:11Z",
  "aggregate": { "type": "dispatch", "id": "uuid" },
  "schema_version": 1,
  "payload": { }
}
```

**Rules:**

- **At-least-once** delivery; consumers deduplicate on `id` (or `seq`). Ordering is guaranteed **per aggregate**, not globally.
- **PII-minimal by design**: payloads carry entity IDs, states, and timestamps — never names, emails, phone numbers, or free text. Consumers fetch details through the API, where masking, purpose-bound grants and PII-read auditing apply. This is what keeps the event stream erasure-proof: erasing a subject never requires rewriting history, because history never contained their identity.
- `schema_version` bumps only on breaking payload changes; old versions keep flowing for the API support window.
- Webhook deliveries are HMAC-signed; replay endpoint: `GET /v1/events?from_seq=&to_seq=` (role-filtered).

## 2 · Catalogue

Standard payload fields (`*_id`, `state`, relevant timestamps) are implied; the **Payload extras** column lists only what's beyond that.

### Contacts & identity

| Type | Emitted when | Payload extras | Primary consumers |
|---|---|---|---|
| `contact.lifecycle_changed` | account lifecycle transition | `from`, `to` | clients (session/UI state) |
| `contact.merged` / `contact.unmerged` | dedupe merge or reversal | `surviving_id`, `absorbed_id` | clients (cache repair) |
| `contact.channel_verified` | email/phone verification completes | `channel_kind` | clients |

### Properties, listings & ingest

| Type | Emitted when | Payload extras | Primary consumers |
|---|---|---|---|
| `property.created` / `property.updated` | entity write (post-resolver) | changed field names (not values) | clients (sync nudge) |
| `property.merged` | cross-source duplicate resolved | `surviving_id`, `absorbed_id` | clients, scraper (key remap) |
| `listing.state_changed` | lifecycle transition | `from`, `to`, `channel` | clients, matching |
| `listing.price_changed` | price update | `old`, `new`, `currency` | clients, matching, scoring |
| `listing.published` | entered `live` | — | clients, matching |
| `document.expiring` | EPC/mandate within warning window | `document_kind`, `expires_at` | clients (owner UI), ops |
| `ingest.batch_completed` | batch fully processed | outcome counts | scraper |
| `ingest.record_processed` | per-record outcome | `outcome`, `problem_code?` | scraper |
| `ingest.quarantine_resolved` | staff accepts/rejects | `resolution` | scraper (feedback loop) |

### Pipelines & matching

| Type | Emitted when | Payload extras | Primary consumers |
|---|---|---|---|
| `pipeline.item_stage_changed` | stage transition | `pipeline_kind`, `from`, `to` | clients (staff/agent UI) |
| `pipeline.sla_breached` | SLA timer fires unanswered | `sla_kind` (`first_response`, `stage`) | clients, ops board |
| `task.assigned` / `task.due` / `task.escalated` | work management | — | clients |
| `match.created` | listing matches a profile | `score` | notifications |
| `match.feedback_recorded` | dismissed/interested | `feedback` | matching (weights) |

### Appointments & showings

| Type | Emitted when | Payload extras | Primary consumers |
|---|---|---|---|
| `appointment.state_changed` | any lifecycle transition | `from`, `to`, `by_party?` | clients (all parties' UIs) |
| `appointment.hold_placed` / `appointment.hold_expired` | slot hold TTL lifecycle | `expires_at` | clients |
| `appointment.awaiting_agent` | booking needs dispatch | — | **dispatch module** (internal trigger) |
| `appointment.reminder_due` | T-24h / T-2h | `offset` | notifications |
| `appointment.checked_in` / `checked_out` | attendance proof recorded | `party`, `method` | clients, scorecard |
| `appointment.outcome_captured` | post-visit outcome | `outcome` | clients, demand pipeline |

### Agents

| Type | Emitted when | Payload extras | Primary consumers |
|---|---|---|---|
| `agent.status_changed` | registry state machine | `from`, `to`, `reason?` | clients (agent app), dispatch |
| `agent.document_expiring` | licence/insurance near lapse | `document_kind`, `expires_at` | notifications (agent nudge) |
| `agent.suspended_auto` | doc lapse auto-suspension | `document_kind` | clients, ops |
| `agent.terms_accepted` | T&C acceptance recorded | `terms_version` | clients |

### Dispatch, claim & attribution

| Type | Emitted when | Payload extras | Primary consumers |
|---|---|---|---|
| `dispatch.started` | candidates ranked, offering begins | `strategy` | ops board |
| `dispatch.offer_sent` | offer created for an agent | `ttl_expires_at` | **notifications (critical_ack chain)**, agent app |
| `dispatch.offer_resolved` | claim/decline/expire/withdraw | `resolution` | agent app (remove from list) |
| `dispatch.claimed` | **the atomic claim won** | `agreement_id` | all clients, notifications (losers' UIs update via `offer_resolved`) |
| `dispatch.escalated` | ladder rung executed | `rung` (`widen_radius`, `relax_criteria`, `ops_alert`) | ops board |
| `dispatch.no_agent` | fallback path entered | — | ops board, viewer notification |
| `agreement.created` | claim → assignment agreement | `exclusivity_ends_at` | agent app |
| `attribution.state_changed` | active/converted/expired/disputed | `from`, `to` | agent app, ops |
| `dispute.opened` / `dispute.resolved` | attribution dispute workflow | `resolution?` | agent app, ops |
| `commission.statement_issued` | statement finalised | `amount`, `currency` | agent app |

### Communications & notifications

| Type | Emitted when | Payload extras | Primary consumers |
|---|---|---|---|
| `message.received` | inbound routed to a thread | `channel` | clients (thread UI) |
| `message.delivery_changed` | sent/delivered/bounced/complained | `channel`, `state` | clients (staff UI) |
| `message.blocked_by_gate` | pre-send compliance gate refusal | `gate_reason` | ops (never external webhooks) |
| `notification.acknowledged` | client ACK received | `ack_channel` | dispatch (stop escalation) |
| `notification.chain_exhausted` | fallback chain ran out | `last_channel` | ops board |

### Portfolio (added 2026-08-09, client-team scope)

| Type | Emitted when | Payload extras | Primary consumers |
|---|---|---|---|
| `portfolio.entry_added` / `portfolio.entry_removed` | investor adds/removes a tracked property | — | clients |
| `portfolio.entry_updated` | investor-entered figures or status change | changed field names | clients |
| `portfolio.valuation_updated` | comp-based re-estimate **actually changes** `current_value_estimate` (not on every recompute) | `old`, `new` (Money) | clients |

### Privacy & platform

| Type | Emitted when | Payload extras | Primary consumers |
|---|---|---|---|
| `dsr.received` / `dsr.completed` | data subject request lifecycle | `kind` | clients (self-service UI), ops |
| `privacy.processing_restricted` | Art 18 freeze toggled | `restricted` | all modules (enforcement), clients |
| `privacy.erased` | erasure pipeline completed | *(aggregate id is a pseudonymous ref)* | clients (**purge local caches for this subject — contractual obligation**) |
| `platform.api_deprecation` | version sunset announced | `version`, `sunset_at` | client team tooling |
| `platform.flags_changed` | feature flag / remote config update | changed keys | clients (config refresh) |

## 3 · Consumer obligations (part of the contract)

1. Deduplicate on `id`; tolerate redelivery and out-of-global-order arrival.
2. Treat unknown event types and unknown payload fields as ignorable — the catalogue grows additively.
3. On `privacy.erased`: purge any locally cached data for that aggregate within 72 h. This obligation is what lets the CRM complete erasure attestations covering downstream caches.
4. Never persist event payloads as a data source of record — events signal *that* something changed; the API is the source of *what*.

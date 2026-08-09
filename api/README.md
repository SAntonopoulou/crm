# API Contract — v1

This directory is the **contract of record** between the CRM and the other two
components. The CRM implementation conforms to these documents — not the other
way round. If the implementation and the contract disagree, the contract wins
and the implementation is the bug.

| Document | Audience |
|---|---|
| [`openapi/crm-v1.yaml`](openapi/crm-v1.yaml) | Web + Flutter client team |
| [`openapi/ingest-v1.yaml`](openapi/ingest-v1.yaml) | Scraper team |

Prose companion (semantics, rationale): [`../docs/api-specification.md`](../docs/api-specification.md).
Async events (webhooks): [`../docs/event-catalogue.md`](../docs/event-catalogue.md).

## Change policy (frozen contract)

The contract is **frozen** as of v1. Changes happen only when absolutely
required, and only like this:

1. **Additive, non-breaking** (new optional field, new endpoint, new value in
   an enum marked OPEN): allowed via PR with the `contract-additive` label.
   Consumers must already tolerate these by contract.
2. **Breaking** (removed/renamed field, type change, new required input,
   changed status semantics, new value in a CLOSED enum): requires a version
   bump (`/v2`), a deprecation window on v1, and sign-off from every consuming
   team on the PR. There is no fast path.
3. CI runs `oasdiff` against `main` on every PR touching this directory; a
   breaking diff without a version bump fails the build.

Enums are explicitly marked **OPEN** (unknown values must be handled with a
default arm) or **CLOSED** (value set is part of the contract) in their
descriptions.

## Developing against the contract today (no CRM server needed)

Run a mock server from the spec — request/response validation included:

```bash
# client API on :4010
npx @stoplight/prism-cli mock api/openapi/crm-v1.yaml -p 4010

# ingest API on :4011
npx @stoplight/prism-cli mock api/openapi/ingest-v1.yaml -p 4011
```

Prism returns schema-valid examples for every route, validates your request
bodies/headers against the contract, and honours `Prefer: code=409` style
headers to force specific responses — which is how you test your handling of
`already_claimed`, `offer_expired`, `state_conflict`, etc. before the real
server exists.

Generate typed clients:

```bash
# Flutter / Dart
npx @openapitools/openapi-generator-cli generate -i api/openapi/crm-v1.yaml -g dart-dio -o gen/dart

# TypeScript (web)
npx @openapitools/openapi-generator-cli generate -i api/openapi/crm-v1.yaml -g typescript-fetch -o gen/ts
```

Validate after editing:

```bash
npx @redocly/cli lint api/openapi/*.yaml
```

## Changelog

### crm-v1.yaml 1.1.0 — 2026-08-09

Coordinated amendment from the client-team reconciliation
([`docs/client-reconciliation.md`](../docs/client-reconciliation.md)):

- **Additive:** `ListingSummary.property_kind` (CLOSED), `.occupancy` (OPEN,
  nullable), `.estimated_rental_yield_percent` (nullable, server-computed);
  `GET /listings` filters `property_kind`, `occupancy`;
  `GET /listings/{id}/viewing-slots` (browse-then-hold);
  `portfolio` tag: `GET/POST /me/portfolio`, `PATCH/DELETE
  /me/portfolio/{propertyId}` + `PortfolioEntry*` schemas.
- **Narrowing, client-requested:** `Listing.epc_rating` closed to the Belgian
  label superset `A++…G` (+ null). Requested as A–G by the client team; closed
  to the nine-value regional superset instead because Flemish/Brussels/Walloon
  certificates legitimately carry A+/A++. Signed off via the reconciliation
  doc; no other consumers existed at amendment time.

## Contract semantics cheat-sheet

- **Errors**: RFC 9457 `application/problem+json`; the `code` field is the
  machine contract (`already_claimed`, `state_conflict`, `hold_expired`,
  `claims_online_only`, `idempotency_key_reuse`, `step_up_required`, …).
- **Idempotency**: send `Idempotency-Key` on unsafe requests. Same key + same
  payload = stored response replayed; same key + different payload = 409.
- **Offline queue**: replayed writes add `X-Offline-Replay: 1`. State-machine
  resources are server-authoritative (`409 state_conflict` + current resource);
  free text is last-write-wins. **Claims must never enter the offline queue.**
- **Delta sync**: `GET /v1/sync?since=<seq>` → changes + tombstones ordered by
  `sync_seq`; follow `next_since` while `has_more`.
- **Version gate**: send `X-App-Platform` / `X-App-Version`; handle `426` as a
  hard upgrade wall and the bootstrap `version_verdict` as the soft one.
- **PII masking**: party details are masked by default; full details appear
  only inside an active purpose-bound window (post-claim, around the
  appointment). Design UIs for the masked shape as the normal case.
- **ACKs**: time-critical pushes (dispatch offers) must be ACKed via
  `POST /v1/notifications/{id}/ack` as soon as the client renders them —
  no ACK means the server escalates to SMS/email and the agent gets duplicate
  noise. This is a contract obligation on the mobile client.

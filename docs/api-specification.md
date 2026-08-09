# Deliverable 4 — API Specification

**Status: published, contract-first.** The machine-readable OpenAPI documents live in [`api/openapi/`](../api/openapi/) and are **the contract of record**: hand-authored first, frozen at v1, and the CRM implementation is built to conform to them (if implementation and contract disagree, the implementation is the bug). The scraper and client teams pin their codegen and mock servers to these files — see [`api/README.md`](../api/README.md) for the change policy, mock-server workflow and codegen commands. CI diffs the contract on every PR — a breaking change without a version bump fails the build. This document is the prose companion: semantics and rationale.

---

## 1 · Versioning & lifecycle

- URI-versioned: `/v1/...`. A version is **supported for 12 months after its successor ships**; deprecation is announced via `Deprecation` and `Sunset` response headers plus the event stream (`platform.api_deprecation`), never silently.
- Additive changes (new optional fields, new endpoints, new enum values *marked extensible*) are non-breaking within a version. Consumers must tolerate unknown fields; enums documented as **open** must be handled with a default arm — this is in both teams' contract.
- **Minimum-version gate**: every client request carries `X-App-Platform` + `X-App-Version`. The gate compares against `app_version_gate` config: below `warn_below` → response includes `X-Upgrade-Advised` with a server-driven message key; below `min_version` → `426 Upgrade Required` with a localised message body. Web is gated by build hash with warn-only semantics.

## 2 · Authentication & authorization

- All calls bear a Keycloak JWT. Human clients use Authorization Code + PKCE; the **scraper uses client-credentials** with a dedicated service account scoped to the ingest endpoints only.
- The CRM keys everything on the token's `sub` (opaque subject ID). Roles arrive as realm roles; fine-grained decisions (masking, purpose-bound grants) are CRM-side.
- **Step-up**: endpoints marked `step_up:<action>` verify token ACR/auth-age against `step_up_policy`; failure returns `403` with `{"error":"step_up_required","acr":"..."}` and the client re-authenticates. Applies to: payout detail changes, contract acceptance, bulk export, first claim.

## 3 · Conventions

- Errors: RFC 9457 `application/problem+json` with a stable machine `code` per problem type.
- Pagination: cursor-based (`?cursor=`, `?limit=` ≤ 100), `next_cursor` in body.
- **Idempotency**: all unsafe endpoints accept `Idempotency-Key`. Same key + same payload → replay of the stored response; same key + different payload → `409 idempotency_key_reuse`. Keys expire after 24 h.
- Rate limits: per-token buckets, `429` + `Retry-After`; ingest has its own volume-based budget.
- Timestamps ISO-8601 UTC; money as `{"amount": "285000.00", "currency": "EUR"}` (string decimal).

## 4 · Ingest contract (scraper team)

```
POST /v1/ingest/batches                 Idempotency-Key required
GET  /v1/ingest/batches/{batchId}       per-record outcomes
POST /v1/ingest/batches/{batchId}/replay
```

Batch = source metadata + up to 500 records. Each record: caller-supplied `idempotency_key` (unique per source), `dedupe_key` (address-based for properties, channel-based for contacts), `kind` (`property_listing`, `owner_contact`, `combined`), payload, and **per-field provenance** (`collected_at`, `method`, `confidence`).

Per-record outcomes (also delivered as `ingest.record_processed` events): `created` / `updated` / `unchanged` / `quarantined` (with reason) / `suppressed` / `failed` (with problem code). **`suppressed` is intentionally indistinguishable from success in bulk stats** — the scraper must not learn which specific identifiers are on the suppression list; the outcome exists so re-sends stop, it carries no identifying detail.

Contract guarantees to the scraper team:
1. Replaying a batch (same idempotency keys) is always safe — recorded outcomes, no side effects.
2. A record whose subject was erased will never recreate the subject (suppression precedes entity writes).
3. Scraped values never overwrite owner-confirmed or staff-verified values — they park as candidates (see [domain model §4](domain-model.md)).
4. Malformed records fail individually; a batch is never all-or-nothing.

## 5 · Client contract (web + Flutter team) — surface map

| Area | Endpoints (representative, not exhaustive) | Notes |
|---|---|---|
| Session/bootstrap | `GET /v1/bootstrap` | flags, remote config, version gate verdict, server-driven copy keys, feature entitlements per role |
| Contacts/self | `GET/PATCH /v1/me`, `/v1/me/channels`, `/v1/me/preferences` | preference centre: per channel × category × device |
| Properties & listings | `GET /v1/listings`, `GET /v1/listings/{id}`, `GET /v1/properties/{id}` | search: geo (point+radius or polygon), filters; owner self-serve writes for `verified` owners (hybrid model) |
| Requirement profiles | `GET/POST/PATCH /v1/me/requirement-profiles` | drives matching; feedback: `POST /v1/matches/{id}/feedback` (`dismissed`/`interested`) |
| Appointments | `POST /v1/appointments/holds` → `POST /v1/appointments` → reschedule/cancel sub-resources | hold returns `expires_at` (TTL); booking validates hold + min-notice in property tz; cancellation returns applied policy |
| Agent: offers & claim | `GET /v1/agent/offers`, `POST /v1/agent/offers/{id}/claim`, `.../decline` | see §6 — the one endpoint with special semantics |
| Agent: schedule & profile | `GET /v1/agent/schedule` (+ iCal feed URL), `GET/PATCH /v1/agent/profile`, document upload | uploads are resumable (tus protocol), EXIF stripped server-side |
| Showings execution | `POST /v1/appointments/{id}/check-in|check-out` (geofence evidence or one-time code), `POST .../feedback`, `POST .../outcome` | |
| Conversations | `GET /v1/conversations`, `POST /v1/conversations/{id}/messages` | in-app channel; other channels join the same thread server-side |
| Notifications | `POST /v1/notifications/{id}/ack`, action endpoints from tray buttons | tray accept = the claim endpoint with identical atomicity; ACK is what halts the fallback chain |
| Devices | `PUT /v1/devices/{installId}` | token, platform, locale, OS permission state; server prunes dead tokens |
| Privacy self-service | `POST /v1/me/dsr` (access/erasure/…), `GET /v1/me/dsr/{id}`, `GET /v1/me/consents`, `POST /v1/me/consents/{purpose}/withdraw` | files into the DSR queue with the one-month SLA |
| Delta sync | `GET /v1/sync` | §7 |

Staff/ops console endpoints (`/v1/ops/...`: quarantine queue, dispatch board, disputes, DSR queue, recovery queue) share the platform but are a separate OpenAPI tag with staff-role guards and are not part of the mobile contract.

## 6 · The claim endpoint (contract-critical)

```
POST /v1/agent/offers/{offerId}/claim     step_up on first-ever claim
```

- `200` → claim won. Body: assignment agreement summary, purpose-bound contact reveal window, appointment details.
- `409 already_claimed` → clean loss; body includes nothing about the winner.
- `410 offer_expired` / `409 offer_withdrawn` → TTL lapsed or dispatch cancelled.
- **Idempotent**: same agent retrying after a network failure gets `200` again (its own win is replayed, never double-created).
- **Online-only**: requests carrying the offline-queue replay header (`X-Offline-Replay`) are rejected `422 claims_online_only` — the client team must exclude claims from the offline write queue by contract, and the server enforces it.
- Claim TTLs and countdowns are server-authoritative: the offer payload carries `ttl_expires_at`; client countdowns are cosmetic.

## 7 · Delta sync & offline writes

```
GET /v1/sync?since=<seq>&types=listing,appointment,offer,...
```

- Returns changed resources **and tombstones**, ordered by the global `sync_seq`, with `next_since` cursor; `since=0` bootstraps. Single resources support `ETag`/`If-None-Match`.
- Sync scope is role-filtered server-side (an agent syncs their offers/appointments, an owner their properties) — the cursor never leaks cross-tenant data.
- **Offline write queue**: unsafe requests replayed from the client queue carry `Idempotency-Key` + `X-Offline-Replay`. Server policy: state-machine resources are **server-authoritative** (a stale transition gets `409 state_conflict` + current resource; client reconciles); free-text fields are last-write-wins. Claims: excluded entirely (§6).

## 8 · Media, deep links, webhooks

- **Media**: `POST /v1/media/uploads` (tus resumable) → server thumbnails, EXIF-strips, virus-scans → `media_asset` reference to attach. Direct-to-storage with signed URLs; the API never proxies bytes.
- **Deep links**: canonical `https://{host}/l/{listingId}` etc. generated server-side; `apple-app-site-association` and `assetlinks.json` served from platform config.
- **Webhooks** (client-side team's backend): subscriptions per event type, HMAC-SHA256 signature header, at-least-once with exponential backoff and a 24 h retry budget; replay endpoint by event `seq` range. Payloads follow the [event catalogue](event-catalogue.md) envelope — PII-minimal, IDs not identities.

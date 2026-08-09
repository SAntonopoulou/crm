# Deliverable 7 — Operational Runbook

**Status: awaiting review** (procedures take effect as the modules ship). Audience: whoever is on call — assumed to have ops-console access and `crm_readonly` DB access; destructive actions go through the console's audited paths, never raw SQL.

---

## 1 · Dispatch tuning

All parameters are **feature-flag keys** (`feature_flag` table, served via `/v1/bootstrap` and hot-reloaded server-side) — retuning never needs a deploy or app release. Changes are audit-logged with actor and take effect for *new* dispatches only; in-flight dispatches keep their `config_snapshot`.

| Key | Default | Safe range | Effect / notes |
|---|---|---|---|
| `dispatch.strategy` | `hybrid` | waterfall / broadcast / hybrid | hybrid = N waterfall rounds then open broadcast |
| `dispatch.waterfall_rounds` | 3 | 1–5 | rounds before broadcast (hybrid) |
| `dispatch.offer_ttl_seconds` | 120 | 60–600 | per-offer countdown; below 60 s mobile ACK latency causes false expiry |
| `dispatch.radius_initial_km` | 10 | 3–25 | first candidate ring |
| `dispatch.radius_step_km` | 10 | 5–25 | added per `widen_radius` escalation rung |
| `dispatch.rank_weights` | `{distance:0.3, load:0.2, rating:0.2, language:0.15, fairness:0.15}` | must sum to 1 | changing weights is an **Art 22-relevant** change: record the rationale in the change note; the explanation endpoint reflects the snapshot |
| `dispatch.relax_criteria_order` | `[language, specialism]` | — | second escalation rung |
| `dispatch.ops_alert_after_rungs` | 2 | 1–3 | when the board pages a human |
| `dispatch.max_concurrent_offers` | 1 (waterfall) / 8 (broadcast) | 1–15 | broadcast fan-out width |

**Symptom → adjustment quick table** (verify on the dispatch board first — §5):
- Time-to-claim rising, claim rate healthy → lower `offer_ttl_seconds` or raise `waterfall_rounds` fan-out.
- `no_agent` rate rising in a region → raise `radius_initial_km` for that region's flag audience; check agent supply/suspensions before touching weights.
- One agent hoovering everything → raise `fairness` weight a notch (0.05 steps); confirm on the allocation histogram after 48 h.
- Complaints of "already claimed" frustration → widen waterfall (fewer simultaneous offers), not shorter TTLs.

## 2 · Scheduled jobs

All jobs are BullMQ repeatables; every run writes a job-run record (start, end, counts, errors) surfaced on the health board. **Every purge writes to `purge_log`** (category, policy, row counts) — that log is the evidence for retention compliance.

| Job | Schedule (Europe/Brussels) | What it does | Failure response |
|---|---|---|---|
| `retention-sweep` | daily 03:00 | applies `retention_policy` clocks per category (defaults below) | alert if 2 consecutive failures — a silent stall is a compliance breach in the making |
| `ingest-payload-purge` | daily 03:30 | nulls `ingest_record.payload` past quarantine window | same |
| `sla-sweep` | every minute | fires breached `first_response_due_at` / stage SLAs / DSR due-date escalations | backlog > 5 min → page; timers are user-visible promises |
| `offer-ttl` / `hold-ttl` | delayed jobs per record | expire offers, release slot holds | DLQ entries here mean stuck dispatches — treat as incident |
| `grant-revocation` | every 5 min | revokes `access_grant` past window | failure = agents keep PII access → page immediately |
| `doc-lapse-check` | daily 06:00 | agent licence/insurance expiry → auto-suspend + notify | verify suspension events emitted |
| `scorecard-refresh` | hourly | refresh `agent_scorecard` MV | stale scorecard degrades ranking quality only — no page |
| `partition-maintenance` | monthly | pre-create next audit/activity partitions | must never fail twice in a row |
| `outbox-relay` | continuous | publish outbox → webhooks | lag > 60 s → page (client UX degrades) |
| `retention: backups` | per backup policy | verify backup + **suppression-replay drill** (§4) | quarterly drill is mandatory, calendar-owned |

**Default retention clocks** (proposed — need DPO sign-off before go-live, tracked as launch blocker):
unregistered scraped leads **6 months from collection** (Art 14 disclosure within 1 month regardless); quarantined raw payloads 30 days; registered/active customers: life of relationship + 30 days post-erasure-request processing; messages 3 years; dispatch/audit records 5 years (commission disputes); `pii_access_log` never purged, cold-stored after 12 months; suppression HMACs kept indefinitely (they contain no recoverable PII and are the erasure guarantee).

## 3 · Breach notification procedure (72-hour clock)

**Detection → the clock starts at *awareness*, not confirmation.** Whoever suspects a breach opens an incident in the console (`breach_incident`) immediately — that timestamps `detected_at` and computes `notify_deadline_at`.

1. **T+0 – T+4 h — Triage.** Incident commander = on-call dev (day 1 team: whoever is available; not the person who caused it if avoidable). Contain (revoke tokens/sessions via Keycloak, disable compromised flags/keys, isolate). Log every action in the incident timeline — the timeline *is* the Art 33(5) documentation.
2. **T+4 – T+24 h — Assess.** What data, whose, how many subjects, risk level. The `pii_access_log` and audit trail are the primary forensic sources. Classify: risk to subjects → DPA notification required; *high* risk → subject notification also required.
3. **T+24 – T+72 h — Notify DPA** if required: lead authority is the **Belgian APD/GBA** (assuming establishment in BE — confirm at launch; FR CNIL / NL AP if cross-border, via the one-stop-shop). Use the incident record's export as the notification annex. Partial notification before the deadline beats complete notification after it — the form allows supplements.
4. **Subjects** (if high risk): plain-language notice via the notification module, transactional category (not suppressible), per-locale templates pre-drafted in the template library (`breach_notice.fr/nl/en` — drafting these is a launch-checklist item).
5. **Post-incident:** close the incident with root cause, remediation, and a review of whether `processor` register entries (sub-processors involved) require their own notifications under their DPAs.

**Never**: delete or edit audit/incident records (append corrections instead); communicate externally except through the incident commander; wait for certainty past T+68 h.

## 4 · Backup, restore & erasure consistency

- Nightly full + WAL archiving; encrypted at rest; restore rehearsal quarterly.
- **Restore procedure has two extra mandatory steps** versus a vanilla restore: (1) replay `suppression_entry` against the restored data — any entity matching a suppression HMAC is re-pseudonymised before the system accepts traffic; (2) verify crypto-shredding: sample erased subjects and confirm their `contact_sensitive` fields fail decryption (their DEKs no longer exist in KMS — key deletion is *not* reversed by DB restore, which is the point).
- KMS key material is backed up under the KMS's own policy, **excluding destroyed DEKs** — never re-import a destroyed subject key.

## 5 · Dashboards & alert thresholds

| Board | Watch | Page when |
|---|---|---|
| Dispatch | time-to-claim p50/p95, claim rate, `no_agent` rate, escalation rung histogram | claim rate < 70 % over 1 h, or any `no_agent` in a covered region |
| Ingest | batch failure rate, quarantine depth, suppression hits | failure > 5 %, quarantine > 200 pending |
| Notifications | per-channel delivery rate, ACK latency, chain exhaustion, DLQ depth | push delivery < 90 %, DLQ > 50 |
| SLA | first-response breach rate, DSR queue vs. one-month deadlines | any DSR within 5 days of deadline unassigned |
| Privacy | grant-revocation job health, purge job history, erasure propagation failures | any propagation `failed`, revocation job stalled |
| Platform | outbox lag, API p95 per route, version-gate rejection counts | outbox lag > 60 s; gate rejections spiking after a config change (bad `min_version` push — roll back the flag) |

## 6 · Common incidents, first moves

- **Stuck dispatch (offering, no live offers):** board → the dispatch → check offer TTL job in DLQ → requeue; if claim row shows `winning_offer_id` set but state ≠ `claimed` (should be impossible — single UPDATE), open a bug incident, use staff direct-assign to unblock the viewer.
- **Notification chain silent:** check provider status pages first (FCM/APNs outage looks like mass ACK timeout); the chain auto-falls-back — resist manually re-sending, you'll double-message; raise `offer_ttl_seconds` temporarily if push is degraded platform-wide.
- **Ingest flooding quarantine:** usually a portal layout change upstream — coordinate with scraper team, pause the source (`source` disable flag) rather than letting quarantine grow; replay the batches after their fix.
- **Erasure propagation `failed` on Keycloak:** retry from the DSR detail view; if Keycloak is down, the DSR stays open — the one-month SLA clock is the backstop, escalate before it bites.
- **Accidental PII in an event payload or log** (should be prevented by design): treat as an incident (§3 triage), purge the webhook consumer side per contract, fix the emitter — do not rewrite the outbox (append a correction event).

# Launch Checklist

Everything engineering could build is built, tested, and config-gated: each
external integration binds automatically the moment its variables appear in
`.env.production` (template: [`.env.production.example`](../.env.production.example)).
What remains is **provisioning, credentials, and sign-offs** — none of it code.

## 1 · Credentials & accounts to provision (Sophia / whoever owns the accounts)

| # | What | Fills in | Verifies itself by |
|---|---|---|---|
| 1 | Managed **PostgreSQL 16 + PostGIS** and **Redis** | `DATABASE_URL`, `REDIS_URL` | `migrate` service applies all 19 migrations |
| 2 | **Keycloak** deployment; import [`keycloak/realm-crm.json`](../keycloak/realm-crm.json); rotate the two dev client secrets | `KEYCLOAK_ISSUER`, `KEYCLOAK_ADMIN_CLIENT_SECRET` | login works; erasure test deletes a test user |
| 3 | **KMS-held secrets**: generate + store master key (32B base64) and suppression HMAC key | `KMS_MASTER_KEY`, `SUPPRESSION_HMAC_KEY` | payout IBAN save/reveal round-trips |
| 4 | **S3 bucket** (EU region) + access key | `S3_*` | media upload lands in the bucket |
| 5 | **SMTP** account (EU provider) | `SMTP_URL`, `EMAIL_FROM` | notification fallback email arrives |
| 6 | **Twilio** (or compatible) account + BE sender number | `TWILIO_*` | fallback SMS arrives |
| 7 | **Firebase project** + service account for FCM (covers iOS + Android push) | `FCM_SERVICE_ACCOUNT` | dispatch offer push arrives on a test device |
| 8 | **Self-hosted Nominatim** (or EU geocoding vendor) | `GEOCODER_URL` | ingested property gets coordinates |
| 9 | Webhook edge secret (random) shared with provider callback config | `PROVIDER_WEBHOOK_SECRET` | bounce webhook flips a message to `bounced` |
| 10 | Domain + TLS, container registry, host for `docker-compose.prod.yml` (or translate to your orchestrator) | `PUBLIC_BASE_URL` | `/health` green from the internet |
| 11 | Monitoring/alerts wired to runbook §5 thresholds; backups per runbook §4 (incl. quarterly suppression-replay drill) | — | first restore rehearsal |

## 2 · Legal & organisational sign-offs (counsel / DPO)

| # | Item | Where it lands in the system |
|---|---|---|
| 1 | **LIA** for scraped-data processing | reference on `privacy.processing_activity` (`LIA-2026-001` placeholder) |
| 2 | **Art 26 / C2C arrangement** for agents | new `core.terms_version` row; agents re-accept in-app |
| 3 | **Retention clocks** approval | `privacy.retention_policy` rows (defaults: 180d unregistered leads, 30d payloads) |
| 4 | **Per-country ePrivacy decisions** for electronic outreach | `core.channel_policy` rows (absence = BLOCK, which is the safe launch state) |
| 5 | **Breach-notice copy** (fr/nl/en) | replaces the `[PENDING COUNSEL]` `breach_notice` template versions |
| 6 | Lead supervisory authority confirmation (assumed BE APD/GBA) | runbook §3 |
| 7 | Privacy policy + in-app legal texts | served via bootstrap copy / legal pages |

## 3 · Client-side launch items (the other two teammates)

- Scraper: point at production, real `Idempotency-Key` discipline, monitor
  quarantine rate the first week.
- Mobile app: implement against the design package from
  `~/property-design-request.md`; store listings (Apple/Google) with the
  data-safety questionnaires; deep-link association files served under the
  production domain.

## 4 · Launch-day order

1. Provision §1 rows 1–4 → deploy stack → smoke `/health`, login, migration state.
2. Seed staging with `npm run seed`; run the runbook §5 dashboards against it.
3. Add messaging + geocoder credentials (rows 5–9); verify each self-check.
4. Counsel items §2 — at minimum LIA, retention, breach templates before real
   scraped data flows; `channel_policy` can stay empty (block-all) at launch.
5. Ingest a first real scrape batch; watch quarantine + geocode rates.
6. Store release once the app passes the §3 checklist.

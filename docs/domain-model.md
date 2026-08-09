# Property CRM — Domain Model & ERD

**Deliverable 1 of 7 · Status: awaiting review** — no code or migrations until this is approved.

| Decision | Locked choice |
|---|---|
| Stack | TypeScript / NestJS · PostgreSQL 16 + PostGIS · Redis + BullMQ |
| Identity provider | Keycloak (CRM stores only the opaque `subject_id`) |
| Exclusivity & attribution | Exclusive window, sole credit (default 30 days from showing; every touch snapshotted so a split policy can be layered on later) |
| Operating model | Hybrid — scraped listings staff-mediated until the owner registers and verifies, then self-serve |

Conventions used throughout: every table gets `id uuid PK`, `created_at` / `updated_at timestamptz`, and a trigger-maintained `sync_seq bigint` (global sequence) for delta sync. All timestamps are `timestamptz`; scheduling logic computes in the property's IANA timezone (derived at geocode time). Diagrams show the columns that carry a design decision — exhaustive column lists arrive with Deliverable 2 (migrations).

---

## 1 · Module map

Thirteen NestJS modules, one Postgres schema each where isolation pays for itself (`audit`, `privacy`) and a shared `core` schema for the rest:

```mermaid
flowchart LR
  subgraph upstream [Upstream]
    SCR[Scraper]
  end
  subgraph crm [CRM]
    ING[Ingest and Provenance] --> PROP[Properties and Listings]
    ING --> CONT[Contacts and Identity]
    PROP --> PIPE[Pipelines]
    CONT --> PIPE
    PROP --> MATCH[Matching]
    MATCH --> NOTIF[Notifications]
    PIPE --> COMMS[Communications]
    PROP --> APPT[Appointments]
    APPT --> DISP[Dispatch and Attribution]
    AGENT[Agent Registry] --> DISP
    DISP --> NOTIF
    SEC[Access Control and Audit] -.enforces on all.- CONT
    PRIV[Privacy and GDPR] -.governs all.- CONT
    PLAT[Platform: outbox, flags, sync] -.serves all.- NOTIF
  end
  subgraph downstream [Downstream]
    WEB[Web client]
    APP[Flutter app]
  end
  SCR -->|batched idempotent upsert| ING
  PLAT -->|events, delta sync| WEB
  PLAT -->|events, delta sync| APP
  NOTIF -->|push, SMS, email| APP
```

---

## 2 · Contacts & identity

A **contact is one human** (or one organisation via `ORGANISATION`); roles are attached rows with independent lifecycles, never subtypes. The Keycloak `subject_id` is the only identity link — email is a channel, never a key. Direct identifiers that need KMS field encryption live in a separate 1:1 table so the main row never carries them.

```mermaid
erDiagram
  CONTACT ||--o{ CONTACT_ROLE : "holds"
  CONTACT ||--o{ CONTACT_CHANNEL : "reachable via"
  CONTACT ||--o| CONTACT_SENSITIVE : "encrypted ids"
  CONTACT ||--o{ ORG_MEMBERSHIP : "belongs to"
  ORGANISATION ||--o{ ORG_MEMBERSHIP : "employs"
  CONTACT ||--o{ CONTACT_RELATIONSHIP : "linked from"
  CONTACT ||--o{ CONTACT_MERGE : "merge history"

  CONTACT {
    uuid id PK
    text idp_subject_id UK "nullable until registered, opaque Keycloak sub"
    text lifecycle_state "unregistered, invited, registered, identity_verified, suspended, erased"
    text locale "fr, nl, en"
    text timezone
    boolean processing_restricted "GDPR Art 18 freeze flag"
    uuid dek_id "per-subject data encryption key, destroyed on erasure"
  }
  CONTACT_ROLE {
    uuid contact_id FK
    text role "owner, buyer, renter, agent, staff"
    text state "active, dormant, ended"
    timestamptz activated_at
    timestamptz ended_at
  }
  CONTACT_CHANNEL {
    uuid contact_id FK
    text kind "email, phone"
    text value_normalised "E164 for phone, lowercased for email"
    text verification_state "unverified, pending, verified, bounced"
    boolean is_preferred
  }
  CONTACT_SENSITIVE {
    uuid contact_id PK
    bytea national_id_enc "KMS envelope encrypted"
    bytea iban_enc "KMS envelope encrypted"
  }
  ORGANISATION {
    uuid id PK
    text kind "agency, corporate_landlord"
    text name
    text registration_number
  }
  ORG_MEMBERSHIP {
    uuid contact_id FK
    uuid organisation_id FK
    text role_in_org
    daterange validity
  }
  CONTACT_RELATIONSHIP {
    uuid from_contact_id FK
    uuid to_contact_id FK
    text kind "co_owner, power_of_attorney, tenant_of_record"
    daterange validity
  }
  CONTACT_MERGE {
    uuid surviving_id FK
    uuid absorbed_id FK
    jsonb pre_merge_snapshot "full state of both records for unmerge"
    timestamptz merged_at
    uuid merged_by FK
    timestamptz unmerged_at "null unless reversed"
  }
```

**Merge/unmerge:** merging re-points child rows to the survivor and stores a full JSONB snapshot of both records plus the re-pointing map; unmerge replays the map in reverse. The absorbed row stays as a tombstoned alias so inbound references (ingest dedupe keys, inbound email routing) still resolve. Every merge and unmerge is also an audit event.

**Account lifecycle** (spec-given, enforced as a state machine on `CONTACT.lifecycle_state`): `unregistered → invited → registered → identity_verified`, with `suspended` reachable from and returnable to any active state, and `erased` terminal (row pseudonymised, DEK destroyed, suppression entries written).

---

## 3 · Properties & listings

**Property** is the durable physical asset; a **listing** is one marketing episode (sale *or* rent) of that property. A property accumulates listings over the years; at most one *active* listing per channel is enforced by a partial unique index. The spec's lifecycle state machine (§7 below) lives on the listing, not the property.

```mermaid
erDiagram
  PROPERTY ||--o{ LISTING : "marketed as"
  PROPERTY ||--o{ PROPERTY_PARTY : "owned or represented by"
  CONTACT ||--o{ PROPERTY_PARTY : "party to"
  LISTING ||--o{ LISTING_CHANGE : "history"
  PROPERTY ||--o{ PROPERTY_DOCUMENT : "evidenced by"
  PROPERTY ||--o{ MEDIA_ASSET : "depicted by"
  PROPERTY ||--o{ PROPERTY_MERGE : "merge history"

  PROPERTY {
    uuid id PK
    text canonical_key UK "hash of normalised address plus unit designator"
    jsonb address_normalised "structured, libpostal output"
    geography geo_point "PostGIS, SRID 4326"
    text timezone "IANA, derived from geocode"
    text kind "house, apartment, land, commercial"
    text tenure "freehold, leasehold"
    numeric floor_area_sqm
    int bedrooms
    text epc_rating
    jsonb features "structured attributes"
    jsonb free_attributes "unmodelled source data, provenance tracked"
  }
  LISTING {
    uuid id PK
    uuid property_id FK
    text channel "sale, rent"
    text state "see listing lifecycle machine"
    numeric price
    char3 currency
    text description
    timestamptz state_entered_at
  }
  LISTING_CHANGE {
    uuid listing_id FK
    text field "price, state, description"
    jsonb old_value
    jsonb new_value
    uuid provenance_id FK "who or what changed it"
    timestamptz changed_at
  }
  PROPERTY_PARTY {
    uuid property_id FK
    uuid contact_id FK
    text role "owner, representative"
    numeric ownership_share "nullable"
    daterange validity "supports historical ownership"
  }
  PROPERTY_DOCUMENT {
    uuid property_id FK
    text kind "epc_certificate, floor_plan, title_deed, mandate"
    text storage_key
    date issued_at
    date expires_at "expiry watched by scheduler"
    text verification_state
  }
  MEDIA_ASSET {
    uuid property_id FK
    uuid listing_id FK "nullable, listing-specific media"
    text kind "photo, video, plan"
    text storage_key "EXIF stripped at upload"
    int position
    text caption
    text rights_status "owned, licensed, scraped_unverified"
  }
```

**Canonical key:** `sha256(country | normalised_street | number | unit | postcode)` from libpostal-normalised components — deliberately *not* derived from geocoder output, so a geocoder version bump can't fork identities. The geocode (point, timezone, confidence) is stored alongside with its own provenance row. Cross-source near-duplicates (fuzzy address + <25 m distance) are surfaced to the quarantine queue rather than auto-merged.

---

## 4 · Ingest, provenance & suppression

Every provenance-bearing field write flows through one **resolver**: the incoming value wins only if its method outranks the current value's method (`staff_verified > owner_submitted > scraped`, overridable per field via `FIELD_PRECEDENCE_RULE`). A losing value isn't discarded — it's parked as `candidate_value` on the provenance row, visible in the review UI. This is what makes "owner-confirmed always supersedes scraped" structural rather than conventional.

```mermaid
erDiagram
  SOURCE ||--o{ INGEST_RUN : "produces"
  INGEST_RUN ||--o{ INGEST_RECORD : "contains"
  INGEST_RECORD ||--o| QUARANTINE_ITEM : "may be held as"
  INGEST_RECORD ||--o{ FIELD_PROVENANCE : "yields"

  SOURCE {
    uuid id PK
    text kind "portal_scrape, owner_submission, staff_entry"
    text name
    text default_lawful_basis "legitimate_interest with LIA ref, consent"
  }
  INGEST_RUN {
    uuid id PK
    uuid source_id FK
    timestamptz started_at
    timestamptz finished_at
    jsonb stats "created, updated, skipped, quarantined, suppressed"
  }
  INGEST_RECORD {
    uuid id PK
    uuid run_id FK
    text idempotency_key UK "caller supplied, unique per source"
    text dedupe_key "caller supplied, resolves to property or contact"
    jsonb payload "raw as received, purged on short retention clock"
    text outcome "created, updated, unchanged, quarantined, suppressed, failed"
    uuid target_entity_id "resolved property or contact"
  }
  QUARANTINE_ITEM {
    uuid ingest_record_id FK
    text reason "low_confidence, contradiction, near_duplicate"
    text state "pending, accepted, rejected"
    uuid reviewed_by FK
    jsonb resolution
  }
  FIELD_PROVENANCE {
    uuid id PK
    text entity_type
    uuid entity_id
    text field_name
    uuid source_id FK
    text method "scraped, owner_submitted, staff_verified"
    numeric confidence "0 to 1"
    timestamptz collected_at
    jsonb candidate_value "losing value retained for review, null if applied"
  }
  FIELD_PRECEDENCE_RULE {
    text entity_type
    text field_name
    jsonb method_ranking "per-field override of the default order"
  }
  SUPPRESSION_ENTRY {
    uuid id PK
    text kind "email, phone, address_key, idp_subject"
    text value_hmac UK "HMAC-SHA256 with KMS-held key, no raw PII stored"
    text reason "erasure, objection"
    uuid dsr_id FK
    timestamptz created_at
  }
```

**Suppression at ingest:** the suppression list stores only keyed HMACs of normalised identifiers — it must not itself retain the PII it exists to erase. The ingest pipeline HMACs every incoming email/phone/address key and drops matches with outcome `suppressed` *before* any entity write, so an erased owner rescraped next week never rematerialises. Replay: re-posting a batch with the same idempotency keys returns the recorded outcomes without side effects.

---

## 5 · Pipelines, tasks & activity

Supply and demand are two rows in `PIPELINE`, not two schemas — stages, SLAs and routing are configuration. `PIPELINE_ITEM` is the lead; `ACTIVITY` is the single append-only timeline every module writes to (one query serves both the contact view and the property view).

```mermaid
erDiagram
  PIPELINE ||--o{ PIPELINE_STAGE : "ordered stages"
  PIPELINE ||--o{ PIPELINE_ITEM : "contains"
  PIPELINE_STAGE ||--o{ PIPELINE_ITEM : "current stage of"
  PIPELINE_ITEM ||--o{ STAGE_TRANSITION : "history"
  PIPELINE_ITEM ||--o{ TASK : "drives"
  CONTACT ||--o{ PIPELINE_ITEM : "subject of"

  PIPELINE {
    uuid id PK
    text kind "supply, demand"
    text name
  }
  PIPELINE_STAGE {
    uuid pipeline_id FK
    int position
    text name
    jsonb entry_criteria
    jsonb exit_criteria
    int sla_minutes "null means no timer"
  }
  PIPELINE_ITEM {
    uuid id PK
    uuid pipeline_id FK
    uuid stage_id FK
    uuid contact_id FK
    uuid property_id FK "nullable on demand side until matched"
    uuid assigned_to FK "staff contact, round robin or rules"
    numeric score "recomputed on signal events"
    timestamptz stage_entered_at
    timestamptz sla_due_at "BullMQ timer, escalates on breach"
    timestamptz first_response_due_at "time-to-first-response SLA"
  }
  STAGE_TRANSITION {
    uuid item_id FK
    uuid from_stage_id FK
    uuid to_stage_id FK
    uuid actor_id FK "null when rule-driven"
    text reason
    timestamptz at
  }
  TASK {
    uuid id PK
    uuid item_id FK
    uuid assignee_id FK
    text kind "call, follow_up, review"
    timestamptz due_at
    timestamptz snoozed_until
    text state "open, done, escalated, cancelled"
  }
  ACTIVITY {
    uuid id PK
    uuid contact_id FK "indexed"
    uuid property_id FK "indexed, either or both set"
    text kind "message, stage_change, viewing, score_change, note"
    jsonb payload
    uuid actor_id FK
    timestamptz occurred_at
  }
```

**Time-to-first-response:** `first_response_due_at` is stamped when an inbound inquiry creates or touches an item; the first outbound staff/agent action clears it; a BullMQ delayed job fires escalation if it survives past the SLA. It is deliberately its own column, not a generic stage SLA — the spec calls it the single most conversion-critical metric and it must survive stage reconfiguration.

**Matching** hangs off the demand side: `REQUIREMENT_PROFILE` (budget range, PostGIS multipolygon *or* postcode list, bedrooms, must-haves/deal-breakers as JSONB) and `MATCH` (profile × listing, score, state `new → alerted → dismissed | interested`, feedback captured on state change and fed back into scoring weights). Alert fan-out is an event to Notifications with per-profile frequency capping.

---

## 6 · Communications & compliance gate

Every outbound message passes a **pre-send gate** whose verdict is persisted — consent/lawful basis, suppression check, quiet hours, and whether an Article 14 disclosure must ride along. A message without a passing `COMPLIANCE_CHECK` row cannot reach a provider adapter; that is enforced in code as the only send path.

```mermaid
erDiagram
  CONVERSATION ||--o{ MESSAGE : "threads"
  CONTACT ||--o{ CONVERSATION : "party to"
  TEMPLATE ||--o{ TEMPLATE_VERSION : "versioned as"
  TEMPLATE_VERSION ||--o{ MESSAGE : "rendered from"
  MESSAGE ||--|| COMPLIANCE_CHECK : "gated by"
  SEQUENCE ||--o{ SEQUENCE_ENROLLMENT : "enrolls"
  CONTACT ||--o{ DISCLOSURE : "informed via"

  CONVERSATION {
    uuid id PK
    uuid contact_id FK
    uuid property_id FK "nullable"
    text topic
  }
  MESSAGE {
    uuid id PK
    uuid conversation_id FK
    text direction "inbound, outbound"
    text channel "email, sms, whatsapp, voice_note, in_app"
    text state "draft, gated, queued, sent, delivered, bounced, complained, failed"
    uuid template_version_id FK "null for free text"
    text provider_message_id "for inbound matching and receipts"
    timestamptz sent_at
  }
  COMPLIANCE_CHECK {
    uuid message_id PK
    boolean consent_ok
    boolean lawful_basis_ok
    boolean suppression_ok
    boolean quiet_hours_ok
    boolean art14_required "first outreach to indirectly collected contact"
    text verdict "pass, blocked"
    jsonb detail
    timestamptz checked_at
  }
  TEMPLATE {
    uuid id PK
    text key
    text category "transactional, marketing"
  }
  TEMPLATE_VERSION {
    uuid template_id FK
    int version
    text locale "fr, nl, en"
    text body "merge fields"
    timestamptz published_at
  }
  SEQUENCE {
    uuid id PK
    text name
    jsonb steps "delays, templates, channels"
    jsonb throttle "per contact and global caps, quiet hours"
  }
  SEQUENCE_ENROLLMENT {
    uuid sequence_id FK
    uuid contact_id FK
    int current_step
    text state "active, stopped_on_reply, completed, blocked_by_gate"
  }
  DISCLOSURE {
    uuid id PK
    uuid contact_id FK
    text kind "article_14"
    uuid message_id FK "proof of send"
    timestamptz delivered_at
  }
```

Inbound routing resolves `provider_message_id` / reply-to token → conversation, falling back to verified channel value → contact. Delivery, bounce, complaint and unsubscribe callbacks update `MESSAGE.state` and write channel-level suppression (a complaint hard-stops the channel, not the contact).

---

## 7 · Appointments, access & post-visit

Booking is a three-way availability intersection — viewer, agent, **and property access** — resolved against Postgres range types with GiST exclusion constraints, so a double-booking is impossible at the database layer, not just the application layer:

```sql
ALTER TABLE appointment ADD CONSTRAINT no_agent_overlap
  EXCLUDE USING gist (agent_id WITH =, during WITH &&)
  WHERE (state IN ('booked','confirmed','in_progress'));
-- same shape for property_id; slot_holds join the constraint while unexpired
```

`during` includes the agent's travel buffer. Minimum notice for tenanted properties is validated in the property's timezone at slot-generation *and* at booking (the rule may have changed between the two).

```mermaid
erDiagram
  PROPERTY ||--o| PROPERTY_ACCESS_RULE : "access governed by"
  PROPERTY ||--o{ SLOT_HOLD : "tentatively reserved"
  SLOT_HOLD ||--o| APPOINTMENT : "converts to"
  APPOINTMENT ||--o{ ATTENDANCE_PROOF : "evidenced by"
  APPOINTMENT ||--o{ APPOINTMENT_FEEDBACK : "reviewed in"
  APPOINTMENT ||--o| VIEWING_OUTCOME : "concludes as"
  APPOINTMENT ||--o{ WAITLIST_ENTRY : "open house waitlist"

  PROPERTY_ACCESS_RULE {
    uuid property_id PK
    text occupancy "vacant, owner_occupied, tenanted"
    int min_notice_hours "enforced for tenanted"
    uuid key_holder_contact_id FK
    text lockbox_ref "encrypted"
    jsonb blackout_windows
  }
  SLOT_HOLD {
    uuid id PK
    uuid property_id FK
    uuid viewer_contact_id FK
    tstzrange during
    timestamptz expires_at "TTL, BullMQ auto-release"
    text state "held, converted, released, expired"
  }
  APPOINTMENT {
    uuid id PK
    uuid property_id FK
    uuid viewer_contact_id FK
    uuid agent_id FK "null until dispatch claims"
    tstzrange during "includes travel buffer"
    text kind "private, open_house"
    int capacity "open house only"
    text state "see appointment machine"
    text cancellation_policy_snapshot
  }
  ATTENDANCE_PROOF {
    uuid appointment_id FK
    text party "agent, viewer"
    text method "geofence, one_time_code"
    text direction "check_in, check_out"
    jsonb evidence
    timestamptz at
  }
  APPOINTMENT_FEEDBACK {
    uuid appointment_id FK
    text author_role "agent, viewer"
    jsonb structured "condition, price_opinion, interest_level"
    boolean shared_with_owner "feeds owner digest"
  }
  VIEWING_OUTCOME {
    uuid appointment_id PK
    text outcome "interested, offer_intent, rejected, no_show_viewer, no_show_agent"
    uuid routed_pipeline_item_id FK "back into demand pipeline"
  }
  WAITLIST_ENTRY {
    uuid appointment_id FK
    uuid contact_id FK
    int position
  }
```

Reminders (T-24h, T-2h) are scheduler jobs per appointment per party; calendar integration is an outbound iCal feed (token per agent) plus optional two-way Google/Outlook sync via a `CALENDAR_LINK` row holding provider sync cursors.

---

## 8 · Agent registry

```mermaid
erDiagram
  CONTACT ||--o| AGENT_PROFILE : "professional identity"
  AGENT_PROFILE ||--o{ AGENT_DOCUMENT : "licensed and insured by"
  AGENT_PROFILE ||--o{ COVERAGE_AREA : "works in"
  AGENT_PROFILE ||--o{ AGENT_ABSENCE : "unavailable during"
  AGENT_PROFILE ||--o{ TERMS_ACCEPTANCE : "accepted"
  TERMS_VERSION ||--o{ TERMS_ACCEPTANCE : "of version"

  AGENT_PROFILE {
    uuid contact_id PK
    text state "see agent status machine"
    text licence_number
    date licence_expires_at "auto-suspend on lapse"
    date insurance_expires_at "auto-suspend on lapse"
    text_array languages
    text_array specialisms "residential, commercial, land"
    int capacity_max_active
    jsonb working_hours "per weekday, agent timezone"
    jsonb commission_terms "current, versioned via terms acceptance"
  }
  AGENT_DOCUMENT {
    uuid agent_id FK
    text kind "licence, insurance, id_document"
    text storage_key
    date expires_at
    text verification_state "pending, verified, rejected, lapsed"
    uuid verified_by FK
  }
  COVERAGE_AREA {
    uuid agent_id FK
    geography area "polygon or point plus radius"
    text_array postcodes "alternative to polygon"
  }
  AGENT_ABSENCE {
    uuid agent_id FK
    tstzrange during
    text reason
  }
  TERMS_VERSION {
    uuid id PK
    int version
    text locale
    text body
    timestamptz effective_from
  }
  TERMS_ACCEPTANCE {
    uuid agent_id FK
    uuid terms_version_id FK
    timestamptz accepted_at
    inet ip
    text device_fingerprint
  }
```

The **scorecard** (claim rate, punctuality from attendance proofs, no-show rate, feedback average) is a materialised view refreshed on a schedule — derived, never hand-edited, and it feeds directly into dispatch ranking. A nightly job plus a document-write trigger flips agents to `suspended` the moment a licence or insurance document lapses; suspension removes them from dispatch candidacy atomically with the state change.

---

## 9 · Dispatch, claim & attribution

The heart of the system. One `DISPATCH` per appointment needing an agent; candidates are ranked and offered per the configured strategy; **the claim is a single conditional UPDATE** — the winner is whoever's transaction flips the row:

```sql
UPDATE dispatch
   SET state = 'claimed', winning_offer_id = :offer_id, claimed_at = now()
 WHERE id = :dispatch_id
   AND state = 'offering'
   AND winning_offer_id IS NULL;
```

Row count 1 → winner: same transaction marks the offer `claimed`, sibling offers `withdrawn`, creates the `ASSIGNMENT_AGREEMENT`, the purpose-bound `ACCESS_GRANT` (§11), and the outbox event. Row count 0 → if `winning_offer_id = :offer_id` it's an idempotent replay (return success), otherwise a clean `409 already_claimed`. Claims are **online-only**: the claim endpoint rejects any request bearing the offline-queue idempotency header, and claims are excluded from the client sync contract. This exact race is covered by the mandated concurrency test (parallel claimers, exactly one winner).

```mermaid
erDiagram
  APPOINTMENT ||--o| DISPATCH : "needs agent via"
  DISPATCH ||--o{ DISPATCH_CANDIDATE : "considered"
  DISPATCH ||--o{ DISPATCH_OFFER : "offered to"
  AGENT_PROFILE ||--o{ DISPATCH_OFFER : "receives"
  DISPATCH_OFFER ||--o| ASSIGNMENT_AGREEMENT : "claim creates"
  ASSIGNMENT_AGREEMENT ||--o| ATTRIBUTION : "grants"
  ATTRIBUTION ||--o{ DISPUTE : "contested via"
  ATTRIBUTION ||--o| COMMISSION_STATEMENT : "pays out via"

  DISPATCH {
    uuid id PK
    uuid appointment_id FK
    text strategy "waterfall, broadcast, hybrid"
    jsonb config_snapshot "radius, ttl, rounds at dispatch time"
    text state "pending, offering, claimed, escalated, no_agent, cancelled"
    uuid winning_offer_id FK "null until claimed, the atomic guard"
    timestamptz claimed_at
  }
  DISPATCH_CANDIDATE {
    uuid dispatch_id FK
    uuid agent_id FK
    int rank
    jsonb score_components "distance, load, rating, language, fairness — Art 22 explainability"
    text excluded_reason "null if offered"
  }
  DISPATCH_OFFER {
    uuid id PK
    uuid dispatch_id FK
    uuid agent_id FK
    text state "see offer machine"
    timestamptz ttl_expires_at "BullMQ expiry job"
    timestamptz responded_at
  }
  ASSIGNMENT_AGREEMENT {
    uuid id PK
    uuid offer_id FK
    uuid agent_id FK
    uuid appointment_id FK
    jsonb terms_snapshot "commission terms frozen at claim"
    uuid terms_version_id FK
    timestamptz accepted_at
    inet ip
    text device_fingerprint
    timestamptz exclusivity_ends_at "default showing date plus 30 days"
  }
  LEAD_TOUCH {
    uuid id PK
    uuid agent_id FK
    uuid buyer_contact_id FK
    uuid property_id FK
    text kind "showing, call, message, offer_assist"
    timestamptz at "snapshot for future split policies"
  }
  ATTRIBUTION {
    uuid id PK
    uuid agreement_id FK
    uuid buyer_contact_id FK
    uuid property_id FK
    text state "active, converted, expired, disputed, revoked"
    timestamptz window_ends_at
  }
  DISPUTE {
    uuid attribution_id FK
    uuid raised_by FK
    jsonb evidence
    text state "open, under_review, resolved"
    jsonb resolution
    uuid resolved_by FK
  }
  COMMISSION_STATEMENT {
    uuid attribution_id FK
    numeric deal_value
    jsonb rate_snapshot
    numeric amount
    char3 currency
    text state "draft, issued, settled_externally"
  }
```

**Escalation ladder** (state `escalated`, loops back to `offering` with widened parameters): no claim → widen radius → relax criteria (language, specialism) → alert ops → `no_agent` fallback (staff-assigned or viewer notified). Every rung is recorded; `DISPATCH_CANDIDATE.score_components` is retained for the Article 22 explanation path and the ops board's manual override writes the same audit trail.

**Attribution policy (locked):** sole credit within `exclusivity_ends_at`; `LEAD_TOUCH` records every agent interaction anyway, so a future split policy is a new calculator over existing data, not a migration.

---

## 10 · Notifications

Delivery is never assumed. Time-critical categories (dispatch offers) require a **client ACK**; a missing ACK within the per-step timer escalates down the fallback chain push → SMS → email. Tray accept/decline actions hit the same claim endpoint with the same atomicity.

```mermaid
erDiagram
  CONTACT ||--o{ DEVICE : "registered"
  CONTACT ||--o{ NOTIFICATION : "receives"
  NOTIFICATION ||--o{ DELIVERY_ATTEMPT : "attempted via"
  DEVICE ||--o{ DELIVERY_ATTEMPT : "targeted"
  CONTACT ||--o{ NOTIFICATION_PREFERENCE : "controls"

  DEVICE {
    uuid id PK
    uuid contact_id FK
    text push_token
    text platform "ios, android, web"
    text app_version
    text locale
    text os_permission_state
    timestamptz last_seen_at
    text state "active, pruned"
  }
  NOTIFICATION {
    uuid id PK
    uuid contact_id FK
    text category "transactional, marketing"
    text priority "critical_ack, high, normal, digest"
    text kind "dispatch_offer, reminder, alert, marketing"
    jsonb payload
    timestamptz acknowledged_at "client ACK, null triggers fallback"
    text state "pending, delivering, acked, exhausted, dead_letter"
  }
  DELIVERY_ATTEMPT {
    uuid notification_id FK
    int step "position in fallback chain"
    text channel "push, sms, email"
    uuid device_id FK "push only"
    text state "queued, sent, delivered, failed, bounced"
    text provider_message_id
    timestamptz next_escalation_at "per-step ACK timer"
  }
  FALLBACK_POLICY {
    text category PK
    jsonb chain "ordered channels with per-step timers"
    boolean requires_ack
    boolean respects_quiet_hours "false for critical"
  }
  NOTIFICATION_PREFERENCE {
    uuid contact_id FK
    text channel
    text category
    uuid device_id FK "nullable, per-device override"
    boolean opted_out "marketing only, transactional not suppressible"
  }
```

Provider failure responses (`Unregistered`, `BadDeviceToken`) prune tokens automatically. Quiet hours apply to non-urgent categories only, evaluated in the *recipient's* timezone. Retries use exponential backoff; exhausted chains land in `dead_letter` state surfaced on the ops board.

---

## 11 · Access control, audit & security

```mermaid
erDiagram
  CONTACT ||--o{ ROLE_BINDING : "authorised via"
  CONTACT ||--o{ ACCESS_GRANT : "subject of"
  AGENT_PROFILE ||--o{ ACCESS_GRANT : "granted to"
  CONTACT ||--o{ PII_ACCESS_LOG : "reads and writes logged"

  ROLE_BINDING {
    uuid contact_id FK
    text role "staff_admin, staff_ops, agent, owner, viewer"
    jsonb scope "org or team restriction"
  }
  ACCESS_GRANT {
    uuid id PK
    uuid grantee_agent_id FK
    uuid subject_contact_id FK
    uuid appointment_id FK
    text purpose "claimed_showing"
    tstzrange window "appointment window plus configured buffer"
    timestamptz revoked_at "job-enforced at window end"
  }
  PII_ACCESS_LOG {
    bigint seq PK "append-only, monthly partitions, insert-only role"
    uuid actor_id
    uuid subject_contact_id
    text entity_field "e.g. contact_channel.value"
    text action "read, reveal, write, export"
    text reason "required for reveal-on-click"
    jsonb request_context "route, ip, session"
    timestamptz at
  }
  EXPORT_REQUEST {
    uuid id PK
    uuid requested_by FK
    jsonb criteria
    text state "pending_approval, approved, rejected, delivered"
    uuid approved_by FK
    text watermark_id "embedded in the export"
  }
  RECOVERY_REQUEST {
    uuid id PK
    uuid contact_id FK
    text state "open, first_approved, approved, rejected, completed"
    uuid first_approver FK
    uuid second_approver FK "dual staff approval"
    timestamptz payout_change_unlocked_at "cooldown after completion"
  }
  STEP_UP_POLICY {
    text action PK "payout_change, contract_accept, bulk_export, first_claim"
    text required_acr "Keycloak ACR level demanded"
    int max_age_seconds
  }
```

**Purpose-bound temporal grants:** claiming a showing creates an `ACCESS_GRANT` scoped to that viewer, that appointment, that window. Outside a live grant, agents see masked contact details (`j***@***.com`); reveal-on-click requires a reason and writes a `reveal` row to `PII_ACCESS_LOG`. The log is insert-only at the Postgres-role level — the application user has no UPDATE/DELETE on those partitions — and records **reads as well as writes**. Step-up enforcement is delegated to Keycloak ACR: the API checks the token's ACR/auth-age against `STEP_UP_POLICY` and returns a `step_up_required` challenge.

---

## 12 · Privacy & GDPR

Two clusters: *basis & consent* (why we may process) and *rights & retention* (what the subject may demand and when data dies).

```mermaid
erDiagram
  PROCESSING_ACTIVITY ||--o{ LAWFUL_BASIS_RECORD : "applied as"
  CONSENT_WORDING ||--o{ CONSENT : "granted against"
  CONTACT ||--o{ CONSENT : "gave"
  CONTACT ||--o{ DSR : "exercises rights via"
  DSR ||--o{ ERASURE_PROPAGATION : "propagates via"
  RETENTION_POLICY ||--o{ PURGE_LOG : "executed as"

  PROCESSING_ACTIVITY {
    uuid id PK
    text name "Art 30 register entry"
    text purpose
    text lawful_basis "consent, contract, legitimate_interest"
    text lia_document_ref "required for legitimate interest"
    text_array data_categories
    uuid retention_policy_id FK
  }
  LAWFUL_BASIS_RECORD {
    uuid activity_id FK
    text entity_type
    uuid entity_id
    timestamptz established_at
  }
  CONSENT_WORDING {
    uuid id PK
    int version
    text locale
    text exact_text "the wording actually shown"
  }
  CONSENT {
    uuid contact_id FK
    uuid wording_id FK
    text purpose
    timestamptz granted_at
    timestamptz withdrawn_at
    jsonb proof "channel, ip, ui context"
  }
  DSR {
    uuid id PK
    uuid contact_id FK
    text kind "access, rectification, erasure, restriction, portability, objection"
    timestamptz received_at
    timestamptz due_at "received plus one month, escalation before breach"
    text state "received, identity_check, in_progress, escalated, completed, refused"
    jsonb completion_audit
  }
  ERASURE_PROPAGATION {
    uuid dsr_id FK
    text target "keycloak, suppression_list, analytics_store, scraper_feedback"
    text state "pending, confirmed, failed"
    timestamptz confirmed_at
  }
  RETENTION_POLICY {
    uuid id PK
    text data_category
    interval period "short for unregistered scraped leads"
    text trigger "last_activity, lifecycle_state_change"
  }
  BREACH_INCIDENT {
    uuid id PK
    timestamptz detected_at
    timestamptz notify_deadline_at "detected plus 72h"
    text state "triage, assessing, notified_dpa, notified_subjects, closed"
    jsonb timeline
  }
  PROCESSOR {
    uuid id PK
    text vendor
    text role "processor, sub_processor"
    text dpa_status
    text transfer_mechanism "SCC, adequacy, none_required"
  }
```

**Erasure** is a pipeline, not a delete: pseudonymise the contact row, destroy the per-subject DEK (crypto-shredding — §13), write suppression HMACs, propagate to Keycloak (admin API delete) and the analytics store, and record each confirmation on `ERASURE_PROPAGATION`. **Restriction** sets `processing_restricted`, which the pipeline engine, matcher, sequencer and dispatcher all check — the record is held but inert. Retention clocks run per category via nightly scheduler with a `PURGE_LOG` of what was destroyed and under which policy.

---

## 13 · Platform: outbox, sync, idempotency

```mermaid
erDiagram
  OUTBOX_EVENT ||--o{ WEBHOOK_DELIVERY : "fanned out as"
  WEBHOOK_SUBSCRIPTION ||--o{ WEBHOOK_DELIVERY : "delivers to"

  OUTBOX_EVENT {
    bigint seq PK "monotonic, the delta-sync and webhook cursor"
    text aggregate_type
    uuid aggregate_id
    text event_type "listing.updated, dispatch.claimed, ..."
    jsonb payload "written in the same tx as the domain change"
    timestamptz published_at "null until relay picks it up"
  }
  WEBHOOK_SUBSCRIPTION {
    uuid id PK
    text consumer "client_team"
    text url
    text_array event_types
    text secret_ref "HMAC signing"
  }
  IDEMPOTENCY_KEY {
    text key PK "client supplied"
    uuid actor_id
    text request_hash "409 on same key, different payload"
    jsonb stored_response
    timestamptz expires_at
  }
  TOMBSTONE {
    text entity_type
    uuid entity_id
    bigint sync_seq "so deletions appear in updated_since"
    timestamptz deleted_at
  }
  APP_VERSION_GATE {
    text platform PK "ios, android, web"
    text min_version "hard block below this"
    text warn_below "soft nag below this"
    text message_key "server-driven copy"
  }
  FEATURE_FLAG {
    text key PK
    jsonb value "dispatch parameters retunable without release"
    jsonb audience "percentage, role, platform"
  }
```

- **Delta sync:** `GET /sync?updated_since=<seq>` returns changed rows + tombstones ordered by `sync_seq` (a global sequence stamped by trigger — no clock-skew ambiguity), with ETag support on single resources.
- **Offline writes:** accepted with client idempotency keys; server-authoritative on anything with a state machine, last-write-wins only on free text. **Claims are excluded** — online-only by contract.
- **Crypto-shredding & backups:** direct identifiers are envelope-encrypted with a per-subject DEK (`CONTACT.dek_id`) wrapped by KMS. Erasure destroys the DEK, which renders those fields unreadable in every backup as well — this is how backup/restore stays consistent with erasure without rewriting backup archives. Restores replay the suppression list before going live.
- **Media:** resumable uploads (tus-style) to object storage, server-side thumbnailing, EXIF stripped on ingest; deep links + `apple-app-site-association` / `assetlinks.json` served from platform config.

---

## 14 · State machines

### Listing lifecycle

```mermaid
stateDiagram-v2
  [*] --> discovered : scraper ingest
  discovered --> contact_attempted : supply pipeline outreach
  contact_attempted --> owner_reached : reply or inbound
  owner_reached --> verified : owner confirms details
  verified --> live : published
  live --> under_offer : offer accepted
  under_offer --> live : offer fell through
  under_offer --> sold : sale completed
  under_offer --> let : tenancy signed
  live --> withdrawn : owner withdraws
  live --> expired : mandate or listing lapsed
  discovered --> expired : retention clock, never reached
  contact_attempted --> withdrawn : owner objects
  sold --> [*]
  let --> [*]
  withdrawn --> [*]
  expired --> [*]
```

Transitions are guarded (e.g. `verified → live` requires an owner-confirmed price and at least one rights-cleared media asset for self-serve owners; staff can override with a recorded reason). Every transition writes `LISTING_CHANGE` + `ACTIVITY` + an outbox event; `live` triggers match evaluation.

### Dispatch offer

```mermaid
stateDiagram-v2
  [*] --> created : candidate selected
  created --> sent : notification dispatched
  sent --> seen : client open receipt
  sent --> claimed : atomic claim wins
  seen --> claimed : atomic claim wins
  sent --> declined : agent declines
  seen --> declined : agent declines
  sent --> expired : TTL lapses
  seen --> expired : TTL lapses
  created --> withdrawn : dispatch cancelled early
  sent --> withdrawn : another offer claimed
  seen --> withdrawn : another offer claimed
  claimed --> [*]
  declined --> [*]
  expired --> [*]
  withdrawn --> [*]
```

The parent `DISPATCH` machine: `pending → offering → claimed`, with `offering → escalated → offering` loops per the ladder (widen radius → relax criteria → alert ops), terminal `no_agent` fallback, and `cancelled` from any non-terminal state. Agent cancellation or no-show after claim re-opens a fresh dispatch automatically.

### Appointment

```mermaid
stateDiagram-v2
  [*] --> requested : viewer picks slot
  requested --> hold_placed : slot hold with TTL
  hold_placed --> requested : hold expired, repick
  hold_placed --> dispatching : dispatch created
  dispatching --> booked : claim succeeded
  dispatching --> unstaffed : no agent found
  unstaffed --> dispatching : staff intervention
  booked --> confirmed : all parties reminded and confirmed
  confirmed --> in_progress : agent check-in proof
  in_progress --> completed : check-out proof
  completed --> outcome_captured : feedback and outcome recorded
  booked --> cancelled : with notice policy applied
  confirmed --> cancelled : with notice policy applied
  confirmed --> no_show : either party absent
  booked --> rescheduled : new slot requested
  rescheduled --> hold_placed : re-enter hold flow
  no_show --> [*] : recorded on scorecard or viewer reliability
  cancelled --> [*]
  outcome_captured --> [*] : routed to demand pipeline
```

`cancelled` and `no_show` carry a `by_party` attribute (viewer / agent / staff) rather than being separate states — the penalty and scorecard logic branch on it, the lifecycle does not.

### Agent status

```mermaid
stateDiagram-v2
  [*] --> invited : staff or self signup
  invited --> onboarding : documents uploading
  onboarding --> pending_review : all documents submitted
  pending_review --> active : staff approval plus terms accepted
  pending_review --> rejected : failed verification
  active --> suspended : auto on licence or insurance lapse
  active --> suspended : manual, conduct or dispute
  suspended --> active : document renewed or reinstated
  active --> offboarded : agent leaves platform
  suspended --> offboarded : not remediated
  rejected --> [*]
  offboarded --> [*]
```

`suspended` carries a `reason` (`doc_lapse_auto`, `manual`) — auto-suspension is reversed automatically when a renewed document is verified; manual suspension requires staff action. Suspension in any form removes dispatch eligibility in the same transaction.

---

## 15 · Flagged risks (per working rules)

1. **Cold outreach to scraped contacts — legal risk, build accordingly.** ePrivacy rules in BE/FR/NL treat unsolicited email/SMS to individuals as requiring prior consent; phone has per-country opposition lists (Bloctel, Ne m'appelez plus). The sequencer therefore ships with a per-country **channel policy table that defaults to BLOCK** for electronic channels to non-consented contacts; unblocking a channel per country is a deliberate config change to be made only on legal advice. The compliance gate makes this enforceable, but the go/no-go itself needs counsel — not engineering.
2. **Agents as controllers (Art 26).** Once an agent receives owner/viewer contact details for a claimed showing they likely become an independent or joint controller. The schema is ready (versioned `TERMS_VERSION` can carry an Art 26 arrangement or C2C data-sharing terms, acceptance is evidenced), but the legal instrument must exist before launch.
3. **Legitimate interest for scraping.** The LIA reference is a required field on any `PROCESSING_ACTIVITY` with basis `legitimate_interest`, Art 14 disclosure is enforced by the pre-send gate, and unregistered-lead retention is deliberately short — but this processing pattern attracts DPA attention; the LIA should be written by counsel, not summarised by us.
4. **Backups vs erasure.** Solved by crypto-shredding (destroying the per-subject DEK makes identifier fields unreadable in all backups) plus suppression-list replay on restore. Trade-off to acknowledge: non-encrypted attributes (e.g. a free-text note containing a name) survive in old backups — mitigated by short backup retention and note-field hygiene rules.
5. **Geocoding dependency.** The canonical property key is derived from normalised address text, *not* geocoder output, so we are not hostage to geocoder versioning. But the geocoder is a processor receiving personal data (owner-linked addresses) — it must be an EU-hosted provider or on an SCC, and it goes in the `PROCESSOR` register from day one.

---

## 16 · What approval unlocks

Deliverable 2 (migration set with indexes justified against dispatch ranking + availability hot paths), then module implementation in the mandated order, each with tests before the next: contacts → properties/ingest → pipelines → appointments → agents → dispatch → notifications → privacy/audit → reporting.

**Points I'd most value review on:** (a) listing-as-episode vs. lifecycle-on-property, (b) the provenance resolver with parked `candidate_value` losers, (c) suppression as keyed HMACs, (d) `cancelled`/`no_show` as states with a `by_party` attribute rather than a state per party, and (e) crypto-shredding as the backup-consistency mechanism.

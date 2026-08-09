# CRM response — client reconciliation of 2026-08-09

Response to the client team's reconciliation document. Contract changes shipped
as **crm-v1.yaml 1.1.0** (see [api/README.md changelog](../api/README.md#changelog)).
Item numbers follow the client doc.

## §2 EPC enum — closed, with one correction

Closed as requested, **but to the nine-value Belgian superset**
`A++ | A+ | A | B | C | D | E | F | G` (+ null), not A–G: Flemish, Brussels and
Walloon EPC scales legitimately include A+ / A++, and this platform is FR/NL/EN.
Your EPC bar can either render nine positions or map A++/A+ onto the A cell —
either way the value space is now guaranteed. Ingest normalises raw source
labels into this set; anything unparseable arrives as `null` and the raw value
is parked for staff review (never force-cast). The "seven grades" assumption
was the only wrong premise in the doc — good instinct flagging instead of
assuming.

## §3.1 Portfolio — accepted as CRM scope

Accepted exactly per your scope table and developer prompt: module
`src/modules/portfolio/`, migration group 110, `portfolio_entry` with
investor-entered figures only, valuation derived (never stored on the entry,
never client-supplied), `portfolio.valuation_updated` only on actual change,
no PII-access logging (investor's own data). Tracked as task #29, blocked only
by the properties module which is in progress now.

Contract shipped in 1.1.0 with two small extensions to your proposal:
- `PATCH /me/portfolio/{propertyId}` — figures and status will change
  (watching → offer_made → owned); delete-and-recreate would lose `added_at`.
- `status` accepted on create (defaults `watching`) — an investor adding a
  property they already own shouldn't have to create-then-patch.
- `POST` returns `409 portfolio_duplicate` for an already-tracked property.

**Valuation methodology — decided** (Sophia, 2026-08-09): adaptive radius.
Comps are same `property_kind`, ±30% floor area, starting 2 km and expanding
to 5 km only if under the minimum; live + sold/let within 12 months; minimum
5 comps or **no estimate** (absent, per the contract). Estimate = median €/m²
× subject area; yield = median comparable rent × 12 / price. The same
estimator feeds `estimated_rental_yield_percent` on listings, so both fields
go live together.

## §3.2 Listing fields — all three added

- `property_kind` (CLOSED: house/apartment/land/commercial/other) — this was
  always in the domain model (`property.kind`); not surfacing it on the listing
  DTO was an oversight. Do **not** dig in `features` for it.
- `occupancy` (OPEN, nullable) — surfaced from property access rules
  (vacant/owner_occupied/tenanted); null when the CRM doesn't know yet, which
  for scraped listings is common until owner contact.
- `estimated_rental_yield_percent` (nullable) — in the contract now so your
  UI can bind to it; the value stays null until the valuation estimator ships
  (same methodology decision as portfolio). **Filter params:** `property_kind`
  and `occupancy` are live in `GET /listings`; a `yield_min` param is
  deliberately NOT added until the estimator exists — a filter the server
  silently ignores is worse than one that isn't there.

## §3.3 Free-text location search — CRM will not geocode queries

Recommendation: keep the CRM contract as geo/postcodes and put a
city-name → coordinates step client-side using a geocoding service, OR switch
the UI to postcode/area entry. Rationale: query-time geocoding of arbitrary
user text is a UX concern (autocomplete, disambiguation of "Ixelles" vs
"Elsene") that belongs next to the input field, and routing every keystroke
through the CRM would add a sub-processor obligation on the CRM side for no
data-model benefit. If you want a shared geocoder key/config, raise it as an
ops question, not a contract one.

## §3.4 Availability browsing — you were right, endpoint added

Browse-then-hold was always the intended UX (the CRM spec has had "bookable
slot generation with blackout windows" since the domain model); the contract
simply lacked the read endpoint — an oversight, now fixed:
`GET /v1/listings/{listingId}/viewing-slots?from&to` returns open slots
generated from access rules in the property's timezone. Contract note worth
designing for: slots are availability, not reservations — a hold on a listed
slot can still `409 slot_conflict` if another viewer wins the race, so keep
your retry-with-next-slot path from the blind-propose design.

## §1 note — Money as float

Normalising `Money.amount` to a JS number at your boundary is your call for
display, but flag it on your side for anything the user re-submits: a value
that round-trips client → CRM (portfolio figures) goes through the decimal-
string `Money` shape, and `"1234.10"` → `1234.1` → `"1234.1"` is fine, but
float arithmetic on amounts before re-submission can produce `"1234.0999..."`
strings the CRM will reject at validation. Compute display totals in floats if
you like; echo back the original strings on writes.

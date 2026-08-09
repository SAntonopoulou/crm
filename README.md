# Property Platform — CRM

The CRM service for the property listing platform: domain model, business logic, and the APIs consumed by the scraper and the web/Flutter clients.

## Status

Design phase. Deliverable 1 is up for review:

- **[Domain model & ERD](docs/domain-model.md)** — module map, per-module ERDs, the listing / dispatch-offer / appointment / agent-status state machines, cross-cutting mechanics (provenance, atomic claim, suppression, crypto-shredding), and flagged legal/architectural risks.

Implementation (migrations → modules → OpenAPI → events → tests → runbook) starts once the model is approved.

## Locked decisions

| Decision | Choice |
|---|---|
| Stack | TypeScript / NestJS · PostgreSQL + PostGIS · Redis + BullMQ |
| Identity provider | Keycloak (CRM stores only the opaque subject ID) |
| Exclusivity & attribution | Exclusive window, sole credit (touches snapshotted for future split policies) |
| Operating model | Hybrid — staff-mediated until owner verification, then self-serve |

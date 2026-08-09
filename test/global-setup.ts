import 'dotenv/config';
import { Pool } from 'pg';

/**
 * The dev database persists between suite runs; geographic fixtures from a
 * previous run would otherwise bleed into this run's candidate rings and
 * comp radii. Truncate all volatile domain tables so every run starts like
 * CI does: empty. Seeded configuration (pipelines, stages, terms versions)
 * and the append-only audit log are deliberately left alone.
 */
export default async function globalSetup(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`
    TRUNCATE
      core.outbox_event, core.idempotency_key, core.tombstone,
      core.field_provenance, core.field_precedence_rule,
      core.contact_merge, core.contact_relationship, core.org_membership,
      core.organisation, core.contact_sensitive, core.contact_channel,
      core.contact_role,
      core.ingest_record, core.quarantine_item, core.ingest_run, core.source,
      core.suppression_entry,
      core.listing_change, core.media_asset, core.property_document,
      core.property_party, core.portfolio_entry,
      core.match, core.requirement_profile,
      core.activity, core.task, core.stage_transition, core.pipeline_item,
      core.attendance_proof, core.appointment_feedback, core.viewing_outcome,
      core.waitlist_entry, core.slot_hold,
      core.access_grant, core.commission_statement, core.dispute,
      core.attribution, core.lead_touch, core.assignment_agreement,
      core.dispatch_offer, core.dispatch_candidate, core.dispatch,
      core.appointment, core.property_access_rule,
      core.terms_acceptance, core.agent_absence, core.coverage_area,
      core.agent_document, core.agent_profile,
      core.listing, core.property, core.contact
    CASCADE
  `);
  await pool.end();
}

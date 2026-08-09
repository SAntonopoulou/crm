import { createHash } from 'node:crypto';
import {
  ConflictException,
  GoneException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Db } from '../../shared/database/db.service';
import { ProvenanceMethod } from '../../shared/provenance/provenance-resolver';
import { ContactsService, normaliseChannelValue } from '../contacts/contacts.service';
import { addressComplete, canonicalKey, normaliseAddress } from './normalise';
import { PropertiesService, PropertyPayload } from './properties.service';
import { SuppressionService, SuppressionKind } from './suppression.service';

export interface IngestRecordInput {
  idempotency_key: string;
  dedupe_key?: string;
  kind: 'property_listing' | 'owner_contact' | 'combined';
  payload: {
    property?: PropertyPayload;
    contact?: {
      display_name?: string;
      emails?: string[];
      phones?: string[];
      role_hint?: 'owner' | 'agent_of_owner' | 'unknown';
    };
  };
  provenance: {
    field?: string;
    collected_at: string;
    method: 'scraped' | 'owner_submitted';
    confidence?: number;
  }[];
}

export interface IngestBatchInput {
  source: { name: string; kind: 'portal_scrape' | 'owner_submission'; run_reference?: string };
  records: IngestRecordInput[];
}

type Outcome = 'created' | 'updated' | 'unchanged' | 'quarantined' | 'suppressed' | 'failed';

const MAX_BATCH = 500;
const QUARANTINE_CONFIDENCE = 0.3;

@Injectable()
export class IngestService {
  constructor(
    private readonly db: Db,
    private readonly properties: PropertiesService,
    private readonly contacts: ContactsService,
    private readonly suppression: SuppressionService,
  ) {}

  async processBatch(
    batch: IngestBatchInput,
    idempotencyKey: string,
  ): Promise<{ batch_id: string; status: string; replayed: boolean }> {
    if (!batch?.source?.name || !Array.isArray(batch.records)) {
      throw new UnprocessableEntityException({ code: 'invalid_batch' });
    }
    if (batch.records.length > MAX_BATCH) {
      throw new UnprocessableEntityException({ code: 'batch_too_large', max: MAX_BATCH });
    }

    const requestHash = createHash('sha256')
      .update(JSON.stringify(batch))
      .digest('hex');

    const source = await this.findOrCreateSource(batch.source);
    if (!source.enabled) {
      throw new UnprocessableEntityException({ code: 'source_disabled' });
    }

    const existing = await this.db.kysely
      .selectFrom('core.ingest_run')
      .select(['id', 'status', 'request_hash'])
      .where('source_id', '=', source.id)
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();
    if (existing) {
      if (existing.request_hash !== requestHash) {
        throw new ConflictException({ code: 'idempotency_key_reuse' });
      }
      return { batch_id: existing.id, status: existing.status, replayed: true };
    }

    const run = await this.db.kysely
      .insertInto('core.ingest_run')
      .values({
        source_id: source.id,
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
      })
      .returning('id')
      .executeTakeFirstOrThrow();

    const stats: Record<Outcome, number> = {
      created: 0, updated: 0, unchanged: 0, quarantined: 0, suppressed: 0, failed: 0,
    };
    for (const record of batch.records) {
      const outcome = await this.processRecord(run.id, source, record);
      stats[outcome]++;
    }

    await this.db.tx(async (ctx) => {
      await ctx.trx
        .updateTable('core.ingest_run')
        .set({
          status: 'completed',
          stats: JSON.stringify(stats),
          finished_at: new Date(),
        })
        .where('id', '=', run.id)
        .execute();
      await ctx.emit({
        aggregateType: 'ingest_run',
        aggregateId: run.id,
        eventType: 'ingest.batch_completed',
        payload: { stats },
      });
    });

    return { batch_id: run.id, status: 'completed', replayed: false };
  }

  /** One record; failures are individual, never batch-fatal. */
  private async processRecord(
    runId: string,
    source: { id: string; kind: string },
    record: IngestRecordInput,
  ): Promise<Outcome> {
    // Record-level replay: a reused record key returns its recorded outcome
    // without side effects (contract guarantee 1).
    const prior = await this.db.kysely
      .selectFrom('core.ingest_record')
      .select('outcome')
      .where('source_id', '=', source.id)
      .where('idempotency_key', '=', record.idempotency_key)
      .executeTakeFirst();
    if (prior?.outcome) {
      await this.copyRecordToRun(runId, source.id, record.idempotency_key);
      return prior.outcome as Outcome;
    }

    try {
      return await this.processFresh(runId, source, record);
    } catch (err) {
      await this.writeRecord(runId, source.id, record, 'failed', {
        problem_code: 'processing_error',
        payload: record.payload,
      });
      return 'failed';
    }
  }

  private async processFresh(
    runId: string,
    source: { id: string; kind: string },
    record: IngestRecordInput,
  ): Promise<Outcome> {
    const wantsProperty = record.kind !== 'owner_contact';
    const wantsContact = record.kind !== 'property_listing';
    if (
      !record.idempotency_key ||
      (wantsProperty && !record.payload?.property?.address?.country) ||
      (wantsContact && !record.payload?.contact) ||
      !record.provenance?.length
    ) {
      await this.writeRecord(runId, source.id, record, 'failed', {
        problem_code: 'invalid_payload',
        payload: record.payload,
      });
      return 'failed';
    }

    // Suppression precedes every entity write (contract guarantee 2). The
    // record row for a suppressed subject stores NO payload.
    const suppressionChecks: { kind: SuppressionKind; value: string }[] = [];
    for (const email of record.payload.contact?.emails ?? []) {
      suppressionChecks.push({ kind: 'email', value: normaliseChannelValue('email', email) });
    }
    for (const phone of record.payload.contact?.phones ?? []) {
      suppressionChecks.push({ kind: 'phone', value: normaliseChannelValue('phone', phone) });
    }
    if (record.payload.property?.address) {
      suppressionChecks.push({
        kind: 'address_key',
        value: canonicalKey(normaliseAddress(record.payload.property.address)),
      });
    }
    if (await this.suppression.anySuppressed(suppressionChecks)) {
      await this.writeRecord(runId, source.id, record, 'suppressed', { payload: null });
      return 'suppressed';
    }

    // Quarantine checks: incomplete address or low declared confidence.
    const defaultProv = record.provenance.find((p) => !p.field) ?? record.provenance[0];
    const confidence = defaultProv.confidence;
    let quarantineReason: 'low_confidence' | null = null;
    if (confidence !== undefined && confidence < QUARANTINE_CONFIDENCE) {
      quarantineReason = 'low_confidence';
    }
    if (
      wantsProperty &&
      record.payload.property &&
      !addressComplete(normaliseAddress(record.payload.property.address))
    ) {
      quarantineReason = 'low_confidence';
    }
    if (quarantineReason) {
      const recordId = await this.writeRecord(runId, source.id, record, 'quarantined', {
        quarantine_reason: quarantineReason,
        payload: record.payload,
      });
      await this.db.kysely
        .insertInto('core.quarantine_item')
        .values({ ingest_record_id: recordId, reason: quarantineReason })
        .execute();
      return 'quarantined';
    }

    const method: ProvenanceMethod =
      defaultProv.method === 'owner_submitted' ? 'owner_submitted' : 'scraped';

    return this.db.tx(async (ctx) => {
      let propertyResult: { propertyId: string; created: boolean } | undefined;
      let contactId: string | undefined;
      let contactCreated = false;

      if (wantsProperty && record.payload.property) {
        propertyResult = await this.properties.upsertFromPayload(
          ctx,
          record.payload.property,
          {
            method,
            confidence,
            collectedAt: new Date(defaultProv.collected_at),
            sourceId: source.id,
          },
        );
      }

      if (wantsContact && record.payload.contact) {
        const c = record.payload.contact;
        const emails = (c.emails ?? []).map((e) => normaliseChannelValue('email', e));
        const found = emails.length
          ? await ctx.trx
              .selectFrom('core.contact_channel as ch')
              .innerJoin('core.contact as co', 'co.id', 'ch.contact_id')
              .select(['co.id', 'co.merged_into'])
              .where('ch.kind', '=', 'email')
              .where('ch.value_normalised', 'in', emails)
              .where('co.lifecycle_state', '<>', 'erased')
              .executeTakeFirst()
          : undefined;

        if (found) {
          contactId = found.merged_into ?? found.id;
        } else {
          contactCreated = true;
          const row = await ctx.trx
            .insertInto('core.contact')
            .values({
              lifecycle_state: 'unregistered',
              display_name: c.display_name ?? null,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          contactId = row.id;
          if (c.role_hint === 'owner') {
            await ctx.trx
              .insertInto('core.contact_role')
              .values({ contact_id: contactId, role: 'owner' })
              .execute();
          }
        }
        for (const email of emails) {
          await ctx.trx
            .insertInto('core.contact_channel')
            .values({ contact_id: contactId, kind: 'email', value_normalised: email })
            .onConflict((oc) =>
              oc.columns(['contact_id', 'kind', 'value_normalised']).doNothing(),
            )
            .execute();
        }
        for (const phone of c.phones ?? []) {
          await ctx.trx
            .insertInto('core.contact_channel')
            .values({
              contact_id: contactId,
              kind: 'phone',
              value_normalised: normaliseChannelValue('phone', phone),
            })
            .onConflict((oc) =>
              oc.columns(['contact_id', 'kind', 'value_normalised']).doNothing(),
            )
            .execute();
        }
      }

      if (propertyResult && contactId && record.payload.contact?.role_hint === 'owner') {
        const linked = await ctx.trx
          .selectFrom('core.property_party')
          .select('id')
          .where('property_id', '=', propertyResult.propertyId)
          .where('contact_id', '=', contactId)
          .where('role', '=', 'owner')
          .executeTakeFirst();
        if (!linked) {
          await ctx.trx
            .insertInto('core.property_party')
            .values({
              property_id: propertyResult.propertyId,
              contact_id: contactId,
              role: 'owner',
            })
            .execute();
        }
      }

      const outcome: Outcome =
        propertyResult?.created || contactCreated ? 'created' : 'updated';
      await this.writeRecord(runId, source.id, record, outcome, {
        payload: record.payload,
        property_id: propertyResult?.propertyId,
        contact_id: contactId,
        trx: ctx,
      });
      await ctx.emit({
        aggregateType: 'ingest_run',
        aggregateId: runId,
        eventType: 'ingest.record_processed',
        payload: { idempotency_key: record.idempotency_key, outcome },
      });
      return outcome;
    });
  }

  async getBatch(
    batchId: string,
    cursor?: string,
    limit = 100,
  ): Promise<Record<string, unknown>> {
    const run = await this.db.kysely
      .selectFrom('core.ingest_run')
      .selectAll()
      .where('id', '=', batchId)
      .executeTakeFirst();
    if (!run) throw new NotFoundException({ code: 'batch_not_found' });

    let q = this.db.kysely
      .selectFrom('core.ingest_record')
      .select(['id', 'idempotency_key', 'outcome', 'quarantine_reason', 'problem_code', 'property_id', 'contact_id'])
      .where('run_id', '=', batchId)
      .orderBy('id')
      .limit(limit + 1);
    if (cursor) q = q.where('id', '>', cursor);
    const rows = await q.execute();
    const page = rows.slice(0, limit);

    const stats = run.stats as Record<string, number>;
    return {
      batch_id: run.id,
      status: run.status,
      stats: {
        total: Object.values(stats).reduce((a, b) => a + b, 0),
        // `suppressed` is folded into ok BY DESIGN — the scraper must not
        // learn which identifiers are on the suppression list.
        ok: (stats.created ?? 0) + (stats.updated ?? 0) + (stats.unchanged ?? 0) + (stats.suppressed ?? 0),
        quarantined: stats.quarantined ?? 0,
        failed: stats.failed ?? 0,
      },
      records: page.map((r) => ({
        idempotency_key: r.idempotency_key,
        outcome: r.outcome,
        ...(r.outcome === 'quarantined' ? { quarantine_reason: r.quarantine_reason } : {}),
        ...(r.outcome === 'failed' ? { problem_code: r.problem_code } : {}),
        ...(r.property_id || r.contact_id
          ? { entity: { property_id: r.property_id ?? undefined, contact_id: r.contact_id ?? undefined } }
          : {}),
      })),
      next_cursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  /** Re-run quarantined/failed records through current rules. */
  async replayBatch(batchId: string): Promise<{ batch_id: string; status: string }> {
    const run = await this.db.kysely
      .selectFrom('core.ingest_run')
      .select(['id', 'source_id'])
      .where('id', '=', batchId)
      .executeTakeFirst();
    if (!run) throw new NotFoundException({ code: 'batch_not_found' });

    const source = await this.db.kysely
      .selectFrom('core.source')
      .select(['id', 'kind'])
      .where('id', '=', run.source_id)
      .executeTakeFirstOrThrow();

    const retryable = await this.db.kysely
      .selectFrom('core.ingest_record')
      .selectAll()
      .where('run_id', '=', batchId)
      .where('outcome', 'in', ['quarantined', 'failed'])
      .execute();
    if (retryable.some((r) => r.payload === null)) {
      throw new GoneException({ code: 'payload_purged' });
    }

    for (const row of retryable) {
      const record: IngestRecordInput = {
        idempotency_key: row.idempotency_key,
        dedupe_key: row.dedupe_key ?? undefined,
        kind: row.kind as IngestRecordInput['kind'],
        payload: row.payload as IngestRecordInput['payload'],
        provenance: [
          { collected_at: new Date(row.created_at).toISOString(), method: 'scraped' },
        ],
      };
      // Delete the old attempt so processFresh can record a new outcome.
      await this.db.kysely
        .deleteFrom('core.quarantine_item')
        .where('ingest_record_id', '=', row.id)
        .execute();
      await this.db.kysely
        .deleteFrom('core.ingest_record')
        .where('id', '=', row.id)
        .execute();
      await this.processFresh(batchId, source, record);
    }
    return { batch_id: batchId, status: 'completed' };
  }

  private async findOrCreateSource(input: {
    name: string;
    kind: string;
  }): Promise<{ id: string; kind: string; enabled: boolean }> {
    const found = await this.db.kysely
      .selectFrom('core.source')
      .select(['id', 'kind', 'enabled'])
      .where('name', '=', input.name)
      .executeTakeFirst();
    if (found) return found;
    return this.db.kysely
      .insertInto('core.source')
      .values({ name: input.name, kind: input.kind })
      .returning(['id', 'kind', 'enabled'])
      .executeTakeFirstOrThrow();
  }

  private async writeRecord(
    runId: string,
    sourceId: string,
    record: IngestRecordInput,
    outcome: Outcome,
    extra: {
      payload?: unknown;
      problem_code?: string;
      quarantine_reason?: string;
      property_id?: string;
      contact_id?: string;
      trx?: { trx: import('kysely').Transaction<import('../../shared/database/db').DB> };
    },
  ): Promise<string> {
    const q = (extra.trx?.trx ?? this.db.kysely)
      .insertInto('core.ingest_record')
      .values({
        run_id: runId,
        source_id: sourceId,
        idempotency_key: record.idempotency_key,
        dedupe_key: record.dedupe_key ?? null,
        kind: record.kind,
        payload: extra.payload === null ? null : JSON.stringify(extra.payload ?? record.payload),
        outcome,
        problem_code: extra.problem_code ?? null,
        quarantine_reason: extra.quarantine_reason ?? null,
        property_id: extra.property_id ?? null,
        contact_id: extra.contact_id ?? null,
      })
      .returning('id');
    const row = await q.executeTakeFirstOrThrow();
    return row.id;
  }

  /** Replayed record keys need a row in the new run for outcome reporting. */
  private async copyRecordToRun(
    runId: string,
    sourceId: string,
    idempotencyKey: string,
  ): Promise<void> {
    // The (source, key) unique constraint means the original row already
    // reports this record; nothing to copy. Kept as an explicit no-op so the
    // replay path is visible in one place.
    void runId;
    void sourceId;
    void idempotencyKey;
  }
}

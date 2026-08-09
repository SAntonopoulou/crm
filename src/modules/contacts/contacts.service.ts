import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Db, TxContext } from '../../shared/database/db.service';
import { systemClock } from '../../shared/jobs/clock';
import { contactLifecycle, ContactLifecycle } from './contact-lifecycle';

export type ChannelKind = 'email' | 'phone';
export type ContactRole = 'owner' | 'buyer' | 'renter' | 'agent' | 'staff';

export interface ContactSelfView {
  id: string;
  lifecycle_state: ContactLifecycle;
  display_name: string | null;
  locale: string;
  timezone: string;
  channels: {
    kind: ChannelKind;
    value: string;
    verification_state: string;
    is_preferred: boolean;
  }[];
  roles: string[];
}

export function normaliseChannelValue(kind: ChannelKind, value: string): string {
  if (kind === 'email') return value.trim().toLowerCase();
  // Minimal E.164 shaping until the full libphonenumber pass in the ingest
  // normalisation pipeline; rejects nothing, canonicalises separators.
  return value.replace(/[\s().-]/g, '').replace(/^00/, '+');
}

@Injectable()
export class ContactsService {
  constructor(private readonly db: Db) {}

  /**
   * Resolve the authenticated subject to a contact, following merge aliases.
   * First login auto-provisions a `registered` contact — registration itself
   * happened in Keycloak.
   */
  async resolveOrProvision(idpSubjectId: string): Promise<string> {
    const existing = await this.db.kysely
      .selectFrom('core.contact')
      .select(['id', 'merged_into', 'lifecycle_state'])
      .where('idp_subject_id', '=', idpSubjectId)
      .executeTakeFirst();
    if (existing) {
      return existing.merged_into ?? existing.id;
    }
    return this.db.tx(async (ctx) => {
      const row = await ctx.trx
        .insertInto('core.contact')
        .values({ idp_subject_id: idpSubjectId, lifecycle_state: 'registered' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await ctx.emit({
        aggregateType: 'contact',
        aggregateId: row.id,
        eventType: 'contact.lifecycle_changed',
        payload: { from: 'unregistered', to: 'registered' },
      });
      return row.id;
    });
  }

  async getSelf(contactId: string): Promise<ContactSelfView> {
    const contact = await this.db.kysely
      .selectFrom('core.contact')
      .selectAll()
      .where('id', '=', contactId)
      .where('lifecycle_state', '<>', 'erased')
      .executeTakeFirst();
    if (!contact) throw new NotFoundException({ code: 'contact_not_found' });

    const [channels, roles] = await Promise.all([
      this.db.kysely
        .selectFrom('core.contact_channel')
        .select(['kind', 'value_normalised', 'verification_state', 'is_preferred'])
        .where('contact_id', '=', contactId)
        .orderBy('created_at')
        .execute(),
      this.db.kysely
        .selectFrom('core.contact_role')
        .select('role')
        .where('contact_id', '=', contactId)
        .where('state', '=', 'active')
        .execute(),
    ]);

    return {
      id: contact.id,
      lifecycle_state: contact.lifecycle_state as ContactLifecycle,
      display_name: contact.display_name,
      locale: contact.locale,
      timezone: contact.timezone,
      channels: channels.map((c) => ({
        kind: c.kind as ChannelKind,
        value: c.value_normalised,
        verification_state: c.verification_state,
        is_preferred: c.is_preferred,
      })),
      roles: roles.map((r) => r.role),
    };
  }

  async updateSelf(
    contactId: string,
    patch: { display_name?: string; locale?: string; timezone?: string },
  ): Promise<ContactSelfView> {
    if (Object.keys(patch).length > 0) {
      await this.db.kysely
        .updateTable('core.contact')
        .set(patch)
        .where('id', '=', contactId)
        .where('lifecycle_state', '<>', 'erased')
        .execute();
    }
    return this.getSelf(contactId);
  }

  async addChannel(
    contactId: string,
    kind: ChannelKind,
    value: string,
    isPreferred = false,
  ): Promise<void> {
    const value_normalised = normaliseChannelValue(kind, value);
    await this.db.tx(async (ctx) => {
      if (isPreferred) {
        await ctx.trx
          .updateTable('core.contact_channel')
          .set({ is_preferred: false })
          .where('contact_id', '=', contactId)
          .where('kind', '=', kind)
          .execute();
      }
      await ctx.trx
        .insertInto('core.contact_channel')
        .values({ contact_id: contactId, kind, value_normalised, is_preferred: isPreferred })
        .onConflict((oc) =>
          oc.columns(['contact_id', 'kind', 'value_normalised']).doNothing(),
        )
        .execute();
      await this.touch(ctx, contactId);
    });
  }

  async addRole(contactId: string, role: ContactRole): Promise<void> {
    await this.db.tx(async (ctx) => {
      await ctx.trx
        .insertInto('core.contact_role')
        .values({ contact_id: contactId, role })
        .execute();
      await this.touch(ctx, contactId);
    });
  }

  /** Lifecycle transition with erasure side effects when the target is `erased`. */
  async transition(
    contactId: string,
    to: ContactLifecycle,
    actorId: string,
  ): Promise<void> {
    await this.db.tx(async (ctx) => {
      const contact = await ctx.trx
        .selectFrom('core.contact')
        .select(['id', 'lifecycle_state'])
        .where('id', '=', contactId)
        .forUpdate()
        .executeTakeFirst();
      if (!contact) throw new NotFoundException({ code: 'contact_not_found' });

      const from = contact.lifecycle_state as ContactLifecycle;
      contactLifecycle.assert(from, to);

      if (to === 'erased') {
        // Local pseudonymisation. The full erasure pipeline (suppression
        // HMACs, Keycloak deletion, DEK destruction) is the privacy module's
        // orchestration (#24) — it calls this transition as one of its steps.
        await ctx.trx
          .deleteFrom('core.contact_channel')
          .where('contact_id', '=', contactId)
          .execute();
        await ctx.trx
          .deleteFrom('core.contact_sensitive')
          .where('contact_id', '=', contactId)
          .execute();
        await ctx.trx
          .updateTable('core.contact')
          .set({
            lifecycle_state: 'erased',
            display_name: null,
            idp_subject_id: null,
          })
          .where('id', '=', contactId)
          .execute();
        await ctx.trx
          .insertInto('core.tombstone')
          .values({ entity_type: 'contact', entity_id: contactId })
          .onConflict((oc) => oc.columns(['entity_type', 'entity_id']).doNothing())
          .execute();
      } else {
        await ctx.trx
          .updateTable('core.contact')
          .set({ lifecycle_state: to })
          .where('id', '=', contactId)
          .execute();
      }

      await ctx.emit({
        aggregateType: 'contact',
        aggregateId: contactId,
        eventType: 'contact.lifecycle_changed',
        payload: { from, to, actor_id: actorId },
      });
    });
  }

  /** Merge `absorbedId` into `survivingId`; fully reversible via unmerge. */
  async merge(
    survivingId: string,
    absorbedId: string,
    actorId: string,
  ): Promise<string> {
    if (survivingId === absorbedId) {
      throw new ConflictException({ code: 'merge_self' });
    }
    return this.db.tx(async (ctx) => {
      // Deterministic lock order prevents deadlock between concurrent merges.
      const ids = [survivingId, absorbedId].sort();
      const locked = await ctx.trx
        .selectFrom('core.contact')
        .selectAll()
        .where('id', 'in', ids)
        .orderBy('id')
        .forUpdate()
        .execute();
      const surviving = locked.find((c) => c.id === survivingId);
      const absorbed = locked.find((c) => c.id === absorbedId);
      if (!surviving || !absorbed) {
        throw new NotFoundException({ code: 'contact_not_found' });
      }
      if (
        surviving.lifecycle_state === 'erased' ||
        absorbed.lifecycle_state === 'erased' ||
        absorbed.merged_into !== null
      ) {
        throw new ConflictException({ code: 'not_mergeable' });
      }

      const snapshotFor = async (contactId: string) => ({
        contact: locked.find((c) => c.id === contactId),
        channels: await ctx.trx
          .selectFrom('core.contact_channel')
          .selectAll()
          .where('contact_id', '=', contactId)
          .execute(),
        roles: await ctx.trx
          .selectFrom('core.contact_role')
          .selectAll()
          .where('contact_id', '=', contactId)
          .execute(),
      });
      const snapshot = {
        surviving: await snapshotFor(survivingId),
        absorbed: await snapshotFor(absorbedId),
      };

      // Re-point channels that don't collide with the survivor's; duplicates
      // are dropped here and restored from the snapshot on unmerge. The
      // survivor keeps its preferred flags — a second preferred channel per
      // kind would violate contact_channel_preferred_uq.
      await ctx.trx
        .updateTable('core.contact_channel')
        .set({ contact_id: survivingId, is_preferred: false })
        .where('contact_id', '=', absorbedId)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('core.contact_channel as dup')
                .select('dup.id')
                .where('dup.contact_id', '=', survivingId)
                .whereRef('dup.kind', '=', 'core.contact_channel.kind')
                .whereRef(
                  'dup.value_normalised',
                  '=',
                  'core.contact_channel.value_normalised',
                ),
            ),
          ),
        )
        .execute();
      await ctx.trx
        .deleteFrom('core.contact_channel')
        .where('contact_id', '=', absorbedId)
        .execute();

      await ctx.trx
        .updateTable('core.contact_role')
        .set({ contact_id: survivingId })
        .where('contact_id', '=', absorbedId)
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom('core.contact_role as dup')
                .select('dup.id')
                .where('dup.contact_id', '=', survivingId)
                .where('dup.state', '<>', 'ended')
                .whereRef('dup.role', '=', 'core.contact_role.role'),
            ),
          ),
        )
        .execute();
      await ctx.trx
        .deleteFrom('core.contact_role')
        .where('contact_id', '=', absorbedId)
        .execute();

      // The absorbed row remains as an alias so inbound references resolve.
      await ctx.trx
        .updateTable('core.contact')
        .set({ merged_into: survivingId })
        .where('id', '=', absorbedId)
        .execute();
      await this.touch(ctx, survivingId);

      const merge = await ctx.trx
        .insertInto('core.contact_merge')
        .values({
          surviving_id: survivingId,
          absorbed_id: absorbedId,
          pre_merge_snapshot: JSON.stringify(snapshot),
          merged_by: actorId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      await ctx.emit({
        aggregateType: 'contact',
        aggregateId: survivingId,
        eventType: 'contact.merged',
        payload: { surviving_id: survivingId, absorbed_id: absorbedId },
      });
      return merge.id;
    });
  }

  /** Replay a merge in reverse from its snapshot. */
  async unmerge(mergeId: string, actorId: string): Promise<void> {
    await this.db.tx(async (ctx) => {
      const merge = await ctx.trx
        .selectFrom('core.contact_merge')
        .selectAll()
        .where('id', '=', mergeId)
        .where('unmerged_at', 'is', null)
        .forUpdate()
        .executeTakeFirst();
      if (!merge) throw new NotFoundException({ code: 'merge_not_found' });

      const snapshot = merge.pre_merge_snapshot as unknown as {
        surviving: SnapshotSide;
        absorbed: SnapshotSide;
      };

      for (const side of [snapshot.surviving, snapshot.absorbed]) {
        const contactId = side.contact.id;
        await ctx.trx
          .deleteFrom('core.contact_channel')
          .where('contact_id', '=', contactId)
          .execute();
        await ctx.trx
          .deleteFrom('core.contact_role')
          .where('contact_id', '=', contactId)
          .execute();
      }
      for (const side of [snapshot.surviving, snapshot.absorbed]) {
        const c = side.contact;
        await ctx.trx
          .updateTable('core.contact')
          .set({
            display_name: c.display_name,
            locale: c.locale,
            timezone: c.timezone,
            lifecycle_state: c.lifecycle_state,
            idp_subject_id: c.idp_subject_id,
            processing_restricted: c.processing_restricted,
            merged_into: null,
          })
          .where('id', '=', c.id)
          .execute();
        for (const ch of side.channels) {
          await ctx.trx
            .insertInto('core.contact_channel')
            .values({
              id: ch.id,
              contact_id: ch.contact_id,
              kind: ch.kind,
              value_normalised: ch.value_normalised,
              verification_state: ch.verification_state,
              is_preferred: ch.is_preferred,
              created_at: ch.created_at,
            })
            .execute();
        }
        for (const r of side.roles) {
          await ctx.trx
            .insertInto('core.contact_role')
            .values({
              id: r.id,
              contact_id: r.contact_id,
              role: r.role,
              state: r.state,
              activated_at: r.activated_at,
              ended_at: r.ended_at,
            })
            .execute();
        }
      }

      await ctx.trx
        .updateTable('core.contact_merge')
        .set({ unmerged_at: systemClock.now() })
        .where('id', '=', mergeId)
        .execute();
      await ctx.emit({
        aggregateType: 'contact',
        aggregateId: merge.surviving_id,
        eventType: 'contact.unmerged',
        payload: {
          surviving_id: merge.surviving_id,
          absorbed_id: merge.absorbed_id,
          actor_id: actorId,
        },
      });
    });
  }

  /** Bump the parent row so child changes surface in delta sync. */
  private async touch(ctx: TxContext, contactId: string): Promise<void> {
    await ctx.trx
      .updateTable('core.contact')
      .set({ updated_at: systemClock.now() })
      .where('id', '=', contactId)
      .execute();
  }
}

interface SnapshotSide {
  contact: {
    id: string;
    display_name: string | null;
    locale: string;
    timezone: string;
    lifecycle_state: string;
    idp_subject_id: string | null;
    processing_restricted: boolean;
  };
  channels: {
    id: string;
    contact_id: string;
    kind: string;
    value_normalised: string;
    verification_state: string;
    is_preferred: boolean;
    created_at: string;
  }[];
  roles: {
    id: string;
    contact_id: string;
    role: string;
    state: string;
    activated_at: string;
    ended_at: string | null;
  }[];
}

import {
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Db } from '../../shared/database/db.service';
import { Clock, systemClock } from '../../shared/jobs/clock';
import { ValuationService, ValueEstimate } from './valuation.service';

export interface Money {
  amount: string;
  currency: string;
}

export interface PortfolioEntryView {
  property_id: string;
  purchase_price: Money;
  monthly_rental_income: Money;
  monthly_expenses: Money;
  outstanding_debt?: Money;
  monthly_mortgage_payment?: Money;
  status: string;
  added_at: string;
  current_value_estimate?: ValueEstimate;
  /**
   * Stamped whenever the valuation job runs — even when the number does not
   * change — so the client can caveat ("as of …") or suppress projections
   * built on a stale estimate (client-team delta, 2026-08-09).
   */
  current_value_estimate_computed_at: string | null;
}

export type PortfolioStatus = 'watching' | 'offer_made' | 'owned';

export interface PortfolioEntryInput {
  property_id: string;
  purchase_price: Money;
  monthly_rental_income: Money;
  monthly_expenses: Money;
  outstanding_debt?: Money;
  monthly_mortgage_payment?: Money;
  status?: PortfolioStatus;
}

/** Investor-entered data about themselves — deliberately no PII-access logging. */
@Injectable()
export class PortfolioService {
  constructor(
    private readonly db: Db,
    private readonly valuation: ValuationService,
    @Optional() private readonly clock?: Clock,
  ) {}

  private now(): Date {
    return this.clock?.now() ?? systemClock.now();
  }

  async list(
    contactId: string,
    cursor?: string,
    limit = 25,
  ): Promise<{ items: PortfolioEntryView[]; next_cursor: string | null }> {
    let q = this.db.kysely
      .selectFrom('core.portfolio_entry')
      .selectAll()
      .where('contact_id', '=', contactId)
      .orderBy('id')
      .limit(limit + 1);
    if (cursor) q = q.where('id', '>', cursor);
    const rows = await q.execute();
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => this.toView(row)),
      next_cursor: rows.length > limit ? page[page.length - 1].id : null,
    };
  }

  async add(contactId: string, input: PortfolioEntryInput): Promise<PortfolioEntryView> {
    const property = await this.db.kysely
      .selectFrom('core.property')
      .select('id')
      .where('id', '=', input.property_id)
      .executeTakeFirst();
    if (!property) throw new NotFoundException({ code: 'property_not_found' });

    // First valuation runs inline so a new entry isn't blank until the
    // hourly job; computed_at is stamped even when no estimate is possible.
    const estimate = await this.valuation.estimateValue(input.property_id);
    const now = this.now();

    const row = await this.db.tx(async (ctx) => {
      const existing = await ctx.trx
        .selectFrom('core.portfolio_entry')
        .select('id')
        .where('contact_id', '=', contactId)
        .where('property_id', '=', input.property_id)
        .executeTakeFirst();
      if (existing) throw new ConflictException({ code: 'portfolio_duplicate' });

      const inserted = await ctx.trx
        .insertInto('core.portfolio_entry')
        .values({
          contact_id: contactId,
          property_id: input.property_id,
          purchase_price: input.purchase_price.amount,
          monthly_rental_income: input.monthly_rental_income.amount,
          monthly_expenses: input.monthly_expenses.amount,
          outstanding_debt: input.outstanding_debt?.amount ?? null,
          monthly_mortgage_payment: input.monthly_mortgage_payment?.amount ?? null,
          currency: input.purchase_price.currency,
          status: input.status ?? 'watching',
          last_value_estimate: estimate?.amount ?? null,
          last_estimated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await ctx.emit({
        aggregateType: 'portfolio_entry',
        aggregateId: inserted.id,
        eventType: 'portfolio.entry_added',
        payload: { contact_id: contactId, property_id: input.property_id },
      });
      if (estimate) {
        await ctx.emit({
          aggregateType: 'portfolio_entry',
          aggregateId: inserted.id,
          eventType: 'portfolio.valuation_updated',
          payload: {
            old: null,
            new: { amount: estimate.amount, currency: inserted.currency },
          },
        });
      }
      return inserted;
    });
    return this.toView(row);
  }

  async update(
    contactId: string,
    propertyId: string,
    patch: Partial<Omit<PortfolioEntryInput, 'property_id'>>,
  ): Promise<PortfolioEntryView> {
    const updates: Record<string, unknown> = {};
    const changed: string[] = [];
    const moneyFields: [keyof typeof patch, string][] = [
      ['purchase_price', 'purchase_price'],
      ['monthly_rental_income', 'monthly_rental_income'],
      ['monthly_expenses', 'monthly_expenses'],
      ['outstanding_debt', 'outstanding_debt'],
      ['monthly_mortgage_payment', 'monthly_mortgage_payment'],
    ];
    for (const [key, column] of moneyFields) {
      const value = patch[key] as Money | undefined;
      if (value) {
        updates[column] = value.amount;
        changed.push(column);
      }
    }
    if (patch.purchase_price) updates.currency = patch.purchase_price.currency;
    if (patch.status) {
      updates.status = patch.status;
      changed.push('status');
    }

    const row = await this.db.tx(async (ctx) => {
      const updated = await ctx.trx
        .updateTable('core.portfolio_entry')
        .set(updates)
        .where('contact_id', '=', contactId)
        .where('property_id', '=', propertyId)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new NotFoundException({ code: 'portfolio_entry_not_found' });
      if (changed.length > 0) {
        await ctx.emit({
          aggregateType: 'portfolio_entry',
          aggregateId: updated.id,
          eventType: 'portfolio.entry_updated',
          payload: { changed_fields: changed },
        });
      }
      return updated;
    });
    return this.toView(row);
  }

  async remove(contactId: string, propertyId: string): Promise<void> {
    await this.db.tx(async (ctx) => {
      const deleted = await ctx.trx
        .deleteFrom('core.portfolio_entry')
        .where('contact_id', '=', contactId)
        .where('property_id', '=', propertyId)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) throw new NotFoundException({ code: 'portfolio_entry_not_found' });
      await ctx.trx
        .insertInto('core.tombstone')
        .values({ entity_type: 'portfolio_entry', entity_id: deleted.id })
        .onConflict((oc) => oc.columns(['entity_type', 'entity_id']).doNothing())
        .execute();
      await ctx.emit({
        aggregateType: 'portfolio_entry',
        aggregateId: deleted.id,
        eventType: 'portfolio.entry_removed',
        payload: { contact_id: contactId, property_id: propertyId },
      });
    });
  }

  /**
   * Scheduled revaluation. computed_at is stamped on EVERY run for every
   * entry; portfolio.valuation_updated fires ONLY where the number moved.
   */
  async refreshValuations(): Promise<number> {
    const entries = await this.db.kysely
      .selectFrom('core.portfolio_entry')
      .select(['id', 'property_id', 'last_value_estimate', 'currency'])
      .execute();

    const now = this.now();
    let changes = 0;
    for (const entry of entries) {
      const estimate = await this.valuation.estimateValue(entry.property_id);
      const newAmount = estimate?.amount ?? null;
      const oldAmount =
        entry.last_value_estimate === null
          ? null
          : Number(entry.last_value_estimate).toFixed(2);

      if (newAmount === oldAmount) {
        await this.db.kysely
          .updateTable('core.portfolio_entry')
          .set({ last_estimated_at: now })
          .where('id', '=', entry.id)
          .execute();
        continue;
      }

      changes++;
      await this.db.tx(async (ctx) => {
        await ctx.trx
          .updateTable('core.portfolio_entry')
          .set({ last_value_estimate: newAmount, last_estimated_at: now })
          .where('id', '=', entry.id)
          .execute();
        await ctx.emit({
          aggregateType: 'portfolio_entry',
          aggregateId: entry.id,
          eventType: 'portfolio.valuation_updated',
          payload: {
            old: oldAmount === null ? null : { amount: oldAmount, currency: entry.currency },
            new: newAmount === null ? null : { amount: newAmount, currency: entry.currency },
          },
        });
      });
    }
    return changes;
  }

  private toView(row: {
    property_id: string;
    purchase_price: string;
    monthly_rental_income: string;
    monthly_expenses: string;
    outstanding_debt: string | null;
    monthly_mortgage_payment: string | null;
    currency: string;
    status: string;
    added_at: Date;
    last_value_estimate: string | null;
    last_estimated_at: Date | null;
  }): PortfolioEntryView {
    const money = (amount: string): Money => ({
      amount: Number(amount).toFixed(2),
      currency: row.currency,
    });
    return {
      property_id: row.property_id,
      purchase_price: money(row.purchase_price),
      monthly_rental_income: money(row.monthly_rental_income),
      monthly_expenses: money(row.monthly_expenses),
      ...(row.outstanding_debt !== null
        ? { outstanding_debt: money(row.outstanding_debt) }
        : {}),
      ...(row.monthly_mortgage_payment !== null
        ? { monthly_mortgage_payment: money(row.monthly_mortgage_payment) }
        : {}),
      status: row.status,
      added_at: row.added_at.toISOString(),
      // Absent, not null-as-zero, until enough comps exist (contract).
      ...(row.last_value_estimate !== null
        ? {
            current_value_estimate: {
              amount: Number(row.last_value_estimate).toFixed(2),
              currency: row.currency,
            },
          }
        : {}),
      current_value_estimate_computed_at:
        row.last_estimated_at?.toISOString() ?? null,
    };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { Db } from '../../shared/database/db.service';

/**
 * Template rendering with locale fallback (requested → en) and {{merge}}
 * fields. Rendered sends record the exact template_version_id used — the
 * "which wording did we send" audit the spec demands.
 */
@Injectable()
export class TemplatesService {
  constructor(private readonly db: Db) {}

  async upsert(
    key: string,
    category: 'transactional' | 'marketing',
    locale: string,
    body: string,
  ): Promise<string> {
    const template = await this.db.kysely
      .insertInto('core.template')
      .values({ key, category })
      .onConflict((oc) => oc.column('key').doUpdateSet({ category }))
      .returning('id')
      .executeTakeFirstOrThrow();
    const latest = await this.db.kysely
      .selectFrom('core.template_version')
      .select(this.db.kysely.fn.max('version').as('v'))
      .where('template_id', '=', template.id)
      .where('locale', '=', locale)
      .executeTakeFirst();
    const row = await this.db.kysely
      .insertInto('core.template_version')
      .values({
        template_id: template.id,
        version: (Number(latest?.v) || 0) + 1,
        locale,
        body,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async render(
    key: string,
    locale: string,
    vars: Record<string, string | number>,
  ): Promise<{ body: string; templateVersionId: string }> {
    const version = await this.db.kysely
      .selectFrom('core.template_version as tv')
      .innerJoin('core.template as t', 't.id', 'tv.template_id')
      .select(['tv.id', 'tv.body', 'tv.locale'])
      .where('t.key', '=', key)
      .where('tv.locale', 'in', [locale, 'en'])
      .orderBy(
        // Requested locale beats the en fallback; then newest version.
        (eb) => eb.case().when('tv.locale', '=', locale).then(0).else(1).end(),
      )
      .orderBy('tv.version', 'desc')
      .limit(1)
      .executeTakeFirst();
    if (!version) throw new NotFoundException({ code: 'template_not_found', key });

    const body = version.body.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name: string) =>
      vars[name] !== undefined ? String(vars[name]) : `{{${name}}}`,
    );
    return { body, templateVersionId: version.id };
  }
}

import { createHash } from 'node:crypto';

export interface AddressInput {
  raw?: string;
  street?: string;
  number?: string;
  unit?: string;
  postcode?: string;
  city?: string;
  country: string;
}

export interface NormalisedAddress {
  street: string;
  number: string;
  unit: string;
  postcode: string;
  city: string;
  country: string;
  raw: string | null;
}

const collapse = (s: string | undefined): string =>
  (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

export function normaliseAddress(a: AddressInput): NormalisedAddress {
  return {
    street: collapse(a.street),
    number: collapse(a.number).replace(/\s/g, ''),
    unit: collapse(a.unit).replace(/\s/g, ''),
    postcode: collapse(a.postcode).replace(/\s/g, ''),
    city: collapse(a.city),
    country: (a.country ?? '').trim().toUpperCase(),
    raw: a.raw?.trim() || null,
  };
}

/**
 * Canonical dedupe key (domain model §3): derived from normalised address
 * components, deliberately NOT from geocoder output, so a geocoder version
 * bump can never fork property identities.
 */
export function canonicalKey(n: NormalisedAddress): string {
  return createHash('sha256')
    .update([n.country, n.street, n.number, n.unit, n.postcode].join('|'))
    .digest('hex');
}

/** Address is complete enough to identify a property; otherwise quarantine. */
export function addressComplete(n: NormalisedAddress): boolean {
  return Boolean(n.country && n.street && n.number && n.postcode);
}

const EPC_LABELS = ['A++', 'A+', 'A', 'B', 'C', 'D', 'E', 'F', 'G'] as const;
export type EpcLabel = (typeof EPC_LABELS)[number];

/**
 * Normalise raw EPC strings to the closed Belgian label superset (contract
 * 1.1.0). "b", "A+", "C (245 kWh/m²)" normalise; anything else is null —
 * never force-cast into a grade it doesn't have.
 */
export function normaliseEpc(raw: string | null | undefined): EpcLabel | null {
  if (!raw) return null;
  const v = raw.trim().toUpperCase().replace(/\s+/g, '');
  const m = v.match(/^(A\+\+|A\+|[A-G])(?![A-Z0-9+]).*$|^(A\+\+|A\+|[A-G])$/);
  const label = (m?.[1] ?? m?.[2]) as EpcLabel | undefined;
  return label && (EPC_LABELS as readonly string[]).includes(label) ? label : null;
}

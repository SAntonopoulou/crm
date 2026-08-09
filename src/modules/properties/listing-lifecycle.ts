import { StateMachine } from '../../shared/state-machine';

export type ListingState =
  | 'discovered'
  | 'contact_attempted'
  | 'owner_reached'
  | 'verified'
  | 'live'
  | 'under_offer'
  | 'sold'
  | 'let'
  | 'withdrawn'
  | 'expired';

/** Listing lifecycle (domain model §14). Terminal: sold, let, withdrawn, expired. */
export const listingLifecycle = new StateMachine<ListingState>('listing', {
  discovered: ['contact_attempted', 'owner_reached', 'expired', 'withdrawn'],
  contact_attempted: ['owner_reached', 'withdrawn', 'expired'],
  owner_reached: ['verified', 'withdrawn', 'expired'],
  verified: ['live', 'withdrawn', 'expired'],
  live: ['under_offer', 'withdrawn', 'expired'],
  under_offer: ['live', 'sold', 'let', 'withdrawn'],
  sold: [],
  let: [],
  withdrawn: [],
  expired: [],
});

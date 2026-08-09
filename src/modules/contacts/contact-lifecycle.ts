import { StateMachine } from '../../shared/state-machine';

export type ContactLifecycle =
  | 'unregistered'
  | 'invited'
  | 'registered'
  | 'identity_verified'
  | 'suspended'
  | 'erased';

/**
 * Account lifecycle (domain model §2): suspended is reachable from and
 * returnable to the active states; erased is terminal. `unregistered ->
 * registered` covers self-signup that never went through an invite.
 */
export const contactLifecycle = new StateMachine<ContactLifecycle>('contact', {
  unregistered: ['invited', 'registered', 'erased'],
  invited: ['registered', 'erased'],
  registered: ['identity_verified', 'suspended', 'erased'],
  identity_verified: ['suspended', 'erased'],
  suspended: ['registered', 'identity_verified', 'erased'],
  erased: [],
});

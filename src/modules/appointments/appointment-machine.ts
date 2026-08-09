import { StateMachine } from '../../shared/state-machine';

export type AppointmentState =
  | 'dispatching'
  | 'unstaffed'
  | 'booked'
  | 'confirmed'
  | 'in_progress'
  | 'completed'
  | 'outcome_captured'
  | 'cancelled'
  | 'no_show';

/**
 * Appointment lifecycle (domain model §14). Booking creates the row in
 * `dispatching`; the dispatch claim moves it to `booked`. `cancelled` and
 * `no_show` carry a by_party attribute instead of being one state per party.
 * A reschedule re-enters `dispatching` with a new time range.
 */
export const appointmentMachine = new StateMachine<AppointmentState>('appointment', {
  dispatching: ['booked', 'unstaffed', 'cancelled'],
  unstaffed: ['dispatching', 'cancelled'],
  booked: ['confirmed', 'dispatching', 'cancelled', 'no_show'],
  // confirmed → dispatching: agent withdrawal before the viewing re-opens
  // the slot for a fresh dispatch (the viewer keeps their booking).
  confirmed: ['in_progress', 'dispatching', 'cancelled', 'no_show'],
  in_progress: ['completed'],
  completed: ['outcome_captured'],
  outcome_captured: [],
  cancelled: [],
  no_show: [],
});

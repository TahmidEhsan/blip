// Blip: in-process event bus for live click streams (SPEC §7.4).
// Events are emitted on `link:<id>` as `{ type, data }`.
import { EventEmitter } from 'node:events';

export const linkChannel = (linkId) => `link:${linkId}`;

export function createBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(0); // one listener per open dashboard; no artificial cap
  return bus;
}

/**
 * @param {EventEmitter} bus
 * @param {number} linkId
 * @param {'click'|'status'|'deleted'} type
 * @param {object} data
 */
export function publish(bus, linkId, type, data) {
  bus.emit(linkChannel(linkId), { type, data });
}

// Blip: in-process wake-ups for live streams (SPEC §7.4).
// Live streams read clicks and status changes from the database (server/live.js), so they see what
// every server instance stored. This bus only tells the streams open on THIS instance that something
// changed for a link, so they poll right away instead of at their next tick. It carries no data.
import { EventEmitter } from 'node:events';

export const linkChannel = (linkId) => `link:${linkId}`;

export function createBus() {
  const bus = new EventEmitter();
  bus.setMaxListeners(0); // one listener per open dashboard; no artificial cap
  return bus;
}

/**
 * Wake this instance's live streams for a link (after a click, a status change, a deletion...).
 * @param {EventEmitter} bus
 * @param {number} linkId
 */
export function wake(bus, linkId) {
  bus.emit(linkChannel(linkId));
}

// Blip: live dashboard streams (SPEC §7.4), Server-Sent Events fed by polling the database.
//
// On Vercel, Blip runs as several stateless instances and a visit can land on any of them, so a stream
// never waits for in-process events to learn about clicks. When it opens it reads one snapshot (the
// `hello` totals and the highest click id stored), then polls every `streamPollMs` for the link's clicks
// stored since and for the link row. New clicks go out in id order with running totals, a burst (such
// as simulated traffic) spread a little apart so the dashboard can animate it, and a `status` event goes
// out whenever the link's status or click count changes. The in-process bus (server/bus.js) only wakes
// the streams open on this instance, so a visit handled here shows up at once instead of at the next
// poll. With `streamMaxMs` set (Vercel ends functions after 300 s) the stream ends cleanly on time and
// the dashboard's client reconnects, getting a fresh `hello`.
import { clickEventFromRow, isCountedClick, liveStreamPoll, liveStreamSnapshot, liveTotalsThrough } from './analytics.js';
import { linkChannel } from './bus.js';
import { statusPayload } from './links.js';

export const STREAM_HEARTBEAT_MS = 15_000;
/** Gap between the `click` events of one burst, so simulated traffic lands click by click... */
export const STREAM_STAGGER_MS = 120;
/** ...but no burst is spread over more than this, so a busy link never falls behind. */
export const STREAM_BURST_MAX_MS = 6_000;
/** Most clicks read by one poll; a longer backlog is read by the polls that follow straight away. */
export const STREAM_POLL_LIMIT = 200;
/** After this many failed polls in a row the stream ends (the dashboard reconnects with backoff). */
const MAX_POLL_FAILURES = 3;

const statusKey = (payload) => JSON.stringify(payload);

/**
 * Serve the live stream of one link on `res`. The caller has already authorised the request.
 * Resolves once the `hello` event is out (or the stream has ended); the stream keeps running after that.
 * @param {object} ctx the app context: db, bus, config (streamPollMs, streamMaxMs), now, streams, redact
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {object} link the link's row
 * @param {{ onOpen?: (stream: { end: () => void }) => void, onClose?: () => void }} [hooks] `onOpen` gets the
 *   stream's handle as soon as it is registered (calling `end()` on it ends the stream); `onClose` runs
 *   once, when the stream ends for any reason
 */
export async function serveLiveStream(ctx, req, res, link, { onOpen, onClose } = {}) {
  const { db, bus, config } = ctx;
  const channel = linkChannel(link.id);
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  req.socket?.setNoDelay?.(true);

  let closed = false;
  let started = false; // `hello` is out and polling has begun
  let polling = false;
  let wakeRequested = false;
  let failures = 0;
  let cursor = 0; // highest click id this stream has accounted for
  let totals = null; // running all-time { clicks, uniqueVisitors } as of `cursor`
  let epoch = null; // CLICKS_EPOCH_KEY as of the last read
  let lastStatus = null;
  let pollTimer = null;
  let pauseTimer = null;
  let pauseDone = null;

  const write = (chunk) => {
    if (!closed && !res.writableEnded && !res.destroyed) res.write(chunk);
  };
  const send = (event, data) => write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const logError = (what, err) => {
    const message = err?.message || String(err);
    console.error(`[blip] live stream for /${link.slug} ${what}: ${ctx.redact ? ctx.redact(message) : message}`);
  };

  const heartbeat = setInterval(() => write(': ping\n\n'), STREAM_HEARTBEAT_MS);
  heartbeat.unref?.();
  const maxTimer = config.streamMaxMs > 0 ? setTimeout(() => stream.end(), config.streamMaxMs) : null;
  maxTimer?.unref?.();

  const stream = {
    end() {
      cleanup();
      if (!res.writableEnded) res.end();
    },
  };

  function cleanup() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(maxTimer);
    clearTimeout(pollTimer);
    clearTimeout(pauseTimer);
    pauseDone?.();
    bus.off(channel, onWake);
    ctx.streams.delete(stream);
    onClose?.();
  }

  function schedule(ms) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(run, ms);
    pollTimer.unref?.();
  }

  function onWake() {
    if (closed) return;
    if (!started || polling) wakeRequested = true;
    else schedule(0);
  }

  function pause(ms) {
    return new Promise((resolve) => {
      pauseDone = resolve;
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        pauseDone = null;
        resolve();
      }, ms);
      pauseTimer.unref?.();
    });
  }

  async function run() {
    pollTimer = null;
    if (closed || polling) return;
    polling = true;
    wakeRequested = false;
    let more = false;
    try {
      more = await pollOnce();
      failures = 0;
    } catch (err) {
      if (!closed) {
        // closed: the dashboard left or the app is shutting down, so a failed read is expected
        failures += 1;
        if (failures === 1) logError('could not poll the database', err);
        if (failures >= MAX_POLL_FAILURES) stream.end();
      }
    } finally {
      polling = false;
    }
    if (!closed) schedule(more || wakeRequested ? 0 : config.streamPollMs);
  }

  /** @returns {Promise<boolean>} true when more stored clicks are waiting to be read */
  async function pollOnce() {
    const snap = await liveStreamPoll(db, link.id, cursor, STREAM_POLL_LIMIT);
    if (closed) return false;
    if (!snap.link) {
      // Deleted. The dashboard reconnects, gets a 404 and stops.
      stream.end();
      return false;
    }
    if (snap.epoch !== epoch) {
      // Clicks were deleted (Clear simulated) somewhere: recount what this stream has counted so far.
      epoch = snap.epoch;
      totals = await liveTotalsThrough(db, link.id, cursor);
      if (closed) return false;
    }
    const { rows } = snap;
    const more = rows.length >= STREAM_POLL_LIMIT;
    // Rows of other links up to throughId are skipped for good; a full page resumes after its last row.
    cursor = more ? rows[rows.length - 1].id : Math.max(cursor, snap.throughId, rows[rows.length - 1]?.id ?? 0);

    const events = rows.map((row) => {
      if (isCountedClick(row)) {
        totals = { clicks: totals.clicks + 1, uniqueVisitors: totals.uniqueVisitors + (row.is_unique ? 1 : 0) };
      }
      return { ...clickEventFromRow(row), totals };
    });
    const gap = events.length > 1 ? Math.min(STREAM_STAGGER_MS, Math.floor(STREAM_BURST_MAX_MS / (events.length - 1))) : 0;
    for (let i = 0; i < events.length; i += 1) {
      if (i > 0 && gap > 0) await pause(gap);
      if (closed) return false;
      send('click', events[i]);
    }

    // Status, expiry reason and click count, as of now (a timer can run out between two polls).
    const status = statusPayload(snap.link, ctx.now());
    const key = statusKey(status);
    if (key !== lastStatus) {
      lastStatus = key;
      send('status', status);
    }
    return more;
  }

  bus.on(channel, onWake);
  ctx.streams.add(stream);
  onOpen?.(stream);
  // `res` 'close' fires when the client disconnects or the stream is ended. On Vercel that needs request
  // cancellation (`supportsCancellation` in vercel.json); the per-client caps in routes/api.js also end
  // an old stream that never reported its disconnect.
  res.on('close', cleanup);
  req.on('close', () => {
    if (res.destroyed || req.socket?.destroyed) cleanup();
  });
  req.on('error', cleanup); // a cancelled request ("aborted")

  try {
    const snap = await liveStreamSnapshot(db, link.id, ctx.now());
    if (closed) return;
    if (!snap.link) {
      stream.end();
      return;
    }
    cursor = snap.throughId;
    totals = { clicks: snap.totals.clicks, uniqueVisitors: snap.totals.uniqueVisitors };
    epoch = snap.epoch;
    lastStatus = statusKey(statusPayload(snap.link, ctx.now()));
    send('hello', { slug: link.slug, totals: snap.totals });
    started = true;
    schedule(wakeRequested ? 0 : config.streamPollMs);
  } catch (err) {
    if (closed) return;
    logError('could not start', err);
    stream.end();
  }
}

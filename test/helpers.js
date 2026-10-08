// Shared test helpers: boot an isolated Blip app on an ephemeral port with a mutable clock.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.js';

export const START_TIME = Date.parse('2026-10-07T12:00:00.000Z');
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0',
  slackbot: 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

/**
 * Start an app + server. Rate limits are raised by default so tests can create many links;
 * pass `rateLimits: null` to keep the production limits.
 */
export async function startServer({ config = {}, geoLookup, random, rateLimits, streamLimits, startTime = START_TIME } = {}) {
  const clock = { t: startTime };
  const instance = createApp({
    config: { dbPath: ':memory:', baseUrl: 'http://localhost:3030', allowDemoTraffic: true, ...config },
    now: () => clock.t,
    geoLookup,
    random,
    rateLimits: rateLimits === null ? undefined : { createLink: 100_000, simulate: 100_000, lookup: 100_000, ...(rateLimits || {}) },
    streamLimits,
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;

  async function request(method, path, { body, token, headers = {}, raw = false } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (token !== undefined) init.headers['X-Manage-Token'] = token;
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = raw ? body : JSON.stringify(body);
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let json = null;
    if (text && (res.headers.get('content-type') || '').includes('application/json')) json = JSON.parse(text);
    return { status: res.status, headers: res.headers, json, text };
  }

  /** POST /api/links and assert success. */
  async function createLink(body) {
    const res = await request('POST', '/api/links', { body });
    if (res.status !== 201) throw new Error(`createLink failed: ${res.status} ${res.text}`);
    return res.json;
  }

  /** Visit a short link like a browser would (no redirect following). */
  function visit(slug, { ua = UA.windowsChrome, method = 'GET', headers = {} } = {}) {
    return request(method, `/${slug}`, { headers: { 'User-Agent': ua, ...headers } });
  }

  async function stop() {
    instance.endStreams();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    instance.close();
  }

  return {
    ...instance,
    server,
    base,
    clock,
    advance(ms) {
      clock.t += ms;
    },
    request,
    createLink,
    visit,
    stop,
  };
}

/**
 * Open the SSE stream for a link and expose a promise-based event reader.
 * @returns {Promise<{ status: number, headers: Headers, next: (pred?: (e) => boolean, timeoutMs?: number) => Promise<{event: string, data: any}>, close: () => void }>}
 */
export async function openStream(base, slug, token) {
  const controller = new AbortController();
  const res = await fetch(`${base}/api/links/${slug}/stream`, {
    headers: { 'X-Manage-Token': token, Accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const events = [];
  const waiters = [];
  let buffer = '';
  let comments = 0;

  const flush = () => {
    for (let i = 0; i < waiters.length; i += 1) {
      const w = waiters[i];
      const idx = events.findIndex(w.pred);
      if (idx !== -1) {
        const [evt] = events.splice(idx, 1);
        waiters.splice(i, 1);
        i -= 1;
        clearTimeout(w.timer);
        w.resolve(evt);
      }
    }
  };

  if (res.ok && res.body) {
    (async () => {
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            let event = 'message';
            const data = [];
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) comments += 1;
              else if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data.push(line.slice(6));
            }
            if (data.length) events.push({ event, data: JSON.parse(data.join('\n')) });
          }
          flush();
        }
      } catch {
        // aborted by close()
      }
    })();
  }

  return {
    status: res.status,
    headers: res.headers,
    get comments() {
      return comments;
    },
    next(pred = () => true, timeoutMs = 3000) {
      return new Promise((resolve, reject) => {
        const waiter = { pred, resolve };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('Timed out waiting for SSE event'));
        }, timeoutMs);
        waiters.push(waiter);
        flush();
      });
    },
    close() {
      controller.abort();
    },
  };
}

/** Extract and parse the `<script type="application/json" id="blip-data">` payload of a view. */
export function blipData(html) {
  const m = /<script type="application\/json" id="blip-data">([\s\S]*?)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

// Copy rules from DESIGN.md §11 (the same patterns scripts/audit-design.mjs uses).
const EM_DASH = String.fromCharCode(0x2014);
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
const COPY_CONTRAST = /\bit'?s not (just )?[^.!?]{1,50}[,;:]\s*it'?s\b|\bnot just [^.!?]{1,50}(,|;)?\s*but\b|\bisn'?t (just )?[^.!?]{1,40}[,;]\s*it'?s\b/i;

/** Assert that user-facing text has no em dashes, no emoji and no "it's not X, it's Y" phrasing. */
export function assertPlainCopy(text, label = 'copy') {
  const value = String(text ?? '');
  assert.ok(!value.includes(EM_DASH), `${label} contains an em dash: ${value.slice(0, 200)}`);
  const emoji = value.match(EMOJI);
  assert.equal(emoji, null, `${label} contains an emoji or symbol glyph: ${emoji?.[0]}`);
  assert.ok(!COPY_CONTRAST.test(value), `${label} uses "it's not X, it's Y" phrasing: ${value.slice(0, 200)}`);
}

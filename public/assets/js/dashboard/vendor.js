// Blip dashboard: the classic vendor scripts the charts need (d3 and topojson-client).
// dashboard.html lists them as deferred scripts after the page module, so the module can route to the
// gate (or put up the dashboard skeleton) without waiting for the 280 KB d3 download. Anything that
// draws waits here instead. If a script failed to load, asking again adds a fresh <script src> tag
// (same origin, so the strict CSP allows it), which is what makes the Retry buttons work.

const LIBS = {
  d3: '/vendor/d3.min.js',
  topojson: '/vendor/topojson-client.min.js',
};

// Deferred scripts run before DOMContentLoaded, so once it fires the parser-inserted tags have either
// defined their global or failed.
const parsed = new Promise((resolve) => {
  if (document.readyState === 'complete') {
    resolve();
    return;
  }
  document.addEventListener('DOMContentLoaded', resolve, { once: true });
  window.addEventListener('load', resolve, { once: true });
});

const inflight = new Map();

function inject(name, src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.addEventListener('load', () => {
      if (window[name]) resolve();
      else reject(new Error(`${src} loaded but did not define ${name}`));
    }, { once: true });
    script.addEventListener('error', () => {
      script.remove();
      reject(new Error(`${src} failed to load`));
    }, { once: true });
    document.head.append(script);
  });
}

/**
 * Resolves once window[name] exists, loading the script again if the page's own tag failed.
 * Concurrent callers share one attempt; a failed attempt is forgotten so the next call tries again.
 * @param {'d3'|'topojson'} name
 * @returns {Promise<void>}
 */
export function loadLib(name) {
  if (window[name]) return Promise.resolve();
  const src = LIBS[name];
  if (!src) return Promise.reject(new Error(`Unknown library ${name}`));
  if (!inflight.has(name)) {
    const attempt = parsed
      .then(() => (window[name] ? undefined : inject(name, src)))
      .finally(() => inflight.delete(name));
    inflight.set(name, attempt);
  }
  return inflight.get(name);
}

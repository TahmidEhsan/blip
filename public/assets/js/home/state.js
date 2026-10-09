// Blip home page: shared state, config defaults and a tiny change bus.

const changeBus = new EventTarget();

export const TEASER_STYLES = ['countdown', 'trivia', 'brand'];
export const TEASER_THEMES = ['hero', 'caption', 'noir', 'sky', 'paper'];
/** Teaser theme ids from the first release, mapped to their comic replacements (DESIGN.md section 12). */
export const LEGACY_THEMES = Object.freeze({ aurora: 'hero', sunset: 'caption', ocean: 'sky', neon: 'noir', candy: 'paper' });

/** Current theme id for any stored or configured id (legacy ids map across, unknown ids fall back to hero). */
export function canonicalTheme(id) {
  if (TEASER_THEMES.includes(id)) return id;
  return LEGACY_THEMES[id] || TEASER_THEMES[0];
}

/** Mutable page state shared by every home-page module. */
export const state = {
  config: fallbackConfig(),
  /** Domain currently chosen in the "Playful domain" panel. */
  domain: fallbackConfig().baseHost,
  /** The link shown in the result card (LinkDTO) or null. */
  currentLink: null,
};

/** Config used until /api/config answers (or if it never does). */
export function fallbackConfig() {
  const host = window.location.host || 'localhost';
  return {
    baseUrl: window.location.origin,
    baseHost: host,
    domains: [{ domain: host, live: true, isBase: true }],
    defaultDomain: host,
    allowDemoTraffic: false,
    teaser: { minSeconds: 3, maxSeconds: 15, defaultSeconds: 5, styles: TEASER_STYLES, themes: TEASER_THEMES },
    limits: { slugMax: 64, titleMax: 120, messageMax: 280, maxClicksMax: 1000000, urlMax: 2048 },
    offline: true,
  };
}

/** Merge a /api/config response over the defaults, dropping anything malformed. */
export function normalizeConfig(raw) {
  const base = fallbackConfig();
  if (!raw || typeof raw !== 'object') return base;
  const baseHost = typeof raw.baseHost === 'string' && raw.baseHost ? raw.baseHost : base.baseHost;
  const domains = Array.isArray(raw.domains)
    ? raw.domains
      .filter((d) => d && typeof d.domain === 'string' && d.domain)
      .map((d) => ({ domain: d.domain, live: Boolean(d.live), isBase: Boolean(d.isBase) }))
    : [];
  if (!domains.some((d) => d.domain === baseHost)) domains.unshift({ domain: baseHost, live: true, isBase: true });
  return {
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl ? raw.baseUrl : base.baseUrl,
    baseHost,
    domains,
    defaultDomain: typeof raw.defaultDomain === 'string' && raw.defaultDomain ? raw.defaultDomain : baseHost,
    allowDemoTraffic: Boolean(raw.allowDemoTraffic),
    teaser: normalizeTeaser(base.teaser, raw.teaser),
    limits: { ...base.limits, ...(raw.limits && typeof raw.limits === 'object' ? raw.limits : {}) },
    offline: false,
  };
}

function normalizeTeaser(base, raw) {
  const merged = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
  const themes = Array.isArray(merged.themes) ? [...new Set(merged.themes.map(canonicalTheme))] : base.themes;
  return { ...merged, themes: themes.length ? themes : base.themes };
}

/** Hosts that belong to this Blip install (used to block redirect loops client-side). */
export function ownHosts() {
  const hosts = new Set([state.config.baseHost.toLowerCase()]);
  for (const d of state.config.domains) hosts.add(d.domain.toLowerCase());
  return [...hosts];
}

export function emitChange(source = null) {
  changeBus.dispatchEvent(new CustomEvent('change', { detail: { source } }));
}

export function onChange(fn) {
  changeBus.addEventListener('change', (event) => fn(event.detail?.source ?? null));
}

/** A validation problem tied to a CreateBody / UpdateBody field name (SPEC §5). */
export class FieldError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'FieldError';
    this.field = field;
  }
}

/** Turn any thrown error into a sentence a human wants to read. */
export function friendlyMessage(err, fallback = 'Something went wrong. Please try again.') {
  if (!err) return fallback;
  if (err.code === 'network') return "Can't reach Blip right now. Check your connection and try again.";
  if (err.status === 429) return err.message && !/^Request failed/.test(err.message) ? err.message : 'Whoa, speedy! Give it a few seconds and try again.';
  // A deployment without its database (or with settings it can't use) says what the owner should do.
  if ((err.code === 'database_not_configured' || err.code === 'misconfigured') && err.message) return err.message;
  if (err.status >= 500) return 'Blip hiccuped on the server side. Please try again in a moment.';
  if (err.message && !/^Request failed/.test(err.message)) return err.message;
  return fallback;
}

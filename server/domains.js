// Blip: vanity domains offered in the UI and the offline domain-idea generator (SPEC §5.3).

/** Real, short ccTLDs/gTLDs that work well for short links. */
export const IDEA_TLDS = Object.freeze([
  'ly', 'to', 'me', 'io', 'co', 'gg', 'sh', 'is', 'it', 'at', 'be', 'so', 'im', 'es', 'us', 'in',
  'al', 'am', 'fm', 'tv', 'cc', 'ai', 'ws', 'la', 'vc', 'st', 'nu', 'ink', 'link',
]);

const TLD_NOTES = {
  ly: 'the classic link-shortener ending',
  to: 'reads like “go to”',
  gg: 'a favourite with gamers',
  sh: 'short, snappy and a bit techy',
  co: 'startup-friendly and easy to say',
};

export const KEYWORD_MAX = 40;
const IDEAS_MAX = 12;
const LABEL_MAX = 63;

/** Whether links on `domain` resolve to this server today. */
export function isDomainLive(config, domain) {
  return domain === config.baseHost || config.liveDomains.includes(domain);
}

/** `[{ domain, live, isBase }]`, base host first. */
export function domainOptions(config) {
  return [
    { domain: config.baseHost, live: true, isBase: true },
    ...config.domains.map((domain) => ({ domain, live: config.liveDomains.includes(domain), isBase: false })),
  ];
}

/** Lowercase, strip accents, keep [a-z0-9-], collapse and trim hyphens. */
export function normalizeKeyword(input) {
  return String(input ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "summer" → "smmr": keep the first letter, drop the vowels after it. */
export function vowelless(word) {
  if (!word) return '';
  return word[0] + word.slice(1).replace(/[aeiou]/g, '');
}

const validLabel = (label) => label.length >= 1 && label.length <= LABEL_MAX && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);

/**
 * Offline domain ideas for a keyword. Never touches the network: availability must be checked by the user.
 * @param {string} keyword
 * @returns {{ keyword: string, ideas: { domain: string, kind: 'hack'|'short'|'playful', note: string }[] }}
 */
export function domainIdeas(keyword) {
  const kw = normalizeKeyword(keyword).slice(0, KEYWORD_MAX).replace(/-+$/, '');
  const compact = kw.replace(/-/g, '');
  const ideas = [];
  const seen = new Set();
  const add = (label, tld, kind, note) => {
    if (!validLabel(label) || !IDEA_TLDS.includes(tld)) return;
    const domain = `${label}.${tld}`;
    if (seen.has(domain)) return;
    seen.add(domain);
    ideas.push({ domain, kind, note });
  };
  if (!compact) return { keyword: kw, ideas };

  // 1. Domain hacks: the TLD completes the word (delicious → delicio.us).
  const hackTlds = [...IDEA_TLDS].sort((a, b) => b.length - a.length);
  for (const tld of hackTlds) {
    if (compact.length > tld.length + 1 && compact.endsWith(tld)) {
      add(compact.slice(0, -tld.length), tld, 'hack', 'Domain hack: the TLD finishes the word');
    }
  }

  const abbr = vowelless(compact);
  const hasAbbr = abbr.length >= 2 && abbr !== compact && abbr.length <= 12;
  const shortOk = compact.length <= 12;
  const shortNote = (tld) => `Short and sweet on .${tld}: ${TLD_NOTES[tld]}`;
  const abbrNote = (tld) => `Vowel-free “${abbr}” on .${tld}: fewer letters to type`;

  const ordered = [
    () => shortOk && add(compact, 'ly', 'short', shortNote('ly')),
    () => add(`go${compact}`, 'to', 'playful', 'Reads like a call to action: “go to ...”'),
    () => hasAbbr && add(abbr, 'ly', 'short', abbrNote('ly')),
    () => add(compact, 'link', 'playful', 'Says exactly what it is'),
    () => shortOk && add(compact, 'to', 'short', shortNote('to')),
    () => add(`hey${compact}`, 'co', 'playful', 'A friendly hello in front of your name'),
    () => shortOk && add(compact, 'gg', 'short', shortNote('gg')),
    () => add(`${compact}hq`, 'io', 'playful', 'Your link headquarters'),
    () => IDEA_TLDS.includes(compact) && add(compact[0], compact, 'playful', 'Single-letter flex: rare and very premium'),
    () => hasAbbr && add(abbr, 'to', 'short', abbrNote('to')),
    () => shortOk && add(compact, 'sh', 'short', shortNote('sh')),
    () => shortOk && add(compact, 'co', 'short', shortNote('co')),
    () => hasAbbr && add(abbr, 'gg', 'short', abbrNote('gg')),
    () => hasAbbr && add(abbr, 'sh', 'short', abbrNote('sh')),
    () => hasAbbr && add(abbr, 'co', 'short', abbrNote('co')),
  ];
  for (const step of ordered) {
    if (ideas.length >= IDEAS_MAX) break;
    step();
  }
  return { keyword: kw, ideas: ideas.slice(0, IDEAS_MAX) };
}

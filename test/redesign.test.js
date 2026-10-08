// The comic redesign's server-side contract (DESIGN.md): self-hosted Bangers and Comic Neue fonts,
// retired lucide/Inter/Space Grotesk routes, and server-rendered views that follow the copy rules.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UA, assertPlainCopy, startServer } from './helpers.js';

describe('vendor assets', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.stop());

  /** GET a font stylesheet, check it declares `family`, and check every font file it points at is served. */
  async function checkFontCss(path, family) {
    const res = await s.request('GET', path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /^text\/css/, path);
    assert.ok(res.text.includes(`font-family: '${family}'`), `${path} declares ${family}`);
    const files = [...res.text.matchAll(/url\(\.\/(files\/[^)]+)\)/g)].map((m) => m[1]);
    assert.ok(files.length >= 1, `${path} points at font files`);
    const dir = path.slice(0, path.lastIndexOf('/') + 1);
    for (const file of files) {
      const font = await fetch(`${s.base}${dir}${file}`);
      assert.equal(font.status, 200, `${dir}${file}`);
      assert.match(font.headers.get('content-type'), /^font\/woff2?$/, `${dir}${file}`);
      await font.arrayBuffer();
    }
  }

  it('serves Bangers and Comic Neue from node_modules', async () => {
    await checkFontCss('/vendor/fonts/bangers/latin-400.css', 'Bangers');
    await checkFontCss('/vendor/fonts/comic-neue/latin-400.css', 'Comic Neue');
    await checkFontCss('/vendor/fonts/comic-neue/latin-700.css', 'Comic Neue');
  });

  it('no longer serves lucide, Inter or Space Grotesk', async () => {
    for (const path of [
      '/vendor/lucide.min.js',
      '/vendor/fonts/inter/index.css',
      '/vendor/fonts/space-grotesk/index.css',
    ]) {
      assert.equal((await s.request('GET', path)).status, 404, path);
    }
  });

  it('keeps the other vendor files and does not list font directories', async () => {
    for (const path of ['/vendor/d3.min.js', '/vendor/topojson-client.min.js', '/vendor/qr-code-styling.js', '/vendor/countries-110m.json']) {
      const res = await fetch(s.base + path);
      assert.equal(res.status, 200, path);
      await res.arrayBuffer();
    }
    assert.equal((await s.request('GET', '/vendor/fonts/bangers/')).status, 404);
    const sprite = await s.request('GET', '/assets/icons.svg');
    assert.equal(sprite.status, 200);
    assert.match(sprite.headers.get('content-type'), /^image\/svg\+xml/);
  });
});

describe('server-rendered views', () => {
  let s;
  before(async () => {
    s = await startServer();
  });
  after(() => s.stop());

  /** One rendered page per view and variant: teaser styles, every expired reason, 404 and the bot preview. */
  async function renderedPages() {
    const pages = [];
    for (const [style, theme] of [['countdown', 'hero'], ['trivia', 'caption'], ['brand', 'noir']]) {
      const slug = `view-${style}`;
      await s.createLink({
        targetUrl: 'https://example.com/landing', slug, redirectMode: 'teaser',
        teaser: { style, theme, message: style === 'brand' ? 'Fresh drops every Friday' : undefined },
      });
      pages.push([`teaser (${style})`, await s.visit(slug), 200]);
    }
    const { manageToken } = await s.createLink({ targetUrl: 'https://example.com/a', slug: 'view-destroyed' });
    await s.request('POST', '/api/links/view-destroyed/destroy', { token: manageToken, body: {} });
    pages.push(['expired (manual)', await s.visit('view-destroyed'), 410]);
    await s.createLink({ targetUrl: 'https://example.com/b', slug: 'view-burn', maxClicks: 1 });
    await s.visit('view-burn');
    pages.push(['expired (clicks)', await s.visit('view-burn'), 410]);
    await s.createLink({ targetUrl: 'https://example.com/c', slug: 'view-timed', expiresInSeconds: 60 });
    s.advance(61_000);
    pages.push(['expired (time)', await s.visit('view-timed'), 410]);
    pages.push(['not-found', await s.visit('view-missing'), 404]);
    await s.createLink({ targetUrl: 'https://example.com/d', slug: 'view-preview', maxClicks: 3 });
    pages.push(['preview', await s.visit('view-preview', { ua: UA.slackbot }), 200]);
    return pages;
  }

  let pages;
  before(async () => {
    pages = await renderedPages();
  });

  it('render with the expected status codes', () => {
    for (const [name, res, status] of pages) assert.equal(res.status, status, name);
  });

  it('have no em dashes, emoji or "it\'s not X, it\'s Y" copy', () => {
    for (const [name, res] of pages) assertPlainCopy(res.text, `${name} view`);
  });

  it('do not reference lucide, Inter or Space Grotesk', () => {
    for (const [name, res] of pages) {
      assert.ok(!/lucide/i.test(res.text), `${name} view references lucide`);
      assert.ok(!/fonts\/inter\b|Inter Variable/i.test(res.text), `${name} view references Inter`);
      assert.ok(!/space-grotesk|Space Grotesk/i.test(res.text), `${name} view references Space Grotesk`);
    }
  });

  it('only reference local stylesheets, scripts and icons that exist', async () => {
    const urls = new Set();
    for (const [, res] of pages) {
      for (const m of res.text.matchAll(/<(?:link|script|img|use)\b[^>]*?\s(?:href|src)="(\/[^"/][^"]*)"/g)) {
        urls.add(m[1].replace(/&amp;/g, '&').replace(/#.*$/, ''));
      }
    }
    assert.ok(urls.size > 0, 'views load local assets');
    for (const url of urls) {
      const res = await fetch(s.base + url);
      assert.equal(res.status, 200, url);
      await res.arrayBuffer();
    }
  });
});

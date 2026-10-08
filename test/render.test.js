import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderTemplate, renderView, safeJson, VIEW_NAMES } from '../server/render.js';
import { TRIVIA, pickTrivia } from '../server/data/trivia.js';
import { assertPlainCopy } from './helpers.js';

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

describe('renderTemplate', () => {
  it('escapes text and attribute placeholders', () => {
    const out = renderTemplate('<h1>{{text:TITLE}}</h1><a href="{{attr:URL}}">go</a>', {
      TITLE: `<script>alert("x")</script> & 'friends'`,
      URL: 'https://example.com/?a=1&b="2"',
    });
    assert.equal(
      out,
      '<h1>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;friends&#39;</h1>'
        + '<a href="https://example.com/?a=1&amp;b=&quot;2&quot;">go</a>',
    );
  });

  it('serialises JSON safely for <script type="application/json">', () => {
    const out = renderTemplate('<script type="application/json">{{json:DATA}}</script>', {
      DATA: { msg: `</script><script>alert(1)</script> & more ${LS}${PS}`, n: 3, nothing: null },
    });
    assert.ok(!out.slice(0, -'</script>'.length).includes('</script>'), out);
    assert.ok(out.includes('\\u003c/script\\u003e'));
    assert.ok(out.includes('\\u0026'));
    assert.ok(!out.includes(LS) && !out.includes(PS));
    const json = out.replace('<script type="application/json">', '').replace(/<\/script>$/, '');
    assert.deepEqual(JSON.parse(json), { msg: `</script><script>alert(1)</script> & more ${LS}${PS}`, n: 3, nothing: null });
  });

  it('renders unknown keys, raw and unsupported kinds as empty strings', () => {
    assert.equal(renderTemplate('[{{text:NOPE}}][{{raw:HTML}}][{{json:NOPE}}][{{weird:HTML}}]', { HTML: '<b>x</b>' }), '[][][][]');
  });

  it('is single pass: values are never re-expanded', () => {
    assert.equal(renderTemplate('{{text:A}}', { A: '{{text:B}}', B: 'boom' }), '{{text:B}}');
  });

  it('tolerates whitespace inside placeholders and null values', () => {
    assert.equal(renderTemplate('{{ text:A }}|{{text:B}}|{{json:C}}', { A: 'x', B: null, C: undefined }), 'x||null');
  });

  it('helpers', () => {
    assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(safeJson(undefined), 'null');
  });
});

describe('renderView', () => {
  it('only renders the four known views (no path traversal)', async () => {
    assert.deepEqual([...VIEW_NAMES], ['teaser', 'expired', 'not-found', 'preview']);
    await assert.rejects(() => renderView('../app'), /Unknown view/);
    await assert.rejects(() => renderView('index'), /Unknown view/);
    await assert.rejects(() => renderView('teaser.html'), /Unknown view/);
  });

  it('renders a real view with escaped values', async () => {
    const html = await renderView('not-found', { SLUG: '<b>x</b>', DATA: { slug: '<b>x</b>' } });
    assert.match(html, /^<!doctype html>/i);
    assert.ok(!html.includes('<b>x</b>'));
    assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  });
});

describe('trivia', () => {
  it('has at least 60 short, unique facts', () => {
    assert.ok(TRIVIA.length >= 60, `${TRIVIA.length} facts`);
    assert.equal(new Set(TRIVIA).size, TRIVIA.length);
    for (const fact of TRIVIA) {
      assert.ok(fact.length >= 20 && fact.length <= 140, fact);
      assert.match(fact, /[.!?”]$/, fact);
      assertPlainCopy(fact, 'trivia fact');
    }
  });

  it('pickTrivia uses the injected random source', () => {
    assert.equal(pickTrivia(() => 0), TRIVIA[0]);
    assert.equal(pickTrivia(() => 0.999999), TRIVIA[TRIVIA.length - 1]);
  });
});

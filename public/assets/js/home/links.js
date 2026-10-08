// Blip home page: "My links" list (batch fetch, status, countdowns, Edit settings, Destroy now/Bring back, delete).

import { api, linkStore, el, icon, toast, copyText, formatRelative } from '../api.js';
import { friendlyMessage } from './state.js';
import { byId, flashButton, setBusy, skeleton } from './dom.js';
import { displayUrl, statusBadge, countdownEl, expiryWords, clicksWords, usableUrl, tickCountdowns } from './format.js';

const BATCH_SIZE = 100;

export function createLinks({ actions, onCountChange, onLinkLoaded }) {
  const list = byId('linksList');
  const empty = byId('linksEmpty');
  const errorBox = byId('linksError');
  const errorText = byId('linksErrorText');
  const retryBtn = byId('linksRetry');
  const refreshBtn = byId('refreshLinks');
  const countEl = byId('linksCount');
  const liveStatus = byId('linksStatus');

  /** slug to { slug, token, link, error, rev } in store order */
  let entries = new Map();
  let loading = false;
  let loadedOnce = false;
  let queued = false;
  /** Bumped whenever add()/update() changes an entry locally, so a slower batch refresh can't undo it. */
  let rev = 0;

  const rowId = (slug) => `link-row-${slug}`;

  function setCount(n) {
    countEl.textContent = String(n);
    onCountChange?.(n);
  }

  /** Row-shaped placeholders (URL, destination, meta line and the action buttons). */
  function showSkeleton() {
    const n = Math.min(3, Math.max(1, linkStore.all().length));
    list.replaceChildren(...Array.from({ length: n }, () => el('li', { class: 'link-row link-row--skeleton', 'aria-hidden': 'true' },
      el('div', { class: 'link-row__main' },
        skeleton('span', 'skeleton--text sk-url'),
        skeleton('span', 'skeleton--text sk-target'),
        skeleton('span', 'skeleton--text sk-meta')),
      el('div', { class: 'link-row__actions' }, ...Array.from({ length: 4 }, () => skeleton('span', 'sk-action'))))));
    empty.hidden = true;
    errorBox.hidden = true;
  }

  /** Row action buttons carry data-action so keyboard focus can follow them across re-renders. */
  function iconButton(iconName, label, onClick, extra = {}) {
    return el('button', {
      type: 'button',
      class: `btn btn--ghost btn--sm btn--icon ${extra.class || ''}`.trim(),
      'aria-label': label,
      title: label,
      dataset: extra.action ? { action: extra.action } : undefined,
      on: { click: onClick },
    }, icon(iconName));
  }

  function iconLink(iconName, label, href, action) {
    return el('a', { class: 'btn btn--ghost btn--sm btn--icon', href, 'aria-label': label, title: label, dataset: action ? { action } : undefined }, icon(iconName));
  }

  function buildMissingRow(entry) {
    const message = entry.error === 'forbidden'
      ? 'This browser’s key for this link was rejected, so it can’t be managed from here.'
      : 'This link could not be loaded.';
    return el('li', { class: 'link-row link-row--problem', id: rowId(entry.slug), dataset: { slug: entry.slug, status: 'unknown' } },
      el('div', { class: 'link-row__main' },
        el('div', { class: 'link-row__top' }, el('span', { class: 'link-row__url' }, `/${entry.slug}`), el('span', { class: 'badge badge--neutral' }, 'no access')),
        el('p', { class: 'link-row__target' }, icon('triangle-alert'), el('span', {}, message))),
      el('div', { class: 'link-row__actions' },
        el('button', {
          type: 'button',
          class: 'btn btn--ghost btn--sm',
          dataset: { action: 'forget' },
          on: {
            click: () => {
              linkStore.remove(entry.slug);
              removeEntry(entry.slug);
              toast(`Forgot /${entry.slug} in this browser.`);
            },
          },
        }, icon('x'), 'Forget')));
  }

  function buildRow(entry) {
    if (!entry.link) return buildMissingRow(entry);
    const link = entry.link;
    const status = link.status;
    const slugHash = `#${encodeURIComponent(link.slug)}`;

    const badges = [statusBadge(link)];
    if (link.redirectMode === 'teaser') badges.push(el('span', { class: 'badge badge--teaser' }, 'teaser'));
    if (!link.domainLive) badges.push(el('span', { class: 'badge badge--vanity', title: `Works right now at ${displayUrl(link.workingUrl)}` }, 'vanity'));

    const meta = [el('span', { class: 'link-row__meta-item' }, icon('mouse-pointer-click'), clicksWords(link))];
    const expiry = expiryWords(link);
    if (expiry) {
      meta.push(el('span', { class: 'link-row__meta-item link-row__meta-item--warn' }, icon(status === 'destroyed' ? 'bomb' : 'clock-alert'), expiry));
    } else if (link.expiresAt) {
      meta.push(el('span', { class: 'link-row__meta-item' }, icon('timer'), countdownEl(link.expiresAt)));
    } else {
      meta.push(el('span', { class: 'link-row__meta-item' }, icon('infinity'), 'No expiry'));
    }
    meta.push(el('span', { class: 'link-row__meta-item', title: link.createdAt }, `Created ${formatRelative(link.createdAt)}`));

    const copyBtn = iconButton('copy', `Copy link /${link.slug}`, async () => {
      const ok = await copyText(usableUrl(link));
      if (ok) {
        flashButton(copyBtn);
        toast(`Copied ${displayUrl(usableUrl(link))}`, { type: 'success' });
      } else {
        toast("Couldn't copy automatically. Select the link and copy it by hand.", { type: 'error' });
      }
    }, { action: 'copy' });

    const keyBtn = iconButton('key-round', `Copy manage key for /${link.slug}`, async () => {
      const ok = entry.token ? await copyText(entry.token) : false;
      if (ok) {
        flashButton(keyBtn);
        toast(`Manage key for /${link.slug} copied. Keep it private: it unlocks this link's dashboard on any device.`, { type: 'success', timeout: 4500 });
      } else {
        toast("Couldn't copy the manage key automatically. Please try again.", { type: 'error' });
      }
    }, { action: 'key' });

    // Destination, title, domain, teaser and self-destruct all live in the shared Edit settings dialog.
    const settingsBtn = iconButton('sliders-horizontal', `Edit settings for /${link.slug}`,
      () => actions.editSettings(link.slug, { focus: 'general' }), { action: 'settings' });

    // One slot for the link's life: Destroy now while active, and Bring back (Edit settings at its
    // Self-destruct section) once it stopped, whether destroyed by hand or out of time or clicks.
    let lifeBtn;
    if (status !== 'active') {
      let why = 'Give it more time so it works again';
      if (status === 'destroyed') why = 'Undo Destroy now so it works again';
      else if (link.expiredReason === 'clicks') why = 'Give it more clicks so it works again';
      lifeBtn = el('button', {
        type: 'button',
        class: 'btn btn--blue btn--sm link-row__bring-back',
        'aria-label': `Bring back /${link.slug}`,
        title: why,
        dataset: { action: 'life' },
        on: { click: () => actions.editSettings(link.slug, { focus: 'destruct' }) },
      }, icon('rotate-ccw'), el('span', {}, 'Bring back'));
    } else {
      lifeBtn = iconButton('bomb', `Destroy /${link.slug} now`, () => actions.destroy(link.slug), { class: 'link-row__destroy', action: 'life' });
    }

    return el('li', { class: 'link-row', id: rowId(link.slug), dataset: { slug: link.slug, status } },
      el('div', { class: 'link-row__main' },
        el('div', { class: 'link-row__top' },
          el('span', { class: 'link-row__url', title: link.shortUrl }, displayUrl(link.shortUrl)),
          ...badges),
        el('p', { class: 'link-row__target' },
          icon('corner-down-right'),
          el('span', { class: 'link-row__target-url truncate', title: link.targetUrl }, displayUrl(link.targetUrl)),
          link.title ? el('span', { class: 'link-row__title truncate' }, `· ${link.title}`) : null),
        el('div', { class: 'link-row__meta' }, ...meta)),
      el('div', { class: 'link-row__actions' },
        copyBtn,
        iconLink('activity', `Live dashboard for /${link.slug}`, `/dashboard.html${slugHash}`, 'dashboard'),
        iconLink('qr-code', `QR studio for /${link.slug}`, `/qr.html${slugHash}`, 'qr'),
        keyBtn,
        settingsBtn,
        lifeBtn,
        iconButton('trash', `Delete /${link.slug}`, () => actions.remove(link.slug), { class: 'link-row__delete', action: 'delete' })));
  }

  function render() {
    const rows = [...entries.values()];
    setCount(rows.length);
    errorBox.hidden = true;
    if (!rows.length) {
      list.replaceChildren();
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    list.replaceChildren(...rows.map(buildRow));
    tickCountdowns();
  }

  const firstAction = (row) => row?.querySelector('.link-row__actions button:not([disabled]), .link-row__actions a[href]') ?? null;

  function replaceRow(slug) {
    const entry = entries.get(slug);
    const old = document.getElementById(rowId(slug));
    if (!entry || !old) {
      render();
      return;
    }
    // Remember which action had keyboard focus so it survives the swap (e.g. Destroy now to Bring back). Only
    // when the row itself had focus, so a slow API reply never pulls focus away from somewhere else.
    const active = document.activeElement;
    const hadFocus = Boolean(active && old.contains(active));
    const action = hadFocus ? active.closest('[data-action]')?.dataset.action ?? null : null;

    const next = buildRow(entry);
    if (old.classList.contains('is-new')) next.classList.add('is-new');
    old.replaceWith(next);
    tickCountdowns();

    if (!hadFocus) return;
    const target = (action && next.querySelector(`[data-action="${action}"]:not([disabled])`)) || firstAction(next);
    target?.focus({ preventScroll: true });
  }

  /** Drop a row, moving keyboard focus to a neighbour if the row had it. */
  function removeEntry(slug) {
    const row = document.getElementById(rowId(slug));
    const hadFocus = Boolean(row?.contains(document.activeElement));
    const order = [...entries.keys()];
    const index = order.indexOf(slug);
    const neighbour = index === -1 ? null : order[index + 1] ?? order[index - 1] ?? null;
    entries.delete(slug);
    render();
    if (!hadFocus) return;
    const nextRow = neighbour ? document.getElementById(rowId(neighbour)) : null;
    const target = nextRow?.querySelector('[data-action="delete"]') || firstAction(nextRow) || (empty.hidden ? refreshBtn : byId('emptyCreateBtn'));
    target.focus({ preventScroll: true });
  }

  async function refresh({ announce = false } = {}) {
    if (loading) {
      queued = true;
      return;
    }
    const stored = linkStore.all();
    if (!stored.length) {
      entries = new Map();
      loadedOnce = true;
      render();
      if (announce) liveStatus.textContent = 'Links refreshed. None saved yet.';
      return;
    }
    const startRev = rev;
    loading = true;
    list.setAttribute('aria-busy', 'true');
    setBusy(refreshBtn, true);
    if (!loadedOnce) showSkeleton();
    try {
      const chunks = [];
      for (let i = 0; i < stored.length; i += BATCH_SIZE) chunks.push(stored.slice(i, i + BATCH_SIZE));
      const responses = await Promise.all(chunks.map((chunk) => api.batch(chunk.map(({ slug, token }) => ({ slug, token })))));
      const results = responses.flatMap((r) => (Array.isArray(r?.results) ? r.results : []));
      const bySlug = new Map(results.map((r) => [r.slug, r]));
      // Merge with whatever happened while the request was in flight instead of overwriting it.
      const storedSlugs = new Set(stored.map((item) => item.slug));
      const stillStored = new Set(linkStore.all().map((item) => item.slug));
      const next = new Map();
      // Links created on this page meanwhile stay on top, where add() put them.
      for (const [slug, entry] of entries) {
        if (entry.rev > startRev && !storedSlugs.has(slug)) next.set(slug, entry);
      }
      let removed = 0;
      for (const item of stored) {
        const prev = entries.get(item.slug);
        // Deleted or forgotten meanwhile.
        if (!prev && !stillStored.has(item.slug)) continue;
        // Destroyed, revived, edited or reloaded meanwhile: the local copy is newer than this reply.
        if (prev && prev.rev > startRev) {
          next.set(item.slug, prev);
          continue;
        }
        const r = bySlug.get(item.slug);
        if (!r) continue;
        if (r.error === 'not_found') {
          linkStore.remove(item.slug);
          removed += 1;
          continue;
        }
        next.set(item.slug, {
          slug: item.slug,
          token: item.token,
          link: r.link || null,
          error: r.error || null,
          rev: 0,
        });
      }
      entries = next;
      loadedOnce = true;
      render();
      // Let the result panel catch up with what the server just said (e.g. its link burned meanwhile).
      for (const entry of next.values()) if (entry.link && entry.rev === 0) onLinkLoaded?.(entry.link);
      if (removed) toast(`${removed === 1 ? 'One link' : `${removed} links`} no longer exist${removed === 1 ? 's' : ''} and ${removed === 1 ? 'was' : 'were'} tidied away.`);
      if (announce) liveStatus.textContent = `Links refreshed. ${next.size} saved.`;
    } catch (err) {
      const message = friendlyMessage(err, "We couldn't load your links.");
      if (loadedOnce) {
        toast(message, { type: 'error' });
      } else {
        list.replaceChildren();
        empty.hidden = true;
        errorBox.hidden = false;
        errorText.textContent = message;
        setCount(linkStore.all().length);
      }
    } finally {
      loading = false;
      list.removeAttribute('aria-busy');
      setBusy(refreshBtn, false);
      if (queued) {
        queued = false;
        refresh();
      }
    }
  }

  refreshBtn.addEventListener('click', () => refresh({ announce: true }));
  retryBtn.addEventListener('click', () => refresh({ announce: true }));
  list.addEventListener('blip:countdown-done', (event) => {
    const slug = event.target.closest('[data-slug]')?.dataset.slug;
    if (slug) actions.expiryReached(slug, event.detail?.expiresAt ?? entries.get(slug)?.link?.expiresAt ?? null);
  });

  // Another tab added or removed links: resync.
  let storageTimer = 0;
  window.addEventListener('storage', (event) => {
    if (event.key !== null && event.key !== 'blip.links.v1') return;
    clearTimeout(storageTimer);
    storageTimer = setTimeout(() => refresh(), 250);
  });

  return {
    refresh,
    /** Put a just-created link at the top of the list. */
    add(link, token) {
      const next = new Map([[link.slug, { slug: link.slug, token, link, error: null, rev: ++rev }]]);
      for (const [slug, entry] of entries) if (slug !== link.slug) next.set(slug, entry);
      entries = next;
      loadedOnce = true;
      render();
      for (const row of list.querySelectorAll('.link-row.is-new')) row.classList.remove('is-new');
      document.getElementById(rowId(link.slug))?.classList.add('is-new');
    },
    update(link) {
      const entry = entries.get(link.slug);
      if (!entry) return;
      entry.link = link;
      entry.error = null;
      entry.rev = ++rev;
      replaceRow(link.slug);
    },
    remove: removeEntry,
    has: (slug) => entries.has(slug),
    /** The latest LinkDTO this list holds for a slug, or null. */
    get: (slug) => entries.get(slug)?.link ?? null,
    /** A row's Edit settings button: where focus lands when the dialog closes and the button that opened it is gone. */
    settingsButton: (slug) => document.getElementById(rowId(slug))?.querySelector('[data-action="settings"]') ?? null,
  };
}

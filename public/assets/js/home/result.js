// Blip home page: result panel shown after a link is created.

import { el, icon, setIcon, toast, copyText, formatNumber, formatDateTime, prefersReducedMotion } from '../api.js';
import { DEFAULT_QR_STYLE, createQr } from '../qr-shared.js';
import { qrLookName } from './qr-render.js';
import { state } from './state.js';
import { byId, flashButton, skeleton } from './dom.js';
import { popBurst } from './effects.js';
import { displayUrl, statusBadge, countdownEl, teaserStyleWord, themeWord, usableUrl, plural } from './format.js';

const RESULT_QR_SIZE = 184;
const TITLE_ICONS = { active: 'rocket', destroyed: 'bomb', expired: 'clock-alert' };

export function createResult({ actions, onAnother }) {
  const section = byId('result');
  const title = byId('resultTitle');
  const titleText = byId('resultTitleText');
  const titleIcon = byId('resultTitleIcon');
  const burst = byId('resultBurst');
  const burstText = byId('resultBurstText');
  const badges = byId('resultBadges');
  const shortUrl = byId('resultShortUrl');
  const target = byId('resultTarget');
  const workingRow = byId('resultWorkingRow');
  const workingUrl = byId('resultWorkingUrl');
  const copyWorking = byId('resultCopyWorking');
  const statusNote = byId('resultStatusNote');
  const copyBtn = byId('resultCopy');
  const openBtn = byId('resultOpen');
  const qrLink = byId('resultQrLink');
  const dashLink = byId('resultDashLink');
  const shareBtn = byId('resultShare');
  const editBtn = byId('resultEdit');
  const destroyBtn = byId('resultDestroy');
  const bringBackBtn = byId('resultBringBack');
  /** Destroy now and Bring back share one slot: Destroy now while the link works, Bring back once it stopped. */
  const lifeButtons = [destroyBtn, bringBackBtn];
  const summary = byId('resultSummary');
  const qrButton = byId('resultQr');
  const qrBox = byId('resultQrCode');
  const anotherBtn = byId('resultAnother');
  const announce = byId('resultAnnounce');
  const keyRow = byId('resultKeyRow');
  const keyValue = byId('resultKey');
  const keyToggle = byId('resultKeyToggle');
  const keyCopy = byId('resultKeyCopy');

  const canShare = typeof navigator.share === 'function';
  let downloading = false;
  /** Status last announced, so polls and same-status re-renders stay quiet. */
  let lastStatus = null;
  let announceTimer = 0;
  /** Manage key of the link on the panel; kept here only (never in state, never logged). */
  let currentKey = null;
  let keyRevealed = false;

  const titleFor = (link) => (link.status === 'active'
    ? 'Your Blip is ready'
    : link.status === 'destroyed' ? 'Boom. This Blip has self-destructed' : 'This Blip has expired');

  /** Speak through the dedicated polite live region (cleared first so repeats are re-read). */
  function say(text) {
    clearTimeout(announceTimer);
    announce.textContent = '';
    if (text) announceTimer = setTimeout(() => { announce.textContent = text; }, 80);
  }

  function renderKey() {
    keyRow.hidden = !currentKey;
    keyToggle.setAttribute('aria-pressed', String(keyRevealed));
    const label = keyToggle.querySelector('[data-label]');
    if (label) label.textContent = keyRevealed ? 'Hide' : 'Show';
    setIcon(keyToggle.querySelector('svg'), keyRevealed ? 'eye-off' : 'eye');
    keyValue.dataset.masked = String(!keyRevealed);
    if (!currentKey) {
      keyValue.replaceChildren();
    } else if (keyRevealed) {
      keyValue.textContent = currentKey;
    } else {
      const tail = currentKey.slice(-4);
      keyValue.replaceChildren(
        el('span', { 'aria-hidden': 'true' }, `${'•'.repeat(12)}${tail}`),
        el('span', { class: 'visually-hidden' }, `Hidden, ends in ${tail}`));
    }
  }

  function summaryItem(iconName, ...content) {
    return el('li', { class: 'result__summary-item' }, icon(iconName), el('span', {}, ...content));
  }

  function renderSummary(link) {
    const items = [];
    items.push(summaryItem('globe', link.domain, ' · ', link.domainLive ? 'live domain' : 'vanity preview'));
    if (link.redirectMode === 'teaser' && link.teaser) {
      items.push(summaryItem('clapperboard', `Teaser: ${link.teaser.seconds}s ${teaserStyleWord(link.teaser.style)} · ${themeWord(link.teaser.theme)}`));
    } else {
      items.push(summaryItem('zap', 'Instant redirect'));
    }
    if (link.status === 'active' && link.expiresAt) {
      items.push(summaryItem('timer', countdownEl(link.expiresAt), el('span', { class: 'muted' }, ` (${formatDateTime(link.expiresAt)})`)));
    } else if (link.expiresAt) {
      items.push(summaryItem('timer', `Timer ended ${formatDateTime(link.expiresAt)}`));
    } else {
      items.push(summaryItem('infinity', 'No time limit'));
    }
    if (link.maxClicks !== null && link.maxClicks !== undefined) {
      items.push(summaryItem('flame', `${formatNumber(link.clicksRemaining ?? 0)} of ${plural(link.maxClicks, 'click')} left`));
    } else {
      items.push(summaryItem('mouse-pointer-click', `${plural(link.clickCount ?? 0, 'click')} · unlimited`));
    }
    items.push(summaryItem('qr-code', `QR look: ${qrLookName(link.qrStyle)}`));
    summary.replaceChildren(...items);
  }

  function renderQr(link) {
    qrBox.replaceChildren(skeleton('span', 'result__qr-skeleton'));
    const qr = createQr(link.qrUrl, link.qrStyle || DEFAULT_QR_STYLE, { size: RESULT_QR_SIZE, type: 'svg' });
    if (!qr) {
      qrButton.hidden = true;
      return;
    }
    qrButton.hidden = false;
    qrBox.replaceChildren();
    qr.append(qrBox);
    qrButton.setAttribute('aria-label', `Download QR code for ${displayUrl(link.qrUrl)} as PNG`);
  }

  /** The sound-effect burst: BLIP! for a live link, BOOM! once it self-destructs, none when it expired. */
  function renderBurst(link, { pop = false } = {}) {
    burst.hidden = link.status === 'expired';
    burst.classList.toggle('burst--red', link.status === 'destroyed');
    burstText.textContent = link.status === 'destroyed' ? 'Boom!' : 'Blip!';
    if (pop && !burst.hidden) popBurst(burst);
  }

  function render(link) {
    section.dataset.status = link.status;
    titleIcon.replaceChildren(icon(TITLE_ICONS[link.status] || 'clock-alert'));
    titleText.textContent = titleFor(link);

    const badgeNodes = [statusBadge(link)];
    badgeNodes.push(link.domainLive
      ? el('span', { class: 'badge badge--live' }, 'live')
      : el('span', { class: 'badge badge--vanity', title: "Point this domain's DNS at your Blip server to make it live" }, 'vanity preview'));
    if (link.redirectMode === 'teaser') badgeNodes.push(el('span', { class: 'badge badge--teaser' }, 'teaser'));
    badges.replaceChildren(...badgeNodes);

    shortUrl.textContent = displayUrl(link.shortUrl);
    shortUrl.title = link.shortUrl;
    target.textContent = displayUrl(link.targetUrl);
    target.title = link.targetUrl;

    const active = link.status === 'active';
    // The working link only "works right now" while the link is active.
    workingRow.hidden = link.domainLive || !active;
    workingUrl.textContent = displayUrl(link.workingUrl);

    // Destroy now and Bring back swap places; keep keyboard focus on whichever one is now shown.
    const lifeHadFocus = lifeButtons.includes(document.activeElement);
    destroyBtn.hidden = !active;
    bringBackBtn.hidden = active;
    bringBackBtn.title = link.status === 'destroyed'
      ? 'Undo Destroy now so it works again'
      : link.expiredReason === 'clicks' ? 'Give it more clicks so it works again' : 'Give it more time so it works again';
    if (lifeHadFocus) (lifeButtons.find((btn) => !btn.hidden) || title).focus({ preventScroll: true });
    if (active) {
      statusNote.hidden = true;
    } else {
      statusNote.hidden = false;
      statusNote.textContent = link.status === 'destroyed'
        ? 'Visitors now see the “this link has self-destructed” page. Press Bring back to undo Destroy now.'
        : link.expiredReason === 'clicks'
          ? 'Its clicks are all used up, so visitors now see the self-destructed page. Press Bring back to give it more clicks.'
          : 'Its timer ran out, so visitors now see the self-destructed page. Press Bring back to give it more time.';
    }

    const slugHash = `#${encodeURIComponent(link.slug)}`;
    qrLink.href = `/qr.html${slugHash}`;
    dashLink.href = `/dashboard.html${slugHash}`;
    shareBtn.hidden = !canShare;

    renderSummary(link);
  }

  copyBtn.addEventListener('click', async () => {
    const link = state.currentLink;
    if (!link) return;
    const ok = await copyText(link.shortUrl);
    if (ok) {
      flashButton(copyBtn);
      toast(link.domainLive ? `Copied ${displayUrl(link.shortUrl)}` : `Copied ${displayUrl(link.shortUrl)}. It's a vanity preview, so share the working link for now.`, { type: 'success' });
    } else {
      toast("Couldn't copy automatically. Select the link and copy it by hand.", { type: 'error' });
    }
  });

  copyWorking.addEventListener('click', async () => {
    const link = state.currentLink;
    if (!link) return;
    const ok = await copyText(link.workingUrl);
    if (ok) {
      flashButton(copyWorking);
      toast(`Copied ${displayUrl(link.workingUrl)}`, { type: 'success' });
    } else {
      toast("Couldn't copy automatically. Select the link and copy it by hand.", { type: 'error' });
    }
  });

  openBtn.addEventListener('click', () => {
    if (state.currentLink) actions.open(state.currentLink);
  });

  shareBtn.addEventListener('click', async () => {
    const link = state.currentLink;
    if (!link) return;
    try {
      await navigator.share({ title: link.title || 'A Blip link', text: link.title || undefined, url: usableUrl(link) });
    } catch (err) {
      if (err?.name === 'AbortError') return;
      const ok = await copyText(usableUrl(link));
      toast(ok ? 'Sharing isn’t available here, so we copied the link instead.' : "Couldn't share this link.", { type: ok ? 'success' : 'error' });
    }
  });

  keyToggle.addEventListener('click', () => {
    if (!currentKey) return;
    keyRevealed = !keyRevealed;
    renderKey();
  });

  keyCopy.addEventListener('click', async () => {
    if (!currentKey) return;
    const ok = await copyText(currentKey);
    if (ok) {
      flashButton(keyCopy);
      toast('Manage key copied. Keep it private.', { type: 'success' });
    } else {
      toast("Couldn't copy automatically. Press Show, then select the key and copy it by hand.", { type: 'error' });
    }
  });

  editBtn.addEventListener('click', () => {
    if (state.currentLink) actions.editSettings(state.currentLink.slug, { focus: 'general' });
  });
  destroyBtn.addEventListener('click', () => {
    if (state.currentLink) actions.destroy(state.currentLink.slug);
  });
  bringBackBtn.addEventListener('click', () => {
    if (state.currentLink) actions.editSettings(state.currentLink.slug, { focus: 'destruct' });
  });

  qrButton.addEventListener('click', async () => {
    const link = state.currentLink;
    if (!link || downloading) return;
    const big = createQr(link.qrUrl, link.qrStyle || DEFAULT_QR_STYLE, { size: 1024, type: 'canvas' });
    if (!big) {
      toast('The QR generator is not loaded. Try the QR studio instead.', { type: 'error' });
      return;
    }
    downloading = true;
    qrButton.classList.add('is-busy');
    qrButton.setAttribute('aria-busy', 'true');
    try {
      await big.download({ name: `blip-${link.slug}`, extension: 'png' });
      toast('QR code downloaded. Print it big!', { type: 'success' });
    } catch {
      toast("Couldn't create the PNG. Try the QR studio for more download options.", { type: 'error' });
    } finally {
      downloading = false;
      qrButton.classList.remove('is-busy');
      qrButton.removeAttribute('aria-busy');
    }
  });

  anotherBtn.addEventListener('click', () => onAnother?.());

  section.addEventListener('blip:countdown-done', (event) => {
    if (state.currentLink) actions.expiryReached(state.currentLink.slug, event.detail?.expiresAt ?? state.currentLink.expiresAt);
  });

  return {
    /** Show a freshly created link, plus its manage key so it can be backed up. */
    show(link, manageToken = null) {
      state.currentLink = link;
      currentKey = typeof manageToken === 'string' && manageToken ? manageToken : null;
      keyRevealed = false;
      renderKey();
      section.hidden = false;
      render(link);
      renderQr(link);
      lastStatus = link.status;
      say(link.domainLive
        ? `Your Blip is ready: ${displayUrl(link.shortUrl)}`
        : `Your Blip is ready: ${displayUrl(link.shortUrl)}. Works right now at ${displayUrl(link.workingUrl)}`);
      const reduced = prefersReducedMotion();
      section.classList.remove('reveal');
      if (!reduced) {
        void section.offsetWidth;
        section.classList.add('reveal');
      }
      renderBurst(link, { pop: true });
      requestAnimationFrame(() => {
        section.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
        title.focus({ preventScroll: true });
      });
    },
    /** Refresh after the link changed (Destroy now / Edit settings / Bring back / poll). */
    update(link) {
      if (!state.currentLink || state.currentLink.slug !== link.slug) return;
      const qrChanged = JSON.stringify(state.currentLink.qrStyle) !== JSON.stringify(link.qrStyle) || state.currentLink.qrUrl !== link.qrUrl;
      state.currentLink = link;
      render(link);
      if (qrChanged) renderQr(link);
      if (link.status !== lastStatus) {
        lastStatus = link.status;
        renderBurst(link, { pop: true });
        say(titleFor(link));
      }
    },
    hide() {
      const hadFocus = section.contains(document.activeElement);
      state.currentLink = null;
      currentKey = null;
      keyRevealed = false;
      renderKey();
      lastStatus = null;
      say('');
      section.hidden = true;
      qrBox.replaceChildren(skeleton('span', 'result__qr-skeleton'));
      if (hadFocus) document.getElementById('targetUrl')?.focus({ preventScroll: true });
    },
    currentSlug: () => state.currentLink?.slug ?? null,
    /** Where focus lands when the Edit settings dialog closes and the button that opened it is gone. */
    settingsButton: () => (section.hidden ? null : editBtn),
  };
}

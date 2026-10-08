// Blip home page: "Playful domain" feature (domain picker + domain idea generator).

import { api, el, icon, setIcon, toast, copyText } from '../api.js';
import { state, emitChange, friendlyMessage } from './state.js';
import { byId, radioGroup, setFieldError, setBusy, skeleton } from './dom.js';

const VANITY_TIP = "Point this domain's DNS at your Blip server to make it live";
const KINDS = {
  hack: 'Domain hack',
  short: 'Short',
  playful: 'Playful',
};
const SKELETON_ROWS = 4;

export function createDomainFeature() {
  const chips = byId('domainChips');
  const note = byId('domainNote');
  const domainError = byId('domainError');
  const keyword = byId('domainKeyword');
  const keywordError = byId('domainKeywordError');
  const generateBtn = byId('domainIdeasBtn');
  const ideasStatus = byId('domainIdeasStatus');
  const ideasList = byId('domainIdeas');
  let generating = false;
  let ideaSeq = 0;

  const group = radioGroup(chips, {
    onChange: (value) => {
      state.domain = value;
      domainError.hidden = true;
      chips.classList.remove('has-error');
      renderNote();
      emitChange('domain');
    },
  });

  const currentEntry = () => state.config.domains.find((d) => d.domain === state.domain) || state.config.domains[0];

  function renderNote() {
    const entry = currentEntry();
    if (!entry) return;
    if (entry.isBase) {
      note.textContent = `${entry.domain} is this server's own address, so links work right away.`;
    } else if (entry.live) {
      note.textContent = `${entry.domain} is live: its DNS points at this Blip server, so the branded link works right away.`;
    } else {
      note.textContent = `${entry.domain} is a vanity preview. You'll get the branded link to show off, plus a working link that redirects today. ${VANITY_TIP}.`;
    }
  }

  /** Placeholder chips until /api/config answers (renderDomains() replaces them either way). */
  function renderLoading() {
    chips.setAttribute('aria-busy', 'true');
    chips.replaceChildren(...Array.from({ length: 4 }, () => skeleton('span', 'chip-skeleton')));
    note.textContent = 'Loading the domains this server offers…';
  }

  function renderDomains() {
    const domains = state.config.domains;
    if (!domains.some((d) => d.domain === state.domain)) state.domain = state.config.baseHost;
    chips.removeAttribute('aria-busy');
    chips.replaceChildren(...domains.map((d) => {
      const checked = d.domain === state.domain;
      return el('button', {
        type: 'button',
        role: 'radio',
        class: 'chip domain-chip',
        'aria-checked': String(checked),
        tabindex: checked ? '0' : '-1',
        title: d.live ? 'Live: links on this domain work right now' : VANITY_TIP,
        dataset: { value: d.domain, live: String(d.live) },
      },
      el('span', { class: 'domain-chip__name' }, d.domain),
      el('span', { class: `badge ${d.live ? 'badge--live' : 'badge--vanity'}` }, d.live ? 'live' : 'vanity'));
    }));
    group.refresh();
    renderNote();
  }

  function ideaRow(idea) {
    const kind = Object.hasOwn(KINDS, idea.kind) ? idea.kind : 'short';
    const domain = String(idea.domain);
    const noteId = `domain-idea-note-${++ideaSeq}`;
    const hintIcon = icon('copy');
    const hintText = el('span', {}, 'Click to copy');
    const row = el('li', { class: 'idea-row', dataset: { kind } });
    let resetTimer = 0;

    const copyBtn = el('button', {
      type: 'button',
      class: 'idea-row__copy',
      'aria-label': `Copy ${domain}`,
      'aria-describedby': noteId,
      on: {
        click: async () => {
          const ok = await copyText(domain);
          if (!ok) {
            toast("Couldn't copy automatically. Select the domain and copy it by hand.", { type: 'error' });
            return;
          }
          row.classList.add('is-copied');
          hintText.textContent = 'Copied';
          setIcon(hintIcon, 'check');
          clearTimeout(resetTimer);
          resetTimer = setTimeout(() => {
            row.classList.remove('is-copied');
            hintText.textContent = 'Click to copy';
            setIcon(hintIcon, 'copy');
          }, 1600);
          toast(`Copied ${domain}. Check it at your favourite registrar.`, { type: 'success' });
        },
      },
    },
    el('span', { class: 'idea-row__top' },
      el('span', { class: 'idea-row__domain' }, domain),
      el('span', { class: 'badge badge--neutral' }, KINDS[kind])),
    el('span', { class: 'idea-row__note', id: noteId }, String(idea.note || '')),
    el('span', { class: 'idea-row__hint', 'aria-hidden': 'true' }, hintIcon, hintText));

    row.append(copyBtn, el('a', {
      class: 'idea-row__check',
      href: `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(domain)}`,
      target: '_blank',
      rel: 'noopener noreferrer',
    }, 'Check availability', el('span', { class: 'visually-hidden' }, ` of ${domain} (opens in a new tab)`), icon('external-link')));
    return row;
  }

  function renderIdeas(ideas, kw) {
    ideasList.removeAttribute('aria-busy');
    if (!ideas.length) {
      ideasStatus.textContent = `No ideas for “${kw}”. Try a shorter or different word.`;
      ideasList.replaceChildren();
      return;
    }
    ideasStatus.textContent = `${ideas.length} ideas for “${kw}”. Click one to copy it.`;
    ideasList.replaceChildren(...ideas.map(ideaRow));
  }

  function renderIdeasLoading() {
    ideasStatus.textContent = 'Brainstorming…';
    ideasList.setAttribute('aria-busy', 'true');
    ideasList.replaceChildren(...Array.from({ length: SKELETON_ROWS }, () => el('li', { class: 'idea-row idea-row--skeleton', 'aria-hidden': 'true' },
      skeleton('span', 'skeleton--text'),
      skeleton('span', 'skeleton--text'))));
  }

  function renderIdeasError(message) {
    ideasList.removeAttribute('aria-busy');
    ideasStatus.textContent = '';
    ideasList.replaceChildren(el('li', { class: 'idea-row idea-row--error', role: 'alert' },
      el('p', {}, message),
      el('button', { type: 'button', class: 'btn btn--sm', on: { click: generate } }, icon('refresh-cw'), 'Retry')));
  }

  async function generate() {
    if (generating) return;
    const kw = keyword.value.trim();
    if (!kw) {
      setFieldError(keyword, keywordError, 'Type a word first: your brand, a product, a mood.');
      keyword.focus();
      return;
    }
    if (kw.length > 40) {
      setFieldError(keyword, keywordError, 'Keep it under 40 characters.');
      keyword.focus();
      return;
    }
    setFieldError(keyword, keywordError, '');
    generating = true;
    setBusy(generateBtn, true);
    renderIdeasLoading();
    try {
      const res = await api.domainIdeas(kw);
      renderIdeas(Array.isArray(res?.ideas) ? res.ideas : [], res?.keyword || kw);
    } catch (err) {
      if (err?.field === 'keyword' || err?.status === 400) {
        ideasList.removeAttribute('aria-busy');
        ideasList.replaceChildren();
        ideasStatus.textContent = '';
        setFieldError(keyword, keywordError, friendlyMessage(err, 'Try a simpler keyword (letters and numbers).'));
        keyword.focus();
      } else {
        renderIdeasError(friendlyMessage(err, "Couldn't brainstorm domains right now."));
      }
    } finally {
      generating = false;
      setBusy(generateBtn, false);
    }
  }

  generateBtn.addEventListener('click', generate);
  keyword.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      generate();
    }
  });
  keyword.addEventListener('input', () => setFieldError(keyword, keywordError, ''));

  renderLoading();

  return {
    id: 'domain',
    label: 'playful domain',
    renderDomains,
    isActive: () => state.domain !== state.config.baseHost,
    chip: () => (state.domain !== state.config.baseHost ? { icon: 'globe', text: state.domain } : null),
    stateText: () => (state.domain !== state.config.baseHost ? state.domain : 'Default'),
    apply(body) {
      body.domain = state.domain;
    },
    showError(_field, message) {
      domainError.textContent = message;
      domainError.hidden = false;
      chips.classList.add('has-error');
      group.focus();
    },
    reset() {
      group.set(state.config.baseHost, { emit: true });
      ideasList.removeAttribute('aria-busy');
      ideasList.replaceChildren();
      ideasStatus.textContent = '';
      keyword.value = '';
      setFieldError(keyword, keywordError, '');
    },
  };
}

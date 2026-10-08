// Blip home page: "Custom slug" feature (live normalization, availability, word slugs, suggestions, title).

import { api, el, icon, toast } from '../api.js';
import { state, emitChange, onChange, FieldError, friendlyMessage } from './state.js';
import { byId, radioGroup, setFieldError, setBusy, skeleton } from './dom.js';
import { normalizeSlug, phraseFromUrl } from './url.js';

const IDLE_HINT = "Leave it blank and we'll invent a fun one, like brave-otter.";
const SUGGESTION_COUNT = 6;

function reasonText(check) {
  const slug = check.normalized || '';
  switch (check.reason) {
    case 'empty': return 'Add some letters or numbers.';
    case 'invalid': return 'Use letters, numbers and dashes (up to 64 characters).';
    case 'reserved': return `“${slug}” is reserved by Blip. Pick another one.`;
    case 'taken': return `Someone already grabbed “${slug}”. Try one of these:`;
    default: return check.available ? "Available. It's all yours!" : 'That slug is not available.';
  }
}

export function createSlugFeature({ getTargetUrl }) {
  const input = byId('slugInput');
  const prefix = byId('slugPrefix');
  const preview = byId('slugPreview');
  const status = byId('slugStatus');
  const stateBox = byId('slugState');
  const clearBtn = byId('slugClear');
  const diceBtn = byId('wordSlugBtn');
  const suggestBtn = byId('suggestSlugsBtn');
  const suggestWrap = byId('slugSuggestionsWrap');
  const suggestHint = byId('slugSuggestHint');
  const suggestList = byId('slugSuggestions');
  const titleInput = byId('titleInput');
  const titleError = byId('titleError');
  const styleGroup = radioGroup(byId('slugStyle'), { onChange: () => emitChange('slug') });

  let controller = null;
  let lastCheck = null;
  let wordCache = [];
  let rolling = false;
  let suggesting = false;

  const normalizedNow = () => normalizeSlug(input.value);

  function setStatus(kind, message) {
    stateBox.dataset.state = kind;
    status.dataset.state = kind;
    status.textContent = message;
    if (kind === 'bad') input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }

  function updatePrefix() {
    prefix.textContent = `${state.domain}/`;
  }

  function updatePreview() {
    const raw = input.value.trim();
    const normalized = normalizedNow();
    clearBtn.hidden = !input.value;
    if (!raw || !normalized) {
      preview.hidden = true;
      preview.textContent = '';
      return;
    }
    preview.hidden = false;
    preview.replaceChildren(
      el('span', { class: 'visually-hidden' }, 'Your link will be '),
      icon('arrow-right'),
      el('span', { class: 'slug-preview__domain' }, `${state.domain}/`),
      el('span', { class: 'slug-preview__slug' }, normalized),
    );
  }

  async function runCheck(raw) {
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    try {
      const res = await api.checkSlug(raw, { signal: mine.signal });
      if (controller !== mine) return;
      lastCheck = res;
      if (res.available && res.valid) {
        setStatus('ok', reasonText(res));
      } else {
        setStatus('bad', reasonText(res));
        if (res.reason === 'taken') loadSuggestions(raw, { auto: true });
      }
      emitChange('slug');
    } catch (err) {
      if (err?.name === 'AbortError' || controller !== mine) return;
      setStatus('error', err?.status === 429 ? 'Checking too fast. Pause for a second.' : "Couldn't check availability right now. We'll double-check when you shorten.");
    }
  }

  let debounceTimer = 0;
  function onSlugInput() {
    clearTimeout(debounceTimer);
    controller?.abort();
    controller = null;
    lastCheck = null;
    updatePreview();
    const raw = input.value.trim();
    if (!raw) {
      setStatus('idle', IDLE_HINT);
    } else if (!normalizedNow()) {
      setStatus('bad', 'Add some letters or numbers.');
    } else {
      setStatus('checking', 'Checking availability…');
      debounceTimer = setTimeout(() => runCheck(raw), 300);
    }
    emitChange('slug');
  }

  function setSlug(value) {
    input.value = value;
    onSlugInput();
  }

  function hideSuggestions() {
    suggestWrap.hidden = true;
    suggestList.replaceChildren();
    suggestList.removeAttribute('aria-busy');
  }

  function renderSuggestionSkeleton() {
    suggestWrap.hidden = false;
    suggestHint.textContent = 'Finding free slugs…';
    suggestList.setAttribute('aria-busy', 'true');
    suggestList.replaceChildren(...Array.from({ length: SUGGESTION_COUNT }, () => skeleton('span', 'chip-skeleton')));
  }

  function renderSuggestions(list, phrase) {
    suggestWrap.hidden = false;
    suggestList.removeAttribute('aria-busy');
    if (!list.length) {
      suggestHint.textContent = phrase ? `No free slugs found for “${phrase}”. Try another phrase or roll a word slug.` : 'No suggestions right now. Roll a word slug instead.';
      suggestList.replaceChildren();
      return;
    }
    suggestHint.textContent = phrase
      ? `${list.length} ideas from “${phrase}”. Tap one to use it.`
      : `${list.length} fresh word slugs. Tap one to use it.`;
    suggestList.replaceChildren(...list.map((slug) => el('button', {
      type: 'button',
      class: 'chip suggestion-chip',
      on: {
        click: () => {
          setSlug(slug);
          input.focus();
        },
      },
    }, slug)));
  }

  function renderSuggestionError(err, phrase) {
    suggestWrap.hidden = false;
    suggestList.removeAttribute('aria-busy');
    suggestHint.textContent = friendlyMessage(err, "Couldn't fetch suggestions right now.");
    suggestList.replaceChildren(el('button', {
      type: 'button',
      class: 'btn btn--sm',
      on: { click: () => loadSuggestions(phrase) },
    }, icon('refresh-cw'), 'Retry'));
  }

  async function loadSuggestions(phrase, { auto = false } = {}) {
    if (suggesting) return;
    suggesting = true;
    if (!auto) setBusy(suggestBtn, true);
    renderSuggestionSkeleton();
    try {
      const { suggestions } = await api.suggestSlugs(phrase, SUGGESTION_COUNT);
      renderSuggestions(Array.isArray(suggestions) ? suggestions : [], phrase);
    } catch (err) {
      if (auto) hideSuggestions();
      else renderSuggestionError(err, phrase);
    } finally {
      suggesting = false;
      setBusy(suggestBtn, false);
    }
  }

  input.addEventListener('input', onSlugInput);
  input.addEventListener('blur', () => {
    // Show the user the canonical form once they're done typing.
    const normalized = normalizedNow();
    if (normalized && normalized !== input.value) {
      input.value = normalized;
      updatePreview();
    }
  });
  clearBtn.addEventListener('click', () => {
    setSlug('');
    input.focus();
  });

  diceBtn.addEventListener('click', async () => {
    if (rolling) return;
    rolling = true;
    setBusy(diceBtn, true);
    try {
      if (!wordCache.length) {
        const { suggestions } = await api.suggestSlugs('', SUGGESTION_COUNT);
        wordCache = Array.isArray(suggestions) ? suggestions.filter((s) => s !== normalizedNow()) : [];
      }
      const next = wordCache.shift();
      if (next) setSlug(next);
      else toast('No word slug came back. Try again.', { type: 'error' });
    } catch (err) {
      toast(friendlyMessage(err, "Couldn't roll a word slug right now."), { type: 'error' });
    } finally {
      rolling = false;
      setBusy(diceBtn, false);
    }
  });

  suggestBtn.addEventListener('click', () => {
    const phrase = (normalizedNow() ? input.value.trim() : '') || titleInput.value.trim() || phraseFromUrl(getTargetUrl());
    loadSuggestions(phrase.slice(0, 60));
  });

  titleInput.addEventListener('input', () => {
    setFieldError(titleInput, titleError, '');
    emitChange('slug');
  });

  onChange((source) => {
    if (source === 'domain' || source === 'config') {
      updatePrefix();
      updatePreview();
    }
  });
  updatePrefix();
  setStatus('idle', IDLE_HINT);

  return {
    id: 'slug',
    label: 'custom slug',
    isActive: () => Boolean(normalizedNow()),
    chip: () => (normalizedNow() ? { icon: 'pencil-line', text: `/${normalizedNow()}` } : null),
    stateText: () => {
      if (normalizedNow()) return `/${normalizedNow()}`;
      return styleGroup.value === 'random' ? 'Random slug' : 'Word slug';
    },
    /** Slug currently typed (normalized) or an empty string; used by the QR preview. */
    currentSlug: normalizedNow,
    setValue(value) {
      setSlug(String(value ?? ''));
    },
    apply(body) {
      const raw = input.value.trim();
      if (raw) {
        const normalized = normalizedNow();
        if (!normalized) throw new FieldError('slug', 'Add some letters or numbers to your slug.');
        if (lastCheck && lastCheck.normalized === normalized && !(lastCheck.valid && lastCheck.available)) {
          throw new FieldError('slug', reasonText(lastCheck).replace(/ Try one of these:$/, ' Pick a suggestion or try another.'));
        }
        body.slug = normalized;
      } else {
        body.slugStyle = styleGroup.value === 'random' ? 'random' : 'words';
      }
      const title = titleInput.value.trim();
      if (title) body.title = title;
    },
    showError(field, message) {
      if (field === 'title') {
        setFieldError(titleInput, titleError, message);
        titleInput.focus();
        return;
      }
      if (field === 'slugStyle') {
        toast(message, { type: 'error' });
        styleGroup.focus();
        return;
      }
      setStatus('bad', message);
      input.focus();
      if (/taken/i.test(message) || /grabbed/i.test(message)) loadSuggestions(input.value.trim(), { auto: true });
    },
    afterCreate() {
      setSlug('');
      titleInput.value = '';
      hideSuggestions();
      wordCache = [];
    },
    reset() {
      setSlug('');
      titleInput.value = '';
      setFieldError(titleInput, titleError, '');
      styleGroup.set('words');
      hideSuggestions();
      emitChange('slug');
    },
  };
}

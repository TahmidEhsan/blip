// Blip home page: small DOM utilities (lookups, radio groups, field errors, button feedback).

export function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Blip home: missing #${id} in index.html`);
  return node;
}

/**
 * Accessible single-choice group built from buttons with role="radio".
 * Click or arrow keys select; roving tabindex keeps one stop in the tab order.
 */
export function radioGroup(container, { onChange } = {}) {
  const items = () => [...container.querySelectorAll('[role="radio"]')];

  function select(item, { focus = false, emit = true } = {}) {
    for (const it of items()) {
      const on = it === item;
      it.setAttribute('aria-checked', String(on));
      it.tabIndex = on ? 0 : -1;
    }
    if (focus) item.focus();
    if (emit) onChange?.(item.dataset.value, item);
  }

  container.addEventListener('click', (event) => {
    const item = event.target.closest('[role="radio"]');
    if (!item || !container.contains(item) || item.disabled) return;
    // Re-clicking the checked item still emits, so "I chose the default on purpose" counts.
    select(item, { emit: true });
  });

  container.addEventListener('keydown', (event) => {
    const keys = ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const list = items().filter((it) => !it.disabled);
    const current = list.indexOf(document.activeElement);
    if (current === -1 || !list.length) return;
    event.preventDefault();
    let next = current;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (current + 1) % list.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (current - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    select(list[next], { focus: true });
  });

  const api = {
    get value() {
      return items().find((it) => it.getAttribute('aria-checked') === 'true')?.dataset.value ?? null;
    },
    /** Select by value without firing onChange (unless emit: true). */
    set(value, { emit = false } = {}) {
      const item = items().find((it) => it.dataset.value === value);
      if (item) select(item, { emit });
      return Boolean(item);
    },
    /** Re-apply roving tabindex after items were (re)rendered. */
    refresh() {
      const list = items();
      const checked = list.find((it) => it.getAttribute('aria-checked') === 'true') || list[0];
      for (const it of list) it.tabIndex = it === checked ? 0 : -1;
    },
    focus() {
      const list = items();
      (list.find((it) => it.getAttribute('aria-checked') === 'true') || list[0])?.focus();
    },
  };
  api.refresh();
  return api;
}

/** Show / clear an inline error for a control (sets aria-invalid, which draws the red outline). */
export function setFieldError(control, errorEl, message) {
  if (message) {
    control?.setAttribute('aria-invalid', 'true');
    if (errorEl) {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }
  } else {
    control?.removeAttribute('aria-invalid');
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.hidden = true;
    }
  }
}

/** Temporarily swap a button's [data-label] text (e.g. "Copied!") and add .is-done (green). */
export function flashButton(button, text = 'Copied!', ms = 1600) {
  if (!button) return;
  const label = button.querySelector('[data-label]');
  if (label && !label.dataset.original) label.dataset.original = label.textContent;
  if (label) label.textContent = text;
  button.classList.add('is-done');
  clearTimeout(button._flashTimer);
  button._flashTimer = setTimeout(() => {
    if (label) label.textContent = label.dataset.original || label.textContent;
    button.classList.remove('is-done');
  }, ms);
}

/** Toggle the shared .is-loading spinner state on a .btn (callers also guard re-entry). */
export function setBusy(button, busy) {
  if (!button) return;
  button.classList.toggle('is-loading', busy);
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

export function isTypingTarget(node) {
  if (!node || node === document.body) return false;
  return Boolean(node.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
}

/** Placeholder rows/chips while something loads (halftone skeleton blocks from theme.css). */
export function skeleton(tag = 'span', className = '') {
  const node = document.createElement(tag);
  node.className = `skeleton${className ? ` ${className}` : ''}`;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

// Blip dashboard: small UI helpers (loading states, accessible radio groups and tabs, debounce).

/**
 * Put sections into (or out of) their skeleton state. CSS shows [data-skeleton] and hides
 * [data-content] inside anything with .is-loading; aria-busy tells assistive tech to wait.
 * @param {(HTMLElement|null)[]} nodes
 * @param {boolean} on
 */
export function setLoading(nodes, on) {
  for (const node of nodes) {
    if (!node) continue;
    node.classList.toggle('is-loading', on);
    if (on) node.setAttribute('aria-busy', 'true');
    else node.removeAttribute('aria-busy');
  }
}

/**
 * Wire a .segmented[role=radiogroup] of <button role="radio"> elements: click + arrow keys,
 * roving tabindex, aria-checked. Returns { set(value, { focus, notify }) }.
 * @param {HTMLElement} group
 * @param {string} attr data attribute holding the value (e.g. "range")
 * @param {(value: string) => void} onChange
 */
export function radioGroup(group, attr, onChange) {
  const buttons = () => [...group.querySelectorAll('[role="radio"]')];

  function set(value, { focus = false, notify = false } = {}) {
    let matched = null;
    for (const b of buttons()) {
      const on = b.dataset[attr] === value;
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
      if (on) matched = b;
    }
    if (!matched) {
      const first = buttons()[0];
      if (first) first.tabIndex = 0;
      return;
    }
    if (focus) matched.focus();
    if (notify) onChange(value);
  }

  group.addEventListener('click', (event) => {
    const b = event.target.closest('[role="radio"]');
    if (!b || !group.contains(b)) return;
    if (b.getAttribute('aria-checked') === 'true') return;
    set(b.dataset[attr], { notify: true });
  });

  group.addEventListener('keydown', (event) => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in keys)) return;
    const list = buttons();
    const current = list.findIndex((b) => b === document.activeElement);
    if (current === -1) return;
    event.preventDefault();
    const step = keys[event.key];
    let next;
    if (step === -Infinity) next = 0;
    else if (step === Infinity) next = list.length - 1;
    else next = (current + step + list.length) % list.length;
    set(list[next].dataset[attr], { focus: true, notify: true });
  });

  return { set };
}

/**
 * WAI-ARIA tabs: role="tablist" of role="tab" buttons, each with aria-controls naming its tabpanel.
 * Click or arrow keys / Home / End select a tab (automatic activation) and show its panel.
 * @param {HTMLElement} tablist
 * @param {{ onChange?: (name: string) => void }} [opts]
 * @returns {{ select(name: string, opts?: { focus?: boolean }): void, selected(): string|null }}
 */
export function tabs(tablist, { onChange } = {}) {
  const all = () => [...tablist.querySelectorAll('[role="tab"]')];
  let current = null;

  function select(name, { focus = false } = {}) {
    const list = all();
    const target = list.find((t) => t.dataset.tab === name) || list[0];
    if (!target) return;
    for (const tab of list) {
      const on = tab === target;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(tab.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    }
    if (focus) target.focus();
    if (current !== target.dataset.tab) {
      current = target.dataset.tab;
      onChange?.(current);
    }
  }

  tablist.addEventListener('click', (event) => {
    const tab = event.target.closest('[role="tab"]');
    if (tab && tablist.contains(tab)) select(tab.dataset.tab);
  });

  tablist.addEventListener('keydown', (event) => {
    const keys = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in keys)) return;
    const list = all();
    const at = list.findIndex((t) => t === document.activeElement);
    if (at === -1) return;
    event.preventDefault();
    const step = keys[event.key];
    let next;
    if (step === -Infinity) next = 0;
    else if (step === Infinity) next = list.length - 1;
    else next = (at + step + list.length) % list.length;
    select(list[next].dataset.tab, { focus: true });
  });

  return { select, selected: () => current };
}

/** Trailing debounce: runs `wait` ms after the last call. Exposes cancel() and flush(). */
export function createDebounce(fn, wait) {
  let timer = null;
  const run = () => {
    clearTimeout(timer);
    timer = null;
    fn();
  };
  const debounced = () => {
    clearTimeout(timer);
    timer = setTimeout(run, wait);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  debounced.flush = () => {
    if (timer) run();
  };
  return debounced;
}

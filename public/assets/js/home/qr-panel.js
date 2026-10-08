// Blip home page: "QR studio" feature (preset look + centre logo, sent as qrStyle on create).

import { el, icon, toast } from '../api.js';
import { QR_PRESETS, LOGOS, presetStyle, normalizeQrStyle, serializeQrStyle, createQr, buildQrOptions } from '../qr-shared.js';
import { qrLookName, qrSwatch, DEFAULT_PRESET } from './qr-render.js';
import { emitChange } from './state.js';
import { byId, radioGroup } from './dom.js';

const PREVIEW_SIZE = 160;

/** Short tag for the feature tile: "Hero look", "Ink + Cat", "Pop, no logo". */
const lookTag = (name) => (/[\s,+]/.test(name) ? name : `${name} look`);

export function createQrFeature({ getPreviewUrl, getPreviewNote = () => '' }) {
  const presetList = byId('qrPresetList');
  const logoList = byId('qrLogoList');
  const stage = byId('qrPanelPreview');
  const caption = byId('qrPanelCaption');
  const errorEl = byId('qrError');

  let touched = false;
  let presetId = DEFAULT_PRESET;
  let logoId = QR_PRESETS[DEFAULT_PRESET].logo;
  let qr = null;
  let panelOpen = false;
  let renderTimer = 0;

  presetList.replaceChildren(...Object.entries(QR_PRESETS).map(([id, p]) => {
    const checked = id === presetId;
    return el('button', {
      type: 'button',
      role: 'radio',
      class: 'qr-preset',
      'aria-checked': String(checked),
      tabindex: checked ? '0' : '-1',
      dataset: { value: id },
    }, qrSwatch(p), el('span', { class: 'qr-preset__label' }, p.label));
  }));

  logoList.replaceChildren(...Object.entries(LOGOS).map(([id, logo]) => {
    const checked = id === logoId;
    return el('button', {
      type: 'button',
      role: 'radio',
      class: 'qr-logo',
      'aria-checked': String(checked),
      tabindex: checked ? '0' : '-1',
      dataset: { value: id },
    },
    logo.src
      ? el('img', { class: 'qr-logo__img', src: logo.src, alt: '', width: '30', height: '30', decoding: 'async' })
      : el('span', { class: 'qr-logo__none', 'aria-hidden': 'true' }, icon('ban')),
    el('span', { class: 'qr-logo__label' }, logo.label));
  }));

  const presets = radioGroup(presetList, {
    onChange: (value) => {
      presetId = value;
      logoId = QR_PRESETS[value]?.logo ?? 'none';
      logos.set(logoId);
      touch();
    },
  });
  const logos = radioGroup(logoList, {
    onChange: (value) => {
      logoId = value;
      touch();
    },
  });

  function currentStyle() {
    const base = presetStyle(presetId);
    // Keep the preset id as the base look even when only the logo differs, so the QR studio
    // can still highlight it; the logo is stored separately.
    return normalizeQrStyle({ ...base, logo: logoId, preset: presetId });
  }

  function touch() {
    touched = true;
    errorEl.hidden = true;
    scheduleRender();
    emitChange('qr');
  }

  function render() {
    if (!panelOpen) return;
    const data = getPreviewUrl();
    const style = currentStyle();
    const opts = { size: PREVIEW_SIZE, type: 'svg' };
    if (!qr) {
      qr = createQr(data, style, opts);
      if (!qr) {
        stage.replaceChildren(el('p', { class: 'qr-preview__fallback' }, 'QR preview unavailable. Reload the page to try again.'));
        return;
      }
      stage.replaceChildren();
      qr.append(stage);
    } else {
      qr.update(buildQrOptions(data, style, opts));
    }
    const note = getPreviewNote();
    caption.textContent = `Preview: ${data.replace(/^https?:\/\//, '')}${note ? `. ${note}` : ''}`;
  }

  function scheduleRender() {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 120);
  }

  const labelText = () => qrLookName(currentStyle());

  return {
    id: 'qr',
    label: 'QR studio',
    isActive: () => touched,
    chip: () => (touched ? { icon: 'qr-code', text: `QR: ${labelText()}` } : null),
    stateText: () => lookTag(touched ? labelText() : QR_PRESETS[DEFAULT_PRESET].label),
    /** Re-render the preview (e.g. slug or domain changed). */
    refreshPreview: scheduleRender,
    onToggle(open) {
      panelOpen = open;
      if (open) render();
    },
    apply(body) {
      if (touched) body.qrStyle = serializeQrStyle(currentStyle());
    },
    showError(_field, message) {
      errorEl.textContent = message;
      errorEl.hidden = false;
      presets.focus();
      toast(message, { type: 'error' });
    },
    reset() {
      touched = false;
      presetId = DEFAULT_PRESET;
      logoId = QR_PRESETS[DEFAULT_PRESET].logo;
      presets.set(presetId);
      logos.set(logoId);
      errorEl.hidden = true;
      scheduleRender();
      emitChange('qr');
    },
  };
}

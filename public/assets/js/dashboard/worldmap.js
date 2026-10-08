// Blip dashboard: world choropleth printed comic style. Land in --heat-0 with thin ink borders, countries
// shaded on the --heat-1..4 ramp, a halftone sea, ink-outlined city marks and a small pop-in burst
// where each live click lands. Countries come from /vendor/countries-110m.json (world-atlas) and are
// matched to stats by ISO numeric id.
import { el, icon, formatNumber } from '../api.js';
import { createTooltip } from './tooltip.js';
import { readPalette, clickKind } from './constants.js';
import { loadLib } from './vendor.js';

const TOPOLOGY_URL = '/vendor/countries-110m.json';
const ANTARCTICA = 10;
const MAX_HITS = 30;
const HIT_LIFETIME = 2600; // ms, matches the hit-pop keyframes in dashboard.css
const LOAD_ERROR = "The world map couldn't load. Every country is still listed under Breakdown, Countries.";
let uid = 0;

const plural = (n, one, many) => `${formatNumber(n)} ${n === 1 ? one : many}`;

// The jagged impact outline of theme.css .burst (its clip-path polygon), as unit vectors from the
// centre: 12 uneven spikes with the inner points at about 0.7 of the radius. The legend keys in
// dashboard.html use the same outline.
const BURST_OUTLINE = [
  [0, -1], [0.18, -0.66], [0.54, -0.88], [0.5, -0.48], [0.92, -0.56], [0.68, -0.22],
  [1, 0], [0.68, 0.22], [0.92, 0.56], [0.5, 0.48], [0.54, 0.88], [0.18, 0.66],
  [0, 1], [-0.18, 0.66], [-0.54, 0.88], [-0.5, 0.48], [-0.92, 0.56], [-0.68, 0.22],
  [-1, 0], [-0.68, -0.22], [-0.92, -0.56], [-0.5, -0.48], [-0.54, -0.88], [-0.18, -0.66],
];

/** Polygon points of the comic impact burst at radius r, centred on 0,0. */
function burstPoints(r) {
  return BURST_OUTLINE.map(([x, y]) => `${(x * r).toFixed(2)},${(y * r).toFixed(2)}`).join(' ');
}

/**
 * Sequential classes for the choropleth. Up to 4 clicks each count gets its own step; above that the
 * four steps split the range on a square-root scale so a few busy countries don't flatten the rest.
 * @returns {{lo: number, hi: number}[]} at most four bins, ascending, covering 1..max
 */
export function heatBins(max) {
  const top = Math.max(0, Math.floor(max));
  if (top <= 0) return [];
  if (top <= 4) return Array.from({ length: top }, (_, i) => ({ lo: i + 1, hi: i + 1 }));
  const edges = [0];
  for (let i = 1; i < 4; i += 1) edges.push(Math.max(edges[i - 1] + 1, Math.round(top * (i / 4) ** 2)));
  edges.push(top);
  return [1, 2, 3, 4].map((i) => ({ lo: edges[i - 1] + 1, hi: edges[i] }));
}

/**
 * @param {HTMLElement} container positioned element with a CSS size (the SVG fills it)
 * @param {{ legend?: HTMLElement }} [opts] <ul> that receives the colour scale entries
 */
export function createWorldMap(container, { legend } = {}) {
  const d3 = window.d3;
  const id = `blip-map-${++uid}`;
  const pal = readPalette();
  const tip = createTooltip(container);

  const svg = d3.select(container)
    .insert('svg', ':first-child')
    .attr('class', 'map-svg')
    .attr('role', 'img')
    .attr('aria-label', 'World map of clicks by country');

  // Halftone sea: blue print dots on the panel colour (flat fills, no gradient).
  const sea = svg.append('defs')
    .append('pattern')
    .attr('id', `${id}-sea`)
    .attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 9)
    .attr('height', 9);
  sea.append('rect').attr('width', 9).attr('height', 9).attr('fill', pal.panel);
  sea.append('circle').attr('cx', 2.25).attr('cy', 2.25).attr('r', 1.15).attr('fill', pal.blue).attr('fill-opacity', 0.45);
  sea.append('circle').attr('cx', 6.75).attr('cy', 6.75).attr('r', 1.15).attr('fill', pal.blue).attr('fill-opacity', 0.45);

  const spherePath = svg.append('path').attr('class', 'map-sphere').attr('fill', `url(#${id}-sea)`);
  const gLand = svg.append('g').attr('class', 'map-land');
  const gPoints = svg.append('g').attr('class', 'map-points');
  const gHits = svg.append('g').attr('class', 'map-hits');

  // Block skeleton over the map box while the country shapes load (the stats can arrive first).
  const skeleton = el('div', { class: 'skeleton map-skeleton', 'aria-hidden': 'true' });
  // Failure message with a Retry button, centred over the empty map box.
  const statusText = el('span', { class: 'map-status__text' });
  const retryBtn = el(
    'button',
    { type: 'button', class: 'btn btn--sm map-status__retry', hidden: true },
    icon('rotate-cw'),
    el('span', {}, 'Retry'),
  );
  const status = el('div', { class: 'map-status', role: 'status', hidden: true }, statusText, retryBtn);
  const note = el('p', { class: 'caption caption--paper map-note', hidden: true }, 'No located clicks yet');
  container.append(skeleton, status, note);
  container.setAttribute('aria-busy', 'true');

  let features = null;
  const featureByNum = new Map();
  let topoLoading = false;
  let projection = null;
  let geoPath = null;
  let lastWidth = 0;
  let lastHeight = 0;
  let data = { countries: [], points: [], total: 0 };
  let countsByNum = new Map();
  let nameByCode = new Map();
  let bins = [];

  function setStatus(text, { retry = false } = {}) {
    statusText.textContent = text || '';
    retryBtn.hidden = !retry;
    status.hidden = !text;
  }

  function setRetryBusy(busy) {
    retryBtn.classList.toggle('is-loading', busy);
    if (busy) retryBtn.setAttribute('aria-busy', 'true');
    else retryBtn.removeAttribute('aria-busy');
  }

  function stopLoading() {
    skeleton.remove();
    container.removeAttribute('aria-busy');
  }

  /**
   * Fetch the country shapes. The first attempt runs behind the skeleton; a retry keeps the message up
   * and spins the Retry button instead, so keyboard focus stays on it if the map fails again.
   */
  async function loadTopology({ fromRetry = false } = {}) {
    if (topoLoading || features) return;
    topoLoading = true;
    const retryHadFocus = fromRetry && document.activeElement === retryBtn;
    if (fromRetry) setRetryBusy(true);
    try {
      await loadLib('topojson');
      // A retry skips the HTTP cache so a bad cached copy can't fail the same way again.
      const res = await fetch(TOPOLOGY_URL, { cache: fromRetry ? 'reload' : 'force-cache' });
      if (!res.ok) throw new Error(`Map data request failed (${res.status})`);
      const topo = await res.json();
      const fc = window.topojson.feature(topo, topo.objects.countries);
      const loaded = fc.features
        .filter((f) => Number(f.id) !== ANTARCTICA)
        .map((f, i) => {
          f.num = f.id === undefined || f.id === null ? NaN : Number(f.id);
          f.key = Number.isFinite(f.num) ? `n${f.num}` : `x${i}`;
          return f;
        });
      featureByNum.clear();
      for (const f of loaded) if (Number.isFinite(f.num)) featureByNum.set(f.num, f);
      features = loaded;
      stopLoading();
      setStatus('');
      render();
      // The Retry button is gone: hand focus to the map itself, which describes what it shows.
      if (retryHadFocus) {
        svg.attr('tabindex', -1);
        svg.node().focus();
      }
    } catch (err) {
      console.error(err);
      stopLoading();
      setStatus(LOAD_ERROR, { retry: true });
      note.hidden = true;
    } finally {
      topoLoading = false;
      setRetryBusy(false);
    }
  }

  retryBtn.addEventListener('click', () => loadTopology({ fromRetry: true }));

  /** Step 0 (no clicks) to 4 on the heat ramp. */
  function heatStep(count) {
    if (!(count > 0) || !bins.length) return 0;
    if (bins.length < 4) return Math.min(4, Math.max(1, Math.round(count)));
    const at = bins.findIndex((b) => count <= b.hi);
    return at === -1 ? 4 : at + 1;
  }

  const fillFor = (feature) => pal.heat[heatStep(countsByNum.get(feature.num)?.count || 0)];

  function countryName(feature) {
    return countsByNum.get(feature.num)?.name || feature.properties?.name || 'Unknown';
  }

  function showCountryTip(event, feature) {
    const c = countsByNum.get(feature.num);
    const [mx, my] = d3.pointer(event, container);
    const share = c && data.total > 0 ? Math.round((c.count / data.total) * 1000) / 10 : 0;
    tip.show(mx, my, {
      label: countryName(feature),
      value: c ? plural(c.count, 'click', 'clicks') : 'No clicks yet',
      sub: c && data.total > 0 ? `${share}% of located clicks` : '',
    });
  }

  function showCityTip(event, p) {
    const [mx, my] = d3.pointer(event, container);
    const country = p.country ? nameByCode.get(p.country) || p.country : '';
    tip.show(mx, my, {
      label: p.city ? `${p.city}${country ? `, ${country}` : ''}` : country || 'Unknown place',
      value: plural(p.count, 'click', 'clicks'),
    });
  }

  function computeScales() {
    countsByNum = new Map();
    nameByCode = new Map();
    let max = 0;
    for (const c of data.countries) {
      if (c?.code && c.name) nameByCode.set(c.code, c.name);
      const n = c?.numeric === null || c?.numeric === undefined ? NaN : Number(c.numeric);
      if (!Number.isFinite(n) || !(c.count > 0)) continue;
      const prev = countsByNum.get(n);
      countsByNum.set(n, prev ? { ...prev, count: prev.count + c.count } : c);
      max = Math.max(max, countsByNum.get(n).count);
    }
    bins = heatBins(max);
    renderLegend();
  }

  function renderLegend() {
    if (!legend) return;
    const entry = (step, text) => el('li', {}, el('span', { class: `swatch swatch--heat-${step}`, 'aria-hidden': 'true' }), el('span', {}, text));
    const items = [entry(0, 'None')];
    bins.forEach((b, i) => {
      const step = bins.length < 4 ? b.hi : i + 1;
      items.push(entry(step, b.lo === b.hi ? formatNumber(b.lo) : `${formatNumber(b.lo)}-${formatNumber(b.hi)}`));
    });
    legend.replaceChildren(...items);
  }

  function paintCountries() {
    gLand.selectAll('path.country')
      .classed('has-clicks', (d) => countsByNum.has(d.num))
      .attr('fill', fillFor);
  }

  function paintPoints() {
    if (!projection) return;
    const pts = (data.points || [])
      .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon) && p.count > 0)
      .map((p) => ({ ...p, xy: projection([p.lon, p.lat]) }))
      .filter((p) => p.xy && Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1]))
      .sort((a, b) => b.count - a.count);
    const maxP = d3.max(pts, (p) => p.count) || 1;
    const compact = lastWidth < 520;
    const r = d3.scaleSqrt().domain([0, maxP]).range([0, compact ? 6 : 10]);
    const radius = (p) => Math.max(compact ? 2.6 : 3.2, r(p.count));

    gPoints.selectAll('g.city')
      .data(pts, (p) => `${p.lat},${p.lon},${p.city || ''}`)
      .join(
        (enter) => {
          const g = enter.append('g').attr('class', 'city');
          g.append('circle').attr('class', 'city__dot').attr('fill', pal.blue);
          g.append('circle').attr('class', 'city__hit');
          return g;
        },
        (update) => update,
        (exit) => exit.remove(),
      )
      .attr('transform', (p) => `translate(${p.xy[0]},${p.xy[1]})`)
      .each(function eachCity(p) {
        const g = d3.select(this);
        const rr = radius(p);
        g.select('.city__dot').attr('r', rr);
        g.select('.city__hit').attr('r', Math.max(12, rr + 5));
      })
      .on('pointerenter', function onEnter() { d3.select(this).classed('is-hover', true); })
      .on('pointermove', (event, p) => showCityTip(event, p))
      .on('pointerleave', function onLeave() {
        d3.select(this).classed('is-hover', false);
        tip.hide();
      });
  }

  function render() {
    const width = Math.floor(container.clientWidth);
    const height = Math.floor(container.clientHeight);
    if (!width || !height || !features) return;
    lastWidth = width;
    lastHeight = height;
    svg.attr('width', width).attr('height', height).attr('viewBox', `0 0 ${width} ${height}`);

    // Fit the land (Antarctica left out) so countries get the room; the sea outline may run past the frame.
    projection = d3.geoNaturalEarth1().fitExtent([[8, 8], [width - 8, height - 8]], { type: 'FeatureCollection', features });
    geoPath = d3.geoPath(projection);
    spherePath.attr('d', geoPath({ type: 'Sphere' }));

    gLand.selectAll('path.country')
      .data(features, (f) => f.key)
      .join('path')
      .attr('class', 'country')
      .attr('d', geoPath)
      .on('pointerenter', function onEnter(event, f) {
        d3.select(this).raise().classed('is-hover', true);
        showCountryTip(event, f);
      })
      .on('pointermove', (event, f) => showCountryTip(event, f))
      .on('pointerleave', function onLeave() {
        d3.select(this).classed('is-hover', false);
        tip.hide();
      });

    gHits.selectAll('*').remove();
    paintCountries();
    paintPoints();
    describe();
  }

  function describe() {
    const top = [...countsByNum.values()].sort((a, b) => b.count - a.count).slice(0, 3);
    const label = top.length
      ? `World map of clicks by country. ${plural(countsByNum.size, 'country', 'countries')} with clicks; top: ${top.map((c) => `${c.name} ${formatNumber(c.count)}`).join(', ')}. The Countries tab under Breakdown lists every value.`
      : 'World map of clicks by country. No located clicks yet.';
    svg.attr('aria-label', label);
    note.hidden = !features || countsByNum.size > 0 || (data.points || []).length > 0;
  }

  /** A small pop-in burst where a live click landed (no rings, no glow). */
  function ping(evt) {
    if (!projection || !geoPath || document.hidden) return;
    let xy = null;
    if (Number.isFinite(evt?.lat) && Number.isFinite(evt?.lon)) xy = projection([evt.lon, evt.lat]);
    const num = evt?.numeric === null || evt?.numeric === undefined ? NaN : Number(evt.numeric);
    const feature = Number.isFinite(num) ? featureByNum.get(num) : null;
    if (!xy && feature) {
      const c = geoPath.centroid(feature);
      if (Number.isFinite(c[0]) && Number.isFinite(c[1])) xy = c;
    }
    if (!xy || !Number.isFinite(xy[0]) || !Number.isFinite(xy[1])) return;

    const g = gHits.append('g')
      .attr('class', `map-hit map-hit--${clickKind(evt)}`)
      .attr('transform', `translate(${xy[0]},${xy[1]})`);
    g.append('polygon').attr('class', 'map-hit__burst').attr('points', burstPoints(lastWidth < 520 ? 8 : 11));
    setTimeout(() => g.remove(), HIT_LIFETIME);

    const nodes = gHits.selectAll('g.map-hit').nodes();
    if (nodes.length > MAX_HITS) nodes.slice(0, nodes.length - MAX_HITS).forEach((n) => n.remove());
  }

  const ro = new ResizeObserver(() => {
    const w = Math.floor(container.clientWidth);
    const h = Math.floor(container.clientHeight);
    if (w && h && (w !== lastWidth || h !== lastHeight)) render();
  });
  ro.observe(container);
  const onVisibility = () => {
    if (document.hidden) gHits.selectAll('*').remove();
  };
  document.addEventListener('visibilitychange', onVisibility);
  loadTopology();

  return {
    /**
     * @param {{code: string|null, numeric: string|null, name: string|null, count: number}[]} countries
     * @param {{lat: number, lon: number, city: string|null, country: string|null, count: number}[]} points
     */
    update(countries, points) {
      const list = Array.isArray(countries) ? countries : [];
      data = {
        countries: list,
        points: Array.isArray(points) ? points : [],
        total: list.reduce((sum, c) => sum + (c?.numeric ? Number(c.count) || 0 : 0), 0),
      };
      computeScales();
      if (!features) return;
      if (!projection || !lastWidth) {
        render();
        return;
      }
      paintCountries();
      paintPoints();
      describe();
    },
    ping,
    clearPings() {
      gHits.selectAll('*').remove();
    },
    destroy() {
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

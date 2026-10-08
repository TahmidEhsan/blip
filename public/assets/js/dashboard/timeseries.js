// Blip dashboard: "Clicks over time". A flat halftone area (an SVG <pattern> of print dots, no gradient),
// a 3px blue line with square markers, ink axes, a caption-box tooltip and keyboard scrubbing.
// Drawn instantly: no transitions between ranges (the section shows a skeleton while it loads).
import { el, formatNumber } from '../api.js';
import { createTooltip } from './tooltip.js';
import { readPalette } from './constants.js';

const HOUR = 3_600_000;
const MARKER = 9; // square marker size (px)
const MARKER_SPACING = 16; // draw per-bucket markers only when buckets are at least this far apart
let uid = 0;

const fmtHourTick = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });
const fmtDayTick = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const fmtTime = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fmtDayLong = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

/** Human label for a bucket ("Tue, Oct 7, 2026" or "Oct 7, 3:00 PM to 4:00 PM"). */
export function bucketLabel(date, bucket) {
  if (bucket === 'hour') {
    const end = new Date(date.getTime() + HOUR);
    return `${fmtDayTick.format(date)}, ${fmtTime.format(date)} to ${fmtTime.format(end)}`;
  }
  return fmtDayLong.format(date);
}

function tickLabel(date, bucket) {
  if (bucket === 'hour') return date.getHours() === 0 ? fmtDayTick.format(date) : fmtHourTick.format(date);
  return fmtDayTick.format(date);
}

/**
 * @param {HTMLElement} container positioned element with a CSS height (the SVG fills it)
 * @returns {{ update(points: {t: string, clicks: number}[], bucket: 'hour'|'day', opts?: {rangeLabel?: string}): void, render(): void, destroy(): void }}
 */
export function createTimeseriesChart(container) {
  const d3 = window.d3;
  const id = `blip-ts-${++uid}`;
  const pal = readPalette();
  const tip = createTooltip(container);
  const note = el('p', { class: 'caption caption--paper chart-note', hidden: true }, 'No clicks in this range yet');
  container.append(note);

  const svg = d3.select(container)
    .insert('svg', ':first-child')
    .attr('class', 'ts-svg')
    .attr('role', 'img')
    .attr('tabindex', 0)
    .attr('aria-roledescription', 'interactive chart')
    .attr('aria-label', 'Clicks over time');

  // Ben-Day halftone: two offset print dots per 8px tile, flat colour.
  const dots = svg.append('defs')
    .append('pattern')
    .attr('id', `${id}-dots`)
    .attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 8)
    .attr('height', 8);
  dots.append('circle').attr('cx', 2).attr('cy', 2).attr('r', 1.5).attr('fill', pal.blue);
  dots.append('circle').attr('cx', 6).attr('cy', 6).attr('r', 1.5).attr('fill', pal.blue);

  const root = svg.append('g').attr('class', 'ts-root');
  const gGrid = root.append('g').attr('class', 'ts-grid');
  const areaPath = root.append('path').attr('class', 'ts-area').attr('fill', `url(#${id}-dots)`);
  const gX = root.append('g').attr('class', 'ts-axis ts-axis--x');
  const gY = root.append('g').attr('class', 'ts-axis ts-axis--y');
  const linePath = root.append('path').attr('class', 'ts-line').attr('stroke', pal.blue);
  const gMarkers = root.append('g').attr('class', 'ts-markers');
  const gPeak = root.append('g').attr('class', 'ts-peak');
  const crosshair = root.append('line').attr('class', 'ts-crosshair').attr('visibility', 'hidden');
  const focusMark = root.append('rect')
    .attr('class', 'ts-focus')
    .attr('width', 13)
    .attr('height', 13)
    .attr('fill', pal.red)
    .attr('visibility', 'hidden');
  const overlay = root.append('rect').attr('class', 'ts-overlay');

  let points = [];
  let bucket = 'day';
  let rangeLabel = '';
  let geometry = null; // { x, y, iw, ih, margin }
  let focusIndex = -1;
  let lastWidth = 0;
  let lastHeight = 0;
  let dirty = false;

  const xAt = (i) => (geometry ? geometry.x(points.length === 1 ? 0 : i) : 0);

  function showIndex(i) {
    if (!geometry || !points.length) return;
    focusIndex = Math.max(0, Math.min(points.length - 1, i));
    const p = points[focusIndex];
    const cx = xAt(focusIndex);
    const cy = geometry.y(p.clicks);
    crosshair.attr('x1', cx).attr('x2', cx).attr('y1', 0).attr('y2', geometry.ih).attr('visibility', 'visible');
    focusMark.attr('x', cx - 6.5).attr('y', cy - 6.5).attr('visibility', 'visible');
    tip.show(geometry.margin.left + cx, geometry.margin.top + cy, {
      label: bucketLabel(p.date, bucket),
      value: `${formatNumber(p.clicks)} ${p.clicks === 1 ? 'click' : 'clicks'}`,
    });
  }

  function hideFocus() {
    focusIndex = -1;
    crosshair.attr('visibility', 'hidden');
    focusMark.attr('visibility', 'hidden');
    tip.hide();
  }

  function nearestIndex(mx) {
    if (points.length <= 1 || !geometry) return 0;
    return Math.max(0, Math.min(points.length - 1, Math.round(geometry.x.invert(mx))));
  }

  overlay
    .on('pointermove', (event) => {
      const [mx] = d3.pointer(event, root.node());
      showIndex(nearestIndex(mx));
    })
    .on('pointerleave', hideFocus);

  svg
    .on('focus', () => showIndex(focusIndex >= 0 ? focusIndex : points.length - 1))
    .on('blur', hideFocus)
    .on('keydown', (event) => {
      if (!points.length) return;
      const keys = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity };
      if (!(event.key in keys)) return;
      event.preventDefault();
      const step = keys[event.key];
      const start = focusIndex >= 0 ? focusIndex : points.length - 1;
      const next = step === -Infinity ? 0 : step === Infinity ? points.length - 1 : start + step;
      showIndex(next);
    });

  function describe() {
    if (!points.length) return 'Clicks over time: no data yet.';
    const total = d3.sum(points, (d) => d.clicks);
    const peakIdx = d3.maxIndex(points, (d) => d.clicks);
    const peak = points[peakIdx];
    const unit = bucket === 'hour' ? 'hour' : 'day';
    const base = `Line chart of clicks per ${unit}${rangeLabel ? `, ${rangeLabel}` : ''}. ${formatNumber(total)} ${total === 1 ? 'click' : 'clicks'} in total`;
    if (!peak || peak.clicks === 0) return `${base}. Use the Table button for exact values.`;
    return `${base}; the busiest ${unit} was ${bucketLabel(peak.date, bucket)} with ${formatNumber(peak.clicks)}. Use the arrow keys to step through values.`;
  }

  function drawPeak(maxVal, margin, iw) {
    gPeak.selectAll('*').remove();
    if (maxVal <= 0 || !points.length) return;
    const pi = d3.maxIndex(points, (d) => d.clicks);
    const px = xAt(pi);
    const py = geometry.y(maxVal);
    gPeak.append('rect')
      .attr('class', 'ts-marker')
      .attr('x', px - 6.5)
      .attr('y', py - 6.5)
      .attr('width', 13)
      .attr('height', 13)
      .attr('fill', pal.yellow);
    const label = gPeak.append('g').attr('class', 'ts-peak__label');
    const box = label.append('rect').attr('class', 'ts-peak__box').attr('fill', pal.yellow);
    // Sentence case in source; .ts-peak__text letters it in caps.
    const text = label.append('text').attr('class', 'ts-peak__text').text(`Peak ${formatNumber(maxVal)}`);
    const tw = text.node().getComputedTextLength() || 60;
    const bw = Math.ceil(tw + 14);
    const bh = 20;
    const bx = Math.max(-margin.left + 2, Math.min(px - bw / 2, iw + margin.right - bw - 2));
    const by = py - bh - 11;
    box.attr('x', bx).attr('y', by).attr('width', bw).attr('height', bh);
    text.attr('x', bx + 7).attr('y', by + 14);
  }

  function render() {
    const width = Math.floor(container.clientWidth);
    const height = Math.floor(container.clientHeight);
    if (!width || !height) {
      dirty = true;
      return;
    }
    dirty = false;
    lastWidth = width;
    lastHeight = height;

    const n = points.length;
    const maxVal = d3.max(points, (d) => d.clicks) || 0;
    const y = d3.scaleLinear().domain([0, Math.max(4, maxVal)]).nice();
    const yTicks = y.ticks(height < 240 ? 4 : 5).filter(Number.isInteger);
    const yFmt = maxVal >= 10000 ? d3.format('~s') : d3.format(',d');
    const longest = d3.max(yTicks, (t) => yFmt(t).length) || 1;
    const margin = { top: 38, right: 18, bottom: 34, left: Math.round(22 + longest * 7.5) };
    const iw = Math.max(40, width - margin.left - margin.right);
    const ih = Math.max(40, height - margin.top - margin.bottom);
    y.range([ih, 0]);
    const x = d3.scaleLinear().domain(n > 1 ? [0, n - 1] : [-1, 1]).range([0, iw]);
    geometry = { x, y, iw, ih, margin };

    svg.attr('width', width).attr('height', height).attr('viewBox', `0 0 ${width} ${height}`).attr('aria-label', describe());
    root.attr('transform', `translate(${margin.left},${margin.top})`);

    // Hairline gridlines (the zero line is the ink x axis itself).
    gGrid.selectAll('line')
      .data(yTicks.filter((t) => t !== 0), (d) => d)
      .join('line')
      .attr('x1', 0)
      .attr('x2', iw)
      .attr('y1', (d) => Math.round(y(d)) + 0.5)
      .attr('y2', (d) => Math.round(y(d)) + 0.5);

    // X axis: ticks on real buckets, anchored on the most recent one.
    const maxTicks = Math.max(2, Math.floor(iw / (bucket === 'hour' ? 64 : 74)));
    const step = Math.max(1, Math.ceil(n / maxTicks));
    const tickIdx = n <= 1 ? (n ? [0] : []) : d3.range(n).filter((i) => (n - 1 - i) % step === 0);
    gX.attr('transform', `translate(0,${ih})`)
      .call(d3.axisBottom(x).tickValues(tickIdx).tickFormat((i) => tickLabel(points[i].date, bucket)).tickSize(6).tickSizeOuter(0).tickPadding(7));
    gY.call(d3.axisLeft(y).tickValues(yTicks).tickFormat(yFmt).tickSize(6).tickSizeOuter(0).tickPadding(6));

    // Area + line. A single bucket is drawn as a short flat run so it still reads as a shape.
    const series = n === 1
      ? [{ i: -0.5, v: points[0].clicks }, { i: 0.5, v: points[0].clicks }]
      : points.map((p, i) => ({ i, v: p.clicks }));
    const area = d3.area().x((d) => x(d.i)).y0(ih).y1((d) => y(d.v)).curve(d3.curveLinear);
    const line = d3.line().x((d) => x(d.i)).y((d) => y(d.v)).curve(d3.curveLinear);
    areaPath.attr('d', n ? area(series) : null);
    linePath.attr('d', n ? line(series) : null);

    // Square markers on every bucket when there is room for them.
    const showMarkers = n > 0 && (n === 1 || iw / (n - 1) >= MARKER_SPACING);
    gMarkers.selectAll('rect')
      .data(showMarkers ? points : [])
      .join('rect')
      .attr('class', 'ts-marker')
      .attr('width', MARKER)
      .attr('height', MARKER)
      .attr('fill', pal.panel)
      .attr('x', (d, i) => xAt(i) - MARKER / 2)
      .attr('y', (d) => y(d.clicks) - MARKER / 2);

    drawPeak(maxVal, margin, iw);
    note.hidden = !(n > 0 && maxVal === 0);

    overlay.attr('width', iw).attr('height', ih);
    if (focusIndex >= 0 && focusIndex < n) showIndex(focusIndex);
    else hideFocus();
  }

  const ro = new ResizeObserver(() => {
    const w = Math.floor(container.clientWidth);
    const h = Math.floor(container.clientHeight);
    if (w && h && (dirty || w !== lastWidth || h !== lastHeight)) render();
  });
  ro.observe(container);
  // Peak label boxes are measured from the text; measure again once the webfonts are in.
  document.fonts?.ready.then(() => {
    if (lastWidth) render();
  });

  return {
    update(rawPoints, nextBucket, { rangeLabel: label = '' } = {}) {
      bucket = nextBucket === 'hour' ? 'hour' : 'day';
      rangeLabel = label;
      points = (Array.isArray(rawPoints) ? rawPoints : [])
        .map((p) => ({ date: new Date(p.t), clicks: Math.max(0, Number(p.clicks) || 0) }))
        .filter((p) => Number.isFinite(p.date.getTime()));
      if (focusIndex >= points.length) focusIndex = -1;
      render();
    },
    render,
    destroy() {
      ro.disconnect();
    },
  };
}

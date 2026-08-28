/**
 * The spectrum plot: four curves on one pair of axes.
 *
 *   source     what the star emitted, above the atmosphere
 *   direct     what is left of that beam after the air
 *   scattered  the light arriving from the sky instead
 *   observed   what the eye actually collects in this direction
 *
 * Read together they tell the whole story: the dip the direct beam loses at
 * short wavelengths is the hump the scattered curve gains.
 */

import { WAVELENGTHS_NM, SPECTRUM_BINS, wavelengthToDisplayRgb } from '../physics/spectrum.js';

const SERIES = [
  { key: 'source', color: '#e8e8ea', dash: [5, 4], width: 1.6 },
  { key: 'direct', color: '#ffb454', dash: [], width: 2 },
  { key: 'scattered', color: '#5aa9ff', dash: [], width: 2 },
  { key: 'observed', color: '#7ef0c0', dash: [2, 3], width: 1.6 },
];

export function createSpectrumChart(canvas, { i18n }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let payload = null;
  let visible = new Set(SERIES.map((s) => s.key));

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(240, rect.width);
    const h = Math.max(150, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function update(next) { payload = next; }

  function toggle(key) {
    if (visible.has(key)) visible.delete(key); else visible.add(key);
  }

  function isVisible(key) { return visible.has(key); }

  function draw() {
    const { w, h } = resize();
    ctx.fillStyle = '#0b0e16';
    ctx.fillRect(0, 0, w, h);
    if (!payload) return;

    const padLeft = 34, padRight = 8, padTop = 10, padBottom = 30;
    const plot = { x: padLeft, y: padTop, w: w - padLeft - padRight, h: h - padTop - padBottom };

    const curves = SERIES
      .filter((s) => visible.has(s.key) && payload.curves[s.key])
      .map((s) => ({ ...s, values: payload.curves[s.key] }));

    // One shared vertical scale keeps the curves comparable; without it the
    // sky curve would be rescaled into looking as strong as the direct beam.
    let peak = 0;
    for (const c of curves) {
      for (let i = 0; i < SPECTRUM_BINS; i++) if (c.values[i] > peak) peak = c.values[i];
    }
    if (!(peak > 0)) peak = 1;

    const toX = (i) => plot.x + (i / (SPECTRUM_BINS - 1)) * plot.w;
    const toY = (v) => plot.y + plot.h - (v / peak) * plot.h;

    drawWavelengthAxis(plot, toX);
    drawGrid(plot, peak, toY);

    for (const c of curves) {
      ctx.save();
      ctx.strokeStyle = c.color;
      ctx.lineWidth = c.width;
      ctx.setLineDash(c.dash);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < SPECTRUM_BINS; i++) {
        const x = toX(i), y = toY(c.values[i]);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    if (peak <= 1e-12 || curves.length === 0) {
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(i18n.t('spectrum.empty'), plot.x + plot.w / 2, plot.y + plot.h / 2);
      ctx.restore();
    }

    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textAlign = 'center';
    ctx.fillText(i18n.t('spectrum.axisX'), plot.x + plot.w / 2, h - 3);
    ctx.restore();
  }

  /** A true-colour ribbon under the axis, so the axis reads as light. */
  function drawWavelengthAxis(plot, toX) {
    const bandY = plot.y + plot.h + 3;
    const bandH = 7;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const [r, g, b] = wavelengthToDisplayRgb(WAVELENGTHS_NM[i]);
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(toX(i) - plot.w / (SPECTRUM_BINS - 1) / 2, bandY,
        plot.w / (SPECTRUM_BINS - 1) + 1, bandH);
    }
    ctx.save();
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const nm of [400, 500, 600, 700]) {
      const i = (nm - 380) / 10;
      ctx.fillText(String(nm), toX(i), bandY + bandH + 1);
    }
    ctx.restore();
  }

  function drawGrid(plot, peak, toY) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= 4; k++) {
      const value = (peak * k) / 4;
      const y = toY(value);
      ctx.beginPath();
      ctx.moveTo(plot.x, y + 0.5);
      ctx.lineTo(plot.x + plot.w, y + 0.5);
      ctx.stroke();
      ctx.fillText(formatTick(value), plot.x - 4, y);
    }
    ctx.restore();
  }

  function formatTick(v) {
    if (v === 0) return '0';
    if (v >= 0.01 && v < 1000) return v.toPrecision(2);
    return v.toExponential(0);
  }

  return { update, draw, toggle, isVisible, series: SERIES };
}

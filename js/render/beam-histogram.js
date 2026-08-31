/**
 * The spectrum of the light the drawn rays deliver, as a chart.
 *
 * The spectrum plot on the right is the analytic answer: smooth curves the
 * integrator produced. This is the measured one - the few hundred rays on
 * screen, each carrying an unbiased estimate of what it contributes, summed per
 * wavelength. The colour it implies is shown beside the integrator's own, and
 * the two agree, which is the point: the picture and the theory are one thing.
 *
 * An earlier version counted rays instead of weighing them. That could never
 * fall when the sky darkened - a fixed number of rays is drawn whatever the
 * state - so climbing to 40 km emptied the sky of light without moving a single
 * bar, while the colour swatch went black. Weighted by energy, and against a
 * scale that is held rather than refitted, the bars collapse with it.
 *
 * Filled bars are the light arriving at the observer: coloured from the viewing
 * cone, grey from the rest of the sky. The dashed outline is the unscattered
 * direct beam, scaled to its own peak because it carries thousands of times
 * more energy than the sky and is here for its shape - which marches red as the
 * star sinks.
 */

import { wavelengthToDisplayRgb } from '../physics/spectrum.js';

const PAD = { left: 34, right: 10, top: 10, bottom: 22 };

export function createBeamHistogram(canvas, { i18n }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let histogram = null;
  /** The brightest the sky has been, held so the bars can visibly fall. */
  let reference = 0;

  function cssSize() {
    const rect = canvas.getBoundingClientRect();
    return { w: Math.max(240, rect.width), h: Math.max(80, rect.height) };
  }

  function resize() {
    const { w, h } = cssSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function update(next) {
    histogram = next;
  }

  function draw() {
    const { w, h } = resize();
    ctx.fillStyle = '#0a0d16';
    ctx.fillRect(0, 0, w, h);
    if (!histogram) return;

    const plot = {
      x: PAD.left, y: PAD.top,
      w: w - PAD.left - PAD.right, h: h - PAD.top - PAD.bottom,
    };
    const bins = histogram.centres.length;
    const slot = plot.w / bins;
    const barW = Math.max(2, slot - 2);

    // The vertical scale is the brightest the sky has been since the page
    // loaded, held rather than re-fitted every frame. Re-fitting would defeat
    // the whole purpose: climbing until the sky is black would keep the bars
    // exactly as tall as before, which is the bug this chart exists to answer.
    if (histogram.peak > reference) reference = histogram.peak;
    const top = Math.max(reference, 1e-30) * 1.08;

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    for (const frac of [0, 0.5, 1]) {
      const y = plot.y + plot.h - frac * plot.h;
      ctx.beginPath();
      ctx.moveTo(plot.x, y + 0.5);
      ctx.lineTo(plot.x + plot.w, y + 0.5);
      ctx.stroke();
    }
    ctx.restore();

    for (let b = 0; b < bins; b++) {
      const cone = histogram.inCone[b];
      const other = histogram.elsewhere[b];
      if (cone + other <= 0) continue;
      const x = plot.x + b * slot + (slot - barW) / 2;
      const [r, g, bl] = wavelengthToDisplayRgb(histogram.centres[b]);
      const coneH = Math.min(plot.h, (cone / top) * plot.h);
      const otherH = Math.min(plot.h - coneH, (other / top) * plot.h);
      const base = plot.y + plot.h;

      ctx.fillStyle = 'rgba(138, 147, 166, 0.42)';
      ctx.fillRect(x, base - coneH - otherH, barW, otherH);
      ctx.fillStyle = `rgb(${r}, ${g}, ${bl})`;
      ctx.fillRect(x, base - coneH, barW, coneH);
    }

    // The direct beam, drawn as an outline scaled to its own peak. It carries
    // thousands of times more energy than the sky does, so it cannot share the
    // axis; what it is here for is its SHAPE, which marches red as the star
    // sinks while the sky is doing something different.
    if (histogram.directPeak > 0) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      for (let b = 0; b < bins; b++) {
        const y = plot.y + plot.h
          - (histogram.direct[b] / histogram.directPeak) * plot.h * 0.9;
        const x = plot.x + b * slot + slot / 2;
        if (b === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    // Wavelength axis, drawn as the spectrum itself: no legend needed to say
    // which end is which.
    ctx.save();
    const strip = ctx.createLinearGradient(plot.x, 0, plot.x + plot.w, 0);
    for (let i = 0; i <= 10; i++) {
      const [r, g, b] = wavelengthToDisplayRgb(380 + (i / 10) * 370);
      strip.addColorStop(i / 10, `rgb(${r}, ${g}, ${b})`);
    }
    ctx.globalAlpha = 0.75;
    ctx.fillStyle = strip;
    ctx.fillRect(plot.x, plot.y + plot.h + 3, plot.w, 4);
    ctx.restore();

    ctx.save();
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('380 nm', plot.x, plot.y + plot.h + 9);
    ctx.textAlign = 'right';
    ctx.fillText('750 nm', plot.x + plot.w, plot.y + plot.h + 9);

    const parts = [];
    if (histogram.coneMeanNm != null) {
      parts.push(`${i18n.t('histogram.sky')} ${histogram.coneMeanNm.toFixed(0)} nm`);
    }
    if (histogram.directMeanNm != null) {
      parts.push(`${i18n.t('histogram.direct')} ${histogram.directMeanNm.toFixed(0)} nm`);
    }
    if (parts.length) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(parts.join('   ·   '), plot.x + plot.w / 2, plot.y + plot.h + 9);
    }

    // How far the sky has fallen from its brightest, which is the number that
    // moves when the observer climbs and the bars shrink to nothing.
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    const share = reference > 0 ? histogram.peak / reference : 0;
    ctx.fillText(share >= 0.995 ? '100 %'
      : share >= 0.01 ? `${(share * 100).toFixed(0)} %`
        : share > 0 ? `${(share * 100).toPrecision(2)} %` : '0 %',
    2, plot.y + 6);
    ctx.restore();
  }

  /** Forget the held scale, so a new world or star starts from its own peak. */
  function resetScale() {
    reference = 0;
  }

  return { update, draw, resetScale };
}

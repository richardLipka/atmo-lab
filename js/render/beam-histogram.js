/**
 * The light the drawn rays deliver, counted by colour.
 *
 * The spectrum plot on the right is the analytic answer: smooth curves the
 * integrator produced. This is the measured one, and it is the only one the
 * sky colour beside it is built from - a few hundred traced rays, each carrying
 * an unbiased estimate of what it contributes, gathered into the eight bands
 * the rays on screen are drawn in. One bar per colour, the same eight colours,
 * so a bar can be checked against the rays it is made of by counting them.
 *
 * Two earlier versions were wrong in instructive ways. The first counted rays
 * instead of weighing them, and a fixed number of rays is traced whatever the
 * state, so climbing to 40 km emptied the sky without moving a single bar. The
 * second weighed them but divided by the rays that ARRIVED, which is an average
 * over the survivors: at the bottom of a fifty-metre shaft, where five rays get
 * in out of fifty, it reported the same bright sky as open ground. The light
 * collected is now divided by the directions LOOKED IN, so a direction that
 * ends in rock contributes its nothing like any other, and the bars fall with
 * the ray count exactly as the eye does.
 *
 * Bars are as wide as their band, which is not equal: the bands are narrow
 * where the eye separates colours quickly and wide out in the deep red where it
 * does not. Filled means the light arrived from inside the viewing cone; the
 * grey stacked on top is the rest of the sky. The dashed outline is the
 * unscattered direct beam, scaled to its own peak because it carries thousands
 * of times more energy than the sky and is here for its shape - which marches
 * red as the star sinks.
 */

import {
  wavelengthToDisplayRgb, RAY_BANDS, SPECTRUM_MIN_NM, SPECTRUM_MAX_NM,
} from '../physics/spectrum.js';

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
    // A true wavelength axis: every band occupies exactly as much of the chart
    // as it occupies of the spectrum. Equal slots would make the deep red, one
    // band covering a third of the range, look like any other colour.
    const AXIS_TO = SPECTRUM_MAX_NM + 1;
    const nmToX = (nm) => plot.x
      + ((nm - SPECTRUM_MIN_NM) / (AXIS_TO - SPECTRUM_MIN_NM)) * plot.w;

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

    const base = plot.y + plot.h;
    for (let b = 0; b < bins; b++) {
      const band = RAY_BANDS[b] ?? { fromNm: 380, edgeNm: 750, css: '#888' };
      const x = nmToX(band.fromNm) + 1;
      const barW = Math.max(2, nmToX(band.edgeNm) - nmToX(band.fromNm) - 2);
      const cone = histogram.inCone[b];
      const other = histogram.elsewhere[b];
      if (cone + other > 0) {
        const coneH = Math.min(plot.h, (cone / top) * plot.h);
        const otherH = Math.min(plot.h - coneH, (other / top) * plot.h);
        ctx.fillStyle = 'rgba(138, 147, 166, 0.42)';
        ctx.fillRect(x, base - coneH - otherH, barW, otherH);
        ctx.fillStyle = band.css;
        ctx.fillRect(x, base - coneH, barW, coneH);
      }

      // How many rays of this colour are arriving from the cone. The bar is
      // what they carry; this is how many there are, and the two together are
      // the whole of what the sky colour is built from.
      const rays = histogram.coneBandRays ? histogram.coneBandRays[b] : 0;
      if (rays > 0 && barW >= 14) {
        ctx.save();
        ctx.font = '9px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = 'rgba(255,255,255,0.68)';
        const coneH = Math.min(plot.h, (cone / top) * plot.h);
        const otherH = Math.min(plot.h - coneH, (other / top) * plot.h);
        ctx.fillText(String(rays), x + barW / 2,
          Math.max(plot.y + 9, base - coneH - otherH - 1));
        ctx.restore();
      }
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
        const x = nmToX(histogram.centres[b]);
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

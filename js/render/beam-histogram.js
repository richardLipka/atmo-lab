/**
 * A histogram of the beams the simulation actually drew.
 *
 * The spectrum plot on the right is the analytic answer: smooth curves the
 * integrator produced. This is the empirical one - a tally of the few hundred
 * rays on screen, binned by wavelength. Two things make it worth its space next
 * to the analytic plot.
 *
 * It closes the loop between the picture and the numbers. Each bar is a count
 * of rays a student can point at in the cross-section above, and the bar
 * carries the same colour rule as that picture: the part of it that reaches the
 * observer from the direction being looked at is drawn in its own wavelength
 * colour, and the rest of the beams are grey.
 *
 * And it makes the sunset quantitative. Lower the star and the whole
 * distribution marches towards the red end, because the chord the light has to
 * cross grows and Beer-Lambert removes the short wavelengths first. The mean
 * wavelength printed beside it moves with it.
 */

import { wavelengthToDisplayRgb } from '../physics/spectrum.js';

const PAD = { left: 34, right: 10, top: 10, bottom: 22 };

export function createBeamHistogram(canvas, { i18n }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let histogram = null;

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
    if (!histogram || !(histogram.peak > 0)) return;

    const plot = {
      x: PAD.left, y: PAD.top,
      w: w - PAD.left - PAD.right, h: h - PAD.top - PAD.bottom,
    };
    const bins = histogram.centres.length;
    const slot = plot.w / bins;
    const barW = Math.max(2, slot - 2);
    // A little headroom, so the tallest bar is not glued to the top edge.
    const top = histogram.peak * 1.08;

    // Horizontal guides, enough to read a count off but not enough to compete.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const frac of [0, 0.5, 1]) {
      const y = plot.y + plot.h - frac * plot.h;
      ctx.beginPath();
      ctx.moveTo(plot.x, y + 0.5);
      ctx.lineTo(plot.x + plot.w, y + 0.5);
      ctx.stroke();
      ctx.fillText(String(Math.round(frac * top)), plot.x - 5, y);
    }
    ctx.restore();

    for (let b = 0; b < bins; b++) {
      const cone = histogram.inCone[b];
      const other = histogram.other[b];
      if (cone + other === 0) continue;
      const x = plot.x + b * slot + (slot - barW) / 2;
      const [r, g, bl] = wavelengthToDisplayRgb(histogram.centres[b]);

      // Everything else, stacked on top and grey - the same rule the
      // cross-section uses, so the two pictures read as one.
      const otherH = (other / top) * plot.h;
      const coneH = (cone / top) * plot.h;
      let y = plot.y + plot.h;

      ctx.fillStyle = 'rgba(138, 147, 166, 0.42)';
      ctx.fillRect(x, y - coneH - otherH, barW, otherH);

      y -= otherH;
      ctx.fillStyle = `rgb(${r}, ${g}, ${bl})`;
      ctx.fillRect(x, y - coneH, barW, coneH);
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

    // The number that moves as the star sets.
    if (histogram.meanNm != null) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(
        `${i18n.t('histogram.mean')} ${histogram.meanNm.toFixed(0)} nm`,
        plot.x + plot.w / 2, plot.y + plot.h + 9);
    }
    ctx.restore();
  }

  return { update, draw };
}

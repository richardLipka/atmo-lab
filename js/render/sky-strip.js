/**
 * The observer's own view of the sky, from one horizon to the other.
 *
 * Every column is one viewing direction, filled with what the TRACED RAYS
 * deliver from it - the same measurement the colour swatch on the right is
 * built from, run once per direction instead of once for the viewing cone.
 * Filling it from the integrator instead, as it used to be, let the picture and
 * the strip beneath it disagree about the same sky.
 *
 * Where the shaft wall stops a direction the column is not black. Black says
 * "nothing here"; what is there is rock, and rock has a colour - the ground's
 * own reflectance lit by the patch of sky that still reaches down the shaft. So
 * a well shows as two warm dark wings closing in on a shrinking strip of sky,
 * and the wings darken as the shaft deepens because less light gets to them.
 *
 * The side-by-side comparison used to be the exception. Two observers were
 * drawn from one set of traced rays, so neither band could be measured and both
 * fell back to the integrator - the theory, sitting under a picture that had no
 * say in it, in the one place where the whole argument is that two observers
 * under the same sky see different things. Each observer now has their own
 * trace, so each band is measured from the rays drawn directly above it and the
 * exception is gone.
 */

import { stationColour } from './scene-renderer.js';

export function createSkyStrip(canvas, { i18n, colorimetry }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let data = null;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(280, rect.width);
    const h = Math.max(56, rect.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function update(next) { data = next; }

  function draw() {
    const { w, h } = resize();
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, w, h);
    if (!data || !data.result) return;

    const stations = data.stations ?? [];
    if (stations.length === 0) return;

    // One band per observer, laid out exactly as the panels above are: one
    // full-width band for a single observer, two half-width bands side by side
    // for two, so each band sits under the picture it was measured from.
    if (stations.length === 1) {
      drawBand(stations[0], 0, 0, w, h - 16, false);
      drawScale(0, w, h);
    } else {
      const gap = 10;
      const half = (w - gap) / 2;
      drawBand(stations[0], 0, 0, half, h - 16, true);
      drawBand(stations[1], half + gap, 0, half, h - 16, true);
      drawScale(0, half, h);
      drawScale(half + gap, half, h);
    }
  }

  /**
   * Where a viewing angle lands on the strip: a plain linear axis, horizon to
   * horizon.
   *
   * It used to be non-linear. The sky dome is sampled with extra samples packed
   * inside a shaft's aperture, so that a sliver of sky a degree wide is
   * computed at all rather than falling between samples, and the strip drew one
   * equal-width column per sample. That handed a third of the strip to an
   * aperture worth two per cent of the sky, and the bottom of a fifty-metre
   * well came out looking like a bright blue window. Sampling density is a
   * numerical concern; it must not decide how wide anything looks.
   */
  function angleToX(signedAngle, x, w) {
    return x + ((Math.max(-90, Math.min(90, signedAngle)) + 90) / 180) * w;
  }

  /**
   * The colour of one direction, as the rays measured it.
   *
   * This is the colour swatch pointed that way: `measureCone` with the same
   * field of view and the same arithmetic, so turning the observer to this
   * direction makes the panel on the right read what this column already shows.
   * A direction that ends in rock is the rock; a direction that ends in sky is
   * the sky, however little of it there is.
   */
  function columnCss(measured, signedAngle, exposure) {
    const bin = measured.binOfAngle(signedAngle);
    const c = colorimetry.spectrumToSrgb(measured.spectrumAt(bin), exposure);
    // The floor belongs to the ROCK and to nothing else. It exists so a wall
    // with almost no light on it still reads as a wall rather than as a hole
    // cut out of the picture. Applying it to sky as well was wrong in exactly
    // the way this whole section is about: it warmed a nearly black sky at the
    // bottom of a deep shaft into something faintly brown, and brown has one
    // meaning here - you are facing rock. Thin sky goes to black.
    if (!measured.blocked[bin]) return c.css;
    return `rgb(${Math.max(22, c.rgb[0])}, ${Math.max(16, c.rgb[1])}, ${Math.max(12, c.rgb[2])})`;
  }

  /** The dome sample nearest a viewing angle. */
  function sampleAt(dome, signedAngle) {
    let best = dome[0], bestDelta = Infinity;
    for (const sample of dome) {
      const delta = Math.abs(sample.signedAngleDeg - signedAngle);
      if (delta < bestDelta) { bestDelta = delta; best = sample; }
    }
    return best;
  }

  function drawBand(station, x, y, w, h, labelled) {
    const evaluation = station.evaluation;
    const observer = station.observer;
    const measured = station.sky;
    const dome = evaluation.dome;
    const exposure = data.result.exposure;
    const active = station.id === data.activeId;

    // One column of pixels per viewing direction, on the true angular axis, so
    // the visible sky occupies exactly the share of the strip it occupies of
    // the sky. From the horizon away from the star, through the zenith, to the
    // horizon beneath it.
    const columns = Math.max(1, Math.round(w));
    for (let i = 0; i < columns; i++) {
      const angle = -90 + (180 * (i + 0.5)) / columns;
      ctx.fillStyle = measured
        ? columnCss(measured, angle, exposure)
        : sampleAt(dome, angle).color.css;
      ctx.fillRect(x + (i * w) / columns, y, w / columns + 1, h);
    }

    // A shaft's aperture can be far narrower than one column, so mark it
    // rather than let it disappear - but mark it, do not widen it.
    const half = evaluation.metrics.apertureHalfAngleDeg;
    if (half < 89.9) {
      // Bracket the aperture from outside rather than draw on top of it. A
      // hundred-and-fifty-metre shaft leaves half a degree of sky, which is one
      // pixel of strip, and two marker lines drawn at its edges cover the very
      // thing they point at - so the sky it does have reads as the marker's own
      // colour instead of its own.
      const gap = 2;
      const x1 = angleToX(-half, x, w) - gap;
      const x2 = angleToX(half, x, w) + gap;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,200,120,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.max(x1, x + 0.5), y);
      ctx.lineTo(Math.max(x1, x + 0.5), y + h);
      ctx.moveTo(Math.min(x2, x + w - 0.5), y);
      ctx.lineTo(Math.min(x2, x + w - 0.5), y + h);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,200,120,0.95)';
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const text = (i18n.getLanguage() === 'cs' ? 'otvor ±' : 'aperture ±')
        + (half >= 1 ? half.toFixed(1) + '°' : half.toExponential(1) + '°');
      ctx.fillText(text, Math.min(x + w - 34, Math.max(x + 34, (x1 + x2) / 2)), y + h - 4);
      ctx.restore();
    }

    // Where the star sits in this view - this simulation's star, which need
    // not be the other one's, nor at the other one's elevation.
    const elevation = station.sim.star.elevationDeg;
    if (elevation >= 0) {
      const sx = angleToX(90 - elevation, x, w);
      const blocked = evaluation.beam.visible === false;
      ctx.save();
      ctx.globalAlpha = blocked ? 0.25 : 1;
      ctx.fillStyle = evaluation.colors.star.css;
      ctx.beginPath();
      ctx.arc(sx, y + h * 0.42, Math.max(4, h * 0.12), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Where the observer is currently looking.
    const viewSigned = observer.viewZenithDeg *
      (Math.cos(observer.viewAzimuthDeg * Math.PI / 180) >= 0 ? 1 : -1);
    const vx = angleToX(viewSigned, x, w);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(vx, y);
    ctx.lineTo(vx, y + h);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(vx, y + h);
    ctx.lineTo(vx - 5, y + h - 7);
    ctx.lineTo(vx + 5, y + h - 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Which observer this band belongs to, in that observer's own colour, and
    // a frame round the selected one - the same marking the panel above it
    // carries, so the eye can join the two without being told.
    if (labelled) {
      const colour = stationColour(station.id);
      const label = i18n.t(station.id === 'a' ? 'compare.observerA' : 'compare.observerB');
      ctx.save();
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.strokeStyle = 'rgba(0,0,0,0.65)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, x + 8, y + 15);
      ctx.fillStyle = colour;
      ctx.fillText(label, x + 8, y + 15);
      if (active) {
        ctx.strokeStyle = colour;
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
      }
      ctx.restore();
    }
  }

  function drawScale(x, w, h) {
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(i18n.t('controls.observer.horizon'), x + 4, h - 2);
    ctx.textAlign = 'center';
    ctx.fillText(i18n.t('controls.observer.zenith'), x + w / 2, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText(i18n.t('controls.observer.horizon'), x + w - 4, h - 2);
    ctx.restore();
  }

  return { update, draw };
}

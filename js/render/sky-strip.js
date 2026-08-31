/**
 * The observer's own view of the sky, from one horizon to the other.
 *
 * Every column is one viewing direction, filled with the colour that the
 * radiance integrator returned for it. Where the shaft wall stops a direction
 * the column is black, so the geometry of a well shows up immediately as a
 * pair of black wings closing in on a shrinking strip of sky.
 */

export function createSkyStrip(canvas, { i18n }) {
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

    const evaluations = data.state.compare.enabled && data.result.compare
      ? [
        { evaluation: data.result.compare.left, label: i18n.t('compare.left') },
        { evaluation: data.result.compare.right, label: i18n.t('compare.right') },
      ]
      : [{ evaluation: data.result.primary, label: null }];

    const bandHeight = (h - 16) / evaluations.length;
    evaluations.forEach((entry, index) => {
      drawBand(entry.evaluation, 0, index * bandHeight, w, bandHeight, entry.label);
    });
    drawScale(w, h);
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

  /** The dome sample nearest a viewing angle. */
  function sampleAt(dome, signedAngle) {
    let best = dome[0], bestDelta = Infinity;
    for (const sample of dome) {
      const delta = Math.abs(sample.signedAngleDeg - signedAngle);
      if (delta < bestDelta) { bestDelta = delta; best = sample; }
    }
    return best;
  }

  function drawBand(evaluation, x, y, w, h, label) {
    const dome = evaluation.dome;

    // One column of pixels per viewing direction, on the true angular axis, so
    // the visible sky occupies exactly the share of the strip it occupies of
    // the sky. From the horizon away from the star, through the zenith, to the
    // horizon beneath it.
    const columns = Math.max(1, Math.round(w));
    for (let i = 0; i < columns; i++) {
      const angle = -90 + (180 * (i + 0.5)) / columns;
      ctx.fillStyle = sampleAt(dome, angle).color.css;
      ctx.fillRect(x + (i * w) / columns, y, w / columns + 1, h);
    }

    // A shaft's aperture can be far narrower than one column, so mark it
    // rather than let it disappear - but mark it, do not widen it.
    const half = evaluation.metrics.apertureHalfAngleDeg;
    if (half < 89.9) {
      const x1 = angleToX(-half, x, w);
      const x2 = angleToX(half, x, w);
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

    // Where the star sits in this view.
    const elevation = data.state.star.elevationDeg;
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
    const viewSigned = data.state.observer.viewZenithDeg *
      (Math.cos(data.state.observer.viewAzimuthDeg * Math.PI / 180) >= 0 ? 1 : -1);
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

    if (label) {
      ctx.save();
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, x + 8, y + 15);
      ctx.fillText(label, x + 8, y + 15);
      ctx.restore();
    }
  }

  function drawScale(w, h) {
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText(i18n.t('controls.observer.horizon'), 4, h - 2);
    ctx.textAlign = 'center';
    ctx.fillText(i18n.t('controls.observer.zenith'), w / 2, h - 2);
    ctx.textAlign = 'right';
    ctx.fillText(i18n.t('controls.observer.horizon'), w - 4, h - 2);
    ctx.restore();
  }

  return { update, draw };
}

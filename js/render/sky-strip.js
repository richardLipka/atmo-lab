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
   * Where a viewing angle lands on the strip. The angular axis is not always
   * linear: inside a shaft the middle of the strip is magnified so the sliver
   * of visible sky can be seen at all, so positions are found by walking the
   * samples rather than by scaling the angle.
   */
  function angleToX(dome, signedAngle, x, w) {
    const n = dome.length;
    if (signedAngle <= dome[0].signedAngleDeg) return x;
    if (signedAngle >= dome[n - 1].signedAngleDeg) return x + w;
    for (let i = 1; i < n; i++) {
      if (dome[i].signedAngleDeg >= signedAngle) {
        const span = dome[i].signedAngleDeg - dome[i - 1].signedAngleDeg;
        const t = span > 0 ? (signedAngle - dome[i - 1].signedAngleDeg) / span : 0;
        return x + ((i - 1 + t) / (n - 1)) * w;
      }
    }
    return x + w;
  }

  function drawBand(evaluation, x, y, w, h, label) {
    const dome = evaluation.dome;
    const n = dome.length;
    for (let i = 0; i < n; i++) {
      // The band runs left to right from the horizon away from the star,
      // through the zenith, to the horizon beneath it.
      const cellX = x + (i / n) * w;
      ctx.fillStyle = dome[i].color.css;
      ctx.fillRect(cellX, y, w / n + 1, h);
    }

    // Mark the magnified span, so nobody reads it as a wide patch of sky.
    const firstMagnified = dome.findIndex((s) => s.magnified);
    if (firstMagnified >= 0) {
      const lastMagnified = dome.length - 1 - [...dome].reverse().findIndex((s) => s.magnified);
      const x1 = x + (firstMagnified / n) * w;
      const x2 = x + ((lastMagnified + 1) / n) * w;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,200,120,0.85)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      for (const edge of [x1, x2]) {
        ctx.beginPath();
        ctx.moveTo(edge, y);
        ctx.lineTo(edge, y + h);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,200,120,0.9)';
      ctx.font = '9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const half = dome[lastMagnified].signedAngleDeg;
      const text = (i18n.getLanguage() === 'cs' ? 'otvor ±' : 'aperture ±') +
        (half >= 1 ? half.toFixed(1) + '°' : half.toExponential(1) + '°');
      ctx.fillText(text, (x1 + x2) / 2, y + h - 4);
      ctx.restore();
    }

    // Where the star sits in this view.
    const elevation = data.state.star.elevationDeg;
    if (elevation >= 0) {
      const sx = angleToX(dome, 90 - elevation, x, w);
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
    const vx = angleToX(dome, viewSigned, x, w);
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

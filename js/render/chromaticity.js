/**
 * The CIE 1931 chromaticity diagram, with the current sky and star plotted on
 * it. Advanced students can watch the sky point slide along the blue edge as
 * the wavelength exponent changes, and the star point crawl down the Planckian
 * locus as its temperature falls.
 */

export function createChromaticityPlot(canvas, { colorimetry, i18n }) {
  const locus = colorimetry.spectralLocus();
  let payload = null;
  let backdrop = null;
  const ctx = canvas.getContext('2d', { alpha: false });

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const size = Math.max(120, Math.min(rect.width, 260));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(size * dpr) || canvas.height !== Math.round(size * dpr)) {
      canvas.width = Math.round(size * dpr);
      canvas.height = Math.round(size * dpr);
      backdrop = null;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return size;
  }

  const toX = (x, size) => 8 + x * (size - 20) / 0.75;
  const toY = (y, size) => size - 12 - y * (size - 20) / 0.85;

  /** The horseshoe is expensive to fill, so it is painted once and cached. */
  function buildBackdrop(size) {
    const off = document.createElement('canvas');
    off.width = size; off.height = size;
    const octx = off.getContext('2d');
    octx.fillStyle = '#0b0e16';
    octx.fillRect(0, 0, size, size);

    const image = octx.createImageData(size, size);
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = (px - 8) * 0.75 / (size - 20);
        const y = (size - 12 - py) * 0.85 / (size - 20);
        const z = 1 - x - y;
        if (x < 0 || y <= 0 || z < 0 || !insideLocus(x, y)) continue;
        // Normalise to constant luminance so the shape shows hue, not brightness.
        const scale = 1 / y;
        const linear = colorimetry.xyzToLinearRgb([x * scale, 1, z * scale]);
        const fitted = colorimetry.fitToGamut(linear);
        const i = (py * size + px) * 4;
        image.data[i] = Math.round(colorimetry.encodeComponent(fitted.rgb[0]) * 255);
        image.data[i + 1] = Math.round(colorimetry.encodeComponent(fitted.rgb[1]) * 255);
        image.data[i + 2] = Math.round(colorimetry.encodeComponent(fitted.rgb[2]) * 255);
        image.data[i + 3] = 235;
      }
    }
    octx.putImageData(image, 0, 0);
    return off;
  }

  /** Even-odd test against the closed spectral locus. */
  function insideLocus(x, y) {
    let inside = false;
    for (let i = 0, j = locus.length - 1; i < locus.length; j = i++) {
      const xi = locus[i].x, yi = locus[i].y;
      const xj = locus[j].x, yj = locus[j].y;
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function update(next) { payload = next; }

  function draw() {
    const size = resize();
    if (!backdrop) backdrop = buildBackdrop(size);
    ctx.drawImage(backdrop, 0, 0);

    // Outline.
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    locus.forEach((p, i) => {
      const px = toX(p.x, size), py = toY(p.y, size);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    if (!payload) return;
    const points = [
      { xy: payload.sky, label: 'sky', ring: '#ffffff' },
      { xy: payload.star, label: 'star', ring: '#ffd88a' },
    ];
    for (const point of points) {
      if (!point.xy) continue;
      const px = toX(point.xy[0], size), py = toY(point.xy[1], size);
      ctx.save();
      ctx.strokeStyle = point.ring;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();
      ctx.restore();
    }

    ctx.save();
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText('x', size - 12, size - 2);
    ctx.fillText('y', 2, 10);
    ctx.restore();
  }

  return { update, draw };
}

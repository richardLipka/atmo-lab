/**
 * The cross-section drawing.
 *
 * Two very different pictures are needed, because the two mechanisms the
 * simulator contrasts live at wildly different scales: an atmosphere is a
 * hundred kilometres deep, a shaft is a couple of metres wide. Rather than
 * pretend one frame can hold both honestly, the renderer switches:
 *
 *   above datum - the atmosphere view, a slab of air with the star, the
 *                 observer and traced photons;
 *   below datum - the shaft view, drawn at the aspect ratio of the shaft
 *                 itself, with the escape cone and the patch of sky it leaves.
 *
 * Nothing here invents a colour. The glow of the air is evaluated by the
 * scattering integrator on a coarse grid and then smoothed; the ground tint is
 * its albedo times the light actually falling on it.
 */

import { computeScatteringSource, QUALITY_PRESETS } from '../physics/radiance.js';
import { wellApertureHalfAngle } from '../physics/well.js';
import { wavelengthToDisplayRgb } from '../physics/spectrum.js';
import { v3 } from '../physics/geometry.js';

const FIELD_COLUMNS = 26;
const FIELD_ROWS = 34;
/** Below this the aperture cone is invisible, so it is drawn wider and labelled. */
const MIN_DRAWN_APERTURE_DEG = 2.2;

export function createSceneRenderer(canvas, { i18n, colorimetry }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let data = null;
  let field = null;          // offscreen canvas holding the atmospheric glow
  let layout = null;         // geometry of the last frame, for hit testing
  let hoveredPath = -1;
  let selectedPath = -1;

  function cssSize() {
    const rect = canvas.getBoundingClientRect();
    return { w: Math.max(320, rect.width), h: Math.max(240, rect.height) };
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

  /**
   * Evaluate the glow of the atmosphere on a coarse grid and bake it into a
   * small offscreen image. Drawn back scaled up and smoothed, it gives a
   * continuous gradient for the price of a few hundred evaluations - and the
   * shadow of the planet appears on its own at low sun.
   */
  function buildField(result, halfWidth, topAltitude) {
    const scene = result.primary.scene;
    const atm = result.atmosphere;
    const off = document.createElement('canvas');
    off.width = FIELD_COLUMNS;
    off.height = FIELD_ROWS;
    const octx = off.getContext('2d');
    const image = octx.createImageData(FIELD_COLUMNS, FIELD_ROWS);

    for (let row = 0; row < FIELD_ROWS; row++) {
      // Rows are spaced by the same power curve the vertical axis uses, so the
      // dense lower air gets the resolution it deserves.
      const tv = 1 - (row + 0.5) / FIELD_ROWS;
      const altitude = Math.pow(tv, 1 / ALTITUDE_POWER) * topAltitude;
      for (let col = 0; col < FIELD_COLUMNS; col++) {
        const x = (-1 + 2 * (col + 0.5) / FIELD_COLUMNS) * halfWidth;
        const point = v3(x, atm.planetRadius + altitude, 0);
        const spectrum = computeScatteringSource(scene, point, 0, QUALITY_PRESETS.preview);
        const c = colorimetry.spectrumToSrgb(spectrum, result.exposure * FIELD_GAIN);
        const i = (row * FIELD_COLUMNS + col) * 4;
        image.data[i] = c.rgb[0];
        image.data[i + 1] = c.rgb[1];
        image.data[i + 2] = c.rgb[2];
        image.data[i + 3] = 255;
      }
    }
    octx.putImageData(image, 0, 0);
    return off;
  }

  /** Ground colour: what the surface reflects of the light reaching it. */
  function groundColor(result) {
    const albedo = result.atmosphere.groundAlbedo;
    const ill = result.primary.illumination;
    const beam = result.primary.beam;
    const spectrum = new Float64Array(beam.spectrum.length);
    const cosSun = Math.max(0, result.primary.scene.sunDir.y);
    for (let i = 0; i < spectrum.length; i++) {
      spectrum[i] = albedo * (beam.spectrum[i] * cosSun);
    }
    const c = colorimetry.spectrumToSrgb(spectrum, 1.6);
    const floor = Math.max(0.03, Math.min(1, ill.totalOpen * 4));
    return `rgb(${Math.round(c.rgb[0] * floor + 12)}, ${Math.round(c.rgb[1] * floor + 10)}, ${Math.round(c.rgb[2] * floor + 9)})`;
  }

  function update(next, options = {}) {
    data = next;
    field = null;
    // Clicking a ray should survive an unrelated slider move; only a fresh set
    // of traced photons invalidates the choice.
    if (!options.keepSelection) selectedPath = -1;
    if (data && data.result && data.state.observer.z >= 0) {
      const topAltitude = data.result.atmosphere.topAltitude;
      field = buildField(data.result, topAltitude * HALF_WIDTH_FACTOR, topAltitude);
    }
  }

  function draw(timeMs) {
    const { w, h } = resize();
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, w, h);
    if (!data || !data.result) return;

    if (data.state.compare.enabled && data.result.compare) {
      const gap = 10;
      const half = (w - gap) / 2;
      drawPanel(0, 0, half, h, data.result.compare.left, data.state.compare.leftZ, timeMs, i18n.t('compare.left'));
      drawPanel(half + gap, 0, half, h, data.result.compare.right, data.state.compare.rightZ, timeMs, i18n.t('compare.right'));
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.moveTo(half + gap / 2, 8);
      ctx.lineTo(half + gap / 2, h - 8);
      ctx.stroke();
      layout = null;
    } else {
      drawPanel(0, 0, w, h, data.result.primary, data.state.observer.z, timeMs, null);
    }
  }

  function drawPanel(x0, y0, pw, ph, evaluation, z, timeMs, caption) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, pw, ph);
    ctx.clip();
    ctx.translate(x0, y0);

    if (z < 0) drawShaftView(pw, ph, evaluation, z, timeMs);
    else drawAtmosphereView(pw, ph, evaluation, z, timeMs, caption === null);

    if (caption) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.font = '600 12px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(caption + ' - ' + formatAltitude(z), 10, 18);
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* Atmosphere view                                                   */
  /* ---------------------------------------------------------------- */

  function drawAtmosphereView(w, h, evaluation, z, timeMs, allowInteraction) {
    const atm = data.result.atmosphere;
    const topAltitude = atm.topAltitude;
    const halfWidth = topAltitude * HALF_WIDTH_FACTOR;

    const padLeft = 46, padRight = 12, padTop = 10, padBottom = 26;
    const plot = { x: padLeft, y: padTop, w: w - padLeft - padRight, h: h - padTop - padBottom };
    const groundY = plot.y + plot.h;

    const toX = (metres) => plot.x + ((metres + halfWidth) / (2 * halfWidth)) * plot.w;
    const toY = (altitude) => groundY - Math.pow(
      Math.max(0, Math.min(1, altitude / topAltitude)), ALTITUDE_POWER) * plot.h;

    // Sky glow, painted from the computed field.
    if (field) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(field, plot.x, plot.y, plot.w, plot.h);
      ctx.restore();
    }

    drawStarBeams(plot, toX, toY, topAltitude, halfWidth, evaluation);
    if (data.photons && data.state.rays.showScattering) {
      drawPhotons(plot, toX, toY, timeMs, allowInteraction);
    }

    // Ground.
    ctx.fillStyle = groundColor(data.result);
    ctx.fillRect(plot.x, groundY, plot.w, h - groundY);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.x, groundY + 0.5);
    ctx.lineTo(plot.x + plot.w, groundY + 0.5);
    ctx.stroke();

    drawAltitudeAxis(plot, toY, topAltitude);
    drawObserver(toX(0), toY(Math.max(0, z)), evaluation, z);
    layout = allowInteraction ? { plot, toX, toY, mode: 'atmosphere' } : layout;
  }

  function drawStarBeams(plot, toX, toY, topAltitude, halfWidth, evaluation) {
    const elevation = data.state.star.elevationDeg * Math.PI / 180;
    const dir = { x: -Math.cos(elevation), y: -Math.sin(elevation) };
    const color = data.result.primary.colors.source.css;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([7, 6]);
    for (let i = 0; i < 7; i++) {
      const aim = (-1 + 2 * (i + 0.5) / 7) * halfWidth * 0.92;
      const backoff = topAltitude / Math.max(0.08, Math.abs(dir.y));
      const sx = aim - dir.x * backoff;
      ctx.beginPath();
      ctx.moveTo(toX(sx), toY(topAltitude));
      ctx.lineTo(toX(aim), toY(0));
      ctx.stroke();
    }
    ctx.restore();

    // A marker showing where the star sits.
    const label = i18n.t('canvas.star');
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    const mx = plot.x + plot.w - 8;
    const my = plot.y + 10 + (1 - Math.max(0, Math.min(1, data.state.star.elevationDeg / 90))) * (plot.h * 0.35);
    ctx.beginPath();
    ctx.arc(mx - 26, my, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'right';
    ctx.fillText(label, mx, my + 3);
    ctx.restore();
  }

  function drawPhotons(plot, toX, toY, timeMs, allowInteraction) {
    const paths = data.photons;
    const animate = data.state.rays.animate;
    // Group by wavelength bucket so the whole cloud costs a handful of strokes.
    const buckets = new Map();
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      const key = Math.round(p.lambda / 20) * 20;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }

    const phase = animate ? (timeMs / 2600) % 1 : 1;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    for (const [lambda, indices] of buckets) {
      const [r, g, b] = wavelengthToDisplayRgb(lambda);
      ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.beginPath();
      for (const index of indices) {
        if (index === selectedPath || index === hoveredPath) continue;
        strokePath(paths[index], toX, toY, phase);
      }
      ctx.stroke();
    }
    ctx.restore();

    for (const index of [hoveredPath, selectedPath]) {
      if (index < 0 || index >= paths.length) continue;
      const p = paths[index];
      const [r, g, b] = wavelengthToDisplayRgb(p.lambda);
      ctx.save();
      ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.lineWidth = index === selectedPath ? 2.6 : 1.8;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.9)`;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      strokePath(p, toX, toY, 1);
      ctx.stroke();
      ctx.shadowBlur = 0;
      for (const e of p.events) {
        if (e.type !== 'scatter' && e.type !== 'absorb') continue;
        ctx.fillStyle = e.type === 'absorb' ? '#ff5a5a' : '#ffffff';
        ctx.beginPath();
        ctx.arc(toX(e.x), toY(e.y), e.type === 'absorb' ? 3.5 : 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function strokePath(path, toX, toY, phase) {
    const pts = path.points;
    if (pts.length < 2) return;
    const limit = phase >= 1 ? pts.length : Math.max(2, Math.ceil(pts.length * phase));
    ctx.moveTo(toX(pts[0].x), toY(pts[0].y));
    for (let i = 1; i < limit; i++) ctx.lineTo(toX(pts[i].x), toY(pts[i].y));
  }

  function drawAltitudeAxis(plot, toY, topAltitude) {
    const ticks = niceAltitudeTicks(topAltitude);
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const value of ticks) {
      const y = toY(value);
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      ctx.beginPath();
      ctx.moveTo(plot.x, y + 0.5);
      ctx.lineTo(plot.x + plot.w, y + 0.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(formatAltitude(value), plot.x - 6, y);
    }
    ctx.restore();
  }

  function drawObserver(px, py, evaluation, z) {
    const zenith = data.state.observer.viewZenithDeg * Math.PI / 180;
    const azimuth = data.state.observer.viewAzimuthDeg * Math.PI / 180;
    // In the cross-section, azimuth 0 points towards the star (to the right).
    const sign = Math.cos(azimuth) >= 0 ? 1 : -1;
    const dx = Math.sin(zenith) * sign;
    const dy = Math.cos(zenith);

    ctx.save();
    ctx.strokeStyle = evaluation.view.blocked ? '#ff6b6b' : '#ffffff';
    ctx.lineWidth = 1.8;
    ctx.setLineDash(evaluation.view.blocked ? [4, 3] : []);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + dx * 54, py - dy * 54);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#05070d';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* Shaft view                                                        */
  /* ---------------------------------------------------------------- */

  function drawShaftView(w, h, evaluation, z, timeMs) {
    const depth = -z;
    const radius = data.state.observer.well.radius_m;
    const halfAngle = wellApertureHalfAngle(depth, radius);
    const halfAngleDeg = halfAngle * 180 / Math.PI;

    const padTop = 8, padBottom = 26, padSide = 40;
    const skyHeight = Math.round((h - padTop - padBottom) * 0.30);
    const groundY = padTop + skyHeight;
    const shaftTop = groundY;
    const shaftBottom = h - padBottom;
    const centreX = w / 2;
    const shaftHalfWidth = Math.max(26, Math.min((w - padSide * 2) / 2, w * 0.16));

    // Sky above the shaft, coloured by the computed dome.
    drawDomeBand(padSide, padTop, w - padSide * 2, skyHeight, evaluation);

    // Rock.
    ctx.fillStyle = '#221b16';
    ctx.fillRect(0, groundY, w, h - groundY);
    ctx.fillStyle = '#2e251d';
    ctx.fillRect(0, groundY, w, 6);

    // The shaft cavity.
    ctx.fillStyle = '#07080c';
    ctx.fillRect(centreX - shaftHalfWidth, shaftTop, shaftHalfWidth * 2, shaftBottom - shaftTop);

    const observerY = shaftBottom - 16;

    // The escape cone, filled with the colour of the sky it reveals.
    const drawnDeg = Math.max(halfAngleDeg, MIN_DRAWN_APERTURE_DEG);
    const drawnAngle = drawnDeg * Math.PI / 180;
    const coneHeight = observerY - shaftTop;
    const coneHalf = Math.tan(drawnAngle) * coneHeight;
    const zenithColor = nearestDomeColor(evaluation, 0);
    ctx.save();
    const gradient = ctx.createLinearGradient(0, observerY, 0, shaftTop);
    gradient.addColorStop(0, 'rgba(255,255,255,0.02)');
    gradient.addColorStop(1, zenithColor);
    ctx.fillStyle = gradient;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(centreX, observerY);
    ctx.lineTo(centreX - coneHalf, shaftTop);
    ctx.lineTo(centreX + coneHalf, shaftTop);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Walls.
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(centreX - shaftHalfWidth, shaftTop);
    ctx.lineTo(centreX - shaftHalfWidth, shaftBottom);
    ctx.moveTo(centreX + shaftHalfWidth, shaftTop);
    ctx.lineTo(centreX + shaftHalfWidth, shaftBottom);
    ctx.stroke();

    // Sample rays: some slip through the mouth, the rest strike the wall.
    ctx.save();
    ctx.lineWidth = 1.2;
    for (let i = 0; i <= 14; i++) {
      const angle = (-1 + 2 * i / 14) * (Math.PI / 2) * 0.92;
      const escapes = Math.abs(angle) <= drawnAngle;
      const dx = Math.sin(angle), dy = Math.cos(angle);
      const tWall = Math.abs(dx) > 1e-6 ? shaftHalfWidth / Math.abs(dx) : Infinity;
      const tMouth = coneHeight / dy;
      const t = Math.min(tWall, tMouth);
      ctx.strokeStyle = escapes ? 'rgba(255,255,255,0.75)' : 'rgba(255,120,90,0.5)';
      ctx.setLineDash(escapes ? [] : [3, 3]);
      ctx.beginPath();
      ctx.moveTo(centreX, observerY);
      ctx.lineTo(centreX + dx * t, observerY - dy * t);
      ctx.stroke();
      if (!escapes && t === tWall) {
        ctx.fillStyle = 'rgba(255,120,90,0.85)';
        ctx.beginPath();
        ctx.arc(centreX + dx * t, observerY - dy * t, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    drawObserver(centreX, observerY, evaluation, z);

    // Labels: depth, radius, and an honest note when the cone is exaggerated.
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.textAlign = 'left';
    ctx.fillText(`${i18n.t('controls.observer.wellDepth')}: ${formatAltitude(depth)}`, 8, shaftBottom - 4);
    ctx.fillText(`R = ${radius.toFixed(1)} m`, 8, shaftBottom + 10);
    ctx.textAlign = 'right';
    ctx.fillText(`θmax = ${formatAngle(halfAngleDeg)}`, w - 8, shaftTop + 14);
    if (halfAngleDeg < MIN_DRAWN_APERTURE_DEG) {
      ctx.fillStyle = 'rgba(255,200,120,0.8)';
      ctx.fillText(i18n.getLanguage() === 'cs'
        ? 'kužel zvětšen pro názornost'
        : 'cone exaggerated for clarity', w - 8, shaftTop + 28);
    }
    ctx.restore();
    layout = null;
  }

  /** Paint the sampled sky dome as a horizon-to-horizon band. */
  function drawDomeBand(x, y, w, h, evaluation) {
    const dome = evaluation.dome;
    const n = dome.length;
    for (let i = 0; i < n; i++) {
      const cellX = x + (i / n) * w;
      const cellW = w / n + 1;
      ctx.fillStyle = dome[i].color.css;
      ctx.fillRect(cellX, y, cellW, h);
    }
  }

  function nearestDomeColor(evaluation, signedAngleDeg) {
    let best = evaluation.dome[0], bestDelta = Infinity;
    for (const sample of evaluation.dome) {
      const delta = Math.abs(sample.signedAngleDeg - signedAngleDeg);
      if (delta < bestDelta) { bestDelta = delta; best = sample; }
    }
    return best.color.css;
  }

  /* ---------------------------------------------------------------- */

  /** Find the traced photon nearest to a canvas point. */
  function pick(clientX, clientY) {
    if (!layout || !data || !data.photons) return -1;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const { toX, toY } = layout;
    let best = -1, bestDist = 12;
    for (let i = 0; i < data.photons.length; i++) {
      const pts = data.photons[i].points;
      for (let k = 1; k < pts.length; k++) {
        const d = distanceToSegment(px, py,
          toX(pts[k - 1].x), toY(pts[k - 1].y), toX(pts[k].x), toY(pts[k].y));
        if (d < bestDist) { bestDist = d; best = i; }
      }
    }
    return best;
  }

  function distanceToSegment(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSq)) : 0;
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  }

  return {
    update, draw, pick,
    setHovered(index) { hoveredPath = index; },
    setSelected(index) { selectedPath = index; },
    getSelected() { return selectedPath; },
  };
}

/* Shared constants and helpers -------------------------------------- */

const ALTITUDE_POWER = 0.55;
const HALF_WIDTH_FACTOR = 1.5;
const FIELD_GAIN = 5.4e3;

function niceAltitudeTicks(topAltitude) {
  const km = topAltitude / 1000;
  const candidates = km > 300 ? [0, 25000, 100000, 250000, 500000]
    : km > 150 ? [0, 10000, 40000, 100000, 200000]
      : [0, 2000, 10000, 30000, 60000, 100000];
  return candidates.filter((v) => v <= topAltitude);
}

export function formatAltitude(metres) {
  const a = Math.abs(metres);
  if (a >= 1000) return `${(metres / 1000).toFixed(a >= 10000 ? 0 : 1)} km`;
  if (a >= 1) return `${metres.toFixed(0)} m`;
  return `${metres.toFixed(2)} m`;
}

export function formatAngle(deg) {
  const a = Math.abs(deg);
  if (a >= 1) return `${deg.toFixed(1)}°`;
  if (a >= 0.01) return `${deg.toFixed(3)}°`;
  return `${(deg * 3600).toExponential(1)}″`;
}

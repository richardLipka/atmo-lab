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
import { VIEW_CONE_HALF_DEG } from './photons.js';
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
      const altitude = tv * topAltitude;
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
      const top = frameTopFor(data.result.atmosphere, data.state.observer.z);
      field = buildField(data.result, top * HALF_WIDTH_FACTOR, top);
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
    const topAltitude = frameTopFor(atm, z);
    const halfWidth = topAltitude * HALF_WIDTH_FACTOR;

    const padLeft = 46, padRight = 12, padTop = 10, padBottom = 26;
    const plot = { x: padLeft, y: padTop, w: w - padLeft - padRight, h: h - padTop - padBottom };
    const groundY = plot.y + plot.h;

    const toX = (metres) => plot.x + ((metres + halfWidth) / (2 * halfWidth)) * plot.w;
    const toY = (altitude) => groundY
      - Math.max(0, Math.min(1, altitude / topAltitude)) * plot.h;

    // Sky glow, painted from the computed field.
    if (field) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(field, plot.x, plot.y, plot.w, plot.h);
      ctx.restore();
    }

    drawStarBeams(plot, toX, toY, topAltitude, halfWidth, evaluation);
    drawViewCone(plot, toX, toY, topAltitude, halfWidth, z);
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

  /**
   * A marker showing where the star sits. The beams themselves are no longer
   * drawn here: the traced paths carry the real, spectrally weighted version of
   * the same light, and a second set of decorative rays only competed with it.
   */
  function drawStarBeams(plot, toX, toY, topAltitude, halfWidth, evaluation) {
    const color = data.result.primary.colors.source.css;
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

  /**
   * The cone of sky the observer is looking down.
   *
   * The panels report one radiance, one spectrum and one colour, and all three
   * are properties of this cone. Drawing it makes that concrete: the bright
   * rays inside the wedge are the ones being measured, the faint ones outside
   * are the rest of the sky arriving from elsewhere.
   */
  function drawViewCone(plot, toX, toY, topAltitude, halfWidth, z) {
    const state = data.state;
    const sign = Math.cos(state.observer.viewAzimuthDeg * Math.PI / 180) >= 0 ? 1 : -1;
    const axis = sign * state.observer.viewZenithDeg * Math.PI / 180;
    const half = VIEW_CONE_HALF_DEG * Math.PI / 180;
    const oy = Math.max(0, z);

    // One straight segment per edge; the axis is linear, so that is exact.
    const edge = (angle) => {
      const dx = Math.sin(angle), dy = Math.cos(angle);
      if (dy <= 0.02) return null;
      let reach = (topAltitude - oy) / dy;
      if (Math.abs(dx) > 1e-6) reach = Math.min(reach, (halfWidth * 0.98) / Math.abs(dx));
      return { x: dx * reach, y: oy + dy * reach };
    };

    const left = edge(axis - half);
    const right = edge(axis + half);
    if (!left || !right) return;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(toX(0), toY(oy));
    ctx.lineTo(toX(left.x), toY(left.y));
    ctx.lineTo(toX(right.x), toY(right.y));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.075)';
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const side of [left, right]) {
      ctx.beginPath();
      ctx.moveTo(toX(0), toY(oy));
      ctx.lineTo(toX(side.x), toY(side.y));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    const a = left, b = right;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.textAlign = 'center';
    ctx.fillText(i18n.t('canvas.viewCone'),
      (toX(a.x) + toX(b.x)) / 2, toY(Math.max(a.y, b.y)) - 5);
    ctx.restore();
  }

  /**
   * Draw the families of light paths.
   *
   * They are painted back to front so the subject ends up on top: first the
   * light that crossed without interacting, then the events that threw light
   * where the observer will never see it, then the light arriving from the rest
   * of the sky, and last, brightest, the rays inside the viewing cone.
   */
  function drawPhotons(plot, toX, toY, timeMs, allowInteraction) {
    const paths = data.photons;
    const animate = data.state.rays.animate;
    const phase = animate ? (timeMs / 2600) % 1 : 1;

    const state = data.state;
    const sign = Math.cos(state.observer.viewAzimuthDeg * Math.PI / 180) >= 0 ? 1 : -1;
    const axis = sign * state.observer.viewZenithDeg * Math.PI / 180;
    const half = VIEW_CONE_HALF_DEG * Math.PI / 180;

    /**
     * Is this ray part of what the observer is currently looking at?
     *
     * Colour is reserved for exactly these. Everything else - light arriving
     * from the rest of the sky, light thrown in directions that miss the eye,
     * light that crossed without ever interacting - is drawn grey. The rule is
     * one sentence long and it is the whole legend: coloured means this light
     * enters your eye from the direction you are facing.
     */
    const involved = (p) => p.kind === 'arriving'
      && Math.abs(p.arrivalAngleRad - axis) <= half;

    const GREY = '#8a93a6';
    const contextAlpha = { through: 0.10, missed: 0.16, arriving: 0.13 };

    /**
     * Every arriving ray outside the cone also ends at the observer, so drawn
     * in full they make a grey starburst on top of the very convergence the
     * cone exists to show. Only every third is drawn. It is a drawing density,
     * chosen by index so it stays put as the view turns, and it changes nothing
     * the panels report.
     */
    const GREY_ARRIVING_STRIDE = 3;
    const asContext = (p, i) => !involved(p)
      && (p.kind !== 'arriving' || i % GREY_ARRIVING_STRIDE === 0);

    /* ---- everything outside the cone, in grey ---- */

    for (const kind of ['through', 'missed', 'arriving']) {
      ctx.save();
      ctx.strokeStyle = GREY;
      ctx.lineWidth = 1;
      ctx.globalAlpha = contextAlpha[kind];
      ctx.beginPath();
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        if (p.kind !== kind || !asContext(p, i)) continue;
        if (i === selectedPath || i === hoveredPath) continue;
        strokePath(p, toX, toY, phase);
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    // Scattering vertices outside the cone: every one is still a photon taken
    // out of the beam, so they are drawn - just not celebrated.
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = GREY;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (p.scatterCount === 0 || !asContext(p, i)) continue;
      if (i === selectedPath || i === hoveredPath) continue;
      const e = p.events[1];
      ctx.beginPath();
      ctx.arc(toX(e.x), toY(e.y), 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Arrowheads on the paths that leave: without them a stub reads as a line
    // rather than as light departing in a direction that misses you.
    ctx.globalAlpha = 0.3;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (p.kind !== 'missed' || !asContext(p, i)) continue;
      if (i === selectedPath || i === hoveredPath) continue;
      const from = p.points[p.points.length - 2];
      const to = p.points[p.points.length - 1];
      drawArrowHead(toX(from.x), toY(from.y), toX(to.x), toY(to.y), 4.5);
    }
    ctx.restore();

    /* ---- the rays inside the cone, in their own colours ---- */

    const buckets = new Map();
    for (let i = 0; i < paths.length; i++) {
      if (!involved(paths[i])) continue;
      if (i === selectedPath || i === hoveredPath) continue;
      const key = Math.round(paths[i].lambda / 20) * 20;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }

    ctx.save();
    ctx.lineWidth = 1.3;
    ctx.globalAlpha = 0.85;
    for (const [lambda, indices] of buckets) {
      const [r, g, b] = wavelengthToDisplayRgb(lambda);
      ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.beginPath();
      for (const index of indices) strokePath(paths[index], toX, toY, phase);
      ctx.stroke();
    }
    ctx.restore();

    // The last leg - the one that actually enters the eye - is redrawn heavier,
    // or the incoming stubs swamp the convergence.
    if (phase >= 1) {
      ctx.save();
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      for (const [lambda, indices] of buckets) {
        const [r, g, b] = wavelengthToDisplayRgb(lambda);
        ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.beginPath();
        for (const index of indices) {
          const pts = paths[index].points;
          const from = pts[pts.length - 2], to = pts[pts.length - 1];
          ctx.moveTo(toX(from.x), toY(from.y));
          ctx.lineTo(toX(to.x), toY(to.y));
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = '#ffffff';
    for (const indices of buckets.values()) {
      for (const index of indices) {
        const e = paths[index].events[1];
        ctx.beginPath();
        ctx.arc(toX(e.x), toY(e.y), 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    /* ---- hover and selection ---- */

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

    drawPathLegend(plot);
  }

  function drawArrowHead(x1, y1, x2, y2, size) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - size * Math.cos(angle - 0.42), y2 - size * Math.sin(angle - 0.42));
    ctx.lineTo(x2 - size * Math.cos(angle + 0.42), y2 - size * Math.sin(angle + 0.42));
    ctx.closePath();
    ctx.fill();
  }

  /** One rule in four lines: colour means this light reaches your eye. */
  function drawPathLegend(plot) {
    const rows = [
      { key: 'canvas.legendArriving', colour: true, width: 2.4 },
      { key: 'canvas.legendOffView', colour: false, width: 1 },
      { key: 'canvas.legendMissed', colour: false, width: 1 },
      { key: 'canvas.legendThrough', colour: false, width: 1 },
    ];
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labels = rows.map((row) => i18n.t(row.key));
    let width = 0;
    for (const label of labels) width = Math.max(width, ctx.measureText(label).width);
    const boxW = width + 32;
    const boxH = rows.length * 15 + 8;
    const x = plot.x + 8;
    const y = plot.y + 8;
    ctx.fillStyle = 'rgba(5, 7, 13, 0.66)';
    ctx.fillRect(x, y, boxW, boxH);
    for (let i = 0; i < rows.length; i++) {
      const cy = y + 12 + i * 15;
      ctx.lineWidth = rows[i].width;
      if (rows[i].colour) {
        // The swatch is a spectrum, because that is what the rule means: these
        // are the rays whose wavelength you are being shown.
        ctx.globalAlpha = 0.95;
        const gradient = ctx.createLinearGradient(x + 6, 0, x + 22, 0);
        for (let k = 0; k <= 4; k++) {
          const [r, g, b] = wavelengthToDisplayRgb(430 + k * 60);
          gradient.addColorStop(k / 4, `rgb(${r}, ${g}, ${b})`);
        }
        ctx.strokeStyle = gradient;
      } else {
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = '#8a93a6';
      }
      ctx.beginPath();
      ctx.moveTo(x + 6, cy);
      ctx.lineTo(x + 22, cy);
      ctx.stroke();
      ctx.globalAlpha = rows[i].colour ? 0.92 : 0.55;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(labels[i], x + 27, cy);
    }
    ctx.restore();
  }

  // Straight in the world, straight on screen: the altitude axis is linear, so
  // a leg needs no subdivision to land on the altitudes it really passes
  // through, and a ray looks like what it is.
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

/**
 * The altitude axis is LINEAR.
 *
 * An earlier version compressed it by a power law to give the dense lower air
 * more room. The price was that a ray which is straight in the world became a
 * curve on screen, which is exactly the wrong lesson in a picture about light
 * travelling in straight lines. The room is bought a different way instead: the
 * frame is cropped to the air that actually matters - see frameTopFor.
 */
const HALF_WIDTH_FACTOR = 1.5;

/**
 * Top of the drawn frame.
 *
 * Three scale heights hold 95 % of the column, so cropping there costs almost
 * nothing and buys back the vertical room the power law used to steal - the
 * air that does the scattering gets most of the picture instead of the bottom
 * tenth of it. The frame always extends far enough to contain the observer, so
 * climbing towards space still works, and never past the real top of the
 * atmosphere.
 */
export function frameTopFor(atmosphere, observerAltitude) {
  const wanted = Math.max(3 * atmosphere.scaleHeightRayleigh, observerAltitude * 1.15);
  return Math.max(1, Math.min(atmosphere.topAltitude, wanted));
}
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

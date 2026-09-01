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
import { RAY_BANDS } from '../physics/spectrum.js';
import { VIEW_CONE_HALF_DEG, drawnRayShare, isRayDrawn } from './photons.js';
import { clampSpan } from '../state.js';
import { v3 } from '../physics/geometry.js';

const FIELD_COLUMNS = 26;
const FIELD_ROWS = 34;
/**
 * The deepest shaft the picture draws to scale, as a depth-to-radius ratio.
 * Beyond this the cone would be thinner than a line, so the shaft is drawn
 * stubbier than it is and both the true ratio and the true angle are printed.
 */
/** How many of the blocked directions to draw, once nearly all of them are. */
const MAX_DRAWN_BLOCKED = 26;

export function createSceneRenderer(canvas, { i18n, colorimetry }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let data = null;
  let field = null;          // offscreen canvas holding the atmospheric glow
  let fieldKey = null;       // what that glow was computed for
  let layout = null;         // geometry of the last frame, for hit testing
  let hoveredPath = -1;
  let selectedPath = -1;
  /** The brightest arriving bundle seen, so a dimmer one can be drawn dimmer. */

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
   *
   * The grid is laid out in screen space and lifted into the world through the
   * camera, so zooming out re-evaluates the same integrator over a bigger piece
   * of the planet rather than stretching a picture of a small one. Cells below
   * the surface or above the atmosphere are left transparent; the ground and
   * the black of space are painted separately.
   */
  function buildField(result, camera, plot) {
    const scene = result.primary.scene;
    const atm = result.atmosphere;
    const off = document.createElement('canvas');
    off.width = FIELD_COLUMNS;
    off.height = FIELD_ROWS;
    const octx = off.getContext('2d');
    const image = octx.createImageData(FIELD_COLUMNS, FIELD_ROWS);

    for (let row = 0; row < FIELD_ROWS; row++) {
      const sy = plot.y + ((row + 0.5) / FIELD_ROWS) * plot.h;
      for (let col = 0; col < FIELD_COLUMNS; col++) {
        const sx = plot.x + ((col + 0.5) / FIELD_COLUMNS) * plot.w;
        const world = camera.unproject(sx, sy);
        const radius = Math.hypot(world.x, world.y);
        const altitude = radius - camera.R;
        const i = (row * FIELD_COLUMNS + col) * 4;
        if (altitude < 0 || altitude > atm.topAltitude) {
          image.data[i + 3] = 0;
          continue;
        }
        const point = v3(world.x, world.y, 0);
        const spectrum = computeScatteringSource(scene, point, 0, QUALITY_PRESETS.preview);
        const c = colorimetry.spectrumToSrgb(spectrum, result.exposure * FIELD_GAIN);
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
    // The terrain is lit by the beam that reaches the SURFACE, which is not the
    // beam that reaches the observer: down a shaft the latter is blocked, and
    // colouring the whole landscape from it turned the ground black while the
    // Sun was still up. What the shaft blocks is the observer's view, not the
    // countryside. Night still darkens it, because then there is no beam.
    const lit = !beam.belowHorizon;
    for (let i = 0; i < spectrum.length; i++) {
      spectrum[i] = lit
        ? albedo * result.source[i] * beam.transmittance[i] * cosSun : 0;
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
    // The glow field is built lazily on the first draw, because it depends on
    // the plot rectangle and so on the size of the canvas.
    fieldKey = null;
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

    // One picture, always. An earlier version switched to a purpose-drawn
    // schematic of the shaft, which meant the shaft was the one situation the
    // simulation did not actually simulate - it was a diagram of what the
    // answer would be. The shaft is now part of the same cross-section, cut out
    // of the ground, with the same traced rays running into its walls.
    drawAtmosphereView(pw, ph, evaluation, z, timeMs, caption === null);

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

    const plot = plotRect(w, h);
    const span = spanFor(data.state, atm, z);
    const camera = makeCamera(atm, plot, span,
      belowGroundFor(data.state), Math.max(0, -z));

    // The glow is expensive, so it is rebuilt only when what it depends on
    // moves - which now includes the zoom and the size of the canvas.
    const key = `${span}|${Math.round(plot.w)}x${Math.round(plot.h)}`;
    if (allowInteraction && fieldKey !== key) {
      field = buildField(data.result, camera, plot);
      fieldKey = key;
    }
    const panelField = allowInteraction ? field : buildField(data.result, camera, plot);

    ctx.save();
    ctx.beginPath();
    ctx.rect(plot.x, plot.y, plot.w, plot.h);
    ctx.clip();

    if (panelField) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(panelField, plot.x, plot.y, plot.w, plot.h);
      ctx.restore();
    }

    // The planet, drawn as the arc it is. At close zoom the sagitta is a
    // fraction of a pixel and it looks like a flat horizon on its own.
    fillPlanet(plot, camera, groundColor(data.result));

    drawAltitudeArcs(plot, camera, atm);
    drawStarMarker(plot, evaluation);
    drawApertureCone(plot, camera, z);
    drawViewCone(plot, camera, z);
    if (data.photons && data.state.rays.showScattering) {
      drawPhotons(plot, camera, z, timeMs, allowInteraction);
    }
    drawObserverAt(camera, z, evaluation);
    ctx.restore();

    // Outside the clip: the labels live in the left margin, which is not part
    // of the plot rectangle the rays are clipped to.
    drawAltitudeLabels(plot, camera, atm);
    drawScaleBar(plot, camera);
    if (allowInteraction) layout = { plot, camera, mode: 'atmosphere' };
  }

  /** The drawing area inside the canvas, shared by the view and the tracer. */
  function plotRect(w, h) {
    const padLeft = 52, padRight = 12, padTop = 10, padBottom = 26;
    return { x: padLeft, y: padTop, w: w - padLeft - padRight, h: h - padTop - padBottom };
  }

  /**
   * The piece of the world that is on screen, for whoever needs to sample it.
   *
   * The ray tracer has to lay its paths out over exactly the region that will be
   * drawn, and it runs before the first frame, so it asks here rather than
   * guessing at the canvas geometry.
   */
  function frameFor(state, atmosphere) {
    const { w, h } = cssSize();
    const plot = plotRect(w, h);
    const camera = makeCamera(atmosphere, plot,
      spanFor(state, atmosphere, state.observer.z), belowGroundFor(state),
      Math.max(0, -state.observer.z));
    return {
      span_m: camera.span,
      halfWidth_m: camera.halfWidth,
      skyExtent_m: camera.skyExtent,
    };
  }

  /** How far below the surface the frame has to reach, in metres. */
  function belowGroundFor(state) {
    const well = state.observer.well;
    return well.enabled ? Math.max(well.depth_m, -state.observer.z) : 0;
  }

  /** Which vertical extent is on screen: the observer's choice, or the default. */
  function spanFor(state, atmosphere, z) {
    return state.camera?.span_m != null
      ? clampSpan(state.camera.span_m)
      : autoSpanFor(atmosphere, z, state.observer.well);
  }

  /**
   * Fill everything below the surface. The surface is a circle of radius R about
   * the origin, so the boundary is sampled across the plot and closed downwards.
   */
  function fillPlanet(plot, camera, colour) {
    const steps = 96;
    ctx.save();
    ctx.beginPath();
    let started = false;
    for (let i = 0; i <= steps; i++) {
      const sx = plot.x + (i / steps) * plot.w;
      const worldX = (sx - camera.cx) / camera.scale;
      // The surface point directly "below" this column: y = sqrt(R^2 - x^2).
      const inside = camera.R * camera.R - worldX * worldX;
      const worldY = inside > 0 ? Math.sqrt(inside) : 0;
      const p = camera.project({ x: worldX, y: worldY });
      if (!started) { ctx.moveTo(p.x, p.y); started = true; } else ctx.lineTo(p.x, p.y);
    }
    ctx.lineTo(plot.x + plot.w, plot.y + plot.h);
    ctx.lineTo(plot.x, plot.y + plot.h);
    ctx.closePath();
    ctx.fillStyle = colour;
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    cutShaft(camera);
  }

  /**
   * The shaft, as what it is: a hole in the ground, drawn to scale in the same
   * frame as everything else. At a wide zoom it is narrower than a pixel and
   * simply does not show, which is the truth about a two-metre shaft under a
   * hundred kilometres of air - zoom in to see it.
   */
  function cutShaft(camera) {
    const well = data.state.observer.well;
    if (!well.enabled) return;
    const top = camera.project({ x: -well.radius_m, y: camera.R });
    const bottom = camera.project({ x: well.radius_m, y: camera.R - well.depth_m });
    const width = bottom.x - top.x;
    if (width < 0.4) return;

    ctx.save();
    ctx.fillStyle = '#05070c';
    ctx.fillRect(top.x, top.y, width, bottom.y - top.y);
    ctx.strokeStyle = 'rgba(255,235,205,0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(top.x, top.y);
    ctx.lineTo(top.x, bottom.y);
    ctx.moveTo(top.x + width, top.y);
    ctx.lineTo(top.x + width, bottom.y);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Altitude gridlines. They are circles about the planet centre, so at wide
   * zoom the top of the atmosphere is visibly a shell wrapped round a ball -
   * which is the whole reason the zoom exists.
   */
  function drawAltitudeArcs(plot, camera, atm) {
    ctx.save();
    for (const value of altitudeTicksFor(camera, atm)) {
      const top = value === atm.topAltitude;
      ctx.strokeStyle = top ? 'rgba(160,200,255,0.35)' : 'rgba(255,255,255,0.10)';
      ctx.setLineDash(top ? [5, 4] : []);
      ctx.beginPath();
      const steps = 64;
      for (let i = 0; i <= steps; i++) {
        const sx = plot.x + (i / steps) * plot.w;
        const worldX = (sx - camera.cx) / camera.scale;
        const radius = camera.R + value;
        const inside = radius * radius - worldX * worldX;
        if (inside <= 0) continue;
        const q = camera.project({ x: worldX, y: Math.sqrt(inside) });
        if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  /** The altitudes those arcs stand for, written in the left margin. */
  function drawAltitudeLabels(plot, camera, atm) {
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    // Zoomed out, the whole atmosphere is a few pixels tall and every tick
    // lands on the same row. Keep the ones that are legibly apart, and always
    // keep the top of the atmosphere, which is the one worth naming.
    const ticks = altitudeTicksFor(camera, atm);
    let lastY = -Infinity;
    for (let i = ticks.length - 1; i >= 0; i--) {
      const value = ticks[i];
      const label = camera.project({ x: 0, y: camera.R + value });
      if (label.y < plot.y + 6 || label.y > plot.y + plot.h - 4) continue;
      if (label.y - lastY < 13 && value !== 0) continue;
      lastY = label.y;
      ctx.fillStyle = value === atm.topAltitude
        ? 'rgba(160,200,255,0.8)' : 'rgba(255,255,255,0.5)';
      ctx.fillText(formatAltitude(value), plot.x - 6, label.y);
    }
    ctx.restore();
  }

  /** Which altitudes get an arc and a label at this zoom. */
  function altitudeTicksFor(camera, atm) {
    const ticks = niceAltitudeTicks(Math.min(atm.topAltitude, camera.skyExtent));
    if (!ticks.includes(atm.topAltitude) && atm.topAltitude <= camera.skyExtent) {
      ticks.push(atm.topAltitude);
    }
    return ticks;
  }

  /** A bar giving the horizontal scale, which now changes with the zoom. */
  function drawScaleBar(plot, camera) {
    const target = plot.w * 0.22;
    const metres = niceRoundDistance(target / camera.scale);
    const px = metres * camera.scale;
    const y = plot.y + plot.h + 14;
    const x = plot.x + 4;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y);
    ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 4);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(formatAltitude(metres), x + px + 6, y - 8);
    ctx.restore();
  }

  /** The observer, with its sight line, placed through the camera. */
  function drawObserverAt(camera, z, evaluation) {
    // Not clamped to the surface: down a shaft, that is the whole point.
    const p = camera.project({ x: 0, y: camera.R + z });
    drawObserver(p.x, p.y, evaluation, z);
  }

  /**
   * A marker showing where the star sits. The beams themselves are not drawn
   * here: the traced `through` paths carry the real, spectrally weighted
   * version of the same light, and a second set of decorative rays only
   * competed with it.
   */
  function drawStarMarker(plot, evaluation) {
    const color = data.result.primary.colors.source.css;
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    const mx = plot.x + plot.w - 8;
    const my = plot.y + 10
      + (1 - Math.max(0, Math.min(1, data.state.star.elevationDeg / 90))) * (plot.h * 0.35);
    ctx.beginPath();
    ctx.arc(mx - 26, my, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'right';
    ctx.fillText(i18n.t('canvas.star'), mx, my + 3);
    ctx.restore();
  }

  /**
   * The only sky a shaft leaves.
   *
   * Without this the picture is honestly puzzling: the air above is bright blue
   * and nothing arrives, and the reason - that the rock has taken all of the
   * sky except a sliver - is implied by the stopped rays rather than shown.
   * This is that sliver, at arctan(R/depth), drawn to scale from the observer
   * out through the mouth. The blue you can actually have is the blue inside it.
   */
  function drawApertureCone(plot, camera, z) {
    const well = data.state.observer.well;
    if (!well.enabled || z >= 0) return;
    const half = wellApertureHalfAngle(-z, well.radius_m);
    if (!(half > 0) || half >= Math.PI / 2 - 1e-6) return;

    const origin = { x: 0, y: camera.R + z };
    const reach = camera.span * 3;
    const edge = (angle) => camera.project({
      x: origin.x + Math.sin(angle) * reach,
      y: origin.y + Math.cos(angle) * reach,
    });
    const o = camera.project(origin);
    const left = edge(-half);
    const right = edge(half);

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(150, 210, 255, 0.10)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(150, 210, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([5, 3]);
    for (const side of [left, right]) {
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(side.x, side.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(180, 220, 255, 0.85)';
    ctx.textAlign = 'left';
    ctx.fillText('θmax = ' + formatAngle(half * 180 / Math.PI), plot.x + 8, plot.y + 14);
    ctx.restore();
  }

  /**
   * The cone of sky the observer is looking down.
   *
   * The panels report one radiance, one spectrum and one colour, and all three
   * are properties of this cone. Drawing it makes that concrete: the coloured
   * rays inside the wedge are the ones being measured, the grey ones outside
   * are everything else.
   */
  function drawViewCone(plot, camera, z) {
    const state = data.state;
    const sign = Math.cos(state.observer.viewAzimuthDeg * Math.PI / 180) >= 0 ? 1 : -1;
    const axis = sign * state.observer.viewZenithDeg * Math.PI / 180;
    const half = VIEW_CONE_HALF_DEG * Math.PI / 180;
    const origin = { x: 0, y: camera.R + z };
    const reach = camera.span * 3;

    // One straight segment per edge, generously long and clipped by the plot
    // rectangle. Straight is exact here: the projection is orthographic.
    const edge = (angle) => ({
      x: origin.x + Math.sin(angle) * reach,
      y: origin.y + Math.cos(angle) * reach,
    });
    const o = camera.project(origin);
    const left = camera.project(edge(axis - half));
    const right = camera.project(edge(axis + half));

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(right.x, right.y);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.075)';
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (const side of [left, right]) {
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      ctx.lineTo(side.x, side.y);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.72)';
    ctx.textAlign = 'center';
    const label = camera.project({
      x: origin.x + Math.sin(axis) * camera.span * 0.55,
      y: origin.y + Math.cos(axis) * camera.span * 0.55,
    });
    ctx.fillText(i18n.t('canvas.viewCone'),
      Math.max(plot.x + 60, Math.min(plot.x + plot.w - 60, label.x)),
      Math.max(plot.y + 12, label.y));
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
  function drawPhotons(plot, camera, observerZ, timeMs, allowInteraction) {
    const project = camera.project;
    const paths = data.photons;
    const animate = data.state.rays.animate;
    const phase = animate ? (timeMs / 2600) % 1 : 1;

    const state = data.state;
    const sign = Math.cos(state.observer.viewAzimuthDeg * Math.PI / 180) >= 0 ? 1 : -1;
    const axis = sign * state.observer.viewZenithDeg * Math.PI / 180;
    const half = VIEW_CONE_HALF_DEG * Math.PI / 180;

    const observerWorld = { x: 0, y: camera.R + observerZ };

    /**
     * Where in the sky a scattering event sits, as the observer sees it.
     *
     * The cone is a volume, not a list of ray labels, and what decides whether
     * a ray belongs to it is where its event happened. This matters because the
     * light feeding those events arrives from somewhere else entirely - down
     * the line to the star, which at a low Sun is nearly at right angles to
     * where you are looking. A ray can therefore come into the cone from any
     * direction at all; what makes it yours is that it turned inside the cone
     * and left along the line to your eye.
     */
    const eventAngle = (p) => {
      const e = p.events[1];
      return Math.atan2(e.x - observerWorld.x, e.y - observerWorld.y);
    };

    /** Did this ray's turn happen inside the cone the observer is looking down? */
    const turnsInCone = (p) => p.scatterCount > 0
      && Math.abs(eventAngle(p) - axis) <= half;

    /**
     * Is this ray part of what the observer is currently looking at?
     *
     * Colour is reserved for exactly these: light that turned inside the cone
     * AND turned towards the eye. Everything else - the same turn made a few
     * degrees the wrong way, light arriving from the rest of the sky, light
     * that crossed without ever interacting - is drawn grey. The rule is one
     * sentence long and it is the whole legend.
     */
    const involved = (p) => p.kind === 'arriving' && turnsInCone(p);

    /**
     * An event inside the cone whose light goes somewhere else.
     *
     * These are the control group, and they are the reason the cone is drawn as
     * a volume rather than a bundle of lines: the same air, the same star, the
     * same deflection, one of them lands in your eye and the other does not.
     * They are ringed rather than coloured, so they read as events you are
     * looking straight at and still cannot see.
     */
    const missedInCone = (p) => p.kind === 'missed' && turnsInCone(p);

    // How many of the arriving rays get drawn, and why that number and not
    // another. See paths.columnFraction: it is the share of the air still above
    // the observer, which is the share of the sky's brightness that is left, so
    // the rays on screen and the colour beside them fall by the same factor.
    // Count alone, never opacity - a ray that reaches you is an ordinary ray,
    // and drawing it faintly would say the light arrives weakened, which is a
    // different claim and a false one.
    const share = drawnRayShare(paths);
    const drawnArriving = (index) => isRayDrawn(index, share);

    const GREY = '#8a93a6';
    // Grey, but not invisible: zoomed out, the long chord an unscattered beam
    // has to cross IS the demonstration, so it gets the strongest of the greys.
    const contextAlpha = { through: 0.30, missed: 0.16, arriving: 0.13 };
    const contextWidth = { through: 1.2, missed: 1, arriving: 1 };

    /**
     * Every arriving ray outside the cone also ends at the observer, so drawn
     * in full they make a grey starburst on top of the very convergence the
     * cone exists to show. Only every third is drawn. It is a drawing density,
     * chosen by index so it stays put as the view turns, and it changes nothing
     * the panels report.
     */
    const GREY_ARRIVING_STRIDE = 3;
    const asContext = (p, i) => !involved(p) && !missedInCone(p)
      && (p.kind !== 'arriving' || (i % GREY_ARRIVING_STRIDE === 0 && drawnArriving(i)));

    /* ---- everything outside the cone, in grey ---- */

    for (const kind of ['through', 'missed', 'arriving']) {
      ctx.save();
      ctx.strokeStyle = GREY;
      ctx.lineWidth = contextWidth[kind];
      ctx.globalAlpha = contextAlpha[kind];
      ctx.beginPath();
      for (let i = 0; i < paths.length; i++) {
        const p = paths[i];
        if (p.kind !== kind || !asContext(p, i)) continue;
        if (i === selectedPath || i === hoveredPath) continue;
        strokePath(p, project, phase);
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.save();
    // Scattering vertices outside the cone: every one is still a photon taken
    // out of the beam, so they are drawn - just not celebrated.
    ctx.fillStyle = GREY;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (p.scatterCount === 0 || !asContext(p, i)) continue;
      ctx.globalAlpha = 0.22;
      if (i === selectedPath || i === hoveredPath) continue;
      const e = project(p.events[1]);
      ctx.beginPath();
      ctx.arc(e.x, e.y, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
    // Arrowheads on the paths that leave: without them a stub reads as a line
    // rather than as light departing in a direction that misses you.
    ctx.globalAlpha = 0.3;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (p.kind !== 'missed' || !asContext(p, i)) continue;
      if (i === selectedPath || i === hoveredPath) continue;
      const from = project(p.points[p.points.length - 2]);
      const to = project(p.points[p.points.length - 1]);
      drawArrowHead(from.x, from.y, to.x, to.y, 4.5);
    }
    ctx.restore();

    /* ---- events inside the cone whose light goes elsewhere ---- */

    // Drawn brighter than the rest of the grey, and ringed. You are looking
    // straight at these; the air turned the light exactly where the coloured
    // rays turned it, and a few degrees of deflection sent it past your eye
    // instead of into it. Without them the cone looks like a place where light
    // simply arrives, rather than a place where most of what happens misses.
    ctx.save();
    ctx.strokeStyle = GREY;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    for (let i = 0; i < paths.length; i++) {
      if (!missedInCone(paths[i]) || i === selectedPath || i === hoveredPath) continue;
      strokePath(paths[i], project, phase);
    }
    ctx.stroke();

    ctx.globalAlpha = 0.55;
    ctx.fillStyle = GREY;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (!missedInCone(p) || i === selectedPath || i === hoveredPath) continue;
      const from = project(p.points[p.points.length - 2]);
      const to = project(p.points[p.points.length - 1]);
      drawArrowHead(from.x, from.y, to.x, to.y, 4.5);
    }

    ctx.globalAlpha = 0.75;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
    ctx.lineWidth = 1.1;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (!missedInCone(p) || i === selectedPath || i === hoveredPath) continue;
      const e = project(p.events[1]);
      ctx.beginPath();
      ctx.arc(e.x, e.y, 3, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    /* ---- the rays the wall stops ---- */

    drawBlockedRays(paths, project);

    /* ---- the rays inside the cone, in their own colours ---- */

    const buckets = new Map();
    for (let i = 0; i < paths.length; i++) {
      if (!involved(paths[i]) || !drawnArriving(i)) continue;
      if (i === selectedPath || i === hoveredPath) continue;
      // One bucket per band, so the picture holds eight colours and no more.
      const key = paths[i].band ?? 0;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(i);
    }

    ctx.save();
    ctx.lineWidth = 1.3;
    ctx.globalAlpha = 0.85;
    for (const [band, indices] of buckets) {
      ctx.strokeStyle = RAY_BANDS[band].css;
      ctx.beginPath();
      for (const index of indices) strokePath(paths[index], project, phase);
      ctx.stroke();
    }
    ctx.restore();

    // The last leg - the one that actually enters the eye - is redrawn heavier,
    // or the incoming stubs swamp the convergence.
    if (phase >= 1) {
      ctx.save();
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      for (const [band, indices] of buckets) {
        ctx.strokeStyle = RAY_BANDS[band].css;
        ctx.beginPath();
        for (const index of indices) {
          const pts = paths[index].points;
          const from = project(pts[pts.length - 2]), to = project(pts[pts.length - 1]);
          ctx.moveTo(from.x, from.y);
          ctx.lineTo(to.x, to.y);
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
        const e = project(paths[index].events[1]);
        ctx.beginPath();
        ctx.arc(e.x, e.y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    /* ---- hover and selection ---- */

    for (const index of [hoveredPath, selectedPath]) {
      if (index < 0 || index >= paths.length) continue;
      const p = paths[index];
      const [r, g, b] = RAY_BANDS[p.band ?? 0].rgb;
      ctx.save();
      ctx.strokeStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.lineWidth = index === selectedPath ? 2.6 : 1.8;
      ctx.shadowColor = `rgba(${r}, ${g}, ${b}, 0.9)`;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      strokePath(p, project, 1);
      ctx.stroke();
      ctx.shadowBlur = 0;
      for (const e of p.events) {
        if (e.type !== 'scatter' && e.type !== 'absorb') continue;
        ctx.fillStyle = e.type === 'absorb' ? '#ff5a5a' : '#ffffff';
        const q = project(e);
        ctx.beginPath();
        ctx.arc(q.x, q.y, e.type === 'absorb' ? 3.5 : 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    drawPathLegend(plot);
  }

  /**
   * Directions the shaft wall refuses.
   *
   * These are ordinary traced rays that never became scattering paths, because
   * the rock was in the way before the air was. Each is drawn from the point on
   * the wall where it stops down to the observer, so the picture shows which
   * part of the sky has been taken away and by what. Only a sample is drawn:
   * once the aperture is a couple of degrees nearly every direction is blocked,
   * and all of them at once is a solid fan that hides the few that get through.
   */
  function drawBlockedRays(paths, project) {
    const blocked = [];
    for (const p of paths) if (p.kind === 'blocked') blocked.push(p);
    if (blocked.length === 0) return;
    const stride = Math.max(1, Math.round(blocked.length / MAX_DRAWN_BLOCKED));

    ctx.save();
    for (let i = 0; i < blocked.length; i += stride) {
      const p = blocked[i];
      const hit = project(p.points[0]);
      const eye = project(p.points[1]);
      if (Math.hypot(hit.x - eye.x, hit.y - eye.y) < 3) continue;

      ctx.strokeStyle = 'rgba(255, 138, 90, 0.34)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(eye.x, eye.y);
      ctx.lineTo(hit.x, hit.y);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.strokeStyle = 'rgba(255, 138, 90, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(hit.x - 3, hit.y - 3);
      ctx.lineTo(hit.x + 3, hit.y + 3);
      ctx.moveTo(hit.x + 3, hit.y - 3);
      ctx.lineTo(hit.x - 3, hit.y + 3);
      ctx.stroke();
    }
    ctx.restore();
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

  /**
   * The rule, and the palette it is written in.
   *
   * Every coloured ray is one of eight bands, picked in proportion to the
   * light's own spectrum, so the colours are countable and counting them reads
   * the spectrum off the picture. The swatch shows them as eight blocks rather
   * than a smooth ramp for exactly that reason: a ramp cannot be counted.
   */
  function drawPathLegend(plot) {
    const rows = [
      { key: 'canvas.legendArriving', style: 'bands', width: 2.4 },
      { key: 'canvas.legendInCone', style: 'ring', width: 1 },
      { key: 'canvas.legendOffView', style: 'grey', width: 1 },
      { key: 'canvas.legendMissed', style: 'grey', width: 1 },
      { key: 'canvas.legendThrough', style: 'grey', width: 1 },
    ];
    const swatchW = 34;
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const labels = rows.map((row) => i18n.t(row.key));
    let width = 0;
    for (const label of labels) width = Math.max(width, ctx.measureText(label).width);
    const boxW = width + swatchW + 20;
    const boxH = rows.length * 15 + 8;
    const x = plot.x + 8;
    const y = plot.y + 8;
    ctx.fillStyle = 'rgba(5, 7, 13, 0.66)';
    ctx.fillRect(x, y, boxW, boxH);

    const left = x + 6;
    const right = left + swatchW - 12;
    for (let i = 0; i < rows.length; i++) {
      const cy = y + 12 + i * 15;
      ctx.lineWidth = rows[i].width;
      if (rows[i].style === 'bands') {
        ctx.globalAlpha = 0.95;
        const step = (right - left) / RAY_BANDS.length;
        for (let b = 0; b < RAY_BANDS.length; b++) {
          ctx.strokeStyle = RAY_BANDS[b].css;
          ctx.beginPath();
          ctx.moveTo(left + b * step, cy);
          // A hair of overlap, so the blocks abut instead of leaving seams.
          ctx.lineTo(left + (b + 1) * step + 0.5, cy);
          ctx.stroke();
        }
      } else if (rows[i].style === 'ring') {
        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = '#8a93a6';
        ctx.beginPath();
        ctx.moveTo(left, cy);
        ctx.lineTo(right, cy);
        ctx.stroke();
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.arc((left + right) / 2, cy, 3, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = '#8a93a6';
        ctx.beginPath();
        ctx.moveTo(left, cy);
        ctx.lineTo(right, cy);
        ctx.stroke();
      }
      ctx.globalAlpha = rows[i].style === 'bands' ? 0.92 : 0.55;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(labels[i], x + swatchW, cy);
    }
    ctx.restore();
  }

  // Straight in the world, straight on screen: the altitude axis is linear, so
  // a leg needs no subdivision to land on the altitudes it really passes
  // through, and a ray looks like what it is.
  function strokePath(path, project, phase) {
    const pts = path.points;
    if (pts.length < 2) return;
    const limit = phase >= 1 ? pts.length : Math.max(2, Math.ceil(pts.length * phase));
    const first = project(pts[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < limit; i++) {
      const q = project(pts[i]);
      ctx.lineTo(q.x, q.y);
    }
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

  /* ---------------------------------------------------------------- */

  /** Find the traced ray nearest to a canvas point. */
  function pick(clientX, clientY) {
    if (!layout || !data || !data.photons) return -1;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const project = layout.camera.project;
    let best = -1, bestDist = 12;
    for (let i = 0; i < data.photons.length; i++) {
      const pts = data.photons[i].points;
      let previous = project(pts[0]);
      for (let k = 1; k < pts.length; k++) {
        const current = project(pts[k]);
        const d = distanceToSegment(px, py, previous.x, previous.y, current.x, current.y);
        if (d < bestDist) { bestDist = d; best = i; }
        previous = current;
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
    update, draw, pick, frameFor,
    setHovered(index) { hoveredPath = index; },
    setSelected(index) { selectedPath = index; },
    getSelected() { return selectedPath; },
  };
}

/* Shared constants and helpers -------------------------------------- */

/**
 * The cross-section is drawn in true spherical geometry, orthographically
 * projected: the planet centre sits at the origin of world coordinates and the
 * camera is a plain translate-and-scale. Two consequences, both deliberate.
 *
 * Straight rays stay straight. An early version compressed the altitude axis by
 * a power law to give the dense lower air more room, which bent every ray on
 * screen - the wrong lesson in a picture about light travelling in straight
 * lines. Here it is the GROUND that curves, which is the truth, and at close
 * zoom that curve is a fraction of a pixel, so the picture looks flat by itself.
 *
 * And the frame can be zoomed out until the curve matters. That is the only way
 * to draw the reason a low Sun is red: its light crosses a chord hundreds of
 * kilometres long, which does not fit in a picture of the local sky.
 */

/**
 * The span used when the observer has not chosen one: three scale heights,
 * which hold 95 % of the column, and always enough to contain the observer.
 */
export function autoSpanFor(atmosphere, observerAltitude, well = null) {
  // A shaft is a thing of metres under an atmosphere of kilometres, and no
  // single frame holds both. When there is a shaft to be in, the frame fits the
  // shaft; the zoom control reaches all the way back out to the atmosphere.
  if (well && well.enabled) {
    return clampSpan(Math.max(4 * well.radius_m, well.depth_m * 2.4, 20));
  }
  return clampSpan(Math.max(
    3 * atmosphere.scaleHeightRayleigh, Math.max(0, observerAltitude) * 1.35));
}

/**
 * How much of the frame is sky.
 *
 * Zoomed in, the ground belongs at the very bottom and the picture is all air.
 * Zoomed out, the planet has to be given room or its curve cannot be seen, so
 * the horizon rises towards the middle. Interpolated on the logarithm, because
 * that is how the zoom control moves.
 */
function skyFractionFor(span) {
  const lo = Math.log(6e4), hi = Math.log(2e6);
  const t = Math.max(0, Math.min(1, (Math.log(span) - lo) / (hi - lo)));
  return 0.95 + t * (0.42 - 0.95);
}

/**
 * The camera: everything the drawing needs to turn world metres into pixels,
 * and to know which piece of the world is on screen.
 */
export function makeCamera(atmosphere, plot, span, belowGround = 0, observerDepth = 0) {
  const R = atmosphere.planetRadius;
  // Normally the ground belongs near the bottom of the frame. When there is a
  // shaft the horizon rises to make room for it - and if the observer is deep
  // enough, or the zoom close enough, that the horizon has to leave the top of
  // the picture altogether, then it leaves. What must never leave is the
  // observer: a zoom that puts them off the bottom edge shows the walls of a
  // shaft with nobody in it, which is what happened before this second step.
  let skyFraction = belowGround > 0
    ? Math.min(skyFractionFor(span), 1 - (belowGround * 1.25) / span)
    : skyFractionFor(span);
  if (observerDepth > 0) {
    const observerFraction = skyFraction + observerDepth / span;
    if (observerFraction > 0.88) skyFraction -= observerFraction - 0.88;
    skyFraction = Math.min(skyFraction, 0.95);
  }
  const scale = plot.h / span;
  const cx = plot.x + plot.w / 2;
  const groundY = plot.y + skyFraction * plot.h;
  return {
    R, span, scale, skyFraction, groundY, cx,
    halfWidth: (plot.w / 2) / scale,
    skyExtent: skyFraction * span,
    project: (q) => ({ x: cx + q.x * scale, y: groundY - (q.y - R) * scale }),
    /** Screen point back to the world, for hit testing. */
    unproject: (sx, sy) => ({ x: (sx - cx) / scale, y: R + (groundY - sy) / scale }),
  };
}

const FIELD_GAIN = 5.4e3;

/** A round number of metres near `metres`, for the scale bar. */
function niceRoundDistance(metres) {
  const power = Math.pow(10, Math.floor(Math.log10(Math.max(1, metres))));
  for (const step of [1, 2, 5, 10]) {
    if (metres <= step * power) return step * power;
  }
  return 10 * power;
}

function niceAltitudeTicks(topAltitude) {
  // The zoom now spans three orders of magnitude, so the ticks are generated
  // rather than chosen from a table: roughly five of them, on a 1-2-5 ladder.
  const step = niceRoundDistance(Math.max(1, topAltitude) / 4);
  const ticks = [];
  for (let v = 0; v <= topAltitude + 1e-6; v += step) ticks.push(Math.round(v));
  return ticks.slice(0, 9);
}

export function formatAltitude(metres) {
  const a = Math.abs(metres);
  if (a === 0) return '0 m';
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

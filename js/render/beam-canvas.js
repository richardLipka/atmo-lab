/**
 * The single-beam view: one sunbeam through the air, colour by colour.
 *
 * Two pictures of the same physics (physics/beam.js):
 *
 *   'macro'  The beam's whole path from the top of the atmosphere to an
 *            observer on the ground, drawn in the planet's own coordinates.
 *            The beam is a straight line, as it is in reality: if heights
 *            have to be stretched to fit, the whole picture is stretched
 *            evenly, which keeps a straight line straight and shows the
 *            ground curving away beneath it. The beam's colour is the colour
 *            of the light still in it; short lines of each colour leave it
 *            where that colour is scattered out (that light is the sky).
 *            Spectrum flags at a few points along the path, and a chart below,
 *            show how much of each colour is left. An inset shows the second,
 *            much weaker colour effect: refraction lifts a low Sun, blue a
 *            little more than red.
 *
 *   'micro'  A magnified piece of air with molecules, haze grains and ozone
 *            molecules, drawn still. Each particle's target size for a given
 *            colour is set so the chamber has the same optical depth as the
 *            real path, kind by kind and colour by colour. One ray can be
 *            chosen; its collisions are numbered, and the readout panel says
 *            what each one did.
 *
 * Nothing here computes physics of its own; it draws what beam.js returns.
 */

import {
  traceBeam, singleColourSpectrum, createChamber, traceChamberBundle,
} from '../physics/beam.js';
import { createAtmosphere } from '../physics/atmosphere.js';
import { makeBlackbodySpectrum, RAY_BANDS, BAND_OF_BIN, WAVELENGTHS_NM, SPECTRUM_BINS } from '../physics/spectrum.js';

/** The sun's temperature for the white beam, as in the rest of the simulator. */
const SUN_TEMPERATURE_K = 5800;
/** The narrowest stretch of ground the macro picture shows, so a high Sun still has air around it. */
const MACRO_MIN_SPAN_M = 150e3;
/** Settings that change the physics; the others only change what is drawn. */
const PHYSICS_KEYS = ['elevationDeg', 'mode', 'wavelengthNm', 'densityScale', 'aerosolScale', 'aerosolPresetId', 'rayleighExponent'];
/** The blue band, the most eventful one to show first. */
const DEFAULT_BAND = 1;

export const DEFAULT_BEAM_STATE = {
  viewType: 'macro',
  bundleMode: 'bundle',
  elevationDeg: 20,
  mode: 'sunlight',
  wavelengthNm: 450,
  densityScale: 1,
  aerosolScale: 1,
  aerosolPresetId: null,
  rayleighExponent: 4,
  selectedBand: null,
  selectedRay: null,
};

/** The bands a source actually contains. */
export function bandsOf(source) {
  const present = new Set();
  for (let i = 0; i < SPECTRUM_BINS; i++) if (source[i] > 0) present.add(BAND_OF_BIN[i]);
  return [...present].sort((a, b) => a - b);
}

export function buildBeamModel(state, { config, colorimetry }) {
  const world = config.atmospheres.get('earth');
  const preset = state.aerosolPresetId
    ? config.scattering.get('aerosols')?.presets?.[state.aerosolPresetId]
    : undefined;
  const atmosphere = createAtmosphere(world, {
    densityScale: state.densityScale,
    aerosolScale: state.aerosolScale,
    rayleighExponent: state.rayleighExponent,
    aerosol: preset,
  });
  let source;
  if (state.mode === 'monochromatic') {
    source = singleColourSpectrum(state.wavelengthNm);
  } else {
    source = makeBlackbodySpectrum(SUN_TEMPERATURE_K);
    colorimetry.normalizeToLuminance(source, 1);
  }
  const trace = traceBeam({ atmosphere, source, elevationDeg: state.elevationDeg });
  return { atmosphere, source, trace, bands: bandsOf(source) };
}

/**
 * The chosen ray in the chamber: the colour asked for if the light has it,
 * and the ray asked for, or else one near the middle that meets something.
 */
export function resolveSelection(state, model, bundle) {
  const bands = model.bands;
  const band = bands.includes(state.selectedBand) ? state.selectedBand
    : bands.includes(DEFAULT_BAND) ? DEFAULT_BAND : bands[0];
  const rays = bundle.rays.filter((r) => r.band === band);
  let index = Number.isInteger(state.selectedRay) && state.selectedRay >= 0 && state.selectedRay < rays.length
    ? state.selectedRay : null;
  if (index === null) {
    const middle = Math.floor(rays.length / 2);
    const order = rays.map((_, k) => k).sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
    index = order.find((k) => rays[k].events.length > 0) ?? middle;
  }
  return { band, index, ray: rays[index], count: rays.length };
}

/** A small deterministic generator, so the picture is the same on every redraw. */
function hashRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

export function createBeamCanvas(canvas, { i18n, colorimetry, config, onPick }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let state = { ...DEFAULT_BEAM_STATE };
  let model = null;
  let chamber = null;
  let bundle = null;
  let selection = null;
  let chamberSize = { w: 0, h: 0 };
  const t = (key, params) => i18n.t(key, params);

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(320, rect.width || 800);
    const h = Math.max(240, rect.height || 450);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function chamberRect(w, h) {
    return { x: 70, y: 52, w: Math.max(120, w - 160), h: Math.max(100, h - 52 - 50) };
  }

  function recompute() {
    model = buildBeamModel(state, { config, colorimetry });
    const { w, h } = resize();
    const rect = chamberRect(w, h);
    chamberSize = { w: rect.w, h: rect.h };
    chamber = createChamber({ width: rect.w, height: rect.h, tauByKind: model.trace.tauByKind });
    bundle = traceChamberBundle(chamber, { bands: model.bands, raysPerBand: model.bands.length > 1 ? 24 : 60 });
    // Each ray's number within its colour: rays come colour by colour, in order of height.
    const seen = {};
    for (const ray of bundle.rays) { ray.index = seen[ray.band] ?? 0; seen[ray.band] = ray.index + 1; }
  }

  function update(next) {
    let physics = !model;
    for (const [k, v] of Object.entries(next ?? {})) {
      if (state[k] !== v) {
        state[k] = v;
        if (PHYSICS_KEYS.includes(k)) physics = true;
      }
    }
    if (physics) recompute();
    draw();
  }

  /* Choosing a ray: the nearest drawn ray within a few pixels of the pointer. */
  function rayNear(event) {
    // Only the chosen ray is drawn in 'single' mode; it is chosen in the panel.
    if (state.viewType !== 'micro' || state.bundleMode === 'single' || !bundle) return null;
    const box = canvas.getBoundingClientRect();
    const rect = chamberRect(box.width, box.height);
    const px = event.clientX - box.left - rect.x;
    const py = event.clientY - box.top - rect.y;
    let best = null;
    for (const ray of bundle.rays) {
      for (let i = 1; i < ray.points.length; i++) {
        // Rays of the chosen colour win where colours share a line.
        const d = distanceToSegment(px, py, ray.points[i - 1], ray.points[i]) - (ray.band === selection?.band ? 3 : 0);
        if (d < 9 && (!best || d < best.d)) best = { d, ray };
      }
    }
    return best?.ray ?? null;
  }

  canvas.addEventListener('pointerdown', (event) => {
    const ray = rayNear(event);
    if (ray) onPick?.({ selectedBand: ray.band, selectedRay: ray.index });
  });
  canvas.addEventListener('pointermove', (event) => {
    canvas.style.cursor = rayNear(event) ? 'pointer' : '';
  });

  window.addEventListener('resize', () => { if (model) { recompute(); draw(); } });

  function draw() {
    if (!model) recompute();
    const { w, h } = resize();
    if (Math.abs(chamberRect(w, h).w - chamberSize.w) > 1 || Math.abs(chamberRect(w, h).h - chamberSize.h) > 1) {
      recompute();
    }
    selection = resolveSelection(state, model, bundle);
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, w, h);
    if (state.viewType === 'micro') drawMicro(w, h); else drawMacro(w, h);
  }

  /* ---------------------------------------------------------------- */
  /* macro: the whole path                                            */
  /* ---------------------------------------------------------------- */

  /** The colour of a spectrum at a fixed brightness: its hue alone. */
  function hueOf(spectrum) {
    const lum = colorimetry.luminance(spectrum);
    if (!(lum > 1e-30)) return '#000000';
    return colorimetry.spectrumToSrgb(spectrum, 0.8 / lum).css;
  }

  function drawMacro(w, h) {
    const trace = model.trace;
    const R = model.atmosphere.planetRadius;
    const pts = trace.points;
    const top = pts[0].altitude;
    const bands = model.bands;
    const initial = pts[0].bands;
    const shareLeft = (p, b) => (initial[b] > 0 ? p.bands[b] / initial[b] : 0);

    const geoH = Math.round(h * 0.56);
    const plot = { x: 12, y: 10, w: w - 24, h: geoH - 10 };
    const obsX = plot.x + plot.w - 74;

    // The stretch of ground to show, and the scale: equal in both directions
    // if the picture fits, otherwise heights stretched by a stated factor.
    // Stretching the plane evenly keeps straight lines straight.
    const sag = (x) => R - Math.sqrt(Math.max(0, R * R - x * x));
    const spanX = Math.max(MACRO_MIN_SPAN_M, pts[0].x * 1.1 + 30e3);
    const headroom = 36;   // px above the top of the air, for the Sun
    const yHigh = top;
    const yLow = -sag(spanX) - 6e3;
    const sxFit = (obsX - plot.x - 12) / spanX;
    const syFit = (plot.h - headroom) / (yHigh - yLow);
    const sx = Math.min(sxFit, syFit);
    const sy = syFit;
    const stretch = sy / sx;
    const X = (x) => obsX - x * sx;
    const Y = (yRel) => plot.y + headroom + (yHigh - yRel) * sy;
    const toScreen = (p) => ({ x: X(p.x), y: Y(p.y - R) });
    const shellAt = (screenX, altitude) => {
      const x = (obsX - screenX) / sx;
      const r = R + altitude;
      return Y(Math.sqrt(Math.max(0, r * r - x * x)) - R);
    };

    ctx.save();
    ctx.beginPath(); ctx.rect(plot.x, plot.y, plot.w, plot.h); ctx.clip();

    // The air, layer by layer, as dense as it is at that height.
    const layers = 25;
    for (let k = 0; k < layers; k++) {
      const a0 = (k / layers) * top, a1 = ((k + 1) / layers) * top;
      const rho = Math.exp(-((a0 + a1) / 2) / 8.5e3);
      ctx.fillStyle = `rgba(70, 120, 200, ${0.04 + 0.42 * rho})`;
      ctx.beginPath();
      for (let sxp = plot.x; sxp <= plot.x + plot.w + 4; sxp += 4) ctx.lineTo(sxp, shellAt(sxp, a1));
      for (let sxp = plot.x + plot.w + 4; sxp >= plot.x; sxp -= 4) ctx.lineTo(sxp, shellAt(sxp, a0));
      ctx.closePath();
      ctx.fill();
    }
    // The ground.
    ctx.fillStyle = '#2b2620';
    ctx.beginPath();
    for (let sxp = plot.x; sxp <= plot.x + plot.w + 4; sxp += 4) ctx.lineTo(sxp, shellAt(sxp, 0));
    ctx.lineTo(plot.x + plot.w + 4, plot.y + plot.h + 4);
    ctx.lineTo(plot.x, plot.y + plot.h + 4);
    ctx.closePath();
    ctx.fill();
    // Outlines: the top of the atmosphere and the surface.
    ctx.lineWidth = 1;
    for (const [alt, style] of [[top, 'rgba(140,180,255,0.45)'], [0, 'rgba(200,170,120,0.6)']]) {
      ctx.strokeStyle = style;
      ctx.setLineDash(alt ? [4, 4] : []);
      ctx.beginPath();
      for (let sxp = plot.x; sxp <= plot.x + plot.w + 4; sxp += 4) ctx.lineTo(sxp, shellAt(sxp, alt));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    // On whichever side the beam leaves free: it enters on the left when the Sun is low.
    const topLabelX = X(pts[0].x) < plot.x + plot.w * 0.45 ? obsX - 250 : plot.x + 8;
    ctx.fillText(t('beam.canvas.top', { km: Math.round(top / 1000) }), topLabelX, shellAt(topLabelX, top) - 3);
    ctx.textBaseline = 'top';
    ctx.fillText(t('beam.canvas.ground'), obsX + 34, Y(0) + 7);

    // Heights above the observer.
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    for (let km = 0; km <= top / 1000 + 0.5; km += 20) {
      const yy = Y(km * 1000);
      ctx.beginPath(); ctx.moveTo(obsX + 26, yy); ctx.lineTo(obsX + 31, yy); ctx.stroke();
      ctx.fillText(`${km} km`, obsX + 34, yy);
    }
    ctx.beginPath(); ctx.moveTo(obsX + 26, Y(0)); ctx.lineTo(obsX + 26, Y(top)); ctx.stroke();

    const screen = pts.map(toScreen);
    const start = screen[0], end = screen[screen.length - 1];
    const dx = end.x - start.x, dy = end.y - start.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    // The side of the beam facing up, away from the ground.
    let nx = -uy, ny = ux;
    if (ny > 0) { nx = -nx; ny = -ny; }

    // Sunlight in space, before it meets any air: straight, and still all the colours it set out with.
    const single = bands.length === 1;
    const spaceColour = single ? RAY_BANDS[bands[0]].css : 'rgba(255,250,235,0.95)';
    const room = Math.min(ux > 0.01 ? (start.x - plot.x) / ux : Infinity, uy > 0.01 ? (start.y - plot.y) / uy : Infinity);
    const back = Math.min(90, Math.max(20, room - 22));
    const sun = { x: start.x - ux * back, y: start.y - uy * back };
    ctx.strokeStyle = spaceColour;
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(sun.x, sun.y); ctx.lineTo(start.x, start.y); ctx.stroke();
    const glow = ctx.createRadialGradient(sun.x, sun.y, 2, sun.x, sun.y, 20);
    glow.addColorStop(0, 'rgba(255,250,235,1)');
    glow.addColorStop(0.45, 'rgba(255,240,200,0.9)');
    glow.addColorStop(1, 'rgba(255,230,180,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(sun.x, sun.y, 20, 0, Math.PI * 2); ctx.fill();

    // Light knocked out of the beam: short lines of its own colour, as many
    // as the share of that colour each step loses, pointing every way.
    const perBand = 55;
    bands.forEach((b) => {
      const rng = hashRng(977 * (b + 1));
      ctx.strokeStyle = RAY_BANDS[b].css;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.8;
      let carry = rng();
      for (let i = 1; i < pts.length; i++) {
        carry += (initial[b] > 0 ? pts[i].shed[b] / initial[b] : 0) * perBand;
        while (carry >= 1) {
          carry -= 1;
          const along = rng();
          const bx = screen[i - 1].x + (screen[i].x - screen[i - 1].x) * along;
          const by = screen[i - 1].y + (screen[i].y - screen[i - 1].y) * along;
          // Any direction away from the beam's own line.
          const turn = (25 + 130 * rng()) * Math.PI / 180 * (rng() < 0.5 ? 1 : -1);
          const cx = Math.cos(turn) * ux - Math.sin(turn) * uy;
          const cy = Math.sin(turn) * ux + Math.cos(turn) * uy;
          const r0 = 5, r1 = 5 + 8 + 8 * rng();
          ctx.beginPath();
          ctx.moveTo(bx + cx * r0, by + cy * r0);
          ctx.lineTo(bx + cx * r1, by + cy * r1);
          ctx.stroke();
        }
      }
    });
    ctx.globalAlpha = 1;

    // The beam: the colour of the light left in it, as wide as how much is left.
    const sourceLum = Math.max(1e-30, colorimetry.luminance(model.source));
    ctx.lineCap = 'round';
    for (let i = 1; i < pts.length; i++) {
      const share = colorimetry.luminance(pts[i].spectrum) / sourceLum;
      ctx.strokeStyle = single ? RAY_BANDS[bands[0]].css : hueOf(pts[i].spectrum);
      ctx.lineWidth = 1.5 + 4.5 * Math.min(1, share);
      ctx.beginPath(); ctx.moveTo(screen[i - 1].x, screen[i - 1].y); ctx.lineTo(screen[i].x, screen[i].y); ctx.stroke();
    }
    ctx.lineCap = 'butt';

    // The observer.
    ctx.fillStyle = single ? RAY_BANDS[bands[0]].css : hueOf(trace.transmittedSpectrum);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(end.x, end.y - 6, 5.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(end.x, end.y - 1); ctx.lineTo(end.x, end.y + 2); ctx.stroke();

    // Spectrum flags: what is left of each colour at a few points on the way.
    const flags = flagPoints(pts, bands, shareLeft);
    drawFlags(flags, screen, nx, ny, plot, obsX, bands, shareLeft);
    ctx.restore();

    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    // Below the ground line: above it, the flags' letter tags crowd round the observer.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText(t('beam.canvas.observer'), end.x - 4, end.y + 5);
    ctx.textBaseline = 'bottom';
    // Beside the Sun, on the side away from the picture's edge.
    const sunOnRight = sun.x > plot.x + plot.w / 2;
    ctx.textAlign = sunOnRight ? 'right' : 'left';
    // Below the light in space when the Sun is low: the A tag sits above it.
    const entryText = single ? t('beam.canvas.entryColour', { nm: Math.round(RAY_BANDS[bands[0]].centreNm) }) : t('beam.canvas.entry');
    if (sunOnRight) ctx.fillText(entryText, sun.x - 24, Math.max(plot.y + 14, sun.y - 6));
    else { ctx.textBaseline = 'top'; ctx.fillText(entryText, sun.x + 24, sun.y + 8); ctx.textBaseline = 'bottom'; }

    // What the picture's scale is, and what its marks mean.
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    ctx.textBaseline = 'alphabetic';
    const scale = stretch < 1.15 ? t('beam.canvas.scaleTrue') : t('beam.canvas.scaleStretched', { m: stretch.toFixed(1) });
    ctx.fillText(`${t('beam.canvas.pathInfo', {
      km: Math.round(trace.pathLengthM / 1000), airmass: trace.airMass.toFixed(1),
    })} · ${scale}`, plot.x, geoH + 14);
    ctx.fillText(t('beam.canvas.legend'), plot.x, geoH + 29);
    ctx.restore();

    const row = { y: geoH + 40, h: h - geoH - 46 };
    const chartW = Math.round((w - 24) * 0.63);
    drawShareChart({ x: plot.x, y: row.y, w: chartW, h: row.h }, pts, bands, shareLeft, flags);
    drawRefractionInset({ x: plot.x + chartW + 10, y: row.y, w: w - 24 - chartW - 10, h: row.h });
  }

  /**
   * Where to plant the flags: the entry, the observer, and the two points
   * where a third and two thirds of the light that will be lost is gone -
   * so each step between flags shows the same amount of change.
   */
  function flagPoints(pts, bands, shareLeft) {
    const lost = (p) => bands.reduce((s, b) => s + 1 - shareLeft(p, b), 0) / bands.length;
    const total = lost(pts[pts.length - 1]);
    const picks = [0];
    for (const f of [1 / 3, 2 / 3]) {
      const i = pts.findIndex((p) => lost(p) >= f * total);
      if (i > picks[picks.length - 1] && i < pts.length - 1) picks.push(i);
    }
    picks.push(pts.length - 1);
    return picks.map((i) => ({ i, s: pts[i].s, altitude: pts[i].altitude, column: pts[i].airColumn }));
  }

  /**
   * The flags stand in a row near the bottom of the picture, out of the
   * beam's way; a lettered mark on the beam and a thin line show where each
   * one was taken. Most of the light is lost in the dense air near the
   * ground, so the marks there can be close together: their letters are
   * stacked instead of overlapping.
   */
  function drawFlags(flags, screen, nx, ny, plot, obsX, bands, shareLeft) {
    const barW = bands.length > 1 ? 6 : 12, gap = 1, barH = 26;
    ctx.font = '9.5px system-ui, sans-serif';
    const labels = flags.map((f) => t('beam.canvas.flagWhere', {
      km: Math.round(f.s / 1000), alt: (f.altitude / 1000).toFixed(f.altitude < 10e3 ? 1 : 0),
    }));
    const boxW = Math.max(bands.length * (barW + gap) + 24, ...labels.map((l) => ctx.measureText(l).width + 10));
    const boxH = barH + 24;
    const left = plot.x + 8, right = obsX - 60;
    const n = flags.length;
    const step = n > 1 ? Math.min(boxW + 40, (right - left - boxW) / (n - 1)) : 0;
    const by = plot.y + plot.h - boxH - 8;

    // Letter tags beside the beam, pushed apart where marks crowd together.
    const tags = [];
    flags.forEach((f) => {
      const at = screen[f.i];
      let d = 14;
      let tag = { x: at.x + nx * d, y: at.y + ny * d };
      while (tags.some((o) => Math.hypot(o.x - tag.x, o.y - tag.y) < 17) && d < 120) {
        d += 17;
        tag = { x: at.x + nx * d, y: at.y + ny * d };
      }
      tags.push(tag);
    });

    flags.forEach((f, k) => {
      const at = screen[f.i];
      const p = model.trace.points[f.i];
      const letter = String.fromCharCode(65 + k);
      const bx = left + k * step;
      const tag = tags[k];

      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(bx + boxW / 2, by); ctx.lineTo(tag.x, tag.y); ctx.stroke();
      ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.beginPath(); ctx.moveTo(at.x, at.y); ctx.lineTo(tag.x, tag.y); ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(at.x, at.y, 2.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(tag.x, tag.y, 7.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#05070d';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(letter, tag.x, tag.y + 0.5);

      ctx.fillStyle = 'rgba(5,7,13,0.92)';
      ctx.fillRect(bx, by, boxW, boxH);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.strokeRect(bx + 0.5, by + 0.5, boxW - 1, boxH - 1);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(letter, bx + 5, by + 4);
      const x0 = bx + 18, base = by + 4 + barH;
      bands.forEach((b, j) => {
        const share = Math.max(0, Math.min(1, shareLeft(p, b)));
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fillRect(x0 + j * (barW + gap), base - barH, barW, barH);
        ctx.fillStyle = RAY_BANDS[b].css;
        ctx.fillRect(x0 + j * (barW + gap), base - barH * share, barW, barH * share);
      });
      ctx.font = '9.5px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.fillText(labels[k], bx + 5, base + 5);
    });
  }

  /**
   * How much of each colour is still in the beam, against how much of the
   * path's air the light has crossed. Against distance, nearly all the change
   * would be squeezed into the last few kilometres, where the air is dense;
   * against the air crossed, each colour fades steadily, and the faster the
   * more strongly that colour is scattered.
   */
  function drawShareChart(box, pts, bands, shareLeft, flags) {
    const L = Math.max(1e-9, pts[pts.length - 1].airColumn);
    const area = { x: box.x + 34, y: box.y + 32, w: box.w - 34 - 70, h: box.h - 32 - 26 };
    if (area.h < 30 || area.w < 80) return;
    const X = (column) => area.x + (column / L) * area.w;
    const Y = (v) => area.y + (1 - v) * area.h;
    ctx.save();
    ctx.fillStyle = 'rgba(5,7,13,0.9)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(t('beam.canvas.chartTitle'), box.x + 8, box.y + 10);

    ctx.font = '9.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.textAlign = 'right';
    for (const v of [0, 0.5, 1]) {
      ctx.fillText(`${Math.round(v * 100)} %`, area.x - 4, Y(v));
      ctx.beginPath(); ctx.moveTo(area.x, Y(v)); ctx.lineTo(area.x + area.w, Y(v)); ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const f of [0, 0.25, 0.5, 0.75, 1]) ctx.fillText(`${f * 100} %`, X(f * L), area.y + area.h + 3);
    ctx.textAlign = 'left';
    ctx.fillText(t('beam.canvas.chartAxis'), area.x, area.y + area.h + 14);

    // The flags' positions, so chart and picture can be read together.
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    flags.forEach((f, k) => {
      const x = X(f.column);
      ctx.beginPath(); ctx.moveTo(x, area.y); ctx.lineTo(x, area.y + area.h); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.font = 'bold 9.5px system-ui, sans-serif';
      ctx.fillText(String.fromCharCode(65 + k), Math.min(x, area.x + area.w - 4), area.y - 1);
    });
    ctx.setLineDash([]);

    ctx.lineWidth = 1.8;
    const labels = [];
    for (const b of bands) {
      ctx.strokeStyle = RAY_BANDS[b].css;
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.airColumn), Y(shareLeft(p, b))) : ctx.moveTo(X(p.airColumn), Y(shareLeft(p, b)))));
      ctx.stroke();
      labels.push({ b, v: shareLeft(pts[pts.length - 1], b) });
    }
    // Labels at the end, pushed apart so they do not overlap, and kept in the box.
    labels.sort((a, c) => c.v - a.v);
    const gapY = 9.5;
    const ys = [];
    labels.forEach((l, k) => ys.push(Math.max(Y(l.v), k ? ys[k - 1] + gapY : -Infinity)));
    const bottom = box.y + box.h - 6;
    for (let k = ys.length - 1; k >= 0; k--) ys[k] = Math.min(ys[k], k === ys.length - 1 ? bottom : ys[k + 1] - gapY);
    ctx.font = '9px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    labels.forEach((l, k) => {
      ctx.fillStyle = RAY_BANDS[l.b].css;
      ctx.fillText(`${Math.round(RAY_BANDS[l.b].centreNm)} nm ${formatPct(l.v)}`, area.x + area.w + 5, ys[k]);
    });
    ctx.restore();
  }

  function formatPct(v) {
    const p = v * 100;
    const text = p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2);
    return `${i18n.getLanguage?.() === 'cs' ? text.replace('.', ',') : text} %`;
  }

  /**
   * Refraction and its dispersion, at a glance: the Sun drawn once per colour,
   * each image lifted by that colour's refraction. The differences between the
   * colours are tiny, so they are magnified by a stated factor; the brightness
   * of each image is the share of that colour still in the beam.
   */
  function drawRefractionInset(box) {
    const refr = model.trace.refraction;
    const bands = model.bands;
    if (box.w < 120 || box.h < 70) return;
    ctx.save();
    ctx.fillStyle = 'rgba(5,7,13,0.9)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(t('beam.canvas.refractionTitle'), box.x + 8, box.y + 10);

    const mid = refr[Math.min(4, refr.length - 1)].arcmin;
    const spread = refr[0].arcmin - refr[refr.length - 1].arcmin;   // violet minus red
    const radius = Math.max(10, Math.min(22, (box.h - 40) / 3));
    const cx = box.x + 14 + radius;
    const cy = box.y + 22 + (box.h - 22) / 2;
    // Magnify the colour differences so the whole spread spans ~16 px.
    const pxPerArcmin = 16 / Math.max(1e-6, spread);
    const magnification = pxPerArcmin * (32 / (2 * radius));   // relative to the disc's own scale
    ctx.globalCompositeOperation = 'lighter';
    const initial = model.trace.points[0].bands;
    const final = model.trace.points[model.trace.points.length - 1].bands;
    const strongest = Math.max(...bands.map((b) => (initial[b] > 0 ? final[b] / initial[b] : 0)), 1e-9);
    for (const b of bands) {
      const lift = (refr[b].arcmin - mid) * pxPerArcmin;
      const share = initial[b] > 0 ? final[b] / initial[b] : 0;
      const [r, g, bl] = RAY_BANDS[b].rgb;
      ctx.fillStyle = `rgba(${r},${g},${bl},${Math.min(1, 0.9 * share / strongest)})`;
      ctx.beginPath();
      ctx.arc(cx, cy - lift, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '10px system-ui, sans-serif';
    const tx = cx + radius + 12;
    ctx.fillText(t('beam.canvas.refractionLift', { arcmin: mid.toFixed(1) }), tx, cy - 16);
    ctx.fillText(t('beam.canvas.refractionSpread', { arcsec: (spread * 60).toFixed(1) }), tx, cy);
    ctx.fillText(t('beam.canvas.refractionMagnified', { m: Math.round(magnification) }), tx, cy + 16);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* micro: the collision chamber                                     */
  /* ---------------------------------------------------------------- */

  const KIND_STYLE = {
    rayleigh: { ring: 'rgba(130,185,255,0.75)' },
    aerosolScatter: { ring: 'rgba(230,200,140,0.75)' },
    aerosolAbsorb: { ring: 'rgba(200,140,100,0.75)' },
    ozone: { ring: 'rgba(255,170,90,0.75)' },
  };

  function drawMicro(w, h) {
    const rect = chamberRect(w, h);
    const single = state.bundleMode === 'single';
    const chosen = selection.ray;

    ctx.save();
    ctx.translate(rect.x, rect.y);
    ctx.fillStyle = '#080b14';
    ctx.fillRect(0, 0, rect.w, rect.h);

    // Emitter and detector.
    ctx.fillStyle = '#1a2233';
    ctx.fillRect(-18, 0, 14, rect.h);
    ctx.fillRect(rect.w + 4, 0, 14, rect.h);
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.save();
    ctx.translate(-26, rect.h / 2); ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillText(t('beam.micro.source'), 0, 0);
    ctx.restore();
    ctx.save();
    ctx.translate(rect.w + 30, rect.h / 2); ctx.rotate(Math.PI / 2);
    ctx.textAlign = 'center'; ctx.fillText(t('beam.micro.detector'), 0, 0);
    ctx.restore();

    // Inside the chamber. It repeats top to bottom, so particles near one
    // edge are also drawn beyond the other, where a ray can meet them.
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, rect.w, rect.h); ctx.clip();
    if (single) drawTargets(selection.band, rect.h);
    drawParticles(rect.h);
    if (!single) {
      // All colours enter at the same heights, so their straight rays lie on
      // top of each other: the other colours stay faint, the chosen colour shows.
      for (const ray of bundle.rays) if (ray.band !== chosen.band) drawRay(ray, 0.1);
      for (const ray of bundle.rays) if (ray.band === chosen.band && ray !== chosen) drawRay(ray, 0.35);
    }
    for (const e of chosen.events) drawTarget(e.kind, e.at, chamber.halfWidths[e.kind][selection.band], true);
    drawRay(chosen, 1);
    ctx.restore();
    drawChosenMarks(chosen, rect);
    ctx.strokeStyle = 'rgba(120,150,200,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, rect.w - 1, rect.h - 1);
    ctx.restore();

    drawMicroCaption(w, h, chosen);
  }

  function drawTarget(kind, at, b, strong) {
    if (!(b > 0.4)) return;
    ctx.strokeStyle = KIND_STYLE[kind].ring;
    ctx.lineWidth = strong ? 1.6 : 1;
    ctx.setLineDash(strong ? [] : [3, 3]);
    ctx.globalAlpha = strong ? 1 : 0.7;
    ctx.beginPath(); ctx.arc(at.x, at.y, b, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  /** Every particle's target for the chosen colour. */
  function drawTargets(band, height) {
    for (const p of chamber.particles) {
      const b = chamber.halfWidths[p.kind][band];
      for (const shift of [-height, 0, height]) drawTarget(p.kind, { x: p.x, y: p.y + shift }, b, false);
    }
  }

  function drawParticles(height) {
    for (const p of chamber.particles) {
      for (const shift of [-height, 0, height]) {
        const x = p.x, y = p.y + shift;
        if (y < -12 || y > height + 12) continue;
        if (p.kind === 'rayleigh') {
          ctx.fillStyle = '#6aa9ff';
          for (const s of [1, -1]) {
            ctx.beginPath(); ctx.arc(x + s * 2.6 * Math.cos(p.phase), y + s * 2.6 * Math.sin(p.phase), 2.2, 0, Math.PI * 2); ctx.fill();
          }
        } else if (p.kind === 'ozone') {
          ctx.fillStyle = '#ffae5c';
          for (let k = 0; k < 3; k++) {
            const a = p.phase + k * 2.1;
            ctx.beginPath(); ctx.arc(x + 3 * Math.cos(a), y + 3 * Math.sin(a), 1.9, 0, Math.PI * 2); ctx.fill();
          }
        } else {
          ctx.fillStyle = p.kind === 'aerosolAbsorb' ? '#6b4a2e' : '#d9b77a';
          ctx.beginPath(); ctx.arc(x, y, 5.5, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }

  function drawRay(ray, alpha) {
    const emphasised = alpha >= 1;
    ctx.save();
    if (emphasised) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 5;
      ctx.beginPath();
      ray.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    }
    ctx.strokeStyle = RAY_BANDS[ray.band].css;
    ctx.lineWidth = emphasised ? 2.6 : 1.2;
    ctx.globalAlpha = emphasised ? 1 : alpha;
    ctx.beginPath();
    ray.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.restore();
  }

  /** The chosen ray's collisions, numbered as in the readout panel, and how it ended. */
  function drawChosenMarks(ray, rect) {
    ctx.save();
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ray.events.forEach((e, k) => {
      if (e.action === 'absorb') {
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 2.2;
        ctx.beginPath();
        ctx.moveTo(e.x - 5, e.y - 5); ctx.lineTo(e.x + 5, e.y + 5);
        ctx.moveTo(e.x + 5, e.y - 5); ctx.lineTo(e.x - 5, e.y + 5);
        ctx.stroke();
      }
      // A numbered tag a little above the collision, kept inside the chamber.
      const tx = Math.max(10, Math.min(rect.w - 10, e.x + 10));
      const ty = Math.max(10, Math.min(rect.h - 10, e.y - 14));
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(tx, ty, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#05070d';
      ctx.fillText(String(k + 1), tx, ty + 0.5);
    });
    const endPoint = ray.points[ray.points.length - 1];
    if (ray.fate === 'direct') {
      ctx.fillStyle = '#7dffa8';
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.fillText('✓', Math.min(rect.w - 8, endPoint.x - 8), endPoint.y - 10);
    }
    ctx.restore();
  }

  function drawMicroCaption(w, h, chosen) {
    ctx.save();
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(t('beam.micro.chosenCaption', {
      nm: Math.round(RAY_BANDS[chosen.band].centreNm),
      n: selection.index + 1, count: selection.count,
      fate: t(`beam.micro.fate.${chosen.fate}`),
    }), 70, h - 28);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(state.bundleMode === 'single' ? t('beam.micro.singleHint') : t('beam.micro.bundleHint'), 70, h - 12);
    ctx.fillText(t('beam.micro.scaleNote'), 70, 18);

    // A key to the particles.
    const keys = [
      ['rayleigh', t('beam.micro.key.rayleigh')],
      ['ozone', t('beam.micro.key.ozone')],
      ['aerosolScatter', t('beam.micro.key.aerosolScatter')],
      ['aerosolAbsorb', t('beam.micro.key.aerosolAbsorb')],
    ];
    let x = 70;
    const y = 36;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (const [kind, label] of keys) {
      const p = { kind, x: x + 6, y, phase: 0.6 };
      if (kind === 'rayleigh') {
        ctx.fillStyle = '#6aa9ff';
        for (const s of [1, -1]) { ctx.beginPath(); ctx.arc(p.x + s * 2.6 * Math.cos(p.phase), y + s * 2.6 * Math.sin(p.phase), 2.2, 0, Math.PI * 2); ctx.fill(); }
      } else if (kind === 'ozone') {
        ctx.fillStyle = '#ffae5c';
        for (let k = 0; k < 3; k++) { const a = p.phase + k * 2.1; ctx.beginPath(); ctx.arc(p.x + 3 * Math.cos(a), y + 3 * Math.sin(a), 1.9, 0, Math.PI * 2); ctx.fill(); }
      } else {
        ctx.fillStyle = kind === 'aerosolAbsorb' ? '#6b4a2e' : '#d9b77a';
        ctx.beginPath(); ctx.arc(p.x, y, 5, 0, Math.PI * 2); ctx.fill();
      }
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(label, x + 15, y);
      x += 15 + ctx.measureText(label).width + 16;
      if (x > w - 120) break;
    }
    ctx.restore();
  }

  return {
    update,
    draw,
    getTraceResult: () => ({ model, bundle, selection, chamber, state: { ...state } }),
  };
}

function distanceToSegment(px, py, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const l2 = vx * vx + vy * vy;
  const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * vx + (py - a.y) * vy) / l2)) : 0;
  return Math.hypot(px - (a.x + u * vx), py - (a.y + u * vy));
}

/** Wavelength in nanometres of the bin a source holds, for labels. */
export function wavelengthOfBin(i) { return WAVELENGTHS_NM[i]; }

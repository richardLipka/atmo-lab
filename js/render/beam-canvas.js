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
import { CHAMBER_SAMPLE, particlePattern, moleculeCrossSection } from '../physics/mie.js';
import { drawTestBench, drawWaveStrip } from './particle-strips.js';
import { drawParticleView } from './particle-view.js';
import { drawCrowdView } from './crowd-view.js';
import { drawSightlineView } from './sightline-view.js';
import { traceSightline } from '../physics/sightline.js';
import { makeBlackbodySpectrum, RAY_BANDS, BAND_OF_BIN, WAVELENGTHS_NM, SPECTRUM_BINS } from '../physics/spectrum.js';

/** The sun's temperature for the white beam, as in the rest of the simulator. */
const SUN_TEMPERATURE_K = 5800;
/** The narrowest stretch of ground the macro picture shows, so a high Sun still has air around it. */
const MACRO_MIN_SPAN_M = 150e3;
/**
 * How much the refraction inset magnifies the differences between the colours'
 * images: the half-arcminute spread at the horizon becomes a visible rim, and
 * the sub-arcsecond spread of a high Sun stays invisible, as it is.
 */
const REFRACTION_COLOUR_MAGNIFICATION = 20;
/** Settings that change the physics; the others only change what is drawn. */
const PHYSICS_KEYS = ['elevationDeg', 'mode', 'wavelengthNm', 'densityScale', 'aerosolScale', 'aerosolPresetId', 'rayleighExponent'];
/** The blue band, the most eventful one to show first. */
const DEFAULT_BAND = 1;

export const DEFAULT_BEAM_STATE = {
  viewType: 'particle',
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
  selectedEvent: null,
  particleDiameterUm: 0.0003,
  particleBand: 1,
  particleLog: false,
  particlePolar: false,
  crowdSize: 3,
  crowdSeed: 1,
  sightViewDeg: 0,
  sightHillKm: null,
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
  return { atmosphere, source, trace, bands: bandsOf(source), exponent: state.rayleighExponent };
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

/** At most this many near misses are marked on one ray. */
const MAX_NEAR_MISSES = 8;

/**
 * Particles the ray passed that another colour would have hit: the ray went
 * by closer than that colour's target is wide, but not close enough for its
 * own. All colours enter at the same heights, so up to the ray's first
 * collision these are exactly the particles that stop the other colours'
 * rays; further on they say where light of those colours, on this path,
 * would be scattered or absorbed.
 * @returns {Array<{particle:number, kind:string, x:number, y:number, distance:number, bands:number[], segment:number}>}
 */
export function nearMisses(ray, chamber, bands) {
  const { particles, halfWidths, height } = chamber;
  const met = new Set(ray.events.map((e) => e.particle));
  const out = [];
  for (let i = 0; i + 1 < ray.points.length; i++) {
    const a = ray.points[i], b = ray.points[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 0)) continue;
    const ux = dx / len, uy = dy / len;
    for (let k = 0; k < particles.length; k++) {
      if (met.has(k)) continue;
      const p = particles[k];
      const own = halfWidths[p.kind][ray.band] ?? 0;
      for (const shift of [-height, 0, height]) {
        const px = p.x - a.x, py = p.y + shift - a.y;
        const along = px * ux + py * uy;
        if (along <= 0 || along >= len) continue;
        const distance = Math.abs(px * uy - py * ux);
        if (distance <= own) continue;
        const others = bands.filter((bb) => bb !== ray.band && (halfWidths[p.kind][bb] ?? 0) > distance);
        if (others.length) {
          out.push({ particle: k, kind: p.kind, x: p.x, y: p.y + shift, distance, bands: others, segment: i, along });
        }
      }
    }
  }
  out.sort((m, n) => m.segment - n.segment || m.along - n.along);
  return out.slice(0, MAX_NEAR_MISSES);
}

/**
 * The collision the wave strip explains: the one asked for if it scattered the
 * ray, otherwise the ray's first scattering; null if nothing scattered it.
 */
export function chosenScatterEvent(ray, wanted) {
  const events = ray?.events ?? [];
  if (Number.isInteger(wanted) && events[wanted]?.action === 'scatter') return { index: wanted, event: events[wanted] };
  const index = events.findIndex((e) => e.action === 'scatter');
  return index >= 0 ? { index, event: events[index] } : null;
}

/**
 * How many times more strongly air molecules scatter band a than band b: the
 * ratio of their targets. (The chamber's own targets are averaged over each
 * band and differ from this by a couple of per cent.)
 */
export function rayleighBandRatio(model, a, b) {
  // At the bands' centre wavelengths, with the real air's law (Bodhaine et al.
  // 1999) and the exponent n set by the slider - the same numbers the test
  // bench and the one-particle view use.
  const n = model.exponent ?? 4;
  return moleculeCrossSection(RAY_BANDS[a].centreNm, n) / moleculeCrossSection(RAY_BANDS[b].centreNm, n);
}

/** In white light, the colour set beside the chosen one: red, or blue for red itself. */
export function contrastBand(model, band) {
  if (model.bands.length < 2) return null;
  return band === RAY_BANDS.length - 1 ? 1 : RAY_BANDS.length - 1;
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
  /** Where the chosen ray's numbered tags were drawn, in chamber coordinates. */
  let tagSpots = [];
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

  /**
   * The collision view, top to bottom: the test bench, the chamber, the wave
   * strip, and two lines of caption under each strip's title.
   */
  function microLayout(w, h) {
    const x = 70, width = Math.max(120, w - 160);
    const benchH = Math.round(Math.max(92, Math.min(132, h * 0.19)));
    const waveH = Math.round(Math.max(128, Math.min(190, h * 0.26)));
    const bench = { x, y: 22, w: width, h: benchH };
    const chamberY = bench.y + benchH + 42;
    const chamberH = Math.max(100, h - 40 - waveH - 22 - chamberY);
    const chamberBox = { x, y: chamberY, w: width, h: chamberH };
    const wave = { x, y: chamberY + chamberH + 22, w: width, h: waveH };
    return { bench, chamber: chamberBox, wave };
  }

  function chamberRect(w, h) { return microLayout(w, h).chamber; }

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

  /** A numbered collision tag under the pointer, if any. */
  function tagNear(event) {
    if (state.viewType !== 'micro') return null;
    const box = canvas.getBoundingClientRect();
    const rect = chamberRect(box.width, box.height);
    const px = event.clientX - box.left - rect.x;
    const py = event.clientY - box.top - rect.y;
    return tagSpots.find((spot) => Math.hypot(spot.x - px, spot.y - py) <= 10) ?? null;
  }

  /* Picture 5: aiming the line of sight with the pointer. */
  let sightLayout = null;
  let sightAiming = false;
  function sightAngleAt(event) {
    if (state.viewType !== 'sightline' || !sightLayout) return null;
    const box = canvas.getBoundingClientRect();
    const px = event.clientX - box.left, py = event.clientY - box.top;
    const pic = sightLayout.picture;
    if (px < pic.x || px > pic.x + pic.w || py < pic.y || py > pic.y + pic.h) return null;
    // Back from the stretched picture to true directions.
    const dx = (px - sightLayout.observer.x) / sightLayout.sx;
    const up = (sightLayout.observer.y - py) / sightLayout.sy;
    if (Math.hypot(px - sightLayout.observer.x, py - sightLayout.observer.y) < 6) return null;
    let angle = Math.atan2(dx, up) * 180 / Math.PI;
    angle = Math.max(-90, Math.min(90, angle));
    return Math.round(angle);
  }

  canvas.addEventListener('pointerdown', (event) => {
    const aim = sightAngleAt(event);
    if (aim !== null) {
      sightAiming = true;
      try { canvas.setPointerCapture(event.pointerId); } catch { /* not an active pointer */ }
      onPick?.({ sightViewDeg: aim });
      return;
    }
    const tag = tagNear(event);
    if (tag) { onPick?.({ selectedEvent: tag.index }); return; }
    const ray = rayNear(event);
    if (ray) onPick?.({ selectedBand: ray.band, selectedRay: ray.index, selectedEvent: null });
  });
  canvas.addEventListener('pointermove', (event) => {
    if (state.viewType === 'sightline') {
      const aim = sightAngleAt(event);
      canvas.style.cursor = aim !== null ? 'crosshair' : '';
      if (sightAiming && aim !== null && aim !== state.sightViewDeg) onPick?.({ sightViewDeg: aim });
      return;
    }
    canvas.style.cursor = tagNear(event) || rayNear(event) ? 'pointer' : '';
  });
  canvas.addEventListener('pointerup', () => { sightAiming = false; });
  canvas.addEventListener('pointercancel', () => { sightAiming = false; });

  // A new size makes a new chamber, so the panel describing its rays is redone too.
  window.addEventListener('resize', () => { if (model) { recompute(); draw(); onPick?.({}); } });

  let crowdResult = null;
  let sightCache = null;
  /** The line of sight of picture 5, and the zenith for comparison, recomputed only when they change. */
  function sightlineResult() {
    const key = `${state.elevationDeg}|${state.sightViewDeg}|${state.sightHillKm}|${state.densityScale}|${state.aerosolScale}|${state.aerosolPresetId}|${state.rayleighExponent}|${state.mode}|${state.wavelengthNm}`;
    if (sightCache?.key !== key) {
      const common = {
        atmosphere: model.atmosphere, source: model.source, wavelengths: WAVELENGTHS_NM,
        sunElevationDeg: Math.max(0, state.elevationDeg),
      };
      sightCache = {
        key,
        result: traceSightline({ ...common, viewDeg: state.sightViewDeg, hillKm: state.sightHillKm }),
        zenith: traceSightline({ ...common, viewDeg: 0, samples: 80 }),
      };
    }
    return sightCache;
  }

  function draw() {
    // The collision view needs more height for its strips.
    canvas.parentElement?.classList.toggle('is-micro', state.viewType === 'micro');
    if (!model) recompute();
    const { w, h } = resize();
    if (Math.abs(chamberRect(w, h).w - chamberSize.w) > 1 || Math.abs(chamberRect(w, h).h - chamberSize.h) > 1) {
      recompute();
    }
    selection = resolveSelection(state, model, bundle);
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, w, h);
    if (state.viewType === 'micro') drawMicro(w, h);
    else if (state.viewType === 'particle') {
      drawParticleView(ctx, {
        w, h, t, lang: i18n.getLanguage?.() ?? 'en',
        diameterUm: state.particleDiameterUm, band: state.particleBand, log: state.particleLog,
        exponent: state.rayleighExponent, polar: state.particlePolar,
      });
    } else if (state.viewType === 'crowd') {
      crowdResult = drawCrowdView(ctx, {
        w, h, t, lang: i18n.getLanguage?.() ?? 'en',
        band: state.particleBand, size: state.crowdSize, seed: state.crowdSeed,
      });
    } else if (state.viewType === 'sightline') {
      const sight = sightlineResult();
      sightLayout = drawSightlineView(ctx, {
        w, h, t, lang: i18n.getLanguage?.() ?? 'en', colorimetry,
        result: sight.result, zenith: sight.zenith,
        elevationDeg: state.elevationDeg, viewDeg: state.sightViewDeg, hillKm: state.sightHillKm,
      });
    } else drawMacro(w, h);
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
    const moleculePattern = particlePattern('molecule', 550);
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
          // Turned as a molecule turns light (most of what leaves the beam is
          // molecular scattering); turns under 25 degrees would lie on the beam
          // itself, which is also where the haze sends its light.
          let turnDeg;
          do { turnDeg = moleculePattern.turnAt(rng()); } while (turnDeg < 25 || turnDeg > 155);
          const turn = turnDeg * Math.PI / 180 * (rng() < 0.5 ? 1 : -1);
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
    const text = p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : '< 0.01';
    return `${i18n.getLanguage?.() === 'cs' ? text.replace('.', ',') : text} %`;
  }

  /**
   * Refraction and its dispersion, at a glance. The dashed circle is where the
   * Sun really is; the coloured discs are where each colour's image appears.
   * The lift is drawn at true scale against the Sun's own 32' disc, so it is
   * plain at the horizon and invisible high up. The differences between the
   * colours are far smaller - tens of arcseconds at most - so they alone are
   * magnified, by a fixed factor: a high Sun shows one white disc, a setting
   * Sun a blue rim on top and a red one below. Each image is as bright as the
   * share of its colour still in the beam.
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
    const spread = refr[1].arcmin - refr[refr.length - 1].arcmin;   // blue (430-465 nm) minus red
    // The largest lift, at the horizon, is about 1.8 solar radii: leave room for it.
    const radius = Math.max(8, Math.min(18, (box.h - 34) / 3.9));
    const pxPerArcmin = radius / 16;                  // the Sun's radius is 16'
    const cx = box.x + 16 + radius;
    const trueY = box.y + box.h - 8 - radius;
    const seenY = trueY - mid * pxPerArcmin;

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, trueY, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);

    ctx.globalCompositeOperation = 'lighter';
    const initial = model.trace.points[0].bands;
    const final = model.trace.points[model.trace.points.length - 1].bands;
    const strongest = Math.max(...bands.map((b) => (initial[b] > 0 ? final[b] / initial[b] : 0)), 1e-9);
    for (const b of bands) {
      const lift = (refr[b].arcmin - mid) * pxPerArcmin * REFRACTION_COLOUR_MAGNIFICATION;
      const share = initial[b] > 0 ? final[b] / initial[b] : 0;
      const [r, g, bl] = RAY_BANDS[b].rgb;
      ctx.fillStyle = `rgba(${r},${g},${bl},${Math.min(1, 0.9 * share / strongest)})`;
      ctx.beginPath();
      ctx.arc(cx, seenY - lift, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '10px system-ui, sans-serif';
    const tx = cx + radius + 12;
    const ty = box.y + 30;
    ctx.fillText(t('beam.canvas.refractionLift', { arcmin: mid.toFixed(1) }), tx, ty);
    ctx.fillText(t('beam.canvas.refractionTrue'), tx, ty + 15);
    ctx.fillText(t('beam.canvas.refractionSpread', { arcsec: (spread * 60).toFixed(1) }), tx, ty + 34);
    ctx.fillText(t('beam.canvas.refractionMagnified', { m: REFRACTION_COLOUR_MAGNIFICATION }), tx, ty + 49);
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
    drawNearMisses(nearMisses(chosen, chamber, model.bands));
    ctx.restore();
    drawChosenMarks(chosen, rect);
    ctx.strokeStyle = 'rgba(120,150,200,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, rect.w - 1, rect.h - 1);
    ctx.restore();

    drawMicroCaption(w, h, chosen);
    drawStrips(w, h, chosen);
  }

  /** The test bench above the chamber and the wave strip below it. */
  function drawStrips(w, h, chosen) {
    const layout = microLayout(w, h);
    const lang = i18n.getLanguage?.() ?? 'en';
    const band = selection.band;
    const contrast = contrastBand(model, band);
    const picked = chosenScatterEvent(chosen, state.selectedEvent);
    const particle = picked ? CHAMBER_SAMPLE[picked.event.kind] : 'molecule';
    const molRatio = contrast !== null ? rayleighBandRatio(model, band, contrast) : null;

    ctx.save();
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(contrast !== null
      ? t('beam.bench.title', { nm: Math.round(RAY_BANDS[band].centreNm), nmC: Math.round(RAY_BANDS[contrast].centreNm) })
      : t('beam.bench.titleOne', { nm: Math.round(RAY_BANDS[band].centreNm) }), layout.bench.x, 15);
    ctx.fillText(picked
      ? t('beam.wave.title', { n: picked.index + 1 })
      : t('beam.wave.titleNone'), layout.wave.x, layout.wave.y - 7);
    ctx.restore();

    drawTestBench(ctx, {
      rect: layout.bench, t, lang, band, contrast,
      highlight: picked ? particle : null,
      inChamber: Object.values(CHAMBER_SAMPLE),
      moleculeRatio: molRatio,
    });
    const other = particle === 'molecule' ? 'haze' : 'molecule';
    const panels = contrast !== null
      ? [{ particle, band, chosen: true }, { particle, band: contrast, chosen: false }]
      : [{ particle, band, chosen: true }, { particle: other, band, chosen: false }];
    drawWaveStrip(ctx, { rect: layout.wave, t, lang, panels });
  }

  /**
   * The particles another colour would have hit: that colour's target as a
   * dashed ring in its colour, and a lettered tag (a, b, c...), as in the panel.
   */
  function drawNearMisses(misses) {
    ctx.save();
    misses.forEach((m, k) => {
      const widest = m.bands.reduce((best, bb) =>
        (chamber.halfWidths[m.kind][bb] > chamber.halfWidths[m.kind][best] ? bb : best), m.bands[0]);
      ctx.strokeStyle = RAY_BANDS[widest].css;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(m.x, m.y, chamber.halfWidths[m.kind][widest], 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
      const tx = m.x - 11, ty = m.y + 13;
      ctx.fillStyle = 'rgba(5,7,13,0.9)';
      ctx.strokeStyle = RAY_BANDS[widest].css;
      ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.rect(tx - 7, ty - 7, 14, 14); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String.fromCharCode(97 + k), tx, ty + 0.5);
    });
    ctx.restore();
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
    tagSpots = [];
    const picked = chosenScatterEvent(ray, state.selectedEvent);
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
      // The collision the wave strip explains is ringed.
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(tx, ty, 8, 0, Math.PI * 2); ctx.fill();
      if (picked?.index === k) {
        ctx.strokeStyle = RAY_BANDS[ray.band].css;
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(tx, ty, 11, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = '#05070d';
      ctx.fillText(String(k + 1), tx, ty + 0.5);
      if (e.action === 'scatter') tagSpots.push({ x: tx, y: ty, index: k });
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
    const above = chamberRect(w, h).y;
    ctx.fillText(t('beam.micro.scaleNote', { elev: Number(state.elevationDeg).toFixed(state.elevationDeg % 1 ? 1 : 0) }), 70, above - 24);

    // A key to the particles.
    const keys = [
      ['rayleigh', t('beam.micro.key.rayleigh')],
      ['ozone', t('beam.micro.key.ozone')],
      ['aerosolScatter', t('beam.micro.key.aerosolScatter')],
      ['aerosolAbsorb', t('beam.micro.key.aerosolAbsorb')],
    ];
    let x = 70;
    const y = above - 9;
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
    getTraceResult: () => ({
      model, bundle, selection, chamber, state: { ...state },
      crowd: crowdResult,
      sight: state.viewType === 'sightline' && model ? sightlineResult() : null,
    }),
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

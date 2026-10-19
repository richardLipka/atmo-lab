/**
 * The single-beam view: one sunbeam through the air, colour by colour.
 *
 * Two pictures of the same physics (physics/beam.js):
 *
 *   'macro'  The beam's whole path from the top of the atmosphere to an
 *            observer on the ground, drawn as eight coloured strands. Each
 *            strand is as thick as the share of its colour still in the beam,
 *            so blue visibly thins out first; the light each strand loses to
 *            scattering leaves it sideways as sparks of its own colour - that
 *            light is the sky. An inset shows the second, much weaker colour
 *            effect: refraction lifts a low Sun, blue a little more than red.
 *
 *   'micro'  A magnified piece of air with molecules, haze grains and ozone
 *            molecules. Each particle's target size for a given colour is set
 *            so the chamber has the same optical depth as the real path, kind
 *            by kind and colour by colour - so the share of each colour that
 *            crosses it untouched is the real one.
 *
 * Nothing here computes physics of its own; it draws what beam.js returns.
 */

import {
  traceBeam, singleColourSpectrum, createChamber, traceChamberBundle, traceChamberRay,
} from '../physics/beam.js';
import { createAtmosphere } from '../physics/atmosphere.js';
import { makeBlackbodySpectrum, RAY_BANDS, BAND_OF_BIN, WAVELENGTHS_NM, SPECTRUM_BINS } from '../physics/spectrum.js';

/** The sun's temperature for the white beam, as in the rest of the simulator. */
const SUN_TEMPERATURE_K = 5800;
/** Horizontal extent of the macro picture: a little more than the horizon chord. */
const MACRO_MAX_KM = 1200;
/** The top of the drawn air: the model's top of atmosphere. */
const MACRO_TOP_KM = 100;

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
  animate: true,
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

export function createBeamCanvas(canvas, { i18n, colorimetry, config }) {
  const ctx = canvas.getContext('2d', { alpha: false });
  let state = { ...DEFAULT_BEAM_STATE };
  let model = null;
  let chamber = null;
  let bundle = null;
  let singleRay = null;
  let singleBandIndex = 0;
  let chamberSize = { w: 0, h: 0 };
  let time = 0;
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
    return { x: 70, y: 46, w: Math.max(120, w - 160), h: Math.max(100, h - 96) };
  }

  function recompute() {
    model = buildBeamModel(state, { config, colorimetry });
    const { w, h } = resize();
    const rect = chamberRect(w, h);
    chamberSize = { w: rect.w, h: rect.h };
    chamber = createChamber({ width: rect.w, height: rect.h, tauByKind: model.trace.tauByKind });
    bundle = traceChamberBundle(chamber, { bands: model.bands, raysPerBand: model.bands.length > 1 ? 24 : 60 });
    fireSingleRay();
  }

  /** The single-ray mode fires one ray at a time, cycling through the colours present. */
  function fireSingleRay() {
    const bands = model.bands;
    const band = bands[singleBandIndex % bands.length];
    let seed = 99 + singleBandIndex * 7919;
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    singleRay = traceChamberRay(chamber, { band, y0: chamber.height / 2, rng });
  }

  function update(next) {
    let changed = !model;
    for (const [k, v] of Object.entries(next ?? {})) {
      if (state[k] !== v) { state[k] = v; changed = true; }
    }
    if (changed) recompute();
    draw();
  }

  canvas.addEventListener('pointerdown', () => {
    if (state.viewType === 'micro' && state.bundleMode === 'single') {
      singleBandIndex++;
      fireSingleRay();
      draw();
    }
  });

  window.addEventListener('resize', () => { if (model) { recompute(); draw(); } });

  function tick(ms) {
    time = ms / 1000;
    if (state.animate && model && !canvas.closest('[hidden]')) draw();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function draw() {
    if (!model) recompute();
    const { w, h } = resize();
    if (Math.abs(chamberRect(w, h).w - chamberSize.w) > 1 || Math.abs(chamberRect(w, h).h - chamberSize.h) > 1) {
      recompute();
    }
    ctx.fillStyle = '#05070d';
    ctx.fillRect(0, 0, w, h);
    if (state.viewType === 'micro') drawMicro(w, h); else drawMacro(w, h);
  }

  /* ---------------------------------------------------------------- */
  /* macro: the whole path                                            */
  /* ---------------------------------------------------------------- */

  function drawMacro(w, h) {
    const plot = { x: 52, y: 14, w: w - 52 - 20, h: h - 14 - 50 };
    const ground = plot.y + plot.h;
    const scaleX = (plot.w - 80) / MACRO_MAX_KM;     // px per km horizontally
    const scaleY = plot.h / MACRO_TOP_KM;            // px per km vertically
    const right = plot.x + plot.w - 70;              // where the observer stands
    const toScreen = (p) => ({ x: right - (p.x / 1000) * scaleX, y: ground - (p.altitude / 1000) * scaleY });

    // The air, by density: an exponential glow fading to black at the top.
    const air = ctx.createLinearGradient(0, ground, 0, plot.y);
    for (let k = 0; k <= 10; k++) {
      const altKm = (k / 10) * MACRO_TOP_KM;
      const rho = Math.exp(-altKm / 8.5);
      air.addColorStop(k / 10, `rgba(70, 120, 200, ${0.05 + 0.4 * rho})`);
    }
    ctx.fillStyle = air;
    ctx.fillRect(plot.x, plot.y, plot.w, plot.h);
    ctx.fillStyle = '#2b2620';
    ctx.fillRect(plot.x, ground, plot.w, 6);

    // Altitude ticks.
    ctx.save();
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const km of [0, 20, 40, 60, 80, 100]) {
      const y = ground - km * scaleY;
      ctx.fillText(`${km} km`, plot.x - 6, y);
      ctx.beginPath(); ctx.moveTo(plot.x, y); ctx.lineTo(plot.x + plot.w, y); ctx.stroke();
    }
    ctx.restore();

    const pts = model.trace.points.map(toScreen);
    const start = pts[0];
    const end = pts[pts.length - 1];
    // Unit vectors along and across the path on screen, for laying out strands.
    const dirX = end.x - start.x, dirY = end.y - start.y;
    const len = Math.hypot(dirX, dirY) || 1;
    const nx = -dirY / len, ny = dirX / len;

    const bands = model.bands;
    const single = bands.length === 1;
    const spacing = single ? 0 : 3.4;
    const maxWidth = single ? 6 : 3;
    const initial = model.trace.points[0].bands;

    // Scattered light leaving each strand: sparks of its own colour, as many
    // as the share of that colour the step loses, drifting off sideways.
    drawSparks(pts, nx, ny, bands, spacing, initial);

    // The strands themselves.
    ctx.save();
    ctx.lineCap = 'round';
    bands.forEach((b, k) => {
      const offset = (k - (bands.length - 1) / 2) * spacing;
      ctx.strokeStyle = RAY_BANDS[b].css;
      for (let i = 1; i < pts.length; i++) {
        const frac = initial[b] > 0 ? model.trace.points[i].bands[b] / initial[b] : 0;
        if (frac < 0.003) break;
        ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, frac * 1.2);
        ctx.lineWidth = Math.max(0.4, maxWidth * frac);
        ctx.beginPath();
        ctx.moveTo(pts[i - 1].x + nx * offset, pts[i - 1].y + ny * offset);
        ctx.lineTo(pts[i].x + nx * offset, pts[i].y + ny * offset);
        ctx.stroke();
      }
    });
    ctx.restore();

    // The Sun where the beam enters, and the observer where it ends.
    ctx.save();
    const sunGlow = ctx.createRadialGradient(start.x, start.y, 2, start.x, start.y, 18);
    sunGlow.addColorStop(0, 'rgba(255,250,235,1)');
    sunGlow.addColorStop(1, 'rgba(255,230,180,0)');
    ctx.fillStyle = sunGlow;
    ctx.beginPath(); ctx.arc(start.x, start.y, 18, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(t('beam.canvas.entry'), Math.min(start.x + 10, right - 60), Math.max(plot.y + 10, start.y - 14));

    const arriving = colorimetry.spectrumToSrgb(model.trace.transmittedSpectrum,
      1 / Math.max(1e-9, colorimetry.luminance(model.source)));
    ctx.fillStyle = arriving.css;
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(end.x, end.y - 6, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'right';
    ctx.fillText(t('beam.canvas.observer'), end.x - 10, end.y - 14);
    ctx.restore();

    // Path length and vertical exaggeration.
    ctx.save();
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.textAlign = 'left';
    ctx.fillText(t('beam.canvas.pathInfo', {
      km: Math.round(model.trace.pathLengthM / 1000),
      airmass: model.trace.airMass.toFixed(1),
      exaggeration: Math.round(scaleY / scaleX),
    }), plot.x, plot.y + plot.h + 22);
    ctx.fillText(`${t('beam.canvas.legendStrands')}  ·  ${t('beam.canvas.legendSparks')}`,
      plot.x, plot.y + plot.h + 38);
    ctx.restore();

    drawRefractionInset(w, plot);
  }

  function drawSparks(pts, nx, ny, bands, spacing, initial) {
    const perBand = 70;   // sparks for a colour that loses all its light
    ctx.save();
    bands.forEach((b, k) => {
      const offset = (k - (bands.length - 1) / 2) * spacing;
      ctx.fillStyle = RAY_BANDS[b].css;
      let carry = 0;
      for (let i = 1; i < pts.length; i++) {
        const shed = initial[b] > 0 ? model.trace.points[i].shed[b] / initial[b] : 0;
        carry += shed * perBand;
        while (carry >= 1) {
          carry -= 1;
          const seed = (i * 131 + b * 977 + Math.floor(carry * 1000)) % 997;
          const side = seed % 2 === 0 ? 1 : -1;
          const phase = (seed * 0.618) % 1;
          const travel = state.animate ? ((time * 0.35 + phase) % 1) : phase;
          const reach = 10 + 38 * travel;
          // Sideways, with a little spread along the path.
          const along = ((seed % 7) - 3) * 0.6;
          const x = pts[i].x + nx * (offset + side * reach) + along;
          const y = pts[i].y + ny * (offset + side * reach);
          ctx.globalAlpha = 0.85 * (1 - travel);
          ctx.beginPath();
          ctx.arc(x, y, 1.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });
    ctx.restore();
  }

  /**
   * Refraction and its dispersion, at a glance: the Sun drawn once per colour,
   * each image lifted by that colour's refraction. The differences between the
   * colours are tiny, so they are magnified by a stated factor; the brightness
   * of each image is the share of that colour still in the beam.
   */
  function drawRefractionInset(w, plot) {
    const refr = model.trace.refraction;
    const bands = model.bands;
    const boxW = 196, boxH = 132;
    // Bottom left: below the beam's path whatever the Sun's height.
    const x0 = plot.x + 6;
    const y0 = plot.y + plot.h - boxH - 6;
    ctx.save();
    ctx.fillStyle = 'rgba(5,7,13,0.82)';
    ctx.fillRect(x0, y0, boxW, boxH);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, boxW - 1, boxH - 1);
    ctx.font = '10.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(t('beam.canvas.refractionTitle'), x0 + 8, y0 + 11);

    const mid = refr[Math.min(4, refr.length - 1)].arcmin;
    const spread = refr[0].arcmin - refr[refr.length - 1].arcmin;   // violet minus red
    const cx = x0 + boxW / 2 - 30;
    const cy = y0 + 72;
    const radius = 22;
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
    const tx = cx + radius + 10;
    ctx.fillText(t('beam.canvas.refractionLift', { arcmin: mid.toFixed(1) }), tx, cy - 20);
    ctx.fillText(t('beam.canvas.refractionSpread', { arcsec: (spread * 60).toFixed(1) }), tx, cy - 4);
    ctx.fillText(t('beam.canvas.refractionMagnified', { m: Math.round(magnification) }), tx, cy + 12);
    ctx.restore();
  }

  /* ---------------------------------------------------------------- */
  /* micro: the collision chamber                                     */
  /* ---------------------------------------------------------------- */

  function drawMicro(w, h) {
    const rect = chamberRect(w, h);
    ctx.save();
    ctx.translate(rect.x, rect.y);

    ctx.fillStyle = '#080b14';
    ctx.fillRect(0, 0, rect.w, rect.h);
    ctx.strokeStyle = 'rgba(120,150,200,0.35)';
    ctx.strokeRect(0.5, 0.5, rect.w - 1, rect.h - 1);

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

    const single = state.bundleMode === 'single';
    if (single) drawTargets(singleRay.band);
    drawParticles();
    if (single) drawRay(singleRay, true); else bundle.rays.forEach((ray) => drawRay(ray, false));
    ctx.restore();

    drawMicroCaption(w, h, single);
  }

  /** In single-ray mode: each particle's target for the colour being fired. */
  function drawTargets(band) {
    ctx.save();
    for (const p of chamber.particles) {
      const b = chamber.halfWidths[p.kind][band];
      if (!(b > 0.4)) continue;
      ctx.strokeStyle = p.kind === 'rayleigh' ? 'rgba(130,185,255,0.7)'
        : p.kind === 'ozone' ? 'rgba(255,170,90,0.7)' : 'rgba(230,200,140,0.7)';
      ctx.lineWidth = 1.1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(p.x, p.y, b, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  function drawParticles() {
    ctx.save();
    for (const p of chamber.particles) {
      const wob = state.animate ? Math.sin(time * 2 + p.phase) * 0.8 : 0;
      const x = p.x + wob, y = p.y - wob;
      if (p.kind === 'rayleigh') {
        const a = p.phase + (state.animate ? time * 0.8 : 0);
        ctx.fillStyle = '#6aa9ff';
        for (const s of [1, -1]) {
          ctx.beginPath(); ctx.arc(x + s * 2.6 * Math.cos(a), y + s * 2.6 * Math.sin(a), 2.2, 0, Math.PI * 2); ctx.fill();
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
    ctx.restore();
  }

  function drawRay(ray, emphasised) {
    ctx.save();
    ctx.strokeStyle = RAY_BANDS[ray.band].css;
    ctx.lineWidth = emphasised ? 2.4 : (ray.fate === 'direct' ? 1.5 : 1);
    ctx.globalAlpha = emphasised ? 0.95 : (ray.fate === 'direct' ? 0.85 : 0.45);
    ctx.beginPath();
    ray.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.stroke();
    ctx.globalAlpha = 1;
    for (const e of ray.events) {
      if (e.action === 'absorb') {
        ctx.strokeStyle = '#ff6b6b';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(e.x - 3, e.y - 3); ctx.lineTo(e.x + 3, e.y + 3);
        ctx.moveTo(e.x + 3, e.y - 3); ctx.lineTo(e.x - 3, e.y + 3);
        ctx.stroke();
      } else if (emphasised) {
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(e.x, e.y, 3, 0, Math.PI * 2); ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawMicroCaption(w, h, single) {
    ctx.save();
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.textAlign = 'left';
    const text = single
      ? t('beam.micro.singleCaption', { nm: RAY_BANDS[singleRay.band].centreNm.toFixed(0), fate: t(`beam.micro.fate.${singleRay.fate}`) })
      : t('beam.micro.bundleCaption');
    ctx.fillText(text, 70, h - 22);
    ctx.fillText(t('beam.micro.scaleNote'), 70, 30);
    ctx.restore();
  }

  return {
    update,
    draw,
    getTraceResult: () => ({ model, bundle, singleRay, state: { ...state } }),
  };
}

/** Wavelength in nanometres of the bin a source holds, for labels. */
export function wavelengthOfBin(i) { return WAVELENGTHS_NM[i]; }

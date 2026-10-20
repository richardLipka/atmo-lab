/**
 * One direction of the sky: the observer's line of sight through the air,
 * sunlight falling on it, and how much each part of it sends to the eye.
 *
 *   Left:  the line of sight (light paths). Sun rays arrive along it in the
 *          colour they still have there; the beads on the line are as large as
 *          the light that part sends you and in its colour. With a hill, the
 *          line ends on its face.
 *   Right: the colour of the sky in that direction (hue, and how bright it is
 *          against the zenith), where along the line the light comes from,
 *          and the spectrum that arrives.
 *
 * The geometry is drawn with heights stretched by a stated factor; the whole
 * picture is stretched evenly, so the lines stay straight.
 */

import { RAY_BANDS } from '../physics/spectrum.js';
import { drawKindTag } from './particle-strips.js';

function sightNumber(v, digits, lang) {
  const text = v.toFixed(digits);
  return lang === 'cs' ? text.replace('.', ',') : text;
}

/**
 * @param {object} o w, h, t, lang, colorimetry, result (traceSightline), zenith (traceSightline
 *   for the zenith, for comparison), elevationDeg, viewDeg, hillKm
 * @returns {{ observer:{x:number,y:number}, scale:{sx:number, sy:number} }} for aiming with the pointer
 */
export function drawSightlineView(ctx, o) {
  const { w, h, t, lang, colorimetry, result, zenith, elevationDeg, viewDeg } = o;
  const samples = result.samples;
  const R = samples.length ? Math.hypot(samples[0].x, samples[0].y) - samples[0].altitude : 6.371e6;
  const hueOf = (spectrum) => {
    const lum = colorimetry.luminance(spectrum);
    return lum > 1e-30 ? colorimetry.spectrumToSrgb(spectrum, 0.45 / lum).css : '#000';
  };

  ctx.save();
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const where = Math.abs(viewDeg) < 1 ? t('beam.sight.zenith')
    : t(viewDeg < 0 ? 'beam.sight.towardsSun' : 'beam.sight.awayFromSun', { deg: Math.round(90 - Math.abs(viewDeg)) });
  ctx.fillText(t('beam.sight.header', { where, sun: sightNumber(elevationDeg, 0, lang) }), 14, 20);
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fillText(t('beam.sight.subheader', { angle: Math.round(result.scatteringAngleDeg) }), 14, 36);

  // Where most of the light comes from: the picture shows the line up to 98 %.
  const total = samples.reduce((s, p) => s + p.total, 0) || 1;
  let acc = 0, cut = samples.length - 1, half = 0;
  for (let k = 0; k < samples.length; k++) {
    acc += samples[k].total;
    if (!half && acc >= 0.5 * total) half = samples[k].t;
    if (acc >= 0.98 * total) { cut = k; break; }
  }
  const shown = samples.slice(0, cut + 1);
  const reachT = result.endsOn === 'hill' ? result.length : shown[shown.length - 1].t;

  // Left: the picture.
  const pic = { x: 14, y: 46, w: Math.round((w - 28) * 0.6), h: h - 46 - 30 };
  ctx.fillStyle = '#070a12';
  ctx.fillRect(pic.x, pic.y, pic.w, pic.h);
  const xs = [0, ...shown.map((p) => p.x)], ys = [R, ...shown.map((p) => p.y)];
  const spanY = Math.max(Math.max(...ys) - R, 1000);
  // Room on the left, where the sunlight comes from.
  let minX = Math.min(...xs) - 0.45 * spanY;
  const maxX = Math.max(...xs) + 0.1 * spanY;
  const spanX = Math.max(maxX - minX, 2000);
  const margin = 26;
  const sxFit = (pic.w - 2 * margin) / spanX;
  const syFit = (pic.h - 2 * margin - 14) / spanY;
  // Tall lines are drawn to scale; long, low ones with heights stretched evenly.
  const sx = Math.min(sxFit, syFit);
  const sy = syFit < sxFit ? syFit : Math.min(syFit, sxFit * 60);
  const stretch = sy / sx;
  if (syFit < sxFit) minX -= ((pic.w - 2 * margin) / sx - spanX) / 2;   // centre the narrow picture
  const ox = pic.x + margin + (0 - minX) * sx;
  const oy = pic.y + pic.h - margin;
  const X = (x) => ox + x * sx, Y = (y) => oy - (y - R) * sy;

  ctx.save();
  ctx.beginPath(); ctx.rect(pic.x, pic.y, pic.w, pic.h); ctx.clip();
  // Air, denser lower down, and the ground.
  const air = ctx.createLinearGradient(0, oy, 0, pic.y);
  for (let k = 0; k <= 8; k++) {
    const hKm = (k / 8) * (spanY / 1000) * (pic.h / (pic.h - 2 * margin));
    air.addColorStop(k / 8, `rgba(70,120,200,${0.04 + 0.36 * Math.exp(-hKm / 8.5)})`);
  }
  ctx.fillStyle = air;
  ctx.fillRect(pic.x, pic.y, pic.w, oy - pic.y);
  ctx.fillStyle = '#2b2620';
  ctx.fillRect(pic.x, oy, pic.w, pic.y + pic.h - oy);

  // Sunlight arriving at points along the line, in the colour it has there.
  const e = elevationDeg * Math.PI / 180;
  const ux = Math.cos(e) * sx, uy = -Math.sin(e) * sy;
  const ul = Math.hypot(ux, uy) || 1;
  const step = Math.max(1, Math.floor(shown.length / 10));
  for (let k = 0; k < shown.length; k += step) {
    const p = shown[k];
    const px = X(p.x), py = Y(p.y);
    ctx.strokeStyle = hueOf(p.sunSpectrum);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    // Towards the Sun is up and to the left.
    ctx.beginPath(); ctx.moveTo(px - (ux / ul) * 2000, py + (uy / ul) * 2000); ctx.lineTo(px, py); ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // The line of sight, and the beads: what each part sends you.
  const end = { x: X(shown[shown.length - 1].x), y: Y(shown[shown.length - 1].y) };
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(X(0), Y(R)); ctx.lineTo(end.x, end.y); ctx.stroke();
  ctx.setLineDash([]);
  const peak = Math.max(...shown.map((p) => p.total)) || 1;
  const beadStep = Math.max(1, Math.floor(shown.length / 36));
  for (let k = 0; k < shown.length; k += beadStep) {
    const p = shown[k];
    const r = 1.5 + 7 * Math.sqrt(p.total / peak);
    ctx.fillStyle = hueOf(p.spectrum);
    ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), r, 0, Math.PI * 2); ctx.fill();
  }
  // A hill at the end of the line.
  if (result.endsOn === 'hill') {
    const hx = X(shown[shown.length - 1].x), hy = Y(R);
    // In the colour you see it: its own light plus the light of the air in front.
    ctx.fillStyle = hueOf(result.spectrum);
    ctx.beginPath();
    ctx.moveTo(hx - 30, hy); ctx.lineTo(hx + 4, hy - 34); ctx.lineTo(hx + 40, hy); ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  // The observer.
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(X(0), Y(R) - 4, 4, 0, Math.PI * 2); ctx.fill();
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillText(t('beam.sight.you'), X(0), Y(R) + 4);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(stretch < 1.15 ? t('beam.sight.scaleTrue') : t('beam.sight.scaleStretched', { m: Math.round(stretch) }), pic.x + 6, pic.y + 6);
  drawKindTag(ctx, pic, 'rays', t);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fillText(t('beam.sight.legend'), 14, h - 10);

  // Right: the colour, where it comes from, and the spectrum.
  const right = { x: pic.x + pic.w + 12, w: w - (pic.x + pic.w + 12) - 14 };
  let y = 46;
  const lum = colorimetry.luminance(result.spectrum);
  const zenithLum = colorimetry.luminance(zenith.spectrum) || 1;
  ctx.font = 'bold 10.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(t(result.endsOn === 'hill' ? 'beam.sight.colourHill' : 'beam.sight.colourTitle'), right.x, y + 10);
  ctx.fillStyle = hueOf(result.spectrum);
  ctx.fillRect(right.x, y + 18, 56, 40);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  ctx.strokeRect(right.x + 0.5, y + 18.5, 55, 39);
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillText(t('beam.sight.brightness', { ratio: sightNumber(lum / zenithLum, lum / zenithLum < 10 ? 1 : 0, lang) }), right.x + 64, y + 32);
  ctx.fillText(t('beam.sight.polarization', { p: Math.round(result.polarization * 100) }), right.x + 64, y + 48);
  y += 72;

  // Where along the line the light comes from: the share from the first so many km.
  const chart = { x: right.x, y, w: right.w, h: Math.max(90, (h - y - 40) * 0.55) };
  ctx.fillStyle = 'rgba(8,11,20,0.95)';
  ctx.fillRect(chart.x, chart.y, chart.w, chart.h);
  ctx.strokeStyle = 'rgba(143,227,196,0.35)';
  ctx.strokeRect(chart.x + 0.5, chart.y + 0.5, chart.w - 1, chart.h - 1);
  drawKindTag(ctx, chart, 'graph', t);
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.fillText(t('beam.sight.chartTitle'), chart.x + 6, chart.y + 14);
  const area = { x: chart.x + 30, y: chart.y + 24, w: chart.w - 40, h: chart.h - 44 };
  const maxT = reachT || 1;
  let run = 0;
  ctx.lineWidth = 2;
  for (let k = 0; k < shown.length; k++) {
    const before = run / total;
    run += shown[k].total;
    const x0 = area.x + ((k ? shown[k - 1].t : 0) / maxT) * area.w;
    const x1 = area.x + (shown[k].t / maxT) * area.w;
    ctx.strokeStyle = hueOf(shown[k].spectrum);
    ctx.beginPath();
    ctx.moveTo(x0, area.y + (1 - before) * area.h);
    ctx.lineTo(x1, area.y + (1 - run / total) * area.h);
    ctx.stroke();
  }
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.textAlign = 'right';
  ctx.fillText('100 %', area.x - 3, area.y + 4);
  ctx.fillText('0', area.x - 3, area.y + area.h);
  ctx.textAlign = 'left';
  ctx.fillText(t('beam.sight.chartAxis', { km: sightNumber(maxT / 1000, maxT < 10e3 ? 1 : 0, lang) }), area.x, area.y + area.h + 12);
  if (half) {
    const hx = area.x + (half / maxT) * area.w;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(hx, area.y); ctx.lineTo(hx, area.y + area.h); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText(t('beam.sight.half', { km: sightNumber(half / 1000, half < 10e3 ? 1 : 0, lang) }), Math.min(hx + 3, area.x + area.w - 70), area.y + area.h * 0.6);
  }

  // The spectrum that arrives, band by band, against the sunlight's own.
  const spec = { x: right.x, y: chart.y + chart.h + 8, w: right.w, h: h - (chart.y + chart.h + 8) - 30 };
  if (spec.h > 50) {
    ctx.fillStyle = 'rgba(8,11,20,0.95)';
    ctx.fillRect(spec.x, spec.y, spec.w, spec.h);
    ctx.strokeStyle = 'rgba(143,227,196,0.35)';
    ctx.strokeRect(spec.x + 0.5, spec.y + 0.5, spec.w - 1, spec.h - 1);
    drawKindTag(ctx, spec, 'graph', t);
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillText(t('beam.sight.spectrumTitle'), spec.x + 6, spec.y + 14);
    const bands = RAY_BANDS.map(() => 0);
    // Per nanometre: the bands are not equally wide.
    samples.forEach((p) => p.bands.forEach((v, b) => { bands[b] += v / (RAY_BANDS[b].toNm - RAY_BANDS[b].fromNm + 1); }));
    const maxB = Math.max(...bands) || 1;
    const slot = (spec.w - 16) / bands.length;
    const base = spec.y + spec.h - 16, height = spec.h - 38;
    bands.forEach((v, b) => {
      const bh = Math.max(1, height * v / maxB);
      ctx.fillStyle = RAY_BANDS[b].css;
      ctx.fillRect(spec.x + 8 + b * slot + slot * 0.15, base - bh, slot * 0.7, bh);
      ctx.font = '8.5px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.textAlign = 'center';
      ctx.fillText(String(Math.round(RAY_BANDS[b].centreNm)), spec.x + 8 + b * slot + slot / 2, base + 11);
      ctx.textAlign = 'left';
    });
  }
  ctx.restore();
  return { observer: { x: X(0), y: Y(R) }, picture: pic, sx, sy };
}

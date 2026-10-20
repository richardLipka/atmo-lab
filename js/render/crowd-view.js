/**
 * Many molecules together: the same number of molecules, evenly spaced on the
 * left (like glass or water) and at random on the right (like air), lit by
 * the same wave. Dials add up the molecules' waves sideways and backwards:
 * evenly spaced they cancel, at random they add up to about N times one
 * molecule's light. Forwards they are always in step - that is the light
 * going on through.
 *
 * The drawing is a scheme, not to scale: real molecules sit far closer than
 * a quarter of a wavelength (in glass some 1500 to a wavelength), which only
 * makes the cancelling more complete.
 */

import { RAY_BANDS } from '../physics/spectrum.js';
import { crowdPositions, crowdSum } from '../physics/crowd.js';
import { drawKindTag } from './particle-strips.js';

/** Random arrangements averaged for the "on average" figure. */
const AVERAGE_OVER = 24;

function crowdNumber(v, lang) {
  const text = v >= 100 ? String(Math.round(v)) : v >= 10 ? v.toFixed(0) : v >= 0.01 ? v.toFixed(1) : '0';
  return lang === 'cs' ? text.replace('.', ',') : text;
}

/** The average sideways light of many random arrangements, cached by size. */
const averageCache = new Map();
export function averageSideways(size) {
  if (!averageCache.has(size)) {
    let sum = 0;
    for (let s = 1; s <= AVERAGE_OVER; s++) sum += crowdSum(crowdPositions('random', size, 1000 + s), 90).intensity;
    averageCache.set(size, sum / AVERAGE_OVER);
  }
  return averageCache.get(size);
}

/**
 * @param {object} o w, h, t, lang, band, size (square side in wavelengths), seed
 */
export function drawCrowdView(ctx, o) {
  const { w, h, t, lang, band, size, seed } = o;
  const even = crowdPositions('even', size);
  const random = crowdPositions('random', size, seed);
  const n = even.length;
  const colour = RAY_BANDS[band].css;

  ctx.save();
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(t('beam.crowd.header', { n, size }), 14, 20);
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fillText(t('beam.crowd.subheader'), 14, 36);

  const top = 46, gap = 12, bottomH = 96;
  const panelW = (w - 28 - gap) / 2;
  const panelH = h - top - bottomH - gap - 10;
  const results = [];
  [['even', even], ['random', random]].forEach(([kind, points], k) => {
    const box = { x: 14 + k * (panelW + gap), y: top, w: panelW, h: panelH };
    results.push(drawArrangement(ctx, box, kind, points, size, colour, t, lang));
  });

  // Bottom: the sideways light, side by side, in units of one molecule's.
  const chart = { x: 14, y: top + panelH + gap, w: w - 28, h: bottomH };
  ctx.fillStyle = 'rgba(8,11,20,0.95)';
  ctx.fillRect(chart.x, chart.y, chart.w, chart.h);
  ctx.strokeStyle = 'rgba(143,227,196,0.35)';
  ctx.strokeRect(chart.x + 0.5, chart.y + 0.5, chart.w - 1, chart.h - 1);
  drawKindTag(ctx, chart, 'graph', t);
  ctx.font = 'bold 10.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(t('beam.crowd.chartTitle'), chart.x + 8, chart.y + 16);
  const average = averageSideways(size);
  const rows = [
    [t('beam.crowd.rowEven'), results[0].side],
    [t('beam.crowd.rowRandom'), results[1].side],
    [t('beam.crowd.rowAverage', { m: AVERAGE_OVER }), average],
  ];
  const labelW = 230;
  const barMax = Math.max(n, ...rows.map(([, v]) => v)) * 1.05;
  const barX = chart.x + 8 + labelW, barW = chart.w - labelW - 90;
  rows.forEach(([label, value], i) => {
    const y = chart.y + 30 + i * 20;
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, chart.x + 8, y + 6);
    ctx.fillStyle = colour;
    ctx.fillRect(barX, y, Math.max(1, (value / barMax) * barW), 12);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText(`${crowdNumber(value, lang)} ×`, barX + Math.max(1, (value / barMax) * barW) + 6, y + 6);
  });
  // The reference: N molecules' worth.
  const nx = barX + (n / barMax) * barW;
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(nx, chart.y + 26); ctx.lineTo(nx, chart.y + chart.h - 8); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`N = ${n}`, nx, chart.y + chart.h - 2);
  ctx.restore();
  return { n, even: results[0], random: results[1], average };
}

function drawArrangement(ctx, box, kind, points, size, colour, t, lang) {
  ctx.fillStyle = 'rgba(8,11,20,0.95)';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeStyle = 'rgba(120,150,200,0.3)';
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
  ctx.font = 'bold 10.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(t(`beam.crowd.title.${kind}`), box.x + 8, box.y + 15);

  // The scheme: molecules in a square, wave crests one wavelength apart.
  const side = Math.min(box.w * 0.48, box.h - 50);
  const pic = { x: box.x + 10, y: box.y + 24, w: side, h: side };
  const px = side / size;   // pixels per wavelength
  ctx.save();
  ctx.beginPath(); ctx.rect(pic.x, pic.y, pic.w, pic.h); ctx.clip();
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(pic.x, pic.y, pic.w, pic.h);
  ctx.strokeStyle = colour;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1.2;
  for (let c = 0; c <= size; c++) {
    ctx.beginPath(); ctx.moveTo(pic.x + c * px, pic.y); ctx.lineTo(pic.x + c * px, pic.y + pic.h); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#6aa9ff';
  const dot = Math.max(1.2, Math.min(3, px / 9));
  for (const [x, y] of points) {
    ctx.beginPath(); ctx.arc(pic.x + x * px, pic.y + y * px, dot, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
  ctx.strokeStyle = 'rgba(200,200,200,0.35)';
  ctx.strokeRect(pic.x + 0.5, pic.y + 0.5, pic.w - 1, pic.h - 1);
  drawKindTag(ctx, pic, 'scheme', t, 'bottom-left');
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.fillText(t('beam.crowd.crests'), pic.x, pic.y + pic.h + 13);

  // Dials: sideways and backwards; the sum's scale is the same in both
  // panels, so the random walk and the closed loop can be compared.
  const dials = { x: pic.x + pic.w + 14, y: pic.y, w: box.x + box.w - (pic.x + pic.w + 14) - 8, h: pic.h };
  const n = points.length;
  const out = {};
  [['side', 90], ['back', 180]].forEach(([key, theta], i) => {
    const sum = crowdSum(points, theta);
    out[key] = sum.intensity;
    const r = Math.min(dials.w / 2 - 8, (dials.h - 40) / 4);
    const cx = dials.x + dials.w / 2, cy = dials.y + 18 + r + i * (2 * r + 34);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    const scale = (0.45 * r) / Math.sqrt(n);
    const last = sum.chain[sum.chain.length - 1];
    const sx = cx - last.x * scale * 0.5, sy = cy + last.y * scale * 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    sum.chain.forEach((p, j) => (j ? ctx.lineTo(sx + p.x * scale, sy - p.y * scale) : ctx.moveTo(sx, sy)));
    ctx.stroke();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2.2;
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + last.x * scale, sy - last.y * scale); ctx.stroke();
    ctx.font = '9.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(t(`beam.crowd.dir.${key}`), cx, cy - r - 2);
    ctx.textBaseline = 'top';
    ctx.fillStyle = colour;
    ctx.fillText(`${crowdNumber(sum.intensity, lang)} ×`, cx, cy + r + 3);
    ctx.textAlign = 'left';
  });
  drawKindTag(ctx, { x: dials.x, y: dials.y, w: dials.w, h: dials.h + 22 }, 'sum', t, 'bottom-right');
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(t('beam.crowd.forward', { n }), box.x + 8, box.y + box.h - 8);
  return out;
}

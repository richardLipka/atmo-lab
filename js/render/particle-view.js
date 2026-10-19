/**
 * The single-particle view: one particle of any size, from an air molecule
 * to a 20 micrometre cloud droplet, lit from the left.
 *
 *   Left:  where its scattered light goes, for the chosen colour (filled) and
 *          a contrasting one (dashed), with a fan of rays of the chosen colour
 *          spread exactly as the pattern says - each ray carries the same
 *          share of the scattered light, so where rays crowd, much light goes.
 *   Right: for every colour band, how large the particle's target is (how
 *          often light is scattered at all) and how far the light typically
 *          turns. A molecule: steep in the first, flat in the second. A haze
 *          droplet: mild in both. A cloud droplet: flat in the first, all
 *          turns tiny.
 *
 * The patterns come from physics/mie.js.
 */

import { RAY_BANDS } from '../physics/spectrum.js';
import { dropletPattern, sizeRegime } from '../physics/mie.js';

/** Rays in the fan. */
const FAN_RAYS = 60;
/** Decades shown on the logarithmic radial scale. */
const LOG_DECADES = 4;

function viewNumber(v, digits, lang) {
  const text = v.toFixed(digits);
  return lang === 'cs' ? text.replace('.', ',') : text;
}

/** A diameter in words: nanometres below a tenth of a micrometre, micrometres above. */
export function diameterText(d, lang) {
  if (d < 0.1) {
    const nm = d * 1000;
    return `${viewNumber(nm, nm < 10 ? 1 : 0, lang)} nm`;
  }
  return `${viewNumber(d, d < 1 ? 2 : d < 10 ? 1 : 0, lang)} µm`;
}

/** The colour shown beside the chosen one: red, or blue for red itself. */
export function particleContrast(band) {
  return band === RAY_BANDS.length - 1 ? 1 : RAY_BANDS.length - 1;
}

function radiusOf(value, log) {
  if (!log) return value;
  if (!(value > 0)) return 0;
  return Math.max(0, (Math.log10(value) + LOG_DECADES) / LOG_DECADES);
}

function lobe(ctx, pattern, cx, cy, R, log) {
  const n = pattern.thetaDeg.length;
  ctx.beginPath();
  for (let j = 0; j < n; j++) {
    const th = pattern.thetaDeg[j] * Math.PI / 180;
    const r = R * radiusOf(pattern.pattern[j], log);
    const x = cx + r * Math.cos(th), y = cy - r * Math.sin(th);
    if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  for (let j = n - 1; j >= 0; j--) {
    const th = pattern.thetaDeg[j] * Math.PI / 180;
    const r = R * radiusOf(pattern.pattern[j], log);
    ctx.lineTo(cx + r * Math.cos(th), cy + r * Math.sin(th));
  }
  ctx.closePath();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o w, h, t, lang, diameterUm, band, log
 */
export function drawParticleView(ctx, o) {
  const { w, h, t, lang, diameterUm, band, log } = o;
  const contrast = particleContrast(band);
  const chosen = dropletPattern(diameterUm, RAY_BANDS[band].centreNm);
  const other = dropletPattern(diameterUm, RAY_BANDS[contrast].centreNm);
  const regime = sizeRegime(chosen.sizeParameter);

  // Header: the particle against the two wavelengths.
  ctx.save();
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(t('beam.particle.header', {
    d: diameterText(diameterUm, lang), regime: t(`beam.particle.regime.${regime}`),
  }), 16, 22);
  ctx.font = '10.5px system-ui, sans-serif';
  let x = 16;
  const piece = (text, colour) => { ctx.fillStyle = colour; ctx.fillText(text, x, 40); x += ctx.measureText(text).width; };
  for (const [b, p, sep] of [[band, chosen, ' · '], [contrast, other, '']]) {
    piece(t('beam.particle.sizeAgainst', {
      nm: Math.round(RAY_BANDS[b].centreNm), ratio: viewNumber(diameterUm / (RAY_BANDS[b].centreNm / 1000), diameterUm * 1000 / RAY_BANDS[b].centreNm < 0.1 ? 4 : 2, lang),
      x: viewNumber(p.sizeParameter, p.sizeParameter < 0.1 ? 4 : 2, lang),
    }), RAY_BANDS[b].css);
    piece(sep, 'rgba(255,255,255,0.6)');
  }

  // The polar picture.
  const area = { x: 12, y: 52, w: Math.max(200, w * 0.58), h: h - 52 - 44 };
  const cx = area.x + area.w / 2, cy = area.y + area.h / 2;
  const R = Math.max(40, Math.min(area.w / 2, area.h / 2) - 22);
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.lineWidth = 1;
  for (const f of (log ? [0.25, 0.5, 0.75, 1] : [0.5, 1])) {
    ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const a = deg * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + R * Math.cos(a), cy - R * Math.sin(a)); ctx.stroke();
    const label = deg > 180 ? 360 - deg : deg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // The back direction's label sits below the axis, clear of the arriving light.
    ctx.fillText(`${label}°`, cx + (R + 12) * Math.cos(a), cy - (R + 12) * Math.sin(a) + (deg === 180 ? 34 : 0));
  }
  if (log) {
    ctx.textAlign = 'left';
    for (let k = 0; k < LOG_DECADES; k++) {
      ctx.fillText(k ? `10⁻${'¹²³⁴'[k - 1]}` : '1', cx + 3, cy - R * (1 - k / LOG_DECADES) + 6);
    }
  }

  // Light arriving from the left.
  ctx.strokeStyle = RAY_BANDS[band].css;
  ctx.fillStyle = RAY_BANDS[band].css;
  ctx.lineWidth = 1.5;
  for (const dy of [-24, -12, 0, 12, 24]) {
    const y = cy + dy;
    const x1 = cx - R * 0.42;
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(area.x + 2, y); ctx.lineTo(x1, y); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x1, y); ctx.lineTo(x1 - 6, y - 3); ctx.lineTo(x1 - 6, y + 3); ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // The fan: each ray carries the same share of the scattered light.
  const [r, g, bl] = RAY_BANDS[band].rgb;
  ctx.strokeStyle = `rgba(${r},${g},${bl},0.55)`;
  ctx.lineWidth = 1;
  for (let k = 0; k < FAN_RAYS; k++) {
    const q = (Math.floor(k / 2) + 0.5) / (FAN_RAYS / 2);
    const th = chosen.turnAt(q) * Math.PI / 180 * (k % 2 ? -1 : 1);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R * 1.02 * Math.cos(th), cy - R * 1.02 * Math.sin(th));
    ctx.stroke();
  }

  // The patterns.
  lobe(ctx, chosen, cx, cy, R, log);
  ctx.fillStyle = `rgba(${r},${g},${bl},0.3)`;
  ctx.fill();
  ctx.strokeStyle = RAY_BANDS[band].css;
  ctx.lineWidth = 2;
  ctx.stroke();
  lobe(ctx, other, cx, cy, R, log);
  ctx.setLineDash([5, 3]);
  ctx.strokeStyle = RAY_BANDS[contrast].css;
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(cx, cy, 4, 0, Math.PI * 2); ctx.fill();

  // Legend under the picture.
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(t('beam.particle.legend', {
    nm: Math.round(RAY_BANDS[band].centreNm), nmC: Math.round(RAY_BANDS[contrast].centreNm), n: FAN_RAYS,
  }), 16, h - 26);
  ctx.fillText(t(log ? 'beam.particle.scaleLog' : 'beam.particle.scaleLinear'), 16, h - 10);

  // Right: by colour band, the target and the typical turn.
  const right = { x: area.x + area.w + 18, w: w - (area.x + area.w + 18) - 14 };
  const half = (h - 52 - 20) / 2;
  const patterns = RAY_BANDS.map((b) => dropletPattern(diameterUm, b.centreNm));
  const maxC = Math.max(...patterns.map((p) => p.crossSection));
  const ratio = patterns[band].crossSection / patterns[contrast].crossSection;
  bars(ctx, { x: right.x, y: 52, w: right.w, h: half - 8 },
    t('beam.particle.targetTitle'),
    t('beam.particle.targetNote', {
      nm: Math.round(RAY_BANDS[band].centreNm), nmC: Math.round(RAY_BANDS[contrast].centreNm), ratio: viewNumber(ratio, ratio < 10 ? 2 : 1, lang),
    }),
    patterns.map((p) => p.crossSection / maxC), () => '', band);
  const maxTurn = Math.max(90, ...patterns.map((p) => p.medianTurnDeg));
  bars(ctx, { x: right.x, y: 52 + half + 10, w: right.w, h: half - 8 },
    t('beam.particle.turnTitle'),
    t('beam.particle.turnNote'),
    patterns.map((p) => p.medianTurnDeg / maxTurn),
    (k) => {
      const v = patterns[k].medianTurnDeg;
      return `${viewNumber(v, v < 10 ? 1 : 0, lang)}°`;
    }, band);
  ctx.restore();
}

function bars(ctx, box, title, note, values, label, band) {
  ctx.fillStyle = 'rgba(8,11,20,0.95)';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeStyle = 'rgba(120,150,200,0.3)';
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
  ctx.font = 'bold 10.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(title, box.x + 8, box.y + 6);
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(note, box.x + 8, box.y + 21);
  const plot = { x: box.x + 10, y: box.y + 48, w: box.w - 20, h: box.h - 48 - 18 };
  const n = values.length;
  const slot = plot.w / n;
  values.forEach((v, k) => {
    const bh = Math.max(1, plot.h * Math.min(1, v));
    const bx = plot.x + k * slot + slot * 0.15;
    ctx.fillStyle = RAY_BANDS[k].css;
    ctx.globalAlpha = k === band ? 1 : 0.75;
    ctx.fillRect(bx, plot.y + plot.h - bh, slot * 0.7, bh);
    ctx.globalAlpha = 1;
    if (k === band) {
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(bx - 0.5, plot.y + plot.h - bh - 0.5, slot * 0.7 + 1, bh + 1);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const text = label(k);
    if (text) ctx.fillText(text, bx + slot * 0.35, plot.y + plot.h - bh - 2);
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(String(Math.round(RAY_BANDS[k].centreNm)), bx + slot * 0.35, plot.y + plot.h + 3);
  });
}

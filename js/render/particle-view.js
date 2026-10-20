/**
 * The single-particle view: one particle of any size, from an air molecule
 * to a 20 micrometre cloud droplet, lit from the left. Three kinds of picture,
 * each tagged with what it is: the particle to scale against the wave, the
 * paths the light takes, and graphs of how much light goes where.
 *
 * The patterns come from physics/mie.js.
 */

import { RAY_BANDS } from '../physics/spectrum.js';
import { dropletPattern, sizeRegime, moleculeCrossSection, MOLECULE_LIMIT_UM } from '../physics/mie.js';
import { drawKindTag, drawToScale } from './particle-strips.js';

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

function lobe(ctx, pattern, cx, cy, R, log, key = 'pattern') {
  const n = pattern.thetaDeg.length;
  ctx.beginPath();
  for (let j = 0; j < n; j++) {
    const th = pattern.thetaDeg[j] * Math.PI / 180;
    const r = R * radiusOf(pattern[key][j], log);
    const x = cx + r * Math.cos(th), y = cy - r * Math.sin(th);
    if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  for (let j = n - 1; j >= 0; j--) {
    const th = pattern.thetaDeg[j] * Math.PI / 180;
    const r = R * radiusOf(pattern[key][j], log);
    ctx.lineTo(cx + r * Math.cos(th), cy + r * Math.sin(th));
  }
  ctx.closePath();
}

/**
 * Three kinds of picture, kept apart and labelled the same way as in the
 * collision view:
 *   1. TO SCALE - the particle beside the light's wave crests;
 *   2. LIGHT PATHS - rays arriving from the left and the scattered rays
 *      leaving, each carrying the same share of the scattered light;
 *   3. BRIGHTNESS GRAPH - how much light goes in each direction, with the
 *      strongest direction on the outer ring. Its outline is not the shape of
 *      the particle, and its size says nothing about how much is scattered.
 * Below: two graphs by colour band - the target, and the typical turn.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} o w, h, t, lang, diameterUm, band, log
 */
export function drawParticleView(ctx, o) {
  const { w, h, t, lang, diameterUm, band, log } = o;
  const exponent = o.exponent ?? 4;
  const polar = !!o.polar;
  const molecule = diameterUm < MOLECULE_LIMIT_UM;
  const contrast = particleContrast(band);
  const chosen = dropletPattern(diameterUm, RAY_BANDS[band].centreNm);
  const other = dropletPattern(diameterUm, RAY_BANDS[contrast].centreNm);
  const regime = sizeRegime(chosen.sizeParameter);
  const [r, g, bl] = RAY_BANDS[band].rgb;

  // Header: the particle against the two wavelengths.
  ctx.save();
  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(t('beam.particle.header', {
    d: diameterText(diameterUm, lang), regime: t(`beam.particle.regime.${regime}`),
  }), 14, 20);
  ctx.font = '10.5px system-ui, sans-serif';
  let x = 14;
  const piece = (text, colour) => { ctx.fillStyle = colour; ctx.fillText(text, x, 36); x += ctx.measureText(text).width; };
  for (const [b, p, sep] of [[band, chosen, ' · '], [contrast, other, '']]) {
    piece(t('beam.particle.sizeAgainst', {
      nm: Math.round(RAY_BANDS[b].centreNm),
      ratio: viewNumber(diameterUm / (RAY_BANDS[b].centreNm / 1000), diameterUm * 1000 / RAY_BANDS[b].centreNm < 0.1 ? 4 : 2, lang),
      x: viewNumber(p.sizeParameter, p.sizeParameter < 0.1 ? 4 : 2, lang),
    }), RAY_BANDS[b].css);
    piece(sep, 'rgba(255,255,255,0.6)');
  }

  // Row 1: three boxes, one per kind of picture.
  const top = 46, gap = 10;
  const legendH = 30;
  const rowH = Math.round((h - top - legendH - gap) * 0.6);
  const innerW = w - 28;
  const w1 = Math.round(innerW * 0.24), w2 = Math.round(innerW * 0.38);
  const w3 = innerW - w1 - w2 - 2 * gap;
  const boxScale = { x: 14, y: top, w: w1, h: rowH };
  const boxRays = { x: 14 + w1 + gap, y: top, w: w2, h: rowH };
  const boxGraph = { x: 14 + w1 + w2 + 2 * gap, y: top, w: w3, h: rowH };

  // 1. To scale.
  boxTitle(ctx, boxScale, t('beam.particle.box.scale'));
  const pic = { x: boxScale.x, y: boxScale.y + 18, w: boxScale.w, h: boxScale.h - 18 };
  drawToScale(ctx, pic, diameterUm, band, t, diameterUm < 0.002);
  drawKindTag(ctx, pic, 'scale', t);

  // 2. Light paths.
  boxTitle(ctx, boxRays, t('beam.particle.box.rays'));
  const rays = { x: boxRays.x, y: boxRays.y + 18, w: boxRays.w, h: boxRays.h - 18 };
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  ctx.fillRect(rays.x, rays.y, rays.w, rays.h);
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 1;
  ctx.strokeRect(rays.x + 0.5, rays.y + 0.5, rays.w - 1, rays.h - 1);
  const rcx = rays.x + rays.w * 0.5, rcy = rays.y + rays.h * 0.5;
  const reach = Math.min(rays.w * 0.46, rays.h * 0.44);
  ctx.save();
  ctx.beginPath(); ctx.rect(rays.x, rays.y, rays.w, rays.h); ctx.clip();
  // Arriving: a narrow parallel beam from the left, straight at the particle.
  ctx.strokeStyle = RAY_BANDS[band].css;
  ctx.fillStyle = RAY_BANDS[band].css;
  ctx.lineWidth = 1.6;
  for (const dy of [-4, 0, 4]) arrow(ctx, rays.x + 4, rcy + dy, rcx - 9, rcy + dy, 6);
  // Leaving: each ray carries the same share of the scattered light.
  ctx.strokeStyle = `rgba(${r},${g},${bl},0.85)`;
  ctx.fillStyle = `rgba(${r},${g},${bl},0.85)`;
  ctx.lineWidth = 1.2;
  const fan = 24;
  for (let k = 0; k < fan; k++) {
    const q = (Math.floor(k / 2) + 0.5) / (fan / 2);
    const th = chosen.turnAt(q) * Math.PI / 180 * (k % 2 ? -1 : 1);
    arrow(ctx, rcx + 6 * Math.cos(th), rcy - 6 * Math.sin(th), rcx + reach * Math.cos(th), rcy - reach * Math.sin(th), 5);
  }
  ctx.restore();
  ctx.fillStyle = '#d9b77a';
  ctx.beginPath(); ctx.arc(rcx, rcy, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  boxNote(ctx, t('beam.particle.raysNote', { n: fan }), rays);
  drawKindTag(ctx, rays, 'rays', t);

  // 3. Brightness graph.
  boxTitle(ctx, boxGraph, t('beam.particle.box.graph'));
  const graph = { x: boxGraph.x, y: boxGraph.y + 18, w: boxGraph.w, h: boxGraph.h - 18 };
  ctx.fillStyle = 'rgba(143,227,196,0.03)';
  ctx.fillRect(graph.x, graph.y, graph.w, graph.h);
  ctx.strokeStyle = 'rgba(143,227,196,0.35)';
  ctx.strokeRect(graph.x + 0.5, graph.y + 0.5, graph.w - 1, graph.h - 1);
  const gcx = graph.x + graph.w / 2, gcy = graph.y + graph.h / 2 - 4;
  const R = Math.max(24, Math.min(graph.w / 2 - 22, graph.h / 2 - 26));
  ctx.strokeStyle = 'rgba(143,227,196,0.22)';
  ctx.lineWidth = 1;
  for (const f of (log ? [0.25, 0.5, 0.75, 1] : [0.5, 1])) {
    ctx.beginPath(); ctx.arc(gcx, gcy, R * f, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(143,227,196,0.75)';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const deg of [0, 45, 90, 135, 180, 225, 270, 315]) {
    const a = deg * Math.PI / 180;
    ctx.beginPath(); ctx.moveTo(gcx, gcy); ctx.lineTo(gcx + R * Math.cos(a), gcy - R * Math.sin(a)); ctx.stroke();
    if (deg % 90 === 0) ctx.fillText(`${deg > 180 ? 360 - deg : deg}°`, gcx + (R + 11) * Math.cos(a), gcy - (R + 9) * Math.sin(a));
  }
  if (log) {
    ctx.textAlign = 'left';
    for (let k = 0; k < LOG_DECADES; k++) {
      ctx.fillText(k ? `10⁻${'¹²³⁴'[k - 1]}` : '1', gcx + 3, gcy - R * (1 - k / LOG_DECADES) + 6);
    }
  }
  lobe(ctx, chosen, gcx, gcy, R, log);
  ctx.fillStyle = `rgba(${r},${g},${bl},0.3)`;
  ctx.fill();
  ctx.strokeStyle = RAY_BANDS[band].css;
  ctx.lineWidth = 2;
  ctx.stroke();
  if (polar) {
    // The two polarisations, whose sum is the graph: across the scattering
    // plane (solid) and in it (dotted).
    lobe(ctx, chosen, gcx, gcy, R, log, 'perpendicular');
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.4;
    ctx.stroke();
    lobe(ctx, chosen, gcx, gcy, R, log, 'parallel');
    ctx.setLineDash([2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  } else {
    lobe(ctx, other, gcx, gcy, R, log);
    ctx.setLineDash([5, 3]);
    ctx.strokeStyle = RAY_BANDS[contrast].css;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  boxNote(ctx, t(polar ? 'beam.particle.polarNote' : log ? 'beam.particle.graphNoteLog' : 'beam.particle.graphNote'), graph);
  drawKindTag(ctx, graph, 'graph', t);

  // Row 2: by colour band, the target and the typical turn - graphs too.
  const row2Y = top + rowH + gap;
  const row2H = h - legendH - row2Y;
  const half = (innerW - gap) / 2;
  const patterns = RAY_BANDS.map((b) => dropletPattern(diameterUm, b.centreNm));
  // A molecule's target follows 1/lambda^n with the slider's n; its directions do not.
  const targets = RAY_BANDS.map((b, k) => (molecule ? moleculeCrossSection(b.centreNm, exponent) : patterns[k].crossSection));
  const maxC = Math.max(...targets);
  const ratio = targets[band] / targets[contrast];
  const targetBox = { x: 14, y: row2Y, w: half, h: row2H };
  const turnBox = { x: 14 + half + gap, y: row2Y, w: half, h: row2H };
  bars(ctx, targetBox,
    t('beam.particle.targetTitle'),
    t(molecule ? 'beam.particle.targetNoteMolecule' : 'beam.particle.targetNote', {
      nm: Math.round(RAY_BANDS[band].centreNm), nmC: Math.round(RAY_BANDS[contrast].centreNm), ratio: viewNumber(ratio, ratio < 10 ? 2 : 1, lang),
      n: viewNumber(exponent, 1, lang),
    }),
    targets.map((v) => v / maxC), () => '', band);
  drawKindTag(ctx, targetBox, 'graph', t);
  if (polar) {
    polarizationChart(ctx, turnBox, [[chosen, band], [other, contrast]], t, lang);
    drawKindTag(ctx, turnBox, 'graph', t);
  } else {
  const maxTurn = Math.max(90, ...patterns.map((p) => p.medianTurnDeg));
  bars(ctx, turnBox,
    t('beam.particle.turnTitle'),
    t('beam.particle.turnNote'),
    patterns.map((p) => p.medianTurnDeg / maxTurn),
    (k) => {
      const v = patterns[k].medianTurnDeg;
      return `${viewNumber(v, v < 10 ? 1 : 0, lang)}°`;
    }, band);
  drawKindTag(ctx, turnBox, 'graph', t);
  }

  // What each kind of picture means.
  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.65)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(t('beam.particle.kindsLegend', {
    nm: Math.round(RAY_BANDS[band].centreNm), nmC: Math.round(RAY_BANDS[contrast].centreNm),
  }), 14, h - 10);
  ctx.restore();
}

/** A note at the bottom of a box, wrapped onto as many lines as the box is narrow. */
function boxNote(ctx, text, box) {
  ctx.save();
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    const tryLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(tryLine).width > box.w - 10 && line) { lines.push(line); line = word; } else line = tryLine;
  }
  if (line) lines.push(line);
  lines.forEach((l, k) => ctx.fillText(l, box.x + 5, box.y + box.h - 4 - (lines.length - 1 - k) * 11));
  ctx.restore();
}

/**
 * Degree of polarisation against the scattering angle, for two colours: the
 * share of the scattered light polarised across the scattering plane minus
 * the share polarised in it. Negative values mean polarised in the plane.
 */
function polarizationChart(ctx, box, curves, t, lang) {
  ctx.fillStyle = 'rgba(8,11,20,0.95)';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeStyle = 'rgba(120,150,200,0.3)';
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
  ctx.font = 'bold 10.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(t('beam.particle.polarTitle'), box.x + 8, box.y + 6);
  const [first] = curves;
  const p90 = first[0].polarization[(first[0].thetaDeg.length - 1) / 2];
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillText(t('beam.particle.polarNoteChart', { p: Math.round(p90 * 100) }), box.x + 8, box.y + 21);
  const area = { x: box.x + 38, y: box.y + 40, w: box.w - 50, h: box.h - 62 };
  const X = (deg) => area.x + (deg / 180) * area.w;
  const Y = (v) => area.y + (1 - (v + 1) / 2) * area.h;
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  for (const v of [-1, 0, 1]) { ctx.beginPath(); ctx.moveTo(area.x, Y(v)); ctx.lineTo(area.x + area.w, Y(v)); ctx.stroke(); }
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of [-1, 0, 1]) ctx.fillText(`${Math.round(v * 100)} %`, area.x - 4, Y(v));
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const deg of [0, 45, 90, 135, 180]) ctx.fillText(`${deg}°`, X(deg), area.y + area.h + 3);
  curves.forEach(([pattern, band], k) => {
    ctx.strokeStyle = RAY_BANDS[band].css;
    ctx.lineWidth = k ? 1.4 : 2;
    ctx.setLineDash(k ? [5, 3] : []);
    ctx.beginPath();
    pattern.thetaDeg.forEach((deg, j) => (j ? ctx.lineTo(X(deg), Y(pattern.polarization[j])) : ctx.moveTo(X(deg), Y(pattern.polarization[j]))));
    ctx.stroke();
    ctx.setLineDash([]);
  });
  ctx.textAlign = 'left';
}

function boxTitle(ctx, box, text) {
  ctx.save();
  ctx.font = 'bold 10.5px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.88)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, box.x + 2, box.y + 12);
  ctx.restore();
}

/** A ray: a line with an arrowhead where it ends. */
function arrow(ctx, x0, y0, x1, y1, head) {
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - head * Math.cos(a - 0.45), y1 - head * Math.sin(a - 0.45));
  ctx.lineTo(x1 - head * Math.cos(a + 0.45), y1 - head * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
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

/**
 * Two strips around the collision chamber that show why the size of a
 * particle, compared with the wavelength, decides where scattered light goes.
 *
 *   Test bench (above the chamber): four particles side by side - an air
 *   molecule, droplets of 0.1 and 0.5 micrometres, and a 10 micrometre cloud
 *   droplet - each with the pattern of where its scattered light goes, for the
 *   chosen colour and, in white light, for a contrasting one. A molecule's
 *   pattern is the same for every colour; a half-micrometre droplet sends blue
 *   further forward than red; a cloud droplet sends every colour into the
 *   same narrow forward cone.
 *
 *   Waves (below the chamber): the particle met at the chosen collision, with
 *   the incoming wave drawn to scale against it, and dials adding up the waves
 *   its parts send forward, sideways and back. In white light the same
 *   particle is shown in two colours; with one colour, beside the other kind
 *   of particle.
 *
 * The patterns come from physics/mie.js; nothing here computes physics.
 */

import { RAY_BANDS } from '../physics/spectrum.js';
import { particlePattern, phasorChain, SAMPLE_PARTICLES } from '../physics/mie.js';

/** The wavelength drawn this many pixels apart, unless the particle would not fit. */
const WAVE_SPACING_PX = 34;

function stripPct(v, lang) {
  const p = v * 100;
  const text = p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p >= 0.1 ? p.toFixed(1) : '< 0.1';
  return `${lang === 'cs' ? text.replace('.', ',') : text} %`;
}

function stripNumber(v, digits, lang) {
  const text = v.toFixed(digits);
  return lang === 'cs' ? text.replace('.', ',') : text;
}

/** The pattern as a closed polar outline round (cx, cy), incoming light from the left. */
function patternPath(ctx, pattern, cx, cy, radius) {
  const n = pattern.thetaDeg.length;
  ctx.beginPath();
  for (let j = 0; j < n; j++) {
    const th = pattern.thetaDeg[j] * Math.PI / 180;
    const r = radius * pattern.pattern[j];
    const x = cx + r * Math.cos(th), y = cy - r * Math.sin(th);
    if (j) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  for (let j = n - 1; j >= 0; j--) {
    const th = pattern.thetaDeg[j] * Math.PI / 180;
    const r = radius * pattern.pattern[j];
    ctx.lineTo(cx + r * Math.cos(th), cy + r * Math.sin(th));
  }
  ctx.closePath();
}

/**
 * What kind of picture a box holds, as a small tag in its top right corner,
 * the same in every view: 'scale' (particle and wave drawn to scale), 'rays'
 * (where the light goes), 'graph' (how much light goes which way), 'sum'
 * (the waves from a particle's parts added up), 'scheme' (a drawing that is
 * not to scale).
 */
const KIND_COLOURS = { scale: '#d9b77a', rays: '#ffffff', graph: '#8fe3c4', sum: '#c9a8ff', scheme: '#aab4c8' };

export function drawKindTag(ctx, box, kind, t, corner = 'top-right') {
  ctx.save();
  ctx.font = 'bold 8.5px system-ui, sans-serif';
  const text = t(`beam.kinds.${kind}`).toUpperCase();
  const w = ctx.measureText(text).width + 10;
  const left = corner.endsWith('left');
  const x = left ? box.x + 4 : box.x + box.w - w - 4;
  const y = corner.startsWith('bottom') ? box.y + box.h - 17 : box.y + 4;
  ctx.fillStyle = 'rgba(5,7,13,0.85)';
  ctx.strokeStyle = KIND_COLOURS[kind];
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, 13, 6); else ctx.rect(x, y, w, 13);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = KIND_COLOURS[kind];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + w / 2, y + 7);
  ctx.restore();
}

/** A polar grid for a brightness graph: two rings and the forward/back axis. */
export function drawPolarGrid(ctx, cx, cy, radius) {
  ctx.save();
  ctx.strokeStyle = 'rgba(143,227,196,0.22)';
  ctx.lineWidth = 1;
  for (const f of [0.5, 1]) { ctx.beginPath(); ctx.arc(cx, cy, radius * f, 0, Math.PI * 2); ctx.stroke(); }
  ctx.beginPath(); ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius); ctx.stroke();
  ctx.restore();
}

/**
 * The particle and the light's wave drawn to the same scale: one line per
 * wave crest, the particle as a circle with some of its parts. A molecule is
 * far too small to see at this scale and is drawn as a dot.
 */
export function drawToScale(ctx, pic, diameterUm, bandIndex, t, molecule) {
  const band = RAY_BANDS[bandIndex];
  const lambdaUm = band.centreNm / 1000;
  const cx = pic.x + pic.w * 0.5, cy = pic.y + pic.h / 2;
  let pxPerUm = WAVE_SPACING_PX / lambdaUm;
  let radiusPx = (diameterUm / 2) * pxPerUm;
  const maxRadius = pic.h * 0.36;
  if (radiusPx > maxRadius) { pxPerUm *= maxRadius / radiusPx; radiusPx = maxRadius; }
  const spacing = lambdaUm * pxPerUm;
  const dot = molecule || radiusPx < 2;
  ctx.save();
  ctx.fillStyle = 'rgba(217,183,122,0.04)';
  ctx.fillRect(pic.x, pic.y, pic.w, pic.h);
  ctx.strokeStyle = 'rgba(217,183,122,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeRect(pic.x + 0.5, pic.y + 0.5, pic.w - 1, pic.h - 1);
  ctx.beginPath(); ctx.rect(pic.x, pic.y, pic.w, pic.h); ctx.clip();
  // Wave crests, one line per wavelength, up to the particle's far side.
  ctx.strokeStyle = band.css;
  ctx.lineWidth = spacing > 6 ? 1.6 : 0.8;
  ctx.globalAlpha = 0.8;
  for (let x = cx + (dot ? 0 : radiusPx); x > pic.x; x -= spacing) {
    ctx.beginPath(); ctx.moveTo(x, pic.y + 4); ctx.lineTo(x, pic.y + pic.h - 4); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (dot) {
    ctx.fillStyle = molecule ? '#6aa9ff' : '#d9b77a';
    ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(217,183,122,0.35)';
    ctx.strokeStyle = '#d9b77a';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    const step = Math.max(5, radiusPx / 4);
    ctx.fillStyle = '#fff3d6';
    for (let dx = -radiusPx; dx <= radiusPx; dx += step) {
      for (let dy = -radiusPx; dy <= radiusPx; dy += step) {
        if (dx * dx + dy * dy <= radiusPx * radiusPx * 0.85) {
          ctx.beginPath(); ctx.arc(cx + dx, cy + dy, 1.1, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  }
  ctx.restore();
  // Scale bar: one wavelength, or a note that the lines are its crests.
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1;
  const barY = pic.y + pic.h - 4;
  const barX = pic.x + 5;
  const barLen = Math.min(spacing, pic.w * 0.4);
  ctx.beginPath(); ctx.moveTo(barX, barY); ctx.lineTo(barX + barLen, barY); ctx.stroke();
  ctx.font = '9px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText(barLen >= spacing - 0.5 ? `λ = ${Math.round(band.centreNm)} nm` : t('beam.wave.crests'), barX, barY - 2);
  if (dot) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(t('beam.kinds.tooSmall'), cx, cy + 7);
  }
  ctx.restore();
}

function frame(ctx, box, strong) {
  ctx.fillStyle = 'rgba(8,11,20,0.95)';
  ctx.fillRect(box.x, box.y, box.w, box.h);
  ctx.strokeStyle = strong ? 'rgba(255,255,255,0.75)' : 'rgba(120,150,200,0.3)';
  ctx.lineWidth = strong ? 1.5 : 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w - 1, box.h - 1);
}

/**
 * The test bench.
 * @param {object} o
 *   rect, t, lang, band (chosen), contrast (band or null),
 *   highlight (sample id of the chosen collision's particle, or null),
 *   moleculeRatio (how much larger a molecule's target is for band than for contrast)
 */
export function drawTestBench(ctx, o) {
  const { rect, t, lang, band, contrast } = o;
  const gap = 8;
  const cells = SAMPLE_PARTICLES.length;
  const cw = (rect.w - gap * (cells - 1)) / cells;
  const nm = RAY_BANDS[band].centreNm;
  const nmC = contrast !== null ? RAY_BANDS[contrast].centreNm : null;
  ctx.save();
  SAMPLE_PARTICLES.forEach((particle, k) => {
    const box = { x: rect.x + k * (cw + gap), y: rect.y, w: cw, h: rect.h };
    frame(ctx, box, particle.id === o.highlight);
    const a = particlePattern(particle.id, nm);
    const b = nmC !== null ? particlePattern(particle.id, nmC) : null;

    // Two lines of text: what it is, and the numbers that matter.
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(t(`beam.bench.name.${particle.id}`), box.x + 6, box.y + 4);
    ctx.font = '9.5px system-ui, sans-serif';
    let tx = box.x + 6;
    const ty = box.y + 17;
    const piece = (text, colour) => {
      ctx.fillStyle = colour;
      ctx.fillText(text, tx, ty);
      tx += ctx.measureText(text).width;
    };
    piece(`${t('beam.bench.turn')} `, 'rgba(255,255,255,0.6)');
    piece(`${Math.round(a.medianTurnDeg)}°`, RAY_BANDS[band].css);
    if (b) {
      piece(' / ', 'rgba(255,255,255,0.6)');
      piece(`${Math.round(b.medianTurnDeg)}°`, RAY_BANDS[contrast].css);
      const ratio = particle.id === 'molecule' && o.moleculeRatio ? o.moleculeRatio : a.crossSection / b.crossSection;
      piece(` · ${t('beam.bench.target')} ${stripNumber(ratio, 1, lang)}×`, 'rgba(255,255,255,0.6)');
    }

    // The pattern: where the scattered light goes, light arriving from the left.
    const top = box.y + 30;
    const area = { x: box.x + 4, y: top, w: box.w - 8, h: box.y + box.h - top - 4 };
    const cx = area.x + area.w / 2;
    const cy = area.y + area.h / 2;
    const radius = Math.max(8, Math.min(area.h / 2 - 2, area.w / 2 - 12));
    // A brightness graph, not a picture: the grid says so, and so does the tag.
    drawPolarGrid(ctx, cx, cy, radius);
    drawKindTag(ctx, box, 'graph', t, 'bottom-left');

    const [r, g, bl] = RAY_BANDS[band].rgb;
    patternPath(ctx, a, cx, cy, radius);
    ctx.fillStyle = `rgba(${r},${g},${bl},0.35)`;
    ctx.fill();
    ctx.strokeStyle = RAY_BANDS[band].css;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    if (b) {
      patternPath(ctx, b, cx, cy, radius);
      ctx.setLineDash([3, 2]);
      ctx.strokeStyle = RAY_BANDS[contrast].css;
      ctx.lineWidth = 1.4;
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.arc(cx, cy, 1.6, 0, Math.PI * 2); ctx.fill();

    if (o.inChamber.includes(particle.id)) {
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(t('beam.bench.inChamber'), box.x + box.w - 5, box.y + box.h - 3);
    }
  });
  ctx.restore();
}

/**
 * The wave strip: one or two panels.
 * @param {object} o rect, t, lang, panels: [{ particle, band, chosen }]
 */
export function drawWaveStrip(ctx, o) {
  const { rect, t, lang, panels } = o;
  const gap = 10;
  const pw = (rect.w - gap * (panels.length - 1)) / panels.length;
  ctx.save();
  panels.forEach((panel, k) => {
    const box = { x: rect.x + k * (pw + gap), y: rect.y, w: pw, h: rect.h };
    frame(ctx, box, panel.chosen);
    drawWavePanel(ctx, box, panel, t, lang);
  });
  ctx.restore();
}

function drawWavePanel(ctx, box, panel, t, lang) {
  const band = RAY_BANDS[panel.band];
  const particle = SAMPLE_PARTICLES.find((p) => p.id === panel.particle);
  const lambdaUm = band.centreNm / 1000;

  // Header: which particle, which colour, and its size against the wavelength.
  ctx.font = 'bold 10px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  const header = panel.particle === 'molecule'
    ? t('beam.wave.headerMolecule', { nm: Math.round(band.centreNm), times: Math.round(lambdaUm / particle.diameterUm) })
    : t('beam.wave.headerDroplet', {
      name: t(`beam.bench.name.${panel.particle}`), nm: Math.round(band.centreNm),
      ratio: stripNumber(particle.diameterUm / lambdaUm, 1, lang),
    });
  ctx.fillStyle = band.css;
  ctx.fillRect(box.x + 6, box.y + 6, 8, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText(header, box.x + 18, box.y + 5);

  // Picture to scale: the wave crests and the particle.
  const pic = { x: box.x + 6, y: box.y + 20, w: Math.min(box.w * 0.42, (box.h - 26) * 1.5), h: box.h - 26 };
  drawToScale(ctx, pic, particle.diameterUm, panel.band, t, panel.particle === 'molecule');
  drawKindTag(ctx, pic, 'scale', t);

  // Dials: the waves from all the parts added up, in three directions.
  const dialsX = pic.x + pic.w + 10;
  const dialsW = box.x + box.w - 6 - dialsX;
  const directions = [['forward', 0], ['side', 90], ['back', 180]];
  const cell = dialsW / directions.length;
  const dialR = Math.max(10, Math.min(cell / 2 - 5, (box.h - 26 - 44) / 2));
  const dialCy = box.y + 36 + dialR;
  drawKindTag(ctx, { x: dialsX, y: box.y + 20, w: dialsW, h: box.h - 24 }, 'sum', t, 'bottom-right');
  directions.forEach(([key, theta], i) => {
    const dcx = dialsX + cell * (i + 0.5);
    const { chain, resultant } = phasorChain(particle.diameterUm, band.centreNm, theta);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(dcx, dialCy, dialR, 0, Math.PI * 2); ctx.stroke();
    // The chain of small waves, head to tail, then the sum as an arrow.
    const scale = dialR * 0.95;
    const sx = dcx - scale * 0.5 * (chain[chain.length - 1].x);
    const sy = dialCy + scale * 0.5 * (chain[chain.length - 1].y);
    const stepDraw = Math.max(1, Math.floor(chain.length / 400));
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    for (let j = 0; j < chain.length; j += stepDraw) {
      const p = chain[j];
      if (j) ctx.lineTo(sx + p.x * scale, sy - p.y * scale); else ctx.moveTo(sx + p.x * scale, sy - p.y * scale);
    }
    const last = chain[chain.length - 1];
    ctx.lineTo(sx + last.x * scale, sy - last.y * scale);
    ctx.stroke();
    const ex = sx + last.x * scale, ey = sy - last.y * scale;
    if (resultant > 0.04) {
      ctx.strokeStyle = band.css;
      ctx.fillStyle = band.css;
      ctx.lineWidth = 2.4;
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
      const ang = Math.atan2(ey - sy, ex - sx);
      ctx.beginPath();
      ctx.moveTo(ex, ey);
      ctx.lineTo(ex - 7 * Math.cos(ang - 0.4), ey - 7 * Math.sin(ang - 0.4));
      ctx.lineTo(ex - 7 * Math.cos(ang + 0.4), ey - 7 * Math.sin(ang + 0.4));
      ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = band.css;
      ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = '9.5px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${t(`beam.wave.dir.${key}`)} ${theta}°`, dcx, dialCy - dialR - 3);
    ctx.textBaseline = 'top';
    ctx.fillStyle = band.css;
    ctx.fillText(stripPct(resultant * resultant, lang), dcx, dialCy + dialR + 4);
    ctx.textAlign = 'left';
  });
}

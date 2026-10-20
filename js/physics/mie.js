/**
 * How a single particle scatters light, by size and wavelength.
 *
 * Mie theory for a sphere (the BHMIE algorithm of Bohren and Huffman, 1983,
 * appendix A), used for droplets; the Rayleigh limit for molecules. It gives
 * two things the collision view needs:
 *
 *   - how likely a hit is: the scattering cross-section, which for a molecule
 *     goes as 1/lambda^4 and for a large droplet hardly depends on colour;
 *   - where the light goes: the angular pattern (phase function), which for a
 *     molecule is 1 + cos^2(theta) whatever the colour, but for a particle
 *     about as large as the wavelength turns forward, and more so the shorter
 *     the wavelength.
 *
 * Two different things come out of the same pattern, and they must not be
 * confused. The pattern p(theta) itself is the BRIGHTNESS in a direction: the
 * light per unit solid angle, which is what the polar graphs draw. The TURN a
 * ray takes is the scattering angle, and in three dimensions there are far
 * more directions near 90 degrees than near 0 or 180 (a ring of directions,
 * 2 pi sin(theta) dtheta), so the angle is distributed as p(theta) sin(theta).
 * The chamber, the ray fan and the "typical turn" all use that distribution:
 * each drawn ray is a real scattering seen in the plane it happened in.
 *
 * The wave picture (phasorChain) is the Rayleigh-Gans view of the same thing:
 * every small part of the particle re-radiates the wave that reaches it, and
 * the parts' waves are added with the phase differences their positions give.
 * In the forward direction they always arrive in step; in other directions
 * they arrive in step only if the particle is small compared with the
 * wavelength.
 */

import { bodhaineAirShape } from './scattering.js';

/** The depolarisation ratio of air (Young 1980), as the sky simulation uses it. */
export const AIR_DEPOLARIZATION = 0.0279;

/** Below this diameter (micrometres) a "droplet" is an air molecule. */
export const MOLECULE_LIMIT_UM = 0.002;

/** Water droplets: real refractive index, no absorption. */
export const WATER_INDEX = 1.33;

/**
 * The particles the collision view shows. The molecule and the haze droplet
 * are the two kinds that scatter in the chamber.
 */
export const SAMPLE_PARTICLES = [
  { id: 'molecule', diameterUm: 0.0003 },
  { id: 'fine', diameterUm: 0.1, index: WATER_INDEX },
  { id: 'haze', diameterUm: 0.5, index: WATER_INDEX },
  { id: 'cloud', diameterUm: 10, index: WATER_INDEX },
];

/** The chamber's particle kinds and the sample each one stands for. */
export const CHAMBER_SAMPLE = { rayleigh: 'molecule', aerosolScatter: 'haze' };

/** Angular resolution of the tables: quarter-degree steps from 0 to 180 degrees. */
const HALF_ANGLES = 361;

/**
 * Mie scattering by a sphere of real refractive index m.
 * @param {number} x size parameter 2*pi*r/lambda
 * @param {number} m refractive index (real)
 * @param {number} nang angles from 0 to 90 degrees inclusive; the result has 2*nang-1 from 0 to 180
 * @returns {{qsca:number, qext:number, g:number, s11:Float64Array, perp:Float64Array, par:Float64Array}}
 *   s11 = (|S1|^2+|S2|^2)/2; perp = |S1|^2 (light polarised across the
 *   scattering plane), par = |S2|^2 (polarised in it)
 */
export function mie(x, m, nang = HALF_ANGLES) {
  const y = x * m;
  const xstop = x + 4 * Math.cbrt(x) + 2;
  const nstop = Math.round(xstop);
  const nmx = Math.round(Math.max(xstop, Math.abs(y))) + 15;
  const dang = (Math.PI / 2) / (nang - 1);
  const amu = new Float64Array(nang);
  for (let j = 0; j < nang; j++) amu[j] = Math.cos(j * dang);
  const pi0 = new Float64Array(nang);
  const pi1 = new Float64Array(nang).fill(1);
  const pi = new Float64Array(nang);
  const tau = new Float64Array(nang);
  const nn = 2 * nang - 1;
  const s1r = new Float64Array(nn), s1i = new Float64Array(nn);
  const s2r = new Float64Array(nn), s2i = new Float64Array(nn);

  // Logarithmic derivative D_n(mx), by downward recurrence (real for real m).
  const d = new Float64Array(nmx + 1);
  for (let n = 1; n < nmx; n++) {
    const en = nmx - n + 1;
    d[nmx - n] = en / y - 1 / (d[nmx - n + 1] + en / y);
  }

  let psi0 = Math.cos(x), psi1 = Math.sin(x);
  let chi0 = -Math.sin(x), chi1 = Math.cos(x);
  let qsca = 0, gsca = 0;
  let p = -1;
  let anR1 = 0, anI1 = 0, bnR1 = 0, bnI1 = 0;
  for (let n = 1; n <= nstop; n++) {
    const fn = (2 * n + 1) / (n * (n + 1));
    const psi = (2 * n - 1) * psi1 / x - psi0;
    const chi = (2 * n - 1) * chi1 / x - chi0;
    // xi = psi - i chi, xi1 = psi1 - i chi1
    const fa = d[n] / m + n / x;
    const fb = m * d[n] + n / x;
    const [anR, anI] = cdiv(fa * psi - psi1, 0, fa * psi - psi1, -(fa * chi - chi1));
    const [bnR, bnI] = cdiv(fb * psi - psi1, 0, fb * psi - psi1, -(fb * chi - chi1));
    qsca += (2 * n + 1) * (anR * anR + anI * anI + bnR * bnR + bnI * bnI);
    gsca += fn * (anR * bnR + anI * bnI);
    if (n > 1) {
      gsca += ((n - 1) * (n + 1) / n) * (anR1 * anR + anI1 * anI + bnR1 * bnR + bnI1 * bnI);
    }
    for (let j = 0; j < nang; j++) {
      pi[j] = pi1[j];
      tau[j] = n * amu[j] * pi[j] - (n + 1) * pi0[j];
      s1r[j] += fn * (anR * pi[j] + bnR * tau[j]);
      s1i[j] += fn * (anI * pi[j] + bnI * tau[j]);
      s2r[j] += fn * (anR * tau[j] + bnR * pi[j]);
      s2i[j] += fn * (anI * tau[j] + bnI * pi[j]);
    }
    p = -p;
    for (let j = 0; j < nang - 1; j++) {
      const jj = nn - 1 - j;
      s1r[jj] += fn * p * (anR * pi[j] - bnR * tau[j]);
      s1i[jj] += fn * p * (anI * pi[j] - bnI * tau[j]);
      s2r[jj] += fn * p * (bnR * pi[j] - anR * tau[j]);
      s2i[jj] += fn * p * (bnI * pi[j] - anI * tau[j]);
    }
    psi0 = psi1; psi1 = psi;
    chi0 = chi1; chi1 = chi;
    for (let j = 0; j < nang; j++) {
      pi1[j] = ((2 * n + 1) * amu[j] * pi[j] - (n + 1) * pi0[j]) / n;
      pi0[j] = pi[j];
    }
    anR1 = anR; anI1 = anI; bnR1 = bnR; bnI1 = bnI;
  }
  const g = 2 * gsca / qsca;
  qsca *= 2 / (x * x);
  const qext = (4 / (x * x)) * s1r[0];
  const s11 = new Float64Array(nn);
  const perp = new Float64Array(nn);
  const par = new Float64Array(nn);
  for (let j = 0; j < nn; j++) {
    perp[j] = s1r[j] * s1r[j] + s1i[j] * s1i[j];
    par[j] = s2r[j] * s2r[j] + s2i[j] * s2i[j];
    s11[j] = 0.5 * (perp[j] + par[j]);
  }
  return { qsca, qext, g, s11, perp, par };
}

/** (a + ib) / (c + id) */
function cdiv(a, b, c, dd) {
  const den = c * c + dd * dd;
  return [(a * c + b * dd) / den, (b * c - a * dd) / den];
}

const patternCache = new Map();

/**
 * One particle's scattering at one wavelength, ready to draw and to sample.
 * @returns {{
 *   id:string, diameterUm:number, lambdaNm:number, sizeParameter:number,
 *   thetaDeg:Float64Array, pattern:Float64Array,   // pattern normalised to its maximum
 *   cdf:Float64Array,                                // probability of turning by at most theta
 *   crossSection:number,                             // um^2; for the molecule, relative (lambda^-4)
 *   medianTurnDeg:number, forwardShare:number,       // forwardShare: turned by less than 90 degrees
 * }}
 */
export function particlePattern(id, lambdaNm) {
  const particle = SAMPLE_PARTICLES.find((p) => p.id === id);
  if (!particle) throw new Error(`unknown particle ${id}`);
  return buildPattern(id, particle.diameterUm, particle.index, lambdaNm);
}

/**
 * The same for a water sphere of any diameter: the single-particle view's
 * slider. The diameter is rounded to four significant figures for the cache.
 */
export function dropletPattern(diameterUm, lambdaNm, index = WATER_INDEX) {
  // Smaller than a couple of nanometres there is no droplet, only molecules.
  if (diameterUm < MOLECULE_LIMIT_UM) return particlePattern('molecule', lambdaNm);
  const d = Number(diameterUm.toPrecision(4));
  return buildPattern(`d${d}`, d, index, lambdaNm);
}

function buildPattern(id, diameterUm, index, lambdaNm) {
  const key = `${id}@${lambdaNm.toFixed(2)}`;
  const cached = patternCache.get(key);
  if (cached) return cached;
  const particle = { diameterUm, index };
  const lambdaUm = lambdaNm / 1000;
  const r = particle.diameterUm / 2;
  const sizeParameter = 2 * Math.PI * r / lambdaUm;
  const nn = 2 * HALF_ANGLES - 1;
  const thetaDeg = new Float64Array(nn);
  for (let j = 0; j < nn; j++) thetaDeg[j] = (180 * j) / (nn - 1);

  let raw, crossSection, perpRaw, parRaw;
  if (id === 'molecule') {
    // Rayleigh with the depolarisation of real air (Chandrasekhar; Hansen &
    // Travis 1974), and the cross-section of real air (Bodhaine et al. 1999),
    // exactly as the sky simulation uses them. Relative units: only ratios
    // between colours are used.
    crossSection = moleculeCrossSection(lambdaNm);
    // The two polarisations: across the scattering plane the same in every
    // direction, in the plane as cos^2 - with the small depolarisation of air
    // (gamma = rho / (2 - rho)) filling the dip at 90 degrees a little.
    const gamma = AIR_DEPOLARIZATION / (2 - AIR_DEPOLARIZATION);
    perpRaw = thetaDeg.map(() => 1 + gamma);
    parRaw = thetaDeg.map((t) => 2 * gamma + (1 - gamma) * Math.cos(t * Math.PI / 180) ** 2);
    // Their mean: the Rayleigh pattern of air, (1 + 3 gamma) + (1 - gamma) cos^2,
    // the same shape as rayleighPhase() in scattering.js with the same depolarisation.
    raw = thetaDeg.map((_, j) => 0.5 * (perpRaw[j] + parRaw[j]));
  } else {
    const result = mie(sizeParameter, particle.index);
    raw = result.s11;
    perpRaw = result.perp;
    parRaw = result.par;
    crossSection = result.qsca * Math.PI * r * r;
  }
  let max = 0;
  for (const v of raw) max = Math.max(max, v);
  const pattern = raw.map((v) => v / max);
  // The two polarisations on the same scale (their mean is the pattern), and
  // the degree of polarisation: how much more light is polarised across the
  // scattering plane than in it, as a share of all of it.
  const scale = 0.5 / max;
  const perpendicular = Float64Array.from(perpRaw, (v) => v * scale);
  const parallel = Float64Array.from(parRaw, (v) => v * scale);
  const polarization = Float64Array.from(perpRaw, (v, j) => {
    const sum = v + parRaw[j];
    return sum > 0 ? (v - parRaw[j]) / sum : 0;
  });
  // The turn: the scattering angle, distributed as p(theta) sin(theta).
  const weight = (j) => pattern[j] * Math.sin(thetaDeg[j] * Math.PI / 180);
  const cdf = new Float64Array(nn);
  for (let j = 1; j < nn; j++) cdf[j] = cdf[j - 1] + 0.5 * (weight(j) + weight(j - 1));
  const total = cdf[nn - 1];
  for (let j = 0; j < nn; j++) cdf[j] /= total;
  const at = (q) => {
    let j = 1;
    while (j < nn - 1 && cdf[j] < q) j++;
    const f = (q - cdf[j - 1]) / Math.max(1e-300, cdf[j] - cdf[j - 1]);
    return thetaDeg[j - 1] + f * (thetaDeg[j] - thetaDeg[j - 1]);
  };
  const half = cdf[(nn - 1) / 2];
  const out = {
    id, diameterUm: particle.diameterUm, lambdaNm, sizeParameter,
    thetaDeg, pattern, cdf, crossSection, perpendicular, parallel, polarization,
    medianTurnDeg: at(0.5), forwardShare: half,
    turnAt: at,
  };
  if (patternCache.size > 4000) patternCache.clear();
  patternCache.set(key, out);
  return out;
}

/**
 * How strongly an air molecule scatters at a wavelength, relative to 550 nm,
 * for an exponent n: the measured law of real air (Bodhaine et al. 1999) with
 * its ideal 1/lambda^4 part replaced by 1/lambda^n - exactly what the
 * atmosphere does with its exponent slider, so n = 4 is real air.
 */
export function moleculeCrossSection(lambdaNm, exponent = 4) {
  return (bodhaineAirShape(lambdaNm) / bodhaineAirShape(550)) * Math.pow(550 / lambdaNm, exponent - 4);
}

/** A turn drawn from the particle's pattern: degrees, with a random side. */
export function sampleTurnDeg(pattern, rng) {
  const theta = pattern.turnAt(rng());
  return rng() < 0.5 ? theta : -theta;
}

/**
 * Size regime of a particle at a wavelength, for the words that go with it:
 * 'small' (much smaller than the wavelength), 'comparable', or 'large'.
 */
export function sizeRegime(sizeParameter) {
  if (sizeParameter < 0.3) return 'small';
  if (sizeParameter < 15) return 'comparable';
  return 'large';
}

/**
 * The waves from the parts of a particle, added for one direction. The
 * particle is the disc it cuts from the plane of the picture, filled with
 * small emitters a fraction of a wavelength apart; the light arrives along +x.
 * An emitter at (x, y) is reached with phase k*x and its wave leaves towards
 * direction theta with an extra path of -(x cos theta + y sin theta).
 *
 * @returns {{ chain: Array<{x:number, y:number}>, resultant:number }}
 *   chain: the running sum of the emitters' unit waves, scaled so that waves
 *   all in step reach length 1; resultant: the length of the sum (0..1).
 */
export function phasorChain(diameterUm, lambdaNm, thetaDeg, maxEmitters = 6000) {
  const r = diameterUm / 2;
  const lambdaUm = lambdaNm / 1000;
  const k = 2 * Math.PI / lambdaUm;
  // Spacing: well under the wavelength, and no more emitters than needed.
  let spacing = Math.min(lambdaUm / 6, r / 4);
  if (Math.PI * (r / spacing) ** 2 > maxEmitters) spacing = r * Math.sqrt(Math.PI / maxEmitters);
  const points = [];
  if (r < lambdaUm / 50) {
    points.push([0, 0]);
  } else {
    for (let gx = -r; gx <= r; gx += spacing) {
      for (let gy = -r; gy <= r; gy += spacing) {
        if (gx * gx + gy * gy <= r * r) points.push([gx, gy]);
      }
    }
  }
  const th = thetaDeg * Math.PI / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const n = points.length;
  // Order the emitters by phase so the chain is drawn as a smooth curve.
  const phases = points.map(([px, py]) => k * (px - (px * c + py * s)));
  phases.sort((a, b) => a - b);
  const chain = [{ x: 0, y: 0 }];
  let sx = 0, sy = 0;
  for (const ph of phases) {
    sx += Math.cos(ph) / n;
    sy += Math.sin(ph) / n;
    chain.push({ x: sx, y: sy });
  }
  return { chain, resultant: Math.hypot(sx, sy), emitters: n };
}

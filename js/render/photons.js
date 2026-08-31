/**
 * The light paths drawn in the cross-section.
 *
 * The picture is built backwards from the observer, because the question a
 * student is asking is "why is the light that reaches *me* blue?" Every path
 * drawn is one of three kinds:
 *
 *   arriving  sunlight that came down, scattered once, and turned INTO the
 *             observer. Its wavelength is drawn from the true single-scattering
 *             weight, so the bundle really is blue for the reason the
 *             integrator says it is.
 *   missed    sunlight that scattered at some other point and left in some
 *             other direction. Same physics, same phase function - it simply
 *             is not aimed at you.
 *   through   light that crossed the air without being scattered at all.
 *             Overwhelmingly red, and the lower the star the redder, because
 *             the chord it has to cross grows without limit.
 *
 * Each arriving path has exactly one scattering vertex, which is not a
 * simplification introduced here: it is precisely the single-scattering
 * approximation that physics/radiance.js integrates. The picture and the
 * numbers therefore describe the same model.
 *
 * GEOMETRY IS SPHERICAL, in true Cartesian coordinates with the planet centre at
 * the origin. An earlier version used a flat slab, which is indistinguishable
 * over a few tens of kilometres but makes the single most important fact about a
 * low Sun impossible to draw: that its light crosses a chord hundreds of
 * kilometres long. Straight lines stay straight here - the projection is a plain
 * orthographic one - and it is the ground that curves, which is the truth.
 *
 * The traced set does NOT depend on where the observer is looking. Scattering
 * events are a property of the air and the star; the renderer decides at draw
 * time which of them fall inside the current viewing cone.
 */

import { SPECTRUM_BINS, WAVELENGTHS_NM } from '../physics/spectrum.js';
import {
  rayleighPhase, henyeyGreensteinPhase, sampleRayleighCosine, sampleHenyeyGreensteinCosine,
} from '../physics/scattering.js';

/**
 * Half-angle of the cone of sky the observer is looking down.
 *
 * The panels report a radiance for one direction, so the picture has to show
 * which rays that direction actually collects. A mathematical point direction
 * would be one line; a cone is what an eye or an instrument really accepts, and
 * it is wide enough to read at the scale the cross-section is drawn.
 */
export const VIEW_CONE_HALF_DEG = 12;

/** How far from the zenith arriving rays are sampled, short of the horizon. */
const MAX_SKY_ANGLE_DEG = 85;

/** Length of the drawn sunward stub, as a fraction of the frame half-width. */
const ARRIVING_STUB = 0.30;

/** A small deterministic generator, so a given setup always draws the same picture. */
function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** Draw an index from a set of non-negative weights. */
function sampleWeighted(weights, total, u) {
  let acc = 0;
  const target = u * total;
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    acc += weights[i];
    if (acc >= target) return i;
  }
  return SPECTRUM_BINS - 1;
}

/**
 * Trace the light paths for the picture.
 *
 * @param {object} options
 *   atmosphere        an object from createAtmosphere
 *   source            top-of-atmosphere spectrum
 *   sunElevationDeg   elevation of the star above the observer's horizon
 *   observerZ         observer altitude in metres
 *   count             how many paths to draw
 *   span_m            vertical extent of the drawn frame, in metres
 *   halfWidth_m       half its horizontal extent
 *   skyExtent_m       how far above the observer's ground point the frame reaches
 *   seed              generator seed
 */
export function tracePhotons(options) {
  const {
    atmosphere, source, sunElevationDeg, observerZ = 0,
    count, span_m, halfWidth_m, skyExtent_m, seed = 12345,
    // Scales the sun-leg cache cell. 1 is the working value; the test suite
    // drives it towards zero to compare against an effectively uncached trace.
    sunCacheScale = 1,
  } = options;

  const paths = [];
  if (!(count > 0)) return paths;

  let sourceTotal = 0;
  for (let i = 0; i < SPECTRUM_BINS; i++) sourceTotal += source[i];
  if (!(sourceTotal > 0)) return paths;

  const rng = makeRng(seed);
  const R = atmosphere.planetRadius;
  const topR = R + atmosphere.topAltitude;
  const elevation = sunElevationDeg * Math.PI / 180;
  // The star is effectively at infinity, so this one direction serves the whole
  // picture - which is exactly why a low Sun makes long chords rather than a fan.
  const toStar = { x: Math.cos(elevation), y: Math.sin(elevation) };

  const betaR = atmosphere.rayleighBeta0;
  const betaAext = atmosphere.aerosolExt0;
  const betaAsca = atmosphere.aerosolSca0;
  const g = atmosphere.asymmetryG;
  const HR = atmosphere.scaleHeightRayleigh;
  const invHR = 1 / HR;
  const invHA = 1 / atmosphere.scaleHeightAerosol;

  const observer = { x: 0, y: R + Math.max(0, observerZ) };

  /* ---- world helpers, all in true Cartesian ---- */

  /** The tallest air worth drawing at this zoom. */
  function drawTopFor() {
    return Math.min(atmosphere.topAltitude, Math.max(HR * 0.6, skyExtent_m));
  }

  const altitudeOf = (p) => Math.sqrt(p.x * p.x + p.y * p.y) - R;

  /**
   * The point at altitude `h` whose horizontal screen coordinate is `x`.
   *
   * Parameterised by the Cartesian offset rather than by arc length along the
   * surface, because the frame is a rectangle in Cartesian space: an arc length
   * of exactly the half-width lands slightly outside it once the point is a few
   * kilometres up, by the factor (R + h)/R.
   */
  function pointAtOffset(x, h) {
    const r = R + h;
    return { x, y: Math.sqrt(Math.max(0, r * r - x * x)) };
  }

  /** Root of |origin + t·dir| = radius: the near one, or the far one. */
  function raySphere(origin, dir, radius, far) {
    const b = origin.x * dir.x + origin.y * dir.y;
    const c = origin.x * origin.x + origin.y * origin.y - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return null;
    const root = Math.sqrt(disc);
    const t = far ? -b + root : -b - root;
    return t > 1e-6 ? t : null;
  }

  /**
   * Column of air along a segment, for both species at once.
   *
   * Marched rather than solved in closed form: the closed form belongs to a flat
   * slab, and the whole point of the spherical geometry is the grazing path that
   * the flat form gets wrong. Steps are sized against the scale height, so a
   * short vertical path costs a dozen samples and a 600 km chord gets the
   * resolution it needs.
   */
  function columns(from, dir, length) {
    // 56 steps is the knee of the curve: a grazing chord of several hundred
    // kilometres is still integrated to well under a percent, and this runs a
    // few hundred times per retrace, so the constant matters. Written without
    // allocating a point per step, and with sqrt rather than hypot, because
    // profiling put nearly all of a 73 ms retrace right here.
    const steps = Math.max(6, Math.min(48, Math.round(length / (0.6 * HR))));
    const ds = length / steps;
    let colR = 0, colA = 0;
    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * ds;
      const x = from.x + dir.x * t;
      const y = from.y + dir.y * t;
      const h = Math.sqrt(x * x + y * y) - R;
      // The exponentials are written out rather than called through the
      // atmosphere object: this loop runs tens of thousands of times per
      // retrace, and the closure call was not being inlined.
      colR += h < 0 ? 1 : Math.exp(-h * invHR);
      colA += h < 0 ? 1 : Math.exp(-h * invHA);
    }
    return { colR: colR * ds, colA: colA * ds };
  }

  /**
   * Transmission of the path from P out to the star, or false if the planet is
   * in the way. That shadow test is how night, and the darkening from the bottom
   * up after sunset, appear without a line of special-case code.
   */
  /**
   * The sun leg is the expensive part of a trace, and in a spherically
   * symmetric atmosphere its column depends on only two numbers: how high the
   * point is, and the angle between the starlight and the local vertical there.
   * Quantising those two and memoising collapses the cost at high ray counts,
   * where hundreds of rays share a cell, while leaving the cheap cases alone.
   * The quantum is fine enough that the transmission varies by well under a
   * percent across a cell, which no drawn colour can show.
   */
  const sunCache = new Map();
  const altitudeQuantum = Math.max(1e-6, sunCacheScale * drawTopFor() / 150);

  /**
   * The 38 transmissions along the sun leg, or null if the point is in shadow.
   *
   * The whole spectrum is cached, not merely the columns: turning a column into
   * a transmission costs one exponential per wavelength, and doing that per ray
   * rather than per cell was the largest single cost in a trace at five
   * thousand rays. The returned array is shared and must not be written to.
   */
  function sunTransmission(P) {
    if (raySphere(P, toStar, R, false) != null) return null;
    const radius = Math.sqrt(P.x * P.x + P.y * P.y);
    const cosZenith = (P.x * toStar.x + P.y * toStar.y) / radius;
    // Two independent quantised coordinates packed into one integer key. The
    // cosine term is bounded by +/-400/scale, and the altitude term is spaced
    // wider than that range, so the two can never collide.
    const cosTerm = Math.round(cosZenith * 400 / sunCacheScale);
    const key = Math.round((radius - R) / altitudeQuantum) * (2000 / sunCacheScale)
      + cosTerm;
    const hit = sunCache.get(key);
    if (hit !== undefined) return hit;

    const path = marchSunColumns(P, cosZenith);
    const transmission = new Float64Array(SPECTRUM_BINS);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      transmission[i] = Math.exp(-(betaR[i] * path.colR + betaAext[i] * path.colA));
    }
    sunCache.set(key, transmission);
    return transmission;
  }

  function marchSunColumns(P, cosZenith) {
    let exit = raySphere(P, toStar, topR, true);
    if (exit != null) {
      // Stop integrating once the air has thinned past any relevance. Along a
      // path leaving at local zenith angle X the density falls with a
      // characteristic length H/cos(X), so twelve of those leaves under 1e-5 of
      // the column behind - while a grazing path, where cos(X) is small, keeps
      // its full length, which is exactly the case that matters.
      if (cosZenith > 0.02) exit = Math.min(exit, 12 * HR / cosZenith);
    }
    return exit == null ? { colR: 0, colA: 0 } : columns(P, toStar, exit);
  }



  /* ---- how much of this light is scattered at all ---- */

  const vertical = columns({ x: 0, y: R }, { x: 0, y: 1 }, atmosphere.topAltitude);
  let tauScatter = 0;
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    tauScatter += (source[i] / sourceTotal)
      * (betaR[i] * vertical.colR + betaAsca[i] * vertical.colA);
  }
  const scatteredFraction = 1 - Math.exp(-tauScatter);

  // Below this, scattering is a one-in-ten-thousand event: with a few hundred
  // drawn paths the honest count of scattering vertices is zero, and drawing any
  // would invent a sky on a world that has none. This is the airless case the
  // simulator exists to contrast, so it must not be fudged.
  const scatters = tauScatter > 1e-4;

  // Pedagogic proportions, not physical ones: in reality the unscattered light
  // outnumbers the scattered several times over, and drawing that faithfully
  // would leave too few arriving rays to read. The true fraction is returned in
  // the tally and stated in the panel instead.
  const nArriving = scatters ? Math.max(1, Math.round(count * 0.60)) : 0;
  const nMissed = scatters ? Math.max(1, Math.round(count * 0.28)) : 0;
  const nThrough = Math.max(1, count - nArriving - nMissed);

  const weights = new Float64Array(SPECTRUM_BINS);

  /** The tallest air worth drawing at this zoom. */
  const drawTop = drawTopFor();

  /** Sample an altitude from the density profile, between a floor and drawTop. */
  function sampleAltitude(floor) {
    const eFloor = Math.exp(-floor / HR);
    const eTop = Math.exp(-drawTop / HR);
    return -HR * Math.log(eFloor + rng() * (eTop - eFloor));
  }

  /** Walk from a point along a direction to the edge of the drawn frame. */
  function clipToFrame(from, dir, maxLength = Infinity) {
    let t = maxLength;
    const yTop = R + skyExtent_m;
    const yBottom = R + skyExtent_m - span_m;
    if (dir.y > 1e-9) t = Math.min(t, (yTop - from.y) / dir.y);
    else if (dir.y < -1e-9) t = Math.min(t, (from.y - yBottom) / -dir.y);
    if (Math.abs(dir.x) > 1e-9) {
      t = Math.min(t, (Math.sign(dir.x) * halfWidth_m - from.x) / dir.x);
    }
    if (!Number.isFinite(t) || t < 0) t = 0;
    return { x: from.x + dir.x * t, y: from.y + dir.y * t };
  }

  /* ---- 1. paths that arrive at the observer ---- */

  const observerAltitude = Math.max(0, observerZ);

  for (let n = 0; n < nArriving; n++) {
    const angle = (rng() * 2 - 1) * MAX_SKY_ANGLE_DEG * Math.PI / 180;
    // Line of sight in world coordinates. The observer sits on the x = 0 axis,
    // so its local "up" is +y and this is just a rotation of it.
    const d = { x: Math.sin(angle), y: Math.cos(angle) };

    // Keep the vertex a little way off the observer. Sampled straight from the
    // density, a good fraction land within a few hundred metres and collapse the
    // drawn ray to a dot.
    const floor = observerAltitude + drawTop * 0.045;
    const target = sampleAltitude(floor);
    if (!(target > observerAltitude)) continue;

    // Where the line of sight reaches that altitude. Closed form on the sphere,
    // so the vertex sits exactly on the drawn straight line.
    const reach = raySphere(observer, d, R + target, true);
    if (reach == null) continue;
    const maxAcross = Math.abs(d.x) > 1e-6 ? (halfWidth_m * 0.98) / Math.abs(d.x) : Infinity;
    const dist = Math.min(reach, maxAcross);
    if (!(dist > 0)) continue;
    const P = { x: observer.x + d.x * dist, y: observer.y + d.y * dist };

    const sunT = sunTransmission(P);
    if (!sunT) continue;                       // this parcel of air is in shadow

    // Deflection: the photon was travelling away from the star, and leaves
    // travelling along -d, from P back down to the observer.
    const cosTheta = Math.max(-1, Math.min(1, toStar.x * d.x + toStar.y * d.y));
    const h = altitudeOf(P);
    const rhoR = atmosphere.densityRayleigh(h);
    const rhoA = atmosphere.densityAerosol(h);
    const phaseR = rayleighPhase(cosTheta);
    const phaseA = henyeyGreensteinPhase(cosTheta, g);
    const back = columns(P, { x: -d.x, y: -d.y }, dist);

    let total = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const scatter = betaR[i] * rhoR * phaseR + betaAsca[i] * rhoA * phaseA;
      const tView = Math.exp(-(betaR[i] * back.colR + betaAext[i] * back.colA));
      const w = source[i] * scatter * sunT[i] * tView;
      weights[i] = w;
      total += w;
    }
    if (!(total > 0)) continue;
    const bin = sampleWeighted(weights, total, rng());
    const lambda = WAVELENGTHS_NM[bin];

    // The incoming leg is a stub, not the whole journey down from space. Drawn
    // full length, several hundred of them cross the entire frame at the solar
    // angle and scatter the colour everywhere except where it belongs; the
    // unscattered `through` rays already show that journey at full length. The
    // stub is clipped, never bent, so it stays a piece of the true straight ray.
    const entry = clipToFrame(P, toStar, halfWidth_m * ARRIVING_STUB);

    paths.push({
      kind: 'arriving',
      lambda, bin,
      weight: total,
      points: [entry, P, observer],
      // Signed direction the light arrives from, so the renderer can ask whether
      // this ray is inside the cone the observer is looking down.
      arrivalAngleRad: angle,
      events: [
        { type: 'enter', x: entry.x, y: entry.y, altitude: atmosphere.topAltitude, lambda },
        {
          type: 'scatter', x: P.x, y: P.y, altitude: h, lambda,
          species: 'rayleigh',
          angleDeg: Math.acos(cosTheta) * 180 / Math.PI,
        },
        {
          type: 'observed', x: observer.x, y: observer.y,
          altitude: observerAltitude, lambda,
        },
      ],
      outcome: 'observed',
      scatterCount: 1,
    });
  }

  /* ---- 2. paths that scatter but go somewhere else ---- */

  for (let n = 0; n < nMissed; n++) {
    const P = pointAtOffset((rng() * 2 - 1) * halfWidth_m, sampleAltitude(0));
    const sunT = sunTransmission(P);
    if (!sunT) continue;

    const h = altitudeOf(P);
    const rhoR = atmosphere.densityRayleigh(h);
    const rhoA = atmosphere.densityAerosol(h);
    const isRayleigh = rng() * (rhoR + rhoA) < rhoR || rhoA <= 0;

    // Which way does it leave? Draw the deflection from the real phase function,
    // then reject the small cone that would in fact reach the observer - those
    // paths belong to category 1 and are already drawn.
    let out = null;
    const toObs = { x: observer.x - P.x, y: observer.y - P.y };
    const obsLen = Math.hypot(toObs.x, toObs.y) || 1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const cosT = isRayleigh ? sampleRayleighCosine(rng) : sampleHenyeyGreensteinCosine(g, rng);
      const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
      const turn = rng() < 0.5 ? theta : -theta;
      const c = Math.cos(turn), s = Math.sin(turn);
      const inX = -toStar.x, inY = -toStar.y;
      const candidate = { x: inX * c - inY * s, y: inX * s + inY * c, cosTheta: cosT };
      const alignment = (candidate.x * toObs.x + candidate.y * toObs.y) / obsLen;
      if (alignment < Math.cos(0.12)) { out = candidate; break; }
    }
    if (!out) continue;

    // Wavelength weighted by how strongly each colour scatters here, with no aim
    // taken at the observer. Mostly blue, which is the point: the blue is being
    // taken out of the beam and thrown in every direction at once.
    const phase = isRayleigh ? rayleighPhase(out.cosTheta) : henyeyGreensteinPhase(out.cosTheta, g);
    let total = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const scatter = isRayleigh ? betaR[i] * rhoR * phase : betaAsca[i] * rhoA * phase;
      const w = source[i] * scatter * sunT[i];
      weights[i] = w;
      total += w;
    }
    if (!(total > 0)) continue;
    const bin = sampleWeighted(weights, total, rng());
    const lambda = WAVELENGTHS_NM[bin];

    // Both legs are stubs. A missed event is about the turn, not about where
    // that particular photon came from or ends up.
    const stub = halfWidth_m * 0.13;
    const entry = clipToFrame(P, toStar, stub);
    const end = clipToFrame(P, out, stub);

    paths.push({
      kind: 'missed',
      lambda, bin,
      weight: total,
      points: [entry, P, end],
      events: [
        { type: 'enter', x: entry.x, y: entry.y, altitude: altitudeOf(entry), lambda },
        {
          type: 'scatter', x: P.x, y: P.y, altitude: h, lambda,
          species: isRayleigh ? 'rayleigh' : 'aerosol',
          angleDeg: Math.acos(Math.max(-1, Math.min(1, out.cosTheta))) * 180 / Math.PI,
        },
        { type: 'missed', x: end.x, y: end.y, altitude: altitudeOf(end), lambda },
      ],
      outcome: 'missed',
      scatterCount: 1,
    });
  }

  /* ---- 3. light that crosses without being scattered at all ---- */

  for (let n = 0; n < nThrough; n++) {
    // Anchor the beam on a parcel of air that is actually in the picture, then
    // follow the line the starlight takes through it. Sampling the anchor from
    // the density puts the beams where the air is, which at a low Sun means a
    // long chord skimming the limb - the reason the light is red, drawn rather
    // than asserted.
    const anchor = pointAtOffset((rng() * 2 - 1) * halfWidth_m, sampleAltitude(0));
    const back = { x: -toStar.x, y: -toStar.y };

    const entryDist = raySphere(anchor, back, topR, true);
    if (entryDist == null) continue;
    const entry = { x: anchor.x + back.x * entryDist, y: anchor.y + back.y * entryDist };

    // Forward from the entry: stop at the ground if it gets there, otherwise at
    // the far side of the atmosphere.
    const ground = raySphere(entry, toStar, R, false);
    const exit = raySphere(entry, toStar, topR, true);
    const travel = ground != null ? ground : (exit ?? 0);
    if (!(travel > 0)) continue;
    const end = { x: entry.x + toStar.x * travel, y: entry.y + toStar.y * travel };

    // Beer-Lambert over the whole chord, so this bundle carries exactly the
    // reddening the spectrum panel plots for the direct beam.
    const path = columns(entry, toStar, travel);
    let total = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const w = source[i] * Math.exp(-(betaR[i] * path.colR + betaAext[i] * path.colA));
      weights[i] = w;
      total += w;
    }
    if (!(total > 0)) continue;
    const bin = sampleWeighted(weights, total, rng());
    const lambda = WAVELENGTHS_NM[bin];

    // Draw the part of that chord which is inside the frame: clipped from the
    // anchor in both directions, never bent, and never past the real endpoints.
    const drawnStart = clipToFrame(anchor, back, entryDist);
    const drawnEnd = clipToFrame(anchor, toStar, Math.max(0, travel - entryDist));

    paths.push({
      kind: 'through',
      lambda, bin,
      weight: total,
      pathLength: travel,
      points: [drawnStart, drawnEnd],
      events: [
        { type: 'enter', x: entry.x, y: entry.y, altitude: atmosphere.topAltitude, lambda },
        {
          type: ground != null ? 'ground' : 'escape',
          x: end.x, y: end.y, altitude: Math.max(0, altitudeOf(end)), lambda,
        },
      ],
      outcome: ground != null ? 'ground' : 'escape',
      scatterCount: 0,
    });
  }

  paths.scatteredFraction = scatteredFraction;
  return paths;
}

/**
 * Tally the drawn paths - how many of each kind, and how blue each family came
 * out. These are properties of the drawing. The percentages the panel quotes are
 * NOT taken from here: they are integrated straight off the spectra the engine
 * computed, which is exact and free of sampling noise. What this does carry that
 * the spectra do not is `scatteredFraction`, the true share of the light that is
 * scattered at all, which the picture deliberately over-represents.
 */
export function summarisePhotons(paths, options = {}) {
  const { source = null, splitNm = 520 } = options;
  const group = () => ({ total: 0, blue: 0 });
  const tally = {
    arriving: group(), missed: group(), through: group(),
    sourceBlueFraction: null,
    scatteredFraction: paths.scatteredFraction ?? null,
    blue: { total: 0, scattered: 0 },
    red: { total: 0, scattered: 0 },
  };

  for (const p of paths) {
    const isBlue = p.lambda < splitNm;
    const bucket = tally[p.kind];
    if (bucket) { bucket.total++; if (isBlue) bucket.blue++; }
    const legacy = isBlue ? tally.blue : tally.red;
    legacy.total++;
    if (p.scatterCount > 0) legacy.scattered++;
  }

  if (source) {
    let all = 0, blue = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      all += source[i];
      if (WAVELENGTHS_NM[i] < splitNm) blue += source[i];
    }
    tally.sourceBlueFraction = all > 0 ? blue / all : null;
  }

  return tally;
}

/**
 * Histogram of the drawn beams over the spectral grid, split into the light that
 * reaches the observer from the direction being looked at and everything else.
 *
 * This counts the simulated bundle itself rather than plotting the analytic
 * spectrum: it is what those few hundred rays on screen actually came out as,
 * and counting them is the point. When the star sinks, the bars visibly march
 * towards the red end, because that is what happens to the beams.
 *
 * @param {Array}  paths    traced paths
 * @param {number} axisRad  signed direction the observer is looking
 * @param {number} halfRad  half-angle of the viewing cone
 * @param {number} groupNm  width of one histogram bin, in nanometres
 */
export function histogramPhotons(paths, axisRad, halfRad, groupNm = 20) {
  const perBin = Math.max(1, Math.round(groupNm / 10));
  const bins = Math.ceil(SPECTRUM_BINS / perBin);
  const inCone = new Float64Array(bins);
  const other = new Float64Array(bins);
  const centres = new Float64Array(bins);

  for (let b = 0; b < bins; b++) {
    const first = b * perBin;
    const last = Math.min(SPECTRUM_BINS - 1, first + perBin - 1);
    centres[b] = (WAVELENGTHS_NM[first] + WAVELENGTHS_NM[last]) / 2;
  }

  let peak = 0, total = 0, sum = 0, coneTotal = 0, coneSum = 0, throughTotal = 0, throughSum = 0;
  for (const p of paths) {
    const b = Math.min(bins - 1, Math.floor(p.bin / perBin));
    const involved = p.kind === 'arriving'
      && Math.abs(p.arrivalAngleRad - axisRad) <= halfRad;
    if (involved) { inCone[b]++; coneTotal++; coneSum += p.lambda; } else other[b]++;
    if (p.kind === 'through') { throughTotal++; throughSum += p.lambda; }
    total++;
    sum += p.lambda;
  }
  for (let b = 0; b < bins; b++) peak = Math.max(peak, inCone[b] + other[b]);

  return {
    centres, inCone, other, peak, total,
    binWidthNm: perBin * 10,
    meanNm: total > 0 ? sum / total : null,
    coneMeanNm: coneTotal > 0 ? coneSum / coneTotal : null,
    throughMeanNm: throughTotal > 0 ? throughSum / throughTotal : null,
  };
}

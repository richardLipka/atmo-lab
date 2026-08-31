/**
 * The light paths drawn in the cross-section, built from the observer backwards.
 *
 * An earlier version launched photons from the star and let them wander. It was
 * faithful but unreadable: a few hundred random walks fill the picture, and
 * essentially none of them end at the eye, so the one thing a student needs to
 * see - WHY the light that arrives is blue - never appeared on screen.
 *
 * This module answers a sharper question instead. Every path drawn is one of
 * exactly three kinds, and the contrast between them is the whole lesson:
 *
 *   arriving  sunlight that came down, scattered once, and turned INTO the
 *             observer's eye. Its wavelength is drawn from the true
 *             single-scattering weight, so the arriving bundle really is blue
 *             for the reason the integrator says it is.
 *   missed    sunlight that scattered at some other point and left in some
 *             other direction. Same physics, same phase function - it simply
 *             is not aimed at you. These are the majority, and they are what
 *             makes the whole sky glow rather than just the patch you look at.
 *   through   light that crossed the entire atmosphere without being scattered
 *             at all and reached the ground. Overwhelmingly red, because the
 *             blue was removed into the other two categories.
 *
 * Each arriving path has exactly one scattering vertex, which is not a
 * simplification introduced here: it is precisely the single-scattering
 * approximation that physics/radiance.js integrates. The picture and the
 * numbers therefore describe the same model.
 *
 * Geometry is a flat slab whose density depends only on altitude. Over the
 * width of the picture the curvature of the planet is invisible, and the flat
 * slab makes the paths far easier to read. Colours and spectra always come
 * from the spherical integrator, never from here.
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
 * Column of an exponential slab along a straight path.
 *
 * ∫ρ ds from altitude y0 to altitude y1 along a ray whose vertical component is
 * dy has the closed form (H/|dy|)(e^(−y0/H) − e^(−y1/H)); for a horizontal ray
 * the density is constant along it, which is the |dy| → 0 limit handled
 * separately. Doing this analytically rather than by marching keeps a few
 * hundred paths cheap enough to retrace on every slider move.
 */
function slabColumn(y0, y1, dy, H) {
  if (Math.abs(dy) < 1e-6) return 0;
  return (H / Math.abs(dy)) * Math.abs(Math.exp(-y0 / H) - Math.exp(-y1 / H));
}

/**
 * Trace the light paths for the picture.
 *
 * @param {object} options
 *   atmosphere        an object from createAtmosphere
 *   source            top-of-atmosphere spectrum
 *   sunElevationDeg   elevation of the star above the horizon
 *   observerZ         observer altitude in metres (negative is handled by the
 *                     shaft view, which draws no paths)
 *   frameTop_m        top of the DRAWN region, which is lower than top_m: the
 *                     legs are clipped to it, never bent by it
 *   count             total number of paths to draw
 *   halfWidth_m       half the width of the drawn domain
 *   top_m             top of the drawn domain
 *   seed              generator seed
 */
export function tracePhotons(options) {
  const {
    atmosphere, source, sunElevationDeg, observerZ = 0,
    count, halfWidth_m, top_m, frameTop_m = top_m, seed = 12345,
  } = options;

  const paths = [];
  if (!(count > 0)) return paths;

  let sourceTotal = 0;
  for (let i = 0; i < SPECTRUM_BINS; i++) sourceTotal += source[i];
  if (!(sourceTotal > 0)) return paths;

  const rng = makeRng(seed);
  const elevation = sunElevationDeg * Math.PI / 180;
  // Unit vector pointing from any point in the picture towards the star.
  const toStar = { x: Math.cos(elevation), y: Math.sin(elevation) };

  const betaR = atmosphere.rayleighBeta0;
  const betaAext = atmosphere.aerosolExt0;
  const betaAsca = atmosphere.aerosolSca0;
  const g = atmosphere.asymmetryG;
  const HR = atmosphere.scaleHeightRayleigh;
  const HA = atmosphere.scaleHeightAerosol;

  const observer = { x: 0, y: Math.max(0, observerZ) };

  // How much of the light crossing this air is scattered at all? On Earth the
  // vertical scattering optical depth is about 0.115, so roughly a ninth of it.
  // The number is reported next to the picture, because the picture itself does
  // NOT draw the three families in their true proportion - see below.
  const colRvert = slabColumn(0, top_m, 1, HR);
  const colAvert = slabColumn(0, top_m, 1, HA);
  let tauScatter = 0;
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    tauScatter += (source[i] / sourceTotal)
      * (betaR[i] * colRvert + betaAsca[i] * colAvert);
  }
  const scatteredFraction = 1 - Math.exp(-tauScatter);

  // Below this, scattering is a one-in-ten-thousand event: with a few hundred
  // drawn paths the honest count of scattering vertices is zero, and drawing
  // any would invent a sky on a world that has none. This is the airless case
  // the simulator exists to contrast, so it must not be fudged.
  const NEGLIGIBLE_TAU = 1e-4;
  const scatters = tauScatter > NEGLIGIBLE_TAU;

  // Budget. These are pedagogic proportions, not physical ones: in reality the
  // unscattered light outnumbers the scattered by roughly eight to one, and
  // drawing that faithfully would leave too few arriving paths to read. The
  // true fraction is returned in the tally and stated in the panel instead.
  const nArriving = scatters ? Math.max(1, Math.round(count * 0.60)) : 0;
  const nMissed = scatters ? Math.max(1, Math.round(count * 0.28)) : 0;
  const nThrough = Math.max(1, count - nArriving - nMissed);

  const weights = new Float64Array(SPECTRUM_BINS);

  /**
   * Walk from a point along a direction until the edge of the drawn frame.
   * Clipping, not bending: the result is still a point on the same straight
   * ray, so the drawn line has the direction the physics gave it.
   */
  function clipToFrame(from, dir, maxLength = Infinity) {
    let t = maxLength;
    if (dir.y > 1e-9) t = Math.min(t, (frameTop_m - from.y) / dir.y);
    else if (dir.y < -1e-9) t = Math.min(t, from.y / -dir.y);
    if (Math.abs(dir.x) > 1e-9) {
      t = Math.min(t, (Math.sign(dir.x) * halfWidth_m - from.x) / dir.x);
    }
    if (!Number.isFinite(t) || t < 0) t = 0;
    return { x: from.x + dir.x * t, y: from.y + dir.y * t };
  }

  /** Transmission of the vertical-ish path from P out to space, towards the star. */
  function sunTransmission(bin, y) {
    if (toStar.y <= 0.01) return 0;        // the star is at or below the horizon
    const colR = slabColumn(y, top_m, toStar.y, HR);
    const colA = slabColumn(y, top_m, toStar.y, HA);
    return Math.exp(-(betaR[bin] * colR + betaAext[bin] * colA));
  }

  /**
   * Fill `weights` with the single-scattering contribution per wavelength for
   * light scattered at P through angle θ towards the observer, and return the
   * total. This is the same product the integrator forms; sampling wavelengths
   * from it is what makes the drawn bundle blue rather than merely coloured
   * blue.
   */
  function scatterWeights(P, cosTheta, viewDist, viewDy, toObserver) {
    const rhoR = atmosphere.densityRayleigh(P.y);
    const rhoA = atmosphere.densityAerosol(P.y);
    const phaseR = rayleighPhase(cosTheta);
    const phaseA = henyeyGreensteinPhase(cosTheta, g);
    // Path back down (or up) to the observer.
    const colR = toObserver
      ? slabColumn(P.y, observer.y, viewDy, HR)
      : slabColumn(P.y, top_m, viewDy, HR);
    const colA = toObserver
      ? slabColumn(P.y, observer.y, viewDy, HA)
      : slabColumn(P.y, top_m, viewDy, HA);
    let total = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const scatter = betaR[i] * rhoR * phaseR + betaAsca[i] * rhoA * phaseA;
      const tView = Math.exp(-(betaR[i] * colR + betaAext[i] * colA));
      const w = source[i] * scatter * sunTransmission(i, P.y) * tView;
      weights[i] = w;
      total += w;
    }
    return total;
  }

  /* ---- 1. paths that arrive at the observer ---- */

  // Sampled uniformly over the sky and deliberately independent of where the
  // observer is looking. Turning the view must not reshuffle the picture: the
  // scattering events are a property of the air and the star, not of the
  // direction someone happens to face. The renderer decides at draw time which
  // of these rays fall inside the current viewing cone and colours only those.
  for (let n = 0; n < nArriving; n++) {
    const angle = (rng() * 2 - 1) * MAX_SKY_ANGLE_DEG * Math.PI / 180;
    const d = { x: Math.sin(angle), y: Math.cos(angle) };
    if (d.y <= 0.02) continue;

    // How far up the view ray did the scattering happen? Sample the depth from
    // the density profile itself, so vertices cluster in the dense air near the
    // ground exactly as the real scattering does. The draw is truncated at the
    // top of the frame, which for Earth leaves out under 2 % of the column.
    // Keep the vertex a little way off the observer. Sampled straight from the
    // density, a good fraction of them land within a few hundred metres and
    // collapse the drawn ray to a dot; the floor costs a sliver of the lowest
    // air and is the difference between a readable fan and a smudge.
    const floor = observer.y + (frameTop_m - observer.y) * 0.045;
    const eTop = Math.exp(-frameTop_m / HR);
    const eFloor = Math.exp(-floor / HR);
    const yScatter = -HR * Math.log(eFloor + rng() * (eTop - eFloor));
    // Shorten the ray rather than discarding it when the vertex would fall off
    // the side of the picture: dropping those paths thinned the sky at exactly
    // the shallow angles where it is most visible.
    const maxDist = Math.abs(d.x) > 1e-6
      ? (halfWidth_m * 0.98) / Math.abs(d.x) : Infinity;
    const dist = Math.min((yScatter - observer.y) / d.y, maxDist);
    if (!(dist > 0)) continue;
    const P = { x: observer.x + d.x * dist, y: observer.y + d.y * dist };

    // Deflection: the photon was travelling away from the star, and leaves
    // travelling along −d (from P down to the observer).
    const outX = -d.x, outY = -d.y;
    const inX = -toStar.x, inY = -toStar.y;
    const cosTheta = Math.max(-1, Math.min(1, inX * outX + inY * outY));

    const total = scatterWeights(P, cosTheta, dist, d.y, true);
    if (!(total > 0)) continue;
    const bin = sampleWeighted(weights, total, rng());
    const lambda = WAVELENGTHS_NM[bin];

    // The incoming leg is a stub, not the whole journey down from space.
    // Drawn full length, several hundred of them cross the entire frame at the
    // solar angle and scatter the colour everywhere except the cone it is
    // supposed to mark. The unscattered `through` rays already show where the
    // sunlight comes from, at full length and in the same direction; this leg
    // only has to say that THIS photon came from there too. It is clipped,
    // never bent, so it stays a piece of the true straight ray, and the event
    // still records the altitude at which the photon entered the atmosphere.
    const entry = clipToFrame(P, toStar, halfWidth_m * ARRIVING_STUB);

    paths.push({
      kind: 'arriving',
      lambda, bin,
      weight: total,
      points: [entry, P, observer],
      // Signed in-plane direction the light arrives from, so the renderer can
      // ask whether this ray is inside the cone the observer is looking down.
      arrivalAngleRad: angle,
      events: [
        { type: 'enter', x: entry.x, y: entry.y, altitude: top_m, lambda },
        {
          type: 'scatter', x: P.x, y: P.y, altitude: P.y, lambda,
          species: 'rayleigh',
          angleDeg: Math.acos(cosTheta) * 180 / Math.PI,
        },
        { type: 'observed', x: observer.x, y: observer.y, altitude: observer.y, lambda },
      ],
      outcome: 'observed',
      scatterCount: 1,
    });
  }

  /* ---- 2. paths that scatter but go somewhere else ---- */

  for (let n = 0; n < nMissed; n++) {
    const x = (rng() * 2 - 1) * halfWidth_m;
    // Altitude drawn from the density profile: this is where scattering really
    // happens, so the drawn events crowd the lower air on their own.
    const y = Math.min(frameTop_m * 0.98, -HR * Math.log(Math.max(1e-9, rng())));
    const P = { x, y };

    const rhoR = atmosphere.densityRayleigh(y);
    const rhoA = atmosphere.densityAerosol(y);

    // Which way does it leave? Draw the deflection from the real phase
    // function, then reject the small cone that would in fact reach the
    // observer - those paths belong to category 1 and are already drawn.
    const isRayleigh = rng() * (rhoR + rhoA) < rhoR || rhoA <= 0;
    let out = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      const cosT = isRayleigh ? sampleRayleighCosine(rng) : sampleHenyeyGreensteinCosine(g, rng);
      const theta = Math.acos(Math.max(-1, Math.min(1, cosT)));
      const turn = rng() < 0.5 ? theta : -theta;
      const inX = -toStar.x, inY = -toStar.y;
      const c = Math.cos(turn), s = Math.sin(turn);
      const candidate = { x: inX * c - inY * s, y: inX * s + inY * c, cosTheta: cosT };
      const towards = { x: observer.x - P.x, y: observer.y - P.y };
      const len = Math.hypot(towards.x, towards.y) || 1;
      const alignment = (candidate.x * towards.x + candidate.y * towards.y) / len;
      if (alignment < Math.cos(0.12)) { out = candidate; break; }   // misses the eye
    }
    if (!out) continue;

    // Wavelength: weighted by how strongly each colour scatters here, with no
    // aim taken at the observer. Mostly blue, which is the point - the blue is
    // being taken out of the beam and thrown in every direction at once.
    let total = 0;
    const phase = isRayleigh ? rayleighPhase(out.cosTheta) : henyeyGreensteinPhase(out.cosTheta, g);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const scatter = isRayleigh ? betaR[i] * rhoR * phase : betaAsca[i] * rhoA * phase;
      const w = source[i] * scatter * sunTransmission(i, y);
      weights[i] = w;
      total += w;
    }
    if (!(total > 0)) continue;
    const bin = sampleWeighted(weights, total, rng());
    const lambda = WAVELENGTHS_NM[bin];

    // Both legs are drawn as short stubs. A missed event is about the turn, not
    // about where that particular photon came from or ends up, and full-length
    // legs on several hundred of them buried the arriving paths - which was the
    // exact failure of the previous version of this picture.
    const clip = (dx, dy, wanted) => {
      let t = wanted;
      if (dy < 0) t = Math.min(t, P.y / -dy);
      else if (dy > 0) t = Math.min(t, (frameTop_m - P.y) / dy);
      if (Math.abs(dx) > 1e-9) {
        t = Math.min(t, (Math.sign(dx) * halfWidth_m * 1.02 - P.x) / dx);
      }
      return Math.max(0, t);
    };
    const inStub = clip(toStar.x, toStar.y, halfWidth_m * 0.13);
    const outStub = clip(out.x, out.y, halfWidth_m * 0.13);
    const entry = { x: P.x + toStar.x * inStub, y: P.y + toStar.y * inStub };
    const end = { x: P.x + out.x * outStub, y: P.y + out.y * outStub };

    paths.push({
      kind: 'missed',
      lambda, bin,
      weight: total,
      points: [entry, P, end],
      events: [
        { type: 'enter', x: entry.x, y: entry.y, altitude: entry.y, lambda },
        {
          type: 'scatter', x: P.x, y: P.y, altitude: P.y, lambda,
          species: isRayleigh ? 'rayleigh' : 'aerosol',
          angleDeg: Math.acos(Math.max(-1, Math.min(1, out.cosTheta))) * 180 / Math.PI,
        },
        { type: 'missed', x: end.x, y: end.y, altitude: end.y, lambda },
      ],
      outcome: 'missed',
      scatterCount: 1,
    });
  }

  /* ---- 3. light that crosses without being scattered at all ---- */

  for (let n = 0; n < nThrough; n++) {
    const aim = (rng() * 2 - 1) * halfWidth_m * 0.94;
    const entry = clipToFrame({ x: aim, y: 0 }, toStar);

    // Survival is Beer-Lambert along the whole slant path, so this bundle is
    // reddened by exactly the transmittance the spectrum panel plots.
    const colR = slabColumn(0, top_m, toStar.y, HR);
    const colA = slabColumn(0, top_m, toStar.y, HA);
    let total = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const w = source[i] * Math.exp(-(betaR[i] * colR + betaAext[i] * colA));
      weights[i] = w;
      total += w;
    }
    if (!(total > 0)) continue;
    const bin = sampleWeighted(weights, total, rng());
    const lambda = WAVELENGTHS_NM[bin];

    paths.push({
      kind: 'through',
      lambda, bin,
      weight: total,
      points: [entry, { x: aim, y: 0 }],
      events: [
        { type: 'enter', x: entry.x, y: entry.y, altitude: top_m, lambda },
        { type: 'ground', x: aim, y: 0, altitude: 0, lambda },
      ],
      outcome: 'ground',
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
 * computed, which is exact and free of sampling noise. What this does carry
 * that the spectra do not is `scatteredFraction`, the true share of the light
 * that is scattered at all, which the picture deliberately over-represents.
 */
export function summarisePhotons(paths, options = {}) {
  const { source = null, splitNm = 520 } = options;
  const group = () => ({ total: 0, blue: 0 });
  const tally = {
    arriving: group(), missed: group(), through: group(),
    sourceBlueFraction: null,
    // The true share of the light that is scattered at all, straight from the
    // optical depth - unlike the counts above, which follow a drawing budget.
    scatteredFraction: paths.scatteredFraction ?? null,
    // Kept for anything still reading the old shape.
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

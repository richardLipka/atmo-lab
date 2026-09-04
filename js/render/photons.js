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

import {
  SPECTRUM_BINS, WAVELENGTHS_NM, BAND_OF_BIN, RAY_BANDS, RAY_BAND_COUNT,
} from '../physics/spectrum.js';
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

/**
 * How many of the arriving rays are worth drawing, and which ones.
 *
 * One rule, in one place, used by the picture and by the caption that invites
 * you to count what the picture shows. The share is the fraction of the air
 * still above the observer (see paths.columnFraction): light only reaches you
 * from a direction if air in that direction turned it towards you, so with a
 * tenth of the atmosphere left overhead there are a tenth as many rays, and -
 * the sky being optically thin - a tenth of the brightness. Rays and colour
 * fall together, by the same factor, for the same reason.
 *
 * The survivors are chosen by a fixed hash of the ray's index rather than by a
 * counter or a prefix, so that the set at 20 km is a subset of the set at 10 km
 * instead of a fresh draw: climbing thins the fan smoothly rather than making
 * it flicker.
 */
export function drawnRayShare(paths) {
  const fraction = paths && paths.columnFraction != null ? paths.columnFraction : 1;
  return Math.max(0, Math.min(1, fraction));
}

export function isRayDrawn(index, share) {
  if (share >= 1) return true;
  if (!(share > 0)) return false;
  return (((index * 2654435761) >>> 0) / 4294967296) < share;
}

/** How far from the zenith arriving rays are sampled, short of the horizon. */
const MAX_SKY_ANGLE_DEG = 85;

/**
 * How many parallel lines stand for the star's direct beam.
 *
 * A drawing decision, and the only place in the picture where the number of
 * lines is not the amount of light. It cannot be: see the note where they are
 * built.
 */
const DIRECT_BUNDLE = 9;

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

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));

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
 *   observerZ         observer altitude in metres, negative inside a shaft
 *   well              { enabled, radius_m, depth_m }, or null
 *   count             how many paths to draw
 *   span_m            vertical extent of the drawn frame, in metres
 *   halfWidth_m       half its horizontal extent
 *   skyExtent_m       how far above the observer's ground point the frame reaches
 *   seed              generator seed
 */
export function tracePhotons(options) {
  const {
    atmosphere, source, sunElevationDeg, observerZ = 0,
    well = null,
    count, span_m, halfWidth_m, skyExtent_m, seed = 12345,
    // The star's apparent size, which is what turns its irradiance into a
    // radiance and so decides how much brighter its disc is than the sky
    // beside it. The Sun's 0.2665 degrees is the default.
    starAngularRadiusDeg = 0.2665,
    // How the drawn paths are shared out between the families. These change
    // the PICTURE and nothing else: the measurement divides the light it
    // collects by the number of directions it looked in, so tracing half as
    // many arriving rays halves both and leaves the answer where it was. The
    // test suite pins that invariance.
    mix = null,
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

  // Altitude of the lowest air: inside a shaft the observer is below the
  // surface, but the air still begins at the surface, because the shaft is a
  // hole in the ground rather than a hole in the atmosphere.
  const observerAltitude = Math.max(0, observerZ);
  const observer = { x: 0, y: R + observerZ };

  const shaft = well && well.enabled && observerZ < 0
    ? { radius: well.radius_m, depth: -observerZ }
    : null;

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

  /**
   * How the drawn paths are shared out, and why the default is not the truth.
   *
   * `scatterShare` is the fraction of drawn paths that are scattering events at
   * all; `arrivingShare` is the fraction of those aimed at the observer. The
   * defaults, 0.88 and 0.68, are pedagogic: in reality only about a sixth of
   * the light crossing the air is scattered at any wavelength, so a faithful
   * budget leaves five arriving rays out of six hundred and nothing to look at.
   *
   * Turn `physical` on and the budget becomes the honest one - `scatterShare`
   * is replaced by the fraction of the incident light this atmosphere actually
   * scatters, integrated over the source spectrum, and the picture fills with
   * the unscattered beams that really do dominate it. That switch is the
   * clearest statement the tool can make about its own exaggeration: it shows
   * you what it has been leaving out.
   *
   * None of this touches the measurement. See the note on `mix` above.
   */
  const scatterShare = mix && mix.physical ? scatteredFraction
    : clamp01(mix && mix.scatterShare != null ? mix.scatterShare : 0.88);
  const arrivingShare = clamp01(
    mix && mix.arrivingShare != null ? mix.arrivingShare : 0.6818);

  const scatteredPaths = scatters ? Math.round(count * scatterShare) : 0;
  const nArriving = scatters ? Math.max(1, Math.round(scatteredPaths * arrivingShare)) : 0;
  const nMissed = scatters ? Math.max(0, scatteredPaths - nArriving) : 0;
  const nThrough = Math.max(1, count - nArriving - nMissed);

  const weights = new Float64Array(SPECTRUM_BINS);

  /**
   * Every arriving ray's full spectral contribution, packed end to end in one
   * allocation.
   *
   * A ray is DRAWN in one colour, sampled from its own spectrum, because that is
   * what a photon does. But measuring the sky from those sampled colours alone
   * throws away most of what each ray knows and leaves the estimate visibly
   * noisy with only a few dozen rays in the cone. So the sampled wavelength is
   * kept for the picture and the whole spectrum is kept for the measurement.
   */
  const arrivingSpectra = new Float64Array(Math.max(1, nArriving) * SPECTRUM_BINS);
  let arrivingCount = 0;

  /**
   * Every direction the observer looked in, recorded before anything is allowed
   * to stop it.
   *
   * This is what makes the measurement a measurement rather than an average of
   * the survivors. A direction that ends in rock, or in air the planet's own
   * shadow has already darkened, delivers nothing - and nothing is a number. If
   * only the rays that got through were averaged, a well with one ray coming in
   * would report the same sky as open ground with three hundred, which is the
   * complaint this answers. Dividing the light collected by the directions
   * looked in, rather than by the directions that paid out, is the difference
   * between "how bright is that patch of sky" and "how bright is it here".
   */
  const castAngles = new Float64Array(Math.max(1, nArriving));
  let castCount = 0;

  /** The tallest air worth drawing at this zoom. */
  const drawTop = drawTopFor();

  /**
   * Sample an altitude from the density profile, between a floor and a ceiling.
   *
   * Two callers with different needs. The arriving rays are a measurement, so
   * they sample the whole column above the observer and `columnScale` below is
   * the normalising constant of that distribution. The decorative families only
   * have to be somewhere visible, so they stop at the top of the frame.
   */
  function sampleAltitude(floor = observerAltitude, ceiling = atmosphere.topAltitude) {
    const eFloor = Math.exp(-floor / HR);
    const eTop = Math.exp(-ceiling / HR);
    return -HR * Math.log(eFloor + rng() * (eTop - eFloor));
  }

  /**
   * Integral of the density over the sampled altitude range: the constant that
   * turns one importance-sampled point into an estimate of the whole column.
   */
  const columnScale = HR * (Math.exp(-observerAltitude / HR)
    - Math.exp(-atmosphere.topAltitude / HR));

  /** The same integral for an observer standing on the ground, as a reference. */
  const surfaceColumnScale = HR * (1 - Math.exp(-atmosphere.topAltitude / HR));

  /**
   * How far a ray gets before it meets the ground.
   *
   * Written out rather than reusing raySphere because the case that matters is
   * the one that function cannot answer: a scattering event AT the surface,
   * leaving in a downward direction. Both roots are then zero to within
   * rounding, and a ray that starts on the ground pointing into it travels no
   * distance at all.
   */
  function groundLimit(from, dir) {
    const b = from.x * dir.x + from.y * dir.y;
    const radius = Math.sqrt(from.x * from.x + from.y * from.y);
    if (radius - R <= 0.5) return b < 0 ? 0 : Infinity;
    const c = radius * radius - R * R;
    const disc = b * b - c;
    if (disc < 0) return Infinity;
    const t = -b - Math.sqrt(disc);
    return t > 0 ? t : Infinity;
  }

  /**
   * Walk from a point along a direction to the edge of the drawn frame, or to
   * the ground, whichever comes first. Light does not travel through rock, so
   * nothing is ever drawn below the surface - which at a wide zoom is a large
   * part of the picture, and used to collect the stubs of everything scattered
   * downwards near the limb.
   */
  function clipToFrame(from, dir, maxLength = Infinity) {
    let t = Math.min(maxLength, groundLimit(from, dir));
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

  for (let n = 0; n < nArriving; n++) {
    const angle = (rng() * 2 - 1) * MAX_SKY_ANGLE_DEG * Math.PI / 180;
    castAngles[castCount++] = angle;
    // Line of sight in world coordinates. The observer sits on the x = 0 axis,
    // so its local "up" is +y and this is just a rotation of it.
    const d = { x: Math.sin(angle), y: Math.cos(angle) };

    // Inside a shaft, the wall decides first. A direction steeper than
    // arctan(R/depth) runs into rock before it reaches the mouth, and no
    // amount of air above changes that - so the ray is recorded as stopped at
    // the wall, carries nothing, and never becomes a scattering path at all.
    if (shaft && Math.abs(Math.tan(angle)) * shaft.depth > shaft.radius) {
      const along = shaft.radius / Math.max(1e-9, Math.abs(d.x));
      const hit = { x: observer.x + d.x * along, y: observer.y + d.y * along };
      paths.push({
        kind: 'blocked',
        lambda: 550, bin: 17, band: BAND_OF_BIN[17],
        weight: 0, radiance: 0,
        arrivalAngleRad: angle,
        points: [hit, observer],
        events: [
          {
            type: 'wall', x: hit.x, y: hit.y, altitude: altitudeOf(hit),
            lambda: 550, angleDeg: Math.abs(angle) * 180 / Math.PI,
          },
        ],
        outcome: 'wall',
        scatterCount: 0,
      });
      continue;
    }

    // The scattering altitude is drawn from the density profile over the WHOLE
    // column above the observer, not just the part inside the drawn frame.
    // Sampling only what is on screen would bias the estimate below by whatever
    // fraction of the air the current zoom happens to exclude, and at a close
    // zoom that is most of it. Points off the frame still count; only their
    // drawing is clipped.
    const target = sampleAltitude();
    if (!(target > observerAltitude)) continue;

    // Where the line of sight reaches that altitude. Closed form on the sphere,
    // so the vertex sits exactly on the drawn straight line.
    const dist = raySphere(observer, d, R + target, true);
    if (dist == null || !(dist > 0)) continue;
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
    // The column back to the observer stops at the surface: with the shaft
    // treated as empty, the metres between the mouth and the observer are not
    // air and must not be integrated as if they were.
    const mouth = shaft ? raySphere(observer, d, R, true) : null;
    const airStart = mouth != null && mouth > 0 ? mouth : 0;
    const back = columns(P, { x: -d.x, y: -d.y }, Math.max(0, dist - airStart));

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
    // The colour this ray is drawn in. The bin was drawn in proportion to the
    // ray's own spectrum, so the bands come out in the ratio the spectrum
    // holds: count the violet rays against the red ones and you have read the
    // spectrum off the picture.
    const band = BAND_OF_BIN[bin];

    // Turn this sample into an estimate of the whole integral along the ray.
    //
    // The altitude was drawn with probability proportional to the density, so
    // the density in the integrand cancels against the one in the sampling
    // distribution and what is left is Z / (rho * |dh/ds|) - importance
    // sampling that is exact for an exponential atmosphere. |dh/ds| is the
    // cosine between the ray and the local vertical, which is why a ray near
    // the horizon carries so much more: it crosses far more air per metre of
    // altitude gained. It is floored, because at the horizon itself the
    // spherical geometry, not this factor, sets the path length.
    const cosLocal = Math.max(0.02, (d.x * P.x + d.y * P.y) / (R + h));
    const estimator = columnScale / (rhoR * cosLocal);

    // Now the drawing, which is a separate concern from the measurement above.
    // A vertex can legitimately sit above or beside the frame - at a close zoom
    // most of the column does - and such a ray is drawn as a line entering from
    // the edge, with no vertex marker, because its turn happened out of shot.
    const exit = clipToFrame(observer, d);
    const offFrame = Math.hypot(exit.x - observer.x, exit.y - observer.y) < dist - 1;
    const vertex = offFrame ? exit : P;

    // The incoming leg is a stub, not the whole journey down from space. Drawn
    // full length, several hundred of them cross the entire frame at the solar
    // angle and scatter the colour everywhere except where it belongs; the
    // unscattered `through` rays already show that journey at full length. The
    // stub is clipped, never bent, so it stays a piece of the true straight ray.
    const entry = clipToFrame(P, toStar, halfWidth_m * ARRIVING_STUB);
    const drawn = offFrame ? [vertex, observer] : [entry, P, observer];

    const spectrumOffset = arrivingCount * SPECTRUM_BINS;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      arrivingSpectra[spectrumOffset + i] = weights[i] * estimator;
    }
    arrivingCount++;

    paths.push({
      kind: 'arriving',
      lambda, bin, band,
      weight: total,
      spectrumOffset,
      // An unbiased single-sample estimate of this ray's contribution to the
      // radiance, in the same units the integrator reports. Depositing it in
      // the sampled bin estimates the spectrum, because the bin was drawn in
      // proportion to that spectrum.
      radiance: total * estimator,
      offFrame,
      points: drawn,
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
    const P = pointAtOffset((rng() * 2 - 1) * halfWidth_m, sampleAltitude(0, drawTop));
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
    const band = BAND_OF_BIN[bin];

    // Both legs are stubs. A missed event is about the turn, not about where
    // that particular photon came from or ends up.
    const stub = halfWidth_m * 0.13;
    const entry = clipToFrame(P, toStar, stub);
    const end = clipToFrame(P, out, stub);

    paths.push({
      kind: 'missed',
      lambda, bin, band,
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
    const anchor = pointAtOffset((rng() * 2 - 1) * halfWidth_m, sampleAltitude(0, drawTop));
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
    const band = BAND_OF_BIN[bin];

    // Draw the part of that chord which is inside the frame: clipped from the
    // anchor in both directions, never bent, and never past the real endpoints.
    const drawnStart = clipToFrame(anchor, back, entryDist);
    const drawnEnd = clipToFrame(anchor, toStar, Math.max(0, travel - entryDist));

    paths.push({
      kind: 'through',
      lambda, bin, band,
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

  /* ---- 4. the star's own beam, as THIS observer receives it ---- */

  /**
   * The direct beam is not sampled, because there is nothing to sample: one
   * star, one direction, one chord. It is marched with the same integrator the
   * scattered paths use, through the same air, stopped by the same rock - so it
   * belongs to the trace and not to the theory beside it, and the interface can
   * show a star colour without leaving the simulation.
   *
   * Two ways to lose it, and they are different facts. Below the horizon the
   * planet is in the way; down a shaft the wall can take a star that is well up
   * in the sky, which is why a deep enough well shows only a few minutes of Sun
   * a day.
   */
  paths.observerBeam = (() => {
    const transmittance = new Float64Array(SPECTRUM_BINS);
    const spectrum = new Float64Array(SPECTRUM_BINS);
    // Not raySphere: an observer standing ON the surface is the degenerate case
    // that function cannot answer, both its roots being zero to within rounding.
    // groundLimit already knows how to read that - a star below the local
    // horizon is simply one whose line to you passes through the planet.
    const belowHorizon = Number.isFinite(groundLimit(observer, toStar));
    // The star's angle from the observer's local vertical, which is the only
    // thing the shaft wall cares about.
    const starAngle = Math.atan2(toStar.x, toStar.y);
    const blockedByWall = shaft != null
      && Math.abs(Math.tan(starAngle)) * shaft.depth > shaft.radius;

    const exit = raySphere(observer, toStar, topR, true);
    // Inside a shaft the metres between the observer and the mouth are rock and
    // empty air, not atmosphere, so the column starts where the hole ends.
    const mouth = shaft ? raySphere(observer, toStar, R, true) : null;
    const airStart = mouth != null && mouth > 0 ? mouth : 0;
    const length = exit != null ? Math.max(0, exit - airStart) : 0;
    const from = {
      x: observer.x + toStar.x * airStart,
      y: observer.y + toStar.y * airStart,
    };
    const path = length > 0 ? columns(from, toStar, length) : { colR: 0, colA: 0 };

    const visible = !belowHorizon && !blockedByWall;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      transmittance[i] = Math.exp(-(betaR[i] * path.colR + betaAext[i] * path.colA));
      spectrum[i] = visible ? source[i] * transmittance[i] : 0;
    }
    // The disc's radiance: irradiance spread over the solid angle it covers.
    // This is the number that makes the drawn bundle a lie of scale and says by
    // how much - the Sun's disc runs to some hundreds of thousands of times the
    // radiance of the sky next to it.
    const starSolidAngle = 2 * Math.PI
      * (1 - Math.cos(starAngularRadiusDeg * Math.PI / 180));
    const radiance = new Float64Array(SPECTRUM_BINS);
    if (starSolidAngle > 0) {
      for (let i = 0; i < SPECTRUM_BINS; i++) radiance[i] = spectrum[i] / starSolidAngle;
    }
    // What the beam delivers to anything the wall is NOT shading - the mouth of
    // the shaft, and the rock down as far as the star can reach. `spectrum` is
    // zeroed when the wall takes the beam from the observer, which is a fact
    // about the observer at the bottom and not about the shaft as a whole.
    const unblocked = new Float64Array(SPECTRUM_BINS);
    if (!belowHorizon) {
      for (let i = 0; i < SPECTRUM_BINS; i++) unblocked[i] = source[i] * transmittance[i];
    }
    return {
      spectrum, transmittance, radiance, starSolidAngle, unblocked,
      visible, belowHorizon, blockedByWall,
      pathLength: length,
    };
  })();

  /** Where the star sits, as an angle from the observer's local vertical. */
  paths.starAngleRad = Math.atan2(toStar.x, toStar.y);

  /**
   * How much of the air is still above the observer, as a share of the whole
   * column from the surface.
   *
   * This is the one number that says how many rays there ought to be. Light
   * only reaches you from a direction if something in that direction turned it
   * towards you, and what does the turning is air: an observer with a tenth of
   * the atmosphere left overhead is looked at by a tenth as many scattering
   * events, and sees a tenth of the sky brightness. In the optically thin case
   * - which is the whole visible sky, since the vertical optical depth is well
   * under one - radiance is proportional to this column, so the count of rays
   * and the brightness fall together and by the same factor.
   *
   * The renderer draws this share of the arriving rays. That is not a display
   * heuristic dressed up: it is the physical chance that the direction has
   * anything to give, and a well multiplies it by a second, independent count -
   * how many directions the rock leaves open. Fewer rays for both reasons, one
   * rule, and the swatch follows the rays rather than the rays following the
   * swatch.
   */
  paths.columnFraction = surfaceColumnScale > 0
    ? Math.min(1, columnScale / surfaceColumnScale) : 1;

  /* ---- 5. the beam that comes straight from the star into the eye ---- */

  /**
   * Light that crossed the whole atmosphere without being turned once, and
   * landed on the observer.
   *
   * This was missing, and its absence said something false: point the view at
   * the star and every ray in the cone had scattered somewhere, as though
   * nothing ever arrives in a straight line. The overwhelming majority of what
   * reaches an observer looking at the Sun has never been scattered at all.
   *
   * It is drawn as a narrow bundle of parallel lines rather than one, because
   * that is what a collimated beam looks like and because one line reads as one
   * ray - and one ray is the wrong impression by four orders of magnitude. The
   * bundle is NOT to scale and cannot be: the beam's irradiance is thousands of
   * times the whole sky's, and honouring the count-is-brightness rule here
   * would need a hundred thousand lines. The number is stated in the panel
   * instead, which is the only place it fits.
   *
   * Each line takes a band sampled from the beam's own spectrum, so the bundle
   * reddens as the star sinks in the same eight colours as everything else.
   */
  const beam = paths.observerBeam;
  if (beam.visible && count > 0) {
    const starAngle = Math.atan2(toStar.x, toStar.y);
    let beamTotal = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      weights[i] = beam.spectrum[i];
      beamTotal += weights[i];
    }
    // Perpendicular to the beam, for the width of the bundle.
    const across = { x: -toStar.y, y: toStar.x };
    const width = halfWidth_m * 0.007;
    for (let n = 0; n < DIRECT_BUNDLE; n++) {
      const offset = (n - (DIRECT_BUNDLE - 1) / 2) * width;
      const through = {
        x: observer.x + across.x * offset,
        y: observer.y + across.y * offset,
      };
      // Upstream first, to the edge of the frame, then back down the line the
      // light actually travels. Stopping at whichever comes first - the
      // observer, or the ground - is what keeps the outer lines of the bundle
      // out of the rock: an observer standing on the surface has neighbours
      // whose share of the beam lands on the ground beside them, not below it.
      const from = clipToFrame(through, toStar);
      const back = { x: -toStar.x, y: -toStar.y };
      const reach = Math.min(
        Math.hypot(from.x - through.x, from.y - through.y),
        groundLimit(from, back));
      const eye = {
        x: from.x + back.x * reach,
        y: from.y + back.y * reach,
      };
      const bin = beamTotal > 0 ? sampleWeighted(weights, beamTotal, rng()) : 17;
      paths.push({
        kind: 'direct',
        lambda: WAVELENGTHS_NM[bin], bin, band: BAND_OF_BIN[bin],
        weight: beamTotal,
        pathLength: beam.pathLength,
        // The bundle is a drawing; every line of it stands for the same one
        // direction, which is the star's.
        arrivalAngleRad: starAngle,
        points: [from, eye],
        events: [
          {
            type: 'enter', x: from.x, y: from.y,
            altitude: altitudeOf(from), lambda: WAVELENGTHS_NM[bin],
          },
          {
            type: 'observed', x: eye.x, y: eye.y,
            altitude: observerAltitude, lambda: WAVELENGTHS_NM[bin],
          },
        ],
        outcome: 'observed',
        scatterCount: 0,
      });
    }
  }

  paths.scatterShare = scatterShare;
  paths.arrivingShare = arrivingShare;
  paths.scatteredFraction = scatteredFraction;
  paths.arrivingSpectra = arrivingSpectra;
  paths.castAngles = castAngles.subarray(0, castCount);
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
 * What an observer facing one way sees, measured from the rays.
 *
 * THE one definition. The colour swatch calls it once, for the direction the
 * observer is facing; the strip under the cross-section calls it once per
 * direction, all the way round. They used to be two functions answering two
 * subtly different questions - the swatch divided by every direction it looked
 * in, the strip only by the ones that had sky - so at the bottom of a shaft the
 * swatch went nearly black while the strip below it still showed a bright band.
 * Both were defensible; having both was not.
 *
 * Two things set the answer, and both come off the picture:
 *
 *   WHICH COLOURS - the mix of the eight bands arriving from inside the cone.
 *
 *   HOW MANY - the light collected divided by the sky the cone covers, counting
 *     the directions that end in rock as the nothing they deliver. A drawn ray
 *     is not one direction but the ring you get by spinning the cross-section
 *     about ITS OWN axis of symmetry, which is the zenith - the atmosphere is
 *     layered about it and a vertical shaft is bored along it. A ring at angle
 *     theta from the zenith covers a solid angle proportional to sin(theta), so
 *     that is the weight: rays near the zenith stand for almost no sky, rays
 *     near the horizon for a great deal.
 *
 *     Spinning about the axis of VIEW instead - the obvious thing, and what
 *     this did first - puts the weight to zero exactly where a shaft's aperture
 *     sits when you look up it, so looking four degrees off the zenith reported
 *     more sky than looking straight up it. About the zenith the aperture's
 *     solid angle comes out exact, and the answer falls away monotonically as
 *     you turn from the mouth.
 *
 *     The price is that an off-zenith field of view is averaged over the ANNULUS
 *     its angles sweep rather than over the disc it really is. For a sky that
 *     varies mostly with height above the horizon the two are close, and both
 *     are centred on the same direction.
 *
 * Two readings come back. `sky` is the light the traced rays deliver and
 * nothing else - what the histogram bars are made of, since rock is not a ray,
 * and what goes black when no beams arrive. `perceived` is what is in front of
 * the observer, which is the same thing UNLESS the direction being faced ends
 * in rock, in which case it is the rock.
 *
 * That is a hard either/or and not a blend, and the difference matters. Mixing
 * the rock in by the share of the view it fills made looking straight up a
 * shaft come out brown - and brown means "you are looking at a wall". Looking
 * up a shaft you are looking at sky; there is simply very little of it, and too
 * little light has to read as dark, never as rock.
 *
 * @param {Array}  paths     traced paths
 * @param {number} axisRad   signed direction the observer is facing
 * @param {number} halfRad   half-angle of the field of view
 * @param {object} options   `index` from indexArrivals, for callers sweeping
 *                           many directions; `wall`, the rock's spectrum
 */
export function measureCone(paths, axisRad, halfRad, options = {}) {
  const { index = null, wall = null } = options;
  const spectrum = new Float64Array(SPECTRUM_BINS);
  const bandEnergy = new Float64Array(RAY_BAND_COUNT);
  const bandRays = new Int32Array(RAY_BAND_COUNT);
  const ring = (angle) => Math.sin(Math.abs(angle));

  let castSky = 0, arrivedSky = 0;
  let cast = 0, arrived = 0, blocked = 0, drawn = 0;
  // Whether the direction being FACED, rather than the cone around it, ends in
  // rock. Judged from the handful of traced directions nearest the axis, so it
  // stays as sharp as the geometry: a two-degree aperture is two degrees of
  // sky, with the wall starting immediately outside it.
  const NEAR_RAD = 2 * Math.PI / 180;
  let nearCast = 0, nearBlocked = 0, nearArrived = 0;
  const drawShare = drawnRayShare(paths);
  const spectra = paths.arrivingSpectra;

  const castAngles = paths.castAngles;
  if (castAngles) {
    for (let i = 0; i < castAngles.length; i++) {
      const away = Math.abs(castAngles[i] - axisRad);
      if (away <= NEAR_RAD) nearCast++;
      if (away > halfRad) continue;
      cast++;
      castSky += ring(castAngles[i]);
    }
  }

  const visit = (p, pathIndex) => {
    if (p.kind === 'blocked') {
      const away = Math.abs(p.arrivalAngleRad - axisRad);
      if (away <= NEAR_RAD) nearBlocked++;
      if (away <= halfRad) blocked++;
      return;
    }
    if (p.kind !== 'arriving') return;
    if (Math.abs(p.arrivalAngleRad - axisRad) <= NEAR_RAD) nearArrived++;
    if (Math.abs(p.arrivalAngleRad - axisRad) > halfRad) return;
    const w = ring(p.arrivalAngleRad);
    arrived++;
    arrivedSky += w;
    const band = p.band ?? 0;
    if (isRayDrawn(pathIndex, drawShare)) { drawn++; bandRays[band]++; }
    if (spectra && p.spectrumOffset != null) {
      for (let i = 0; i < SPECTRUM_BINS; i++) {
        const value = spectra[p.spectrumOffset + i] * w;
        spectrum[i] += value;
        bandEnergy[BAND_OF_BIN[i]] += value;
      }
    } else {
      spectrum[p.bin] += p.radiance * w;
      bandEnergy[band] += p.radiance * w;
    }
  };

  if (index) {
    // Only the paths whose direction can possibly fall inside this cone.
    const from = index.binOfAngle(axisRad - halfRad);
    const to = index.binOfAngle(axisRad + halfRad);
    for (let b = from; b <= to; b++) {
      for (const i of index.buckets[b]) visit(paths[i], i);
    }
  } else {
    for (let i = 0; i < paths.length; i++) visit(paths[i], i);
  }

  // The sky the cone covers, not the rays that paid out. A direction that ends
  // in rock contributes its nothing to the average like any other, which is the
  // whole difference between "how bright is that patch of sky" and "how bright
  // is it here".
  if (castSky > 0) {
    for (let i = 0; i < SPECTRUM_BINS; i++) spectrum[i] /= castSky;
    for (let b = 0; b < RAY_BAND_COUNT; b++) bandEnergy[b] /= castSky;
  }

  const skyShare = castSky > 0 ? arrivedSky / castSky : null;

  // Is the axis itself looking at rock?
  //
  // Stated positively: you are looking at sky if any ray at all arrives from
  // near this direction, and at rock only if the wall stopped something there
  // and nothing came through. A majority vote among the nearby directions was
  // the obvious test and was wrong - the window is two degrees wide and a deep
  // shaft's aperture is half a degree, so looking straight up a hundred and
  // fifty metres of shaft came out "rock" when it is a narrow slot of sky.
  //
  // The two conditions are both needed. Without the first, a shaft at night
  // would be rock everywhere; without the second, so would open ground at
  // night, since no ray arrives anywhere then either.
  const nearAnswers = nearCast > 0;
  const axisBlocked = nearAnswers
    ? nearBlocked > 0 && nearArrived === 0
    : blocked > 0 && arrived === 0;

  const perceived = axisBlocked && wall ? wall : spectrum;

  return {
    spectrum, perceived, bandEnergy, bandRays, axisBlocked,
    cast, arrived, blocked, drawn, skyShare,
  };
}

/**
 * Bucket the paths by the direction they arrive from, so a caller sweeping the
 * whole sky does not walk every path once per direction.
 */
export function indexArrivals(paths, binDeg = 1) {
  const bins = Math.max(1, Math.round(180 / binDeg));
  const buckets = Array.from({ length: bins }, () => []);
  const binOfAngle = (rad) => {
    const deg = Math.max(-90, Math.min(90, rad * 180 / Math.PI));
    return Math.max(0, Math.min(bins - 1, Math.floor((deg + 90) / binDeg)));
  };
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    if (p.kind !== 'arriving' && p.kind !== 'blocked') continue;
    buckets[binOfAngle(p.arrivalAngleRad)].push(i);
  }
  return { bins, binDeg, buckets, binOfAngle };
}

/**
 * What the drawn rays deliver, measured.
 *
 * This is the only source the interface uses for the colour it calls the sky.
 * Nothing here consults the integrator; every number comes from paths that were
 * traced, one scattering event at a time, through the same air the picture
 * draws. The integrator's answer is shown beside it for comparison, and the
 * agreement is then evidence rather than assumption.
 *
 * Two things set the result, and they are the two things a student can see:
 *
 *   WHICH COLOURS.  Each ray was assigned one of eight bands, drawn in
 *      proportion to its own spectrum, so the mix of bands in the cone is the
 *      mix of colours in the light. Count them on screen and you have the hue.
 *
 *   HOW MANY.  The light collected is divided by the number of directions
 *      LOOKED IN, not by the number that paid out. A direction that ends in
 *      rock, or in shadow, contributes its nothing to the average like any
 *      other. So a well with five rays coming in out of fifty is a tenth as
 *      bright as open ground, and forty kilometres up, where each ray carries
 *      almost nothing, the sky goes out. Averaging only over the arrivals - the
 *      old behaviour - reported a bright blue sky at the bottom of a mine,
 *      because the patch of sky you can still see through the mouth is, in
 *      fact, as blue as ever. That is a true statement about a patch of sky and
 *      a false one about a place.
 *
 * The bars are per band rather than per 10 nm bin so that the histogram and the
 * rays in the picture are the same eight colours; the swatch beside them is
 * still built on the full spectral grid each ray carries, which costs nothing
 * and keeps the colour steady when only a few dozen rays are in view.
 *
 * @param {Array}  paths    traced paths
 * @param {number} axisRad  signed direction the observer is looking
 * @param {number} halfRad  half-angle of the viewing cone
 */
export function histogramPhotons(paths, axisRad, halfRad, wall = null) {
  const bands = RAY_BAND_COUNT;
  const elsewhere = new Float64Array(bands);
  const direct = new Float64Array(bands);
  const centres = new Float64Array(bands);
  for (let b = 0; b < bands; b++) centres[b] = RAY_BANDS[b].centreNm;

  // The cone itself, from the one definition. Nothing about the colour on the
  // right of the screen is worked out here any more; this only arranges it.
  const cone = measureCone(paths, axisRad, halfRad, { wall });
  // The bars are the light the RAYS deliver, so they stay sky-only; the swatch
  // is what fills the view, so it takes the rock as well.
  const coneSpectrum = cone.perceived;
  const coneSkySpectrum = cone.spectrum;
  const inCone = cone.bandEnergy;
  const coneBandRays = cone.bandRays;

  // Is the star itself inside the cone? When it is, the direct beam is by far
  // the largest thing in the field of view, and saying so is the only way the
  // panel can be honest about a bundle it cannot draw to scale.
  const starInCone = paths.starAngleRad != null
    && paths.observerBeam != null && paths.observerBeam.visible
    && Math.abs(paths.starAngleRad - axisRad) <= halfRad;

  // The rest of the sky, which is only ever a backdrop to the cone and so keeps
  // the plain per-direction average it always had.
  const spectra = paths.arrivingSpectra;
  let elsewhereCast = 0, directRays = 0, directSum = 0, directWeighted = 0;
  const castAngles = paths.castAngles;
  if (castAngles) {
    for (let i = 0; i < castAngles.length; i++) {
      if (Math.abs(castAngles[i] - axisRad) > halfRad) elsewhereCast++;
    }
  }
  for (const p of paths) {
    const b = Math.min(bands - 1, p.band ?? 0);
    if (p.kind === 'arriving') {
      if (Math.abs(p.arrivalAngleRad - axisRad) <= halfRad) continue;
      if (spectra && p.spectrumOffset != null) {
        for (let i = 0; i < SPECTRUM_BINS; i++) {
          elsewhere[BAND_OF_BIN[i]] += spectra[p.spectrumOffset + i];
        }
      } else {
        elsewhere[b] += p.radiance;
      }
    } else if (p.kind === 'through') {
      direct[b] += p.weight;
      directSum += p.weight;
      directWeighted += p.weight * p.lambda;
      directRays++;
    }
  }
  if (elsewhereCast > 0) {
    for (let b = 0; b < bands; b++) elsewhere[b] /= elsewhereCast;
  }

  let peak = 0, directPeak = 0, coneSum = 0, coneWeighted = 0;
  for (let b = 0; b < bands; b++) {
    peak = Math.max(peak, inCone[b] + elsewhere[b]);
    directPeak = Math.max(directPeak, direct[b]);
    coneSum += inCone[b];
    coneWeighted += inCone[b] * centres[b];
  }

  return {
    bands: RAY_BANDS, centres, inCone, elsewhere, direct, peak, directPeak,
    coneSpectrum, coneSkySpectrum, coneBandRays,
    // The star as this observer receives it, marched rather than sampled.
    beam: paths.observerBeam ?? null,
    starInCone,
    coneRays: cone.arrived, coneCast: cone.cast, elsewhereCast,
    blockedRays: cone.blocked, directRays,
    drawnInCone: cone.drawn, drawShare: drawnRayShare(paths),
    // The share of the FIELD OF VIEW that still has sky in it - not the share
    // of the drawn angles, which is a different and much kinder number down a
    // narrow shaft. In the open it is one; down a shaft it is the whole story,
    // and it is what the brightness follows.
    skyShare: cone.skyShare,
    coneMeanNm: coneSum > 0 ? coneWeighted / coneSum : null,
    directMeanNm: directSum > 0 ? directWeighted / directSum : null,
  };
}

/**
 * What the observer sees, direction by direction, all the way round.
 *
 * The strip under the cross-section, and it is the colour swatch swept across
 * the sky: every column is `measureCone` pointed that way, with the same field
 * of view and the same arithmetic. Turn the observer to any direction and the
 * swatch on the right reads what the strip already shows at that column.
 *
 * It used to be its own calculation, dividing only by the directions that had
 * sky down them. That is a perfectly good quantity - the radiance of the patch
 * you can still see - and it is why a fifty-metre shaft showed a bright band
 * while the swatch beside it read almost black. Both were right about different
 * questions, and having both was the bug.
 *
 * Where the field of view holds no sky at all the answer is nothing, and
 * nothing has no colour. What is there is rock, so the rock is mixed in by the
 * share of the view it fills. On open ground that share is zero and this
 * changes nothing; down a shaft it carries the strip smoothly from the lit
 * mouth out to the wall, with no seam to mark where the sky ran out.
 *
 * @param {Array}  paths      traced paths
 * @param {object} options    binDeg, the field of view, and the wall spectrum
 */
export function skyFromRays(paths, options = {}) {
  const {
    binDeg = 1,
    halfRad = VIEW_CONE_HALF_DEG * Math.PI / 180,
    wall = null,
  } = options;
  const bins = Math.max(1, Math.round(180 / binDeg));
  const index = indexArrivals(paths, binDeg);

  const radiance = new Float64Array(bins * SPECTRUM_BINS);
  const skyShare = new Float64Array(bins);
  /** Which directions end in rock, so the renderer can tell them apart. */
  const blocked = new Uint8Array(bins);
  const angleOf = (b) => -90 + (b + 0.5) * binDeg;

  for (let b = 0; b < bins; b++) {
    const axis = angleOf(b) * Math.PI / 180;
    const cone = measureCone(paths, axis, halfRad, { index, wall });
    skyShare[b] = cone.skyShare == null ? 1 : cone.skyShare;
    blocked[b] = cone.axisBlocked ? 1 : 0;
    radiance.set(cone.perceived, b * SPECTRUM_BINS);
  }

  return {
    bins, binDeg, radiance, skyShare, blocked, angleOf,
    binOfAngle: (deg) => Math.max(0, Math.min(bins - 1,
      Math.floor((Math.max(-90, Math.min(90, deg)) + 90) / binDeg))),
    /** The spectrum of one bin, as a view into the packed array. */
    spectrumAt(b) {
      const i = Math.max(0, Math.min(bins - 1, b)) * SPECTRUM_BINS;
      return radiance.subarray(i, i + SPECTRUM_BINS);
    },
  };
}

/**
 * The colour of the rock the shaft is cut through, lit by what reaches it.
 *
 * Not black. Black says "nothing here"; what is there is rock, and rock has a
 * colour. Two things light it, and which of them wins is the whole character of
 * the picture:
 *
 *   THE SKY at the mouth, which reaches all the way down. How much of it a
 *     point on the wall can see depends on how far below the mouth it is, and
 *     averaged over the whole depth that comes out in closed form as
 *     (R/d)·arctan(d/R) - 38 % of the way to a full hemisphere for a five-metre
 *     shaft, 1 % for a two-hundred-metre one. Using the OBSERVER's aperture
 *     instead was wrong twice over: it is the view from the very bottom, the
 *     darkest point on the wall, and it sent a deep shaft to pure black.
 *
 *   THE STAR, which reaches only as far down as the geometry lets it - a patch
 *     2R/tan(z) deep on one side, where z is the star's angle from the vertical.
 *     At a high star that is most of a shallow shaft and none of a deep one.
 *     Without it the wall came out a cool grey, because blue sky on red-brown
 *     rock very nearly cancels; with it a shallow shaft is warm and lit and a
 *     deep one is the cold grey-brown it should be.
 *
 * The reflectance is the world's own, from its config: dark in the blue, rising
 * towards the red, which is what soil and most rock do.
 *
 * @param {Array}  paths        traced paths
 * @param {Float64Array} reflectance  the ground's reflectance spectrum
 * @param {object} shaft        { depth_m, radius_m, sunZenithRad }
 */
export function shaftWallSpectrum(paths, reflectance, shaft = null) {
  const out = new Float64Array(SPECTRUM_BINS);
  if (!paths || !reflectance) return out;

  const spectra = paths.arrivingSpectra;
  const sky = new Float64Array(SPECTRUM_BINS);
  let rays = 0;
  for (const p of paths) {
    if (p.kind !== 'arriving') continue;
    rays++;
    if (spectra && p.spectrumOffset != null) {
      for (let i = 0; i < SPECTRUM_BINS; i++) sky[i] += spectra[p.spectrumOffset + i];
    } else {
      sky[p.bin] += p.radiance;
    }
  }
  // The brightness of the patch of sky itself, not how small it is - how small
  // it is comes in through the geometry below.
  if (rays > 0) for (let i = 0; i < SPECTRUM_BINS; i++) sky[i] /= rays;

  const depth = shaft && shaft.depth_m > 0 ? shaft.depth_m : 0;
  const radius = shaft && shaft.radius_m > 0 ? shaft.radius_m : 1;
  const skyLit = depth > 0 ? (radius / depth) * Math.atan(depth / radius) : 1;

  // How much of the wall the star can reach at all.
  const beam = paths.observerBeam;
  const zenith = shaft && shaft.sunZenithRad != null ? shaft.sunZenithRad : null;
  let sunlit = 0;
  if (beam && zenith != null && depth > 0) {
    const tan = Math.abs(Math.tan(zenith));
    const reach = tan > 1e-6 ? (2 * radius) / tan : depth;
    // Only when the star is above the horizon - the beam's own visibility flag
    // is about the OBSERVER at the bottom, whom the wall is busy shading.
    if (!beam.belowHorizon) sunlit = Math.max(0, Math.min(1, reach / depth));
  }
  const grazing = zenith == null ? 0 : Math.abs(Math.sin(zenith));

  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const lit = sky[i] * skyLit
      + (beam ? beam.unblocked[i] * sunlit * grazing / Math.PI : 0);
    out[i] = lit * reflectance[i];
  }
  return out;
}

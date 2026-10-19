/**
 * One sunbeam through the air, colour by colour.
 *
 * The question this module answers is the one a student asks first: does the
 * air treat the colours of a sunbeam differently? It does, in two quite
 * different ways, and the module computes both.
 *
 *   SCATTERING (rozptyl) depends strongly on wavelength. Molecules scatter as
 *   roughly 1/lambda^4 (Bodhaine et al. 1999: lambda^-4.09 across the visible),
 *   haze much more weakly (the Angstrom law, alpha about 1.1-1.4), and ozone
 *   absorbs a band centred on orange (the Chappuis band). Along the path every
 *   colour is drained at its own rate: blue leaves the beam sideways - that is
 *   the sky - and what reaches the ground is the remainder, reddened.
 *
 *   REFRACTION (lom) depends only weakly on wavelength. The refractive index of
 *   air is about 1.5 % larger for blue than for red (Ciddor 1996), so a low Sun
 *   is lifted by about half a degree and its blue image sits a fraction of an
 *   arcminute above its red one: coloured rims and the green flash. Far too
 *   small to colour a sunset - which is what scattering does.
 *
 * Everything physical comes from the same atmosphere the rest of the simulator
 * uses (createAtmosphere): the Rayleigh coefficients and their measured shape,
 * the haze, the ozone layer, the exact column integration. The beam is a pencil
 * of direct sunlight from the top of the atmosphere straight to an observer on
 * the ground; what leaves it is booked, colour by colour, as scattered by
 * molecules, scattered by haze, absorbed by haze, or absorbed by ozone, so that
 * for every colour the four losses and the transmitted share add up to one.
 */

import { SPECTRUM_BINS, WAVELENGTHS_NM, RAY_BANDS, BAND_OF_BIN } from './spectrum.js';
import { v3, v3addScaled, v3length, sunDirectionFromElevation } from './geometry.js';
import { particlePattern, sampleTurnDeg, CHAMBER_SAMPLE } from './mie.js';

/* ------------------------------------------------------------------ */
/* refraction and dispersion                                          */
/* ------------------------------------------------------------------ */

/**
 * Refractivity n - 1 of standard dry air (15 °C, 101.325 kPa), Ciddor (1996),
 * Appl. Opt. 35, 1566, Eq. (1); sigma is the vacuum wavenumber in 1/micrometre.
 */
export function airRefractivity(lambdaNm) {
  const sigma = 1000 / lambdaNm;
  const s2 = sigma * sigma;
  return (5792105 / (238.0185 - s2) + 167917 / (57.362 - s2)) * 1e-8;
}

/** The wavelength the standard refraction formula is taken to hold for. */
export const REFRACTION_REFERENCE_NM = 550;

/**
 * Astronomical refraction for a star at TRUE (geometric) elevation h, in
 * arcminutes, at 101 kPa and 10 °C: Saemundsson (1986), Sky & Telescope 72, 70,
 *
 *     R = 1.02 / tan(h + 10.3 / (h + 5.11))      (h in degrees)
 *
 * scaled to another wavelength by the ratio of refractivities, since the
 * bending is proportional to n - 1. That ratio is the whole of the dispersion.
 */
export function refractionArcmin(trueElevationDeg, lambdaNm = REFRACTION_REFERENCE_NM) {
  const h = Math.max(-1, trueElevationDeg);
  const standard = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * Math.PI / 180);
  return standard * airRefractivity(lambdaNm) / airRefractivity(REFRACTION_REFERENCE_NM);
}

/* ------------------------------------------------------------------ */
/* the beam                                                           */
/* ------------------------------------------------------------------ */

/** A source spectrum holding a single colour: one bin of the 10 nm grid. */
export function singleColourSpectrum(wavelengthNm) {
  const out = new Float64Array(SPECTRUM_BINS);
  let best = 0;
  for (let i = 1; i < SPECTRUM_BINS; i++) {
    if (Math.abs(WAVELENGTHS_NM[i] - wavelengthNm) < Math.abs(WAVELENGTHS_NM[best] - wavelengthNm)) best = i;
  }
  out[best] = 1;
  return out;
}

const LOSSES = ['rayleigh', 'aerosolScatter', 'aerosolAbsorb', 'ozone'];

/**
 * Follow the direct beam from the top of the atmosphere down to an observer on
 * the ground, the Sun at `elevationDeg` (geometric) above the horizon.
 *
 * @param {object} options
 *   atmosphere    an object from createAtmosphere
 *   source        the spectrum entering the top of the atmosphere
 *   elevationDeg  the Sun's elevation, >= 0
 *   steps         segments along the path
 * @returns per-bin and per-band intensity along the path, where each loss went,
 *   and the refraction of each colour.
 */
export function traceBeam({ atmosphere, source, elevationDeg, steps = 160 }) {
  const R = atmosphere.planetRadius;
  const observer = v3(0, R, 0);
  const elevation = Math.max(0, elevationDeg);
  const toSun = sunDirectionFromElevation(elevation);
  const length = atmosphere.rayExtent(observer, toSun).distance;

  const betaR = atmosphere.rayleighBeta0;
  const betaAext = atmosphere.aerosolExt0;
  const betaAsca = atmosphere.aerosolSca0;
  const kO = atmosphere.ozoneAbsorption0;

  const intensity = Float64Array.from(source);
  const lost = Object.fromEntries(LOSSES.map((k) => [k, new Float64Array(SPECTRUM_BINS)]));
  const tau = new Float64Array(SPECTRUM_BINS);

  // Points from the entry at the top (s = 0) to the observer (s = length).
  const points = [];
  const pointAt = (s) => {
    const p = v3addScaled(observer, toSun, length - s);
    return { s, x: p.x, y: p.y, altitude: v3length(p) - R };
  };
  const bandTotals = (spectrum) => {
    const out = new Float64Array(RAY_BANDS.length);
    for (let i = 0; i < SPECTRUM_BINS; i++) out[BAND_OF_BIN[i]] += spectrum[i];
    return out;
  };

  let previous = pointAt(0);
  // airColumn: the molecules crossed so far (m, at sea-level density).
  let airColumn = 0;
  points.push({ ...previous, airColumn, bands: bandTotals(intensity), spectrum: Float64Array.from(intensity), shed: new Float64Array(RAY_BANDS.length) });
  const ds = length / steps;
  for (let k = 1; k <= steps; k++) {
    const here = pointAt(k * ds);
    // Exact for the exponential layers between the two ends of the step.
    const col = atmosphere.segmentColumns(previous.altitude, here.altitude, ds);
    const shed = new Float64Array(RAY_BANDS.length);
    airColumn += col.r;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const parts = {
        rayleigh: betaR[i] * col.r,
        aerosolScatter: betaAsca[i] * col.a,
        aerosolAbsorb: (betaAext[i] - betaAsca[i]) * col.a,
        ozone: kO[i] * col.o,
      };
      const dTau = parts.rayleigh + parts.aerosolScatter + parts.aerosolAbsorb + parts.ozone;
      if (!(dTau > 0)) continue;
      tau[i] += dTau;
      const loss = intensity[i] * -Math.expm1(-dTau);
      for (const key of LOSSES) lost[key][i] += loss * parts[key] / dTau;
      // What this step sends sideways, by colour: the light that becomes sky.
      shed[BAND_OF_BIN[i]] += loss * (parts.rayleigh + parts.aerosolScatter) / dTau;
      intensity[i] -= loss;
    }
    points.push({ ...here, airColumn, bands: bandTotals(intensity), spectrum: Float64Array.from(intensity), shed });
    previous = here;
  }

  // Per colour band: where its light went, as shares of what entered.
  const entered = bandTotals(source);
  const transmitted = bandTotals(intensity);
  const lostBands = Object.fromEntries(LOSSES.map((k) => [k, bandTotals(lost[k])]));
  const budget = RAY_BANDS.map((band, b) => {
    const total = entered[b];
    const share = (v) => (total > 0 ? v / total : 0);
    return {
      band,
      present: total > 0,
      transmitted: share(transmitted[b]),
      rayleigh: share(lostBands.rayleigh[b]),
      aerosolScatter: share(lostBands.aerosolScatter[b]),
      aerosolAbsorb: share(lostBands.aerosolAbsorb[b]),
      ozone: share(lostBands.ozone[b]),
      // The band's own optical depth, for the chamber and the readouts.
      tau: total > 0 ? -Math.log(Math.max(1e-300, transmitted[b] / total)) : 0,
    };
  });

  // The optical depth of each kind of matter along the whole path, per band:
  // what the chamber reproduces with its particles.
  const tauByKind = Object.fromEntries(LOSSES.map((key) => [key, RAY_BANDS.map((_, b) => {
    const t = budget[b];
    if (!t.present) return 0;
    const out = t.rayleigh + t.aerosolScatter + t.aerosolAbsorb + t.ozone;
    return out > 0 ? t.tau * t[key] / out : 0;
  })]));

  const verticalColumn = atmosphere.verticalColumnRayleigh(0);
  const pathColumn = atmosphere.pathColumns(observer, toSun, length).columnR;

  return {
    elevationDeg: elevation,
    pathLengthM: length,
    airMass: verticalColumn > 0 ? pathColumn / verticalColumn : 0,
    points,
    transmittedSpectrum: intensity,
    tau,
    budget,
    tauByKind,
    refraction: RAY_BANDS.map((band) => ({
      band,
      arcmin: refractionArcmin(elevation, band.centreNm),
    })),
  };
}

/* ------------------------------------------------------------------ */
/* the collision chamber                                              */
/* ------------------------------------------------------------------ */

/**
 * A magnified piece of air, drawn as particles, that lets light through in the
 * same proportions, colour by colour, as the real path does.
 *
 * In two dimensions a ray meets a particle if it passes within the particle's
 * half-width b, so the chance of a hit per unit length is n * 2b, where n is
 * the number of particles per unit area. Choosing, for each kind of particle,
 *
 *     b(colour) = tau(colour) / (2 n W)
 *
 * makes a ray crossing the chamber's width W meet on average tau particles of
 * that kind - the optical depth of that kind of matter along the real path. So
 * blue's targets are bigger than red's by exactly the factor the scattering
 * law says, and the share of each colour that crosses untouched is e^-tau, as
 * it is in the sky. (An earlier version scaled the radius as 1/lambda^2, which
 * in two dimensions gives a hit rate of 1/lambda^2, not 1/lambda^4.)
 *
 * The chamber is periodic top to bottom for hit-testing, so a ray near an edge
 * sees as many targets as one in the middle.
 */
export const CHAMBER_KINDS = {
  rayleigh: { count: 44, action: 'scatter' },
  aerosolScatter: { count: 10, action: 'scatter' },
  aerosolAbsorb: { count: 6, action: 'absorb' },
  ozone: { count: 10, action: 'absorb' },
};

function chamberRng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function createChamber({ width, height, tauByKind, seed = 2026 }) {
  const rng = chamberRng(seed);
  const particles = [];
  const halfWidths = {};
  for (const [kind, spec] of Object.entries(CHAMBER_KINDS)) {
    const n = spec.count / (width * height);
    // Never wider than half the chamber: past that a colour is gone anyway.
    halfWidths[kind] = (tauByKind[kind] ?? []).map((t) => Math.min(height / 2, t / (2 * n * width)));
    for (let i = 0; i < spec.count; i++) {
      particles.push({ kind, x: rng() * width, y: rng() * height, phase: rng() * Math.PI * 2 });
    }
  }
  return { width, height, particles, halfWidths };
}

/**
 * The turn at a scattering, drawn from the pattern of the particle the kind
 * stands for, at this colour's wavelength (physics/mie.js): an air molecule
 * scatters as 1 + cos^2(theta) whatever the colour; a haze droplet half a
 * micrometre across scatters forward, and blue more forward than red.
 */
function deflection(kind, rng, band) {
  const pattern = particlePattern(CHAMBER_SAMPLE[kind], RAY_BANDS[band].centreNm);
  return sampleTurnDeg(pattern, rng) * Math.PI / 180;
}

/**
 * One ray of one colour band across the chamber from the left wall.
 * Returns its polyline, what it met, and how it ended: 'direct' (crossed
 * without meeting anything), 'scattered' or 'absorbed'. Each event names the
 * particle met and where it stood (`at`, which for a hit near the top or bottom
 * is its periodic image), and for a scatter how far the ray was turned
 * (`turnDeg`). `exit` is the wall the ray left by, or null if it ended inside.
 */
export function traceChamberRay(chamber, { band, y0, rng, maxEvents = 3 }) {
  const { width, height, particles, halfWidths } = chamber;
  let x = 0, y = y0, angle = 0;
  const points = [{ x, y }];
  const events = [];
  const met = new Set();
  for (let e = 0; e <= maxEvents; e++) {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    let best = null;
    for (let i = 0; i < particles.length; i++) {
      if (met.has(i)) continue;
      const p = particles[i];
      const b = halfWidths[p.kind][band];
      if (!(b > 0)) continue;
      // The particle and its images above and below: periodic hit-testing.
      for (const shift of [-height, 0, height]) {
        const px = p.x - x, py = p.y + shift - y;
        const along = px * dx + py * dy;
        if (along <= 0.5) continue;
        const perp2 = px * px + py * py - along * along;
        if (perp2 > b * b) continue;
        const dist = along - Math.sqrt(b * b - perp2);
        if (dist > 0.5 && (!best || dist < best.dist)) best = { i, dist, kind: p.kind, shift };
      }
    }
    // Distance to the walls.
    let wall = Infinity;
    if (dx > 1e-9) wall = Math.min(wall, (width - x) / dx);
    if (dx < -1e-9) wall = Math.min(wall, -x / dx);
    if (dy > 1e-9) wall = Math.min(wall, (height - y) / dy);
    if (dy < -1e-9) wall = Math.min(wall, -y / dy);

    if (!best || best.dist >= wall) {
      x += dx * wall; y += dy * wall;
      points.push({ x, y });
      const exit = x >= width - 1e-6 ? 'detector' : x <= 1e-6 ? 'back' : y <= 1e-6 ? 'top' : 'bottom';
      return { band, points, events, exit, fate: events.length === 0 ? 'direct' : 'scattered' };
    }
    x += dx * best.dist; y += dy * best.dist;
    points.push({ x, y });
    met.add(best.i);
    const action = CHAMBER_KINDS[best.kind].action;
    const p = particles[best.i];
    // Which particle, and where its copy stood if it was one of the images.
    events.push({ x, y, kind: best.kind, action, particle: best.i, at: { x: p.x, y: p.y + best.shift } });
    if (action === 'absorb') return { band, points, events, exit: null, fate: 'absorbed' };
    const turn = deflection(best.kind, rng, band);
    events[events.length - 1].turnDeg = Math.abs(turn) * 180 / Math.PI;
    angle += turn;
    // Wrap a scattered ray back into the chamber vertically only while it is
    // still inside; leaving through the top or bottom ends it at the wall.
  }
  // Followed for maxEvents + 1 collisions; it is still in the chamber.
  return { band, points, events, exit: null, fate: 'scattered' };
}

/**
 * A bundle: the same number of rays in every colour band present in the source,
 * so the share of each colour that gets through can be counted and set beside
 * e^-tau.
 *
 * Every colour enters at the SAME heights, evenly spread across the chamber.
 * With random heights the colours would differ by chance as much as by physics
 * - a dozen rays per colour scatter by about one in seven - and the picture
 * could show yellow faring worse than violet. With shared heights two colours
 * meet the same particles and differ only by how big those particles' targets
 * are for them, which is the thing being shown.
 */
export function traceChamberBundle(chamber, { bands, raysPerBand = 24, seed = 7 }) {
  const rays = [];
  const tally = RAY_BANDS.map(() => ({ sent: 0, direct: 0, scattered: 0, absorbed: 0 }));
  for (const b of bands) {
    const rng = chamberRng(seed);   // the same deflections too, colour by colour
    for (let k = 0; k < raysPerBand; k++) {
      const y0 = ((k + 0.5) / raysPerBand) * chamber.height;
      const ray = traceChamberRay(chamber, { band: b, y0, rng });
      rays.push(ray);
      tally[b].sent++;
      tally[b][ray.fate]++;
    }
  }
  return { rays, tally };
}

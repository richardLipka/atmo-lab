/**
 * Scattering physics: cross-sections and phase functions.
 *
 * Two regimes are modelled.
 *
 * Rayleigh scattering applies when the scatterer is far smaller than the
 * wavelength (air molecules, ~0.3 nm, against ~500 nm light). The cross
 * section goes as 1/lambda^4, which is the single fact behind the blue sky and
 * the red sunset.
 *
 * Aerosol (Mie) scattering applies when the particle size is comparable to the
 * wavelength (dust, droplets, smoke). The exact theory needs Maxwell's
 * equations solved on a sphere; here it is replaced by the standard
 * educational pair of an Angstrom power law and a Henyey-Greenstein phase
 * function, which reproduce the two features that matter: near-neutral colour
 * and strong forward peaking.
 */

import { SPECTRUM_BINS, WAVELENGTHS_NM, specNew } from './spectrum.js';

export const REFERENCE_WAVELENGTH_NM = 550;

/**
 * The scattering cross-section of real air, relative to its value at 550 nm.
 *
 * An ideal dipole scatters as 1/lambda^4 exactly. Air does not, for two reasons
 * that both come from the molecule rather than from the light: the refractive
 * index of air itself rises towards the blue (so the polarisability that
 * squares into the cross-section is not constant), and the molecules are not
 * spheres, so a little light is scattered depolarised - the King factor, which
 * also rises towards the blue. Together they steepen the law to roughly
 * lambda^-4.08 across the visible.
 *
 * This is the fit of Bodhaine, Wood, Dutton & Slusser (1999), "On Rayleigh
 * optical depth calculations", J. Atmos. Oceanic Technol. 16, 1854-1861,
 * Eq. (29): the cross-section of dry air with 360 ppm CO2, accurate to better
 * than 0.01 % over 250-850 nm. Only its SHAPE is used here - the strength comes
 * from the atmosphere's own column - so the leading constant cancels.
 */
export function bodhaineAirShape(lambdaNm) {
  const l = lambdaNm / 1000;          // the fit is written in micrometres
  const l2 = l * l;
  return (1.0455996 - 341.29061 / l2 - 0.90230850 * l2)
    / (1 + 0.0027059889 / l2 - 85.968563 * l2);
}

/**
 * How far real air departs from an ideal 1/lambda^4 law at each wavelength,
 * normalised to 1 at 550 nm. Multiplying an ideal (550/lambda)^4 spectrum by
 * this gives Bodhaine's measured shape exactly.
 */
export const AIR_DISPERSION_FACTOR = (() => {
  const out = specNew();
  const ref = bodhaineAirShape(REFERENCE_WAVELENGTH_NM);
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const nm = WAVELENGTHS_NM[i];
    const ideal = Math.pow(REFERENCE_WAVELENGTH_NM / nm, 4);
    out[i] = (bodhaineAirShape(nm) / ref) / ideal;
  }
  return out;
})();

/**
 * Rayleigh volume scattering coefficient per wavelength, at the density where
 * `beta550` was measured.
 *
 *     beta(lambda) = beta(550) * (550 / lambda)^exponent * D(lambda)
 *
 * The exponent is exposed so a student can dial it away from 4 and watch the
 * sky lose its colour - the fastest way to see that 1/lambda^4 is doing all
 * the work. D is the departure of the real gas from an ideal dipole (see
 * AIR_DISPERSION_FACTOR); it is 1 everywhere for a world that does not declare
 * one, and it stays applied when the exponent is moved, so the slider always
 * means "the ideal part of the law" and n = 4 is real air, exactly.
 */
export function rayleighBetaSpectrum(beta550, exponent = 4, dispersion = null) {
  const out = specNew();
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    out[i] = beta550 * Math.pow(REFERENCE_WAVELENGTH_NM / WAVELENGTHS_NM[i], exponent)
      * (dispersion ? dispersion[i] : 1);
  }
  return out;
}

/**
 * Aerosol extinction coefficient per wavelength using the Angstrom power law.
 * An exponent near 0 means a grey (colour-neutral) haze; near 1.3 it is a fine
 * clean aerosol with a mild blue preference.
 *
 * The exponent may be one number, or a pair { short, long } split at 500 nm.
 * Aerosol climatologies quote exactly that pair - OPAC (Hess, Koepke & Schult
 * 1998, Table 3) gives alpha over 350-500 nm and over 500-800 nm separately,
 * because a real size distribution is not a single power law - and the two
 * halves are joined continuously at the split.
 */
export const ANGSTROM_SPLIT_NM = 500;

export function aerosolBetaSpectrum(beta550, angstromExponent = 1) {
  const out = specNew();
  const pair = typeof angstromExponent === 'object' && angstromExponent !== null;
  const long = pair ? angstromExponent.long : angstromExponent;
  const short = pair ? angstromExponent.short : angstromExponent;
  const atSplit = beta550 * Math.pow(REFERENCE_WAVELENGTH_NM / ANGSTROM_SPLIT_NM, long);
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const nm = WAVELENGTHS_NM[i];
    out[i] = nm >= ANGSTROM_SPLIT_NM
      ? beta550 * Math.pow(REFERENCE_WAVELENGTH_NM / nm, long)
      : atSplit * Math.pow(ANGSTROM_SPLIT_NM / nm, short);
  }
  return out;
}

/**
 * Resolve a single-scattering albedo specification into a spectrum.
 * Accepts a plain number (grey) or a {wavelengths_nm, values} table, which is
 * linearly interpolated and clamped at the ends.
 *
 * The albedo is the fraction of an extinction event that is scattering rather
 * than absorption. Martian dust absorbs blue far more than red, and that
 * asymmetry - not the scattering itself - is what makes the Martian sky ochre.
 */
export function resolveAlbedoSpectrum(spec) {
  const out = specNew();
  if (typeof spec === 'number') {
    out.fill(spec);
    return out;
  }
  if (!spec || !Array.isArray(spec.wavelengths_nm) || !Array.isArray(spec.values)) {
    out.fill(1);
    return out;
  }
  const xs = spec.wavelengths_nm, ys = spec.values;
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    const w = WAVELENGTHS_NM[i];
    if (w <= xs[0]) { out[i] = ys[0]; continue; }
    if (w >= xs[xs.length - 1]) { out[i] = ys[ys.length - 1]; continue; }
    let k = 0;
    while (k < xs.length - 2 && xs[k + 1] < w) k++;
    const t = (w - xs[k]) / (xs[k + 1] - xs[k]);
    out[i] = ys[k] + t * (ys[k + 1] - ys[k]);
  }
  return out;
}

/**
 * The coefficients of the Rayleigh phase function, P = (a + b mu^2) / norm, for
 * a gas with depolarisation ratio rho.
 *
 * For an ideal spherical dipole rho = 0 and a = b: light scattered at right
 * angles is fully polarised and half as strong as forward light. A real
 * molecule is slightly anisotropic, so some of the right-angle light is
 * depolarised and the sideways dip is shallower:
 *
 *     P(theta) = 3 / (16 pi (1 + 2 gamma)) * [(1 + 3 gamma) + (1 - gamma) cos^2 theta]
 *     gamma    = rho / (2 - rho)
 *
 * Chandrasekhar (1950), Radiative Transfer, sect. 18; in this form Eq. (2.15)
 * of Hansen & Travis (1974), Space Sci. Rev. 16, 527. For air rho = 0.0279
 * (Young 1980, the value Bodhaine et al. 1999 adopt): the sky 90 degrees from
 * the Sun comes out 1.4 % brighter than the ideal law says, and the sky beside
 * the Sun 1.4 % fainter.
 */
function rayleighPhaseCoefficients(depolarization) {
  const rho = Math.max(0, Math.min(0.5, depolarization || 0));
  const gamma = rho / (2 - rho);
  return { a: 1 + 3 * gamma, b: 1 - gamma, norm: (16 * Math.PI * (1 + 2 * gamma)) / 3 };
}

/**
 * Normalised Rayleigh phase function. With no depolarisation it is the
 * textbook 3 / (16 pi) (1 + cos^2 theta).
 *
 * It integrates to 1 over the full solid angle. Forward and backward
 * scattering are equally likely and sideways scattering is only about half as
 * likely, so the sky is brightest near the Sun and dimmest 90 degrees away.
 */
export function rayleighPhase(cosTheta, depolarization = 0) {
  const { a, b, norm } = rayleighPhaseCoefficients(depolarization);
  return (a + b * cosTheta * cosTheta) / norm;
}

/**
 * Henyey-Greenstein phase function, the standard one-parameter stand-in for a
 * Mie lobe.
 *
 *     P(theta) = (1 - g^2) / (4 pi (1 + g^2 - 2 g cos theta)^{3/2})
 *
 * g = 0 is isotropic, g -> 1 is entirely forward. Atmospheric aerosols sit
 * around g = 0.7, which is why haze produces a bright glare around the Sun.
 */
export function henyeyGreensteinPhase(cosTheta, g) {
  const gg = Math.max(-0.99, Math.min(0.99, g));
  const denom = 1 + gg * gg - 2 * gg * cosTheta;
  return (1 - gg * gg) / (4 * Math.PI * Math.pow(Math.max(denom, 1e-6), 1.5));
}

/**
 * Draw a scattering direction cosine from the Rayleigh phase function.
 *
 * The cumulative distribution of a + b mu^2 on [-1, 1] is a cubic in mu, and a
 * cubic with a positive linear term has exactly one real root, which Cardano's
 * formula gives in closed form:
 *
 *     mu^3 + p mu + q = 0,   p = 3a / b,   q = (3 / b) (a + b / 3) (1 - 2 xi)
 *
 * With no depolarisation this is the familiar u = 4 xi - 2,
 * d = cbrt(u + sqrt(u^2 + 1)), mu = d - 1/d.
 */
export function sampleRayleighCosine(random = Math.random, depolarization = 0) {
  const { a, b } = rayleighPhaseCoefficients(depolarization);
  const xi = random();
  const p = (3 * a) / b;
  const q = (3 / b) * (a + b / 3) * (1 - 2 * xi);
  const root = Math.sqrt((q * q) / 4 + (p * p * p) / 27);
  const mu = Math.cbrt(-q / 2 + root) + Math.cbrt(-q / 2 - root);
  return Math.max(-1, Math.min(1, mu));
}

/** Draw a scattering direction cosine from the Henyey-Greenstein lobe. */
export function sampleHenyeyGreensteinCosine(g, random = Math.random) {
  const gg = Math.max(-0.99, Math.min(0.99, g));
  if (Math.abs(gg) < 1e-4) return 1 - 2 * random();
  const s = (1 - gg * gg) / (1 - gg + 2 * gg * random());
  return (1 + gg * gg - s * s) / (2 * gg);
}

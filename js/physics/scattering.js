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
 * Rayleigh volume scattering coefficient per wavelength, at the density where
 * `beta550` was measured.
 *
 *     beta(lambda) = beta(550) * (550 / lambda)^exponent
 *
 * The exponent is exposed so a student can dial it away from 4 and watch the
 * sky lose its colour - the fastest way to see that 1/lambda^4 is doing all
 * the work.
 */
export function rayleighBetaSpectrum(beta550, exponent = 4) {
  const out = specNew();
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    out[i] = beta550 * Math.pow(REFERENCE_WAVELENGTH_NM / WAVELENGTHS_NM[i], exponent);
  }
  return out;
}

/**
 * Aerosol extinction coefficient per wavelength using the Angstrom power law.
 * An exponent near 0 means a grey (colour-neutral) haze; near 1.3 it is a fine
 * clean aerosol with a mild blue preference.
 */
export function aerosolBetaSpectrum(beta550, angstromExponent = 1) {
  const out = specNew();
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    out[i] = beta550 * Math.pow(REFERENCE_WAVELENGTH_NM / WAVELENGTHS_NM[i], angstromExponent);
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
 * Normalised Rayleigh phase function.
 *
 *     P(theta) = 3 / (16 pi) * (1 + cos^2 theta)
 *
 * It integrates to 1 over the full solid angle. Forward and backward
 * scattering are equally likely and sideways scattering is only half as
 * likely, so the sky is brightest near the Sun and dimmest 90 degrees away.
 */
export function rayleighPhase(cosTheta) {
  return (3 / (16 * Math.PI)) * (1 + cosTheta * cosTheta);
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

/** Draw a scattering direction cosine from the Rayleigh phase function. */
export function sampleRayleighCosine(random = Math.random) {
  // Inverting the cumulative distribution of (3/8)(1+mu^2) analytically.
  const u = 4 * random() - 2;
  const d = Math.cbrt(u + Math.sqrt(u * u + 1));
  return d - 1 / d;
}

/** Draw a scattering direction cosine from the Henyey-Greenstein lobe. */
export function sampleHenyeyGreensteinCosine(g, random = Math.random) {
  const gg = Math.max(-0.99, Math.min(0.99, g));
  if (Math.abs(gg) < 1e-4) return 1 - 2 * random();
  const s = (1 - gg * gg) / (1 - gg + 2 * gg * random());
  return (1 + gg * gg - s * s) / (2 * gg);
}

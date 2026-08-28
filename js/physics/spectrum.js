/**
 * Spectral representation.
 *
 * Every radiometric quantity in this simulator is carried as a discrete
 * spectral power density vector I(lambda) sampled on a fixed grid:
 *
 *     lambda in [380 nm, 750 nm], step 10 nm  ->  38 bins.
 *
 * Keeping one single grid for sources, cross-sections, transmittances and the
 * CIE colour matching functions means no resampling is ever needed and the
 * whole pipeline is a chain of element-wise array operations.
 */

export const SPECTRUM_MIN_NM = 380;
export const SPECTRUM_MAX_NM = 750;
export const SPECTRUM_STEP_NM = 10;
export const SPECTRUM_BINS =
  Math.round((SPECTRUM_MAX_NM - SPECTRUM_MIN_NM) / SPECTRUM_STEP_NM) + 1;

/** Wavelength of every bin centre, in nanometres. */
export const WAVELENGTHS_NM = (() => {
  const a = new Float64Array(SPECTRUM_BINS);
  for (let i = 0; i < SPECTRUM_BINS; i++) a[i] = SPECTRUM_MIN_NM + i * SPECTRUM_STEP_NM;
  return a;
})();

/* Physical constants (SI, CODATA 2018). */
export const PLANCK_H = 6.62607015e-34;      // J s
export const LIGHT_C = 2.99792458e8;         // m / s
export const BOLTZMANN_K = 1.380649e-23;     // J / K
export const WIEN_B = 2.897771955e-3;        // m K

/** Allocate a zeroed spectrum. */
export function specNew() {
  return new Float64Array(SPECTRUM_BINS);
}

/** Allocate a spectrum filled with a constant. */
export function specConst(value) {
  const s = new Float64Array(SPECTRUM_BINS);
  s.fill(value);
  return s;
}

export function specCopy(src) {
  return Float64Array.from(src);
}

/** out[i] += src[i] * scale  (in place, returns out) */
export function specAddScaled(out, src, scale) {
  for (let i = 0; i < SPECTRUM_BINS; i++) out[i] += src[i] * scale;
  return out;
}

/** out[i] *= scale (in place, returns out) */
export function specScale(out, scale) {
  for (let i = 0; i < SPECTRUM_BINS; i++) out[i] *= scale;
  return out;
}

/** Element-wise product into a new array. */
export function specMul(a, b) {
  const out = new Float64Array(SPECTRUM_BINS);
  for (let i = 0; i < SPECTRUM_BINS; i++) out[i] = a[i] * b[i];
  return out;
}

/** Sum of all bins multiplied by the bin width (a crude integral). */
export function specIntegral(s) {
  let sum = 0;
  for (let i = 0; i < SPECTRUM_BINS; i++) sum += s[i];
  return sum * SPECTRUM_STEP_NM;
}

export function specMax(s) {
  let m = 0;
  for (let i = 0; i < SPECTRUM_BINS; i++) if (s[i] > m) m = s[i];
  return m;
}

/**
 * Planck's law: spectral radiance of a black body, in W / (m^2 sr m).
 *
 *     B(lambda, T) = 2 h c^2 / lambda^5  *  1 / (exp(h c / (lambda k T)) - 1)
 *
 * @param {number} lambdaNm wavelength in nanometres
 * @param {number} temperatureK absolute temperature in kelvin
 */
export function planckSpectralRadiance(lambdaNm, temperatureK) {
  if (temperatureK <= 0) return 0;
  const lambda = lambdaNm * 1e-9;
  const l5 = lambda * lambda * lambda * lambda * lambda;
  const numerator = 2 * PLANCK_H * LIGHT_C * LIGHT_C / l5;
  const exponent = (PLANCK_H * LIGHT_C) / (lambda * BOLTZMANN_K * temperatureK);
  // exp() overflows for cold stars at short wavelengths; the limit is simply 0.
  if (exponent > 700) return 0;
  return numerator / (Math.expm1(exponent));
}

/** Wien displacement law: wavelength of peak emission, in nanometres. */
export function wienPeakNm(temperatureK) {
  if (temperatureK <= 0) return Infinity;
  return (WIEN_B / temperatureK) * 1e9;
}

/**
 * Black-body spectrum sampled on the standard grid.
 *
 * @param {number} temperatureK
 * @param {'peak'|'none'} normalize  'peak' rescales so the largest bin is 1,
 *        which keeps numbers in a friendly range for display. Absolute
 *        photometric scaling is applied later, by the colorimetry module.
 */
export function makeBlackbodySpectrum(temperatureK, normalize = 'peak') {
  const s = new Float64Array(SPECTRUM_BINS);
  for (let i = 0; i < SPECTRUM_BINS; i++) {
    s[i] = planckSpectralRadiance(WAVELENGTHS_NM[i], temperatureK);
  }
  if (normalize === 'peak') {
    const m = specMax(s);
    if (m > 0) specScale(s, 1 / m);
  }
  return s;
}

/**
 * Approximate sRGB colour of a single wavelength, used only to tint the
 * spectrum graph and the illustrative photon paths. It is a display aid, never
 * an input to the physics.
 */
export function wavelengthToDisplayRgb(lambdaNm) {
  let r = 0, g = 0, b = 0;
  const w = lambdaNm;
  if (w >= 380 && w < 440) { r = -(w - 440) / 60; b = 1; }
  else if (w < 490) { g = (w - 440) / 50; b = 1; }
  else if (w < 510) { g = 1; b = -(w - 510) / 20; }
  else if (w < 580) { r = (w - 510) / 70; g = 1; }
  else if (w < 645) { r = 1; g = -(w - 645) / 65; }
  else if (w <= 780) { r = 1; }
  let falloff = 1;
  if (w > 700) falloff = 0.3 + 0.7 * (780 - w) / 80;
  else if (w < 420) falloff = 0.3 + 0.7 * (w - 380) / 40;
  const gamma = 0.8;
  const enc = (c) => Math.round(255 * Math.pow(Math.max(0, Math.min(1, c * falloff)), gamma));
  return [enc(r), enc(g), enc(b)];
}

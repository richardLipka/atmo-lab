/**
 * Colour science: spectrum -> CIE 1931 XYZ -> sRGB.
 *
 * No colour anywhere in this application is chosen by hand. Every sky tint,
 * every star swatch and every gradient band is the end of this pipeline:
 *
 *   1. integrate the observed spectral irradiance against the CIE 1931
 *      colour matching functions to get tristimulus values X, Y, Z;
 *   2. map XYZ into linear sRGB with the standard 3x3 matrix;
 *   3. bring the result into gamut, then apply the display transfer function.
 */

import { SPECTRUM_BINS, SPECTRUM_STEP_NM, WAVELENGTHS_NM } from './spectrum.js';

/**
 * Build a colorimetry object from the CIE data file.
 * The colour matching functions must already be on the standard grid.
 */
export function createColorimetry(cieConfig) {
  if (cieConfig.count !== SPECTRUM_BINS ||
      cieConfig.wavelengthStart_nm !== WAVELENGTHS_NM[0] ||
      cieConfig.wavelengthStep_nm !== SPECTRUM_STEP_NM) {
    throw new Error('CIE table does not match the spectral grid');
  }

  const xBar = Float64Array.from(cieConfig.xBar);
  const yBar = Float64Array.from(cieConfig.yBar);
  const zBar = Float64Array.from(cieConfig.zBar);
  const M = cieConfig.xyzToLinearSRGB;

  /** Integral of yBar over the grid; the normaliser for photometric units. */
  let yBarIntegral = 0;
  for (let i = 0; i < SPECTRUM_BINS; i++) yBarIntegral += yBar[i];
  yBarIntegral *= SPECTRUM_STEP_NM;

  /**
   * Tristimulus values of a spectral power distribution.
   *   X = k * sum I(lambda) xBar(lambda) dLambda      (likewise Y and Z)
   * with k = 1, so Y is a relative luminance in the same arbitrary units as
   * the input spectrum.
   */
  function spectrumToXYZ(spec) {
    let X = 0, Y = 0, Z = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const v = spec[i];
      X += v * xBar[i];
      Y += v * yBar[i];
      Z += v * zBar[i];
    }
    return [X * SPECTRUM_STEP_NM, Y * SPECTRUM_STEP_NM, Z * SPECTRUM_STEP_NM];
  }

  /** Relative luminance Y only - cheaper when the hue is not needed. */
  function luminance(spec) {
    let Y = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) Y += spec[i] * yBar[i];
    return Y * SPECTRUM_STEP_NM;
  }

  /** CIE 1931 chromaticity coordinates. */
  function xyzToChromaticity([X, Y, Z]) {
    const sum = X + Y + Z;
    if (sum <= 0) return [0.3127, 0.3290];
    return [X / sum, Y / sum];
  }

  /** Linear (un-encoded) sRGB primaries. Components may fall outside [0,1]. */
  function xyzToLinearRgb([X, Y, Z]) {
    return [
      M[0][0] * X + M[0][1] * Y + M[0][2] * Z,
      M[1][0] * X + M[1][1] * Y + M[1][2] * Z,
      M[2][0] * X + M[2][1] * Y + M[2][2] * Z,
    ];
  }

  /**
   * The sRGB electro-optical transfer function, inverted. Its slope matches a
   * pure power law of gamma = 2.2 closely enough that the two are
   * interchangeable for teaching; 'gamma22' selects the plain power law.
   */
  function encodeComponent(c, transfer = 'srgb') {
    const v = Math.max(0, Math.min(1, c));
    if (transfer === 'gamma22') return Math.pow(v, 1 / 2.2);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  }

  /**
   * Bring a linear RGB triplet into the displayable cube without changing its
   * hue more than necessary.
   *
   *   - a negative component means the colour is outside the sRGB gamut, so we
   *     add just enough white to reach the gamut boundary (desaturation);
   *   - a component above 1 means the colour is brighter than the display can
   *     show, so every component is divided by the maximum. Scaling all three
   *     by one factor keeps their ratios, and therefore the hue, intact.
   */
  function fitToGamut(rgb) {
    let [r, g, b] = rgb;
    let desaturated = false, clipped = false;
    const min = Math.min(r, g, b);
    if (min < 0) {
      r -= min; g -= min; b -= min;
      desaturated = true;
    }
    const max = Math.max(r, g, b);
    if (max > 1) {
      r /= max; g /= max; b /= max;
      clipped = true;
    }
    return { rgb: [r, g, b], desaturated, clipped };
  }

  /**
   * Full pipeline. `exposure` scales the spectrum before conversion and is the
   * only place where an arbitrary display choice enters; it never changes the
   * ratios between wavelengths, so it cannot change the hue.
   */
  function spectrumToSrgb(spec, exposure = 1, transfer = 'srgb') {
    const xyz = spectrumToXYZ(spec);
    const scaled = [xyz[0] * exposure, xyz[1] * exposure, xyz[2] * exposure];
    const linear = xyzToLinearRgb(scaled);
    const fitted = fitToGamut(linear);
    const enc = fitted.rgb.map((c) => encodeComponent(c, transfer));
    const bytes = enc.map((c) => Math.round(c * 255));
    return {
      xyz,
      chromaticity: xyzToChromaticity(xyz),
      luminance: xyz[1],
      linear: fitted.rgb,
      rgb: bytes,
      css: `rgb(${bytes[0]}, ${bytes[1]}, ${bytes[2]})`,
      desaturated: fitted.desaturated,
      clipped: fitted.clipped,
    };
  }

  /** Rescale a spectrum in place so that its luminance equals `targetY`. */
  function normalizeToLuminance(spec, targetY = 1) {
    const Y = luminance(spec);
    if (Y > 0) {
      const k = targetY / Y;
      for (let i = 0; i < SPECTRUM_BINS; i++) spec[i] *= k;
    }
    return spec;
  }

  /** xy coordinates of every monochromatic wavelength - the spectral locus. */
  function spectralLocus() {
    const pts = [];
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const X = xBar[i], Y = yBar[i], Z = zBar[i];
      const sum = X + Y + Z;
      if (sum > 1e-6) pts.push({ lambda: WAVELENGTHS_NM[i], x: X / sum, y: Y / sum });
    }
    return pts;
  }

  return {
    xBar, yBar, zBar, yBarIntegral,
    spectrumToXYZ, luminance, xyzToChromaticity, xyzToLinearRgb,
    encodeComponent, fitToGamut, spectrumToSrgb, normalizeToLuminance,
    spectralLocus,
  };
}

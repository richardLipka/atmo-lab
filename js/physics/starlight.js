/**
 * Starlight from straight overhead, and how much of a field of view it makes.
 *
 * The old claim is that from the bottom of a deep well you can see stars by
 * day. The cross-section draws the reason anyone believes it: a star sends its
 * light down the shaft as surely as onto open ground, and the shaft walls take
 * away almost all of the scattered sunlight that floods the eye in the open.
 *
 * What the walls cannot take away is the sky directly around the star. Its
 * radiance does not depend on the shaft at all - that is the well paradox - so
 * the star gains on the light in the field of view only in proportion to the
 * sky the rock has removed, and by day it starts from a deficit of billions.
 * This module computes the share honestly, so the picture can show the
 * mechanism without the panel overstating what it achieves.
 */

import { SPECTRUM_BINS, makeBlackbodySpectrum } from './spectrum.js';

/**
 * The star drawn overhead: as bright as Vega, visual magnitude 0, and about as
 * hot (an A0 star, near 9600 K). Its exact position does not matter; that it is
 * near the zenith does, because that is the one direction a vertical shaft
 * always leaves open.
 */
export const OVERHEAD_STAR = { magnitude: 0, temperatureK: 9600 };

/** The Sun's apparent visual magnitude at 1 AU. */
export const SUN_APPARENT_MAGNITUDE = -26.74;

/**
 * A star's illuminance in units of the Sun's at 1 AU - the unit this simulator
 * uses for every source: 10^(-0.4 (m - m_sun)). Magnitude 0 is 2.0e-11.
 */
export function starIlluminanceRelativeToSun(magnitude) {
  return Math.pow(10, -0.4 * (magnitude - SUN_APPARENT_MAGNITUDE));
}

/** Solid angle of a cone of the given half-angle, in steradians. */
export function coneSolidAngle(halfAngleDeg) {
  return 2 * Math.PI * (1 - Math.cos(halfAngleDeg * Math.PI / 180));
}

/**
 * The overhead star's illuminance at an observer, after the air above them.
 *
 * The star's spectrum is carried through the vertical column - molecules, haze
 * and ozone - and the loss is weighted by the eye's response, so a reddening
 * air mass costs what it should. Returned in the simulator's units: luminance
 * with the Sun at 1 AU equal to one.
 */
export function overheadStarIlluminance(atmosphere, colorimetry, altitude, star = OVERHEAD_STAR) {
  const spectrum = makeBlackbodySpectrum(star.temperatureK);
  const z = Math.max(0, altitude);
  const transmitted = atmosphere.transmittance(
    atmosphere.verticalColumnRayleigh(z),
    atmosphere.verticalColumnAerosol(z),
    atmosphere.verticalColumnOzone(z));
  const through = new Float64Array(SPECTRUM_BINS);
  for (let i = 0; i < SPECTRUM_BINS; i++) through[i] = spectrum[i] * transmitted[i];
  const before = colorimetry.luminance(spectrum);
  const fraction = before > 0 ? colorimetry.luminance(through) / before : 0;
  return starIlluminanceRelativeToSun(star.magnitude) * fraction;
}

/**
 * What share of the light collected over a field of view comes from the star.
 *
 *     star / (star + L_mean * Omega)
 *
 * L_mean is the mean luminance over the field of view with the rock counted as
 * the nothing it delivers - the "how bright it looks here" reading - so a shaft
 * lowers the sky term by exactly the share of the view it takes away, and does
 * not touch the radiance of the patch beside the star.
 */
export function starShareOfView({ starIlluminance, meanLuminance, fieldSolidAngle }) {
  const sky = Math.max(0, meanLuminance) * fieldSolidAngle;
  const total = starIlluminance + sky;
  return total > 0 ? starIlluminance / total : 0;
}

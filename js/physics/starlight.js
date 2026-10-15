/**
 * Starlight from straight overhead, and whether it can be seen against the sky.
 *
 * The old claim - Aristotle's - is that from the bottom of a deep well you can
 * see stars by day. It is false, and it was tested: Hynek and Winsor looked
 * for Vega and Pollux up tall chimneys and saw nothing, even with binoculars.
 *
 * A star is a point. What it has to outshine is not the whole sky but the
 * patch of sky the eye cannot tell apart from it - one resolution element of
 * the eye, about one arcminute across. That patch has the radiance of the sky
 * in the star's direction, and a shaft does not change that radiance at all:
 * it is the well paradox. So the comparison that decides visibility,
 *
 *     star illuminance  /  (sky radiance x solid angle of one arcminute),
 *
 * is the same at the bottom of a well as on open ground. What changes it is the
 * sky going dark: at night, or on a world with no air to scatter sunlight.
 */

import { SPECTRUM_BINS, makeBlackbodySpectrum } from './spectrum.js';

/**
 * The star drawn overhead: as bright as Vega, visual magnitude 0, and about as
 * hot (an A0 star, near 9600 K). Vega is also the star Hynek and Winsor looked
 * for up a chimney.
 */
export const OVERHEAD_STAR = { magnitude: 0, temperatureK: 9600 };

/** Venus at its brightest, for comparison: it can be found by eye in daylight. */
export const VENUS_BRIGHTEST_MAGNITUDE = -4.6;

/** The Sun's apparent visual magnitude at 1 AU. */
export const SUN_APPARENT_MAGNITUDE = -26.74;

/** The smallest detail a normal eye resolves: about one arcminute. */
export const EYE_RESOLUTION_ARCMIN = 1;

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

/** Solid angle of the patch of sky one resolution element of the eye covers. */
export function eyeResolutionSolidAngle(arcmin = EYE_RESOLUTION_ARCMIN) {
  return coneSolidAngle(arcmin / 60 / 2);
}

/**
 * The overhead star's illuminance at an observer, after the air between them.
 *
 * `transmittance` is the spectrum the air passes straight up from where the
 * observer stands - including any air standing in a shaft - and the loss is
 * weighted by the eye's response, so a reddening path costs what it should.
 * Returned in the simulator's units: luminance with the Sun at 1 AU equal to one.
 */
export function overheadStarIlluminance(transmittance, colorimetry, star = OVERHEAD_STAR) {
  const spectrum = makeBlackbodySpectrum(star.temperatureK);
  const through = new Float64Array(SPECTRUM_BINS);
  for (let i = 0; i < SPECTRUM_BINS; i++) through[i] = spectrum[i] * transmittance[i];
  const before = colorimetry.luminance(spectrum);
  const fraction = before > 0 ? colorimetry.luminance(through) / before : 0;
  return starIlluminanceRelativeToSun(star.magnitude) * fraction;
}

/**
 * How bright the sunlit ground looks, in luminance per steradian.
 *
 * A matte surface lit by an illuminance E has a luminance rho E / pi, rho its
 * albedo. That is the brightness an eye standing on it adapts to - and on the
 * Moon, with an albedo near 0.14, it comes out about as bright as Earth's blue
 * daytime sky. So an eye on the sunlit Moon is in nearly the same position as
 * an eye on Earth by day, even though the sky above it is black.
 */
export function groundLuminance(albedo, illuminance) {
  return Math.max(0, albedo) * Math.max(0, illuminance) / Math.PI;
}

/**
 * How bright the star is against the sky right around it: the star's light
 * divided by the light of the patch of sky the eye cannot separate from it.
 * Above 1 the star outshines that patch; far below 1 it is lost in it.
 * Infinite when the sky behind it is black.
 */
export function starContrastAgainstSky({ starIlluminance, skyLuminance, patchSolidAngle = eyeResolutionSolidAngle() }) {
  const patch = Math.max(0, skyLuminance) * patchSolidAngle;
  if (!(patch > 0)) return starIlluminance > 0 ? Infinity : 0;
  return starIlluminance / patch;
}

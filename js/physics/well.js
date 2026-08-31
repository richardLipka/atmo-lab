/**
 * Well shaft geometry.
 *
 * This module exists to keep one idea strictly separate from the atmosphere
 * code: going down a shaft is a GEOMETRIC restriction, not an atmospheric one.
 *
 * An observer standing on the axis of a cylindrical shaft of radius R at depth
 * d looks out through the mouth of the shaft. A ray leaving at zenith angle
 * theta rises d and travels d*tan(theta) sideways, so it escapes only while
 *
 *     tan(theta) <= R / d
 *
 * Everything steeper hits the wall. The sky that remains visible is exactly as
 * bright and exactly the same colour as it was at ground level - there is just
 * far less of it. That is the whole of the well paradox.
 */

/** Half-angle of the visible cone of sky, in radians. */
export function wellApertureHalfAngle(depth, radius) {
  if (depth <= 0) return Math.PI / 2;
  if (radius <= 0) return 0;
  return Math.atan(radius / depth);
}

/** Is a viewing direction stopped by the shaft wall? */
export function wellIsBlocked(zenithRad, depth, radius) {
  if (depth <= 0) return false;
  if (zenithRad >= Math.PI / 2) return true;
  if (radius <= 0) return true;
  return Math.tan(zenithRad) > radius / depth;
}

/**
 * Solid angle of the visible cone, in steradians.
 *     Omega = 2 pi (1 - cos theta_max)
 * The open sky is a hemisphere, 2 pi sr.
 */
export function wellSolidAngle(halfAngleRad) {
  return 2 * Math.PI * (1 - Math.cos(halfAngleRad));
}

/** Visible sky as a fraction of the open hemisphere. */
export function wellSkyFraction(depth, radius) {
  return wellSolidAngle(wellApertureHalfAngle(depth, radius)) / (2 * Math.PI);
}

/**
 * Fraction of the horizontal illuminance that survives, assuming a sky of
 * uniform radiance.
 *
 *     E_cone / E_hemisphere = sin^2(theta_max)
 *
 * For a 1 m wide shaft 20 m deep this is about 0.0025: the light level drops
 * by a factor of four hundred while the patch of sky overhead stays exactly as
 * blue as before.
 */
export function wellIlluminanceFraction(depth, radius) {
  const s = Math.sin(wellApertureHalfAngle(depth, radius));
  return s * s;
}

/**
 * Distance from the observer to the point where a ray meets the shaft wall or
 * clears the mouth. Used only for drawing.
 */
export function wellRayHit(zenithRad, depth, radius) {
  if (depth <= 0) return null;
  const t = Math.tan(Math.min(zenithRad, Math.PI / 2 - 1e-6));
  if (zenithRad >= Math.PI / 2) return { type: 'wall', distance: radius, height: 0 };
  const heightToMouth = depth;
  const lateralAtMouth = heightToMouth * t;
  if (lateralAtMouth <= radius) {
    return { type: 'escapes', distance: heightToMouth / Math.cos(zenithRad), height: depth };
  }
  const heightAtWall = radius / Math.max(t, 1e-9);
  return { type: 'wall', distance: Math.hypot(radius, heightAtWall), height: heightAtWall };
}

/**
 * Extra air column inside an air-filled shaft, in metres of surface-equivalent
 * density. The exponential profile continued below datum gives
 *
 *     C_shaft = H (exp(d / H) - 1)
 *
 * The specification treats the column above the observer as unchanged when
 * descending, which isolates the geometric effect; this function powers an
 * optional advanced toggle that restores the real, denser shaft air.
 */
export function wellShaftColumn(depth, scaleHeight) {
  if (depth <= 0) return 0;
  return scaleHeight * (Math.exp(depth / scaleHeight) - 1);
}

/**
 * What share of an observer's field of view still has sky in it.
 *
 * An eye does not measure one direction; it collects a cone. A shaft leaves a
 * cap of sky of half-angle `apertureHalf` about the zenith, and the observer is
 * looking down a cone of half-angle `fieldHalf` whose axis is `offAxis` from
 * the zenith. What is wanted is the fraction of that cone's solid angle which
 * falls inside the cap - and with it, since radiance is what it is, how bright
 * the place looks.
 *
 * The overlap of two spherical caps has a closed form, but not a short one.
 * Three cases can be answered exactly: they do not meet, the aperture swallows
 * the field of view, and the aperture sits wholly inside it. In practice a
 * shaft is one of those three, because an aperture is either far narrower than
 * a field of view or wide enough to contain it. Only partial overlap is
 * interpolated, and the result is clamped: a wide shallow shaft must never
 * report more sky than a field of view can hold.
 *
 * @param {number} apertureHalf  half-angle of the sky the shaft leaves, radians
 * @param {number} fieldHalf     half-angle of the field of view, radians
 * @param {number} offAxis       angle from the zenith to the view axis, radians
 */
export function fieldOfViewSkyShare(apertureHalf, fieldHalf, offAxis) {
  if (!(fieldHalf > 0)) return 0;
  if (!(apertureHalf > 0)) return 0;
  if (apertureHalf >= Math.PI / 2) return 1;

  const away = Math.abs(offAxis);
  let overlap;
  if (away >= fieldHalf + apertureHalf) overlap = 0;
  else if (away + fieldHalf <= apertureHalf) overlap = 1 - Math.cos(fieldHalf);
  else if (away + apertureHalf <= fieldHalf) overlap = 1 - Math.cos(apertureHalf);
  else {
    const smaller = Math.min(apertureHalf, fieldHalf);
    const t = (fieldHalf + apertureHalf - away) / (2 * smaller);
    overlap = (1 - Math.cos(smaller)) * Math.max(0, Math.min(1, t));
  }
  return Math.max(0, Math.min(1, overlap / (1 - Math.cos(fieldHalf))));
}

/**
 * Minimal 3D vector maths and ray/sphere intersection.
 *
 * The world is a sphere of radius R centred on the origin. The observer stands
 * on the +Y axis, so the local "up" direction is simply the normalised
 * position vector. Working on a sphere rather than a flat slab is not a
 * refinement here, it is essential: a flat atmosphere has an infinite path
 * length at the horizon, and the sunset experiment would never terminate.
 */

export function v3(x, y, z) { return { x, y, z }; }

export function v3add(a, b) { return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }; }

export function v3scale(a, s) { return { x: a.x * s, y: a.y * s, z: a.z * s }; }

/** a + b * s, the fused form used inside the ray-marching inner loops. */
export function v3addScaled(a, b, s) {
  return { x: a.x + b.x * s, y: a.y + b.y * s, z: a.z + b.z * s };
}

export function v3dot(a, b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

export function v3length(a) { return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z); }

export function v3normalize(a) {
  const l = v3length(a);
  return l > 0 ? { x: a.x / l, y: a.y / l, z: a.z / l } : { x: 0, y: 1, z: 0 };
}

export const DEG = Math.PI / 180;

/**
 * Unit direction from a zenith angle and an azimuth, in the local frame of an
 * observer standing on the +Y axis.
 *   theta = 0    -> straight up
 *   theta = 90   -> the horizon
 *   phi   = 0    -> towards the Sun's azimuth
 */
export function directionFromAngles(zenithRad, azimuthRad) {
  const st = Math.sin(zenithRad);
  return {
    x: st * Math.cos(azimuthRad),
    y: Math.cos(zenithRad),
    z: st * Math.sin(azimuthRad),
  };
}

/** Direction towards a star at a given elevation above the horizon. */
export function sunDirectionFromElevation(elevationDeg) {
  const e = elevationDeg * DEG;
  return { x: Math.cos(e), y: Math.sin(e), z: 0 };
}

/**
 * Distance from `origin` along `dir` to the far intersection with a sphere of
 * radius R centred at the origin. Returns -1 if the ray misses.
 * Used to find where a ray leaves the top of the atmosphere.
 */
export function raySphereFar(origin, dir, R) {
  const b = v3dot(origin, dir);
  const c = v3dot(origin, origin) - R * R;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b + Math.sqrt(disc);
}

/**
 * Distance to the near intersection with a sphere of radius R, but only if it
 * lies ahead of the origin. Returns -1 when the ray does not hit.
 * Used to test whether a ray runs into the ground.
 */
export function raySphereNear(origin, dir, R) {
  const b = v3dot(origin, dir);
  const c = v3dot(origin, origin) - R * R;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const t = -b - Math.sqrt(disc);
  return t > 1e-6 ? t : -1;
}

/**
 * Application state and the rules that keep it physically coherent.
 *
 * One object holds everything the user can change. Panels subscribe to it and
 * are told which paths moved, so a slider drag repaints the spectrum without
 * rebuilding the whole interface.
 */

/**
 * Vertical extent of the cross-section, in metres, at either end of the zoom.
 *
 * These live here because this is where the invariant is enforced, and they got
 * out of step once already: the renderer was widened to let the zoom reach a
 * twenty-metre shaft while the store went on clamping to five kilometres, so
 * every attempt to zoom in on a shaft silently snapped back and the shaft could
 * not be seen at all. One definition, imported by whoever needs it.
 */
export const MIN_SPAN_M = 20;
export const MAX_SPAN_M = 6e6;

/** The zoom is a physical extent, so it has physical limits. */
export function clampSpan(span) {
  return Math.max(MIN_SPAN_M, Math.min(MAX_SPAN_M, span));
}

export const DEFAULT_STATE = {
  language: 'cs',
  level: 'basic',
  experimentId: null,
  experimentStep: 0,

  star: {
    presetId: 'sun-5800k',
    temperatureK: 5800,
    elevationDeg: 55,
    realisticInsolation: true,
  },

  atmosphere: {
    presetId: 'earth',
    densityScale: 1,
    scaleHeight_m: null,   // null means "use the value from the preset"
    aerosolScale: 1,
    aerosolPresetId: null,   // null means 'the haze this world came with'
    rayleighExponent: 4,
  },

  observer: {
    z: 0,
    viewZenithDeg: 35,
    viewAzimuthDeg: 180,
    countShaftAir: false,
    well: { enabled: false, radius_m: 1.5, depth_m: 50 },
  },

  // Null means "fit the frame to the air"; a number is a vertical extent in
  // metres, chosen with the zoom control or the mouse wheel.
  camera: { span_m: null },

  rays: {
    count: 600,
    showScattering: true,
    animate: true,
    brightness: 1,
    quality: 'normal',
  },

  compare: { enabled: false, leftZ: 10000, rightZ: -10000 },
};

/** Highest altitude the position control can reach, in metres. */
export function maxAltitudeFor(atmosphereConfig) {
  return Math.max(100000, atmosphereConfig?.topAltitude_m ?? 100000);
}

/**
 * The vertical control is one continuous coordinate that has to span a two
 * metre well and a hundred kilometre climb. A signed power law gives metre
 * resolution near the ground while still reaching space at the end of travel.
 */
const SLIDER_RANGE = 1000;
const SLIDER_POWER = 2.5;

export function sliderToZ(slider, maxAltitude, maxDepth) {
  const t = Math.abs(slider) / SLIDER_RANGE;
  const magnitude = Math.pow(t, SLIDER_POWER);
  return slider >= 0 ? magnitude * maxAltitude : -magnitude * maxDepth;
}

export function zToSlider(z, maxAltitude, maxDepth) {
  const span = z >= 0 ? maxAltitude : maxDepth;
  if (span <= 0) return 0;
  const t = Math.pow(Math.min(1, Math.abs(z) / span), 1 / SLIDER_POWER);
  return Math.round((z >= 0 ? t : -t) * SLIDER_RANGE);
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deep merge a patch into a target, recording the dotted paths that changed. */
function mergeInto(target, patch, changed, prefix = '') {
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeInto(target[key], value, changed, path);
    } else if (target[key] !== value) {
      target[key] = value;
      changed.add(path);
      // Mark ancestors so coarse subscribers can watch a whole section.
      let p = prefix;
      while (p) { changed.add(p); p = p.includes('.') ? p.slice(0, p.lastIndexOf('.')) : ''; }
    }
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function createStore(initial = DEFAULT_STATE) {
  const state = clone(initial);
  const listeners = new Set();
  let context = { maxAltitude: 100000 };

  /**
   * Enforce the invariants that make the model meaningful:
   * being below datum means being in a shaft, and the shaft is what limits
   * how far down the observer can go.
   */
  function reconcile(changed) {
    const obs = state.observer;
    // Inside a shaft you are somewhere between its bottom and its mouth, and
    // nowhere else: the cross-section shows the shaft the whole time the shaft
    // is switched on, so the position control must not be able to leave it.
    const maxDepth = obs.well.enabled ? obs.well.depth_m : 0;
    const ceiling = obs.well.enabled ? 0 : context.maxAltitude;
    const clamped = Math.max(-maxDepth, Math.min(ceiling, obs.z));
    if (clamped !== obs.z) {
      obs.z = clamped;
      changed.add('observer.z');
      changed.add('observer');
    }
    const span = state.camera.span_m;
    if (span != null) {
      const fixed = clampSpan(span);
      if (fixed !== span) {
        state.camera.span_m = fixed;
        changed.add('camera.span_m');
        changed.add('camera');
      }
    }
    if (state.compare.enabled) {
      const depth = Math.max(obs.well.depth_m, 1);
      const right = Math.max(-depth, Math.min(0, state.compare.rightZ));
      if (right !== state.compare.rightZ) {
        state.compare.rightZ = right;
        changed.add('compare.rightZ');
        changed.add('compare');
      }
    }
  }

  function notify(changed) {
    if (changed.size === 0) return;
    listeners.forEach((fn) => fn(state, changed));
  }

  return {
    get state() { return state; },

    /** Tell the store about limits that depend on the loaded configuration. */
    setContext(next) { context = { ...context, ...next }; },

    /** Apply a partial update; nested objects are merged, not replaced. */
    patch(update) {
      const changed = new Set();
      mergeInto(state, update, changed);
      reconcile(changed);
      notify(changed);
      return changed;
    },

    /** Replace the whole state, used by Reset. */
    reset(next = DEFAULT_STATE) {
      const changed = new Set();
      mergeInto(state, clone(next), changed);
      reconcile(changed);
      notify(changed);
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    snapshot() { return clone(state); },
  };
}

/** True if any changed path falls under one of the given prefixes. */
export function touches(changed, ...prefixes) {
  for (const path of changed) {
    for (const prefix of prefixes) {
      if (path === prefix || path.startsWith(prefix + '.')) return true;
    }
  }
  return false;
}

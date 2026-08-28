/**
 * Application state and the rules that keep it physically coherent.
 *
 * One object holds everything the user can change. Panels subscribe to it and
 * are told which paths moved, so a slider drag repaints the spectrum without
 * rebuilding the whole interface.
 */

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
    const maxDepth = obs.well.enabled ? obs.well.depth_m : 0;
    const clamped = Math.max(-maxDepth, Math.min(context.maxAltitude, obs.z));
    if (clamped !== obs.z) {
      obs.z = clamped;
      changed.add('observer.z');
      changed.add('observer');
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

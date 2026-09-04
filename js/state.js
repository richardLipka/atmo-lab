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

/**
 * One observer, complete: where they stand, where they look, the shaft they
 * stand in, and how much of the world their own frame shows.
 *
 * It is a factory rather than a constant because there are two of these in the
 * state and they must not share a single nested `well` object between them -
 * moving one observer's shaft would otherwise move the other's.
 */
export function makeObserver(overrides = {}) {
  return {
    z: 0,
    viewZenithDeg: 35,
    viewAzimuthDeg: 180,
    countShaftAir: false,
    /**
     * Vertical extent of THIS observer's frame, in metres; null means "fit the
     * frame to the air". The zoom belongs to the observer and not to one global
     * camera because the two observers being compared are looking at wildly
     * different things - a shaft two metres across beside a hundred kilometres
     * of air - and a single shared zoom can only ever be right for one of them.
     */
    span_m: null,
    ...overrides,
    well: { enabled: false, radius_m: 1.5, depth_m: 50, ...(overrides.well ?? {}) },
  };
}

/**
 * The three things that make one simulation: a star, an atmosphere, and an
 * observer standing in it.
 *
 * Everything else in the state is about the PAGE rather than about a
 * simulation - which language it speaks, how many rays it draws, how bright it
 * draws them. That line is the whole of what makes the comparison legible: a
 * control either changes one of the situations being compared, or it changes
 * how both of them are drawn, and the interface says which.
 */
export const SIMULATION_KEYS = ['star', 'atmosphere', 'observer'];

export function makeSimulation(overrides = {}) {
  return {
    star: {
      presetId: 'sun-5800k',
      temperatureK: 5800,
      elevationDeg: 55,
      realisticInsolation: true,
      ...(overrides.star ?? {}),
    },
    atmosphere: {
      presetId: 'earth',
      densityScale: 1,
      scaleHeight_m: null,   // null means "use the value from the preset"
      aerosolScale: 1,
      aerosolPresetId: null,   // null means 'the haze this world came with'
      rayleighExponent: 4,
      ...(overrides.atmosphere ?? {}),
    },
    observer: makeObserver(overrides.observer ?? {}),
  };
}

export const DEFAULT_STATE = {
  language: 'cs',
  level: 'basic',
  experimentId: null,
  experimentStep: 0,

  // Simulation A lives at the top level, so it has no prefix and nothing that
  // speaks of "the star" or "the observer" had to learn about the comparison.
  ...makeSimulation(),

  /**
   * How both simulations are DRAWN, and therefore shared by both.
   *
   * The display exposure especially: two panels rendered at two gains cannot be
   * compared by eye, which is the one thing the comparison is for. The ray
   * budget is a sampling choice rather than a physical one - the measured
   * colour divides what it collects by the directions it looked in, so doubling
   * the rays leaves every answer where it was - so it is shared too, and the
   * control panel says so above the section.
   */
  rays: {
    count: 600,
    showScattering: true,
    animate: true,
    brightness: 1,
    quality: 'normal',
    /**
     * How the drawn paths are shared out between the families.
     *
     * These tune the PICTURE and nothing else. The measured colour divides the
     * light it collects by the number of directions it looked in, so halving
     * the arriving rays halves both and leaves the answer exactly where it was;
     * a test pins that. What they change is what the cross-section chooses to
     * show you, and the defaults are frankly unfaithful: 88 % of the drawn
     * paths are scattering events when the real figure for Earth's air is about
     * a sixth. Switch `physical` on to see the honest budget.
     */
    mix: {
      scatterShare: 0.88,
      arrivingShare: 0.6818,
      physical: false,
    },
  },

  /**
   * The second simulation, and which of the two the interface answers for.
   *
   * There is no separate "comparison mode" state. Switching the comparison on
   * adds a second simulation of exactly the same kind - its own star, its own
   * air, its own observer - and `active` says which one the controls edit,
   * which one the readouts describe, and which panel is drawn as the selected
   * one. That is the whole of it, and it is why nothing downstream has to ask
   * whether a comparison is running before it can say what a number means.
   */
  compare: {
    enabled: false,
    active: 'a',
    b: makeSimulation({ observer: { z: 10000 } }),
  },
};

/** Which simulation the interface is pointed at: 'a' or 'b'. */
export function activeSimulationId(state) {
  return state.compare.enabled && state.compare.active === 'b' ? 'b' : 'a';
}

/**
 * One simulation by id. Simulation A *is* the top of the state, which is why
 * switching the comparison off needs no migration: what is left is A.
 */
export function simulationOf(state, id) {
  return id === 'b' ? state.compare.b : state;
}

/** The simulation the interface is pointed at. */
export function activeSimulation(state) {
  return simulationOf(state, activeSimulationId(state));
}

/** The observer the interface is pointed at. */
export function activeObserver(state) {
  return activeSimulation(state).observer;
}

/**
 * The prefix that names the selected simulation's half of the state: nothing
 * for A, since A has no prefix, and `compare.b` for B.
 */
export function activeSimulationPath(state) {
  return activeSimulationId(state) === 'b' ? 'compare.b' : '';
}

/**
 * Every simulation being run, in the order their panels are drawn. One
 * normally; two when the comparison is on, and then each gets its own
 * atmosphere, its own trace, its own strip and its own histogram, because a
 * measurement made for one says nothing about the other.
 */
export function simulationsOf(state) {
  const list = [{ id: 'a', sim: state }];
  if (state.compare.enabled) list.push({ id: 'b', sim: state.compare.b });
  return list;
}

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
  // How high each simulation's observer may climb, which is a property of that
  // simulation's own world - the two can be different worlds.
  let context = { maxAltitude: { a: 100000, b: 100000 } };

  /** Mark a path as changed, and every prefix of it, for coarse subscribers. */
  function mark(changed, path) {
    changed.add(path);
    let p = path;
    while (p.includes('.')) {
      p = p.slice(0, p.lastIndexOf('.'));
      changed.add(p);
    }
  }

  /**
   * The invariants that belong to an observer, applied to whichever observer
   * this is. Both of them get the same treatment: the second observer is not a
   * lesser thing that only carries an altitude, it is an observer.
   */
  function reconcileObserver(obs, prefix, changed, maxAltitude) {
    // Inside a shaft you are somewhere between its bottom and its mouth, and
    // nowhere else: the cross-section shows the shaft the whole time the shaft
    // is switched on, so the position control must not be able to leave it.
    const maxDepth = obs.well.enabled ? obs.well.depth_m : 0;
    const ceiling = obs.well.enabled ? 0 : maxAltitude;
    const clamped = Math.max(-maxDepth, Math.min(ceiling, obs.z));
    if (clamped !== obs.z) {
      obs.z = clamped;
      mark(changed, `${prefix}.z`);
    }
    const span = obs.span_m;
    if (span != null) {
      const fixed = clampSpan(span);
      if (fixed !== span) {
        obs.span_m = fixed;
        mark(changed, `${prefix}.span_m`);
      }
    }
  }

  /**
   * Enforce the invariants that make the model meaningful: being below datum
   * means being in a shaft, the shaft limits how far down the observer can go,
   * and both observers are held to it, not just the one being edited.
   */
  function reconcile(changed) {
    reconcileObserver(state.observer, 'observer', changed, context.maxAltitude.a);
    reconcileObserver(state.compare.b.observer, 'compare.b.observer', changed,
      context.maxAltitude.b);
    // The drawing budget is a pair of shares, and a share outside [0, 1] is not
    // a share. Nothing downstream would crash on one, but the tracer would draw
    // a family with a negative population and the picture would quietly lose it.
    const mix = state.rays.mix;
    for (const key of ['scatterShare', 'arrivingShare']) {
      const value = Math.max(0, Math.min(1, mix[key]));
      if (value !== mix[key]) {
        mix[key] = value;
        changed.add(`rays.mix.${key}`);
        changed.add('rays.mix');
      }
    }
    // Only two observers exist, so only two answers are meaningful. A stray
    // value here would leave the controls editing nobody.
    if (state.compare.active !== 'a' && state.compare.active !== 'b') {
      state.compare.active = 'a';
      mark(changed, 'compare.active');
    }
  }

  function notify(changed) {
    if (changed.size === 0) return;
    listeners.forEach((fn) => fn(state, changed));
  }

  return {
    get state() { return state; },

    /** Tell the store about limits that depend on the loaded configuration. */
    setContext(next) {
      const ceiling = next.maxAltitude;
      context = {
        ...context,
        ...next,
        maxAltitude: typeof ceiling === 'number'
          ? { a: ceiling, b: ceiling }
          : { ...context.maxAltitude, ...(ceiling ?? {}) },
      };
    },

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

/**
 * Application bootstrap.
 *
 * Wiring only: load the configuration, build the physics, build the interface,
 * and keep the two in step. The loop recomputes the model at most once per
 * frame and only when something actually changed, so dragging a slider stays
 * responsive while an idle page costs nothing.
 */

import { loadConfiguration } from './config-loader.js';
import { createI18n } from './i18n.js';
import {
  createStore, DEFAULT_STATE, maxAltitudeFor, touches, clampSpan,
} from './state.js';
import { createColorimetry } from './physics/color.js';
import { createSimulation } from './simulation.js';
import { createSceneRenderer, formatAltitude, autoSpanFor } from './render/scene-renderer.js';
import { createSkyStrip } from './render/sky-strip.js';
import { createSpectrumChart } from './render/spectrum-chart.js';
import { createChromaticityPlot } from './render/chromaticity.js';
import {
  tracePhotons, summarisePhotons, histogramPhotons, skyFromRays,
  shaftWallSpectrum, VIEW_CONE_HALF_DEG,
} from './render/photons.js';
import { createBeamHistogram } from './render/beam-histogram.js';
import { createControls } from './ui/controls.js';
import { createPanels } from './ui/panels.js';
import { createExplanation } from './ui/explanation.js';
import { createExperiments } from './ui/experiments.js';

const boot = document.getElementById('boot');
const bootMessage = document.getElementById('boot-message');

async function start() {
  const config = await loadConfiguration();
  const colorimetry = createColorimetry(config.colorimetryData);
  const i18n = createI18n(config.localization, config.index.defaults.language ?? 'cs');

  const store = createStore({ ...DEFAULT_STATE, language: i18n.getLanguage() });
  store.setContext({
    maxAltitude: maxAltitudeFor(config.atmospheres.get(DEFAULT_STATE.atmosphere.presetId)),
  });

  const simulation = createSimulation({ config, colorimetry });

  const sceneRenderer = createSceneRenderer(
    document.getElementById('scene-canvas'), { i18n, colorimetry });
  const skyStrip = createSkyStrip(
    document.getElementById('sky-canvas'), { i18n, colorimetry });
  const beamHistogram = createBeamHistogram(
    document.getElementById('histogram-canvas'), { i18n });
  const spectrumChart = createSpectrumChart(document.getElementById('spectrum-canvas'), { i18n });
  const chromaticity = createChromaticityPlot(
    document.getElementById('chroma-canvas'), { colorimetry, i18n });

  const controls = createControls(
    document.getElementById('controls-root'), { store, i18n, config });
  const panels = createPanels(
    document.getElementById('right-panel'),
    { i18n, store, spectrumChart, chromaticity, colorimetry });
  const explanation = createExplanation(
    document.getElementById('explain-panel'), { i18n, store });
  const experiments = createExperiments(
    document.getElementById('experiment-panel'),
    { i18n, store, config, onHighlight: (id) => id && controls.highlight(id) });

  /* ---- derived data, recomputed only when its inputs move ---- */

  let result = null;
  /**
   * Everything traced, by observer id.
   *
   * Each observer gets their OWN trace, their own rock and their own sweep of
   * the sky. The comparison used to trace once and draw the result twice at two
   * heights, which meant the second panel showed the first observer's rays with
   * a different label under them - and the strip beneath both had to fall back
   * to theory, because one trace cannot answer for two observers.
   */
  let traces = new Map();
  let needsPhysics = true;
  let needsPhotons = true;
  let needsPaint = true;

  function recomputePhysics() {
    result = simulation.run(store.state);
    needsPhysics = false;
  }

  /** Trace one observer, and measure everything that comes off those rays. */
  function traceFor(observer, panels) {
    const state = store.state;
    const atmosphere = result.atmosphere;
    const photons = tracePhotons({
      atmosphere,
      source: result.source,
      sunElevationDeg: state.star.elevationDeg,
      observerZ: observer.z,
      well: observer.well,
      count: state.rays.showScattering ? state.rays.count : 0,
      starAngularRadiusDeg:
        config.stars.get(state.star.presetId)?.angularRadius_deg ?? 0.2665,
      mix: state.rays.mix,
      // The rays must be laid out over exactly the region that will be drawn,
      // so the renderer is asked rather than the geometry guessed at.
      ...sceneRenderer.frameFor(observer, atmosphere, panels),
      seed: 20260828,
    });
    const tally = summarisePhotons(photons, { source: result.source });
    // The rock the shaft is cut through, lit by the sky that reaches it. The
    // strip fills its wings with it and the cross-section paints the hole in
    // the ground with it, so the two cannot drift apart.
    const wall = photons.length > 0
      ? shaftWallSpectrum(photons, atmosphere.groundReflectance, {
        depth_m: observer.well.depth_m,
        radius_m: observer.well.radius_m,
        sunZenithRad: (90 - state.star.elevationDeg) * Math.PI / 180,
      })
      : null;
    // The strip under the picture is the colour swatch swept across the sky -
    // the same function, once per direction - so the two cannot disagree. It
    // depends only on the traced rays, so it is rebuilt exactly when they are.
    const sky = photons.length > 0
      ? skyFromRays(photons, { wall: observer.well.enabled ? wall : null })
      : null;
    return { photons, tally, wall, sky };
  }

  function recomputePhotons() {
    const panels = result.observers.length;
    traces = new Map(result.observers.map(
      ({ id, observer }) => [id, traceFor(observer, panels)]));
    needsPhotons = false;
  }

  /**
   * The observers as the views want them: the state, the physics and the rays
   * for each, joined up.
   *
   * Rebuilt on every publish rather than cached, because `result` is rebuilt
   * whenever anything changes and the evaluations inside a cached list would go
   * stale against it - one of those bugs that shows as a panel quietly
   * describing the state of two moves ago.
   */
  function stationsNow() {
    return result.observers.map((entry) => {
      const traced = traces.get(entry.id) ?? {};
      return {
        ...entry,
        ...traced,
        histogram: histogramFor(entry.observer, traced),
      };
    });
  }

  /**
   * Push freshly computed data into the views. This is the expensive half - it
   * rebuilds the atmospheric glow field and the readout DOM - so it runs only
   * when something actually changed, never once per animation frame.
   */
  function publish({ photonsChanged }) {
    const stations = stationsNow();
    const view = {
      state: store.state, result, stations, activeId: result.activeId,
    };
    sceneRenderer.update(view, { keepSelection: !photonsChanged });
    skyStrip.update(view);
    beamHistogram.update(view);
    // The readouts describe ONE observer: the selected one. Every number in
    // them is a property of a place someone is standing, and quoting two places
    // in one column of figures says nothing about either.
    const active = stations.find((entry) => entry.id === result.activeId) ?? stations[0];
    panels.update(result, active.tally, active.histogram);
    explanation.update(result);
    needsPaint = true;
  }

  /**
   * Bin the drawn beams for the histogram. The split between "reaches the
   * observer from where it is looking" and everything else is made here, from
   * the same angle the cross-section colours by, so the two agree by
   * construction rather than by coincidence.
   */
  function histogramFor(observer, traced) {
    if (!traced.photons) return null;
    const sign = Math.cos(observer.viewAzimuthDeg * Math.PI / 180) >= 0 ? 1 : -1;
    const axis = sign * observer.viewZenithDeg * Math.PI / 180;
    // The same wall the strip fills its wings with, so the swatch and the
    // column under the observer's direction are one colour, not two answers.
    return histogramPhotons(traced.photons, axis, VIEW_CONE_HALF_DEG * Math.PI / 180,
      observer.well.enabled ? traced.wall : null);
  }

  store.subscribe((state, changed) => {
    needsPhysics = true;
    needsPaint = true;
    if (touches(changed, 'atmosphere', 'star.elevationDeg', 'star.temperatureK',
      'star.presetId', 'star.realisticInsolation', 'rays.count', 'rays.showScattering',
      'rays.mix', 'compare.enabled',
      'observer.z', 'observer.well', 'observer.span_m',
      'compare.b.z', 'compare.b.well', 'compare.b.span_m')) {
      // Note what is absent. The viewing direction: the scattering events are a
      // property of the air and the star, not of where anyone is facing, so
      // turning the view restyles the existing rays rather than redrawing new
      // ones. And `compare.active`: choosing which observer the controls answer
      // for moves no one and changes no air, so both traces stand.
      needsPhotons = true;
    }
    if (touches(changed, 'atmosphere.presetId')) {
      store.setContext({
        maxAltitude: maxAltitudeFor(config.atmospheres.get(state.atmosphere.presetId)),
      });
    }

    if (touches(changed, 'atmosphere.presetId', 'star.presetId', 'star.temperatureK')) {
      // The histogram's held axis belongs to one world lit by one star, and
      // carrying it across to another would say something false about the new
      // one. The cross-section no longer holds anything: how many rays it draws
      // is now read off the air still above the observer, so it needs no memory
      // of how bright this world has ever been.
      beamHistogram.resetScale();
    }
    controls.update();
    syncHeader();
  });

  /* ---- header wiring ---- */

  const langToggle = document.getElementById('lang-toggle');
  const levelToggle = document.getElementById('level-toggle');
  const experimentSelect = document.getElementById('experiment-select');
  const resetButton = document.getElementById('reset-button');

  langToggle.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-lang]');
    if (!button) return;
    i18n.setLanguage(button.dataset.lang);
  });

  levelToggle.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-level]');
    if (!button) return;
    store.patch({ level: button.dataset.level });
  });

  experimentSelect.addEventListener('change', () => {
    const value = experimentSelect.value;
    if (value) experiments.start(value); else experiments.exit();
  });

  resetButton.addEventListener('click', () => {
    store.reset({ ...DEFAULT_STATE, language: i18n.getLanguage() });
    experimentSelect.value = '';
    experiments.exit();
  });

  function buildExperimentOptions() {
    const chosen = store.state.experimentId ?? '';
    experimentSelect.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = i18n.t('header.experimentNone');
    experimentSelect.appendChild(none);
    for (const item of experiments.listExperiments()) {
      const option = document.createElement('option');
      option.value = item.value;
      option.textContent = item.label;
      option.title = item.summary;
      experimentSelect.appendChild(option);
    }
    experimentSelect.value = chosen;
  }

  function syncHeader() {
    const state = store.state;
    langToggle.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.lang === i18n.getLanguage());
    });
    levelToggle.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.level === state.level);
    });
    document.body.dataset.level = state.level;
    if (experimentSelect.value !== (state.experimentId ?? '')) {
      experimentSelect.value = state.experimentId ?? '';
    }
  }

  i18n.onChange(() => {
    store.patch({ language: i18n.getLanguage() });
    buildExperimentOptions();
    controls.update();
    panels.refreshLegendText();
    experiments.render();
    if (result) publish({ photonsChanged: false });
    needsPaint = true;
  });

  /* ---- ray inspection ---- */

  const sceneCanvas = document.getElementById('scene-canvas');
  const rayLog = document.getElementById('ray-log');
  const rayLogBody = document.getElementById('ray-log-body');
  document.getElementById('ray-log-close').addEventListener('click', () => {
    sceneRenderer.setSelected(-1);
    rayLog.hidden = true;
    needsPaint = true;
  });

  sceneCanvas.addEventListener('mousemove', (event) => {
    const index = sceneRenderer.pick(event.clientX, event.clientY);
    sceneCanvas.style.cursor = index >= 0 ? 'pointer' : 'default';
    sceneRenderer.setHovered(index);
    needsPaint = true;
  });
  /**
   * The wheel zooms the cross-section. Multiplicative, because the interesting
   * range spans three orders of magnitude - from a picture of the air over your
   * head to one that shows the whole chord a low Sun has to cross.
   */
  sceneCanvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    // The panel under the pointer is the one that zooms, whether or not it is
    // the selected one. Direct manipulation needs no selection to be
    // unambiguous - you are pointing at the thing you are changing.
    const id = sceneRenderer.panelAt(event.clientX, event.clientY) ?? store.state.compare.active;
    const observer = id === 'b' ? store.state.compare.b : store.state.observer;
    const span = observer.span_m
      ?? autoSpanFor(result.atmosphere, observer.z, observer.well);
    const factor = Math.exp(event.deltaY * 0.0015);
    const patch = { span_m: clampSpan(span * factor) };
    store.patch(id === 'b' ? { compare: { b: patch } } : { observer: patch });
  }, { passive: false });

  sceneCanvas.addEventListener('mouseleave', () => {
    sceneRenderer.setHovered(-1);
    sceneCanvas.style.cursor = 'default';
    needsPaint = true;
  });
  sceneCanvas.addEventListener('click', (event) => {
    // Clicking the panel that is not selected selects it, and does nothing
    // else. It is the fastest way to say which simulation you mean, and it
    // cannot be confused with picking a ray out of it, because a ray in an
    // unselected panel is not pickable at all.
    const panelId = sceneRenderer.panelAt(event.clientX, event.clientY);
    if (store.state.compare.enabled && panelId && panelId !== store.state.compare.active) {
      store.patch({ compare: { active: panelId } });
      rayLog.hidden = true;
      return;
    }
    const index = sceneRenderer.pick(event.clientX, event.clientY);
    sceneRenderer.setSelected(index);
    const rays = traces.get(result.activeId)?.photons;
    if (index >= 0 && rays && rays[index]) showRayLog(rays[index]);
    else rayLog.hidden = true;
    needsPaint = true;
  });

  function showRayLog(path) {
    rayLog.hidden = false;
    rayLogBody.textContent = '';

    const header = document.createElement('div');
    header.className = 'ray-log-summary';
    header.textContent =
      `λ = ${path.lambda} nm · ${i18n.t('canvas.scattered')}: ${path.scatterCount} · ` +
      i18n.t(`canvas.${outcomeKey(path.outcome)}`);
    rayLogBody.appendChild(header);

    const list = document.createElement('ol');
    list.className = 'ray-events';
    for (const event of path.events) {
      const li = document.createElement('li');
      const parts = [eventLabel(event)];
      parts.push(`${i18n.t('canvas.altitude')} ${formatAltitude(event.altitude)}`);
      if (event.angleDeg != null) {
        parts.push(`${i18n.t('canvas.angle')} ${event.angleDeg.toFixed(0)}°`);
      }
      if (event.species) parts.push(event.species === 'rayleigh' ? 'Rayleigh' : 'Mie');
      li.textContent = parts.join(' · ');
      list.appendChild(li);
    }
    rayLogBody.appendChild(list);
  }

  function outcomeKey(outcome) {
    if (outcome === 'observed') return 'observed';
    if (outcome === 'missed') return 'missedObserver';
    if (outcome === 'ground') return 'reachedGround';
    if (outcome === 'absorb') return 'absorbed';
    return 'escaped';
  }

  function eventLabel(event) {
    switch (event.type) {
      case 'enter': return i18n.getLanguage() === 'cs' ? 'vstup do atmosféry' : 'enters the atmosphere';
      case 'scatter': return i18n.t('canvas.scattered');
      case 'absorb': return i18n.t('canvas.absorbed');
      case 'ground': return i18n.t('canvas.reachedGround');
      case 'observed': return i18n.t('canvas.observed');
      case 'missed': return i18n.t('canvas.missedObserver');
      case 'escape': return i18n.t('canvas.escaped');
      default: return event.type;
    }
  }

  /* ---- frame loop ---- */

  window.addEventListener('resize', () => { needsPaint = true; });

  let lastFpsSample = performance.now();
  let frames = 0;

  function frame(now) {
    const physicsChanged = needsPhysics;
    const photonsChanged = needsPhotons;
    if (needsPhysics) recomputePhysics();
    if (needsPhotons && result) recomputePhotons();
    if (physicsChanged || photonsChanged) publish({ photonsChanged });

    const animating = store.state.rays.animate && store.state.rays.showScattering;
    if (needsPaint || animating) {
      sceneRenderer.draw(now);
      skyStrip.draw();
      beamHistogram.draw();
      needsPaint = false;
    }

    frames++;
    if (now - lastFpsSample > 1000) {
      document.body.dataset.fps = String(Math.round((frames * 1000) / (now - lastFpsSample)));
      frames = 0;
      lastFpsSample = now;
    }
    requestAnimationFrame(frame);
  }

  /* ---- go ---- */

  buildExperimentOptions();
  syncHeader();
  i18n.applyTo(document);
  controls.update();
  recomputePhysics();
  recomputePhotons();
  publish({ photonsChanged: true });

  document.getElementById('app').hidden = false;
  boot.hidden = true;
  boot.style.display = 'none';
  requestAnimationFrame(frame);

  // Handy for exploring the model from the browser console, and for driving the
  // renderers from a test harness where no animation frames are scheduled.
  window.atmoLab = {
    store, config, simulation, colorimetry, i18n, experiments,
    renderers: {
      scene: sceneRenderer, sky: skyStrip, spectrum: spectrumChart,
      chromaticity, histogram: beamHistogram,
    },
    get result() { return result; },
    get stations() { return stationsNow(); },
    get photons() { return traces.get(result?.activeId ?? 'a')?.photons ?? null; },
    /** Force one full synchronous update, bypassing the frame loop. */
    renderNow() {
      recomputePhysics();
      recomputePhotons();
      publish({ photonsChanged: true });
      sceneRenderer.draw(performance.now());
      skyStrip.draw();
      beamHistogram.draw();
      spectrumChart.draw();
      return true;
    },
  };
}

start().catch((error) => {
  console.error(error);
  boot.classList.add('is-error');
  bootMessage.textContent = String(error.message ?? error);
});

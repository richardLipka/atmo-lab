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
import { createStore, DEFAULT_STATE, maxAltitudeFor, touches } from './state.js';
import { createColorimetry } from './physics/color.js';
import { createSimulation } from './simulation.js';
import { createSceneRenderer, formatAltitude, clampSpan, autoSpanFor } from './render/scene-renderer.js';
import { createSkyStrip } from './render/sky-strip.js';
import { createSpectrumChart } from './render/spectrum-chart.js';
import { createChromaticityPlot } from './render/chromaticity.js';
import {
  tracePhotons, summarisePhotons, histogramPhotons, VIEW_CONE_HALF_DEG,
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
  const skyStrip = createSkyStrip(document.getElementById('sky-canvas'), { i18n });
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
  let photons = null;
  let photonTally = null;
  let needsPhysics = true;
  let needsPhotons = true;
  let needsPaint = true;

  function recomputePhysics() {
    result = simulation.run(store.state);
    needsPhysics = false;
  }

  function recomputePhotons() {
    const state = store.state;
    const atmosphere = result.atmosphere;
    photons = tracePhotons({
      atmosphere,
      source: result.source,
      sunElevationDeg: state.star.elevationDeg,
      observerZ: state.observer.z,
      count: state.rays.showScattering ? state.rays.count : 0,
      // The rays must be laid out over exactly the region that will be drawn,
      // so the renderer is asked rather than the geometry guessed at.
      ...sceneRenderer.frameFor(state, atmosphere),
      seed: 20260828,
    });
    photonTally = summarisePhotons(photons, { source: result.source });
    needsPhotons = false;
  }

  /**
   * Push freshly computed data into the views. This is the expensive half - it
   * rebuilds the atmospheric glow field and the readout DOM - so it runs only
   * when something actually changed, never once per animation frame.
   */
  function publish({ photonsChanged }) {
    const view = { state: store.state, result, photons };
    const histogram = beamHistogramFor(store.state);
    sceneRenderer.update(view, { keepSelection: !photonsChanged });
    skyStrip.update(view);
    beamHistogram.update(histogram);
    panels.update(result, photonTally, histogram);
    explanation.update(result);
    needsPaint = true;
  }

  /**
   * Bin the drawn beams for the histogram. The split between "reaches the
   * observer from where it is looking" and everything else is made here, from
   * the same angle the cross-section colours by, so the two agree by
   * construction rather than by coincidence.
   */
  function beamHistogramFor(state) {
    if (!photons) return null;
    const sign = Math.cos(state.observer.viewAzimuthDeg * Math.PI / 180) >= 0 ? 1 : -1;
    const axis = sign * state.observer.viewZenithDeg * Math.PI / 180;
    return histogramPhotons(photons, axis, VIEW_CONE_HALF_DEG * Math.PI / 180);
  }

  store.subscribe((state, changed) => {
    needsPhysics = true;
    needsPaint = true;
    if (touches(changed, 'atmosphere', 'star.elevationDeg', 'star.temperatureK',
      'star.presetId', 'star.realisticInsolation', 'rays.count', 'rays.showScattering',
      'observer.z', 'camera.span_m')) {
      // Note that the viewing direction is absent: the scattering events are a
      // property of the air and the star, not of where anyone is facing, so
      // turning the view restyles the existing rays rather than redrawing new
      // ones. The picture stays put and only the emphasis moves.
      needsPhotons = true;
    }
    if (touches(changed, 'atmosphere.presetId')) {
      store.setContext({
        maxAltitude: maxAltitudeFor(config.atmospheres.get(state.atmosphere.presetId)),
      });
    }
    if (touches(changed, 'observer.viewZenithDeg', 'observer.viewAzimuthDeg')) {
      // No new rays, but the split between "reaches you" and "does not" moves.
      const histogram = beamHistogramFor(state);
      beamHistogram.update(histogram);
      panels.update(result, photonTally, histogram);
    }
    if (touches(changed, 'atmosphere.presetId', 'star.presetId', 'star.temperatureK')) {
      // The held scales - the histogram's axis and the brightness the rays are
      // drawn against - belong to one world lit by one star. Carrying them
      // across to another would say something false about the new one.
      beamHistogram.resetScale();
      sceneRenderer.resetScale();
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
    if (result) {
      panels.update(result, photonTally, beamHistogramFor(store.state));
      explanation.update(result);
    }
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
    if (store.state.observer.z < 0) return;    // the shaft view has its own scale
    event.preventDefault();
    const current = store.state.camera.span_m
      ?? autoSpanFor(result.atmosphere, Math.max(0, store.state.observer.z));
    const factor = Math.exp(event.deltaY * 0.0015);
    store.patch({ camera: { span_m: clampSpan(current * factor) } });
  }, { passive: false });

  sceneCanvas.addEventListener('mouseleave', () => {
    sceneRenderer.setHovered(-1);
    sceneCanvas.style.cursor = 'default';
    needsPaint = true;
  });
  sceneCanvas.addEventListener('click', (event) => {
    const index = sceneRenderer.pick(event.clientX, event.clientY);
    sceneRenderer.setSelected(index);
    if (index >= 0 && photons && photons[index]) showRayLog(photons[index]);
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
    get photons() { return photons; },
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

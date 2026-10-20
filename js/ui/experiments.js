/**
 * Guided experiments.
 *
 * Each step is a short piece of prose plus a patch to apply to the state, so a
 * student can be walked through a discovery without ever losing the ability to
 * grab a slider and wander off. Leaving an experiment changes nothing: the
 * controls simply stop being driven for you.
 *
 * A step is NOT applied on top of whatever happens to be on screen. It is
 * rebuilt from a clean starting situation plus every step up to it, so going
 * back, jumping ahead with the dots, or returning after wandering off all give
 * exactly the situation the text describes. Applying only the step's own patch
 * left the settings of other steps behind: going back from "put n = 4 back" to
 * "set n = 0" kept n = 4 while the text said 0.
 *
 * And a step says what it changed. The list under the text is computed from the
 * state before and after the step, named with the controls' own labels, so a
 * reader always knows which slider moved and to what - and the list cannot
 * drift from what the step really does, because it is not written by hand.
 *
 * A step can also take place in the Single beam tab: it says "tab": "beam" and
 * sets that tab's pictures with a "beam" patch, rebuilt the same way from the
 * tab's defaults and every step up to it. A step that names no tab stays in
 * the tab of the step before; "tab": "scattering" goes back.
 */

import { DEFAULT_STATE } from '../state.js';
import { formatAltitude } from '../render/scene-renderer.js';
import { DEFAULT_BEAM_STATE } from '../render/beam-canvas.js';
import { diameterText } from '../render/particle-view.js';
import { RAY_BANDS } from '../physics/spectrum.js';

const copyOf = (value) => JSON.parse(JSON.stringify(value));
const isPlainRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Deep merge of plain objects, patch winning; returns a new object. */
function mergedOver(base, patch) {
  const out = copyOf(base);
  (function into(target, source) {
    for (const [key, value] of Object.entries(source)) {
      if (isPlainRecord(value) && isPlainRecord(target[key])) into(target[key], value);
      else target[key] = copyOf(value);
    }
  })(out, patch);
  return out;
}

/**
 * The situation every guide starts from: the default star, world and observer,
 * no comparison, and the display at its normal brightness. The page's own
 * choices - language, how many rays, animation - are left alone.
 */
function guideBaseline() {
  const d = copyOf(DEFAULT_STATE);
  return {
    star: d.star, atmosphere: d.atmosphere, observer: d.observer,
    compare: d.compare, rays: { brightness: d.rays.brightness },
  };
}

function readGuidePath(object, path) {
  return path.split('.').reduce((node, key) => (node == null ? node : node[key]), object);
}

/**
 * The full situation step `index` of a guide stands for: the baseline plus
 * every step up to and including it. Pure, so the test suite can replay every
 * guide exactly as the page does.
 */
export function guideSituation(experiment, index, level = 'basic') {
  let state = mergedOver(guideBaseline(), { level });
  for (let i = 0; i <= index; i++) {
    const step = experiment.steps[i];
    if (step?.state) state = mergedOver(state, step.state);
  }
  return state;
}

/**
 * The tab a step takes place in: 'beam' or 'scattering'. A step that does not
 * say stays in the tab of the step before it; a guide starts in the Light
 * scattering tab.
 */
export function guideTab(experiment, index) {
  for (let i = index; i >= 0; i--) {
    const tab = experiment.steps[i]?.tab;
    if (tab === 'beam' || tab === 'scattering') return tab;
  }
  return 'scattering';
}

/** The Single beam tab's settings at a step: its defaults plus every beam patch up to it. */
export function guideBeamSituation(experiment, index) {
  let beam = copyOf(DEFAULT_BEAM_STATE);
  for (let i = 0; i <= index; i++) {
    const patch = experiment.steps[i]?.beam;
    if (patch) beam = mergedOver(beam, patch);
  }
  return beam;
}

/** Every Single beam setting a guide may change; each has a named control. */
export const BEAM_DESCRIBED_PATHS = [
  'viewType', 'particleDiameterUm', 'particleBand', 'particlePolar', 'particleLog', 'rayleighExponent',
  'crowdSize', 'elevationDeg', 'sightViewDeg', 'sightHillKm', 'densityScale', 'aerosolScale', 'aerosolPresetId',
];

/**
 * Every state path a guide may change. Each is named in the "Changed" line
 * with the label of the control that shows it; a guide changing anything else
 * would be changing something the reader cannot find.
 */
export const DESCRIBED_PATHS = [
  'level', 'star.presetId', 'star.temperatureK', 'star.elevationDeg', 'star.realisticInsolation',
  'atmosphere.presetId', 'atmosphere.densityScale', 'atmosphere.aerosolPresetId',
  'atmosphere.aerosolScale', 'atmosphere.rayleighExponent',
  'observer.z', 'observer.viewZenithDeg', 'observer.well.enabled', 'observer.well.radius_m',
  'observer.well.depth_m', 'observer.countShaftAir', 'observer.span_m',
  'compare.enabled', 'compare.active', 'rays.brightness',
];

export function createExperiments(root, { i18n, store, config, onHighlight, onTab }) {
  const titleEl = root.querySelector('#experiment-title');
  const stepEl = root.querySelector('#experiment-step');
  const bodyEl = root.querySelector('#experiment-body');
  const changesEl = root.querySelector('#experiment-changes');
  const goalEl = root.querySelector('#experiment-goal');
  const observeEl = root.querySelector('#experiment-observe');
  const questionEl = root.querySelector('#experiment-question');
  const sourcesEl = root.querySelector('#experiment-sources');
  const prevBtn = root.querySelector('#experiment-prev');
  const nextBtn = root.querySelector('#experiment-next');
  const exitBtn = root.querySelector('#experiment-exit');
  const progressEl = root.querySelector('#experiment-progress');

  prevBtn.addEventListener('click', () => move(-1));
  nextBtn.addEventListener('click', () => move(1));
  exitBtn.addEventListener('click', () => exit());

  const onOff = (v) => i18n.t(v ? 'experiment.on' : 'experiment.off');
  const times = (v) => `${Number(v) < 10 ? Number(v).toFixed(2) : Math.round(v)} ×`;

  /**
   * What a guide may change, under the name the control panel gives it, and
   * how to print the new value. A path a guide changes that is missing here is
   * a guide changing something the reader cannot find - the test suite checks
   * there is none.
   */
  const DESCRIBED = [
    ['level', 'header.level', (v) => i18n.t(v === 'advanced' ? 'header.levelAdvanced' : 'header.levelBasic')],
    ['star.presetId', 'controls.star.preset', (v) => i18n.localized(config.stars.get(v)?.name, v)],
    ['star.temperatureK', 'controls.star.temperature', (v) => `${Math.round(v)} K`],
    ['star.elevationDeg', 'controls.star.elevation', (v) => `${v}°`],
    ['star.realisticInsolation', 'controls.star.realisticInsolation', onOff],
    ['atmosphere.presetId', 'controls.atmosphere.preset', (v) => i18n.localized(config.atmospheres.get(v)?.name, v)],
    ['atmosphere.densityScale', 'controls.atmosphere.density', times],
    ['atmosphere.aerosolPresetId', 'controls.atmosphere.aerosolType', (v) => (v
      ? i18n.localized(config.scattering.get('aerosols')?.presets?.[v]?.name, v)
      : i18n.t('controls.atmosphere.aerosolNative'))],
    ['atmosphere.aerosolScale', 'controls.atmosphere.aerosol', times],
    ['atmosphere.rayleighExponent', 'controls.atmosphere.exponent', (v) => `n = ${v}`],
    ['observer.z', 'controls.observer.position', (v) => (Math.abs(v) < 0.5
      ? i18n.t('controls.observer.groundLevel')
      : `${formatAltitude(Math.abs(v))} ${i18n.t(v > 0 ? 'controls.observer.aboveGround' : 'controls.observer.underground')}`)],
    ['observer.viewZenithDeg', 'controls.observer.viewDirection', (v) => (Math.abs(v) < 1
      ? `0° (${i18n.t('controls.observer.zenith')})` : `${Math.abs(v)}°`)],
    ['observer.well.enabled', 'controls.observer.wellEnabled', onOff],
    ['observer.well.radius_m', 'controls.observer.wellRadius', (v) => `${v} m`],
    ['observer.well.depth_m', 'controls.observer.wellDepth', (v) => formatAltitude(v)],
    ['observer.countShaftAir', 'controls.observer.countShaftAir', onOff],
    ['observer.span_m', 'controls.observer.zoom', (v) => (v ? formatAltitude(v) : i18n.t('experiment.auto'))],
    ['compare.enabled', 'compare.enable', onOff],
    ['compare.active', 'compare.controls', (v) => i18n.t(v === 'b' ? 'compare.observerB' : 'compare.observerA')],
    ['rays.brightness', 'controls.rays.brightness', times],
  ];
  const SIMULATION_PATHS = DESCRIBED.filter(([p]) => /^(star|atmosphere|observer)\./.test(p));

  /** The Single beam tab's settings, under the names its controls give them. */
  const num = (v, digits) => (i18n.getLanguage() === 'cs' ? Number(v).toFixed(digits).replace('.', ',') : Number(v).toFixed(digits));
  const BEAM_DESCRIBED = [
    ['viewType', 'beam.controls.viewTitle', (v) => i18n.t(`beam.controls.view.${v}`)],
    ['particleDiameterUm', 'beam.particle.size', (v) => diameterText(v, i18n.getLanguage())],
    ['particleBand', 'beam.particle.colour', (v) => `${Math.round(RAY_BANDS[v].centreNm)} nm`],
    ['particlePolar', 'beam.particle.polar', onOff],
    ['particleLog', 'beam.particle.log', onOff],
    ['rayleighExponent', 'beam.controls.exponent', (v) => `n = ${num(v, 1)}`],
    ['crowdSize', 'beam.crowd.count', (v) => `N = ${(4 * v) ** 2}`],
    ['elevationDeg', 'beam.controls.elevation', (v) => `${v}°`],
    ['sightViewDeg', 'beam.sight.view', (v) => (Math.abs(v) < 1 ? i18n.t('beam.sight.zenithShort')
      : i18n.t(v < 0 ? 'beam.sight.towardsShort' : 'beam.sight.awayShort', { deg: Math.round(90 - Math.abs(v)) }))],
    ['sightHillKm', 'beam.sight.hill', (v) => (v == null ? onOff(false) : `${v} km`)],
    ['densityScale', 'beam.controls.density', times],
    ['aerosolScale', 'beam.controls.aerosol', times],
    ['aerosolPresetId', 'beam.controls.aerosolType', (v) => (v
      ? i18n.localized(config.scattering.get('aerosols')?.presets?.[v]?.name, v)
      : i18n.t('beam.controls.aerosolEarth'))],
  ];
  if (BEAM_DESCRIBED.some(([p], i) => p !== BEAM_DESCRIBED_PATHS[i]) || BEAM_DESCRIBED.length !== BEAM_DESCRIBED_PATHS.length) {
    throw new Error('experiments: BEAM_DESCRIBED and BEAM_DESCRIBED_PATHS disagree');
  }
  if (DESCRIBED.length !== DESCRIBED_PATHS.length
    || DESCRIBED.some(([p], i) => p !== DESCRIBED_PATHS[i])) {
    throw new Error('experiments: DESCRIBED and DESCRIBED_PATHS disagree');
  }

  function current() {
    const state = store.state;
    if (!state.experimentId) return null;
    return config.experiments.get(state.experimentId) ?? null;
  }

  /** The full situation a step stands for: the baseline plus every step up to it. */
  const situationAt = (experiment, index) => guideSituation(experiment, index, store.state.level);

  /** The settings this step changed, as "label → value" lines. */
  function changesAt(experiment, index) {
    if (index === 0) return [];
    const lines = [];
    const tabBefore = guideTab(experiment, index - 1), tabAfter = guideTab(experiment, index);
    if (tabBefore !== tabAfter) lines.push(i18n.t(tabAfter === 'beam' ? 'experiment.toBeamTab' : 'experiment.toScatteringTab'));
    if (tabAfter === 'beam') {
      const was = guideBeamSituation(experiment, index - 1), now = guideBeamSituation(experiment, index);
      for (const [path, labelKey, format] of BEAM_DESCRIBED) {
        if (JSON.stringify(was[path]) !== JSON.stringify(now[path])) lines.push(`${i18n.t(labelKey)} → ${format(now[path])}`);
      }
      return lines;
    }
    const before = situationAt(experiment, index - 1);
    const after = situationAt(experiment, index);
    const two = after.compare?.enabled || before.compare?.enabled;
    const describe = (path, labelKey, format, prefix = '') => {
      const a = readGuidePath(before, path), b = readGuidePath(after, path);
      if (JSON.stringify(a) === JSON.stringify(b)) return;
      lines.push(`${prefix}${i18n.t(labelKey)} → ${format(b)}`);
    };
    for (const [path, labelKey, format] of DESCRIBED) {
      const own = two && SIMULATION_PATHS.some(([p]) => p === path)
        ? `${i18n.t('compare.observerA')}: ` : '';
      describe(path, labelKey, format, own);
    }
    for (const [path, labelKey, format] of SIMULATION_PATHS) {
      describe(`compare.b.${path}`, labelKey, format, `${i18n.t('compare.observerB')}: `);
    }
    return lines;
  }

  function start(experimentId) {
    if (!experimentId) { exit(); return; }
    store.patch({ experimentId, experimentStep: 0 });
    applyStep(0);
  }

  function exit() {
    store.patch({ experimentId: null, experimentStep: 0 });
    onHighlight(null);
    render();
  }

  function move(delta) {
    const experiment = current();
    if (!experiment) return;
    const next = store.state.experimentStep + delta;
    if (next < 0) return;
    if (next >= experiment.steps.length) { exit(); return; }
    store.patch({ experimentStep: next });
    applyStep(next);
  }

  function applyStep(index) {
    const experiment = current();
    if (!experiment) return;
    const step = experiment.steps[index];
    if (!step) return;
    store.patch(situationAt(experiment, index));
    const tab = guideTab(experiment, index);
    onTab?.(tab, tab === 'beam' ? guideBeamSituation(experiment, index) : null);
    onHighlight(step.highlight ?? null);
    render();
  }

  function render() {
    const experiment = current();
    if (!experiment) {
      root.hidden = true;
      return;
    }
    root.hidden = false;
    const index = store.state.experimentStep;
    const step = experiment.steps[index];
    const total = experiment.steps.length;

    titleEl.textContent = i18n.localized(experiment.title);
    stepEl.textContent = i18n.t('experiment.step', { n: index + 1, total });
    bodyEl.textContent = i18n.localized(step.title) + ' — ' + i18n.localized(step.text);

    // The goal is stated once, at the start: what this guide is for.
    goalEl.hidden = !(index === 0 && experiment.goal);
    if (!goalEl.hidden) {
      goalEl.querySelector('.hint-label').textContent = i18n.t('experiment.goal');
      goalEl.querySelector('.hint-text').textContent = i18n.localized(experiment.goal);
    }

    const changes = changesAt(experiment, index);
    changesEl.hidden = changes.length === 0;
    changesEl.querySelector('.hint-label').textContent = i18n.t('experiment.changed');
    changesEl.querySelector('.hint-text').textContent = changes.join('  ·  ');

    if (step.observe) {
      observeEl.hidden = false;
      observeEl.querySelector('.hint-label').textContent = i18n.t('experiment.observe');
      observeEl.querySelector('.hint-text').textContent = i18n.localized(step.observe);
    } else {
      observeEl.hidden = true;
    }

    if (step.question) {
      questionEl.hidden = false;
      questionEl.querySelector('.hint-label').textContent = i18n.t('experiment.question');
      questionEl.querySelector('.hint-text').textContent = i18n.localized(step.question);
    } else {
      questionEl.hidden = true;
    }

    // Where the step's claims come from: plain links, built as elements so a
    // label can never be read as markup.
    const sources = Array.isArray(step.sources) ? step.sources : [];
    sourcesEl.hidden = sources.length === 0;
    sourcesEl.querySelector('.hint-label').textContent = i18n.t('experiment.sources');
    const list = sourcesEl.querySelector('.hint-text');
    list.textContent = '';
    sources.forEach((source, i) => {
      if (i > 0) list.append('  ·  ');
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = i18n.localized(source.label);
      list.append(link);
    });

    prevBtn.disabled = index === 0;
    prevBtn.textContent = i18n.t('experiment.previous');
    nextBtn.textContent = index === total - 1 ? i18n.t('experiment.finish') : i18n.t('experiment.next');
    exitBtn.textContent = i18n.t('experiment.exit');

    progressEl.textContent = '';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'progress-dot' + (i === index ? ' is-active' : '') + (i < index ? ' is-done' : '');
      dot.title = i18n.localized(experiment.steps[i].title);
      dot.addEventListener('click', () => {
        store.patch({ experimentStep: i });
        applyStep(i);
      });
      progressEl.appendChild(dot);
    }
  }

  /** Options for the header selector, ordered as the config files ask. */
  function listExperiments() {
    return Array.from(config.experiments.values())
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((e) => ({ value: e.id, label: i18n.localized(e.title), summary: i18n.localized(e.summary) }));
  }

  render();
  return { start, exit, render, listExperiments, changesAt };
}

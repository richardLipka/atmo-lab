/**
 * Guided experiments.
 *
 * Each step is a short piece of prose plus a patch to apply to the state, so a
 * student can be walked through a discovery without ever losing the ability to
 * grab a slider and wander off. Leaving an experiment changes nothing: the
 * controls simply stop being driven for you.
 */

export function createExperiments(root, { i18n, store, config, onHighlight }) {
  const titleEl = root.querySelector('#experiment-title');
  const stepEl = root.querySelector('#experiment-step');
  const bodyEl = root.querySelector('#experiment-body');
  const observeEl = root.querySelector('#experiment-observe');
  const questionEl = root.querySelector('#experiment-question');
  const prevBtn = root.querySelector('#experiment-prev');
  const nextBtn = root.querySelector('#experiment-next');
  const exitBtn = root.querySelector('#experiment-exit');
  const progressEl = root.querySelector('#experiment-progress');

  prevBtn.addEventListener('click', () => move(-1));
  nextBtn.addEventListener('click', () => move(1));
  exitBtn.addEventListener('click', () => exit());

  function current() {
    const state = store.state;
    if (!state.experimentId) return null;
    return config.experiments.get(state.experimentId) ?? null;
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
    if (step.state) store.patch(step.state);
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
  return { start, exit, render, listExperiments };
}

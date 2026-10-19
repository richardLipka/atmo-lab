/**
 * Controls and readouts for the single-beam view.
 *
 * The left panel chooses the situation: which picture, how high the Sun is,
 * white sunlight or one colour, and the air. The right panel reports what the
 * beam delivers and, colour by colour, where the rest of its light went - the
 * same numbers the picture is drawn from. Every string comes from the
 * localisation files, so Czech and English stay in step.
 */

import { RAY_BANDS } from '../physics/spectrum.js';

const SOURCES = [
  ['beam.sources.bodhaine', 'https://doi.org/10.1175/1520-0426(1999)016%3C1854:ORODC%3E2.0.CO;2'],
  ['beam.sources.opac', 'https://doi.org/10.1175/1520-0477(1998)079%3C0831:OPOAAC%3E2.0.CO;2'],
  ['beam.sources.ozone', 'https://doi.org/10.5194/amt-7-625-2014'],
  ['beam.sources.ciddor', 'https://doi.org/10.1364/AO.35.001566'],
  ['beam.sources.refraction', 'https://en.wikipedia.org/wiki/Atmospheric_refraction'],
  ['beam.sources.greenFlash', 'https://en.wikipedia.org/wiki/Green_flash'],
];

/** Colours for the parts of the light budget. */
const BUDGET_COLOURS = {
  rayleigh: '#8fb8ff',
  aerosolScatter: '#cfc2a6',
  absorbed: '#6b4a2e',
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') node.textContent = v;
    else if (k === 'className') node.className = v;
    else if (k === 'style') Object.assign(node.style, v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : v);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

export function createBeamUI({
  leftContainer, rightContainer, i18n, colorimetry, config, initialState, onStateChange, onSwitchToScattering,
}) {
  const state = { ...initialState };
  const t = (key, params) => i18n.t(key, params);
  const pct = (v) => {
    const p = 100 * v;
    const text = p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p >= 0.01 ? p.toFixed(2) : p > 0 ? p.toExponential(0) : '0';
    return `${i18n.getLanguage() === 'cs' ? text.replace('.', ',') : text} %`;
  };

  function emit(patch) {
    Object.assign(state, patch);
    onStateChange?.({ ...state });
  }

  /* ---------------------------------------------------------------- */
  /* left: the situation                                              */
  /* ---------------------------------------------------------------- */

  function section(titleKey, ...children) {
    return el('section', { className: 'control-section' }, [el('h2', { text: t(titleKey) }), ...children]);
  }

  function segmented(options, value, onPick) {
    return el('div', { className: 'segmented', role: 'group' }, options.map(([v, labelKey]) => {
      const button = el('button', { type: 'button', className: v === value ? 'is-active' : '', text: t(labelKey) });
      button.addEventListener('click', () => onPick(v));
      return button;
    }));
  }

  function range({ id, labelKey, helpKey, min, max, step, value, format, onInput }) {
    const out = el('span', { className: 'field-value', text: format(value) });
    const input = el('input', { type: 'range', id, min, max, step, value });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = format(v);
      onInput(v);
    });
    return el('div', { className: 'field' }, [
      el('label', { for: id, className: 'field-label' }, [el('span', { text: t(labelKey), title: helpKey ? t(helpKey) : null }), out]),
      input,
      helpKey ? el('p', { className: 'field-help', text: t(helpKey) }) : null,
    ]);
  }

  function quick(values, current, format, onPick, colourOf) {
    return el('div', { className: 'beam-quick' }, values.map((v) => {
      const b = el('button', {
        type: 'button', className: `ghost-button small${v === current ? ' is-active' : ''}`, text: format(v),
        style: colourOf ? { borderLeft: `3px solid ${colourOf(v)}` } : {},
      });
      b.addEventListener('click', () => onPick(v));
      return b;
    }));
  }

  function renderLeft() {
    leftContainer.textContent = '';

    const view = section('beam.controls.viewTitle',
      segmented([['macro', 'beam.controls.viewMacro'], ['micro', 'beam.controls.viewMicro']],
        state.viewType, (v) => { emit({ viewType: v }); renderLeft(); }),
      el('p', { className: 'field-help', text: t(state.viewType === 'macro' ? 'beam.controls.viewMacroHelp' : 'beam.controls.viewMicroHelp') }));
    if (state.viewType === 'micro') {
      view.append(segmented([['bundle', 'beam.controls.bundle'], ['single', 'beam.controls.single']],
        state.bundleMode, (v) => { emit({ bundleMode: v }); renderLeft(); }));
      view.append(el('p', { className: 'field-help', text: t(state.bundleMode === 'single' ? 'beam.controls.singleHelp' : 'beam.controls.bundleHelp') }));
    }

    const sun = section('beam.controls.sunTitle',
      range({
        id: 'beam-elevation', labelKey: 'beam.controls.elevation', helpKey: 'beam.controls.elevationHelp',
        min: 0, max: 90, step: 0.5, value: state.elevationDeg, format: (v) => `${Number(v).toFixed(1)}°`,
        onInput: (v) => emit({ elevationDeg: v }),
      }),
      quick([60, 20, 5, 1, 0], state.elevationDeg, (v) => `${v}°`, (v) => { emit({ elevationDeg: v }); renderLeft(); }));

    const light = section('beam.controls.lightTitle',
      segmented([['sunlight', 'beam.controls.white'], ['monochromatic', 'beam.controls.oneColour']],
        state.mode, (v) => { emit({ mode: v }); renderLeft(); }));
    if (state.mode === 'monochromatic') {
      light.append(
        range({
          id: 'beam-wavelength', labelKey: 'beam.controls.wavelength', min: 380, max: 750, step: 10,
          value: state.wavelengthNm, format: (v) => `${Math.round(v)} nm`, onInput: (v) => emit({ wavelengthNm: v }),
        }),
        quick(RAY_BANDS.map((b) => Math.round(b.centreNm / 10) * 10), state.wavelengthNm, (v) => `${v}`,
          (v) => { emit({ wavelengthNm: v }); renderLeft(); },
          (v) => RAY_BANDS.find((b) => v >= b.fromNm && v <= b.toNm + 1)?.css ?? '#fff'));
    }

    const presets = config.scattering.get('aerosols')?.presets ?? {};
    const select = el('select', { id: 'beam-aerosol-type' }, [
      el('option', { value: '', text: t('beam.controls.aerosolEarth') }),
      ...Object.entries(presets).map(([id, p]) => el('option', { value: id, text: i18n.localized(p.name) })),
    ]);
    select.value = state.aerosolPresetId ?? '';
    select.addEventListener('change', () => emit({ aerosolPresetId: select.value || null }));

    const air = section('beam.controls.airTitle',
      range({
        id: 'beam-density', labelKey: 'beam.controls.density', helpKey: 'beam.controls.densityHelp',
        min: 0, max: 3, step: 0.05, value: state.densityScale, format: (v) => `${Number(v).toFixed(2)} ×`,
        onInput: (v) => emit({ densityScale: v }),
      }),
      el('div', { className: 'field' }, [
        el('label', { for: 'beam-aerosol-type', className: 'field-label', text: t('beam.controls.aerosolType') }),
        select,
      ]),
      range({
        id: 'beam-aerosol', labelKey: 'beam.controls.aerosol', helpKey: 'beam.controls.aerosolHelp',
        min: 0, max: 5, step: 0.05, value: state.aerosolScale, format: (v) => `${Number(v).toFixed(2)} ×`,
        onInput: (v) => emit({ aerosolScale: v }),
      }),
      range({
        id: 'beam-exponent', labelKey: 'beam.controls.exponent', helpKey: 'beam.controls.exponentHelp',
        min: 0, max: 6, step: 0.1, value: state.rayleighExponent, format: (v) => `n = ${Number(v).toFixed(1)}`,
        onInput: (v) => emit({ rayleighExponent: v }),
      }));

    leftContainer.append(view, sun, light, air);
  }

  /* ---------------------------------------------------------------- */
  /* right: what arrives, and where the rest went                     */
  /* ---------------------------------------------------------------- */

  function chip(css, captionKey, detail) {
    return el('div', { className: 'beam-chip' }, [
      el('div', { className: 'beam-chip-swatch', style: { background: css } }),
      el('div', {}, [el('div', { className: 'beam-chip-caption', text: t(captionKey) }), el('div', { className: 'beam-chip-detail', text: detail })]),
    ]);
  }

  function renderRight(result) {
    if (!result?.model) return;
    const { model, bundle } = result;
    const trace = model.trace;
    rightContainer.textContent = '';

    // What enters, and what arrives: true brightness, and the hue on its own.
    const sourceLum = Math.max(1e-12, colorimetry.luminance(model.source));
    const entering = colorimetry.spectrumToSrgb(model.source, 1 / sourceLum);
    const arriving = colorimetry.spectrumToSrgb(trace.transmittedSpectrum, 1 / sourceLum);
    const arrivingLum = colorimetry.luminance(trace.transmittedSpectrum);
    const hue = colorimetry.spectrumToSrgb(trace.transmittedSpectrum, 1 / Math.max(1e-30, arrivingLum));
    rightContainer.append(el('section', { className: 'panel-section' }, [
      el('h2', { text: t('beam.panel.arrivesTitle') }),
      el('div', { className: 'beam-chips' }, [
        chip(entering.css, 'beam.panel.entering', ''),
        chip(arriving.css, 'beam.panel.arriving', pct(arrivingLum / sourceLum)),
        chip(arrivingLum > 0 ? hue.css : '#000', 'beam.panel.arrivingHue', ''),
      ]),
      el('p', { className: 'note', text: t('beam.panel.pathInfo', {
        km: Math.round(trace.pathLengthM / 1000), airmass: trace.airMass.toFixed(1),
      }) }),
    ]));

    // Where each colour's light went.
    const rows = trace.budget.filter((b) => b.present).map((b) => {
      const absorbed = b.aerosolAbsorb + b.ozone;
      const segments = [
        [b.transmitted, b.band.css],
        [b.rayleigh, BUDGET_COLOURS.rayleigh],
        [b.aerosolScatter, BUDGET_COLOURS.aerosolScatter],
        [absorbed, BUDGET_COLOURS.absorbed],
      ];
      const bar = el('div', { className: 'beam-budget-bar' }, segments.map(([v, c]) =>
        el('span', { style: { width: `${Math.max(0, v * 100)}%`, background: c } })));
      return el('div', {
        className: 'beam-budget-row',
        title: t('beam.panel.budgetTooltip', {
          t: pct(b.transmitted), r: pct(b.rayleigh), a: pct(b.aerosolScatter), o: pct(b.ozone), x: pct(b.aerosolAbsorb),
        }),
      }, [
        el('span', { className: 'beam-budget-label', text: `${b.band.fromNm}–${Math.min(750, b.band.toNm + 1)} nm` }),
        bar,
        el('span', { className: 'beam-budget-value', text: pct(b.transmitted) }),
      ]);
    });
    const legend = el('div', { className: 'beam-budget-legend' }, [
      ['beam.panel.legendTransmitted', 'linear-gradient(90deg,#6c5ce7,#00b0ff,#00e676,#ffd600,#ff3d00)'],
      ['beam.panel.legendRayleigh', BUDGET_COLOURS.rayleigh],
      ['beam.panel.legendAerosol', BUDGET_COLOURS.aerosolScatter],
      ['beam.panel.legendAbsorbed', BUDGET_COLOURS.absorbed],
    ].map(([key, bg]) => el('span', {}, [el('i', { style: { background: bg } }), t(key)])));
    rightContainer.append(el('section', { className: 'panel-section' }, [
      el('h2', { text: t('beam.panel.budgetTitle') }), ...rows, legend,
      el('p', { className: 'note', text: t('beam.panel.budgetNote') }),
    ]));

    // The chosen ray, collision by collision.
    if (result.state.viewType === 'micro' && result.selection) rightContainer.append(chosenRaySection(result));

    // The chamber's own count, beside what the path says.
    if (result.state.viewType === 'micro' && bundle) {
      const counted = trace.budget.filter((b) => b.present).map((b) => {
        const i = RAY_BANDS.indexOf(b.band);
        const tally = bundle.tally[i];
        return el('tr', {}, [
          el('td', { text: `${b.band.fromNm}–${Math.min(750, b.band.toNm + 1)} nm` }),
          el('td', { text: `${tally.direct} / ${tally.sent}` }),
          el('td', { text: pct(Math.exp(-b.tau)) }),
        ]);
      });
      rightContainer.append(el('section', { className: 'panel-section' }, [
        el('h2', { text: t('beam.panel.chamberTitle') }),
        el('table', { className: 'data-table' }, [
          el('thead', {}, el('tr', {}, [el('th', { text: t('beam.panel.colour') }), el('th', { text: t('beam.panel.counted') }), el('th', { text: t('beam.panel.expected') })])),
          el('tbody', {}, counted),
        ]),
        el('p', { className: 'note', text: t('beam.panel.chamberNote') }),
      ]));
    }

    // Refraction: the weak, second dependence on colour.
    const refr = trace.refraction;
    const mid = refr[4].arcmin;
    const spreadArcsec = (refr[0].arcmin - refr[refr.length - 1].arcmin) * 60;
    rightContainer.append(el('section', { className: 'panel-section' }, [
      el('h2', { text: t('beam.panel.refractionTitle') }),
      el('p', { className: 'note', text: t('beam.panel.refractionText', {
        arcmin: mid.toFixed(mid < 1 ? 2 : 1), arcsec: spreadArcsec.toFixed(spreadArcsec < 1 ? 2 : 1),
      }) }),
    ]));

    // Why, briefly, and where it comes from.
    const sources = el('p', { className: 'note beam-sources' }, [t('beam.panel.sources'), ' ']);
    SOURCES.forEach(([key, url], i) => {
      if (i) sources.append(' · ');
      sources.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: t(key) }));
    });
    const go = el('button', { type: 'button', className: 'primary-button beam-go', text: t('beam.panel.toScattering') });
    go.addEventListener('click', () => onSwitchToScattering?.());
    rightContainer.append(el('section', { className: 'panel-section' }, [
      el('h2', { text: t('beam.panel.whyTitle') }),
      el('p', { className: 'note', text: t('beam.panel.whyScattering') }),
      el('p', { className: 'note', text: t('beam.panel.whyRefraction') }),
      sources, go,
    ]));
  }

  /**
   * What happened to the chosen ray: one line per collision, in the order the
   * picture numbers them, then how it ended. Switching colour keeps the same
   * ray - the same entry height - so the colours can be compared.
   */
  function chosenRaySection(result) {
    const { model, selection } = result;
    const { ray, band, index, count } = selection;
    const nm = Math.round(RAY_BANDS[band].centreNm);

    const colours = el('div', { className: 'beam-quick' }, model.bands.map((b) => {
      const button = el('button', {
        type: 'button', className: `ghost-button small${b === band ? ' is-active' : ''}`,
        text: `${Math.round(RAY_BANDS[b].centreNm)} nm`, style: { borderLeft: `3px solid ${RAY_BANDS[b].css}` },
      });
      button.addEventListener('click', () => emit({ selectedBand: b, selectedRay: index }));
      return button;
    }));
    const step = (delta, text, labelKey) => {
      const button = el('button', { type: 'button', className: 'ghost-button small', text, 'aria-label': t(labelKey) });
      button.addEventListener('click', () => emit({ selectedBand: band, selectedRay: (index + delta + count) % count }));
      return button;
    };
    const stepper = el('div', { className: 'beam-stepper' }, [
      step(-1, '◀', 'beam.chosen.previous'),
      el('span', { text: t('beam.chosen.which', { n: index + 1, count, nm }) }),
      step(1, '▶', 'beam.chosen.next'),
    ]);

    // A kind met before gets a short line; its full explanation is above.
    const items = ray.events.map((e, k) => {
      const repeat = ray.events.slice(0, k).some((o) => o.kind === e.kind);
      return el('li', {}, [
        el('strong', { text: `${k + 1}. ${t(`beam.chosen.kind.${e.kind}`)}` }),
        el('span', { text: ` ${t(`beam.chosen.${repeat ? 'again' : 'does'}.${e.kind}`, { deg: Math.round(e.turnDeg ?? 0) })}` }),
      ]);
    });
    let endKey;
    if (ray.fate === 'direct') endKey = 'direct';
    else if (ray.fate === 'absorbed') endKey = 'absorbed';
    else endKey = ray.exit ? `scattered.${ray.exit}` : 'scattered.inside';
    items.push(el('li', { className: 'beam-chosen-end' }, [
      el('strong', { text: t('beam.chosen.endTitle') }),
      el('span', { text: ` ${t(`beam.chosen.end.${endKey}`, { n: ray.events.length })}` }),
    ]));

    return el('section', { className: 'panel-section' }, [
      el('h2', { text: t('beam.chosen.title') }),
      colours, stepper,
      el('ol', { className: 'beam-chosen-list' }, items),
      el('p', { className: 'note', text: t('beam.chosen.compare') }),
    ]);
  }

  /**
   * New numbers: only the readouts are rebuilt. The controls are left alone,
   * so a slider being dragged is not destroyed under the pointer.
   */
  function update(next, result) {
    if (next) Object.assign(state, next);
    renderRight(result);
  }

  /** Everything, for a change of language. */
  function refresh(result) {
    renderLeft();
    renderRight(result);
  }

  renderLeft();
  return { update, refresh, renderLeft, renderRight };
}

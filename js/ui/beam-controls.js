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
import { particlePattern, dropletPattern, sizeRegime, CHAMBER_SAMPLE } from '../physics/mie.js';
import { diameterText, particleContrast } from '../render/particle-view.js';
import { chosenScatterEvent, contrastBand, rayleighBandRatio } from '../render/beam-canvas.js';

const SOURCES = [
  ['beam.sources.bodhaine', 'https://doi.org/10.1175/1520-0426(1999)016%3C1854:ORODC%3E2.0.CO;2'],
  ['beam.sources.opac', 'https://doi.org/10.1175/1520-0477(1998)079%3C0831:OPOAAC%3E2.0.CO;2'],
  ['beam.sources.ozone', 'https://doi.org/10.5194/amt-7-625-2014'],
  ['beam.sources.ciddor', 'https://doi.org/10.1364/AO.35.001566'],
  ['beam.sources.refraction', 'https://en.wikipedia.org/wiki/Atmospheric_refraction'],
  ['beam.sources.greenFlash', 'https://en.wikipedia.org/wiki/Green_flash'],
  ['beam.sources.mie', 'https://en.wikipedia.org/wiki/Mie_scattering'],
  ['beam.sources.bohren', 'https://doi.org/10.1002/9783527618156'],
];

/** The single-particle slider runs on a logarithmic scale between these diameters (micrometres). */
const PARTICLE_MIN_UM = 0.0003;
const PARTICLE_MAX_UM = 20;
const SLIDER_STEPS = 1000;
const toSlider = (d) => Math.round(SLIDER_STEPS * Math.log(d / PARTICLE_MIN_UM) / Math.log(PARTICLE_MAX_UM / PARTICLE_MIN_UM));
const fromSlider = (v) => PARTICLE_MIN_UM * (PARTICLE_MAX_UM / PARTICLE_MIN_UM) ** (v / SLIDER_STEPS);
/** Named stops: the particles of the test bench, plus a 2 micrometre dust grain's size. */
const PARTICLE_STOPS = [['molecule', 0.0003], ['fine', 0.1], ['haze', 0.5], ['dust', 2], ['cloud', 10]];

/** What the air does to light, in the order the panel lists it. */
const PRINCIPLES = ['molecules', 'haze', 'absorption', 'path', 'refraction', 'views'];

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

  function segmented(options, value, onPick, extraClass = '') {
    return el('div', { className: `segmented ${extraClass}`.trim(), role: 'group' }, options.map(([v, labelKey]) => {
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
      segmented([['macro', 'beam.controls.viewMacro'], ['micro', 'beam.controls.viewMicro'], ['particle', 'beam.controls.viewParticle']],
        state.viewType, (v) => { emit({ viewType: v }); renderLeft(); }, 'beam-view-picker'),
      el('p', { className: 'field-help', text: t({
        macro: 'beam.controls.viewMacroHelp', micro: 'beam.controls.viewMicroHelp', particle: 'beam.controls.viewParticleHelp',
      }[state.viewType] ?? 'beam.controls.viewMacroHelp') }));

    // One particle: its size and the colour; the Sun and the air play no part.
    if (state.viewType === 'particle') {
      const log = el('input', { type: 'checkbox', id: 'beam-particle-log', checked: state.particleLog });
      log.addEventListener('change', () => emit({ particleLog: log.checked }));
      const particle = section('beam.particle.controlsTitle',
        range({
          id: 'beam-particle-size', labelKey: 'beam.particle.size', helpKey: 'beam.particle.sizeHelp',
          min: 0, max: SLIDER_STEPS, step: 1, value: toSlider(state.particleDiameterUm),
          format: (v) => diameterText(fromSlider(Number(v)), i18n.getLanguage()),
          onInput: (v) => emit({ particleDiameterUm: fromSlider(v) }),
        }),
        quick(PARTICLE_STOPS.map(([, d]) => d), state.particleDiameterUm,
          (d) => t(`beam.particle.stop.${PARTICLE_STOPS.find(([, x]) => x === d)[0]}`),
          (d) => { emit({ particleDiameterUm: d }); renderLeft(); }),
        el('div', { className: 'field' }, [
          el('span', { className: 'field-label', text: t('beam.particle.colour') }),
          quick(RAY_BANDS.map((_, b) => b), state.particleBand, (b) => `${Math.round(RAY_BANDS[b].centreNm)}`,
            (b) => { emit({ particleBand: b }); renderLeft(); }, (b) => RAY_BANDS[b].css),
          el('p', { className: 'field-help', text: t('beam.particle.colourHelp') }),
        ]),
        el('div', { className: 'field field-check' }, [log,
          el('label', { className: 'field-label', for: 'beam-particle-log', text: t('beam.particle.log') })]),
        el('p', { className: 'field-help', text: t('beam.particle.logHelp') }));
      leftContainer.append(view, particle);
      return;
    }
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

  /** The principles, in words a student could give back. */
  function principlesSection() {
    return el('section', { className: 'panel-section' }, [
      el('h2', { text: t('beam.panel.principlesTitle') }),
      el('ul', { className: 'beam-principles' }, PRINCIPLES.map((key) => el('li', {}, [
        el('strong', { text: t(`beam.panel.principles.${key}.lead`) }),
        ` ${t(`beam.panel.principles.${key}.text`)}`,
      ]))),
    ]);
  }

  /** Where it comes from, and the way to the whole sky. */
  function sourcesSection() {
    const sources = el('p', { className: 'note beam-sources' }, [t('beam.panel.sources'), ' ']);
    SOURCES.forEach(([key, url], i) => {
      if (i) sources.append(' · ');
      sources.append(el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', text: t(key) }));
    });
    const go = el('button', { type: 'button', className: 'primary-button beam-go', text: t('beam.panel.toScattering') });
    go.addEventListener('click', () => onSwitchToScattering?.());
    return el('section', { className: 'panel-section' }, [sources, go]);
  }

  /**
   * One particle: its size against the two wavelengths compared, what that
   * means for where the light goes and how often it is scattered, and what to
   * try with the slider.
   */
  function particleSections(st) {
    const lang = i18n.getLanguage();
    const num = (v, digits) => (lang === 'cs' ? v.toFixed(digits).replace('.', ',') : v.toFixed(digits));
    const turn = (deg) => num(deg, deg < 10 ? 1 : 0);
    const band = st.particleBand, contrast = particleContrast(band);
    const shortBand = Math.min(band, contrast), longBand = Math.max(band, contrast);
    const sp = dropletPattern(st.particleDiameterUm, RAY_BANDS[shortBand].centreNm);
    const lp = dropletPattern(st.particleDiameterUm, RAY_BANDS[longBand].centreNm);
    const chosen = band === shortBand ? sp : lp;
    const regime = sizeRegime(chosen.sizeParameter);
    const ratio = sp.crossSection / lp.crossSection;
    const params = {
      d: diameterText(st.particleDiameterUm, lang),
      nmS: Math.round(RAY_BANDS[shortBand].centreNm), nmL: Math.round(RAY_BANDS[longBand].centreNm),
      mS: turn(sp.medianTurnDeg), mL: turn(lp.medianTurnDeg),
      fS: pct(sp.forwardShare), fL: pct(lp.forwardShare),
      ratio: num(ratio, ratio < 10 ? 1 : 0),
      x: num(chosen.sizeParameter, chosen.sizeParameter < 0.1 ? 3 : 1),
    };
    const rows = [
      [t('beam.particle.row.x'), num(sp.sizeParameter, sp.sizeParameter < 0.1 ? 3 : 2), num(lp.sizeParameter, lp.sizeParameter < 0.1 ? 3 : 2)],
      [t('beam.particle.row.turn'), `${turn(sp.medianTurnDeg)}°`, `${turn(lp.medianTurnDeg)}°`],
      [t('beam.particle.row.forward'), pct(sp.forwardShare), pct(lp.forwardShare)],
      [t('beam.particle.row.target'), num(ratio, ratio < 10 ? 2 : 1) + '×', '1×'],
    ];
    return [
      el('section', { className: 'panel-section' }, [
        el('h2', { text: t('beam.particle.panelTitle', { d: params.d }) }),
        el('table', { className: 'data-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', { text: '' }),
            el('th', { text: `${params.nmS} nm`, style: { color: RAY_BANDS[shortBand].css } }),
            el('th', { text: `${params.nmL} nm`, style: { color: RAY_BANDS[longBand].css } }),
          ])),
          el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', { text: c }))))),
        ]),
        el('p', { className: 'note', text: t('beam.particle.tableNote') }),
      ]),
      el('section', { className: 'panel-section' }, [
        el('h2', { text: t(`beam.particle.regime.${regime}`) }),
        el('p', { className: 'note', text: t(`beam.particle.explain.${regime}`, params) }),
      ]),
      el('section', { className: 'panel-section' }, [
        el('h2', { text: t('beam.particle.tryTitle') }),
        el('ul', { className: 'beam-principles' }, ['one', 'two', 'three'].map((k) => el('li', { text: t(`beam.particle.try.${k}`) }))),
      ]),
    ];
  }

  function renderRight(result) {
    if (!result?.model) return;
    const { model, bundle } = result;
    const trace = model.trace;
    rightContainer.textContent = '';
    if (result.state.viewType === 'particle') {
      rightContainer.append(...particleSections(result.state), principlesSection(), sourcesSection());
      return;
    }

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
    if (result.state.viewType === 'micro' && result.selection) {
      rightContainer.append(chosenRaySection(result), sizeSection(result));
    }

    rightContainer.append(principlesSection());

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
    const spreadArcsec = (refr[1].arcmin - refr[refr.length - 1].arcmin) * 60;
    rightContainer.append(el('section', { className: 'panel-section' }, [
      el('h2', { text: t('beam.panel.refractionTitle') }),
      el('p', { className: 'note', text: t('beam.panel.refractionText', {
        arcmin: mid.toFixed(mid < 1 ? 2 : 1), arcsec: spreadArcsec.toFixed(spreadArcsec < 1 ? 2 : 1),
      }) }),
    ]));

    rightContainer.append(sourcesSection());
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
      button.addEventListener('click', () => emit({ selectedBand: b, selectedRay: index, selectedEvent: null }));
      return button;
    }));
    const step = (delta, text, labelKey) => {
      const button = el('button', { type: 'button', className: 'ghost-button small', text, 'aria-label': t(labelKey) });
      button.addEventListener('click', () => emit({ selectedBand: band, selectedRay: (index + delta + count) % count, selectedEvent: null }));
      return button;
    };
    const stepper = el('div', { className: 'beam-stepper' }, [
      step(-1, '◀', 'beam.chosen.previous'),
      el('span', { text: t('beam.chosen.which', { n: index + 1, count, nm }) }),
      step(1, '▶', 'beam.chosen.next'),
    ]);

    // A kind met before gets a short line; its full explanation is above.
    // A scattering can be clicked: the wave strip under the chamber explains it.
    const picked = chosenScatterEvent(ray, result.state.selectedEvent);
    const pair = colourPair(model, band);
    const items = ray.events.map((e, k) => {
      const repeat = ray.events.slice(0, k).some((o) => o.kind === e.kind);
      const parts = [
        el('strong', { text: `${k + 1}. ${t(`beam.chosen.kind.${e.kind}`)}` }),
        el('span', { text: ` ${t(`beam.chosen.${repeat ? 'again' : 'does'}.${e.kind}`, { deg: Math.round(e.turnDeg ?? 0) })}` }),
      ];
      if (!repeat && e.kind === 'rayleigh') parts.push(el('span', { text: ` ${t('beam.chosen.moleculeColour')}` }));
      if (!repeat && e.kind === 'aerosolScatter') {
        const s = particlePattern('haze', RAY_BANDS[pair.short].centreNm);
        const l = particlePattern('haze', RAY_BANDS[pair.long].centreNm);
        parts.push(el('span', { text: ` ${t('beam.chosen.hazeColour', {
          nmS: Math.round(RAY_BANDS[pair.short].centreNm), mS: turnText(s.medianTurnDeg),
          nmL: Math.round(RAY_BANDS[pair.long].centreNm), mL: turnText(l.medianTurnDeg),
        })}` }));
      }
      const scatter = e.action === 'scatter';
      const li = el('li', {
        className: `${scatter ? 'is-clickable' : ''}${picked?.index === k ? ' is-active' : ''}`,
        title: scatter ? t('beam.chosen.pickHint') : null,
      }, parts);
      if (scatter) li.addEventListener('click', () => emit({ selectedEvent: k }));
      return li;
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
      ray.events.some((e) => e.action === 'scatter') ? el('p', { className: 'note', text: t('beam.chosen.pickHint') }) : null,
      el('ol', { className: 'beam-chosen-list' }, items),
      el('p', { className: 'note', text: t('beam.chosen.compare') }),
    ]);
  }

  /** The two colours compared: the chosen one and its contrast, shorter first. */
  function colourPair(model, band) {
    const other = contrastBand(model, band) ?? (band === RAY_BANDS.length - 1 ? 1 : RAY_BANDS.length - 1);
    return { short: Math.min(band, other), long: Math.max(band, other) };
  }

  function turnText(deg) {
    const text = deg < 10 ? deg.toFixed(1) : String(Math.round(deg));
    return i18n.getLanguage() === 'cs' ? text.replace('.', ',') : text;
  }

  /**
   * Why the size of the particle decides: the three regimes the test bench
   * shows, with the numbers for the colours being compared, and the regime of
   * the collision the wave strip explains picked out.
   */
  function sizeSection(result) {
    const { model, selection } = result;
    const pair = colourPair(model, selection.band);
    const nmS = RAY_BANDS[pair.short].centreNm, nmL = RAY_BANDS[pair.long].centreNm;
    const fmt = (v) => (i18n.getLanguage() === 'cs' ? v.toFixed(1).replace('.', ',') : v.toFixed(1));
    // The molecule's ratio is the air's own scattering, band by band, as in the chamber.
    const picked = chosenScatterEvent(selection.ray, result.state.selectedEvent);
    const active = picked ? CHAMBER_SAMPLE[picked.event.kind] : 'molecule';
    const rows = [
      ['molecule', 'small', { ratio: fmt(rayleighBandRatio(model, pair.short, pair.long)), times: Math.round(nmS / 0.3) }],
      ['haze', 'comparable', {}],
      ['cloud', 'large', {}],
    ].map(([id, regime, extra]) => {
      const s = particlePattern(id, nmS), l = particlePattern(id, nmL);
      const params = {
        nmS: Math.round(nmS), nmL: Math.round(nmL),
        mS: turnText(s.medianTurnDeg), mL: turnText(l.medianTurnDeg),
        ratio: fmt(s.crossSection / l.crossSection), ...extra,
      };
      return el('li', { className: id === active ? 'is-active' : '' }, [
        el('strong', { text: t(`beam.size.${regime}.lead`) }),
        ` ${t(`beam.size.${regime}.text`, params)}`,
      ]);
    });
    return el('section', { className: 'panel-section' }, [
      el('h2', { text: t('beam.size.title') }),
      el('p', { className: 'note', text: t('beam.size.intro') }),
      el('ul', { className: 'beam-principles beam-size' }, rows),
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

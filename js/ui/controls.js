/**
 * The control panel.
 *
 * Controls are declared as data rather than written out as markup, so adding a
 * new physical parameter is one entry in the list below. Each entry names the
 * state path it drives; nothing here knows anything about the physics.
 */

import {
  sliderToZ, zToSlider, maxAltitudeFor, MIN_SPAN_M, MAX_SPAN_M,
} from '../state.js';
import { formatAltitude, autoSpanFor } from '../render/scene-renderer.js';

function getPath(object, path) {
  return path.split('.').reduce((node, key) => (node == null ? node : node[key]), object);
}

function setPath(patch, path, value) {
  const keys = path.split('.');
  let node = patch;
  for (let i = 0; i < keys.length - 1; i++) {
    node[keys[i]] = node[keys[i]] ?? {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = value;
  return patch;
}

/** Surface pressure, in whatever unit keeps the number readable. */
function formatPressure(kPa) {
  if (kPa >= 1000) return `${(kPa / 1000).toFixed(1)} MPa`;
  if (kPa >= 1) return `${kPa.toFixed(kPa >= 10 ? 0 : 2)} kPa`;
  if (kPa > 0) return `${(kPa * 1000).toFixed(0)} Pa`;
  return '0';
}

/** Logarithmic slider mapping, for controls spanning several decades. */
function logToValue(t, min, max) {
  return min * Math.pow(max / min, t);
}
function valueToLog(v, min, max) {
  return Math.log(Math.max(min, v) / min) / Math.log(max / min);
}

export function createControls(root, { store, i18n, config }) {
  const elements = new Map();

  /**
   * Just enough of an atmosphere for autoSpanFor: it only reads the scale
   * height, and building a whole atmosphere to fill in a slider would be
   * wasteful on every repaint of the controls.
   */
  function atmosphereShape(state) {
    const preset = config.atmospheres.get(state.atmosphere.presetId);
    return {
      scaleHeightRayleigh: state.atmosphere.scaleHeight_m
        ?? preset?.rayleigh.scaleHeight_m ?? 8500,
    };
  }

  const sections = [
    {
      id: 'sec-star', titleKey: 'controls.star.title',
      controls: [
        {
          id: 'ctl-star-preset', type: 'select', labelKey: 'controls.star.preset',
          path: 'star.presetId',
          options: () => Array.from(config.stars.values()).map((s) => ({
            value: s.id, label: i18n.localized(s.name),
          })),
          onChange: (value) => {
            const preset = config.stars.get(value);
            return { star: { presetId: value, temperatureK: preset?.temperature_K ?? 5800 } };
          },
        },
        {
          id: 'ctl-temperature', type: 'range', labelKey: 'controls.star.temperature',
          helpKey: 'controls.star.temperatureHelp', path: 'star.temperatureK',
          min: 2000, max: 20000, step: 100,
          format: (v) => `${Math.round(v)} K`,
        },
        {
          id: 'ctl-elevation', type: 'range', labelKey: 'controls.star.elevation',
          helpKey: 'controls.star.elevationHelp', path: 'star.elevationDeg',
          min: -8, max: 90, step: 0.5,
          format: (v) => v < 0
            ? `${v.toFixed(1)}° (${i18n.t('controls.star.belowHorizon')})`
            : `${v.toFixed(1)}°`,
        },
        {
          id: 'ctl-insolation', type: 'checkbox', labelKey: 'controls.star.realisticInsolation',
          helpKey: 'controls.star.realisticInsolationHelp',
          path: 'star.realisticInsolation', advanced: true,
        },
      ],
    },
    {
      id: 'sec-atmosphere', titleKey: 'controls.atmosphere.title',
      controls: [
        {
          id: 'ctl-atmosphere-preset', type: 'select', labelKey: 'controls.atmosphere.preset',
          path: 'atmosphere.presetId',
          options: () => Array.from(config.atmospheres.values()).map((a) => ({
            value: a.id, label: i18n.localized(a.name),
          })),
          // Switching world resets the derived sliders to that world's own values.
          onChange: (value) => ({
            atmosphere: {
              presetId: value, densityScale: 1, aerosolScale: 1,
              aerosolPresetId: null, scaleHeight_m: null, rayleighExponent: 4,
            },
          }),
        },
        {
          id: 'ctl-density', type: 'range', labelKey: 'controls.atmosphere.density',
          helpKey: 'controls.atmosphere.densityHelp', path: 'atmosphere.densityScale',
          min: 0, max: 3, step: 0.02,
          format: (v) => `${v.toFixed(2)} ×`,
        },
        {
          id: 'ctl-aerosol-preset', type: 'select', labelKey: 'controls.atmosphere.aerosolType',
          helpKey: 'controls.atmosphere.aerosolTypeHelp', path: 'atmosphere.aerosolPresetId',
          nullable: true,
          options: () => {
            const presets = config.scattering.get('aerosols')?.presets ?? {};
            return [{ value: '', label: i18n.t('controls.atmosphere.aerosolNative') }].concat(
              Object.entries(presets).map(([id, preset]) => ({
                value: id, label: i18n.localized(preset.name),
              })));
          },
        },
        {
          id: 'ctl-aerosol', type: 'range', labelKey: 'controls.atmosphere.aerosol',
          helpKey: 'controls.atmosphere.aerosolHelp', path: 'atmosphere.aerosolScale',
          min: 0, max: 5, step: 0.05,
          format: (v) => `${v.toFixed(2)} ×`,
        },
        {
          id: 'ctl-scale-height', type: 'range', labelKey: 'controls.atmosphere.scaleHeight',
          helpKey: 'controls.atmosphere.scaleHeightHelp', path: 'atmosphere.scaleHeight_m',
          min: 1000, max: 60000, step: 100, advanced: true,
          fallback: (state) => config.atmospheres.get(state.atmosphere.presetId)?.rayleigh.scaleHeight_m ?? 8500,
          format: (v) => `${(v / 1000).toFixed(1)} km`,
        },
        {
          id: 'ctl-exponent', type: 'range', labelKey: 'controls.atmosphere.exponent',
          helpKey: 'controls.atmosphere.exponentHelp', path: 'atmosphere.rayleighExponent',
          min: 0, max: 6, step: 0.1, advanced: true,
          format: (v) => `n = ${v.toFixed(1)}`,
        },
        {
          // What this world is actually made of, named from the gas table in
          // config/scattering/rayleigh_gases.json.
          id: 'ctl-composition', type: 'note',
          text: (state) => {
            const world = config.atmospheres.get(state.atmosphere.presetId);
            if (!world) return '';
            const table = config.scattering.get('rayleigh_gases')?.gases ?? {};
            const parts = (world.composition ?? [])
              .filter((entry) => entry.fraction >= 0.001)
              .map((entry) => {
                const name = i18n.localized(table[entry.gas]?.name, entry.gas);
                return `${name} ${(entry.fraction * 100).toFixed(entry.fraction >= 0.1 ? 0 : 1)} %`;
              });
            const composition = parts.length
              ? `${i18n.t('controls.atmosphere.composition')}: ${parts.join(', ')}`
              : '';
            const pressure = world.surfacePressure_kPa != null
              ? `${i18n.t('controls.atmosphere.surfacePressure')}: ${formatPressure(world.surfacePressure_kPa)}`
              : '';
            return [composition, pressure, i18n.localized(world.description)]
              .filter(Boolean).join('\n');
          },
        },
      ],
    },
    {
      id: 'sec-observer', titleKey: 'controls.observer.title',
      controls: [
        {
          id: 'ctl-position', type: 'range', labelKey: 'controls.observer.position',
          helpKey: 'controls.observer.positionHelp', path: 'observer.z',
          min: -1000, max: 1000, step: 1, mapping: 'position',
          format: (v) => {
            if (Math.abs(v) < 0.5) return i18n.t('controls.observer.groundLevel');
            return v > 0
              ? `${formatAltitude(v)} (${i18n.t('controls.observer.altitude')})`
              : `${formatAltitude(-v)} (${i18n.t('controls.observer.underground')})`;
          },
        },
        {
          id: 'ctl-view', type: 'range', labelKey: 'controls.observer.viewDirection',
          helpKey: 'controls.observer.viewDirectionHelp', path: 'observer.viewZenithDeg',
          min: -90, max: 90, step: 1, mapping: 'view',
          format: (v) => {
            const a = Math.abs(v);
            if (a < 1) return `0° (${i18n.t('controls.observer.zenith')})`;
            if (a > 89) return `90° (${i18n.t('controls.observer.horizon')})`;
            return `${a.toFixed(0)}°`;
          },
        },
        {
          id: 'ctl-well', type: 'checkbox', labelKey: 'controls.observer.wellEnabled',
          path: 'observer.well.enabled',
          onChange: (enabled) => {
            const state = store.state;
            if (enabled) {
              const depth = state.observer.well?.depth_m ?? 50;
              const z = state.observer.z <= 0 ? -depth : state.observer.z;
              return { observer: { well: { enabled: true }, z } };
            }
            return { observer: { well: { enabled: false }, z: Math.max(0, state.observer.z) } };
          },
        },
        {
          id: 'ctl-well-radius', type: 'range', labelKey: 'controls.observer.wellRadius',
          path: 'observer.well.radius_m', min: 0.2, max: 20, step: 0.1,
          scale: 'log', dependsOn: 'observer.well.enabled',
          format: (v) => `${v.toFixed(1)} m`,
        },
        {
          id: 'ctl-well-depth', type: 'range', labelKey: 'controls.observer.wellDepth',
          helpKey: 'controls.observer.wellDepthHelp',
          path: 'observer.well.depth_m', min: 1, max: 10000, step: 1,
          scale: 'log', dependsOn: 'observer.well.enabled',
          format: (v) => formatAltitude(v),
        },
        {
          id: 'ctl-shaft-air', type: 'checkbox', labelKey: 'controls.observer.countShaftAir',
          helpKey: 'controls.observer.countShaftAirHelp',
          path: 'observer.countShaftAir', advanced: true, dependsOn: 'observer.well.enabled',
        },
        {
          id: 'ctl-zoom', type: 'range', labelKey: 'controls.observer.zoom',
          helpKey: 'controls.observer.zoomHelp', path: 'camera.span_m',
          min: MIN_SPAN_M, max: MAX_SPAN_M, step: 1, scale: 'log',
          fallback: (state) => autoSpanFor(
            atmosphereShape(state), state.observer.z, state.observer.well),
          format: (v) => formatAltitude(v),
        },
        {
          id: 'ctl-compare', type: 'checkbox', labelKey: 'compare.enable',
          path: 'compare.enabled',
        },
      ],
    },
    {
      id: 'sec-rays', titleKey: 'controls.rays.title',
      controls: [
        {
          id: 'ctl-ray-count', type: 'range', labelKey: 'controls.rays.count',
          path: 'rays.count', min: 100, max: 5000, step: 100,
          format: (v) => String(Math.round(v)),
        },
        {
          id: 'ctl-show-scattering', type: 'checkbox', labelKey: 'controls.rays.showScattering',
          helpKey: 'controls.rays.showScatteringHelp', path: 'rays.showScattering',
        },
        {
          id: 'ctl-animate', type: 'checkbox', labelKey: 'controls.rays.animate',
          path: 'rays.animate',
        },
        {
          id: 'ctl-brightness', type: 'range', labelKey: 'controls.rays.brightness',
          helpKey: 'controls.rays.brightnessHelp', path: 'rays.brightness',
          min: 0.05, max: 10000, step: 0.001, scale: 'log',
          format: (v) => `${v < 10 ? v.toFixed(2) : Math.round(v)} ×`,
        },
        {
          id: 'ctl-quality', type: 'select', labelKey: 'controls.rays.quality',
          path: 'rays.quality', advanced: true,
          options: () => [
            { value: 'preview', label: i18n.t('controls.rays.qualityPreview') },
            { value: 'normal', label: i18n.t('controls.rays.qualityNormal') },
            { value: 'high', label: i18n.t('controls.rays.qualityHigh') },
          ],
        },
      ],
    },
  ];

  /* ---- construction ---- */

  function build() {
    root.textContent = '';
    for (const section of sections) {
      const wrap = document.createElement('section');
      wrap.className = 'control-section';
      wrap.id = section.id;

      const heading = document.createElement('h2');
      heading.setAttribute('data-i18n', section.titleKey);
      heading.textContent = i18n.t(section.titleKey);
      wrap.appendChild(heading);

      for (const control of section.controls) wrap.appendChild(buildControl(control));
      root.appendChild(wrap);
    }
  }

  function buildControl(control) {
    const field = document.createElement('div');
    field.className = 'field';
    field.id = control.id;
    if (control.advanced) field.dataset.advanced = 'true';

    if (control.type === 'note') {
      field.classList.add('field-note');
      elements.set(control.id, { control, field, input: null, value: null, labelText: null });
      return field;
    }

    const label = document.createElement('label');
    label.className = 'field-label';
    label.htmlFor = control.id + '-input';

    const labelText = document.createElement('span');
    labelText.setAttribute('data-i18n', control.labelKey);
    labelText.textContent = i18n.t(control.labelKey);
    label.appendChild(labelText);

    const value = document.createElement('span');
    value.className = 'field-value';
    label.appendChild(value);

    let input;
    if (control.type === 'range') {
      input = document.createElement('input');
      input.type = 'range';
      if (control.mapping === 'position') { input.min = -1000; input.max = 1000; input.step = 1; }
      else if (control.scale === 'log') { input.min = 0; input.max = 1000; input.step = 1; }
      else { input.min = control.min; input.max = control.max; input.step = control.step; }
      input.addEventListener('input', () => commit(control, readInput(control, input)));
    } else if (control.type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      field.classList.add('field-check');
      input.addEventListener('change', () => commit(control, input.checked));
    } else {
      input = document.createElement('select');
      input.addEventListener('change', () => commit(control, input.value));
    }
    input.id = control.id + '-input';

    if (control.helpKey) {
      input.title = i18n.t(control.helpKey);
      label.title = i18n.t(control.helpKey);
      field.dataset.help = control.helpKey;
    }

    if (control.type === 'checkbox') {
      field.appendChild(input);
      field.appendChild(label);
    } else {
      field.appendChild(label);
      field.appendChild(input);
    }

    elements.set(control.id, { control, field, input, value, labelText });
    return field;
  }

  /* ---- reading and writing ---- */

  function readInput(control, input) {
    const raw = Number(input.value);
    if (control.mapping === 'position') {
      const state = store.state;
      const atmosphereConfig = config.atmospheres.get(state.atmosphere.presetId);
      const maxDepth = state.observer.well.enabled ? state.observer.well.depth_m : 0;
      return sliderToZ(raw, maxAltitudeFor(atmosphereConfig), maxDepth);
    }
    if (control.scale === 'log') return logToValue(raw / 1000, control.min, control.max);
    return raw;
  }

  function commit(control, value) {
    if (control.onChange) {
      store.patch(control.onChange(value));
      return;
    }
    if (control.mapping === 'view') {
      // A signed control: negative means looking away from the star.
      store.patch({
        observer: {
          viewZenithDeg: Math.abs(value),
          viewAzimuthDeg: value >= 0 ? 0 : 180,
        },
      });
      return;
    }
    store.patch(setPath({}, control.path, control.nullable && value === '' ? null : value));
  }

  function currentValue(control, state) {
    if (control.mapping === 'view') {
      const signed = state.observer.viewAzimuthDeg > 90 ? -1 : 1;
      return state.observer.viewZenithDeg * signed;
    }
    const raw = getPath(state, control.path);
    if (raw == null && control.fallback) return control.fallback(state);
    return raw;
  }

  /** Push the current state into every widget. */
  function update() {
    const state = store.state;
    const advanced = state.level === 'advanced';
    const atmosphereConfig = config.atmospheres.get(state.atmosphere.presetId);
    const maxAltitude = maxAltitudeFor(atmosphereConfig);
    const maxDepth = state.observer.well.enabled ? state.observer.well.depth_m : 0;

    for (const { control, field, input, value, labelText } of elements.values()) {
      if (control.type === 'note') {
        field.textContent = control.text(state);
        field.hidden = !field.textContent;
        continue;
      }
      labelText.textContent = i18n.t(control.labelKey);
      if (control.helpKey) {
        input.title = i18n.t(control.helpKey);
        field.title = i18n.t(control.helpKey);
      }

      field.hidden = (control.advanced && !advanced) ||
        (control.dependsOn && !getPath(state, control.dependsOn));

      const raw = currentValue(control, state);

      if (control.type === 'select') {
        const options = control.options();
        const wanted = options.map((o) => o.value).join('|');
        if (input.dataset.signature !== wanted + '|' + i18n.getLanguage()) {
          input.textContent = '';
          for (const option of options) {
            const el = document.createElement('option');
            el.value = option.value;
            el.textContent = option.label;
            input.appendChild(el);
          }
          input.dataset.signature = wanted + '|' + i18n.getLanguage();
        }
        input.value = raw == null ? '' : String(raw);
        value.textContent = '';
      } else if (control.type === 'checkbox') {
        input.checked = Boolean(raw);
        value.textContent = '';
      } else {
        if (control.mapping === 'position') {
          input.value = String(zToSlider(raw, maxAltitude, maxDepth));
        } else if (control.scale === 'log') {
          input.value = String(Math.round(valueToLog(raw, control.min, control.max) * 1000));
        } else {
          input.value = String(raw);
        }
        value.textContent = control.format ? control.format(Number(raw)) : String(raw);
      }
    }
  }

  /** Briefly draw attention to a control named by a guided experiment. */
  function highlight(controlId) {
    for (const { field } of elements.values()) field.classList.remove('is-highlighted');
    const entry = elements.get(controlId);
    if (!entry) return;
    entry.field.classList.add('is-highlighted');
    entry.field.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  build();
  update();
  return { update, highlight, rebuild: () => { build(); update(); } };
}

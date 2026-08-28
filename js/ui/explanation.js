/**
 * The explanation panel.
 *
 * It looks at the state the student has actually produced and picks the one
 * story that fits, then fills that story with the numbers currently on screen.
 * Order matters: the tests run from the most specific situation to the most
 * general, so standing at the bottom of a deep shaft is explained as a shaft
 * and not as "a slightly dark daytime sky".
 */

import { formatAltitude, formatAngle } from '../render/scene-renderer.js';

const SPACE_COLUMN_FRACTION = 2e-3;
const AIRLESS_TAU = 1e-6;
const THIN_TAU = 0.03;
const DENSE_TAU = 3;
const DEEP_APERTURE_DEG = 1;

export function createExplanation(root, { i18n, store }) {
  const seeTitle = root.querySelector('#explain-see-title');
  const seeBody = root.querySelector('#explain-see-body');
  const whyTitle = root.querySelector('#explain-why-title');
  const whyBody = root.querySelector('#explain-why-body');
  const badge = root.querySelector('#explain-badge');

  /** Choose which explanation applies. */
  function classify(result, state) {
    const m = result.primary.metrics;
    const scene = result.primary.scene;
    const tau550 = m.verticalTau[550];

    if (scene.wellActive) {
      return m.apertureHalfAngleDeg < DEEP_APERTURE_DEG ? 'wellDeep' : 'wellShallow';
    }
    // "Airless" is a property of the world, so it is judged at the surface;
    // "space" is a property of where the observer has climbed to. Testing the
    // observer's own optical depth would call the top of a thick atmosphere
    // airless, which is exactly the confusion the two texts exist to prevent.
    const surfaceTau = result.atmosphere.opticalDepth(
      result.atmosphere.verticalColumnRayleigh(0),
      result.atmosphere.verticalColumnAerosol(0))[Math.round((550 - 380) / 10)];
    if (surfaceTau < AIRLESS_TAU) return 'airless';
    if (m.columnFraction < SPACE_COLUMN_FRACTION) return 'space';
    // A world with real air but almost none of it: the scattering law is
    // untouched, only the amount of material is missing.
    if (surfaceTau < THIN_TAU && m.atmosphericAltitude < 3000) return 'thinAir';
    if (state.star.elevationDeg < 0) return 'twilight';
    if (state.star.elevationDeg < 10) return 'sunset';
    if (tau550 > DENSE_TAU) return 'denseAtmosphere';

    // Is the aerosol doing more of the scattering than the gas?
    const atmosphere = result.atmosphere;
    const index550 = Math.round((550 - 380) / 10);
    const gas = atmosphere.rayleighBeta0[index550] * atmosphere.scaleHeightRayleigh;
    const dust = atmosphere.aerosolSca0[index550] * atmosphere.scaleHeightAerosol;
    if (dust > gas) return 'dusty';

    if (m.atmosphericAltitude > 3000) return 'highAltitude';
    if (state.star.temperatureK < 4000) return 'coldStar';
    if (state.star.temperatureK > 9000) return 'hotStar';
    return 'daySky';
  }

  /** Numbers the explanation texts can quote. */
  function parameters(result, state) {
    const m = result.primary.metrics;
    const atmosphere = result.atmosphere;
    const i450 = Math.round((450 - 380) / 10);
    const i650 = Math.round((650 - 380) / 10);
    const scatterRatio = atmosphere.rayleighBeta0[i650] > 0
      ? atmosphere.rayleighBeta0[i450] / atmosphere.rayleighBeta0[i650]
      : 0;
    const illumination = result.primary.illumination;

    return {
      ratio: scatterRatio.toFixed(1),
      airmass: m.airMass >= 10 ? Math.round(m.airMass) : m.airMass.toFixed(1),
      tau450: formatTau(m.beamTau[450]),
      tau650: formatTau(m.beamTau[650]),
      z: formatAltitude(Math.abs(m.z)),
      scaleHeight: formatAltitude(m.scaleHeight),
      columnPercent: m.columnFraction >= 0.01
        ? `${(m.columnFraction * 100).toFixed(1)} %`
        : `${(m.columnFraction * 100).toExponential(1)} %`,
      aperture: formatAngle(m.apertureHalfAngleDeg),
      solidAngle: `${m.apertureSolidAngle.toExponential(2)} sr`,
      g: atmosphere.asymmetryG.toFixed(2),
      tau550: formatTau(m.verticalTau[550]),
      illuminanceRatio: illumination.totalOpen > 0
        ? (illumination.total / illumination.totalOpen).toExponential(1) : '0',
    };
  }

  function formatTau(value) {
    if (!Number.isFinite(value)) return '-';
    if (value >= 0.01 && value < 1000) return value.toFixed(2);
    return value.toExponential(1);
  }

  function update(result) {
    const state = store.state;
    const key = classify(result, state);
    const params = parameters(result, state);
    // The well texts quote the illuminance ratio under the name `ratio`.
    if (key === 'wellDeep') params.ratio = params.illuminanceRatio;

    seeTitle.textContent = i18n.t('explain.titleSee');
    whyTitle.textContent = i18n.t('explain.titleWhy');
    seeBody.textContent = i18n.t(`explain.states.${key}.see`, params);
    whyBody.textContent = i18n.t(`explain.states.${key}.why`, params);
    badge.textContent = key;
    root.dataset.state = key;
  }

  return { update };
}

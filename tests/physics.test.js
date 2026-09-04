/**
 * The physics test suite.
 *
 * These are not smoke tests. Each one pins down a claim the simulator makes to
 * students, so that a future change which quietly breaks the teaching shows up
 * as a red line rather than as a slightly different shade of blue.
 */

import {
  SPECTRUM_BINS, SPECTRUM_MIN_NM, SPECTRUM_MAX_NM, SPECTRUM_STEP_NM,
  WAVELENGTHS_NM, planckSpectralRadiance, wienPeakNm, makeBlackbodySpectrum,
  specConst, specIntegral,
} from '../js/physics/spectrum.js';
import {
  RAY_BANDS, RAY_BAND_COUNT, BAND_OF_BIN, bandOfWavelength,
} from '../js/physics/spectrum.js';
import {
  rayleighBetaSpectrum, aerosolBetaSpectrum, resolveAlbedoSpectrum,
  rayleighPhase, henyeyGreensteinPhase, sampleRayleighCosine,
} from '../js/physics/scattering.js';
import { createAtmosphere } from '../js/physics/atmosphere.js';
import { createColorimetry } from '../js/physics/color.js';
import {
  wellApertureHalfAngle, wellIsBlocked, wellSolidAngle,
  wellIlluminanceFraction, wellShaftColumn, fieldOfViewSkyShare,
} from '../js/physics/well.js';
import {
  buildScene, computeViewRadiance, computeDirectBeam, computeIllumination,
  QUALITY_PRESETS,
} from '../js/physics/radiance.js';
import { directionFromAngles, sunDirectionFromElevation, raySphereFar, raySphereNear, v3 } from '../js/physics/geometry.js';
import {
  sliderToZ, zToSlider, createStore, DEFAULT_STATE,
  clampSpan, MIN_SPAN_M, MAX_SPAN_M,
} from '../js/state.js';
import {
  tracePhotons, summarisePhotons, histogramPhotons, VIEW_CONE_HALF_DEG,
  drawnRayShare, isRayDrawn, skyFromRays, shaftWallSpectrum,
} from '../js/render/photons.js';

const INDEX = (nm) => Math.round((nm - SPECTRUM_MIN_NM) / SPECTRUM_STEP_NM);

/** Numerically integrate a phase function over the whole solid angle. */
function integratePhase(fn, samples = 40000) {
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const mu = -1 + (2 * (i + 0.5)) / samples;
    sum += fn(mu) * (2 / samples);
  }
  return sum * 2 * Math.PI;
}

export function registerTests({ group, test, assert }, config) {
  const colorimetry = createColorimetry(config.color);
  const earth = createAtmosphere(config.atmospheres.earth);

  const sunSpectrum = makeBlackbodySpectrum(5800);
  colorimetry.normalizeToLuminance(sunSpectrum, 1);

  const sceneAt = (options = {}) => buildScene({
    atmosphere: options.atmosphere ?? earth,
    sourceSpectrum: options.source ?? sunSpectrum,
    sunDirection: sunDirectionFromElevation(options.elevation ?? 60),
    sunElevationDeg: options.elevation ?? 60,
    observerZ: options.z ?? 0,
    well: options.well ?? { enabled: false, radius_m: 1 },
    countShaftAir: options.countShaftAir ?? false,
  });
  const ZENITH = directionFromAngles(0, 0);

  /* ---------------------------------------------------------------- */

  group('spectral grid', () => {
    test('has 38 bins from 380 nm to 750 nm at 10 nm spacing', () => {
      assert.equal(SPECTRUM_BINS, 38);
      assert.equal(WAVELENGTHS_NM[0], SPECTRUM_MIN_NM);
      assert.equal(WAVELENGTHS_NM[SPECTRUM_BINS - 1], SPECTRUM_MAX_NM);
      assert.equal(WAVELENGTHS_NM[1] - WAVELENGTHS_NM[0], SPECTRUM_STEP_NM);
    });

    test('Planck law peaks where the Wien displacement law says it should', () => {
      for (const T of [3000, 5800, 12000]) {
        const peak = wienPeakNm(T);
        const below = planckSpectralRadiance(peak * 0.8, T);
        const at = planckSpectralRadiance(peak, T);
        const above = planckSpectralRadiance(peak * 1.2, T);
        assert.greater(at, below, `T=${T}: peak should exceed the short side`);
        assert.greater(at, above, `T=${T}: peak should exceed the long side`);
      }
      assert.close(wienPeakNm(5800), 499.6, 1e-3);
    });

    test('Planck radiance rises everywhere with temperature', () => {
      for (const nm of [400, 550, 700]) {
        assert.greater(planckSpectralRadiance(nm, 6000), planckSpectralRadiance(nm, 5000));
      }
    });

    test('a cold star emits relatively more red than a hot one', () => {
      const cold = makeBlackbodySpectrum(3000);
      const hot = makeBlackbodySpectrum(12000);
      const coldRatio = cold[INDEX(450)] / cold[INDEX(650)];
      const hotRatio = hot[INDEX(450)] / hot[INDEX(650)];
      assert.less(coldRatio, hotRatio);
    });
  });

  /* ---------------------------------------------------------------- */

  group('Rayleigh scattering', () => {
    test('cross-section follows an exact inverse fourth power of wavelength', () => {
      const beta = rayleighBetaSpectrum(1.35e-5, 4);
      for (const [a, b] of [[400, 700], [450, 650], [380, 750]]) {
        const predicted = Math.pow(b / a, 4);
        const actual = beta[INDEX(a)] / beta[INDEX(b)];
        assert.close(actual, predicted, 1e-12,
          `beta(${a})/beta(${b}) should equal (${b}/${a})^4`);
      }
    });

    test('reproduces the published sea-level coefficients for Earth air', () => {
      const beta = rayleighBetaSpectrum(1.35e-5, 4);
      assert.close(beta[INDEX(440)], 3.31e-5, 0.02);
      assert.close(beta[INDEX(680)], 5.8e-6, 0.02);
    });

    test('the exponent is honoured, so n = 0 gives a colourless cross-section', () => {
      const grey = rayleighBetaSpectrum(1e-5, 0);
      assert.close(grey[INDEX(400)], grey[INDEX(700)], 1e-12);
    });

    test('phase function integrates to exactly one over the sphere', () => {
      assert.close(integratePhase(rayleighPhase), 1, 1e-5);
    });

    test('phase function is symmetric and twice as strong forwards as sideways', () => {
      assert.close(rayleighPhase(1), rayleighPhase(-1), 1e-12);
      assert.close(rayleighPhase(1) / rayleighPhase(0), 2, 1e-12);
    });

    test('sampled scattering cosines reproduce the phase function mean', () => {
      let sum = 0, sumSq = 0;
      const n = 200000;
      // xorshift32: a linear congruential generator would overflow the 53-bit
      // mantissa here and quietly stop being random.
      let seed = 2463534242;
      const rng = () => {
        seed ^= seed << 13; seed >>>= 0;
        seed ^= seed >> 17;
        seed ^= seed << 5; seed >>>= 0;
        return seed / 4294967296;
      };
      for (let i = 0; i < n; i++) {
        const mu = sampleRayleighCosine(rng);
        sum += mu; sumSq += mu * mu;
      }
      // Rayleigh is symmetric: <mu> = 0 and <mu^2> = 2/5.
      assert.between(Math.abs(sum / n), 0, 0.01, 'the mean cosine of a symmetric phase function must vanish');
      assert.close(sumSq / n, 0.4, 0.02);
    });
  });

  /* ---------------------------------------------------------------- */

  group('aerosol approximation', () => {
    test('Angstrom exponent controls the wavelength dependence', () => {
      const neutral = aerosolBetaSpectrum(2e-5, 0);
      assert.close(neutral[INDEX(400)], neutral[INDEX(700)], 1e-12);
      const tilted = aerosolBetaSpectrum(2e-5, 1);
      assert.close(tilted[INDEX(400)] / tilted[INDEX(700)], 700 / 400, 1e-12);
    });

    test('Henyey-Greenstein integrates to one for every asymmetry', () => {
      for (const g of [0, 0.3, 0.7, 0.9]) {
        assert.close(integratePhase((mu) => henyeyGreensteinPhase(mu, g)), 1, 2e-3, `g = ${g}`);
      }
    });

    test('a forward-peaked lobe really does favour the forward direction', () => {
      assert.greater(henyeyGreensteinPhase(1, 0.76), henyeyGreensteinPhase(-1, 0.76) * 100);
    });

    test('an albedo table is interpolated and clamped at its ends', () => {
      const albedo = resolveAlbedoSpectrum({ wavelengths_nm: [400, 600], values: [0.5, 0.9] });
      assert.close(albedo[INDEX(400)], 0.5, 1e-9);
      assert.close(albedo[INDEX(500)], 0.7, 1e-9);
      assert.close(albedo[INDEX(600)], 0.9, 1e-9);
      assert.close(albedo[INDEX(380)], 0.5, 1e-9, 'clamped below the table');
      assert.close(albedo[INDEX(750)], 0.9, 1e-9, 'clamped above the table');
    });
  });

  /* ---------------------------------------------------------------- */

  group('atmosphere and Beer-Lambert', () => {
    test('density falls by a factor of e over one scale height', () => {
      const H = earth.scaleHeightRayleigh;
      assert.close(earth.densityRayleigh(0), 1, 1e-12);
      assert.close(earth.densityRayleigh(H), 1 / Math.E, 1e-12);
      assert.close(earth.densityRayleigh(2 * H), 1 / (Math.E * Math.E), 1e-12);
    });

    test('the vertical column matches the closed-form integral H exp(-z/H)', () => {
      const H = earth.scaleHeightRayleigh;
      assert.close(earth.verticalColumnRayleigh(0), H, 1e-12);
      assert.close(earth.verticalColumnRayleigh(H), H / Math.E, 1e-12);
      assert.close(earth.verticalColumnRayleigh(3 * H), H * Math.exp(-3), 1e-12);
    });

    test('transmission obeys T = exp(-tau)', () => {
      const column = earth.verticalColumnRayleigh(0);
      const tau = earth.opticalDepth(column, 0);
      const T = earth.transmittance(column, 0);
      for (const nm of [400, 550, 700]) {
        assert.close(T[INDEX(nm)], Math.exp(-tau[INDEX(nm)]), 1e-12, `at ${nm} nm`);
      }
    });

    test('doubling the column squares the transmission', () => {
      const column = earth.verticalColumnRayleigh(0);
      const single = earth.transmittance(column, 0);
      const doubled = earth.transmittance(2 * column, 0);
      for (const nm of [420, 550, 680]) {
        assert.close(doubled[INDEX(nm)], single[INDEX(nm)] ** 2, 1e-9, `at ${nm} nm`);
      }
    });

    test('transmission is one through vacuum and never leaves [0, 1]', () => {
      const none = earth.transmittance(0, 0);
      for (let i = 0; i < SPECTRUM_BINS; i++) assert.close(none[i], 1, 1e-12);
      const heavy = earth.transmittance(1e9, 1e9);
      for (let i = 0; i < SPECTRUM_BINS; i++) assert.between(heavy[i], 0, 1);
    });

    test('optical depth at 550 nm sits near the measured Rayleigh value', () => {
      const tau = earth.opticalDepth(earth.verticalColumnRayleigh(0), 0);
      assert.between(tau[INDEX(550)], 0.08, 0.13);
    });

    test('short wavelengths are always attenuated more than long ones', () => {
      const T = earth.transmittance(earth.verticalColumnRayleigh(0), 0);
      const values = [];
      for (const nm of [400, 450, 500, 550, 600, 650, 700]) values.push(T[INDEX(nm)]);
      for (let i = 1; i < values.length; i++) assert.greater(values[i], values[i - 1]);
    });

    test('the mass column above sea level matches surface pressure divided by g', () => {
      const cfg = config.atmospheres.earth;
      assert.close(earth.massColumn(0), (cfg.surfacePressure_kPa * 1000) / cfg.surfaceGravity_mps2, 1e-9);
    });
  });

  /* ---------------------------------------------------------------- */

  group('spherical geometry and air mass', () => {
    test('a ray leaving straight up exits through the top of the atmosphere', () => {
      const origin = earth.observerPosition(0);
      const distance = raySphereFar(origin, ZENITH, earth.topRadius);
      assert.close(distance, earth.topAltitude, 1e-6);
    });

    test('a ray aimed below the horizon hits the ground', () => {
      const origin = earth.observerPosition(50000);
      const down = directionFromAngles(Math.PI, 0);
      assert.greater(raySphereNear(origin, down, earth.planetRadius), 0);
    });

    test('air mass is 1 at the zenith and follows sec(z) at moderate angles', () => {
      const origin = earth.observerPosition(0);
      const vertical = earth.verticalColumnRayleigh(0);
      const airMass = (deg) => {
        const dir = directionFromAngles((deg * Math.PI) / 180, 0);
        const ext = earth.rayExtent(origin, dir);
        return earth.pathColumns(origin, dir, ext.distance, 400).columnR / vertical;
      };
      assert.close(airMass(0), 1, 2e-3);
      assert.close(airMass(60), 2, 0.02);
      assert.close(airMass(70), 1 / Math.cos((70 * Math.PI) / 180), 0.03);
    });

    test('the curved atmosphere keeps the horizon air mass finite', () => {
      const origin = earth.observerPosition(0);
      const dir = directionFromAngles(Math.PI / 2, 0);
      const ext = earth.rayExtent(origin, dir);
      const airMass = earth.pathColumns(origin, dir, ext.distance, 600).columnR /
        earth.verticalColumnRayleigh(0);
      assert.finite(airMass);
      assert.between(airMass, 25, 45, 'the classic value is about 38');
    });
  });

  /* ---------------------------------------------------------------- */

  group('colour science', () => {
    test('equal-energy white lands on the white point of the diagram', () => {
      const white = colorimetry.spectrumToSrgb(specConst(1), 1);
      assert.close(white.chromaticity[0], 1 / 3, 2e-3);
      assert.close(white.chromaticity[1], 1 / 3, 2e-3);
    });

    test('tristimulus values are never negative for a physical spectrum', () => {
      for (const T of [2000, 5800, 20000]) {
        const xyz = colorimetry.spectrumToXYZ(makeBlackbodySpectrum(T));
        for (const component of xyz) assert.greater(component, 0);
      }
    });

    test('encoded sRGB always stays inside the 0 to 255 cube', () => {
      const spectra = [
        specConst(0), specConst(1), specConst(1e6),
        makeBlackbodySpectrum(2000), makeBlackbodySpectrum(20000),
      ];
      for (const spectrum of spectra) {
        for (const exposure of [1e-6, 1, 1e6]) {
          const c = colorimetry.spectrumToSrgb(spectrum, exposure);
          for (const channel of c.rgb) {
            assert.between(channel, 0, 255);
            assert.equal(Number.isInteger(channel), true);
          }
        }
      }
    });

    test('luminance is linear in the spectrum', () => {
      const base = makeBlackbodySpectrum(5800);
      const Y = colorimetry.luminance(base);
      const scaled = base.map((v) => v * 3.5);
      assert.close(colorimetry.luminance(scaled), Y * 3.5, 1e-12);
    });

    test('exposure changes brightness but never chromaticity', () => {
      const spectrum = makeBlackbodySpectrum(5800);
      const dim = colorimetry.spectrumToSrgb(spectrum, 1e-4);
      const bright = colorimetry.spectrumToSrgb(spectrum, 1e-2);
      assert.close(dim.chromaticity[0], bright.chromaticity[0], 1e-12);
      assert.close(dim.chromaticity[1], bright.chromaticity[1], 1e-12);
    });

    test('the black body locus runs from red through white to blue', () => {
      const xs = [2000, 3000, 4500, 5800, 9000, 20000].map((T) => {
        const s = makeBlackbodySpectrum(T);
        return colorimetry.spectrumToSrgb(s, 1).chromaticity[0];
      });
      assert.decreasing(xs, 'chromaticity x must fall as the star gets hotter');
    });

    test('gamut fitting desaturates rather than producing negative light', () => {
      const fitted = colorimetry.fitToGamut([-0.4, 0.2, 0.9]);
      for (const c of fitted.rgb) assert.greater(c, -1e-12);
      assert.equal(fitted.desaturated, true);
    });
  });

  /* ---------------------------------------------------------------- */

  group('the sky', () => {
    test('daylight scattering is stronger at short wavelengths', () => {
      const r = computeViewRadiance(sceneAt({ elevation: 60 }), ZENITH, QUALITY_PRESETS.high);
      assert.greater(r.scattered[INDEX(450)], r.scattered[INDEX(650)] * 2);
    });

    test('the zenith sky is blue, and measurably so', () => {
      const noAerosol = createAtmosphere(config.atmospheres.earth, { aerosolScale: 0 });
      const r = computeViewRadiance(
        sceneAt({ atmosphere: noAerosol, elevation: 45 }), ZENITH, QUALITY_PRESETS.high);
      const c = colorimetry.spectrumToSrgb(r.scattered, 45);
      // Clear-sky measurements cluster around x = 0.24 to 0.27, y = 0.24 to 0.28.
      assert.between(c.chromaticity[0], 0.22, 0.29);
      assert.between(c.chromaticity[1], 0.22, 0.30);
      assert.greater(c.linear[2], c.linear[0], 'blue must exceed red');
      assert.greater(c.linear[1], c.linear[0], 'green must exceed red');
    });

    test('turning off the wavelength dependence turns off the colour', () => {
      const grey = createAtmosphere(config.atmospheres.earth,
        { aerosolScale: 0, rayleighExponent: 0 });
      const r = computeViewRadiance(
        sceneAt({ atmosphere: grey, elevation: 45 }), ZENITH, QUALITY_PRESETS.high);
      const c = colorimetry.spectrumToSrgb(r.scattered, 45);
      assert.close(c.chromaticity[0], 1 / 3, 0.06, 'a grey cross-section must give a near-white sky');
    });

    test('scattering never manufactures energy', () => {
      const scene = sceneAt({ elevation: 60 });
      const r = computeViewRadiance(scene, ZENITH, QUALITY_PRESETS.high);
      for (let i = 0; i < SPECTRUM_BINS; i++) {
        assert.greater(scene.source[i] + 1e-18, r.scattered[i]);
      }
    });

    test('sky radiance falls monotonically as the observer climbs', () => {
      const values = [0, 2000, 5000, 10000, 20000, 40000, 80000].map((z) =>
        colorimetry.luminance(
          computeViewRadiance(sceneAt({ z, elevation: 60 }), ZENITH, QUALITY_PRESETS.high).scattered));
      assert.decreasing(values);
    });

    test('at the top of the atmosphere the sky is black while the star still shines', () => {
      const scene = sceneAt({ z: 100000, elevation: 60 });
      const sky = computeViewRadiance(scene, ZENITH, QUALITY_PRESETS.high);
      const beam = computeDirectBeam(scene, QUALITY_PRESETS.high);
      assert.less(colorimetry.luminance(sky.scattered), 1e-6);
      assert.close(colorimetry.luminance(beam.spectrum), 1, 1e-3);
    });

    test('an airless world has a black sky at noon and full transmission', () => {
      const moon = createAtmosphere(config.atmospheres['airless-moon']);
      const scene = sceneAt({ atmosphere: moon, elevation: 60 });
      const sky = computeViewRadiance(scene, ZENITH, QUALITY_PRESETS.high);
      const beam = computeDirectBeam(scene, QUALITY_PRESETS.high);
      assert.less(colorimetry.luminance(sky.scattered), 1e-9);
      assert.close(colorimetry.luminance(beam.spectrum), 1, 1e-6);
    });
  });

  /* ---------------------------------------------------------------- */

  group('the sunset', () => {
    test('lowering the star lengthens the path and reddens the beam', () => {
      const airMasses = [], reds = [], blues = [];
      for (const elevation of [90, 60, 30, 10, 5, 2]) {
        const beam = computeDirectBeam(sceneAt({ elevation }), QUALITY_PRESETS.high);
        airMasses.push(beam.airMass);
        blues.push(beam.spectrum[INDEX(450)]);
        reds.push(beam.spectrum[INDEX(650)]);
      }
      for (let i = 1; i < airMasses.length; i++) {
        assert.greater(airMasses[i], airMasses[i - 1], 'air mass must grow');
      }
      assert.decreasing(blues, 'blue must fade');
      assert.decreasing(reds, 'red must fade too, only slower');
      // The ratio of what survives must swing decisively towards red.
      const startRatio = blues[0] / reds[0];
      const endRatio = blues[blues.length - 1] / reds[reds.length - 1];
      assert.less(endRatio, startRatio / 20, 'the blue-to-red ratio must collapse');
    });

    test('the low star is chromatically redder, not merely dimmer', () => {
      const high = computeDirectBeam(sceneAt({ elevation: 60 }), QUALITY_PRESETS.high);
      const low = computeDirectBeam(sceneAt({ elevation: 2 }), QUALITY_PRESETS.high);
      const cHigh = colorimetry.spectrumToSrgb(high.spectrum, 1);
      const cLow = colorimetry.spectrumToSrgb(low.spectrum, 1);
      assert.greater(cLow.chromaticity[0], cHigh.chromaticity[0] + 0.1);
    });

    test('optical depth is far larger for blue than for red along a low path', () => {
      const beam = computeDirectBeam(sceneAt({ elevation: 5 }), QUALITY_PRESETS.high);
      assert.greater(beam.opticalDepth[INDEX(450)], beam.opticalDepth[INDEX(650)] * 3);
    });

    test('a star below the horizon delivers no direct light', () => {
      const beam = computeDirectBeam(sceneAt({ elevation: -5 }), QUALITY_PRESETS.high);
      assert.equal(beam.visible, false);
      assert.close(colorimetry.luminance(beam.spectrum), 0, 1e-12);
    });
  });

  /* ---------------------------------------------------------------- */

  group('well geometry', () => {
    test('the blocking condition is exactly tan(theta) > R / d', () => {
      const depth = 10, radius = 2;
      const critical = Math.atan(radius / depth);
      assert.equal(wellIsBlocked(critical * 0.99, depth, radius), false);
      assert.equal(wellIsBlocked(critical * 1.01, depth, radius), true);
      assert.equal(wellIsBlocked(0, depth, radius), false, 'the zenith is always visible');
      assert.equal(wellIsBlocked(Math.PI / 2, depth, radius), true, 'the horizon never is');
    });

    test('no direction is blocked when the observer is not below datum', () => {
      assert.equal(wellIsBlocked(1.4, 0, 2), false);
      assert.close(wellApertureHalfAngle(0, 2), Math.PI / 2, 1e-12);
    });

    test('aperture half-angle is arctan(R/d) and shrinks with depth', () => {
      assert.close(wellApertureHalfAngle(10, 10), Math.PI / 4, 1e-12);
      assert.close(wellApertureHalfAngle(100, 1), Math.atan(0.01), 1e-12);
      const angles = [1, 10, 100, 1000].map((d) => wellApertureHalfAngle(d, 1));
      assert.decreasing(angles);
    });

    test('solid angle follows 2 pi (1 - cos theta) and reaches a hemisphere when open', () => {
      assert.close(wellSolidAngle(Math.PI / 2), 2 * Math.PI, 1e-12);
      assert.close(wellSolidAngle(Math.PI / 3), 2 * Math.PI * 0.5, 1e-12);
    });

    test('illuminance fraction follows sin squared of the half-angle', () => {
      for (const [d, R] of [[1, 1], [10, 1], [100, 2]]) {
        const half = wellApertureHalfAngle(d, R);
        assert.close(wellIlluminanceFraction(d, R), Math.sin(half) ** 2, 1e-12);
      }
      assert.close(wellIlluminanceFraction(0, 1), 1, 1e-12);
    });

    test('the shaft air column is the exponential profile continued downwards', () => {
      const H = 8500;
      assert.close(wellShaftColumn(0, H), 0, 1e-12);
      assert.close(wellShaftColumn(H, H), H * (Math.E - 1), 1e-12);
    });
  });

  /* ---------------------------------------------------------------- */

  group('the well paradox', () => {
    const well = { enabled: true, radius_m: 2, depth_m: 10000 };

    test('descending leaves the radiance of the visible sky completely unchanged', () => {
      const surface = computeViewRadiance(
        sceneAt({ z: 0, elevation: 70 }), ZENITH, QUALITY_PRESETS.high);
      for (const depth of [1, 100, 10000]) {
        const inside = computeViewRadiance(
          sceneAt({ z: -depth, elevation: 70, well }), ZENITH, QUALITY_PRESETS.high);
        assert.close(
          colorimetry.luminance(inside.scattered),
          colorimetry.luminance(surface.scattered), 1e-12,
          `at depth ${depth} m the patch of sky overhead must be identical`);
      }
    });

    test('descending leaves the colour of that sky unchanged too', () => {
      const surface = colorimetry.spectrumToSrgb(computeViewRadiance(
        sceneAt({ z: 0, elevation: 70 }), ZENITH, QUALITY_PRESETS.high).scattered, 45);
      const deep = colorimetry.spectrumToSrgb(computeViewRadiance(
        sceneAt({ z: -10000, elevation: 70, well }), ZENITH, QUALITY_PRESETS.high).scattered, 45);
      assert.equal(deep.css, surface.css);
    });

    test('climbing, by contrast, really does dim and redden the same patch', () => {
      const surface = computeViewRadiance(
        sceneAt({ z: 0, elevation: 70 }), ZENITH, QUALITY_PRESETS.high);
      const aloft = computeViewRadiance(
        sceneAt({ z: 10000, elevation: 70 }), ZENITH, QUALITY_PRESETS.high);
      assert.less(
        colorimetry.luminance(aloft.scattered),
        colorimetry.luminance(surface.scattered) * 0.5);
    });

    test('the shaft wall blocks everything outside the aperture', () => {
      const scene = sceneAt({ z: -10000, elevation: 70, well });
      const sideways = computeViewRadiance(
        scene, directionFromAngles(Math.PI / 4, 0), QUALITY_PRESETS.preview);
      assert.equal(sideways.blocked, true);
      assert.close(colorimetry.luminance(sideways.scattered), 0, 1e-12);
    });

    test('illuminance collapses with the visible solid angle, not with the air', () => {
      const open = computeIllumination(sceneAt({ z: 0, elevation: 70 }), colorimetry);
      const deep = computeIllumination(sceneAt({ z: -1000, elevation: 70, well }), colorimetry);
      const ratio = deep.skyIlluminance / open.skyIlluminance;
      const predicted = wellIlluminanceFraction(1000, 2);
      assert.greater(ratio, 0, 'a real, non-zero amount of light must remain');
      // The analytic form assumes a uniform sky, so a factor-of-two band is right.
      assert.between(ratio / predicted, 0.4, 2.5);
    });

    test('the atmospheric column above the observer does not change with depth', () => {
      const surface = sceneAt({ z: 0 });
      const deep = sceneAt({ z: -10000, well });
      assert.equal(deep.atmosphericAltitude, surface.atmosphericAltitude);
      assert.close(
        earth.verticalColumnRayleigh(deep.atmosphericAltitude),
        earth.verticalColumnRayleigh(0), 1e-12);
    });

    test('the optional shaft air is what finally makes descent atmospheric', () => {
      const plain = computeViewRadiance(
        sceneAt({ z: -20000, elevation: 70, well }), ZENITH, QUALITY_PRESETS.high);
      const withAir = computeViewRadiance(
        sceneAt({ z: -20000, elevation: 70, well, countShaftAir: true }), ZENITH, QUALITY_PRESETS.high);
      assert.less(
        colorimetry.luminance(withAir.scattered),
        colorimetry.luminance(plain.scattered));
    });
  });

  /* ---------------------------------------------------------------- */

  group('alien atmospheres', () => {
    test('dust-free thin CO2 still gives a blue, only much fainter, sky', () => {
      const thin = createAtmosphere(config.atmospheres['thin-co2']);
      const r = computeViewRadiance(sceneAt({ atmosphere: thin, elevation: 60 }), ZENITH, QUALITY_PRESETS.high);
      const c = colorimetry.spectrumToSrgb(r.scattered, 45);
      assert.greater(c.linear[2], c.linear[0], 'still blue');
      const earthSky = computeViewRadiance(sceneAt({ elevation: 60 }), ZENITH, QUALITY_PRESETS.high);
      assert.less(colorimetry.luminance(r.scattered), colorimetry.luminance(earthSky.scattered) * 0.2);
    });

    test('Martian dust turns the same starlight into a warm sky', () => {
      const mars = createAtmosphere(config.atmospheres.mars);
      const r = computeViewRadiance(sceneAt({ atmosphere: mars, elevation: 60 }), ZENITH, QUALITY_PRESETS.high);
      const c = colorimetry.spectrumToSrgb(r.scattered, 45);
      assert.greater(c.chromaticity[0], 0.33, 'chromaticity must move to the warm side');
      assert.greater(c.linear[0], c.linear[2], 'red must now exceed blue');
    });

    test('a hotter star makes the same air bluer', () => {
      const cold = makeBlackbodySpectrum(3000);
      const hot = makeBlackbodySpectrum(12000);
      colorimetry.normalizeToLuminance(cold, 1);
      colorimetry.normalizeToLuminance(hot, 1);
      const xCold = colorimetry.spectrumToSrgb(computeViewRadiance(
        sceneAt({ source: cold, elevation: 60 }), ZENITH, QUALITY_PRESETS.high).scattered, 45).chromaticity[0];
      const xHot = colorimetry.spectrumToSrgb(computeViewRadiance(
        sceneAt({ source: hot, elevation: 60 }), ZENITH, QUALITY_PRESETS.high).scattered, 45).chromaticity[0];
      assert.less(xHot, xCold);
    });
  });

  /* ---------------------------------------------------------------- */

  group('light paths drawn in the cross-section', () => {
    /** Fraction of the drawn paths of one kind that are short-wavelength. */
    function blueFraction(paths, kind) {
      const set = paths.filter((p) => p.kind === kind);
      if (set.length === 0) return null;
      return set.filter((p) => p.lambda < 520).length / set.length;
    }

    /** Blue share of the source itself, for comparison. */
    function sourceBlue(spectrum) {
      let all = 0, blue = 0;
      for (let i = 0; i < spectrum.length; i++) {
        all += spectrum[i];
        if (380 + i * 10 < 520) blue += spectrum[i];
      }
      return blue / all;
    }

    const SPAN = 25500, SKY = SPAN * 0.95, HALF = 21000;
    const trace = (options = {}) => tracePhotons({
      atmosphere: earth, source: sunSpectrum, sunElevationDeg: 40, observerZ: 0,
      count: 3000, span_m: SPAN, skyExtent_m: SKY, halfWidth_m: HALF,
      seed: 42, ...options,
    });

    const earthPaths = trace();
    const earthTally = summarisePhotons(earthPaths, { source: sunSpectrum });
    const arrivingBlue = earthTally.arriving.blue / earthTally.arriving.total;
    const throughBlue = earthTally.through.blue / earthTally.through.total;

    test('the light that arrives at the observer is far bluer than the star it came from', () => {
      assert.greater(arrivingBlue, sourceBlue(sunSpectrum) * 1.4);
    });

    test('the light that crosses unscattered is redder than the star it came from', () => {
      assert.less(throughBlue, sourceBlue(sunSpectrum));
    });

    test('arriving light is bluer than the light that got through, by a wide margin', () => {
      assert.greater(arrivingBlue, throughBlue * 1.6);
    });

    test('every ray is drawn in one of eight colours, and they tile the spectrum', () => {
      // Thirty-eight shades running smoothly from violet to red read as one
      // continuous wash and cannot be counted. Eight can, which is the whole
      // reason for the bands - so they have to be a partition: every bin in
      // exactly one band, no gaps, no overlaps, and no two bands so close in
      // colour that counting them is guesswork.
      assert.between(RAY_BAND_COUNT, 7, 10);
      assert.equal(RAY_BANDS[0].fromNm, SPECTRUM_MIN_NM);
      assert.greater(RAY_BANDS[RAY_BAND_COUNT - 1].edgeNm, SPECTRUM_MAX_NM);
      for (let b = 1; b < RAY_BAND_COUNT; b++) {
        assert.equal(RAY_BANDS[b].fromNm, RAY_BANDS[b - 1].edgeNm,
          `band ${b} must start where band ${b - 1} ends`);
      }
      for (let i = 0; i < SPECTRUM_BINS; i++) {
        const band = RAY_BANDS[BAND_OF_BIN[i]];
        assert.between(WAVELENGTHS_NM[i], band.fromNm, band.toNm,
          `${WAVELENGTHS_NM[i]} nm was filed under ${band.fromNm}-${band.toNm}`);
        assert.equal(bandOfWavelength(WAVELENGTHS_NM[i]), BAND_OF_BIN[i]);
      }
      for (let a = 0; a < RAY_BAND_COUNT; a++) {
        for (let b = a + 1; b < RAY_BAND_COUNT; b++) {
          const distance = Math.hypot(
            RAY_BANDS[a].rgb[0] - RAY_BANDS[b].rgb[0],
            RAY_BANDS[a].rgb[1] - RAY_BANDS[b].rgb[1],
            RAY_BANDS[a].rgb[2] - RAY_BANDS[b].rgb[2]);
          assert.greater(distance, 40,
            `bands ${a} and ${b} are too close to tell apart on screen`);
        }
      }
      for (const path of trace({ count: 400 })) {
        assert.between(path.band, 0, RAY_BAND_COUNT - 1);
      }
    });

    test('the eight colours come out in the ratio the spectrum holds', () => {
      // The claim the picture makes: count the violet rays against the red ones
      // and you have read the spectrum off the screen. That is only true if the
      // band a ray is drawn in was picked in proportion to the light it carries.
      const paths = trace({ count: 30000 });
      const h = histogramPhotons(paths, 0, VIEW_CONE_HALF_DEG * Math.PI / 180);

      const energy = new Float64Array(RAY_BAND_COUNT);
      let total = 0;
      for (let i = 0; i < SPECTRUM_BINS; i++) {
        energy[BAND_OF_BIN[i]] += h.coneSpectrum[i];
        total += h.coneSpectrum[i];
      }
      // Counted over every arriving ray, not only the drawn ones, because this
      // is a statement about the sampling and wants all the samples it has.
      const counts = new Int32Array(RAY_BAND_COUNT);
      let rays = 0;
      for (const p of paths) {
        if (p.kind !== 'arriving') continue;
        counts[p.band]++;
        rays++;
      }
      assert.greater(rays, 5000);
      for (let b = 0; b < RAY_BAND_COUNT; b++) {
        const byCount = counts[b] / rays;
        const byEnergy = energy[b] / total;
        assert.less(Math.abs(byCount - byEnergy), 0.04,
          `band ${b}: ${(byCount * 100).toFixed(1)}% of the rays but `
          + `${(byEnergy * 100).toFixed(1)}% of the light`);
      }
    });

    test('how bright the sky is measured to be follows how much sky is in view', () => {
      // Both ways of losing light have to show up as the same thing - less sky
      // in the field of view - and the brightness has to follow that and not
      // something computed behind it.
      //
      // The subtlety a plane slice hides: a drawn ray is not one direction, it
      // is the ring you get by spinning it about the axis of view, and a ring
      // near the middle stands for almost no sky at all. Counting angles rather
      // than sky made a fifty-metre shaft five times too bright. What the
      // brightness follows is the sky, and for a round shaft that has to come
      // out at the round-shaft geometry.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const at = (options, zenithDeg = 0) => {
        const paths = trace({ count: 20000, ...options });
        const h = histogramPhotons(paths, -zenithDeg * Math.PI / 180, cone);
        return { h, luminance: colorimetry.luminance(h.coneSpectrum) };
      };

      const ground = at({});
      assert.close(ground.h.skyShare, 1, 0.02, 'the open sky fills the view');

      // Two ways to lose light, and they are not the same mechanism. Climbing
      // leaves the whole sky in view and less air to scatter it; a shaft leaves
      // the air alone and takes the sky away. Both end as fewer rays, and each
      // has to track the quantity that actually causes it.
      for (const [label, options] of [
        ['10 km up', { observerZ: 10000 }],
        ['25 km up', { observerZ: 25000 }],
      ]) {
        const here = at(options);
        const brightness = here.luminance / ground.luminance;
        assert.less(brightness, 0.75, `${label} must be visibly darker`);
        assert.close(here.h.skyShare, 1, 0.02, `${label}: the sky is all still there`);
        assert.between(brightness / here.h.drawShare, 0.5, 2,
          `${label}: ${(brightness * 100).toFixed(1)}% as bright from `
          + `${(100 * here.h.drawShare).toFixed(1)}% of the air overhead`);
      }

      for (const [label, options] of [
        ['a 20 m shaft', { observerZ: -20, well: { enabled: true, radius_m: 1.5, depth_m: 20 } }],
        ['a 60 m shaft', { observerZ: -60, well: { enabled: true, radius_m: 1.5, depth_m: 60 } }],
      ]) {
        const here = at(options);
        const brightness = here.luminance / ground.luminance;
        assert.less(brightness, 0.5, `${label} must be visibly darker`);
        assert.close(here.h.drawShare, 1, 0.02, `${label}: the air is all still there`);
        assert.between(brightness / Math.max(1e-9, here.h.skyShare), 0.5, 2,
          `${label}: ${(brightness * 100).toFixed(1)}% as bright from `
          + `${(100 * here.h.skyShare).toFixed(1)}% as much sky`);
      }

      // And down a shaft that share is the round-shaft one, not the flattering
      // ratio of plane angles. At fifty metres those differ by five times.
      for (const [depth, radius] of [[20, 1.5], [50, 1.5], [50, 4]]) {
        const h = at({
          observerZ: -depth, count: 40000,
          well: { enabled: true, radius_m: radius, depth_m: depth },
        }).h;
        const half = wellApertureHalfAngle(depth, radius);
        const round = fieldOfViewSkyShare(half, cone, 0);
        const plane = Math.min(1, half / cone);
        assert.between(h.skyShare / round, 0.6, 1.7,
          `${depth} m, r=${radius}: measured ${(100 * h.skyShare).toFixed(2)}% `
          + `against a round-shaft ${(100 * round).toFixed(2)}%`);
        assert.less(h.skyShare, plane * 0.75,
          'and it must be far below the ratio of plane angles');
      }
    });

    test('a shaft takes the light away without changing its colour', () => {
      // What a well does is subtract directions. The patch of sky left at the
      // top is exactly as blue as it ever was, which is the paradox; what
      // collapses is how much of your view has any sky in it. So the hue must
      // hold while the brightness falls.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const xy = (spectrum) => {
        const v = colorimetry.spectrumToXYZ(spectrum);
        const sum = v[0] + v[1] + v[2];
        return [v[0] / sum, v[1] / sum];
      };
      const open = histogramPhotons(trace({ count: 8000 }), 0, cone);
      const deep = histogramPhotons(trace({
        count: 8000, observerZ: -25,
        well: { enabled: true, radius_m: 2, depth_m: 25 },
      }), 0, cone);

      assert.greater(deep.coneRays, 0, 'some light still comes down the shaft');
      assert.less(colorimetry.luminance(deep.coneSpectrum),
        colorimetry.luminance(open.coneSpectrum) * 0.6);
      const [ax, ay] = xy(open.coneSpectrum);
      const [bx, by] = xy(deep.coneSpectrum);
      assert.less(Math.hypot(ax - bx, ay - by), 0.03,
        'the sky down a shaft is the same colour, only less of it');
    });

    test('looking away from the mouth of a deep shaft measures exactly nothing', () => {
      // Not "nearly nothing". Every direction ends in rock, so the sum of what
      // arrives has no terms in it, and the swatch has to be black rather than
      // a dark blue borrowed from a patch of sky nobody can see.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const paths = trace({
        count: 4000, observerZ: -50,
        well: { enabled: true, radius_m: 1.5, depth_m: 50 },
      });
      const away = histogramPhotons(paths, -35 * Math.PI / 180, cone);
      assert.equal(away.coneRays, 0);
      assert.greater(away.coneCast, 10, 'directions were looked in');
      assert.greater(away.blockedRays, 10, 'and the wall stopped them');
      for (let i = 0; i < SPECTRUM_BINS; i++) assert.equal(away.coneSpectrum[i], 0);
    });

    test('the measured sky divides by the sky looked at, not the rays that paid', () => {
      // Two bugs pinned at once, both of which made a well too bright.
      //
      // Averaging over the ARRIVALS reports the radiance of whatever patch of
      // sky is still visible, which down a fifty-metre shaft is as blue as open
      // ground. And averaging over the drawn ANGLES treats a ray in the middle
      // of your view as worth the same as one at the edge, when the first
      // stands for a sliver of sky and the second for a broad ring of it.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const paths = trace({
        count: 20000, observerZ: -40,
        well: { enabled: true, radius_m: 1.5, depth_m: 40 },
      });
      const h = histogramPhotons(paths, 0, cone);
      assert.greater(h.coneCast, h.coneRays * 2, 'most directions end in rock');

      let weighted = 0, flat = 0;
      for (const p of paths) {
        if (p.kind !== 'arriving') continue;
        if (Math.abs(p.arrivalAngleRad) > cone) continue;
        weighted += p.radiance * Math.sin(Math.abs(p.arrivalAngleRad));
        flat += p.radiance;
      }
      let castSky = 0;
      for (const a of paths.castAngles) {
        if (Math.abs(a) <= cone) castSky += Math.sin(Math.abs(a));
      }

      let measured = 0;
      for (let i = 0; i < SPECTRUM_BINS; i++) measured += h.coneSpectrum[i];
      assert.close(measured, weighted / castSky, 0.02,
        'the divisor is the sky the field of view covers');

      // And the old flat average really was several times brighter, which is
      // the whole reason this changed.
      assert.greater(flat / h.coneCast, (weighted / castSky) * 2,
        'counting angles instead of sky flatters a shaft badly');
    });

    test('how many rays are drawn is the air left overhead, and thins smoothly', () => {
      // A held maximum used to decide this, which made the picture depend on
      // where the observer had been. It is now read off the atmosphere: the
      // share of the column still above you, which in an optically thin sky is
      // the share of the brightness too.
      const surface = trace({ count: 600 });
      assert.close(drawnRayShare(surface), 1, 1e-9);

      const shares = [];
      for (const z of [0, 5000, 10000, 20000, 30000]) {
        shares.push(drawnRayShare(trace({ count: 600, observerZ: z })));
      }
      assert.decreasing(shares);
      // Roughly exp(-z/H): four scale heights up, under two percent is left.
      assert.less(shares[4], 0.03);

      // Climbing must thin the fan, never reshuffle it: the rays drawn higher
      // up are a subset of the ones drawn lower down, so they fade out one at a
      // time instead of flickering.
      const low = [], high = [];
      for (let i = 0; i < 400; i++) {
        if (isRayDrawn(i, shares[2])) low.push(i);
        if (isRayDrawn(i, shares[3])) high.push(i);
      }
      assert.greater(low.length, high.length);
      for (const index of high) {
        assert.ok(low.includes(index), `ray ${index} appeared on the way up`);
      }
    });

    test('the star the trace delivers is the one the integrator computes', () => {
      // The colour panel shows a star without leaving the simulation, so the
      // beam has to be marched by the tracer - through the same air, stopped by
      // the same rock. This is the check that doing it twice gives one answer.
      for (const [elevation, z, well] of [
        [55, 0, null], [4, 0, null], [55, 20000, null],
        [-6, 0, null],
        [55, -20, { enabled: true, radius_m: 1.5, depth_m: 20 }],
      ]) {
        const traced = trace({ count: 400, sunElevationDeg: elevation, observerZ: z, well })
          .observerBeam;
        const scene = sceneAt({ elevation, z, well });
        const analytic = computeDirectBeam(scene, QUALITY_PRESETS.high);
        const where = `elevation ${elevation}, z ${z}${well ? ', in a shaft' : ''}`;
        assert.equal(traced.visible, analytic.visible, `${where}: visibility`);
        if (!traced.visible) continue;
        for (const nm of [450, 550, 650]) {
          const i = Math.round((nm - 380) / 10);
          assert.close(traced.spectrum[i], analytic.spectrum[i], 0.02,
            `${where}: ${nm} nm`);
        }
      }
    });

    test('light arrives unturned when you look at the star', () => {
      // The complaint this answers: point the view at the Sun and every ray in
      // the cone had scattered somewhere, as though nothing ever arrives in a
      // straight line. Almost everything reaching an observer looking at the
      // Sun has never been scattered at all.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const paths = trace({ sunElevationDeg: 55 });
      const straight = paths.filter(
        (p) => p.scatterCount === 0 && p.outcome === 'observed');
      assert.greater(straight.length, 0, 'the beam has to be drawn');
      for (const p of straight) {
        assert.equal(p.kind, 'direct');
        assert.equal(p.points.length, 2, 'it is a straight line, not a kink');
      }

      // It lies along the star's direction, and the histogram knows whether
      // that direction is the one being looked at.
      const starZenith = (90 - 55) * Math.PI / 180;
      assert.close(paths.starAngleRad, starZenith, 1e-9);
      assert.ok(histogramPhotons(paths, starZenith, cone).starInCone);
      assert.ok(!histogramPhotons(paths, -starZenith, cone).starInCone);
      assert.ok(!histogramPhotons(paths, starZenith + 2 * cone, cone).starInCone);
    });

    test('the beam is not drawn when nothing can deliver it', () => {
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const gone = (options) => trace({ count: 400, ...options })
        .filter((p) => p.kind === 'direct').length;
      assert.equal(gone({ sunElevationDeg: -6 }), 0, 'the star has set');
      assert.equal(gone({
        sunElevationDeg: 55, observerZ: -20,
        well: { enabled: true, radius_m: 1.5, depth_m: 20 },
      }), 0, 'the shaft wall is in the way');

      const walled = trace({
        count: 400, sunElevationDeg: 55, observerZ: -20,
        well: { enabled: true, radius_m: 1.5, depth_m: 20 },
      });
      assert.ok(!histogramPhotons(walled, 0, cone).starInCone);
    });

    test('the star disc is far brighter than the sky, and the panel says so', () => {
      // The one place in the picture where the number of drawn lines is not the
      // amount of light, because it cannot be. The bundle is five lines and the
      // truth is five orders of magnitude, so the truth has to be a number.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const starZenith = (90 - 55) * Math.PI / 180;
      const h = histogramPhotons(
        trace({ sunElevationDeg: 55, count: 6000 }), starZenith, cone);
      const ratio = colorimetry.luminance(h.beam.radiance)
        / colorimetry.luminance(h.coneSpectrum);
      // The Sun's disc against a clear daytime sky is a few times 10^5.
      assert.between(ratio, 3e4, 3e6, `disc/sky = ${ratio.toExponential(2)}`);
      assert.close(h.beam.starSolidAngle,
        2 * Math.PI * (1 - Math.cos(0.2665 * Math.PI / 180)), 1e-9);
    });

    test('tuning what gets drawn does not move what gets measured', () => {
      // The knobs in the advanced panel are a drawing budget, and the whole
      // reason they are safe to expose is this: the measurement divides the
      // light it collects by the number of directions it looked in, so tracing
      // half as many arriving rays halves both and leaves the answer alone.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const xy = (spectrum) => {
        const v = colorimetry.spectrumToXYZ(spectrum);
        const sum = v[0] + v[1] + v[2];
        return [v[0] / sum, v[1] / sum];
      };
      const measure = (mix) => {
        const paths = trace({ count: 20000, mix });
        const h = histogramPhotons(paths, -35 * Math.PI / 180, cone);
        return { h, xy: xy(h.coneSpectrum), y: colorimetry.luminance(h.coneSpectrum) };
      };

      const base = measure(null);
      for (const mix of [
        { scatterShare: 0.4, arrivingShare: 0.5 },
        { scatterShare: 0.95, arrivingShare: 0.9 },
        { scatterShare: 0.2, arrivingShare: 0.8 },
      ]) {
        const other = measure(mix);
        const label = `scatter ${mix.scatterShare}, arriving ${mix.arrivingShare}`;
        assert.less(Math.hypot(other.xy[0] - base.xy[0], other.xy[1] - base.xy[1]),
          0.006, `${label}: the colour moved`);
        assert.between(other.y / base.y, 0.9, 1.1, `${label}: the brightness moved`);
      }
    });

    test('the true proportions are the ones the physics gives', () => {
      // What the switch is for: the drawn budget is frankly unfaithful, and
      // this is the tool admitting it. Only about a sixth of the light crossing
      // Earth's air is scattered at all.
      const paths = trace({ count: 6000, mix: { physical: true } });
      const scattered = paths.filter((p) => p.scatterCount > 0).length;
      const share = scattered / 6000;
      assert.close(share, paths.scatteredFraction, 0.05,
        `drew ${(share * 100).toFixed(1)} % scattered against a true `
        + `${(paths.scatteredFraction * 100).toFixed(1)} %`);
      assert.less(share, 0.25, 'and it is a small fraction');

      // The default is the legible one, and is nothing like it.
      assert.close(trace({ count: 6000 }).scatterShare, 0.88, 1e-9);
    });

    test('the strip under the picture is measured, and keeps the aperture narrow', () => {
      // The strip used to be filled from the integrator while the swatch beside
      // it was measured from the rays, so the two could disagree about the same
      // sky. It is the same measurement now, run once per direction.
      //
      // The thing it must not do is widen a shaft's aperture. Brightness is
      // smoothed over a window, because a few rays per degree is noisy; whether
      // the rock is in the way is taken from the direction's own bin and never
      // smoothed, or a two-degree hole would be drawn eight degrees wide.
      const depth = 20, radius = 1.5;
      const paths = trace({
        count: 20000, observerZ: -depth,
        well: { enabled: true, radius_m: radius, depth_m: depth },
      });
      const sky = skyFromRays(paths);
      const apertureDeg = wellApertureHalfAngle(depth, radius) * 180 / Math.PI;
      assert.between(apertureDeg, 4, 4.6);

      const blockedAt = (deg) => sky.blockedFraction[sky.binOfAngle(deg)];
      assert.less(blockedAt(0), 0.1, 'straight up is open');
      assert.less(blockedAt(apertureDeg - 1.5), 0.5, 'just inside the mouth is open');
      assert.greater(blockedAt(apertureDeg + 1.5), 0.5, 'just outside it is rock');
      assert.greater(blockedAt(45), 0.9, 'and well outside it, all rock');

      // Nothing is traced past 85 degrees. Those directions have to inherit the
      // rock as well as the brightness, or a well grows a bright horizon.
      assert.greater(blockedAt(88), 0.9, 'the wall reaches the horizon too');
      assert.greater(blockedAt(-88), 0.9);

      // And the patch of sky that does show through is as bright as open sky:
      // that is the paradox the well experiment exists to show.
      const open = skyFromRays(trace({ count: 20000 }));
      const a = colorimetry.luminance(sky.spectrumAt(sky.binOfAngle(0)));
      const b = colorimetry.luminance(open.spectrumAt(open.binOfAngle(0)));
      assert.between(a / b, 0.75, 1.25,
        `the sky through the mouth is ${(a / b).toFixed(2)} of the open sky`);
    });

    test('the strip agrees with the swatch about the direction being looked at', () => {
      // One measurement, two places it is shown. If these ever part company,
      // one of them is decoration again.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const paths = trace({ count: 20000, sunElevationDeg: 55 });
      const sky = skyFromRays(paths, { smoothDeg: VIEW_CONE_HALF_DEG });
      for (const zenith of [0, 35, 60]) {
        const strip = sky.spectrumAt(sky.binOfAngle(-zenith));
        const swatch = histogramPhotons(paths, -zenith * Math.PI / 180, cone).coneSpectrum;
        const ratio = colorimetry.luminance(strip) / colorimetry.luminance(swatch);
        // Not identical: the swatch weighs each ray by the ring of sky it
        // stands for and the strip does not, because one is a field of view and
        // the other is a direction. They must still be the same sky.
        assert.between(ratio, 0.6, 1.6, `at ${zenith} deg the two differ by ${ratio.toFixed(2)}`);
      }
    });

    test('the rock in a shaft has a colour, and it is not black', () => {
      // "Do not use black for places I cannot see" - black reads as an absence,
      // and what is there is rock. It is the ground's own reflectance under the
      // sky it can see, plus whatever the star still reaches it with.
      const wallAt = (depth, elevation, radius = 1.5) => {
        const paths = trace({
          count: 4000, sunElevationDeg: elevation, observerZ: -depth,
          well: { enabled: true, radius_m: radius, depth_m: depth },
        });
        return shaftWallSpectrum(paths, earth.groundReflectance, {
          depth_m: depth, radius_m: radius,
          sunZenithRad: (90 - elevation) * Math.PI / 180,
        });
      };
      const xy = (spectrum) => {
        const v = colorimetry.spectrumToXYZ(spectrum);
        const sum = v[0] + v[1] + v[2];
        return [v[0] / sum, v[1] / sum];
      };

      // Deeper is darker, always, and never negative or empty.
      const depths = [5, 20, 80, 200].map((d) => wallAt(d, 55));
      for (const w of depths) {
        for (let i = 0; i < SPECTRUM_BINS; i++) assert.ok(w[i] >= 0);
      }
      assert.decreasing(depths.map((w) => colorimetry.luminance(w)));
      assert.greater(colorimetry.luminance(depths[3]), 0,
        'two hundred metres down there is still rock, not a hole in the picture');

      // Warm, because rock is: redder than the blue sky lighting it.
      const [wx, wy] = xy(depths[1]);
      const skyPaths = trace({ count: 4000 });
      const [sx] = xy(histogramPhotons(skyPaths, 0,
        VIEW_CONE_HALF_DEG * Math.PI / 180).coneSpectrum);
      assert.greater(wx, sx + 0.05, `wall x=${wx.toFixed(3)} against sky x=${sx.toFixed(3)}`);
      assert.between(wy, 0.28, 0.42);

      // A low star reaches less of the way down, so the same shaft goes darker.
      assert.less(colorimetry.luminance(wallAt(20, 8)),
        colorimetry.luminance(wallAt(20, 70)) * 0.6);
      // And at night only the sky is left to light it.
      assert.less(colorimetry.luminance(wallAt(20, -8)),
        colorimetry.luminance(wallAt(20, 55)) * 0.05);
    });

    test('the traced paths do not depend on where the observer is looking', () => {
      // The whole point of tracing independently of the view: turning the head
      // must restyle the existing rays, never reshuffle the scene. If this ever
      // fails, the picture will jump every time the view slider moves.
      const a = trace();
      const b = trace();
      assert.equal(a.length, b.length);
      for (let i = 0; i < a.length; i++) {
        assert.equal(a[i].lambda, b[i].lambda);
        assert.equal(a[i].points[1].x, b[i].points[1].x);
      }
    });

    test('arriving rays cover the whole sky, so any viewing cone has rays in it', () => {
      const arriving = earthPaths.filter((p) => p.kind === 'arriving');
      const angles = arriving.map((p) => p.arrivalAngleRad * 180 / Math.PI);
      assert.less(Math.min(...angles), -70, 'rays from one horizon');
      assert.greater(Math.max(...angles), 70, 'and from the other');
      // Every 24-degree cone the interface can point at must contain a usable
      // bundle, or the emphasised direction would be drawn by a handful of rays.
      for (let axis = -80; axis <= 80; axis += 10) {
        const inCone = angles.filter(
          (a) => Math.abs(a - axis) <= VIEW_CONE_HALF_DEG).length;
        assert.greater(inCone, 25, `cone at ${axis} degrees`);
      }
    });

    test('the arrival angle really is the direction the ray comes from', () => {
      // The renderer selects rays by this angle alone, so it must agree with
      // the geometry of the drawn polyline.
      for (const path of earthPaths.filter((p) => p.kind === 'arriving')) {
        // A ray whose vertex is off the frame is drawn as two points rather
        // than three, so take the last leg either way.
        const end = path.points[path.points.length - 1];
        const vertex = path.points[path.points.length - 2];
        const measured = Math.atan2(vertex.x - end.x, vertex.y - end.y);
        assert.close(measured, path.arrivalAngleRad, 1e-9);
      }
    });

    test('every drawn point lies inside the frame it was traced for', () => {
      const R = earth.planetRadius;
      for (const path of earthPaths) {
        for (const point of path.points) {
          assert.finite(point.x);
          assert.finite(point.y);
          assert.between(point.x, -HALF - 1, HALF + 1);
          // Vertically: from the bottom of the frame to the top of the sky.
          assert.between(point.y - R, SKY - SPAN - 1, SKY + 1);
        }
      }
    });

    test('no drawn point is inside the planet', () => {
      // Light does not travel through rock. At a wide zoom the ground curves
      // away and a large part of the frame is below the surface, which used to
      // collect the stubs of everything scattered downwards near the limb.
      const R = earth.planetRadius;
      for (const wide of [trace(), trace({ span_m: 2e6, skyExtent_m: 8.4e5, halfWidth_m: 1.7e6 })]) {
        for (const path of wide) {
          for (const point of path.points) {
            const altitude = Math.hypot(point.x, point.y) - R;
            assert.greater(altitude, -0.6, `${path.kind} reached ${altitude.toFixed(1)} m`);
          }
        }
      }
    });

    test('a scattering event on the ground sends nothing downwards', () => {
      // The degenerate case: both roots of the surface intersection are zero,
      // so the usual near-root test misses it and the stub is drawn into the
      // ground at full length.
      const R = earth.planetRadius;
      const low = trace({ count: 8000 })
        .filter((p) => p.kind === 'missed' && Math.hypot(p.points[1].x, p.points[1].y) - R < 30);
      assert.greater(low.length, 5, 'some events happen right at the surface');
      for (const path of low) {
        const end = path.points[2];
        assert.greater(Math.hypot(end.x, end.y) - R, -0.6);
      }
    });

    test('the geometry is spherical, so altitude follows the radius', () => {
      // Every scattering vertex should sit at a sensible altitude measured from
      // the planet centre, not from a flat datum. The two differ by kilometres
      // once a path runs a few hundred kilometres sideways.
      const R = earth.planetRadius;
      for (const path of earthPaths) {
        const vertex = path.events.find((e) => e.type === 'scatter');
        if (!vertex) continue;
        const radial = Math.hypot(vertex.x, vertex.y) - R;
        assert.close(radial, vertex.altitude, 1e-6);
      }
    });

    test('a low star makes the unscattered beams cross a far longer chord', () => {
      const chord = (elevation) => {
        const set = trace({ sunElevationDeg: elevation })
          .filter((p) => p.kind === 'through');
        return set.reduce((a, p) => a + p.pathLength, 0) / set.length;
      };
      const high = chord(80);
      const low = chord(2);
      // This is the whole reason a low Sun is red, and the reason the picture
      // can be zoomed out: at two degrees the path is hundreds of kilometres.
      assert.greater(low, high * 8);
      assert.greater(low, 300000);
    });

    test('the beams a low star sends through are visibly redder', () => {
      const meanNm = (elevation) => {
        const set = trace({ sunElevationDeg: elevation })
          .filter((p) => p.kind === 'through');
        return set.reduce((a, p) => a + p.lambda, 0) / set.length;
      };
      assert.greater(meanNm(2), meanNm(80) + 30);
    });

    test('the measured sky is a cone average, and matches one', () => {
      // Why the measurement sits a couple of percent above the integrator, and
      // why that is not an error. The panel's number is the mean radiance over
      // the observer's whole field of view; computeViewRadiance answers for one
      // exact direction. Looking at the zenith, every direction in the cone is
      // brighter than the axis, so the average must come out higher - by 6 % at
      // the zenith and 2 % at 35 degrees. Averaged over the same fan the two
      // agree to about a percent, which is what pins the meaning of the number.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const scene = sceneAt({ elevation: 55 });
      const zenithDeg = 35;

      const point = computeViewRadiance(scene,
        directionFromAngles(zenithDeg * Math.PI / 180, Math.PI),
        QUALITY_PRESETS.normal).scattered;

      const samples = 25;
      const fan = new Float64Array(SPECTRUM_BINS);
      for (let i = 0; i < samples; i++) {
        const signed = -zenithDeg
          + (-VIEW_CONE_HALF_DEG + (2 * VIEW_CONE_HALF_DEG * (i + 0.5)) / samples);
        const r = computeViewRadiance(scene,
          directionFromAngles(Math.abs(signed) * Math.PI / 180, signed <= 0 ? Math.PI : 0),
          QUALITY_PRESETS.normal);
        for (let k = 0; k < SPECTRUM_BINS; k++) fan[k] += r.scattered[k] / samples;
      }

      const measured = histogramPhotons(
        trace({ sunElevationDeg: 55, count: 20000 }),
        -zenithDeg * Math.PI / 180, cone).coneSpectrum;

      const vsFan = colorimetry.luminance(measured) / colorimetry.luminance(fan);
      const vsPoint = colorimetry.luminance(measured) / colorimetry.luminance(point);
      assert.between(vsFan, 0.95, 1.05,
        `against the same fan the measurement is off by ${((vsFan - 1) * 100).toFixed(1)}%`);
      assert.greater(vsPoint, vsFan,
        'and the cone average has to exceed the value on its axis here');
    });

    test('the traced rays reproduce the sky colour the integrator computes', () => {
      // The point of the estimator: the drawn bundle is a measurement of the
      // same integral the engine solves, not a decoration beside it. This runs
      // through histogramPhotons, which is the path the interface uses, so what
      // is checked is what a student is shown.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      for (const [elevation, zenith, z] of [[55, 35, 0], [55, 35, 20000], [4, 35, 0]]) {
        const paths = trace({ sunElevationDeg: elevation, observerZ: z, count: 4000 });
        const measured = histogramPhotons(paths, -zenith * Math.PI / 180, cone).coneSpectrum;

        const scene = sceneAt({ elevation, z });
        const analytic = computeViewRadiance(
          scene, directionFromAngles(zenith * Math.PI / 180, Math.PI),
          QUALITY_PRESETS.high).scattered;

        const xy = (spectrum) => {
          const v = colorimetry.spectrumToXYZ(spectrum);
          const sum = v[0] + v[1] + v[2];
          return [v[0] / sum, v[1] / sum];
        };
        const [ax, ay] = xy(measured);
        const [bx, by] = xy(analytic);
        const dxy = Math.hypot(ax - bx, ay - by);
        const where = `elevation ${elevation}, zenith ${zenith}, z ${z}`;
        // A tenth of the distance across the sRGB gamut would be a visible
        // difference; this has to be far tighter than that, or the two swatches
        // the interface shows side by side would not agree.
        assert.less(dxy, 0.01, `${where}: chromaticity off by ${dxy.toFixed(4)}`);

        const ratio = colorimetry.luminance(measured) / colorimetry.luminance(analytic);
        assert.between(ratio, 0.9, 1.15, `${where}: luminance ratio ${ratio.toFixed(3)}`);
      }
    });

    test('the arriving rays fade as the observer climbs out of the air', () => {
      const skyEnergy = (z) => {
        const paths = trace({ observerZ: z, count: 6000 });
        return paths.filter((p) => p.kind === 'arriving')
          .reduce((a, p) => a + p.radiance, 0)
          / paths.filter((p) => p.kind === 'arriving').length;
      };
      const ground = skyEnergy(0);
      const high = skyEnergy(40000);
      // Four and a half scale heights up, essentially all the air is below you.
      assert.less(high, ground * 0.06, `${high.toExponential(2)} vs ${ground.toExponential(2)}`);
    });

    test('the histogram measures energy, so it falls when the sky darkens', () => {
      // The bug this replaced: a fixed number of rays is drawn whatever the
      // state, so a histogram of counts could not fall when the sky went black.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const ground = histogramPhotons(trace(), 0, cone);
      const high = histogramPhotons(trace({ observerZ: 40000 }), 0, cone);
      assert.greater(ground.peak, 0);
      assert.less(high.peak, ground.peak * 0.06,
        `${high.peak.toExponential(2)} at 40 km vs ${ground.peak.toExponential(2)} at the ground`);
    });

    test('the histogram bins every arriving ray into one of its two series', () => {
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const h = histogramPhotons(earthPaths, 0, cone);
      const arriving = earthPaths.filter((p) => p.kind === 'arriving');
      const counted = arriving.filter(
        (p) => Math.abs(p.arrivalAngleRad - 0) <= cone).length;
      assert.equal(h.coneRays, counted);
      assert.equal(h.directRays, earthPaths.filter((p) => p.kind === 'through').length);
      assert.between(h.coneMeanNm, SPECTRUM_MIN_NM, SPECTRUM_MAX_NM);
    });

    test('the direct beam in the histogram moves red as the star sinks', () => {
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const mean = (elevation) => histogramPhotons(
        trace({ sunElevationDeg: elevation }), 0, cone).directMeanNm;
      assert.greater(mean(3), mean(75) + 25);
    });

    test('the measured cone spectrum is the one the swatch is drawn from', () => {
      // coneSpectrum is what the interface turns into a colour, so it has to be
      // the same data the bars are, on the engine's own grid.
      const cone = VIEW_CONE_HALF_DEG * Math.PI / 180;
      const h = histogramPhotons(earthPaths, 0, cone, 20);
      let fromBins = 0, fromSpectrum = 0;
      for (let b = 0; b < h.centres.length; b++) fromBins += h.inCone[b];
      for (let i = 0; i < SPECTRUM_BINS; i++) fromSpectrum += h.coneSpectrum[i];
      assert.close(fromBins, fromSpectrum, 1e-9);
    });

    test('the shaft wall stops the rays the aperture excludes', () => {
      // The shaft is not a separate picture with a predicted answer painted on
      // it: it is the same trace, with the rock allowed to get in the way
      // first. So the counts have to follow arctan(R/depth) and nothing else.
      const shaft = (depth, radius, count = 4000) => {
        const paths = trace({
          observerZ: -depth, count,
          well: { enabled: true, depth_m: depth, radius_m: radius },
          span_m: depth * 2.4, skyExtent_m: depth * 1.2, halfWidth_m: depth * 2,
        });
        const arriving = paths.filter((p) => p.kind === 'arriving').length;
        const blocked = paths.filter((p) => p.kind === 'blocked').length;
        return { arriving, blocked, fraction: arriving / (arriving + blocked) };
      };

      for (const [depth, radius] of [[20, 2], [20, 8], [50, 1.5]]) {
        const got = shaft(depth, radius);
        // Directions are sampled uniformly in angle over +/- MAX_SKY_ANGLE_DEG,
        // so the surviving share is the aperture's share of that span.
        const share = (Math.atan(radius / depth) * 180 / Math.PI) / 85;
        const total = got.arriving + got.blocked;
        const expected = share * total;
        // Counting a random subset, so the test is a three-sigma band rather
        // than a percentage: a narrow aperture lets so few rays through that
        // ordinary sampling noise is a large fraction of them.
        const sigma = Math.sqrt(expected * (1 - share));
        assert.less(Math.abs(got.arriving - expected), 3 * sigma + 1,
          `depth ${depth}, R ${radius}: ${got.arriving} through, expected `
          + `${expected.toFixed(1)} +/- ${sigma.toFixed(1)}`);
      }
    });

    test('a blocked ray stops on the wall and delivers nothing', () => {
      const depth = 20, radius = 2;
      const paths = trace({
        observerZ: -depth, count: 2000,
        well: { enabled: true, depth_m: depth, radius_m: radius },
        span_m: 48, skyExtent_m: 24, halfWidth_m: 40,
      });
      const blocked = paths.filter((p) => p.kind === 'blocked');
      assert.greater(blocked.length, 100);
      for (const path of blocked) {
        assert.equal(path.radiance, 0, 'a stopped ray carries no light');
        // It ends where the wall is, and never gets past the mouth.
        const wall = path.points[0];
        assert.close(Math.abs(wall.x), radius, 1e-6);
        const heightAboveEye = Math.hypot(wall.x, wall.y) - earth.planetRadius + depth;
        assert.between(heightAboveEye, 0, depth + 1e-6);
      }
    });

    test('widening the shaft lets more of the sky back in', () => {
      const through = (radius) => trace({
        observerZ: -20, count: 3000,
        well: { enabled: true, depth_m: 20, radius_m: radius },
        span_m: 48, skyExtent_m: 24, halfWidth_m: 40,
      }).filter((p) => p.kind === 'arriving').length;
      assert.greater(through(8), through(2) * 3);
      assert.greater(through(2), 0);
    });

    test('a vacuum produces no scattering events at all', () => {
      // What an airless world looks like: the star, and nothing else. Light
      // streams past, the beam arrives unchanged, and not one photon is turned
      // towards the observer anywhere - so there is no sky.
      const moon = createAtmosphere(config.atmospheres['airless-moon']);
      const paths = trace({ atmosphere: moon, count: 400 });
      assert.greater(paths.length, 0);
      for (const path of paths) {
        assert.equal(path.scatterCount, 0);
        assert.ok(path.kind === 'through' || path.kind === 'direct',
          `nothing but light streaming past, and the beam itself; got ${path.kind}`);
      }
      assert.greater(paths.filter((p) => p.kind === 'direct').length, 0,
        'the star is still there to be looked at');
      assert.greater(paths.observerBeam.pathLength, 0);
    });

    test('the reported scattered fraction follows the optical depth', () => {
      // Earth's vertical scattering optical depth is about 0.115, so about a
      // ninth of the light crossing the air is scattered at all.
      assert.between(earthTally.scatteredFraction, 0.05, 0.2);
    });

    test('every drawn path is a well-formed polyline', () => {
      const paths = trace({ sunElevationDeg: 25, count: 300, seed: 5 });
      assert.greater(paths.length, 250);
      for (const path of paths) {
        assert.greater(path.points.length, 1);
        assert.between(path.lambda, SPECTRUM_MIN_NM, SPECTRUM_MAX_NM);
        for (const point of path.points) {
          assert.finite(point.x);
          assert.finite(point.y);
        }
      }
    });
  });

  /* ---------------------------------------------------------------- */

  group('observer position control', () => {
    test('the slider mapping round-trips across its whole range', () => {
      const maxAltitude = 100000, maxDepth = 10000;
      for (const z of [0, 1, 50, 1000, 25000, 100000, -1, -50, -2000, -10000]) {
        const slider = zToSlider(z, maxAltitude, maxDepth);
        const back = sliderToZ(slider, maxAltitude, maxDepth);
        const scale = Math.max(Math.abs(z), 1);
        assert.less(Math.abs(back - z) / scale, 0.02, `z = ${z} should survive the round trip`);
      }
    });

    test('the shaft confines the observer between its bottom and its mouth', () => {
      // The cross-section shows the shaft the whole time the shaft is switched
      // on, so the position control must not be able to leave it - otherwise
      // the picture and the state disagree about where the observer is.
      const store = createStore({
        ...DEFAULT_STATE,
        observer: {
          ...DEFAULT_STATE.observer,
          well: { enabled: true, radius_m: 1.5, depth_m: 50 },
        },
      });
      store.setContext({ maxAltitude: 100000 });

      store.patch({ observer: { z: 5000 } });
      assert.equal(store.state.observer.z, 0, 'cannot climb out of the shaft');
      store.patch({ observer: { z: -500 } });
      assert.equal(store.state.observer.z, -50, 'cannot sink through the bottom');
      store.patch({ observer: { z: -12 } });
      assert.equal(store.state.observer.z, -12, 'anywhere in between is fine');

      // And switching the shaft off releases the ceiling again.
      store.patch({ observer: { well: { enabled: false } } });
      store.patch({ observer: { z: 5000 } });
      assert.equal(store.state.observer.z, 5000);
    });

    test('how bright a shaft looks follows how much sky is left in view', () => {
      // The complaint this answers: at the bottom of a deep well the interface
      // still showed a light blue sky, because the radiance of the patch you
      // can still see is unchanged - that is the paradox. What an eye reports
      // is not that radiance but the average over its whole field of view, and
      // that collapses with the fraction of the view which has any sky in it.
      const field = 12 * Math.PI / 180;
      const deg = (d) => d * Math.PI / 180;

      // Looking straight up, an aperture wider than the field of view leaves
      // nothing but sky, and it is as bright as the open sky.
      assert.equal(fieldOfViewSkyShare(deg(37), field, 0), 1);
      assert.equal(fieldOfViewSkyShare(Math.PI / 2, field, deg(35)), 1);

      // A narrow one leaves the ratio of the two solid angles, and nothing
      // may ever exceed one - a wide shallow shaft used to report 166 %.
      const narrow = fieldOfViewSkyShare(deg(1.72), field, 0);
      assert.close(narrow, (1 - Math.cos(deg(1.72))) / (1 - Math.cos(field)), 1e-9);
      assert.less(narrow, 0.03);
      for (const aperture of [0.5, 5, 11, 12, 13, 20, 45, 89]) {
        assert.between(fieldOfViewSkyShare(deg(aperture), field, 0), 0, 1);
      }

      // Look away from the shaft and there is no sky in view at all.
      assert.equal(fieldOfViewSkyShare(deg(1.72), field, deg(35)), 0);

      // Deeper is always darker, never brighter.
      let previous = 1;
      for (const depth of [1, 2, 5, 10, 20, 50, 200]) {
        const share = fieldOfViewSkyShare(
          wellApertureHalfAngle(depth, 1.5), field, 0);
        assert.less(share, previous + 1e-12, `depth ${depth} must not brighten`);
        previous = share;
      }

      // And once the aperture is small it falls as its square, because that is
      // how solid angle behaves: halving the aperture quarters the light. A
      // hundred-fold shaft is a hundred-thousand-fold darkening.
      for (const depth of [200, 1000]) {
        const half = wellApertureHalfAngle(depth, 1.5);
        const share = fieldOfViewSkyShare(half, field, 0);
        assert.close(share, Math.pow(half / field, 2), 0.01,
          `depth ${depth}: ${share.toExponential(3)}`);
      }
      assert.less(fieldOfViewSkyShare(wellApertureHalfAngle(200, 1.5), field, 0), 2e-3,
        'two hundred metres down is essentially dark');
    });

    test('the zoom reaches far enough in to see a shaft', () => {
      // The limits used to be written down twice - once in the renderer, once
      // in the store's invariant - and they drifted. The renderer was widened
      // to twenty metres while the store went on snapping anything under five
      // kilometres back up, so zooming in on a shaft silently did nothing and
      // the shaft could never be seen. One definition now, and this is it.
      assert.less(MIN_SPAN_M, 50, 'a twenty-metre shaft has to fit in the frame');
      assert.equal(clampSpan(25), 25);
      assert.equal(clampSpan(MIN_SPAN_M / 2), MIN_SPAN_M);
      assert.equal(clampSpan(MAX_SPAN_M * 2), MAX_SPAN_M);

      const store = createStore(DEFAULT_STATE);
      store.patch({ camera: { span_m: 25 } });
      assert.equal(store.state.camera.span_m, 25,
        'the store must not undo a zoom the interface offers');
      store.patch({ camera: { span_m: 1 } });
      assert.equal(store.state.camera.span_m, MIN_SPAN_M);
    });

    test('standing at the mouth of a shaft sees the whole sky', () => {
      // The state the old view could not show at all, because it only drew the
      // shaft once the observer was below the surface. It is the anchor of the
      // experiment: the aperture starts as everything and closes as you go down.
      assert.close(wellApertureHalfAngle(0, 1.5), Math.PI / 2, 1e-12);
      assert.close(wellIlluminanceFraction(0, 1.5), 1, 1e-12);
      assert.equal(wellIsBlocked(80 * Math.PI / 180, 0, 1.5), false);
    });

    test('the mapping keeps metre resolution near the ground', () => {
      const step = sliderToZ(1, 100000, 10000) - sliderToZ(0, 100000, 10000);
      assert.less(step, 1, 'one slider notch near datum must be under a metre');
    });
  });

  /* ---------------------------------------------------------------- */

  group('configuration integrity', () => {
    test('every atmosphere carries the fields the engine relies on', () => {
      for (const [id, cfg] of Object.entries(config.atmospheres)) {
        assert.ok(cfg.planetRadius_m > 0, `${id}: planet radius`);
        assert.ok(cfg.topAltitude_m > 0, `${id}: top altitude`);
        assert.ok(cfg.rayleigh && cfg.rayleigh.scaleHeight_m > 0, `${id}: scale height`);
        assert.ok(cfg.rayleigh.beta550_perM >= 0, `${id}: beta550`);
        assert.ok(cfg.name && cfg.name.cs && cfg.name.en, `${id}: bilingual name`);
        assert.ok(cfg.description && cfg.description.cs && cfg.description.en, `${id}: bilingual description`);
      }
    });

    test('every atmosphere builds and produces finite radiance', () => {
      for (const [id, cfg] of Object.entries(config.atmospheres)) {
        const atmosphere = createAtmosphere(cfg);
        const r = computeViewRadiance(
          sceneAt({ atmosphere, elevation: 50 }), ZENITH, QUALITY_PRESETS.preview);
        for (let i = 0; i < SPECTRUM_BINS; i++) {
          assert.finite(r.scattered[i], `${id}: bin ${i}`);
          assert.greater(r.scattered[i] + 1e-30, 0, `${id}: bin ${i} must not be negative`);
        }
      }
    });

    test('the two localisations expose exactly the same keys', () => {
      const flatten = (object, prefix = '') => Object.entries(object).flatMap(([k, v]) =>
        (v && typeof v === 'object') ? flatten(v, `${prefix}${k}.`) : [`${prefix}${k}`]);
      const cs = flatten(config.localization.cs).sort();
      const en = flatten(config.localization.en).sort();
      assert.equal(cs.length, en.length, `cs has ${cs.length} keys, en has ${en.length}`);
      for (let i = 0; i < cs.length; i++) assert.equal(cs[i], en[i]);
    });

    test('every experiment step is bilingual and patches valid state', () => {
      const valid = new Set(['star', 'atmosphere', 'observer', 'rays', 'compare', 'level']);
      for (const [id, experiment] of Object.entries(config.experiments)) {
        assert.ok(experiment.title.cs && experiment.title.en, `${id}: title`);
        assert.greater(experiment.steps.length, 0, `${id}: has steps`);
        for (const [index, step] of experiment.steps.entries()) {
          assert.ok(step.title.cs && step.title.en, `${id} step ${index}: title`);
          assert.ok(step.text.cs && step.text.en, `${id} step ${index}: text`);
          for (const key of Object.keys(step.state ?? {})) {
            assert.ok(valid.has(key), `${id} step ${index}: unknown state key "${key}"`);
          }
        }
      }
    });

    test('the CIE table lines up with the spectral grid', () => {
      assert.equal(config.color.count, SPECTRUM_BINS);
      assert.equal(config.color.xBar.length, SPECTRUM_BINS);
      assert.equal(config.color.yBar.length, SPECTRUM_BINS);
      assert.equal(config.color.zBar.length, SPECTRUM_BINS);
      assert.equal(config.color.wavelengthStart_nm, SPECTRUM_MIN_NM);
      assert.equal(config.color.wavelengthStep_nm, SPECTRUM_STEP_NM);
    });
  });

  /* ---------------------------------------------------------------- */

  group('performance budget', () => {
    test('a full interactive update stays well inside a 30 fps frame', () => {
      const scene = sceneAt({ elevation: 45 });
      const started = Date.now();
      // What one interaction costs: the sky sweep plus the illumination sum.
      for (let i = 0; i < 73; i++) {
        computeViewRadiance(scene,
          directionFromAngles((i / 72) * Math.PI / 2, 0), QUALITY_PRESETS.preview);
      }
      computeIllumination(scene, colorimetry);
      const elapsed = Date.now() - started;
      assert.less(elapsed, 33, `a full recompute took ${elapsed} ms, the budget is 33 ms`);
    });

    test('tracing the drawn rays stays cheap at the largest ray count', () => {
      // The drawn paths went from a flat slab with a closed-form column to
      // spherical geometry with a marched one, which is the only way to show a
      // grazing chord. That made this loop worth guarding: the sun leg is now
      // cached per cell of (altitude, solar zenith angle), and without that
      // cache five thousand rays cost several times the frame budget.
      const options = {
        atmosphere: earth, source: sunSpectrum, sunElevationDeg: 30, observerZ: 0,
        count: 5000, span_m: 25500, skyExtent_m: 24225, halfWidth_m: 12364, seed: 7,
      };
      tracePhotons(options);
      const started = Date.now();
      tracePhotons(options);
      const elapsed = Date.now() - started;
      assert.less(elapsed, 25, `tracing 5000 rays took ${elapsed} ms`);
    });

    test('the cached sun leg agrees with marching it every time', () => {
      // The cache is only legitimate if it changes nothing you can see. Compare
      // the colours it produces against a trace fine enough that quantisation
      // cannot matter: the two bundles must have the same mean wavelength.
      const base = { atmosphere: earth, source: sunSpectrum, sunElevationDeg: 12,
        observerZ: 0, count: 4000, span_m: 25500, skyExtent_m: 24225,
        halfWidth_m: 12364, seed: 3 };
      const mean = (paths) => {
        const set = paths.filter((p) => p.kind === 'arriving');
        return set.reduce((a, p) => a + p.lambda, 0) / set.length;
      };
      const uncached = mean(tracePhotons({ ...base, sunCacheScale: 1e-4 }));
      const cached = mean(tracePhotons(base));
      // A low star is the hardest case: transmission changes fastest with
      // altitude there, so this is where quantising could show.
      assert.close(cached, uncached, 0.004,
        `cached ${cached.toFixed(2)} nm vs uncached ${uncached.toFixed(2)} nm`);
    });
  });
}

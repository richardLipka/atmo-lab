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
  rayleighBetaSpectrum, aerosolBetaSpectrum, resolveAlbedoSpectrum,
  rayleighPhase, henyeyGreensteinPhase, sampleRayleighCosine,
} from '../js/physics/scattering.js';
import { createAtmosphere } from '../js/physics/atmosphere.js';
import { createColorimetry } from '../js/physics/color.js';
import {
  wellApertureHalfAngle, wellIsBlocked, wellSolidAngle,
  wellIlluminanceFraction, wellShaftColumn,
} from '../js/physics/well.js';
import {
  buildScene, computeViewRadiance, computeDirectBeam, computeIllumination,
  QUALITY_PRESETS,
} from '../js/physics/radiance.js';
import { directionFromAngles, sunDirectionFromElevation, raySphereFar, raySphereNear, v3 } from '../js/physics/geometry.js';
import { sliderToZ, zToSlider } from '../js/state.js';
import {
  tracePhotons, summarisePhotons, histogramPhotons, VIEW_CONE_HALF_DEG,
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

    test('a vacuum produces no scattering events at all', () => {
      const moon = createAtmosphere(config.atmospheres['airless-moon']);
      const paths = trace({ atmosphere: moon, count: 400 });
      assert.greater(paths.length, 0);
      for (const path of paths) {
        assert.equal(path.scatterCount, 0);
        assert.equal(path.kind === 'through', true, 'nothing but light streaming past');
      }
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

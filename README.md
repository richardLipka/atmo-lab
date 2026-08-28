# Atmospheric Light Laboratory

**▶ [Open the laboratory](https://richardlipka.github.io/atmo-lab/)** ·
[run the test suite in your browser](https://richardlipka.github.io/atmo-lab/tests/test-runner.html) ·
[single-file version to download](https://richardlipka.github.io/atmo-lab/dist/atmo-lab.html)

An interactive physics laboratory for secondary-school students (roughly ages 15–19) that
answers four questions with one engine:

- why the daytime sky is blue,
- why a low Sun turns red,
- why the sky fades to black as you climb,
- and why the bottom of a well is dark **for a completely different reason**.

Every colour on screen is the end of a computed pipeline:

```
star temperature → Planck spectrum → scattering + extinction along a real path
                 → spectral irradiance at the eye → CIE 1931 XYZ → sRGB
```

Nothing is a hand-picked tint, a gradient, or a canned animation. Set the wavelength
exponent to 0 and the sky turns grey, because the physics says it must.

**Interface language: Czech by default, English one click away, no page reload.**

---

## Running it

Three ways, in order of convenience.

**1. Double-click, no tooling.** Open `dist/atmo-lab.html`. It is the whole laboratory in
one self-contained file with no network requests of any kind — copy it onto a memory stick
and it works on any modern browser.

**2. With the bundled dev server** (needed if you want to edit the JSON data and see the
change immediately):

```bash
node tools/serve.js
```

Then open <http://localhost:8080/>. Any static server will do; the app itself never makes
a network call.

**3. Tests:**

```bash
node tests/run-tests.js
```

or open `tests/test-runner.html` in the browser to run the identical suite in the engine
that will actually run the simulator.

There are no dependencies. `package.json` declares no packages and none are installed.

---

## Layout

```
index.html                 the lab
css/style.css
js/
  main.js                  bootstrap and frame loop
  state.js                 application state and its invariants
  simulation.js            binds state to physics; the only place the model is assembled
  config-loader.js         reads /config, with an offline fallback
  i18n.js                  live CZ/EN switching
  physics/
    spectrum.js            38-bin spectral grid, Planck's law
    scattering.js          Rayleigh and Henyey-Greenstein cross-sections and phase functions
    atmosphere.js          exponential density, columns, Beer-Lambert optical depth
    geometry.js            vectors and ray/sphere intersection
    well.js                shaft aperture geometry
    radiance.js            the single-scattering integrator
    color.js               CIE 1931 XYZ → sRGB
  render/
    scene-renderer.js      cross-section; switches between atmosphere and shaft views
    sky-strip.js           the observer's own horizon-to-horizon view
    spectrum-chart.js      the four-curve spectrum plot
    chromaticity.js        CIE diagram (Advanced level)
    photons.js             Monte Carlo photon paths, for the picture
  ui/
    controls.js  panels.js  explanation.js  experiments.js
config/
  index.json               manifest: adding a world means adding a file and naming it here
  atmospheres/  stars/  scattering/  experiments/  localization/  color/
  bundle.js                GENERATED — offline copy of the JSON
tests/
  harness.js  physics.test.js  run-tests.js  test-runner.html
tools/
  serve.js  build-bundle.js  build-standalone.js
dist/atmo-lab.html         GENERATED — the single-file build
```

### Adding content without touching code

Drop a file into `config/atmospheres/`, `config/stars/` or `config/experiments/`, list its
id in `config/index.json`, and it appears in the interface. Then rebuild the two generated
artefacts:

```bash
node tools/build-bundle.js && node tools/build-standalone.js
```

All prose in the config files is `{ "cs": …, "en": … }`, and the test suite fails if an
atmosphere, experiment or localisation key is missing one of the two languages.

---

## The physics

### Spectral grid

λ ∈ [380, 750] nm at 10 nm spacing — **38 bins**. Sources, cross-sections, transmittances
and the CIE colour matching functions all share this grid, so no resampling ever happens.

### Source

Planck's law, B(λ,T) = (2hc²/λ⁵)/(exp(hc/λkT) − 1), for T from 2 000 K to 20 000 K.

Each star spectrum is normalised to **unit luminance** so that changing temperature is seen
as a change of *colour*, not of brightness. The optional "realistic distance" switch then
multiplies by each world's true insolation (Earth 1.00, Mars 0.431, Titan 0.011, Venus
1.911), so cross-planet comparisons are honest.

### Atmosphere

ρ(h) = ρ₀ exp(−h/H), which integrates in closed form to C(z) = ρ₀H exp(−z/H) — the entire
"flight into space" experiment in one line.

- Rayleigh: β(λ) = β(550)·(550/λ)ⁿ, n = 4 by default and adjustable from 0 to 6.
  Earth uses β(550) = 1.35 × 10⁻⁵ m⁻¹, H = 8.5 km, which reproduces the published
  sea-level coefficients (3.31 × 10⁻⁵ m⁻¹ at 440 nm, 5.8 × 10⁻⁶ m⁻¹ at 680 nm) and a
  vertical optical depth of 0.115 at 550 nm.
- Aerosol: an Ångström power law with a Henyey-Greenstein lobe (g ≈ 0.7), plus an optional
  wavelength-dependent single-scattering albedo. Martian dust absorbs blue about twice as
  strongly as red, and that — not the CO₂ — is what makes the Martian sky ochre.
- Phase functions: P_R(θ) = (3/16π)(1 + cos²θ) and the Henyey-Greenstein lobe. Both are
  verified by numerical integration to normalise to 1 over the sphere.

### Geometry

The planet is a **sphere**, not a slab. This is not polish: a flat atmosphere has an
infinite path at the horizon and the sunset experiment would never terminate. On the
sphere, the air mass emerges correctly — 1.00 at the zenith, 1.99 at 60°, about 34 at the
horizon (the classic figure is ~38).

### Radiative transfer

Single scattering. For each viewing ray the engine integrates

```
L(λ) = ∫ T_view(λ, 0→s) · [β_R(λ)ρ_R(s)P_R(θ) + β_M(λ)ρ_M(s)P_M(θ)] · T_sun(λ, s→space) · I₀(λ) ds
```

with a shadow ray at every sample, so the planet's own shadow darkens the sky from the
bottom up after sunset without any special-case code.

### Colour

Tristimulus integration against the CIE 1931 2° observer, the standard XYZ→linear-sRGB
matrix, hue-preserving gamut fitting (desaturate if a component goes negative, scale all
three if one exceeds 1), then the sRGB transfer function.

**Exposure is a fixed constant.** An auto-exposure would silently cancel the very effect
the altitude experiment exists to demonstrate, by re-brightening a fading sky. The
"brightness boost" slider is a separate, clearly-labelled display multiplier; because it
scales all wavelengths equally it can change brightness but never hue.

---

## The well, and why it is the point

The specification asks for two mechanisms to be kept strictly apart, and the engine does:

| | rising to +10 km | descending 10 km down a 2 m shaft |
|---|---|---|
| air above the observer | falls to **30.8 %** | stays at **100 %** |
| radiance of the sky overhead | `rgb(84,108,152)` — dimmer | `rgb(154,187,242)` — **byte-identical to ground level** |
| illuminance at the observer | ≈ unchanged | falls by **~9 orders of magnitude** |
| governing relation | C(z) = C(0)e^(−z/H) | tan θ ≤ R/d |

Descending changes no atmospheric quantity whatsoever. It changes how much of the sky can
see you: the visible cone has half-angle arctan(R/d), solid angle 2π(1 − cos θ_max), and
the illuminance follows sin²θ_max. Neither wavelength nor density appears anywhere in
that. The simulator reports both numbers side by side so a student can watch one collapse
while the other does not move at all.

Because a deep shaft's aperture can be a hundredth of a degree wide, two things adapt to it
rather than falling between samples: the hemisphere integral for illuminance, and the sky
strip, whose middle third is magnified onto the aperture and labelled as such.

An **advanced toggle, "count air inside the shaft"**, is off by default so that descending
is purely geometric, as specified. Switching it on adds the denser air that would really
fill a deep shaft (C = H(e^(d/H) − 1)) — and only then does descending finally become an
atmospheric effect too. That contrast is the last step of the well experiment.

---

## What the model does not include

Stated plainly, because a simulation that hides its approximations teaches the wrong
lesson:

- **Single scattering only.** Accurate while τ ≲ 1. It under-predicts deep twilight (real
  twilight is darker and more purple) and the surface brightness of very dense atmospheres
  like Venus, where photons bounce many times before arriving. The explanation panel says
  so on screen whenever the state is one where it matters.
- **No atmospheric refraction**, so no flattened solar disc and no geometric horizon lift.
- **No ozone Chappuis band**, which contributes to the real zenith blue.
- **No ground-reflected light** feeding back into the sky.
- **Mie scattering is approximated**, not solved. Real Mie theory needs Maxwell's equations
  on a sphere; here it is a power law plus an asymmetry parameter, which reproduces the two
  features that matter pedagogically (near-neutral colour, forward peaking).
- The Monte Carlo photon paths are drawn in a **flat slab** — over the width of the picture
  the curvature is invisible and the flat geometry is far easier to read. The numbers and
  colours always come from the spherical integrator, never from the photons.
- The cross-section uses a **compressed vertical axis**, and where a shaft aperture is too
  narrow to draw it is widened and explicitly labelled "cone exaggerated for clarity" with
  the true angle shown next to it.

---

## Tests

`node tests/run-tests.js` runs **71 tests** covering:

- the spectral grid, Planck's law and the Wien peak;
- σ ∝ λ⁻⁴ compliance to machine precision, plus agreement with published sea-level values;
- phase-function normalisation over the sphere, and the sampled cosines matching ⟨μ²⟩ = 2/5;
- Beer-Lambert behaviour: T = exp(−τ), T ∈ [0,1], doubling the column squaring the transmission;
- the closed-form column integral and the mass column against p/g;
- air mass against sec z, and a finite horizon air mass;
- CIE bounds: equal-energy white at x = y = ⅓, non-negative tristimulus values, sRGB output
  always inside the 0–255 cube for exposures spanning twelve orders of magnitude, and
  exposure never altering chromaticity;
- the sky being measurably blue (clear-sky chromaticity), turning grey at n = 0, and never
  manufacturing energy;
- monotonic dimming with altitude, black sky at 100 km, black sky on an airless world;
- sunset reddening: air mass increasing, blue-to-red ratio collapsing, star below the
  horizon delivering nothing;
- well geometry: the exact tan θ > R/d condition, arctan(R/d), 2π(1−cos θ), sin²θ_max;
- **the well paradox itself** — that radiance and colour through the aperture are identical
  at every depth, while illuminance follows the solid angle;
- config integrity, including CZ/EN key parity and bilingual completeness of every
  experiment step;
- a performance budget assertion that a full interactive recompute fits inside 33 ms.

## Performance

Measured in Chrome at 1280×720, median of 14 runs:

| | 600 rays | 2 000 rays | 5 000 rays (the maximum) |
|---|---|---|---|
| moving a slider (full recompute + repaint) | 6.8 ms | 8.0 ms | 12.7 ms (worst 14.6) |
| an animation frame (repaint only) | — | 0.4 ms | 0.9 ms (worst 2.0) |

Both stay inside the 33 ms budget for 30 fps at every ray count the interface offers, and
the test suite asserts the compute half of that budget independently.

Three things buy this. The model is recomputed at most once per frame and only when
something actually changed, so an idle page costs nothing. The expensive step — rebuilding
the atmospheric glow field and the readout DOM — is separated from painting, so it runs on
change rather than once per frame. And photon paths are traced only when a parameter that
affects them moves, then drawn batched by wavelength, so five thousand rays cost a handful
of stroke calls.

## Browser console

`window.atmoLab` exposes `store`, `config`, `simulation`, `colorimetry`, `i18n`,
`renderers`, `result` and `renderNow()` for poking at the model directly — useful in class
for showing that the numbers behind a colour are real.

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
    photons.js             the light paths drawn in the cross-section
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

### What the cross-section draws

The picture is built **backwards from the observer**, because the question a student is
asking is "why is the light that reaches *me* blue?"

The scattering events are traced **independently of where the observer is looking** — they
are a property of the air and the star, not of which way someone happens to face. Turning
the view never reshuffles the scene. What moves is the emphasis: a dashed wedge marks the
**observer's field of view**, a cone of half-angle 12° following both the zenith angle and
the azimuth. What decides whether a ray belongs to that cone is **where its scattering
event happened**, not where the light came from: the light feeding those events arrives
along the line to the star, which at a low Sun is nearly at right angles to where you are
looking. A ray can enter the cone from any direction at all; what makes it yours is that
it turned inside the cone and left along the line to your eye.

Rays that do are drawn **in one of eight colours**; everything else goes **grey**. The rule
is one sentence and it is the whole legend: *coloured means this light enters your eye from
the direction you are facing.* Turning the view is a repaint, 0.8 ms, not a retrace.

| | what it is | how it is drawn |
|---|---|---|
| **in the cone** | turned inside the cone *and* turned into the eye | band colour; heavy final leg into the observer, white vertex where it turned |
| **turned in view, gone elsewhere** | the same turn, made a few degrees the wrong way | brighter grey, ringed vertex, arrowhead — the control group |
| **elsewhere in the sky** | also reaches the eye, from every other direction — this is what lights the ground | grey |
| **missed** | scattered somewhere else and left in another direction | grey kink with an arrowhead, rejection-sampled away from the eye |
| **through** | crossed the whole atmosphere without scattering and hit the ground | grey line, top to bottom |
| **direct** | crossed without scattering and landed on the observer | a bundle of nine parallel lines in band colours, **not to scale** |

**Light also arrives without being turned at all.** Point the view at the star
and, before this existed, every ray in the cone had scattered somewhere — as
though light never arrives in a straight line, when in fact almost everything
reaching an observer looking at the Sun has never been scattered once. The beam
is marched by the tracer along the one chord that matters and drawn as a narrow
bundle into the eye, taking its bands from its own spectrum, so it whitens and
reddens with elevation like everything else: at a 55° Sun the nine lines come
out `045556677`, at 12° `156666777`, at 3° `467777777` — almost all in the
deepest red band.

The bundle is the one place in the picture where **the number of lines is not
the amount of light**, and it cannot be: the Sun's disc runs to about
**2×10⁵ times the radiance of the sky beside it**, so honouring the rule would
take a hundred thousand lines. The ratio is printed in the panel instead, which
is the only place it fits. The outer lines of the bundle stop at the ground
rather than passing through it — that share of the beam lands beside you.

### Eight colours, in the ratio the spectrum holds

A ray's wavelength is sampled on the 10 nm grid, which is right for the physics and wrong
for the picture: thirty-eight shades running smoothly from violet to red read as one
continuous wash, and nobody can count them. So a ray is *drawn* in the colour of the band
its wavelength fell in, and there are eight bands — violet, blue, cyan, green, chartreuse,
yellow, orange, red.

The bands are deliberately **not** of equal width. They are narrow across the blue-green,
where a small change of wavelength is a large change of colour, and wide out past 635 nm
where the eye stops discriminating; equal widths would have spent three of the eight
colours on reds nobody can tell apart. Because the band is picked in proportion to the
ray's own spectrum, **the mix of colours on screen is the spectrum** — counting violet rays
against red ones reads it off the picture, and the test suite pins the two to within four
percentage points per band.

Nothing here enters the physics. Each ray still carries its whole 38-bin spectrum into
every measurement.

**Straight rays stay straight, and the ground curves.** The cross-section is drawn in true
spherical geometry — planet centre at the origin of world coordinates — under a plain
orthographic projection, so a ray that is straight in the world is a straight line on
screen. An early version compressed the altitude axis by a power law to give the dense
lower air more room, which bent every ray: the wrong lesson in a picture about light
travelling in straight lines. Zoomed in, the sagitta of the horizon is a fraction of a
pixel and the picture looks flat by itself.

**And it zooms, from 5 km to 6000 km of frame height** — the control under *Observer*, or
the mouse wheel on the picture. This is not decoration. It is the only way to draw the
reason a low Sun is red: **at 55° above the horizon the unscattered beams cross about
120 km of air; at 3° they cross about 1260 km**, a chord that skims the limb and simply
does not fit in a picture of the local sky. Zoom out at sunset and you can see it — the
planet's arc, the atmosphere as a thin shell, and the beams running the length of it.

The wavelength of each arriving ray is drawn from the true single-scattering weight
β(λ)ρ·P(θ)·T_sun(λ)·T_view(λ)·I₀(λ) — the same product the integrator forms — so the
coloured bundle comes out blue for the reason the physics says, not because it was tinted.
Each arriving ray has exactly one scattering vertex, which is not a shortcut: it is
precisely the single-scattering approximation the engine integrates, so the picture and the
numbers describe the same model.

The panel beside it states the outcome, taken off the rays: at a 55° Sun, looking 35° from
the zenith away from it, most of the light arriving from the viewing cone is blue
(< 520 nm) against a third of the light that crosses unscattered to the ground, from a star
that emitted 39 % blue — and only 16 % of the light crossing the air is scattered at all.
On an airless world every path is a `through` path and no scattering vertex is drawn
anywhere.

### The picture is the measurement, and the theory is one tab behind it

Each arriving ray carries an unbiased Monte Carlo estimate of what it
contributes to the radiance. The scattering altitude is drawn with probability
proportional to the density, so the density in the integrand cancels against the
one in the sampling distribution — importance sampling that is exact for an
exponential atmosphere — and what remains is a factor of 1/cos between the ray
and the local vertical, which is why a ray near the horizon carries so much more.

**The colour the interface calls the sky is now built from the rays and from
nothing else.** The integrator's answer has not gone away — it sits one tab
across, labelled *theory, for comparison*, with the difference between the two
printed. That separation is the point: when the two agree to a thousandth of a
chromaticity, the agreement is *evidence about the model*, which it could not be
if one of them were quietly derived from the other. With 53 rays in the cone they
agree to **Δxy ≤ 0.002** and a luminance ratio of **1.02** at the ground, and the
test suite requires better than 0.01 and 10 % through the same code path the
interface uses.

The star gets the same treatment. There is one star, one direction and one chord,
so its beam is not sampled but **marched by the tracer** along that chord —
through the same air, stopped by the same rock, with the same horizon test — and
it reproduces the integrator's direct beam to within 2 % at 450, 550 and 650 nm,
in daylight, at a 4° Sun, at 20 km, at night, and down a shaft.

Two numbers make the measured colour, and both are on the screen:

- **which colours** — the mix of the eight bands arriving from the cone;
- **how many** — the light collected divided by the number of directions
  *looked in*, not by the number that paid out.

The second is the whole of the second question. A direction that ends in rock, or
in air the planet's own shadow has already darkened, contributes its nothing to
the average like any other. Averaging over the arrivals instead reported a bright
blue sky at the bottom of a fifty-metre mine — a true statement about the patch of
sky still visible through the mouth, and a false one about the place.

### The drawing budget is adjustable, and it changes nothing measured

Three controls under *Rays* at the advanced level set how the drawn paths are
shared out: what fraction of them are scattering events at all, what fraction of
those are aimed at the observer, and a **true proportions** switch that replaces
the first with the fraction this atmosphere really scatters.

The defaults are frankly unfaithful — 88 % of drawn paths are scattering events
where Earth's air scatters about a sixth of the light crossing it — because a
faithful budget leaves five arriving rays out of six hundred and nothing to look
at. Turning the switch on is the tool admitting that: the picture fills with the
unscattered beams that really do dominate it and the sky fan thins to almost
nothing.

**None of it moves the measurement.** The measured colour divides the light it
collects by the number of directions it looked in, so tracing a ninth as many
arriving rays divides both and leaves the answer alone. Across a 9× change in
the arriving budget the measured luminance moves by 0.45 %, which is the Monte
Carlo noise and not the knob; a test pins it.

### Two kinds of darkness, and a ring nobody sees

**Climbing** thins the rays. How many get drawn is read off the atmosphere — the
share of the air still above the observer — because light only reaches you from
a direction if something in that direction turned it towards you, and what does
the turning is air. The sky being optically thin, a tenth of the column overhead
is a tenth of the brightness, so the rays on screen and the colour beside them
fall by the same factor for the same reason.

**A shaft** does something different: it leaves the air alone and takes the sky
away. And here a plane slice through a round world will mislead you if you let
it. A drawn ray is not one direction — it is the whole **ring** of directions
you get by spinning it about the axis of view, and a ring at angle θ covers a
solid angle proportional to sin θ. Rays near the middle of your view stand for
almost no sky at all; rays out at the edge stand for a great deal.

Counting angles rather than sky is what made a well far too bright. A 50 m shaft
of 1.5 m radius leaves an aperture 1.7° wide inside a 12° field of view: **one
drawn angle in seven, but only one part in fifty of the sky.** The measurement
now weighs every ray by the ring it stands for, which is exact when you look
straight up a shaft — the aperture and the field of view are then circles about
the same axis — and an average over the ring elsewhere, where the first-order
variation of the sky across the cone cancels by symmetry.

| observer | rays drawn / directions | sky in view | measured | vs round-shaft geometry |
|---|---|---|---|---|
| open ground | 48 / 48 | 100 % | `rgb(169,198,248)` | — |
| 10 km up | 17 / 48 | 100 % | `rgb(94,120,168)` | — |
| 20 km up | 3 / 48 | 100 % | `rgb(47,62,92)` | — |
| 30 km up | 0 / 48 | 100 % | `rgb(27,37,57)` | — |
| 20 m down a 1.5 m shaft | 21 / 53 | 17 % | `rgb(71,85,110)` | 12.8 % |
| 50 m down | 5 / 50 | 1.5 % | `rgb(13,19,29)` | 2.1 % |
| 100 m down | 4 / 50 | 0.83 % | `rgb(9,14,23)` | 0.5 % |
| 200 m down | 1 / 51 | 0.16 % | `rgb(2,3,5)` | 0.1 % |
| 50 m down, looking 35° off | 0 / 48 | 0 % | `rgb(0,0,0)` | 0 % |

Before the ring weight those wells read 38 %, 8 %, 6.4 % and 1.6 % — three to
sixteen times too bright, and a fifty-metre shaft came out a comfortable blue
when it should be near black. The panel now reports both numbers, because they
answer different questions: *"5 rays across 50 directions · sky fills 1 % of
your view"*.

An earlier version thinned the fan against **the brightest sky it had ever seen**,
which made the picture depend on where the observer had been. Nothing is held now.
Count alone, never opacity: a ray that reaches you is an ordinary ray, and drawing
it faintly would say the light arrives weakened, which is a different claim and a
false one. The survivors are chosen by a fixed hash of the ray index, so climbing
thins the fan smoothly — the set at 20 km is a subset of the set at 10 km rather
than a fresh draw — and none of them blinks as unrelated things change.

Only the drawing thins. The histogram and the measured colour still use every
traced ray, because a measurement should be as precise as it can be while a
picture should be as honest as it can be, and those are different jobs.

The events *below* the observer do not thin out, and that asymmetry is the point
of the altitude experiment: the air is still there, still lit, still scattering.
It is merely no longer above you.

**Nothing is drawn inside the planet.** Every drawn segment is clipped at the
surface as well as at the frame, including the degenerate case of a scattering
event *on* the ground leaving in a downward direction — where both roots of the
surface intersection are zero, so the usual near-root test misses it. Zoomed out,
where the ground curves away and much of the frame is rock, this used to collect
the stubs of everything scattered downwards near the limb.

### How accurate is any of this?

Measured, not asserted. Every number below comes from a script run against this
build.

**What is right.** The Rayleigh and Henyey-Greenstein phase functions integrate
to 1.00000 over 4π, and Rayleigh's forward lobe is exactly twice its sideways
one. The direct beam's air mass is within **1 % of Kasten–Young** from the
zenith down to 10° elevation. The Monte Carlo estimator is unbiased: measured
against the integrator *averaged over the same fan* it lands within 1 %, and its
spread at the default 600 rays is ±2 % on brightness (±8 % looking at the
zenith, where the cone is widest in radiance), falling to ±0.5 % at 5000 rays.
The traced direct beam reproduces the integrator's to 2 % at 450, 550 and
650 nm, in daylight, at a 4° Sun, at 20 km, at night and down a shaft.

The two or three percent by which the measured sky exceeds `computeViewRadiance`
is **not an error**: the panel reports the mean radiance over a 24° field of
view and the integrator answers for one exact direction. At the zenith every
direction in the cone is brighter than the axis, so the average must come out
higher — 6 % higher, which is what it does.

**What is wrong, and by how much.**

| | size | effect |
|---|---|---|
| Rayleigh scattering is **~18 % too strong** — β(550) = 1.35×10⁻⁵ m⁻¹, the value used throughout real-time graphics, against a measured 1.14×10⁻⁵ giving τ = 0.0973 | uniform +17–19 % across 400–700 nm | the sky is a fifth brighter than reality. Being uniform, it barely touches the *colour* |
| **Single scattering only** | second order is roughly τ/2 of the first: **+14 % blue at the zenith, +28 % at 60°**, and far more near the horizon | the sky is too dark and too saturated; the horizon suffers most. Partly cancels the error above, for unrelated reasons |
| **No ozone at all** | the Chappuis band costs τ = 0.041 vertically at 600 nm — **4 % of the orange at the zenith, 39 % at 12 air masses** | the main reason a real twilight zenith is blue. This model has no such mechanism |
| ~~The cross-section is a plane slice~~ — **fixed** by weighting each ray by the ring it stands for | a 50 m shaft now measures **1.5 %** against a round-shaft **2.1 %**; 100 m, 0.83 % against 0.5 % | was 6× too bright, a trench rather than a round shaft. What remains is Monte Carlo scatter on the four or five rays that get through, which straddles the theory rather than sitting above it |
| **No refraction** | air mass at 0.5° elevation is **8.6 % below** Kasten–Young, and does not improve with quality | a very low Sun sits slightly wrong; the Sun should also set about two minutes later than drawn |
| **Nothing is sampled within 5° of the horizon** | looking at 89°, only 29 of a nominal 51 directions are cast | the brightest part of a twilight sky is outside what the rays can see. The measurement divides by what it cast, so it is not biased — it simply cannot look there |
| No multiple ground reflection, exponential density with no temperature structure, Henyey-Greenstein standing in for Mie | | ordinary simplifications, stated for completeness |

**So: is the simulation correct as it is?** For what it sets out to teach — why
the sky is blue, why a low Sun is red, why climbing empties the sky, why a well
is dark — yes, and the mechanism is right rather than painted on. As a
radiometric instrument, expect the sky brightness to be right to a factor of
order 1.2 and twilight colour to be missing its most important ingredient. The
error worth fixing next is **ozone**, without which no twilight zenith here can
turn blue for the reason a real one does.

### The beam histogram

Below the cross-section is the light those rays deliver, **counted by colour** —
one bar per band, the same eight colours as the rays, each labelled with how many
of them are arriving from the cone, so a bar can be checked against the rays it
is made of. Bars are as wide as their band, on a true wavelength axis: the deep
red covers a third of the spectrum and is drawn a third of the chart wide. Filled
means the light came from inside the viewing cone; the grey stacked on top is the
rest of the sky, divided by its own direction count so the two are the same
quantity and can be stacked at all.

The vertical scale is **held at the brightest sky seen so far** rather than
refitted each frame, and this matters. Two earlier versions were wrong in
instructive ways. The first counted rays: a fixed number is traced whatever the
state, so climbing to 40 km emptied the sky without moving a single bar. The
second weighed them but divided by the rays that *arrived*, so five rays out of
fifty at the bottom of a shaft reported the same bright sky as open ground. Now
the bars fall with it — the percentage in the corner reads 100 % at the ground
and 0 % at 30 km — and the two mean wavelengths under the axis move apart as the
star sinks: at a 55° Sun the sky averages **501 nm** and the direct beam
**581 nm**; at 4° the beam has gone well past 600 nm.

### Radiative transfer### Radiative transfer

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

**The shaft is part of the same cross-section, not a picture of its own.** An earlier
version switched to a purpose-drawn schematic of a well, which meant the shaft was the one
situation the simulator did not actually simulate — it was a diagram of what the answer
would be. The shaft is now cut out of the ground in the ordinary cross-section, drawn to
scale, and the ordinary traced rays run into its walls.

A ray whose direction is steeper than arctan(R/depth) meets rock before it reaches the
mouth. It is recorded as stopped at the wall, carries nothing, and never becomes a
scattering path at all — it is drawn ending on the wall with a cross. The rest pass through
the mouth and go on to scatter in the air above exactly as they would anywhere else. The
counts follow the geometry and nothing else: in a shaft 20 m deep, **30 of 360 directions
get through at R = 2 m and 255 of 360 at R = 8 m**, and the test suite checks the surviving
share against arctan(R/depth) inside a three-sigma band.

Because a shaft is a thing of metres under an atmosphere of kilometres, the zoom reaches
down to 20 m of frame height and fits itself to the shaft when there is one. At a wide zoom
the shaft is narrower than a pixel and simply is not drawn, which is the truth about a
two-metre hole under a hundred kilometres of air. The frame keeps the observer in view at
every zoom: the horizon rises to make room for the shaft, and when the zoom is close enough
that the horizon must leave the top of the picture, it leaves.

**The aperture cone is drawn**, at arctan(R/depth), from the observer out through the
mouth. Without it the picture is honestly puzzling — the air above is bright blue and
nothing arrives — and the reason is only implied by the stopped rays. The blue you can
actually have is the blue inside that cone; the rock has taken the rest.

### Radiance is not brightness

The radiance of a patch of sky is the same whether or not there is a shaft in the way. That
is the well paradox, and it is why the "sky in the viewing direction" swatch stays blue.
But quoting it alone left the bottom of a fifty-metre well reading as a bright blue sky,
which is not what anyone standing there would say.

An eye does not measure one direction; it collects a field of view, and what a shaft changes
is how much of that field has any sky in it. A second swatch — **how bright it looks here**
— is the mean radiance over the observer's 12° field of view, with the directions the rock
has taken counted as the nothing they deliver. Its hue comes from the rays that get through
and its intensity from how many there are:

| observer | rays arriving | sky left in view | how bright it looks |
|---|---|---|---|
| open sky | 360 | 100 % | `rgb(136,166,214)` |
| 5 m down, looking up | 70 | 100 % | `rgb(154,187,242)` |
| 20 m down, looking up | 21 | 13 % | `rgb(57,71,95)` |
| 50 m down, looking up | 5 | 2 % | `rgb(19,26,37)` |
| 50 m down, looking 35° off | 5 | 0 % | `rgb(0,0,0)` |

At 5 m the aperture is 16.7° — wider than the field of view — so looking up there is nothing
but sky in front of you and it is as bright as the open sky. Below that the share falls as
the square of the aperture, because that is how solid angle behaves.

**The sky strip is on a true linear angular axis.** It was not: the dome is sampled with
extra samples packed inside a shaft's aperture, so that a sliver of sky a degree wide is
computed at all rather than falling between samples, and the strip drew one equal-width
column per sample. That handed a third of the strip to an aperture worth two per cent of the
sky. Sampling density is a numerical concern and must not decide how wide anything looks;
the aperture is now marked, not widened.

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
- The drawn light paths are integrated with a **marched column** rather than the closed form,
  and the sun leg is **cached** per cell of (altitude, solar zenith angle) — legitimate
  because in a spherically symmetric atmosphere it depends on nothing else. A test compares
  the cached bundle against an effectively uncached one and requires the mean wavelength to
  agree to 0.004 nm.
- The families of path are **not drawn in their true proportion**. In reality about 84 % of
  the sunlight crossing Earth's air is never scattered at all; drawing that faithfully
  would leave too few arriving rays to read. The true fraction is computed from the optical
  depth and stated in the panel beside the picture. For the same reason only every third
  out-of-cone arriving ray is drawn: in full they make a grey starburst on top of the very
  convergence the cone exists to show.
- The sunward leg of an arriving ray is drawn as a **stub, not the whole journey from
  space**. At full length several hundred of them cross the entire frame at the solar angle
  and scatter the colour everywhere except the cone it is meant to mark; the unscattered
  `through` rays already show that journey at full length. The stub is clipped, never bent,
  so it stays a piece of the true straight ray.
- Where a shaft aperture is too narrow to draw it is widened and explicitly labelled "cone
  exaggerated for clarity", with the true angle shown next to it.

---

## Tests

`node tests/run-tests.js` runs **98 tests** covering:

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
- that the shaft confines the observer between its bottom and its mouth while it is on, and
  releases the ceiling again when it is switched off;
- that the shaft wall stops exactly the rays arctan(R/depth) says it should, that a stopped
  ray ends on the wall carrying nothing, and that widening the shaft lets more sky back in;
- that the zoom reaches far enough in to see a shaft — the limits were written down twice
  and drifted, so the store was undoing zooms the interface offered;
- that the share of a field of view which still has sky in it never exceeds one, falls
  monotonically with depth, vanishes when you look away from the shaft, and goes as the
  square of the aperture once it is narrow;
- config integrity, including CZ/EN key parity and bilingual completeness of every
  experiment step;
- the drawn light paths: that arriving light is measurably bluer than its source and than
  the light that got through, that every arriving path really ends at the observer with a
  single scattering vertex, that every missed path genuinely leaves in a direction that is
  not the observer, and that a vacuum produces no scattering vertex at all;
- the drawn rays being independent of the viewing direction, so turning the view restyles
  the picture rather than reshuffling it; that arriving rays cover the whole sky densely
  enough that every cone the interface can point at contains a usable bundle; and that the
  stored arrival angle agrees with the geometry of the drawn polyline, since the renderer
  selects rays by that angle alone;
- the spherical drawing geometry: that a scattering vertex's altitude follows its radius
  from the planet centre, that a low star really does make the unscattered beams cross a
  chord eight times longer and over 300 km, that those beams come out measurably redder, and
  that the histogram counts every drawn beam exactly once and shifts red as the star sinks;
- the drawn rays as a measurement: that their Monte Carlo spectrum reproduces the
  integrator's own sky colour to better than 0.01 in chromaticity and 10 % in luminance at
  three very different states, that the arriving energy falls by more than 16× when the
  observer climbs four and a half scale heights, and that the histogram measures energy
  rather than counting rays;
- that no drawn point lies inside the planet, at either zoom, and that an event on the
  ground sends nothing downwards — both fail if the surface clip is removed;
- performance: that a full interactive recompute fits inside 33 ms, and that tracing five
  thousand rays fits inside 25 ms.

## Performance

The drawn rays are now traced through spherical geometry with a marched column, which is
strictly more expensive than the flat slab and its closed form. Measured in Node on this
machine, median of ten runs, for the tracing step alone:

| | 600 rays | 2 000 rays | 5 000 rays (the maximum) |
|---|---|---|---|
| Sun at 55° | 1.7 ms | 4.5 ms | 15.5 ms |
| Sun at 3° | 1.1 ms | 2.3 ms | 5.9 ms |

A low Sun is *cheaper*, because most of the air the rays would sample is in the planet's
shadow and returns before any marching. Two things keep this affordable: the sun leg is
cached per cell of (altitude, solar zenith angle), and the march stops once the air has
thinned past twelve decay lengths — while a grazing path, where that cutoff does not bite,
keeps its full length, which is exactly the case that matters.

The model is recomputed at most once per frame and only when something changed; the
expensive step — rebuilding the atmospheric glow field and the readout DOM — is separated
from painting; and turning the view restyles the existing rays instead of retracing them, so
that path is a repaint of a few milliseconds rather than a recompute.

The test suite asserts both halves of the budget independently. Browser timings are not
quoted here: the preview environment these were developed in was too contended to measure
reliably, and quoting a number from it would be worse than quoting none.

## Browser console

`window.atmoLab` exposes `store`, `config`, `simulation`, `colorimetry`, `i18n`,
`renderers`, `result` and `renderNow()` for poking at the model directly — useful in class
for showing that the numbers behind a colour are real.

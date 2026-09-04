/**
 * The measurement panel: spectrum legend, perceived colour, and the numeric
 * readout that turns the picture into physics a student can quote.
 *
 * In comparison mode every quantity gains a second column, which is what makes
 * the well experiment convincing: two observers, one table, and the numbers
 * that differ are not the ones you would guess.
 */

import { formatAltitude, formatAngle } from '../render/scene-renderer.js';
import { RAY_BANDS } from '../physics/spectrum.js';

export function createPanels(root, { i18n, store, spectrumChart, chromaticity, colorimetry }) {
  const legend = root.querySelector('#spectrum-legend');
  const swatchSky = root.querySelector('#swatch-sky');
  const swatchPerceived = root.querySelector('#swatch-perceived');
  const swatchMeasured = root.querySelector('#swatch-measured');
  const swatchStar = root.querySelector('#swatch-star');
  const swatchTheoryStar = root.querySelector('#swatch-theory-star');
  const swatchNote = root.querySelector('#swatch-note');
  const measuredNote = root.querySelector('#measured-note');
  const bandTally = root.querySelector('#band-tally');
  const theoryAgreement = root.querySelector('#theory-agreement');
  const colorTabs = root.querySelector('#color-tabs');
  const dataBody = root.querySelector('#data-rows');
  const dataSection = root.querySelector('#data-section');
  const chromaSection = root.querySelector('#chroma-section');
  const photonTally = root.querySelector('#photon-tally');

  buildLegend();
  wireTabs();

  /**
   * Two tabs, and which one is first is the argument.
   *
   * What the interface calls the sky colour is now measured from the rays on
   * screen and from nothing else. The integrator's answer has not gone away -
   * it is one click behind, with the difference between the two spelled out -
   * but it is no longer what is shown by default, because a picture that has no
   * say in the number beside it is decoration.
   */
  function wireTabs() {
    if (!colorTabs) return;
    colorTabs.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-tab]');
      if (!button) return;
      const wanted = button.dataset.tab;
      colorTabs.querySelectorAll('button[data-tab]').forEach((b) => {
        b.classList.toggle('is-active', b.dataset.tab === wanted);
      });
      root.querySelectorAll('.tab-panel').forEach((panel) => {
        panel.hidden = panel.dataset.panel !== wanted;
      });
    });
  }

  function buildLegend() {
    legend.textContent = '';
    for (const series of spectrumChart.series) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'legend-item';
      button.dataset.key = series.key;

      const swatch = document.createElement('span');
      swatch.className = 'legend-swatch';
      swatch.style.background = series.color;
      if (series.dash.length) swatch.style.opacity = '0.75';

      const text = document.createElement('span');
      text.textContent = i18n.t(`spectrum.${legendKey(series.key)}`);

      button.append(swatch, text);
      button.addEventListener('click', () => {
        spectrumChart.toggle(series.key);
        button.classList.toggle('is-off', !spectrumChart.isVisible(series.key));
        spectrumChart.draw();
      });
      legend.appendChild(button);
    }
  }

  function legendKey(key) {
    return key === 'scattered' ? 'scatteredSky' : key;
  }

  function refreshLegendText() {
    legend.querySelectorAll('.legend-item').forEach((button) => {
      const key = button.dataset.key;
      button.lastChild.textContent = i18n.t(`spectrum.${legendKey(key)}`);
    });
  }

  /* ---- number formatting ---- */

  const fmt = {
    fixed: (v, digits = 2) => Number.isFinite(v) ? v.toFixed(digits) : '-',
    sci: (v, digits = 2) => {
      if (!Number.isFinite(v)) return '-';
      if (v === 0) return '0';
      if (Math.abs(v) >= 0.01 && Math.abs(v) < 10000) return v.toFixed(digits);
      return v.toExponential(digits);
    },
    percent: (v) => {
      if (!Number.isFinite(v)) return '-';
      if (v >= 0.01) return `${(v * 100).toFixed(1)} %`;
      if (v === 0) return '0 %';
      return `${(v * 100).toExponential(1)} %`;
    },
    length: (v) => Number.isFinite(v) ? formatAltitude(v) : '-',
    mass: (v) => v == null ? '-' : `${Math.round(v).toLocaleString(i18n.getLanguage() === 'cs' ? 'cs-CZ' : 'en-GB')} kg/m²`,
  };

  /**
   * Build the readout rows for one observer. Rows that are meaningless in the
   * current situation - a shaft aperture when there is no shaft - are dropped
   * rather than shown as dashes.
   */
  function rowsFor(evaluation, state) {
    const m = evaluation.metrics;
    const inWell = evaluation.scene.wellActive;
    const rows = [
      { key: 'data.columnFraction', value: fmt.percent(m.columnFraction) },
      { key: 'data.airColumnMass', value: fmt.mass(m.massColumn), advanced: true },
      { key: 'data.scaleHeight', value: fmt.length(m.scaleHeight), advanced: true },
      { separator: true },
      { key: 'data.opticalDepthAt', params: { lambda: 450 }, value: fmt.sci(m.verticalTau[450], 3) },
      { key: 'data.opticalDepthAt', params: { lambda: 550 }, value: fmt.sci(m.verticalTau[550], 3), advanced: true },
      { key: 'data.opticalDepthAt', params: { lambda: 650 }, value: fmt.sci(m.verticalTau[650], 3) },
      { key: 'data.airMass', value: fmt.fixed(m.airMass, 2) },
      { key: 'data.pathLength', value: fmt.length(m.pathLength), advanced: true },
      { separator: true },
      { key: 'data.skyLuminance', value: fmt.sci(m.skyLuminance, 3) },
      { key: 'data.illuminance', value: fmt.sci(evaluation.illumination.total, 3) },
      { key: 'data.scatteringAngle', value: `${fmt.fixed(m.scatteringAngleDeg, 0)}°`, advanced: true },
      { key: 'data.peakWavelength', value: `${Math.round(m.peakWavelength)} nm`, advanced: true },
    ];

    if (inWell) {
      rows.push(
        { separator: true },
        { key: 'data.apertureAngle', value: formatAngle(m.apertureHalfAngleDeg), emphasis: true },
        { key: 'data.apertureSolidAngle', value: `${fmt.sci(m.apertureSolidAngle, 2)} sr`, emphasis: true },
        { key: 'data.skyFraction', value: fmt.percent(m.skyFraction) },
        {
          key: 'data.illuminanceRatio', emphasis: true,
          value: fmt.percent(evaluation.illumination.totalOpen > 0
            ? evaluation.illumination.total / evaluation.illumination.totalOpen : 0),
        },
      );
    }
    return rows;
  }

  function renderRows(columns, advanced) {
    dataBody.textContent = '';
    const reference = columns[0].rows;

    if (columns.length > 1) {
      const head = document.createElement('tr');
      head.className = 'data-head';
      head.appendChild(document.createElement('th'));
      for (const column of columns) {
        const th = document.createElement('th');
        th.textContent = column.label;
        head.appendChild(th);
      }
      dataBody.appendChild(head);
    }

    reference.forEach((row, index) => {
      if (row.separator) {
        const tr = document.createElement('tr');
        tr.className = 'data-separator';
        const td = document.createElement('td');
        td.colSpan = columns.length + 1;
        tr.appendChild(td);
        dataBody.appendChild(tr);
        return;
      }
      if (row.advanced && !advanced) return;

      const tr = document.createElement('tr');
      if (row.emphasis) tr.className = 'is-key';
      const label = document.createElement('td');
      label.className = 'data-label';
      label.textContent = i18n.t(row.key, row.params);
      tr.appendChild(label);

      for (const column of columns) {
        const td = document.createElement('td');
        td.className = 'data-value';
        td.textContent = column.rows[index]?.value ?? '-';
        tr.appendChild(td);
      }
      dataBody.appendChild(tr);
    });
  }

  /**
   * The sky, measured from the rays and from nothing else.
   *
   * Two numbers make this colour, and both are visible on screen:
   *
   *   WHICH COLOURS. Every ray was drawn in one of eight bands, in proportion
   *     to its own spectrum, so the mix of bands arriving from the cone is the
   *     hue. The tally underneath counts them.
   *
   *   HOW MANY. The light is divided by the number of DIRECTIONS looked in, not
   *     by the number that delivered. Five rays out of fifty is a tenth of a
   *     sky, and reads as one. That is why a well goes dark: not because the
   *     light coming down it changes colour, but because there is so much less
   *     of it per direction you can look in.
   */
  function renderMeasured(result, histogram) {
    const chip = swatchMeasured.querySelector('.swatch-chip');
    const caption = swatchMeasured.querySelector('.swatch-caption');
    const detail = swatchMeasured.querySelector('.swatch-detail');
    caption.textContent = i18n.t('color.measured');

    if (!histogram || !colorimetry) {
      chip.style.background = '#000';
      detail.textContent = '-';
      return;
    }

    const measured = colorimetry.spectrumToSrgb(histogram.coneSpectrum, result.exposure);
    chip.style.background = measured.css;

    // The two things the brightness is made of, and both are on the screen.
    //
    // How many rays are drawn coming into the cone - which falls as you climb,
    // because there is less air left overhead to turn light towards you. And
    // how much of the field of view still has sky in it - which falls down a
    // shaft, because the rock takes the directions.
    //
    // The second is a share of SKY, not of drawn angles, and the difference is
    // large. A drawn ray is not one direction: it is the ring you get by
    // spinning it about the axis of view, and a ring near the middle of your
    // view stands for almost no sky at all. A fifty-metre shaft leaves one
    // drawn angle in seven but only one part in fifty of the sky.
    const cast = histogram.coneCast ?? 0;
    const drawn = histogram.drawnInCone ?? histogram.coneRays ?? 0;
    const share = histogram.skyShare;
    if (drawn === 0) {
      // Two different nothings. Either no light arrives at all - the rock has
      // taken every direction, or the star is down - or light does arrive but
      // there is less of it than one drawn ray stands for, which is what the
      // top of the atmosphere looks like.
      detail.textContent = cast === 0 ? i18n.t('color.noRays')
        : histogram.coneRays > 0 ? i18n.t('color.belowOneRay', { cast })
          : i18n.t('color.noneArrive', { cast });
    } else {
      detail.textContent = `${measured.css}  ·  `
        + i18n.t('color.raysArriving', { drawn, cast })
        + `  ·  ${i18n.t('color.skyFills', { share: formatShare(share ?? 1) })}`;
    }

    renderMeasuredStar(result, histogram);
    renderBandTally(histogram);

    // The one sentence that says where the number came from. It matters that it
    // is not the same sentence as the one on the theory tab.
    //
    // When the star is in the field of view there is a second sentence, and it
    // is an admission. The swatch above is the SKY, and the star's disc beside
    // it runs to some hundreds of thousands of times that radiance - too much
    // to fold into one colour without the answer being "white", and far too
    // much to draw as rays at the scale everything else uses. So the picture
    // shows the beam as a bundle that is frankly not to scale, and the size of
    // the lie is printed here rather than hidden.
    measuredNote.textContent = i18n.t('color.measuredNote');
    if (histogram.starInCone && histogram.beam) {
      const sky = colorimetry.luminance(histogram.coneSpectrum);
      const star = colorimetry.luminance(histogram.beam.radiance ?? histogram.beam.spectrum);
      if (sky > 0 && star > 0) {
        measuredNote.textContent += ` ${i18n.t('color.starInCone', {
          ratio: formatRatio(star / sky),
        })}`;
      }
    }
  }

  /** A large ratio, rounded to something a person would actually say. */
  function formatRatio(value) {
    if (!(value > 0)) return '-';
    if (value < 10) return value.toFixed(1);
    if (value < 1000) return String(Math.round(value / 10) * 10);
    const exponent = Math.floor(Math.log10(value));
    const lead = Math.round(value / 10 ** (exponent - 1)) / 10;
    return `${lead}×10^${exponent}`;
  }

  /**
   * The star, marched from the observer out through the air.
   *
   * Not sampled: there is one star, one direction and one chord, so the beam is
   * integrated along it with the same marcher the scattered paths use. It is
   * still the trace's own answer rather than the panel's - the same air, the
   * same rock, the same horizon test.
   */
  function renderMeasuredStar(result, histogram) {
    const beam = histogram.beam;
    const chip = swatchStar.querySelector('.swatch-chip');
    const caption = swatchStar.querySelector('.swatch-caption');
    const detail = swatchStar.querySelector('.swatch-detail');
    caption.textContent = i18n.t('color.star');

    if (!beam) {
      chip.style.background = '#000';
      detail.textContent = '-';
      swatchStar.classList.add('is-dim');
      return;
    }
    const scale = 1 / Math.max(1e-6, colorimetry.luminance(result.source));
    const colour = colorimetry.spectrumToSrgb(beam.spectrum, scale);
    chip.style.background = beam.visible ? colour.css : '#000';
    swatchStar.classList.toggle('is-dim', !beam.visible);
    detail.textContent = beam.visible
      ? `${colour.css}  ·  ${formatAltitude(beam.pathLength)}`
      // The horizon first: at night the wall is also in the way, but "the star
      // has set" is the fact that explains the other one.
      : (beam.belowHorizon
        ? i18n.t('controls.star.belowHorizon')
        : i18n.t('color.blockedByWall'));
  }

  /**
   * How many rays of each colour arrived, laid out as the spectrum.
   *
   * This is the bridge between the picture and the swatch above it: the numbers
   * here are countable on the cross-section. When a shaft closes down, watch
   * which columns empty first - they do not. The mix stays; the total goes, and
   * the total is the brightness.
   */
  function renderBandTally(histogram) {
    if (!bandTally) return;
    bandTally.textContent = '';
    const counts = histogram.coneBandRays;
    if (!counts) return;
    for (const band of RAY_BANDS) {
      const item = document.createElement('div');
      item.className = 'band-tally-item';
      const n = counts[band.index] ?? 0;
      if (n === 0) item.classList.add('is-empty');
      item.title = `${band.fromNm}-${band.toNm} nm`;

      const bar = document.createElement('div');
      bar.className = 'band-tally-bar';
      bar.style.background = band.css;

      const count = document.createElement('div');
      count.className = 'band-tally-count';
      count.textContent = String(n);

      item.append(bar, count);
      bandTally.appendChild(item);
    }
  }

  /**
   * The integrator's answer, kept for comparison.
   *
   * Everything here is computed rather than traced. It is worth keeping, and
   * worth keeping visibly separate: when the measured colour and this one agree
   * to a thousandth of a chromaticity, that agreement is evidence about the
   * model, which it could not be if either were quietly derived from the other.
   */
  function renderTheory(result, histogram) {
    const primary = result.primary;
    const blocked = primary.view.blocked;
    const sky = primary.colors.sky;
    const star = primary.colors.star;

    swatchSky.querySelector('.swatch-chip').style.background = blocked ? '#000' : sky.css;
    swatchSky.querySelector('.swatch-caption').textContent = i18n.t('color.sky');
    swatchSky.querySelector('.swatch-detail').textContent = blocked
      ? i18n.t('color.blockedByWall')
      : `${sky.css}  ·  x=${sky.chromaticity[0].toFixed(3)} y=${sky.chromaticity[1].toFixed(3)}`;

    // What the whole field of view amounts to, worked out from the geometry of
    // the aperture rather than from the rays. The measured colour gets the same
    // fact for free, by dividing over the directions it looked in.
    const perceived = primary.colors.perceived;
    swatchPerceived.querySelector('.swatch-chip').style.background = perceived.css;
    swatchPerceived.querySelector('.swatch-caption').textContent = i18n.t('color.perceived');
    swatchPerceived.querySelector('.swatch-detail').textContent =
      `${perceived.css}  ·  ${i18n.t('color.skyShare')} `
      + formatShare(primary.metrics.fieldOfViewShare);

    swatchTheoryStar.querySelector('.swatch-chip').style.background = star.css;
    swatchTheoryStar.querySelector('.swatch-caption').textContent = i18n.t('color.star');
    swatchTheoryStar.querySelector('.swatch-detail').textContent = primary.beam.visible
      ? `${star.css}  ·  x=${star.chromaticity[0].toFixed(3)} y=${star.chromaticity[1].toFixed(3)}`
      : (primary.beam.blockedByWell
        ? i18n.t('color.blockedByWall') : i18n.t('controls.star.belowHorizon'));
    swatchTheoryStar.classList.toggle('is-dim', !primary.beam.visible);

    swatchNote.textContent = i18n.t('color.computed');
    renderAgreement(result, histogram);
  }

  /**
   * How far apart the two answers are.
   *
   * A few dozen rays is a noisy instrument, so this wanders by a percent or so
   * as a slider moves, and that is worth seeing: it is the size of the error bar
   * on the picture. What it must not do is drift.
   */
  function renderAgreement(result, histogram) {
    if (!theoryAgreement) return;
    if (!histogram || !(histogram.coneRays > 0) || !colorimetry) {
      theoryAgreement.textContent = '';
      return;
    }
    const measured = colorimetry.spectrumToSrgb(histogram.coneSpectrum, result.exposure);
    const target = result.primary.colors.sky.chromaticity;
    const distance = Math.hypot(
      measured.chromaticity[0] - target[0], measured.chromaticity[1] - target[1]);
    const measuredY = colorimetry.luminance(histogram.coneSpectrum);
    const theoryY = colorimetry.luminance(result.primary.perceived);
    const ratio = theoryY > 0 ? measuredY / theoryY : null;
    theoryAgreement.textContent = i18n.t('color.agreement', {
      dxy: distance.toFixed(3),
      ratio: ratio == null ? '-' : ratio.toFixed(2),
      rays: histogram.coneRays,
    });
  }

  /** A fraction as a percentage, down to the very small ones a shaft produces. */
  function formatShare(fraction) {
    if (!(fraction > 0)) return '0 %';
    const pct = fraction * 100;
    if (pct >= 1) return `${pct.toFixed(0)} %`;
    if (pct >= 0.01) return `${pct.toFixed(2)} %`;
    return `${pct.toExponential(1)} %`;
  }

  /** Share of a spectrum's energy below the blue/red split. */
  function blueShare(spectrum, splitNm = 520) {
    let all = 0, blue = 0;
    for (let i = 0; i < spectrum.length; i++) {
      all += spectrum[i];
      if (380 + i * 10 < splitNm) blue += spectrum[i];
    }
    return all > 0 ? blue / all : null;
  }

  /**
   * The sentence that makes the picture quantitative.
   *
   * Taken off the rays, like everything else on this side of the tabs: the
   * spectrum they deliver from the cone, and the spectrum the star's own beam
   * still has when it arrives. Both wobble by a percent or two as a slider
   * moves, which is what a measurement of a few hundred samples does, and is
   * the honest price of the sentence being about the picture.
   */
  function renderPhotonTally(result, tally, state, histogram) {
    if (!tally || !state.rays.showScattering) {
      photonTally.hidden = true;
      return;
    }
    photonTally.hidden = false;
    const cs = i18n.getLanguage() === 'cs';
    const pct = (v) => (v == null ? null : Math.round(v * 100));
    const arriving = histogram && histogram.coneRays > 0
      ? pct(blueShare(histogram.coneSpectrum)) : null;
    const through = histogram && histogram.beam
      ? pct(blueShare(histogram.beam.spectrum)) : null;
    const emitted = pct(blueShare(result.source));

    if (arriving == null) {
      photonTally.textContent = cs
        ? 'Z tohoto směru k pozorovateli nedopadá žádné rozptýlené světlo.'
        : 'No scattered light reaches the observer from this direction.';
      return;
    }

    // Each clause stands on its own, because they can fail separately. Down a
    // shaft the sky is still there and the star is not, and an earlier version
    // dropped the whole sentence on that - reporting no scattered light at the
    // bottom of a well while twenty-one rays were coming down it.
    const parts = [];
    parts.push(cs
      ? `Ze světla, které dopadá k pozorovateli ze zorného kužele, je ${arriving} % modré `
        + '(< 520 nm)'
      : `Of the light arriving at the observer from the viewing cone, ${arriving}% is blue `
        + '(< 520 nm)');
    if (through != null) {
      parts.push(cs
        ? `ze světla, které projde bez rozptylu až k pozorovateli, jen ${through} %`
        : `of the light that crosses unscattered to the observer, only ${through}%`);
    }
    let text = `${parts.join('; ')}. `;
    text += cs ? `Hvězda přitom vyzářila ${emitted} % modré.`
      : `The star itself emitted ${emitted}% blue.`;

    const scattered = tally.scatteredFraction != null
      ? Math.round(tally.scatteredFraction * 100) : null;
    if (scattered != null) {
      text += cs ? ` Rozptýlí se přitom jen ${scattered} % světla, které vzduchem prochází.`
        : ` Only ${scattered}% of the light crossing the air is scattered at all.`;
    }
    photonTally.textContent = text;
  }

  function update(result, tally, histogram) {
    const state = store.state;
    const advanced = state.level === 'advanced';

    const primary = result.primary;
    spectrumChart.update({
      curves: {
        source: result.source,
        direct: primary.beam.spectrum,
        scattered: primary.view.scattered,
        observed: primary.view.observed,
      },
    });
    spectrumChart.draw();

    renderMeasured(result, histogram);
    renderTheory(result, histogram);
    renderPhotonTally(result, tally, state, histogram);

    dataSection.hidden = false;
    const columns = state.compare.enabled && result.compare
      ? [
        { label: i18n.t('compare.left'), rows: rowsFor(result.compare.left, state) },
        { label: i18n.t('compare.right'), rows: rowsFor(result.compare.right, state) },
      ]
      : [{ label: '', rows: rowsFor(primary, state) }];
    renderRows(columns, advanced);

    chromaSection.hidden = !advanced;
    if (advanced) {
      chromaticity.update({
        sky: primary.view.blocked ? null : primary.colors.sky.chromaticity,
        star: primary.beam.visible ? primary.colors.star.chromaticity : null,
      });
      chromaticity.draw();
    }
  }

  return { update, refreshLegendText };
}

/**
 * The measurement panel: spectrum legend, perceived colour, and the numeric
 * readout that turns the picture into physics a student can quote.
 *
 * In comparison mode every quantity gains a second column, which is what makes
 * the well experiment convincing: two observers, one table, and the numbers
 * that differ are not the ones you would guess.
 */

import { formatAltitude, formatAngle } from '../render/scene-renderer.js';

export function createPanels(root, { i18n, store, spectrumChart, chromaticity }) {
  const legend = root.querySelector('#spectrum-legend');
  const swatchSky = root.querySelector('#swatch-sky');
  const swatchStar = root.querySelector('#swatch-star');
  const swatchNote = root.querySelector('#swatch-note');
  const dataBody = root.querySelector('#data-rows');
  const dataSection = root.querySelector('#data-section');
  const chromaSection = root.querySelector('#chroma-section');
  const photonTally = root.querySelector('#photon-tally');

  buildLegend();

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

  function renderSwatches(result, state) {
    const primary = result.primary;
    const blocked = primary.view.blocked;
    const sky = primary.colors.sky;
    const star = primary.colors.star;

    swatchSky.querySelector('.swatch-chip').style.background = blocked ? '#000' : sky.css;
    swatchSky.querySelector('.swatch-caption').textContent = i18n.t('color.sky');
    swatchSky.querySelector('.swatch-detail').textContent = blocked
      ? i18n.t('color.blockedByWall')
      : `${sky.css}  ·  x=${sky.chromaticity[0].toFixed(3)} y=${sky.chromaticity[1].toFixed(3)}`;

    swatchStar.querySelector('.swatch-chip').style.background = star.css;
    swatchStar.querySelector('.swatch-caption').textContent = i18n.t('color.star');
    swatchStar.querySelector('.swatch-detail').textContent = primary.beam.visible
      ? `${star.css}  ·  x=${star.chromaticity[0].toFixed(3)} y=${star.chromaticity[1].toFixed(3)}`
      : (primary.beam.blockedByWell ? i18n.t('color.blockedByWall') : i18n.t('controls.star.belowHorizon'));
    swatchStar.classList.toggle('is-dim', !primary.beam.visible);

    swatchNote.textContent = i18n.t('color.computed');
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
   * The percentages are integrated off the spectra the engine already computed,
   * not counted from the drawn rays: the drawing samples a few hundred paths and
   * would wobble by a few percent as you move a slider, while these numbers are
   * exact and agree with the spectrum plot immediately above them.
   */
  function renderPhotonTally(result, tally, state) {
    if (!tally || !state.rays.showScattering) {
      photonTally.hidden = true;
      return;
    }
    photonTally.hidden = false;
    const cs = i18n.getLanguage() === 'cs';
    const pct = (v) => (v == null ? null : Math.round(v * 100));
    const arriving = pct(blueShare(result.primary.view.scattered));
    const through = pct(blueShare(result.primary.beam.spectrum));
    const emitted = pct(blueShare(result.source));

    if (arriving == null || through == null) {
      photonTally.textContent = cs
        ? 'Z tohoto směru k pozorovateli nedopadá žádné rozptýlené světlo.'
        : 'No scattered light reaches the observer from this direction.';
      return;
    }
    const scattered = tally.scatteredFraction != null
      ? Math.round(tally.scatteredFraction * 100) : null;
    const scatteredPart = scattered == null ? ''
      : (cs ? ` Rozptýlí se přitom jen ${scattered} % světla, které vzduchem prochází.`
        : ` Only ${scattered}% of the light crossing the air is scattered at all.`);
    photonTally.textContent = cs
      ? `Ze světla, které dopadá k pozorovateli ze zorného kužele, je ${arriving} % modré `
        + `(< 520 nm); ze světla, které projde bez rozptylu až k zemi, jen ${through} %. `
        + `Hvězda přitom vyzářila ${emitted} % modré.${scatteredPart}`
      : `Of the light arriving at the observer from the viewing cone, ${arriving}% is blue `
        + `(< 520 nm); of the light that crosses unscattered to the ground, only ${through}%. `
        + `The star itself emitted ${emitted}% blue.${scatteredPart}`;
  }

  function update(result, tally) {
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

    renderSwatches(result, state);
    renderPhotonTally(result, tally, state);

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

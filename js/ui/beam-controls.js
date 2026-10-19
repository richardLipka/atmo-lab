/**
 * UI Controls and Telemetry Panels for the Single Beam & Particle Micro View.
 *
 * Populates:
 *   - The left panel with view mode (Micro-Chamber vs Macro-Atmosphere), beam mode
 *     (Single Ray vs Beam Bundle), wavelength, spectral laser presets,
 *     atmospheric gas sliders, and aerosol (OPAC) parameters.
 *   - The right panel with optical telemetry, wavelength survival bars,
 *     color swatches, and pedagogical explanations.
 */

export function createBeamUI({
  leftContainer,
  rightContainer,
  i18n,
  colorimetry,
  onStateChange,
  onSwitchToScattering,
}) {
  let currentState = {
    viewType: 'micro',
    bundleMode: 'bundle',
    elevationDeg: 25,
    mode: 'sunlight',
    wavelengthNm: 532,
    densityScale: 1,
    gasScaleHeightM: 8500,
    rayleighExponent: 4,
    aerosolScale: 1,
    aerosolScaleHeightM: 1200,
    angstromExponent: 1.0,
    aerosolAlbedo: 1.0,
    asymmetryFactor: 0.75,
    enableRefraction: true,
    refractionFactor: 15,
    animate: true,
  };

  let lastTraceResult = null;

  function renderLeftPanel() {
    const isCs = i18n.getLanguage() === 'cs';

    leftContainer.innerHTML = `
      <div class="panel-section">
        <h2>${isCs ? 'Pohled a složení paprsku' : 'View & Beam Mode'}</h2>
        
        <div class="segmented" id="beam-view-toggle" style="margin-bottom:8px;display:flex;width:100%;">
          <button type="button" style="flex:1;" class="${currentState.viewType === 'micro' ? 'is-active' : ''}" data-view="micro">
            ${isCs ? '🔬 Mikrosimulace' : '🔬 Particle Micro'}
          </button>
          <button type="button" style="flex:1;" class="${currentState.viewType === 'macro' ? 'is-active' : ''}" data-view="macro">
            ${isCs ? '🌍 Atmosféra Země' : '🌍 Earth Macro'}
          </button>
        </div>

        <div class="segmented" id="beam-bundle-toggle" style="display:flex;width:100%;">
          <button type="button" style="flex:1;" class="${currentState.bundleMode === 'single' ? 'is-active' : ''}" data-bundle="single">
            ${isCs ? '⚡ 1 Paprsek' : '⚡ Single Ray'}
          </button>
          <button type="button" style="flex:1;" class="${currentState.bundleMode === 'bundle' ? 'is-active' : ''}" data-bundle="bundle">
            ${isCs ? '🔦 Svazek paprsků' : '🔦 Beam Bundle'}
          </button>
        </div>
      </div>

      <div class="panel-section">
        <h2>${isCs ? 'Poloha a směr paprsku' : 'Beam Direction & Sun'}</h2>
        
        <div class="control-row">
          <label for="beam-elevation">
            <span>${isCs ? 'Výška nad obzorem (délka dráhy)' : 'Elevation angle (path length)'}</span>
            <span class="value" id="val-beam-elevation">${currentState.elevationDeg.toFixed(1)}°</span>
          </label>
          <input type="range" id="beam-elevation" min="0" max="90" step="0.5" value="${currentState.elevationDeg}">
        </div>

        <div class="quick-buttons" style="display:flex;gap:5px;margin-top:8px;flex-wrap:wrap;">
          <button type="button" class="ghost-button small ${currentState.elevationDeg === 60 ? 'is-active' : ''}" data-elev="60">
            ☀️ ${isCs ? 'Poledne (60°)' : 'Noon (60°)'}
          </button>
          <button type="button" class="ghost-button small ${currentState.elevationDeg === 15 ? 'is-active' : ''}" data-elev="15">
            🌤️ ${isCs ? 'Odpoledne (15°)' : 'Afternoon (15°)'}
          </button>
          <button type="button" class="ghost-button small ${currentState.elevationDeg === 2 ? 'is-active' : ''}" data-elev="2">
            🌅 ${isCs ? 'Západ (2°)' : 'Sunset (2°)'}
          </button>
          <button type="button" class="ghost-button small ${currentState.elevationDeg === 0.5 ? 'is-active' : ''}" data-elev="0.5">
            🌄 ${isCs ? 'Obzor (0.5°)' : 'Horizon (0.5°)'}
          </button>
        </div>
      </div>

      <div class="panel-section">
        <h2>${isCs ? 'Světelný zdroj a vlnová délka' : 'Light Source & Wavelength'}</h2>

        <div class="segmented" id="beam-mode-toggle" style="margin-bottom:12px;display:flex;width:100%;">
          <button type="button" style="flex:1;" class="${currentState.mode === 'sunlight' ? 'is-active' : ''}" data-mode="sunlight">
            ${isCs ? 'Bílé Slunce' : 'White Sun'}
          </button>
          <button type="button" style="flex:1;" class="${currentState.mode === 'monochromatic' ? 'is-active' : ''}" data-mode="monochromatic">
            ${isCs ? 'Laser (λ)' : 'Laser (λ)'}
          </button>
        </div>

        <div id="laser-controls" ${currentState.mode === 'sunlight' ? 'hidden' : ''}>
          <div class="control-row">
            <label for="beam-wavelength">
              <span>${isCs ? 'Vlnová délka (λ)' : 'Wavelength (λ)'}</span>
              <span class="value" id="val-beam-wavelength">${currentState.wavelengthNm} nm</span>
            </label>
            <input type="range" id="beam-wavelength" min="380" max="750" step="5" value="${currentState.wavelengthNm}">
          </div>

          <div class="quick-buttons" style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;">
            <button type="button" class="ghost-button small" data-wl="405" style="border-left:3px solid #7c4dff">405 nm</button>
            <button type="button" class="ghost-button small" data-wl="450" style="border-left:3px solid #29b6f6">450 nm</button>
            <button type="button" class="ghost-button small" data-wl="488" style="border-left:3px solid #00e5ff">488 nm</button>
            <button type="button" class="ghost-button small" data-wl="532" style="border-left:3px solid #00e676">532 nm</button>
            <button type="button" class="ghost-button small" data-wl="589" style="border-left:3px solid #ffd600">589 nm</button>
            <button type="button" class="ghost-button small" data-wl="633" style="border-left:3px solid #ff5252">633 nm</button>
            <button type="button" class="ghost-button small" data-wl="650" style="border-left:3px solid #d50000">650 nm</button>
          </div>
        </div>
      </div>

      <div class="panel-section">
        <h2>${isCs ? 'Molekuly plynu (Rayleigh)' : 'Gas Molecules (Rayleigh)'}</h2>

        <div class="control-row">
          <label for="beam-density">
            <span>${isCs ? 'Hustota plynu (počet molekul)' : 'Gas Density (Molecule Count)'}</span>
            <span class="value" id="val-beam-density">${currentState.densityScale.toFixed(1)}×</span>
          </label>
          <input type="range" id="beam-density" min="0.1" max="3.0" step="0.1" value="${currentState.densityScale}">
        </div>

        <div class="control-row">
          <label for="beam-rayleigh-exponent">
            <span>${isCs ? 'Exponent rozptylu (závislost na λ)' : 'Wavelength Exponent'}</span>
            <span class="value" id="val-beam-exponent">n = ${currentState.rayleighExponent.toFixed(1)}</span>
          </label>
          <input type="range" id="beam-rayleigh-exponent" min="0" max="4.5" step="0.5" value="${currentState.rayleighExponent}">
        </div>
      </div>

      <div class="panel-section">
        <h2>${isCs ? 'Aerosoly a prach (Mie)' : 'Aerosols & Dust (Mie)'}</h2>

        <div class="control-row">
          <label for="beam-aerosol">
            <span>${isCs ? 'Množství aerosolových částic' : 'Aerosol Particle Count'}</span>
            <span class="value" id="val-beam-aerosol">${currentState.aerosolScale.toFixed(1)}×</span>
          </label>
          <input type="range" id="beam-aerosol" min="0" max="3.0" step="0.1" value="${currentState.aerosolScale}">
        </div>

        <div class="control-row">
          <label for="beam-angstrom">
            <span>${isCs ? 'Ångströmův exponent (velikost částic)' : 'Ångström exponent (size)'}</span>
            <span class="value" id="val-beam-angstrom">α = ${currentState.angstromExponent.toFixed(1)}</span>
          </label>
          <input type="range" id="beam-angstrom" min="0" max="2.0" step="0.1" value="${currentState.angstromExponent}">
        </div>

        <div class="control-row">
          <label for="beam-albedo">
            <span>${isCs ? 'Jednorázové albedo (rozptyl vs absorpce)' : 'Single-scattering albedo (SSA)'}</span>
            <span class="value" id="val-beam-albedo">ϖ = ${currentState.aerosolAlbedo.toFixed(2)}</span>
          </label>
          <input type="range" id="beam-albedo" min="0.5" max="1.0" step="0.05" value="${currentState.aerosolAlbedo}">
        </div>

        <div class="control-row">
          <label for="beam-asymmetry">
            <span>${isCs ? 'Dopředný rozptyl (asymetrie g)' : 'Forward peaking (asymmetry g)'}</span>
            <span class="value" id="val-beam-asymmetry">g = ${currentState.asymmetryFactor.toFixed(2)}</span>
          </label>
          <input type="range" id="beam-asymmetry" min="0" max="0.9" step="0.05" value="${currentState.asymmetryFactor}">
        </div>

        <div class="quick-buttons" style="display:flex;gap:4px;margin-top:8px;flex-wrap:wrap;">
          <button type="button" class="ghost-button small" data-aero-preset="clean">${isCs ? 'Čistý vzduch' : 'Clean'}</button>
          <button type="button" class="ghost-button small" data-aero-preset="continental">${isCs ? 'Běžný opar' : 'Haze'}</button>
          <button type="button" class="ghost-button small" data-aero-preset="urban">${isCs ? 'Smog (saze)' : 'Urban soot'}</button>
          <button type="button" class="ghost-button small" data-aero-preset="dust">${isCs ? 'Prach' : 'Dust'}</button>
          <button type="button" class="ghost-button small" data-aero-preset="fog">${isCs ? 'Mlha' : 'Fog'}</button>
        </div>
      </div>

      <div class="panel-section">
        <h2>${isCs ? 'Lom světla a animace' : 'Refraction & Animation'}</h2>

        <div class="toggle-row" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <span>${isCs ? 'Atmosférická refrakce' : 'Atmospheric Refraction'}</span>
          <input type="checkbox" id="beam-refraction" ${currentState.enableRefraction ? 'checked' : ''}>
        </div>

        <div class="toggle-row" style="display:flex;align-items:center;justify-content:space-between;">
          <span>${isCs ? 'Animace fotonů' : 'Photon Animation'}</span>
          <input type="checkbox" id="beam-animate" ${currentState.animate ? 'checked' : ''}>
        </div>
      </div>
    `;

    // Hook view toggle
    leftContainer.querySelectorAll('#beam-view-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentState.viewType = btn.dataset.view;
        renderLeftPanel();
        if (onStateChange) onStateChange(currentState);
      });
    });

    // Hook bundle toggle
    leftContainer.querySelectorAll('#beam-bundle-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentState.bundleMode = btn.dataset.bundle;
        renderLeftPanel();
        if (onStateChange) onStateChange(currentState);
      });
    });

    const elevSlider = leftContainer.querySelector('#beam-elevation');
    elevSlider.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      currentState.elevationDeg = val;
      leftContainer.querySelector('#val-beam-elevation').textContent = `${val.toFixed(1)}°`;
      if (onStateChange) onStateChange(currentState);
    });

    leftContainer.querySelectorAll('[data-elev]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentState.elevationDeg = parseFloat(btn.dataset.elev);
        renderLeftPanel();
        if (onStateChange) onStateChange(currentState);
      });
    });

    leftContainer.querySelectorAll('#beam-mode-toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentState.mode = btn.dataset.mode;
        renderLeftPanel();
        if (onStateChange) onStateChange(currentState);
      });
    });

    const wlSlider = leftContainer.querySelector('#beam-wavelength');
    if (wlSlider) {
      wlSlider.addEventListener('input', (e) => {
        currentState.wavelengthNm = parseInt(e.target.value, 10);
        leftContainer.querySelector('#val-beam-wavelength').textContent = `${currentState.wavelengthNm} nm`;
        if (onStateChange) onStateChange(currentState);
      });
    }

    leftContainer.querySelectorAll('[data-wl]').forEach((btn) => {
      btn.addEventListener('click', () => {
        currentState.wavelengthNm = parseInt(btn.dataset.wl, 10);
        renderLeftPanel();
        if (onStateChange) onStateChange(currentState);
      });
    });

    const densitySlider = leftContainer.querySelector('#beam-density');
    densitySlider.addEventListener('input', (e) => {
      currentState.densityScale = parseFloat(e.target.value);
      leftContainer.querySelector('#val-beam-density').textContent = `${currentState.densityScale.toFixed(1)}×`;
      if (onStateChange) onStateChange(currentState);
    });

    const rayleighExpSlider = leftContainer.querySelector('#beam-rayleigh-exponent');
    rayleighExpSlider.addEventListener('input', (e) => {
      currentState.rayleighExponent = parseFloat(e.target.value);
      leftContainer.querySelector('#val-beam-exponent').textContent = `n = ${currentState.rayleighExponent.toFixed(1)}`;
      if (onStateChange) onStateChange(currentState);
    });

    const aerosolSlider = leftContainer.querySelector('#beam-aerosol');
    aerosolSlider.addEventListener('input', (e) => {
      currentState.aerosolScale = parseFloat(e.target.value);
      leftContainer.querySelector('#val-beam-aerosol').textContent = `${currentState.aerosolScale.toFixed(1)}×`;
      if (onStateChange) onStateChange(currentState);
    });

    const angstromSlider = leftContainer.querySelector('#beam-angstrom');
    angstromSlider.addEventListener('input', (e) => {
      currentState.angstromExponent = parseFloat(e.target.value);
      leftContainer.querySelector('#val-beam-angstrom').textContent = `α = ${currentState.angstromExponent.toFixed(1)}`;
      if (onStateChange) onStateChange(currentState);
    });

    const albedoSlider = leftContainer.querySelector('#beam-albedo');
    albedoSlider.addEventListener('input', (e) => {
      currentState.aerosolAlbedo = parseFloat(e.target.value);
      leftContainer.querySelector('#val-beam-albedo').textContent = `ϖ = ${currentState.aerosolAlbedo.toFixed(2)}`;
      if (onStateChange) onStateChange(currentState);
    });

    const asymSlider = leftContainer.querySelector('#beam-asymmetry');
    asymSlider.addEventListener('input', (e) => {
      currentState.asymmetryFactor = parseFloat(e.target.value);
      leftContainer.querySelector('#val-beam-asymmetry').textContent = `g = ${currentState.asymmetryFactor.toFixed(2)}`;
      if (onStateChange) onStateChange(currentState);
    });

    leftContainer.querySelectorAll('[data-aero-preset]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const p = btn.dataset.aeroPreset;
        if (p === 'clean') {
          currentState.aerosolScale = 0;
        } else if (p === 'continental') {
          currentState.aerosolScale = 1.0;
          currentState.angstromExponent = 1.3;
          currentState.aerosolAlbedo = 0.98;
          currentState.asymmetryFactor = 0.70;
        } else if (p === 'urban') {
          currentState.aerosolScale = 1.5;
          currentState.angstromExponent = 1.1;
          currentState.aerosolAlbedo = 0.72;
          currentState.asymmetryFactor = 0.68;
        } else if (p === 'dust') {
          currentState.aerosolScale = 1.8;
          currentState.angstromExponent = 0.2;
          currentState.aerosolAlbedo = 0.89;
          currentState.asymmetryFactor = 0.75;
        } else if (p === 'fog') {
          currentState.aerosolScale = 2.5;
          currentState.angstromExponent = 0.0;
          currentState.aerosolAlbedo = 1.0;
          currentState.asymmetryFactor = 0.85;
        }
        renderLeftPanel();
        if (onStateChange) onStateChange(currentState);
      });
    });

    const refrCheck = leftContainer.querySelector('#beam-refraction');
    refrCheck.addEventListener('change', (e) => {
      currentState.enableRefraction = e.target.checked;
      if (onStateChange) onStateChange(currentState);
    });

    const animCheck = leftContainer.querySelector('#beam-animate');
    animCheck.addEventListener('change', (e) => {
      currentState.animate = e.target.checked;
      if (onStateChange) onStateChange(currentState);
    });
  }

  function renderRightPanel(traceResult) {
    lastTraceResult = traceResult;
    const isCs = i18n.getLanguage() === 'cs';

    if (!traceResult) return;

    const finalSRGB = colorimetry.spectrumToSrgb(traceResult.finalSpectrum, 1.4);
    const chipCol = finalSRGB.css;

    const tRed = (traceResult.keyTransmittances.red650 * 100).toFixed(1);
    const tGreen = (traceResult.keyTransmittances.green530 * 100).toFixed(1);
    const tBlue = (traceResult.keyTransmittances.blue450 * 100).toFixed(1);

    const isSunset = traceResult.elevationDeg <= 5;

    rightContainer.innerHTML = `
      <section class="panel-section">
        <h2>${isCs ? 'Světlo dopadající k detektoru' : 'Light Reaching Detector'}</h2>
        
        <div class="swatches">
          <div class="swatch" style="display:flex;align-items:center;gap:12px;padding:10px;background:var(--bg-input);border-radius:var(--radius-sm);">
            <div class="swatch-chip" style="width:48px;height:48px;border-radius:8px;background:${chipCol};box-shadow:0 0 16px ${chipCol}44;border:1px solid rgba(255,255,255,0.2);"></div>
            <div>
              <div style="font-weight:600;font-size:14px;color:var(--text);">${isSunset ? (isCs ? 'Zapadající Slunce (červánky)' : 'Setting Sun (Crimson)') : (isCs ? 'Přímý sluneční paprsek' : 'Direct Sunbeam')}</div>
              <div style="font-size:12px;color:var(--text-dim);font-family:var(--mono);">sRGB: ${finalSRGB.rgb[0]}, ${finalSRGB.rgb[1]}, ${finalSRGB.rgb[2]}</div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel-section">
        <h2>${isCs ? 'Propustnost podle vlnových délek' : 'Transmittance by Wavelength'}</h2>
        
        <div class="survival-bars" style="display:flex;flex-direction:column;gap:10px;margin-top:6px;">
          <div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
              <span>🔴 ${isCs ? 'Červená (650 nm)' : 'Red (650 nm)'}</span>
              <strong style="color:#ef5350">${tRed} %</strong>
            </div>
            <div style="height:8px;background:var(--bg-input);border-radius:4px;overflow:hidden;">
              <div style="height:100%;width:${tRed}%;background:#ef5350;border-radius:4px;"></div>
            </div>
          </div>

          <div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
              <span>🟢 ${isCs ? 'Zelená (530 nm)' : 'Green (530 nm)'}</span>
              <strong style="color:#66bb6a">${tGreen} %</strong>
            </div>
            <div style="height:8px;background:var(--bg-input);border-radius:4px;overflow:hidden;">
              <div style="height:100%;width:${tGreen}%;background:#66bb6a;border-radius:4px;"></div>
            </div>
          </div>

          <div>
            <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px;">
              <span>🔵 ${isCs ? 'Modrá (450 nm)' : 'Blue (450 nm)'}</span>
              <strong style="color:#42a5f5">${tBlue} %</strong>
            </div>
            <div style="height:8px;background:var(--bg-input);border-radius:4px;overflow:hidden;">
              <div style="height:100%;width:${tBlue}%;background:#42a5f5;border-radius:4px;"></div>
            </div>
          </div>
        </div>
      </section>

      <section class="panel-section">
        <h2>${isCs ? 'Mikro-fyzika srážek a rozptylu' : 'Micro-Physics & Collisions'}</h2>
        <table class="data-table">
          <tbody>
            <tr>
              <td>${isCs ? 'Účinný průřez modré vs červené' : 'Blue vs Red cross-section'}</td>
              <td><strong style="color:#5aa9ff;">σ(405) ≈ 6.6× σ(650)</strong></td>
            </tr>
            <tr>
              <td>${isCs ? 'Zákon rozptylu na molekulách' : 'Molecular scattering law'}</td>
              <td><strong>σ ∝ 1 / λ⁴</strong> (Rayleigh)</td>
            </tr>
            <tr>
              <td>${isCs ? 'Rozptyl na aerosolech' : 'Aerosol scattering'}</td>
              <td><strong>σ ∝ 1 / λᵅ</strong> (Mie, α ≈ 1.3)</td>
            </tr>
            <tr>
              <td>${isCs ? 'Srážky s molekulami (Rayleigh)' : 'Molecular collisions'}</td>
              <td><span style="color:#5aa9ff;">${traceResult.counts.rayleigh}</span></td>
            </tr>
            <tr>
              <td>${isCs ? 'Srážky s aerosoly (Mie)' : 'Aerosol collisions'}</td>
              <td><span style="color:#ffe082;">${traceResult.counts.aerosol}</span></td>
            </tr>
            <tr>
              <td>${isCs ? 'Pohlcené fotony (absorpce)' : 'Absorbed photons'}</td>
              <td><span style="color:#ff6b6b;">${traceResult.counts.absorbed || 0}</span></td>
            </tr>
            <tr>
              <td>${isCs ? 'Vzdušná hmota (Airmass)' : 'Airmass'}</td>
              <td><strong>${traceResult.airmass.toFixed(1)}×</strong></td>
            </tr>
          </tbody>
        </table>
      </section>

      <section class="panel-section" style="background:var(--bg-panel-2);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--line);">
        <h3 style="font-size:13px;color:var(--accent-warm);margin-bottom:6px;">
          ${isCs ? '🔬 Jak ze srážek paprsků vzniká barva oblohy?' : '🔬 How Beam Collisions Build Sky Colour'}
        </h3>
        <p style="font-size:12px;color:var(--text-dim);margin:0;line-height:1.5;">
          ${isCs
            ? 'V mikrosimulaci naráží paprsek na konkrétní molekuly a aerosoly. Modré světlo má velký účinný průřez (~6.6× větší než červené), proto naráží na molekuly velmi často a je odraženo do stran (modrá obloha). Červené světlo má malý průřez, prochází mezerami bez srážky a dopadá přímo na detektor (červený západ Slunce).'
            : 'In the microsimulation, the ray directly collides with discrete molecules and aerosols. Blue light has a much larger cross-section (~6.6× larger than red), so it collides frequently and scatters outward (blue sky). Red light has a small cross-section, easily slips through gaps without collision, and reaches the detector (red sunset).'}
        </p>

        <button type="button" id="btn-switch-to-scattering" class="primary-button" style="width:100%;margin-top:14px;display:flex;align-items:center;justify-content:center;gap:8px;">
          <span>${isCs ? 'Přejít na celou simulaci rozptylu oblohy' : 'Proceed to Full Sky Simulation'}</span>
          <span>→</span>
        </button>
      </section>
    `;

    const switchBtn = rightContainer.querySelector('#btn-switch-to-scattering');
    if (switchBtn && onSwitchToScattering) {
      switchBtn.addEventListener('click', onSwitchToScattering);
    }
  }

  function update(nextState, traceResult) {
    if (nextState) {
      Object.assign(currentState, nextState);
    }
    renderLeftPanel();
    if (traceResult) {
      renderRightPanel(traceResult);
    }
  }

  return {
    renderLeftPanel,
    renderRightPanel,
    update,
  };
}

/**
 * Interactive Atmospheric Ray Tracer Canvas.
 *
 * Provides two synchronized views:
 *   1. 'micro' (Default): Microscopic Interaction Chamber.
 *      Directly visualizes the path of a ray (or a bundle of rays), discrete collisions
 *      with gas molecules (N2/O2) and aerosol particles, dipole wavelets, scattering
 *      angles theta, and how a bundle of rays naturally reddens as blue rays are
 *      scattered out to the sides.
 *   2. 'macro': Planetary Earth Atmosphere.
 *      Visualizes spherical chord geometry from space to observer, airmass,
 *      and atmospheric refraction.
 */

import {
  EARTH_RADIUS_M, TOA_ALTITUDE_M, traceSingleBeam,
  createChamberParticles, traceMicroRay, traceMicroBundle,
  effectiveCollisionRadius,
} from '../physics/beam-tracer.js';

export function createBeamCanvas(canvas, { i18n, colorimetry, onElevationChange, onStateChange }) {
  const ctx = canvas.getContext('2d', { alpha: false });

  let state = {
    viewType: 'micro', // 'micro' | 'macro'
    bundleMode: 'bundle', // 'single' | 'bundle'
    elevationDeg: 25,
    mode: 'sunlight', // 'sunlight' | 'monochromatic'
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
    loupeMode: 'rayleigh',
    chamberSeed: 12345,
  };

  let traceResult = null;
  let microChamber = null;
  let microSingleResult = null;
  let microBundleResult = null;

  let animTime = 0;
  let isDraggingSun = false;
  let singleRayProgress = 0; // for animated single ray shot

  // Interactive buttons on the canvas header
  const buttons = [];

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(300, rect.width || canvas.clientWidth || 800);
    const h = Math.max(220, rect.height || canvas.clientHeight || 450);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const targetW = Math.round(w * dpr);
    const targetH = Math.round(h * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function recompute() {
    traceResult = traceSingleBeam({
      elevationDeg: state.elevationDeg,
      mode: state.mode,
      wavelengthNm: state.wavelengthNm,
      densityScale: state.densityScale,
      gasScaleHeightM: state.gasScaleHeightM,
      rayleighExponent: state.rayleighExponent,
      aerosolScale: state.aerosolScale,
      aerosolScaleHeightM: state.aerosolScaleHeightM,
      angstromExponent: state.angstromExponent,
      aerosolAlbedo: state.aerosolAlbedo,
      asymmetryFactor: state.asymmetryFactor,
      enableRefraction: state.enableRefraction,
      refractionFactor: state.refractionFactor,
    });

    const { w, h } = resize();

    // Scale chamber particle density with elevation:
    // Low sun (sunset) corresponds to higher effective path density!
    const pathDensityFactor = Math.max(0.6, Math.min(2.8, (traceResult.airmass || 1) * 0.45));
    const effectiveGasDensity = state.densityScale * pathDensityFactor;
    const effectiveAeroDensity = state.aerosolScale * pathDensityFactor;

    microChamber = createChamberParticles(w, h, {
      densityScale: effectiveGasDensity,
      aerosolScale: effectiveAeroDensity,
      aerosolAlbedo: state.aerosolAlbedo,
      asymmetryFactor: state.asymmetryFactor,
      seed: state.chamberSeed,
    });

    // Single ray trace
    microSingleResult = traceMicroRay(microChamber, {
      startX: 70,
      startY: h / 2,
      angleRad: 0,
      wavelengthNm: state.mode === 'monochromatic' ? state.wavelengthNm : 450,
      aerosolAlbedo: state.aerosolAlbedo,
      asymmetryFactor: state.asymmetryFactor,
    });

    // Bundle trace
    microBundleResult = traceMicroBundle(microChamber, {
      rayCount: 28,
      beamHeight: Math.min(100, h * 0.38),
      startY: h / 2,
      mode: state.mode,
      wavelengthNm: state.wavelengthNm,
      aerosolAlbedo: state.aerosolAlbedo,
      asymmetryFactor: state.asymmetryFactor,
      seed: state.chamberSeed + 7,
    });
  }

  function update(newState) {
    let changed = false;
    for (const [k, v] of Object.entries(newState)) {
      if (state[k] !== v) {
        state[k] = v;
        changed = true;
      }
    }
    if (changed || !traceResult) {
      recompute();
    }
    draw();
  }

  function getPointerElevation(e) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    const cx = rect.width * 0.18;
    const cy = rect.height * 0.84;

    const dx = px - cx;
    const dy = cy - py;
    if (dx <= 0 && dy <= 0) return state.elevationDeg;

    let rad = Math.atan2(dy, dx);
    let deg = (rad * 180) / Math.PI;
    deg = Math.max(0, Math.min(90, deg));
    return deg;
  }

  canvas.addEventListener('pointerdown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Check click on UI buttons on canvas
    for (const btn of buttons) {
      if (px >= btn.x && px <= btn.x + btn.w && py >= btn.y && py <= btn.y + btn.h) {
        btn.onClick();
        draw();
        return;
      }
    }

    if (state.viewType === 'macro') {
      const loupeX = rect.width - 130;
      const loupeY = rect.height - 130;
      if (Math.hypot(px - loupeX, py - loupeY) <= 60) {
        state.loupeMode = state.loupeMode === 'rayleigh' ? 'mie' : 'rayleigh';
        draw();
        return;
      }

      isDraggingSun = true;
      canvas.setPointerCapture(e.pointerId);
      const newElev = getPointerElevation(e);
      if (Math.abs(newElev - state.elevationDeg) > 0.5) {
        state.elevationDeg = newElev;
        recompute();
        if (onElevationChange) onElevationChange(newElev);
        draw();
      }
    } else {
      // In micro mode: clicking chamber triggers a ray shoot animation or re-seeds
      singleRayProgress = 0;
      draw();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!isDraggingSun || state.viewType !== 'macro') return;
    const newElev = getPointerElevation(e);
    state.elevationDeg = newElev;
    recompute();
    if (onElevationChange) onElevationChange(newElev);
    draw();
  });

  const stopDrag = (e) => {
    if (isDraggingSun) {
      isDraggingSun = false;
      try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    }
  };
  canvas.addEventListener('pointerup', stopDrag);
  canvas.addEventListener('pointercancel', stopDrag);

  // Animation loop
  function tick(timestamp) {
    animTime = timestamp * 0.001;
    if (state.animate) {
      singleRayProgress = (singleRayProgress + 0.015) % 1;
      draw();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function draw() {
    const { w, h } = resize();
    if (!traceResult || !microChamber) recompute();

    buttons.length = 0; // Clear button hitboxes

    if (state.viewType === 'micro') {
      drawMicroView(ctx, w, h);
    } else {
      drawMacroView(ctx, w, h);
    }

    // Top control bar
    drawTopNav(ctx, w, h);
  }

  /**
   * Top Navigation Switcher on Canvas.
   */
  function drawTopNav(ctx, w, h) {
    const isCs = i18n.getLanguage() === 'cs';
    ctx.save();

    let startX = 14;
    const barY = 14;
    const barH = 30;

    // View switcher: [🔬 Mikrosimulace] | [🌍 Zemská atmosféra]
    const viewBtnW = isCs ? 150 : 140;
    const isMicro = state.viewType === 'micro';

    // Micro button
    ctx.fillStyle = isMicro ? '#2979ff' : 'rgba(20, 26, 40, 0.85)';
    ctx.strokeStyle = isMicro ? '#70a5ff' : '#2b364c';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(startX, barY, viewBtnW, barH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isCs ? '🔬 Mikrosimulace kolizí' : '🔬 Particle Collisions', startX + viewBtnW / 2, barY + 19);

    buttons.push({
      x: startX, y: barY, w: viewBtnW, h: barH,
      onClick: () => {
        state.viewType = 'micro';
        if (onStateChange) onStateChange(state);
      },
    });

    startX += viewBtnW + 8;

    // Macro button
    const macroBtnW = isCs ? 150 : 140;
    ctx.fillStyle = !isMicro ? '#2979ff' : 'rgba(20, 26, 40, 0.85)';
    ctx.strokeStyle = !isMicro ? '#70a5ff' : '#2b364c';
    ctx.beginPath();
    ctx.roundRect(startX, barY, macroBtnW, barH, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.fillText(isCs ? '🌍 Zemská atmosféra' : '🌍 Earth Atmosphere', startX + macroBtnW / 2, barY + 19);

    buttons.push({
      x: startX, y: barY, w: macroBtnW, h: barH,
      onClick: () => {
        state.viewType = 'macro';
        if (onStateChange) onStateChange(state);
      },
    });

    startX += macroBtnW + 16;

    if (isMicro) {
      // Beam composition: [⚡ 1 Paprsek] | [🔦 Svazek]
      const isBundle = state.bundleMode === 'bundle';
      const singleBtnW = isCs ? 100 : 90;

      ctx.fillStyle = !isBundle ? '#00e676' : 'rgba(20, 26, 40, 0.85)';
      ctx.strokeStyle = !isBundle ? '#69f0ae' : '#2b364c';
      ctx.beginPath();
      ctx.roundRect(startX, barY, singleBtnW, barH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = !isBundle ? '#000000' : '#ffffff';
      ctx.fillText(isCs ? '⚡ 1 Paprsek' : '⚡ Single Ray', startX + singleBtnW / 2, barY + 19);

      buttons.push({
        x: startX, y: barY, w: singleBtnW, h: barH,
        onClick: () => {
          state.bundleMode = 'single';
          if (onStateChange) onStateChange(state);
        },
      });

      startX += singleBtnW + 6;

      const bundleBtnW = isCs ? 110 : 100;
      ctx.fillStyle = isBundle ? '#00e676' : 'rgba(20, 26, 40, 0.85)';
      ctx.strokeStyle = isBundle ? '#69f0ae' : '#2b364c';
      ctx.beginPath();
      ctx.roundRect(startX, barY, bundleBtnW, barH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = isBundle ? '#000000' : '#ffffff';
      ctx.fillText(isCs ? '🔦 Svazek paprsků' : '🔦 Beam Bundle', startX + bundleBtnW / 2, barY + 19);

      buttons.push({
        x: startX, y: barY, w: bundleBtnW, h: barH,
        onClick: () => {
          state.bundleMode = 'bundle';
          if (onStateChange) onStateChange(state);
        },
      });

      startX += bundleBtnW + 12;

      // Reseed particles button
      const reseedW = 34;
      ctx.fillStyle = 'rgba(20, 26, 40, 0.85)';
      ctx.strokeStyle = '#2b364c';
      ctx.beginPath();
      ctx.roundRect(startX, barY, reseedW, barH, 6);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.font = '13px system-ui, sans-serif';
      ctx.fillText('🔄', startX + reseedW / 2, barY + 20);

      buttons.push({
        x: startX, y: barY, w: reseedW, h: barH,
        onClick: () => {
          state.chamberSeed = (state.chamberSeed * 1664525 + 1013904223) >>> 0;
          recompute();
          if (onStateChange) onStateChange(state);
        },
      });
    }

    ctx.restore();
  }

  /**
   * 1. MICROSCOPIC INTERACTION CHAMBER (Particle Collisions View).
   */
  function drawMicroView(ctx, w, h) {
    const isCs = i18n.getLanguage() === 'cs';

    // Chamber background
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#060810');
    bgGrad.addColorStop(1, '#0c101c');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Chamber geometry
    const padLeft = 70;
    const padRight = 80;
    const padTop = 60;
    const padBottom = 40;
    const cw = w - padLeft - padRight;
    const ch = h - padTop - padBottom;
    const centerY = padTop + ch / 2;

    // Chamber grid background
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 1;
    for (let x = padLeft; x <= padLeft + cw; x += 40) {
      ctx.beginPath();
      ctx.moveTo(x, padTop);
      ctx.lineTo(x, padTop + ch);
      ctx.stroke();
    }
    for (let y = padTop; y <= padTop + ch; y += 40) {
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + cw, y);
      ctx.stroke();
    }
    ctx.restore();

    // Top and Bottom "Sky" collection borders
    ctx.save();
    const skyGradTop = ctx.createLinearGradient(0, padTop, 0, padTop + 35);
    skyGradTop.addColorStop(0, 'rgba(60, 140, 255, 0.22)');
    skyGradTop.addColorStop(1, 'rgba(60, 140, 255, 0)');
    ctx.fillStyle = skyGradTop;
    ctx.fillRect(padLeft, padTop, cw, 35);

    const skyGradBot = ctx.createLinearGradient(0, padTop + ch, 0, padTop + ch - 35);
    skyGradBot.addColorStop(0, 'rgba(60, 140, 255, 0.22)');
    skyGradBot.addColorStop(1, 'rgba(60, 140, 255, 0)');
    ctx.fillStyle = skyGradBot;
    ctx.fillRect(padLeft, padTop + ch - 35, cw, 35);
    ctx.restore();

    // Chamber border enclosure
    ctx.save();
    ctx.strokeStyle = 'rgba(90, 120, 170, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(padLeft, padTop, cw, ch);
    ctx.restore();

    // Emitter on Left
    ctx.save();
    const emitterH = Math.min(100, ch * 0.44);
    const emitterY = centerY - emitterH / 2;
    ctx.fillStyle = '#182030';
    ctx.strokeStyle = '#3d4d6e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(padLeft - 24, emitterY, 24, emitterH, [6, 0, 0, 6]);
    ctx.fill();
    ctx.stroke();

    // Emitter glow aperture
    const sourceCol = state.mode === 'sunlight' ? '#fff4db' : colorimetry.spectrumToSrgb(traceResult.finalSpectrum, 1.5).css;
    const emitGlow = ctx.createRadialGradient(padLeft, centerY, 2, padLeft, centerY, emitterH * 0.6);
    emitGlow.addColorStop(0, sourceCol);
    emitGlow.addColorStop(0.5, 'rgba(255, 200, 100, 0.4)');
    emitGlow.addColorStop(1, 'rgba(255, 200, 100, 0)');
    ctx.fillStyle = emitGlow;
    ctx.fillRect(padLeft - 5, emitterY, 15, emitterH);

    ctx.fillStyle = '#8b9bb4';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.fillText(isCs ? 'ZDROJ' : 'SOURCE', padLeft - 28, centerY + 3);
    ctx.restore();

    // Detector / Receiver on Right
    ctx.save();
    const detectorH = Math.min(110, ch * 0.48);
    const detectorY = centerY - detectorH / 2;
    const finalSRGB = colorimetry.spectrumToSrgb(traceResult.finalSpectrum, 1.4);
    const receivedCol = finalSRGB.css;

    ctx.fillStyle = '#182030';
    ctx.strokeStyle = '#3d4d6e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(padLeft + cw, detectorY, 28, detectorH, [0, 6, 6, 0]);
    ctx.fill();
    ctx.stroke();

    // Sensor screen face
    ctx.fillStyle = receivedCol;
    ctx.shadowColor = receivedCol;
    ctx.shadowBlur = 12;
    ctx.fillRect(padLeft + cw + 3, detectorY + 6, 12, detectorH - 12);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#8b9bb4';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'left';
    ctx.fillText(isCs ? 'DETEKTOR' : 'DETECTOR', padLeft + cw + 34, centerY + 3);
    ctx.restore();

    // 2. Draw Particles in Chamber: Gas Molecules & Aerosols
    drawParticles(ctx, microChamber, animTime);

    // 3. Draw Rays: Single Ray vs. Bundle Mode
    if (state.bundleMode === 'single') {
      drawSingleRayMode(ctx, microSingleResult, microChamber, animTime, isCs, colorimetry);
    } else {
      drawBundleMode(ctx, microBundleResult, microChamber, animTime, isCs, colorimetry, padLeft, cw, padTop, ch);
    }

    // 4. Chamber Info Badge
    drawMicroTelemetry(ctx, w, h, isCs, microBundleResult, state);
  }

  /**
   * Draw individual gas molecules (diatomic N2/O2) and aerosols.
   */
  function drawParticles(ctx, chamber, time) {
    for (const p of chamber.particles) {
      // Gentle thermal jitter
      const jx = Math.sin(time * 2 + p.id * 1.3) * 1.2;
      const jy = Math.cos(time * 2 + p.id * 1.7) * 1.2;
      const px = p.x + jx;
      const py = p.y + jy;

      if (p.type === 'gas') {
        // Diatomic molecule (N2 / O2): two paired atoms with bond
        const rot = p.bondAngle + time * p.rotationSpeed;
        const bondDist = 3.8;
        const x1 = px + Math.cos(rot) * bondDist;
        const y1 = py + Math.sin(rot) * bondDist;
        const x2 = px - Math.cos(rot) * bondDist;
        const y2 = py - Math.sin(rot) * bondDist;

        // Covalent bond
        ctx.save();
        ctx.strokeStyle = 'rgba(100, 170, 255, 0.5)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Atom 1
        ctx.fillStyle = '#5aa9ff';
        ctx.shadowColor = '#5aa9ff';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(x1, y1, 2.8, 0, Math.PI * 2);
        ctx.fill();

        // Atom 2
        ctx.beginPath();
        ctx.arc(x2, y2, 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        // Aerosol particle: larger dust grain or water droplet
        ctx.save();
        const r = p.radius;
        const aeroGrad = ctx.createRadialGradient(px - r * 0.3, py - r * 0.3, r * 0.1, px, py, r);
        aeroGrad.addColorStop(0, 'rgba(255, 230, 160, 0.85)');
        aeroGrad.addColorStop(0.7, 'rgba(200, 160, 90, 0.65)');
        aeroGrad.addColorStop(1, 'rgba(140, 100, 50, 0.35)');

        ctx.fillStyle = aeroGrad;
        ctx.strokeStyle = 'rgba(255, 220, 140, 0.7)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /**
   * Draw Single Ray trajectory with collision callouts and dipole wavelets.
   */
  function drawSingleRayMode(ctx, rayResult, chamber, time, isCs, colorimetry) {
    if (!rayResult || !rayResult.segments) return;

    const wl = rayResult.wavelengthNm;
    const colStr = wlToColor(wl);

    // 1. Draw Ray Segments
    ctx.save();
    for (let i = 0; i < rayResult.segments.length; i++) {
      const seg = rayResult.segments[i];

      // Segment glow
      ctx.strokeStyle = colStr;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();

      // Segment core
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(seg.x1, seg.y1);
      ctx.lineTo(seg.x2, seg.y2);
      ctx.stroke();
    }
    ctx.restore();

    // 2. Collision Points and Reactions
    for (let j = 0; j < rayResult.collisions.length; j++) {
      const c = rayResult.collisions[j];
      const isRayleigh = c.type === 'rayleigh';

      ctx.save();
      // Flash at collision point
      ctx.fillStyle = isRayleigh ? '#ffffff' : '#ffd54f';
      ctx.shadowColor = colStr;
      ctx.shadowBlur = 14;
      ctx.beginPath();
      ctx.arc(c.x, c.y, isRayleigh ? 4.5 : 6, 0, Math.PI * 2);
      ctx.fill();

      // Expanding dipole wavelets radiating outward from molecule
      const wavePhase = (time * 3 + j * 0.4) % 1;
      for (let r = 8; r <= 32; r += 8) {
        const rad = r + wavePhase * 10;
        ctx.strokeStyle = colStr;
        ctx.globalAlpha = Math.max(0, 0.6 - (rad / 42));
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, rad, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Callout box near collision
      ctx.globalAlpha = 0.95;
      ctx.fillStyle = 'rgba(15, 20, 32, 0.90)';
      ctx.strokeStyle = isRayleigh ? '#5aa9ff' : '#ffd54f';
      ctx.lineWidth = 1;

      const calloutText = isRayleigh
        ? (isCs ? `💥 Kolize s molekulou plynu! Rozptyl θ = ${Math.abs(c.scatterAngleDeg).toFixed(0)}°` : `💥 Molecular collision! Rayleigh θ = ${Math.abs(c.scatterAngleDeg).toFixed(0)}°`)
        : (c.type === 'absorbed'
          ? (isCs ? '💥 Pohlceno aerosolem (absorpce)' : '💥 Absorbed by aerosol')
          : (isCs ? `💥 Kolize s aerosolem! Dopředný rozptyl θ = ${Math.abs(c.scatterAngleDeg).toFixed(0)}°` : `💥 Aerosol collision! Forward Mie θ = ${Math.abs(c.scatterAngleDeg).toFixed(0)}°`));

      ctx.font = '10px ui-monospace, monospace';
      const textW = ctx.measureText(calloutText).width;
      const boxX = Math.min(chamber.width - textW - 20, Math.max(20, c.x - textW / 2));
      const boxY = c.y - 28;

      ctx.beginPath();
      ctx.roundRect(boxX - 6, boxY - 12, textW + 12, 20, 4);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'left';
      ctx.fillText(calloutText, boxX, boxY + 2);
      ctx.restore();
    }

    // 3. Animated photon bead traveling along path
    ctx.save();
    let totalLen = 0;
    for (const s of rayResult.segments) {
      totalLen += Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
    }
    const currentDist = (singleRayProgress * totalLen);
    let walked = 0;
    let beadX = rayResult.segments[0].x1;
    let beadY = rayResult.segments[0].y1;

    for (const s of rayResult.segments) {
      const segLen = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      if (walked + segLen >= currentDist) {
        const frac = (currentDist - walked) / Math.max(1, segLen);
        beadX = s.x1 + (s.x2 - s.x1) * frac;
        beadY = s.y1 + (s.y2 - s.y1) * frac;
        break;
      }
      walked += segLen;
    }

    ctx.fillStyle = '#ffffff';
    ctx.shadowColor = colStr;
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.arc(beadX, beadY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /**
   * Draw Beam Bundle composed of multiple individual rays.
   * Shows blue rays deflecting out to the sides while red rays pass straight through.
   */
  function drawBundleMode(ctx, bundleResult, chamber, time, isCs, colorimetry, padLeft, cw, padTop, ch) {
    if (!bundleResult || !bundleResult.rays) return;

    ctx.save();
    for (let i = 0; i < bundleResult.rays.length; i++) {
      const ray = bundleResult.rays[i];
      const colStr = wlToColor(ray.wavelengthNm);

      // Draw segments
      for (let s = 0; s < ray.segments.length; s++) {
        const seg = ray.segments[s];
        const isFirst = s === 0;

        ctx.strokeStyle = colStr;
        ctx.globalAlpha = isFirst ? 0.45 : 0.28;
        ctx.lineWidth = isFirst ? 1.8 : 1.2;

        ctx.beginPath();
        ctx.moveTo(seg.x1, seg.y1);
        ctx.lineTo(seg.x2, seg.y2);
        ctx.stroke();
      }

      // Animated photons streaming down each ray
      if (ray.segments.length > 0) {
        const phase = (time * 0.8 + i * 0.08) % 1;
        const seg0 = ray.segments[0];
        const segLen = Math.hypot(seg0.x2 - seg0.x1, seg0.y2 - seg0.y1);
        const px = seg0.x1 + (seg0.x2 - seg0.x1) * phase;
        const py = seg0.y1 + (seg0.y2 - seg0.y1) * phase;

        ctx.fillStyle = colStr;
        ctx.beginPath();
        ctx.arc(px, py, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw collision nodes
      for (const c of ray.collisions) {
        ctx.fillStyle = c.type === 'rayleigh' ? '#5aa9ff' : '#ffd54f';
        ctx.beginPath();
        ctx.arc(c.x, c.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  /**
   * Telemetry overlay badge for Micro view.
   */
  function drawMicroTelemetry(ctx, w, h, isCs, bundleResult, state) {
    ctx.save();
    const isSingle = state.bundleMode === 'single';

    let telemetryText = '';
    if (isSingle) {
      telemetryText = isCs
        ? '💡 Sleduj dráhu 1 paprsku a jeho srážky s molekulami (Rayleigh) a aerosoly (Mie)'
        : '💡 Trace 1 ray path and watch collisions with molecules (Rayleigh) and aerosols (Mie)';
    } else if (bundleResult) {
      const transPct = Math.round(bundleResult.transmittedRatio * 100);
      const scaPct = Math.round(bundleResult.scatterRatio !== undefined ? bundleResult.scatterRatio * 100 : bundleResult.scatteredRatio * 100);
      telemetryText = isCs
        ? `Svazek: Prošlo přímo na detektor: ${transPct}%  |  Rozptýleno do stran (modrá obloha): ${scaPct}%  |  Srážky: ${bundleResult.rayleighHitCount} Rayleigh, ${bundleResult.aerosolHitCount} Mie`
        : `Bundle: Direct transmitted: ${transPct}%  |  Side scattered (blue sky): ${scaPct}%  |  Hits: ${bundleResult.rayleighHitCount} Rayleigh, ${bundleResult.aerosolHitCount} Mie`;
    }

    ctx.fillStyle = 'rgba(15, 20, 32, 0.88)';
    ctx.strokeStyle = '#253046';
    ctx.lineWidth = 1;
    ctx.font = '11px ui-monospace, monospace';
    const textW = ctx.measureText(telemetryText).width;

    const bX = 14;
    const bY = h - 34;
    ctx.beginPath();
    ctx.roundRect(bX, bY, textW + 20, 24, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e0e6f5';
    ctx.textAlign = 'left';
    ctx.fillText(telemetryText, bX + 10, bY + 16);
    ctx.restore();
  }

  /**
   * Helper to convert wavelength in nm to vibrant CSS color string.
   */
  function wlToColor(wavelengthNm) {
    if (wavelengthNm < 420) return '#7c4dff';
    if (wavelengthNm < 450) return '#3d5afe';
    if (wavelengthNm < 480) return '#00b0ff';
    if (wavelengthNm < 510) return '#00e5ff';
    if (wavelengthNm < 540) return '#00e676';
    if (wavelengthNm < 570) return '#aeea00';
    if (wavelengthNm < 600) return '#ffd600';
    if (wavelengthNm < 630) return '#ff6d00';
    if (wavelengthNm < 670) return '#ff3d00';
    return '#d50000';
  }

  /**
   * 2. MACROSCOPIC PLANETARY ATMOSPHERE VIEW.
   */
  function drawMacroView(ctx, w, h) {
    const isCs = i18n.getLanguage() === 'cs';

    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#04060c');
    bgGrad.addColorStop(0.7, '#070b14');
    bgGrad.addColorStop(1, '#0c121e');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    const ox = w * 0.18;
    const oy = h * 0.84;
    const viewR = Math.max(w * 1.5, 1100);
    const planetCenter = { x: ox, y: oy + viewR };
    const atmoThickness = Math.min(h * 0.36, 160);
    const atmoOuterR = viewR + atmoThickness;

    const getGroundY = (x) => {
      const dx = x - planetCenter.x;
      if (Math.abs(dx) >= viewR) return planetCenter.y;
      return planetCenter.y - Math.sqrt(viewR * viewR - dx * dx);
    };

    const elevRad = (state.elevationDeg * Math.PI) / 180;
    const cosE = Math.cos(elevRad);
    const sinE = Math.sin(elevRad);

    const atmoChordLen = Math.sqrt(viewR * viewR * sinE * sinE + 2 * viewR * atmoThickness + atmoThickness * atmoThickness) - viewR * sinE;
    const entryX = ox + atmoChordLen * cosE;
    const entryY = oy - atmoChordLen * sinE;

    const spaceMargin = Math.min(w * 0.20, 100);
    const sunDist = atmoChordLen + spaceMargin;
    const sunX = ox + sunDist * cosE;
    const sunY = oy - sunDist * sinE;

    // Atmosphere Density Glow
    const atmoGrad = ctx.createRadialGradient(
      planetCenter.x, planetCenter.y, viewR,
      planetCenter.x, planetCenter.y, atmoOuterR
    );
    atmoGrad.addColorStop(0, 'rgba(45, 110, 210, 0.42)');
    atmoGrad.addColorStop(0.18, 'rgba(40, 95, 190, 0.28)');
    atmoGrad.addColorStop(0.45, 'rgba(30, 75, 160, 0.14)');
    atmoGrad.addColorStop(0.8, 'rgba(20, 50, 120, 0.04)');
    atmoGrad.addColorStop(1, 'rgba(10, 25, 60, 0.0)');

    ctx.save();
    ctx.beginPath();
    ctx.arc(planetCenter.x, planetCenter.y, atmoOuterR, 0, Math.PI * 2);
    ctx.fillStyle = atmoGrad;
    ctx.fill();

    ctx.strokeStyle = 'rgba(90, 169, 255, 0.12)';
    ctx.setLineDash([3, 6]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(planetCenter.x, planetCenter.y, atmoOuterR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // Planet Ground
    ctx.save();
    ctx.beginPath();
    ctx.arc(planetCenter.x, planetCenter.y, viewR, 0, Math.PI * 2);
    ctx.fillStyle = '#0c1018';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#223045';
    ctx.stroke();
    ctx.restore();

    // Ground Observer
    ctx.save();
    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath();
    ctx.arc(ox, oy, 4, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = '#8b9bb4';
    ctx.textAlign = 'center';
    ctx.fillText(isCs ? 'POZOROVATEL' : 'OBSERVER', ox, oy + 16);
    ctx.restore();

    // Sun Emitter Disk
    ctx.save();
    const sunGrad = ctx.createRadialGradient(sunX, sunY, 2, sunX, sunY, 24);
    sunGrad.addColorStop(0, '#ffffff');
    sunGrad.addColorStop(0.2, '#fff3cc');
    sunGrad.addColorStop(0.6, 'rgba(255, 200, 80, 0.35)');
    sunGrad.addColorStop(1, 'rgba(255, 180, 50, 0)');
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 24, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffd54f';
    ctx.beginPath();
    ctx.arc(sunX, sunY, 9, 0, Math.PI * 2);
    ctx.fill();

    ctx.font = '11px ui-monospace, monospace';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(`${state.elevationDeg.toFixed(1)}°`, sunX, sunY - 14);
    ctx.restore();

    // Straight beam chord from Sun to Observer
    const pts = traceResult.pathPoints;
    const srcSrgb = colorimetry.spectrumToSrgb(pts && pts[0] ? pts[0].spectrum : traceResult.finalSpectrum, 1.2);

    ctx.save();
    ctx.strokeStyle = srcSrgb.css;
    ctx.globalAlpha = 0.40;
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(sunX, sunY);
    ctx.lineTo(entryX, entryY);
    ctx.stroke();

    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(sunX, sunY);
    ctx.lineTo(entryX, entryY);
    ctx.stroke();
    ctx.restore();

    // Atmospheric straight chord
    if (pts && pts.length > 1) {
      const totalL = traceResult.totalChordLengthKm * 1000;
      for (let i = 0; i < pts.length - 1; i++) {
        const p1 = pts[i];
        const p2 = pts[i + 1];

        const frac1 = p1.sFromEntry / totalL;
        const frac2 = p2.sFromEntry / totalL;

        const x1 = entryX + (ox - entryX) * frac1;
        const y1 = entryY + (oy - entryY) * frac1;
        const x2 = entryX + (ox - entryX) * frac2;
        const y2 = entryY + (oy - entryY) * frac2;

        const srgb = colorimetry.spectrumToSrgb(p1.spectrum, 1.2);
        const alpha = Math.max(0.15, Math.min(1.0, p1.normalizedIntensity * 1.3));

        ctx.save();
        ctx.strokeStyle = srgb.css;
        ctx.globalAlpha = alpha * 0.45;
        ctx.lineWidth = 7;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        ctx.globalAlpha = Math.min(1.0, alpha * 0.95);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }

      // Scattering events diverted away
      const events = traceResult.scatteringEvents;
      if (events) {
        const beamAngle = Math.atan2(oy - entryY, ox - entryX);
        for (let k = 0; k < events.length; k++) {
          const ev = events[k];
          const frac = Math.max(0, Math.min(1, ev.distanceM / totalL));
          const ex = entryX + (ox - entryX) * frac;
          const ey = entryY + (oy - entryY) * frac;

          const isRayleigh = ev.type === 'rayleigh';
          const dotCol = isRayleigh ? '#5aa9ff' : '#ffe082';

          ctx.save();
          ctx.fillStyle = dotCol;
          ctx.beginPath();
          ctx.arc(ex, ey, isRayleigh ? 2.5 : 3.5, 0, Math.PI * 2);
          ctx.fill();

          const scAngleRad = (ev.scatterAngleDeg * Math.PI) / 180;
          let divAngle = beamAngle - Math.abs(scAngleRad * 0.8);
          const rayLen = isRayleigh ? 36 : 48;
          let endX = ex + Math.cos(divAngle) * rayLen;
          let endY = ey + Math.sin(divAngle) * rayLen;

          const gy = getGroundY(endX);
          if (endY > gy) endY = gy;

          const daughterGrad = ctx.createLinearGradient(ex, ey, endX, endY);
          daughterGrad.addColorStop(0, dotCol);
          daughterGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

          ctx.strokeStyle = daughterGrad;
          ctx.lineWidth = isRayleigh ? 1.3 : 1.9;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(endX, endY);
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // Ground spot
    const finalSRGB = colorimetry.spectrumToSrgb(traceResult.finalSpectrum, 1.4);
    ctx.save();
    const spotGrad = ctx.createRadialGradient(ox, oy - 2, 2, ox, oy - 2, 18);
    spotGrad.addColorStop(0, finalSRGB.css);
    spotGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = spotGrad;
    ctx.beginPath();
    ctx.arc(ox, oy - 2, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Loupe inset
    drawLoupe(ctx, w, h);

    // Macro badge
    drawMacroBadges(ctx, w, h, isCs);
  }

  function drawMacroBadges(ctx, w, h, isCs) {
    ctx.save();
    ctx.fillStyle = 'rgba(15, 19, 29, 0.85)';
    ctx.strokeStyle = '#242c3d';
    ctx.lineWidth = 1;

    const chordText = `${isCs ? 'Délka cesty' : 'Path length'}: ${traceResult.totalChordLengthKm.toFixed(0)} km  |  ${isCs ? 'Vzdušná hmota' : 'Airmass'}: ${traceResult.airmass.toFixed(1)}×`;
    ctx.font = '12px ui-monospace, monospace';
    const textW = ctx.measureText(chordText).width;

    ctx.beginPath();
    ctx.roundRect(14, 56, textW + 20, 26, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e8ecf5';
    ctx.fillText(chordText, 24, 73);
    ctx.restore();
  }

  function drawLoupe(ctx, w, h) {
    const isCs = i18n.getLanguage() === 'cs';
    const lx = w - 125;
    const ly = h - 125;
    const lr = 54;

    ctx.save();
    ctx.beginPath();
    ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.fillStyle = '#0f1422';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = state.loupeMode === 'rayleigh' ? '#5aa9ff' : '#ffb454';
    ctx.stroke();

    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#9aa5bb';
    ctx.textAlign = 'center';
    const title = state.loupeMode === 'rayleigh'
      ? (isCs ? 'Molekula (Rayleigh)' : 'Molecule (Rayleigh)')
      : (isCs ? 'Aerosol / Kapka (Mie)' : 'Aerosol Drop (Mie)');
    ctx.fillText(title, lx, ly - lr - 6);

    ctx.fillStyle = '#6b7488';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(isCs ? '(kliknutím přepni)' : '(click to toggle)', lx, ly + lr + 14);

    if (state.loupeMode === 'rayleigh') {
      const osc = Math.sin(animTime * 6) * 6;
      ctx.strokeStyle = 'rgba(90, 169, 255, 0.35)';
      ctx.lineWidth = 1.2;
      for (let r = 10; r <= 38; r += 12) {
        const wr = (r + (animTime * 24) % 12);
        ctx.beginPath();
        ctx.ellipse(lx, ly, wr, wr * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.arc(lx, ly - osc * 0.4, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#5aa9ff';
      ctx.beginPath();
      ctx.arc(lx, ly + osc * 0.8, 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(140, 190, 230, 0.25)';
      ctx.strokeStyle = 'rgba(200, 230, 255, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(lx, ly, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // Initial calculation and draw
  recompute();
  draw();

  return {
    update,
    draw,
    resize,
    getTraceResult: () => traceResult,
    getMicroBundleResult: () => microBundleResult,
  };
}

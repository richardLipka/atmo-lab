/**
 * Interactive Single Beam Canvas Renderer.
 *
 * Visualizes:
 *   - The curvature of the Earth and the exponential atmospheric density layers.
 *   - An interactive celestial dome with an adjustable Sun / beam emitter handle.
 *   - The traced beam path descending through the air, with its core color evolving
 *     according to true spectral transmission (e.g. turning crimson at sunset).
 *   - Discrete molecular (Rayleigh) and aerosol (Mie) scattering collisions,
 *     with daughter rays radiating outwards into the sky or towards the ground.
 *   - The ground observer receiving the surviving direct beam.
 *   - An interactive Micro-Optics Inset / Loupe illustrating the microscopic
 *     dipole radiation of a gas molecule vs. the reflection/refraction of an aerosol droplet.
 */

import {
  EARTH_RADIUS_M, TOA_ALTITUDE_M, traceSingleBeam,
} from '../physics/beam-tracer.js';

export function createBeamCanvas(canvas, { i18n, colorimetry, onElevationChange }) {
  const ctx = canvas.getContext('2d', { alpha: false });

  let state = {
    elevationDeg: 25,
    mode: 'sunlight',
    wavelengthNm: 532,
    densityScale: 1,
    rayleighExponent: 4,
    aerosolScale: 1,
    enableRefraction: true,
    refractionFactor: 15, // visually legible curvature
    animate: true,
    loupeMode: 'rayleigh', // 'rayleigh' | 'mie'
  };

  let traceResult = null;
  let animTime = 0;
  let isDraggingSun = false;

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

  // Pointer interaction for dragging the Sun/Emitter
  function getPointerElevation(e) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // Observer is located near bottom-center: (cx, cy)
    const cx = rect.width * 0.28;
    const cy = rect.height * 0.82;

    const dx = px - cx;
    const dy = cy - py; // positive upwards
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

    // Check if clicking inside the loupe to toggle mode
    const loupeX = rect.width - 130;
    const loupeY = rect.height - 130;
    const distToLoupe = Math.hypot(px - loupeX, py - loupeY);
    if (distToLoupe <= 60) {
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
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!isDraggingSun) return;
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

  // Animation ticker for photon pulses and dipole wavelets
  function tick(timestamp) {
    animTime = timestamp * 0.001;
    if (state.animate) {
      draw();
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function draw() {
    const { w, h } = resize();
    if (!traceResult) recompute();

    // 1. Deep Space Background
    const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
    bgGrad.addColorStop(0, '#04060c');
    bgGrad.addColorStop(0.7, '#070b14');
    bgGrad.addColorStop(1, '#0c121e');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Coordinate mapping:
    // Observer is near bottom-left: (ox, oy)
    const ox = w * 0.22;
    const oy = h * 0.82;

    // Ground radius on screen (scaled to show spherical curvature)
    const viewR = Math.max(w * 1.4, 900);
    const planetCenter = { x: ox, y: oy + viewR };

    // Atmosphere visual thickness
    const atmoThickness = Math.min(h * 0.55, 230);
    const atmoOuterR = viewR + atmoThickness;

    // 2. Atmosphere Density Glow (Exponential layers)
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
    ctx.restore();

    // 3. Ground / Planet Surface
    ctx.save();
    ctx.beginPath();
    ctx.arc(planetCenter.x, planetCenter.y, viewR, 0, Math.PI * 2);
    const groundGrad = ctx.createLinearGradient(0, oy, 0, h);
    groundGrad.addColorStop(0, '#19202f');
    groundGrad.addColorStop(0.2, '#121722');
    groundGrad.addColorStop(1, '#090c13');
    ctx.fillStyle = groundGrad;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = '#32405a';
    ctx.stroke();
    ctx.restore();

    // 4. Observer Station & Eye Marker
    ctx.save();
    ctx.fillStyle = '#ffb454';
    ctx.beginPath();
    ctx.arc(ox, oy - 2, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#e8ecf5';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText('👁️ ' + (i18n.getLanguage() === 'cs' ? 'Pozorovatel' : 'Observer'), ox - 28, oy + 18);
    ctx.restore();

    // 5. Celestial Arc & Sun Emitter Handle
    const domeR = Math.min(w * 0.68, h * 0.72);
    ctx.save();
    ctx.beginPath();
    ctx.arc(ox, oy, domeR, -Math.PI * 0.5, 0);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

    // Sun Emitter Position
    const elevRad = (state.elevationDeg * Math.PI) / 180;
    const sunX = ox + domeR * Math.cos(elevRad);
    const sunY = oy - domeR * Math.sin(elevRad);

    // Glowing Sun Disc
    const sunGrad = ctx.createRadialGradient(sunX, sunY, 2, sunX, sunY, 22);
    sunGrad.addColorStop(0, '#ffffff');
    sunGrad.addColorStop(0.25, '#ffe082');
    sunGrad.addColorStop(0.6, 'rgba(255, 180, 50, 0.4)');
    sunGrad.addColorStop(1, 'rgba(255, 140, 0, 0)');
    ctx.fillStyle = sunGrad;
    ctx.beginPath();
    ctx.arc(sunX, sunY, 22, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(sunX, sunY, 7, 0, Math.PI * 2);
    ctx.fill();

    // Elevation label
    ctx.fillStyle = '#ffb454';
    ctx.font = 'bold 12px ui-monospace, monospace';
    const elevText = `${state.elevationDeg.toFixed(1)}°`;
    ctx.fillText(elevText, sunX + 14, sunY - 8);
    ctx.restore();

    // 6. Project Beam Path from Emitter to Observer
    const pts = traceResult.pathPoints;
    if (pts && pts.length > 1) {
      // Screen projection: map normalized (sFromEntry / L) and altitude to canvas coords
      const totalL = traceResult.totalChordLengthKm * 1000;

      const screenPoints = pts.map((p) => {
        const t = Math.max(0, Math.min(1, p.sFromEntry / totalL));
        // Linear chord from Sun to Observer
        let sx = sunX + (ox - sunX) * t;
        let sy = sunY + (oy - sunY) * t;

        // Downward curvature if refraction enabled
        if (state.enableRefraction) {
          const bendCurve = Math.sin(t * Math.PI) * (traceResult.deflectionArcmin / 60) * 12;
          sy += bendCurve;
        }

        return { x: sx, y: sy, p };
      });

      // Draw Beam Glow & Core
      for (let i = 0; i < screenPoints.length - 1; i++) {
        const p1 = screenPoints[i];
        const p2 = screenPoints[i + 1];

        // Color of beam at this point from physical spectrum
        const srgb = colorimetry.spectrumToSRGB(p1.p.spectrum, 1.2);
        const colStr = `rgb(${srgb[0]}, ${srgb[1]}, ${srgb[2]})`;

        // Intensity falloff
        const alpha = Math.max(0.15, Math.min(1.0, p1.p.normalizedIntensity * 1.3));

        // Outer glow
        ctx.save();
        ctx.strokeStyle = colStr;
        ctx.globalAlpha = alpha * 0.45;
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();

        // Inner core
        ctx.globalAlpha = Math.min(1.0, alpha * 0.95);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
        ctx.restore();
      }

      // Animated Photons along the beam
      if (state.animate) {
        ctx.save();
        const photonCount = 7;
        for (let j = 0; j < photonCount; j++) {
          const phase = ((animTime * 0.45 + j / photonCount) % 1);
          const idx = Math.floor(phase * (screenPoints.length - 1));
          const pt = screenPoints[idx];
          if (pt) {
            const srgb = colorimetry.spectrumToSRGB(pt.p.spectrum, 1.8);
            ctx.fillStyle = `rgb(${srgb[0]}, ${srgb[1]}, ${srgb[2]})`;
            ctx.shadowColor = ctx.fillStyle;
            ctx.shadowBlur = 8;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // 7. Scattering Events & Daughter Rays
      const events = traceResult.scatteringEvents;
      if (events) {
        for (const ev of events) {
          const t = Math.max(0, Math.min(1, ev.distanceM / totalL));
          const ex = sunX + (ox - sunX) * t;
          let ey = sunY + (oy - sunY) * t;
          if (state.enableRefraction) {
            ey += Math.sin(t * Math.PI) * (traceResult.deflectionArcmin / 60) * 12;
          }

          const isRayleigh = ev.type === 'rayleigh';
          const dotCol = isRayleigh ? '#5aa9ff' : '#ffe082';

          // Collision Node
          ctx.save();
          ctx.fillStyle = dotCol;
          ctx.beginPath();
          ctx.arc(ex, ey, isRayleigh ? 2.5 : 3.5, 0, Math.PI * 2);
          ctx.fill();

          // Emitted daughter ray
          const rayLen = isRayleigh ? 32 : 46;
          const endX = ex + ev.outDirectionX * rayLen;
          const endY = ey - ev.outDirectionY * rayLen; // screen Y inverted

          const daughterGrad = ctx.createLinearGradient(ex, ey, endX, endY);
          daughterGrad.addColorStop(0, dotCol);
          daughterGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

          ctx.strokeStyle = daughterGrad;
          ctx.lineWidth = isRayleigh ? 1.2 : 1.8;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(endX, endY);
          ctx.stroke();

          // Wave pulse on daughter ray if animated
          if (state.animate && isRayleigh) {
            const wavePhase = (animTime * 1.5 + ev.distanceM * 0.0001) % 1;
            const waveX = ex + ev.outDirectionX * rayLen * wavePhase;
            const waveY = ey - ev.outDirectionY * rayLen * wavePhase;
            ctx.fillStyle = 'rgba(120, 190, 255, 0.6)';
            ctx.beginPath();
            ctx.arc(waveX, waveY, 1.8, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }
    }

    // 8. Ground Received Light Spot
    ctx.save();
    const finalSRGB = colorimetry.spectrumToSRGB(traceResult.finalSpectrum, 1.4);
    const finalCol = `rgb(${finalSRGB[0]}, ${finalSRGB[1]}, ${finalSRGB[2]})`;
    const spotGrad = ctx.createRadialGradient(ox, oy - 2, 2, ox, oy - 2, 18);
    spotGrad.addColorStop(0, finalCol);
    spotGrad.addColorStop(0.5, finalCol);
    spotGrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = spotGrad;
    ctx.beginPath();
    ctx.arc(ox, oy - 2, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 9. Interactive Collision Micro-View (Loupe Inset in Bottom-Right Corner)
    drawLoupe(ctx, w, h);

    // 10. Top Informational Badges
    drawBadges(ctx, w, h);
  }

  function drawBadges(ctx, w, h) {
    const isCs = i18n.getLanguage() === 'cs';
    ctx.save();
    ctx.fillStyle = 'rgba(15, 19, 29, 0.85)';
    ctx.strokeStyle = '#242c3d';
    ctx.lineWidth = 1;

    // Chord badge
    const chordText = `${isCs ? 'Délka cesty' : 'Path length'}: ${traceResult.totalChordLengthKm.toFixed(0)} km  |  ${isCs ? 'Vzdušná hmota' : 'Airmass'}: ${traceResult.airmass.toFixed(1)}×`;
    ctx.font = '12px ui-monospace, monospace';
    const textW = ctx.measureText(chordText).width;

    ctx.beginPath();
    ctx.roundRect(14, 14, textW + 20, 28, 6);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#e8ecf5';
    ctx.fillText(chordText, 24, 32);

    // Hint to drag sun
    const hintText = isCs ? '💡 Přetažením Slunce měň výšku nad obzorem' : '💡 Drag Sun to change elevation angle';
    ctx.fillStyle = 'rgba(232, 236, 245, 0.6)';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(hintText, 16, 60);
    ctx.restore();
  }

  function drawLoupe(ctx, w, h) {
    const isCs = i18n.getLanguage() === 'cs';
    const lx = w - 125;
    const ly = h - 125;
    const lr = 54;

    ctx.save();
    // Glass circle
    ctx.beginPath();
    ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.fillStyle = '#0f1422';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = state.loupeMode === 'rayleigh' ? '#5aa9ff' : '#ffb454';
    ctx.stroke();

    // Title
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#9aa5bb';
    ctx.textAlign = 'center';
    const title = state.loupeMode === 'rayleigh'
      ? (isCs ? 'Molekula (Rayleigh)' : 'Molecule (Rayleigh)')
      : (isCs ? 'Aerosol / Kapka (Mie)' : 'Aerosol Drop (Mie)');
    ctx.fillText(title, lx, ly - lr - 6);

    // Subtitle toggle hint
    ctx.fillStyle = '#6b7488';
    ctx.font = '9px system-ui, sans-serif';
    ctx.fillText(isCs ? '(kliknutím přepni)' : '(click to toggle)', lx, ly + lr + 14);

    // Inside Loupe: animated physics
    if (state.loupeMode === 'rayleigh') {
      // Rayleigh Dipole: central molecule with oscillating dipole field
      const osc = Math.sin(animTime * 6) * 6;

      // Dipole field wavelets
      ctx.strokeStyle = 'rgba(90, 169, 255, 0.35)';
      ctx.lineWidth = 1.2;
      for (let r = 10; r <= 38; r += 12) {
        const wr = (r + (animTime * 24) % 12);
        ctx.beginPath();
        ctx.ellipse(lx, ly, wr, wr * 0.6, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Nucleus & Electron cloud
      ctx.fillStyle = '#ff6b6b';
      ctx.beginPath();
      ctx.arc(lx, ly - osc * 0.4, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = '#5aa9ff';
      ctx.beginPath();
      ctx.arc(lx, ly + osc * 0.8, 3, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Aerosol droplet: spherical drop with refraction and forward diffraction lobe
      ctx.fillStyle = 'rgba(140, 190, 230, 0.25)';
      ctx.strokeStyle = 'rgba(200, 230, 255, 0.7)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(lx, ly, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      // Incoming ray and internal reflection
      ctx.strokeStyle = '#ffe082';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(lx - 42, ly - 8);
      ctx.lineTo(lx - 20, ly - 8); // enter drop
      ctx.lineTo(lx + 8, ly + 4);  // refract inside
      ctx.lineTo(lx + 44, ly + 2); // forward exit
      ctx.stroke();

      // Forward diffraction cone
      ctx.fillStyle = 'rgba(255, 224, 130, 0.15)';
      ctx.beginPath();
      ctx.moveTo(lx + 22, ly);
      ctx.lineTo(lx + 48, ly - 16);
      ctx.lineTo(lx + 48, ly + 16);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  return {
    resize,
    update,
    draw,
    getTraceResult: () => traceResult,
  };
}

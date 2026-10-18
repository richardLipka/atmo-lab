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

    const cx = rect.width * 0.18;
    const cy = rect.height * 0.84;

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
    // Observer is anchored on the ground on the left: (ox, oy)
    const ox = w * 0.18;
    const oy = h * 0.84;

    // Ground radius on screen (scaled to show spherical curvature)
    const viewR = Math.max(w * 1.5, 1100);
    const planetCenter = { x: ox, y: oy + viewR };

    // Atmosphere visual thickness
    const atmoThickness = Math.min(h * 0.36, 160);
    const atmoOuterR = viewR + atmoThickness;

    // Helper to get ground surface height at any screen x
    const getGroundY = (x) => {
      const dx = x - planetCenter.x;
      if (Math.abs(dx) >= viewR) return planetCenter.y;
      return planetCenter.y - Math.sqrt(viewR * viewR - dx * dx);
    };

    // Sun angle and trigonometry
    const elevRad = (state.elevationDeg * Math.PI) / 180;
    const cosE = Math.cos(elevRad);
    const sinE = Math.sin(elevRad);

    // Exact geometric chord distance from observer along line of sight to top of atmosphere
    const atmoChordLen = Math.sqrt(viewR * viewR * sinE * sinE + 2 * viewR * atmoThickness + atmoThickness * atmoThickness) - viewR * sinE;

    // Atmospheric entry point on screen (where ray enters from space)
    const entryX = ox + atmoChordLen * cosE;
    const entryY = oy - atmoChordLen * sinE;

    // Sun Emitter position in space beyond atmosphere
    const spaceMargin = Math.min(w * 0.20, 100);
    const sunDist = atmoChordLen + spaceMargin;
    const sunX = ox + sunDist * cosE;
    const sunY = oy - sunDist * sinE;

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

    // Subtle Karman line / top of atmosphere boundary
    ctx.strokeStyle = 'rgba(90, 169, 255, 0.12)';
    ctx.setLineDash([3, 6]);
    ctx.lineWidth = 1;
    ctx.stroke();
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
    ctx.save();
    ctx.beginPath();
    ctx.arc(ox, oy, sunDist, -Math.PI * 0.5, 0);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
    ctx.setLineDash([4, 6]);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);

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

    // Apparent Sun indicator if refraction is enabled
    if (state.enableRefraction && traceResult.deflectionArcmin > 0.5) {
      const deflDeg = Math.min(2.5, traceResult.deflectionArcmin / 60);
      const appElevRad = ((state.elevationDeg + deflDeg) * Math.PI) / 180;
      const appSunX = ox + sunDist * Math.cos(appElevRad);
      const appSunY = oy - sunDist * Math.sin(appElevRad);
      ctx.strokeStyle = 'rgba(255, 224, 130, 0.45)';
      ctx.setLineDash([3, 4]);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(appSunX, appSunY, 12, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.font = '10px ui-monospace, monospace';
      ctx.fillStyle = 'rgba(255, 224, 130, 0.75)';
      ctx.fillText(`+${traceResult.deflectionArcmin.toFixed(1)}'`, appSunX + 14, appSunY + 3);
    }
    ctx.restore();

    // 6. Expected Straight Line (Reference Guide from Sun to Observer)
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sunX, sunY);
    ctx.lineTo(ox, oy);
    ctx.stroke();
    ctx.restore();

    // Atmosphere Entry Marker
    ctx.save();
    ctx.strokeStyle = 'rgba(90, 169, 255, 0.5)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(entryX, entryY, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // Vacuum Segment: From Sun Emitter to Atmosphere Entry (Straight Line)
    const pts = traceResult.pathPoints;
    const srcSrgb = colorimetry.spectrumToSrgb(pts && pts[0] ? pts[0].spectrum : traceResult.finalSpectrum, 1.2);
    ctx.save();
    ctx.strokeStyle = srcSrgb.css;
    ctx.globalAlpha = 0.40;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
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

    // Atmospheric Segment: From Entry to Observer (Straight Line)
    if (pts && pts.length > 1) {
      const totalL = traceResult.totalChordLengthKm * 1000;

      // Draw Beam Glow & Core along the straight chord
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
        const colStr = srgb.css;
        const alpha = Math.max(0.15, Math.min(1.0, p1.normalizedIntensity * 1.3));

        // Outer glow
        ctx.save();
        ctx.strokeStyle = colStr;
        ctx.globalAlpha = alpha * 0.45;
        ctx.lineWidth = 7;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        // Inner core
        ctx.globalAlpha = Math.min(1.0, alpha * 0.95);
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
      }

      // Animated Photons streaming down the straight beam
      if (state.animate) {
        ctx.save();
        const photonCount = 8;
        const entryFrac = spaceMargin / sunDist;
        for (let j = 0; j < photonCount; j++) {
          const phase = ((animTime * 0.45 + j / photonCount) % 1);
          const px = sunX + (ox - sunX) * phase;
          const py = sunY + (oy - sunY) * phase;

          let spec = pts[0].spectrum;
          if (phase >= entryFrac) {
            const atmoPhase = (phase - entryFrac) / (1 - entryFrac);
            const idx = Math.min(pts.length - 1, Math.floor(atmoPhase * pts.length));
            spec = pts[idx].spectrum;
          }
          const srgb = colorimetry.spectrumToSrgb(spec, 1.8);
          ctx.fillStyle = srgb.css;
          ctx.shadowColor = srgb.css;
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.arc(px, py, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // 7. Scattering Events: Diverting Parts of the Beam Away into the Sky
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

          // Collision Node on the straight beam
          ctx.save();
          ctx.fillStyle = dotCol;
          ctx.shadowColor = dotCol;
          ctx.shadowBlur = 6;
          ctx.beginPath();
          ctx.arc(ex, ey, isRayleigh ? 2.5 : 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          // Emitted daughter ray radiating AWAY into the sky
          const scAngleRad = (ev.scatterAngleDeg * Math.PI) / 180;
          const side = (k % 2 === 0) ? 1 : -1;
          let divAngle = beamAngle + side * Math.max(0.35, scAngleRad * 0.8);
          // Ensure scattered rays radiate upwards into the open atmosphere rather than underground
          if (Math.sin(divAngle) > 0) {
            divAngle = beamAngle - Math.abs(scAngleRad * 0.8);
          }

          const rayLen = isRayleigh ? 36 : 48;
          let endX = ex + Math.cos(divAngle) * rayLen;
          let endY = ey + Math.sin(divAngle) * rayLen;

          // Ground surface clipping: never penetrate rock
          const gy = getGroundY(endX);
          if (endY > gy) endY = gy;

          const daughterGrad = ctx.createLinearGradient(ex, ey, endX, endY);
          daughterGrad.addColorStop(0, dotCol);
          daughterGrad.addColorStop(1, 'rgba(255, 255, 255, 0)');

          ctx.save();
          ctx.strokeStyle = daughterGrad;
          ctx.lineWidth = isRayleigh ? 1.3 : 1.9;
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(endX, endY);
          ctx.stroke();

          // Animated branching photons diverted away into the sky
          if (state.animate) {
            const wavePhase = (animTime * 1.5 + k * 0.22) % 1;
            const wx = ex + (endX - ex) * wavePhase;
            const wy = ey + (endY - ey) * wavePhase;
            ctx.fillStyle = dotCol;
            ctx.shadowColor = dotCol;
            ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.arc(wx, wy, isRayleigh ? 1.8 : 2.2, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.restore();
        }
      }
    }

    // 8. Ground Received Light Spot
    ctx.save();
    const finalSRGB = colorimetry.spectrumToSrgb(traceResult.finalSpectrum, 1.4);
    const finalCol = finalSRGB.css;
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

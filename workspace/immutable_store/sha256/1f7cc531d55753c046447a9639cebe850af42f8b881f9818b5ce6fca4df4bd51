import type {
  GlassName,
  MtfPoint,
  OpticalSurface,
  OpticalSystemSpec,
  RayTraceResult,
  SpotPoint,
  TracedRayPoint,
} from './types.ts';

interface SellmeierCoeff {
  B1: number;
  B2: number;
  B3: number;
  C1: number;
  C2: number;
  C3: number;
}

const SELLMEIER_CATALOG: Record<Exclude<GlassName, 'AIR'>, SellmeierCoeff> = {
  // Schott N-BK7
  'N-BK7': {
    B1: 1.03961212,
    B2: 0.231792344,
    B3: 1.01046945,
    C1: 0.00600069867,
    C2: 0.0200179144,
    C3: 103.560653,
  },
  // Schott N-SF11 (high-index flint)
  'N-SF11': {
    B1: 1.73759695,
    B2: 0.313747346,
    B3: 1.89878101,
    C1: 0.013188707,
    C2: 0.0623068142,
    C3: 155.23629,
  },
  // Schott N-F2
  'N-F2': {
    B1: 1.39757037,
    B2: 0.159201403,
    B3: 1.2686543,
    C1: 0.00995906143,
    C2: 0.0546931752,
    C3: 119.248346,
  },
  // Fused Silica
  FUSED_SILICA: {
    B1: 0.6961663,
    B2: 0.4079426,
    B3: 0.8974794,
    C1: 0.00467914826,
    C2: 0.0135120631,
    C3: 97.9340025,
  },
  // Schott N-LAK9
  'N-LAK9': {
    B1: 1.46231905,
    B2: 0.344399589,
    B3: 1.15508372,
    C1: 0.00724270156,
    C2: 0.0243353131,
    C3: 85.4686868,
  },
};

export function refractiveIndex(glass: GlassName, wavelengthNm: number): number {
  if (glass === 'AIR') {
    return 1.000277;
  }
  const coeff = SELLMEIER_CATALOG[glass];
  const lamUm = wavelengthNm / 1000;
  const l2 = lamUm * lamUm;
  const n2Minus1 =
    (coeff.B1 * l2) / (l2 - coeff.C1) +
    (coeff.B2 * l2) / (l2 - coeff.C2) +
    (coeff.B3 * l2) / (l2 - coeff.C3);
  return Math.sqrt(1 + Math.max(0, n2Minus1));
}

export function computeSurfaceVerticesZ(surfaces: OpticalSurface[]): number[] {
  const vertices: number[] = [];
  let z = 0;
  for (let i = 0; i < surfaces.length; i++) {
    vertices.push(z);
    z += surfaces[i].thicknessMm;
  }
  return vertices;
}

/**
 * Exact paraxial ray trace (marginal-slope linearity) for EFL and BFL at given wavelength.
 */
export function computeParaxialProperties(
  surfaces: OpticalSurface[],
  wavelengthNm: number,
  entrancePupilDiameterMm: number,
): { eflMm: number; bflMm: number; fNumber: number; totalTrackMm: number } {
  let y = 1.0; // unit height incoming parallel ray
  let nu = 0.0; // optical slope n * u = 0
  let nBefore = 1.000277;
  let totalThickness = 0;

  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i];
    const nAfter = refractiveIndex(s.glassAfter, wavelengthNm);
    const power = s.radiusMm !== null && Math.abs(s.radiusMm) > 1e-6 ? (nAfter - nBefore) / s.radiusMm : 0;
    nu = nu - y * power;
    const uAfter = nu / nAfter;

    if (i < surfaces.length - 1) {
      y = y + s.thicknessMm * uAfter;
      totalThickness += s.thicknessMm;
    }
    nBefore = nAfter;
  }

  const finalN = nBefore;
  const finalU = nu / finalN;
  const eflMm = Math.abs(finalU) > 1e-9 ? -1.0 / finalU : 1e6;
  const bflMm = Math.abs(finalU) > 1e-9 ? -y / finalU : 1e6;
  const fNumber = Math.abs(eflMm) / Math.max(0.1, entrancePupilDiameterMm);

  return {
    eflMm,
    bflMm,
    fNumber,
    totalTrackMm: totalThickness,
  };
}

interface Ray3DResult {
  points: Array<{ z: number; y: number; x: number }>;
  hitImageX: number;
  hitImageY: number;
  clipped: boolean;
  tir: boolean;
}

function traceSingle3DRay(
  surfaces: OpticalSurface[],
  verticesZ: number[],
  imagePlaneZ: number,
  wavelengthNm: number,
  startX: number,
  startY: number,
  startZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
): Ray3DResult {
  let rx = startX;
  let ry = startY;
  let rz = startZ;
  let kx = dirX;
  let ky = dirY;
  let kz = dirZ;
  let n1 = 1.000277;

  const points: Array<{ z: number; y: number; x: number }> = [{ x: rx, y: ry, z: rz }];

  for (let i = 0; i < surfaces.length; i++) {
    const s = surfaces[i];
    const zv = verticesZ[i];
    const n2 = refractiveIndex(s.glassAfter, wavelengthNm);

    let hitX = 0;
    let hitY = 0;
    let hitZ = 0;
    let nx = 0;
    let ny = 0;
    let nz = -1;

    if (s.radiusMm === null || Math.abs(s.radiusMm) > 1e7) {
      // Planar surface z = zv
      if (Math.abs(kz) < 1e-9) {
        return { points, hitImageX: NaN, hitImageY: NaN, clipped: true, tir: false };
      }
      const t = (zv - rz) / kz;
      if (t <= 0) {
        return { points, hitImageX: NaN, hitImageY: NaN, clipped: true, tir: false };
      }
      hitX = rx + t * kx;
      hitY = ry + t * ky;
      hitZ = zv;
      nx = 0;
      ny = 0;
      nz = -1;
    } else {
      // Spherical surface with center C = (0, 0, zv + R)
      const R = s.radiusMm;
      const cz = zv + R;
      const ox = rx;
      const oy = ry;
      const oz = rz - cz;

      // |O + t*K|^2 = R^2 => t^2 + 2*(O.K)*t + (|O|^2 - R^2) = 0
      const b = ox * kx + oy * ky + oz * kz;
      const c = ox * ox + oy * oy + oz * oz - R * R;
      const disc = b * b - c;
      if (disc < 0) {
        return { points, hitImageX: NaN, hitImageY: NaN, clipped: true, tir: false };
      }
      const sqrtDisc = Math.sqrt(disc);
      // Select intersection closest to vertex zv (R > 0 -> front cap z < cz; R < 0 -> back cap z > cz)
      const t1 = -b - sqrtDisc;
      const t2 = -b + sqrtDisc;
      const candidate1Z = rz + t1 * kz;
      const candidate2Z = rz + t2 * kz;

      let t = NaN;
      if (R > 0) {
        const d1 = t1 > 0 ? Math.abs(candidate1Z - zv) : Infinity;
        const d2 = t2 > 0 ? Math.abs(candidate2Z - zv) : Infinity;
        t = d1 <= d2 ? t1 : t2;
      } else {
        const d1 = t1 > 0 ? Math.abs(candidate1Z - zv) : Infinity;
        const d2 = t2 > 0 ? Math.abs(candidate2Z - zv) : Infinity;
        t = d1 <= d2 ? t1 : t2;
      }
      if (!Number.isFinite(t) || t <= 0) {
        return { points, hitImageX: NaN, hitImageY: NaN, clipped: true, tir: false };
      }

      hitX = rx + t * kx;
      hitY = ry + t * ky;
      hitZ = rz + t * kz;

      // Normal pointing from hit point toward center or away depending on sign of R so n.k < 0
      const rawNx = (hitX - 0) / R;
      const rawNy = (hitY - 0) / R;
      const rawNz = (hitZ - cz) / R;
      // Ensure normal opposes incoming ray direction k (dot(n, k) < 0)
      const dotCheck = rawNx * kx + rawNy * ky + rawNz * kz;
      if (dotCheck > 0) {
        nx = -rawNx;
        ny = -rawNy;
        nz = -rawNz;
      } else {
        nx = rawNx;
        ny = rawNy;
        nz = rawNz;
      }
    }

    const rHit = Math.hypot(hitX, hitY);
    points.push({ x: hitX, y: hitY, z: hitZ });
    if (rHit > s.semiApertureMm + 1e-6) {
      return { points, hitImageX: NaN, hitImageY: NaN, clipped: true, tir: false };
    }

    // Exact 3D vector Snell's Law:
    // cosI = -dot(n, k)
    const cosI = -(nx * kx + ny * ky + nz * kz);
    const mu = n1 / n2;
    const sin2T = mu * mu * (1 - cosI * cosI);
    if (sin2T >= 1.0) {
      return { points, hitImageX: NaN, hitImageY: NaN, clipped: false, tir: true };
    }
    const cosT = Math.sqrt(1 - sin2T);
    const factor = mu * cosI - cosT;
    let newKx = mu * kx + factor * nx;
    let newKy = mu * ky + factor * ny;
    let newKz = mu * kz + factor * nz;
    const norm = Math.hypot(newKx, newKy, newKz);
    newKx /= norm;
    newKy /= norm;
    newKz /= norm;

    rx = hitX;
    ry = hitY;
    rz = hitZ;
    kx = newKx;
    ky = newKy;
    kz = newKz;
    n1 = n2;
  }

  // Propagate to image plane z = imagePlaneZ
  if (Math.abs(kz) < 1e-9) {
    return { points, hitImageX: NaN, hitImageY: NaN, clipped: true, tir: false };
  }
  const tImg = (imagePlaneZ - rz) / kz;
  const hitImageX = rx + tImg * kx;
  const hitImageY = ry + tImg * ky;
  points.push({ x: hitImageX, y: hitImageY, z: imagePlaneZ });

  return {
    points,
    hitImageX,
    hitImageY,
    clipped: false,
    tir: false,
  };
}

function buildCircularPupilSamples(rings = 4): Array<{ px: number; py: number }> {
  const samples: Array<{ px: number; py: number }> = [{ px: 0, py: 0 }];
  for (let rIdx = 1; rIdx <= rings; rIdx++) {
    const r = rIdx / rings;
    const count = 6 * rIdx;
    for (let k = 0; k < count; k++) {
      const theta = (2 * Math.PI * k) / count;
      samples.push({ px: r * Math.cos(theta), py: r * Math.sin(theta) });
    }
  }
  return samples;
}

export function traceOpticalSystem(spec: OpticalSystemSpec): RayTraceResult {
  const dWavelength = spec.wavelengthsNm.includes(587.56)
    ? 587.56
    : spec.wavelengthsNm[Math.floor(spec.wavelengthsNm.length / 2)] ?? 587.56;

  const verticesZ = computeSurfaceVerticesZ(spec.surfaces);
  const lastSurfaceZ = verticesZ[verticesZ.length - 1] ?? 0;

  const paraxialD = computeParaxialProperties(spec.surfaces, dWavelength, spec.entrancePupilDiameterMm);
  const paraxialF = computeParaxialProperties(spec.surfaces, 486.13, spec.entrancePupilDiameterMm);
  const paraxialC = computeParaxialProperties(spec.surfaces, 656.27, spec.entrancePupilDiameterMm);

  let imagePlaneZMm = lastSurfaceZ + paraxialD.bflMm;
  if (spec.focusMode === 'fixed_bfl' && typeof spec.fixedBflMm === 'number') {
    imagePlaneZMm = lastSurfaceZ + spec.fixedBflMm;
  }

  const semiPupil = spec.entrancePupilDiameterMm / 2;
  const startZ = -Math.max(12, spec.entrancePupilDiameterMm * 0.6);

  // If focusMode === 'best_rms', compute best polychromatic image Z shift analytically from final ray slopes!
  const pupilSamples = buildCircularPupilSamples(4);

  if (spec.focusMode === 'best_rms') {
    const hitLines: Array<{ x0: number; y0: number; dx: number; dy: number }> = [];
    for (const wl of spec.wavelengthsNm) {
      for (const sample of pupilSamples) {
        const res = traceSingle3DRay(
          spec.surfaces,
          verticesZ,
          imagePlaneZMm,
          wl,
          sample.px * semiPupil,
          sample.py * semiPupil,
          startZ,
          0,
          0,
          1,
        );
        if (!res.clipped && !res.tir && res.points.length >= 2) {
          const pLast = res.points[res.points.length - 1];
          const pPrev = res.points[res.points.length - 2];
          const dz = pLast.z - pPrev.z;
          if (Math.abs(dz) > 1e-9) {
            hitLines.push({
              x0: pLast.x,
              y0: pLast.y,
              dx: (pLast.x - pPrev.x) / dz,
              dy: (pLast.y - pPrev.y) / dz,
            });
          }
        }
      }
    }
    if (hitLines.length > 0) {
      let num = 0;
      let den = 0;
      for (const l of hitLines) {
        num += l.x0 * l.dx + l.y0 * l.dy;
        den += l.dx * l.dx + l.dy * l.dy;
      }
      if (den > 1e-9) {
        const deltaZ = -num / den;
        if (Math.abs(deltaZ) < 50) {
          imagePlaneZMm += deltaZ;
        }
      }
    }
  }

  // Trace full circular pupil across all wavelengths for on-axis (and first field angle if present)
  const spotPoints: SpotPoint[] = [];
  const byWlSq: Record<string, number[]> = {};
  let clippedRayCount = 0;
  let tirRayCount = 0;
  let totalRayCount = 0;

  const validTransverseYForMtf: number[] = [];
  const validTransverseXForMtf: number[] = [];

  for (const wl of spec.wavelengthsNm) {
    const wlKey = wl.toFixed(2);
    byWlSq[wlKey] = [];
    for (const sample of pupilSamples) {
      totalRayCount++;
      const res = traceSingle3DRay(
        spec.surfaces,
        verticesZ,
        imagePlaneZMm,
        wl,
        sample.px * semiPupil,
        sample.py * semiPupil,
        startZ,
        0,
        0,
        1,
      );
      if (res.clipped) {
        clippedRayCount++;
      } else if (res.tir) {
        tirRayCount++;
      } else {
        const xUm = res.hitImageX * 1000;
        const yUm = res.hitImageY * 1000;
        spotPoints.push({ wavelengthNm: wl, fieldDeg: 0, xUm, yUm });
        byWlSq[wlKey].push(xUm * xUm + yUm * yUm);
        validTransverseYForMtf.push(res.hitImageY);
        validTransverseXForMtf.push(res.hitImageX);
      }
    }
  }

  // Compute RMS spot radius overall and per wavelength
  let allSqSum = 0;
  let allCount = 0;
  const rmsSpotByWavelengthUm: Record<string, number> = {};
  for (const [wlKey, sqList] of Object.entries(byWlSq)) {
    if (sqList.length > 0) {
      const meanSq = sqList.reduce((a, b) => a + b, 0) / sqList.length;
      rmsSpotByWavelengthUm[wlKey] = Math.sqrt(meanSq);
      allSqSum += sqList.reduce((a, b) => a + b, 0);
      allCount += sqList.length;
    } else {
      rmsSpotByWavelengthUm[wlKey] = 9999;
    }
  }
  const rmsSpotRadiusUm = allCount > 0 ? Math.sqrt(allSqSum / allCount) : 9999;

  // Trace meridional ray fan for cross-section diagram & ray-aberration curve
  const meridionalPupils = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
  const meridionalRays: TracedRayPoint[] = [];
  const fanMap = new Map<number, { dy587: number; dy486: number; dy656: number }>();
  for (const p of meridionalPupils) {
    fanMap.set(p, { dy587: 0, dy486: 0, dy656: 0 });
  }

  const fanWavelengths = spec.wavelengthsNm.length > 0 ? spec.wavelengthsNm : [587.56];
  for (const wl of fanWavelengths) {
    for (const p of meridionalPupils) {
      const res = traceSingle3DRay(
        spec.surfaces,
        verticesZ,
        imagePlaneZMm,
        wl,
        0,
        p * semiPupil,
        startZ,
        0,
        0,
        1,
      );
      meridionalRays.push({
        wavelengthNm: wl,
        fieldDeg: 0,
        pupilNormY: p,
        points: res.points.map((pt) => ({ z: pt.z, y: pt.y })),
        imageHitX: res.hitImageX,
        imageHitY: res.hitImageY,
        clipped: res.clipped,
        tir: res.tir,
      });

      const entry = fanMap.get(p);
      if (entry && !res.clipped && !res.tir && Number.isFinite(res.hitImageY)) {
        const dyUm = res.hitImageY * 1000;
        if (Math.abs(wl - 587.56) < 25) entry.dy587 = dyUm;
        else if (wl < 530) entry.dy486 = dyUm;
        else entry.dy656 = dyUm;
      }
    }
  }

  // Longitudinal Spherical Aberration at marginal ray (p = 0.99, d-line)
  const marginalRes = traceSingle3DRay(
    spec.surfaces,
    verticesZ,
    imagePlaneZMm,
    dWavelength,
    0,
    0.99 * semiPupil,
    startZ,
    0,
    0,
    1,
  );
  let marginalFocusZ = lastSurfaceZ + paraxialD.bflMm;
  if (!marginalRes.clipped && !marginalRes.tir && marginalRes.points.length >= 2) {
    const pLast = marginalRes.points[marginalRes.points.length - 1];
    const pPrev = marginalRes.points[marginalRes.points.length - 2];
    const dy = pLast.y - pPrev.y;
    const dz = pLast.z - pPrev.z;
    if (Math.abs(dy) > 1e-9) {
      const tAxis = -pPrev.y / dy;
      marginalFocusZ = pPrev.z + tAxis * dz;
    }
  }
  const longitudinalSphericalAberrationMm = marginalFocusZ - (lastSurfaceZ + paraxialD.bflMm);
  const axialChromaticShiftMm = Math.abs(paraxialF.bflMm - paraxialC.bflMm);

  // Geometric OTF / MTF curve from actual traced ray intercepts + circular diffraction envelope
  const cutoffLpMm = 1000 / (0.00058756 * Math.max(0.5, paraxialD.fNumber));
  const freqs = [0, 10, 20, 30, 45, 60, 80, 100];
  const mtfCurve: MtfPoint[] = freqs.map((freq) => {
    if (freq === 0) {
      return { freqLpMm: 0, mtfSagittal: 1, mtfTangential: 1 };
    }
    const s = Math.min(1, freq / cutoffLpMm);
    const diffMtf = s >= 1 ? 0 : (2 / Math.PI) * (Math.acos(s) - s * Math.sqrt(1 - s * s));

    if (validTransverseYForMtf.length === 0) {
      return { freqLpMm: freq, mtfSagittal: 0, mtfTangential: 0 };
    }
    let cosSumY = 0;
    let sinSumY = 0;
    let cosSumX = 0;
    let sinSumX = 0;
    for (let i = 0; i < validTransverseYForMtf.length; i++) {
      const phaseY = 2 * Math.PI * freq * validTransverseYForMtf[i];
      const phaseX = 2 * Math.PI * freq * validTransverseXForMtf[i];
      cosSumY += Math.cos(phaseY);
      sinSumY += Math.sin(phaseY);
      cosSumX += Math.cos(phaseX);
      sinSumX += Math.sin(phaseX);
    }
    const n = validTransverseYForMtf.length;
    const geomTan = Math.hypot(cosSumY / n, sinSumY / n);
    const geomSag = Math.hypot(cosSumX / n, sinSumX / n);
    return {
      freqLpMm: freq,
      mtfTangential: Number((geomTan * diffMtf).toFixed(4)),
      mtfSagittal: Number((geomSag * diffMtf).toFixed(4)),
    };
  });

  const mtf30 = mtfCurve.find((p) => p.freqLpMm === 30)?.mtfTangential ?? 0;
  const mtf60 = mtfCurve.find((p) => p.freqLpMm === 60)?.mtfTangential ?? 0;

  return {
    solverEngine: 'ts_preview',
    paraxialEflMm: Number(paraxialD.eflMm.toFixed(4)),
    paraxialBflMm: Number(paraxialD.bflMm.toFixed(4)),
    fNumber: Number(paraxialD.fNumber.toFixed(3)),
    imagePlaneZMm: Number(imagePlaneZMm.toFixed(4)),
    totalLengthMm: Number((imagePlaneZMm - verticesZ[0]).toFixed(4)),
    rmsSpotRadiusUm: Number(rmsSpotRadiusUm.toFixed(3)),
    rmsSpotByWavelengthUm: Object.fromEntries(
      Object.entries(rmsSpotByWavelengthUm).map(([k, v]) => [k, Number(v.toFixed(3))]),
    ),
    longitudinalSphericalAberrationMm: Number(longitudinalSphericalAberrationMm.toFixed(4)),
    axialChromaticShiftMm: Number(axialChromaticShiftMm.toFixed(4)),
    mtf30LpMm: mtf30,
    mtf60LpMm: mtf60,
    mtfCurve,
    clippedRayCount,
    tirRayCount,
    totalRayCount,
    meridionalRays,
    spotPoints,
    aberrationFan: meridionalPupils.map((p) => {
      const f = fanMap.get(p)!;
      return {
        pupilNormY: p,
        dyUm587: Number(f.dy587.toFixed(2)),
        dyUm486: Number(f.dy486.toFixed(2)),
        dyUm656: Number(f.dy656.toFixed(2)),
      };
    }),
    surfaceVerticesZ: verticesZ,
    availableMetrics: [
      'paraxialEflMm',
      'paraxialBflMm',
      'fNumber',
      'imagePlaneZMm',
      'rmsSpotRadiusUm',
      'rmsSpotByWavelengthUm',
      'longitudinalSphericalAberrationMm',
      'axialChromaticShiftMm',
      'mtf30LpMm',
      'mtf60LpMm',
      'mtfCurve',
      'spotPoints',
      'meridionalRays',
      'aberrationFan',
    ],
  };
}

export interface VariableHandle {
  surfaceIndex: number;
  field: 'radiusMm' | 'thicknessMm';
  value: number;
}

export function extractVariables(spec: OpticalSystemSpec): VariableHandle[] {
  const vars: VariableHandle[] = [];
  spec.surfaces.forEach((s, idx) => {
    if (s.variableRadius && s.radiusMm !== null) {
      vars.push({ surfaceIndex: idx, field: 'radiusMm', value: s.radiusMm });
    }
    if (s.variableThickness) {
      vars.push({ surfaceIndex: idx, field: 'thicknessMm', value: s.thicknessMm });
    }
  });
  return vars;
}

export function applyVariableVector(spec: OpticalSystemSpec, vars: VariableHandle[], vec: number[]): OpticalSystemSpec {
  const cloned: OpticalSystemSpec = {
    ...spec,
    surfaces: spec.surfaces.map((s) => ({ ...s })),
  };
  vars.forEach((v, i) => {
    const val = vec[i];
    if (v.field === 'radiusMm') {
      // Prevent crossing zero radius which causes degenerate curvature
      const sign = cloned.surfaces[v.surfaceIndex].radiusMm! >= 0 ? 1 : -1;
      const safeAbs = Math.max(12, Math.abs(val));
      cloned.surfaces[v.surfaceIndex].radiusMm = Number((sign * safeAbs).toFixed(4));
    } else {
      cloned.surfaces[v.surfaceIndex].thicknessMm = Number(Math.max(1.5, Math.min(25, val)).toFixed(4));
    }
  });
  return cloned;
}

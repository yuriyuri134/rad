import type { OpticalSystemSpec, RayTraceResult } from '../core/types.ts';

interface OpticalViewportProps {
  spec: OpticalSystemSpec;
  trace: RayTraceResult;
  title?: string;
  compact?: boolean;
}

function wavelengthColor(wl: number): string {
  if (wl < 520) return '#2563eb'; // F-line cobalt blue
  if (wl < 610) return '#059669'; // d-line emerald green
  return '#dc2626'; // C-line crimson
}

function wavelengthLabel(wl: number): string {
  if (Math.abs(wl - 486.13) < 5) return '486.1nm (F)';
  if (Math.abs(wl - 587.56) < 5) return '587.6nm (d)';
  if (Math.abs(wl - 656.27) < 5) return '656.3nm (C)';
  return `${wl}nm`;
}

function buildSurfacePath(
  zVertex: number,
  radiusMm: number | null,
  semiAp: number,
  toSvgX: (z: number) => number,
  toSvgY: (y: number) => number,
): string {
  const steps = 28;
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const y = -semiAp + (2 * semiAp * i) / steps;
    let sag = 0;
    if (radiusMm !== null && Math.abs(radiusMm) > 1e-4) {
      const absR = Math.abs(radiusMm);
      if (Math.abs(y) < absR) {
        const sign = radiusMm > 0 ? 1 : -1;
        sag = sign * (absR - Math.sqrt(absR * absR - y * y));
      }
    }
    const cmd = i === 0 ? 'M' : 'L';
    pts.push(`${cmd}${toSvgX(zVertex + sag).toFixed(2)},${toSvgY(y).toFixed(2)}`);
  }
  return pts.join(' ');
}

export function OpticalViewport({ spec, trace, title, compact = false }: OpticalViewportProps) {
  // 1. Cross-section layout math
  const svgW = 760;
  const svgH = 270;
  const padL = 36;
  const padR = 32;
  const padY = 24;

  const minZ = -Math.max(14, spec.entrancePupilDiameterMm * 0.5);
  const maxZ = Math.max(trace.imagePlaneZMm + 8, 40);
  const maxSemiAp = Math.max(
    spec.entrancePupilDiameterMm * 0.65,
    ...spec.surfaces.map((s) => s.semiApertureMm),
    15,
  );
  const zSpan = Math.max(10, maxZ - minZ);
  const ySpan = maxSemiAp * 2.35;

  const toSvgX = (z: number) => padL + ((z - minZ) / zSpan) * (svgW - padL - padR);
  const toSvgY = (y: number) => svgH / 2 - (y / ySpan) * (svgH - padY * 2);

  // Build glass element polygons between consecutive non-AIR surfaces
  const lensPolygons: Array<{ points: string; glass: string }> = [];
  for (let i = 0; i < spec.surfaces.length - 1; i++) {
    const s1 = spec.surfaces[i];
    if (s1.glassAfter === 'AIR') continue;
    const s2 = spec.surfaces[i + 1];
    const z1 = trace.surfaceVerticesZ[i] ?? 0;
    const z2 = trace.surfaceVerticesZ[i + 1] ?? z1 + s1.thicknessMm;
    const ap = Math.min(s1.semiApertureMm, s2.semiApertureMm);

    const frontPts: string[] = [];
    const backPts: string[] = [];
    const steps = 20;
    for (let k = 0; k <= steps; k++) {
      const y = -ap + (2 * ap * k) / steps;
      const sag1 =
        s1.radiusMm && Math.abs(y) < Math.abs(s1.radiusMm)
          ? Math.sign(s1.radiusMm) * (Math.abs(s1.radiusMm) - Math.sqrt(s1.radiusMm * s1.radiusMm - y * y))
          : 0;
      frontPts.push(`${toSvgX(z1 + sag1).toFixed(1)},${toSvgY(y).toFixed(1)}`);
    }
    for (let k = steps; k >= 0; k--) {
      const y = -ap + (2 * ap * k) / steps;
      const sag2 =
        s2.radiusMm && Math.abs(y) < Math.abs(s2.radiusMm)
          ? Math.sign(s2.radiusMm) * (Math.abs(s2.radiusMm) - Math.sqrt(s2.radiusMm * s2.radiusMm - y * y))
          : 0;
      backPts.push(`${toSvgX(z2 + sag2).toFixed(1)},${toSvgY(y).toFixed(1)}`);
    }
    lensPolygons.push({
      points: [...frontPts, ...backPts].join(' '),
      glass: s1.glassAfter,
    });
  }

  // 2. Spot diagram scale
  const spotSize = 210;
  const maxSpotCoord = Math.max(
    40,
    ...trace.spotPoints.map((p) => Math.max(Math.abs(p.xUm), Math.abs(p.yUm))),
  );
  const spotBound = Math.ceil(maxSpotCoord * 1.18);
  const toSpotX = (x: number) => spotSize / 2 + (x / spotBound) * (spotSize / 2 - 18);
  const toSpotY = (y: number) => spotSize / 2 - (y / spotBound) * (spotSize / 2 - 18);
  const rmsRadiusPx = (trace.rmsSpotRadiusUm / spotBound) * (spotSize / 2 - 18);

  // 3. MTF chart scale
  const mtfW = 340;
  const mtfH = 210;
  const mtfPadL = 40;
  const mtfPadR = 16;
  const mtfPadT = 18;
  const mtfPadB = 28;
  const toMtfX = (f: number) => mtfPadL + (f / 100) * (mtfW - mtfPadL - mtfPadR);
  const toMtfY = (v: number) => mtfH - mtfPadB - Math.max(0, Math.min(1, v)) * (mtfH - mtfPadT - mtfPadB);
  const tanPath = trace.mtfCurve
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${toMtfX(p.freqLpMm).toFixed(1)},${toMtfY(p.mtfTangential).toFixed(1)}`)
    .join(' ');
  const sagPath = trace.mtfCurve
    .map((p, idx) => `${idx === 0 ? 'M' : 'L'}${toMtfX(p.freqLpMm).toFixed(1)},${toMtfY(p.mtfSagittal).toFixed(1)}`)
    .join(' ');

  return (
    <div className="space-y-4">
      {/* Main Optical Ray-Trace Diagram */}
      <div className="bg-white border border-slate-200 rounded-md p-4">
        <div className="flex flex-wrap items-center justify-between gap-4 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">
              {title || `${spec.name} · 斯涅尔子午光线追迹光路`}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 font-mono tabular-nums">
              像面 Z = {trace.imagePlaneZMm.toFixed(2)} mm · 有效焦距 EFL = {trace.paraxialEflMm.toFixed(2)} mm · F/{trace.fNumber}
            </p>
          </div>
          <div className="flex items-center gap-4 text-xs text-slate-600 font-mono">
            {spec.wavelengthsNm.map((wl) => (
              <span key={wl} className="inline-flex items-center gap-1.5">
                <span className="w-3 h-0.5 inline-block" style={{ backgroundColor: wavelengthColor(wl) }} />
                {wavelengthLabel(wl)}
              </span>
            ))}
          </div>
        </div>

        <svg
          viewBox={`0 0 ${svgW} ${svgH}`}
          className="w-full h-auto bg-slate-50 border border-slate-200 rounded"
          role="img"
          aria-label="光学系统截面与光线追迹光路图"
          data-testid="optical-ray-svg"
        >
          {/* Optical axis */}
          <line
            x1={padL}
            y1={svgH / 2}
            x2={svgW - padR}
            y2={svgH / 2}
            stroke="#94a3b8"
            strokeWidth="1"
            strokeDasharray="4 4"
          />

          {/* Glass elements */}
          {lensPolygons.map((poly, idx) => (
            <polygon
              key={idx}
              points={poly.points}
              fill={poly.glass === 'N-SF11' ? 'rgba(14, 165, 233, 0.16)' : 'rgba(59, 130, 246, 0.12)'}
              stroke="#475569"
              strokeWidth="1.2"
            />
          ))}

          {/* Surface arcs */}
          {spec.surfaces.map((s, idx) => (
            <path
              key={s.id}
              d={buildSurfacePath(
                trace.surfaceVerticesZ[idx] ?? 0,
                s.radiusMm,
                s.semiApertureMm,
                toSvgX,
                toSvgY,
              )}
              fill="none"
              stroke="#334155"
              strokeWidth="1.5"
            />
          ))}

          {/* Traced rays */}
          {trace.meridionalRays.map((ray, idx) => {
            if (ray.points.length < 2) return null;
            const d = ray.points
              .map((pt, i) => `${i === 0 ? 'M' : 'L'}${toSvgX(pt.z).toFixed(1)},${toSvgY(pt.y).toFixed(1)}`)
              .join(' ');
            return (
              <path
                key={idx}
                d={d}
                fill="none"
                stroke={wavelengthColor(ray.wavelengthNm)}
                strokeOpacity={ray.clipped || ray.tir ? 0.25 : 0.72}
                strokeWidth="1.15"
                strokeDasharray={ray.clipped || ray.tir ? '3 3' : undefined}
              />
            );
          })}

          {/* Image Plane */}
          <line
            x1={toSvgX(trace.imagePlaneZMm)}
            y1={padY - 6}
            x2={toSvgX(trace.imagePlaneZMm)}
            y2={svgH - padY + 6}
            stroke="#0f172a"
            strokeWidth="1.8"
          />
          <text
            x={toSvgX(trace.imagePlaneZMm) - 6}
            y={padY - 10}
            textAnchor="end"
            className="fill-slate-700 text-[10px] font-mono"
          >
            像面 ({trace.imagePlaneZMm.toFixed(1)}mm)
          </text>
        </svg>
      </div>

      {/* Secondary Quantitative Charts: Spot Diagram + MTF */}
      <div className={compact ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 lg:grid-cols-2 gap-4'}>
        {/* Spot Diagram */}
        <div className="bg-white border border-slate-200 rounded-md p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h4 className="text-xs font-semibold text-slate-900">像面点列图 (3D 圆形光瞳追迹)</h4>
            <span className="text-xs font-mono text-slate-500 tabular-nums whitespace-nowrap">
              边界 ±{spotBound} μm · RMS {trace.rmsSpotRadiusUm} μm
            </span>
          </div>
          <div className="flex flex-wrap sm:flex-nowrap items-center gap-4">
            <svg
              viewBox={`0 0 ${spotSize} ${spotSize}`}
              className="w-44 h-44 shrink-0 bg-slate-50 border border-slate-200 rounded"
              role="img"
              aria-label="像面点列图"
            >
              <line x1={spotSize / 2} y1={10} x2={spotSize / 2} y2={spotSize - 10} stroke="#cbd5e1" strokeWidth="1" />
              <line x1={10} y1={spotSize / 2} x2={spotSize - 10} y2={spotSize / 2} stroke="#cbd5e1" strokeWidth="1" />
              <circle
                cx={spotSize / 2}
                cy={spotSize / 2}
                r={Math.min(spotSize / 2 - 12, rmsRadiusPx)}
                fill="none"
                stroke="#0f172a"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              {trace.spotPoints.map((pt, idx) => (
                <circle
                  key={idx}
                  cx={toSpotX(pt.xUm)}
                  cy={toSpotY(pt.yUm)}
                  r="2.1"
                  fill={wavelengthColor(pt.wavelengthNm)}
                  fillOpacity="0.78"
                />
              ))}
            </svg>
            <div className="text-xs space-y-2 text-slate-600 font-mono tabular-nums flex-1 min-w-[165px]">
              <div className="pb-1.5 border-b border-slate-100">
                <div className="text-slate-400">全波段 RMS 半径</div>
                <div className="text-base font-semibold text-slate-900">{trace.rmsSpotRadiusUm} μm</div>
              </div>
              {Object.entries(trace.rmsSpotByWavelengthUm).map(([wl, val]) => (
                <div key={wl} className="flex items-center justify-between gap-3 whitespace-nowrap">
                  <span>{wl} nm</span>
                  <span className="text-slate-900 font-medium">{val} μm</span>
                </div>
              ))}
              <div className="pt-1.5 border-t border-slate-100 flex items-center justify-between gap-3 whitespace-nowrap">
                <span>球差 (LSA)</span>
                <span className="text-slate-900 font-medium">{trace.longitudinalSphericalAberrationMm} mm</span>
              </div>
            </div>
          </div>
        </div>

        {/* MTF Curve */}
        <div className="bg-white border border-slate-200 rounded-md p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
            <h4 className="text-xs font-semibold text-slate-900">几何光学调制传递函数 (MTF)</h4>
            <span className="text-xs font-mono text-slate-500 tabular-nums whitespace-nowrap">
              30 lp/mm = {trace.mtf30LpMm.toFixed(3)} · 60 lp/mm = {trace.mtf60LpMm.toFixed(3)}
            </span>
          </div>
          <svg
            viewBox={`0 0 ${mtfW} ${mtfH}`}
            className="w-full h-48 bg-slate-50 border border-slate-200 rounded"
            role="img"
            aria-label="光学 MTF 曲线"
          >
            {[0, 0.25, 0.5, 0.75, 1].map((tick) => (
              <g key={tick}>
                <line
                  x1={mtfPadL}
                  y1={toMtfY(tick)}
                  x2={mtfW - mtfPadR}
                  y2={toMtfY(tick)}
                  stroke="#e2e8f0"
                  strokeWidth="1"
                />
                <text
                  x={mtfPadL - 6}
                  y={toMtfY(tick) + 3}
                  textAnchor="end"
                  className="fill-slate-500 text-[9px] font-mono"
                >
                  {tick.toFixed(2)}
                </text>
              </g>
            ))}
            {[0, 20, 40, 60, 80, 100].map((freq) => (
              <g key={freq}>
                <line
                  x1={toMtfX(freq)}
                  y1={mtfPadT}
                  x2={toMtfX(freq)}
                  y2={mtfH - mtfPadB}
                  stroke="#e2e8f0"
                  strokeWidth="1"
                />
                <text
                  x={toMtfX(freq)}
                  y={mtfH - 10}
                  textAnchor="middle"
                  className="fill-slate-500 text-[9px] font-mono"
                >
                  {freq}
                </text>
              </g>
            ))}
            {/* Reference 0.35 line */}
            <line
              x1={mtfPadL}
              y1={toMtfY(0.35)}
              x2={mtfW - mtfPadR}
              y2={toMtfY(0.35)}
              stroke="#d97706"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            <path d={sagPath} fill="none" stroke="#0891b2" strokeWidth="1.8" strokeDasharray="4 2" />
            <path d={tanPath} fill="none" stroke="#1d4ed8" strokeWidth="2.2" />
            <text x={mtfW - mtfPadR - 4} y={mtfPadT + 10} textAnchor="end" className="fill-blue-700 text-[9px] font-mono">
              实线: 子午 T · 虚线: 弧矢 S (lp/mm)
            </text>
          </svg>
        </div>
      </div>
    </div>
  );
}

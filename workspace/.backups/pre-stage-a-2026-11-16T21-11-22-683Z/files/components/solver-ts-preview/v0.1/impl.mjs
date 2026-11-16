// 有限范围几何预览求解器存根（真实物理实现位于 src/core/optics.ts）
// 注意：本求解器仅用于无 Python 3.11+ / Optiland 环境下的链路联调与球面预览，不能替代 Optiland。
import { traceOpticalSystem } from '../../../../src/core/optics.ts';

export function selfCheck() {
  const res = traceOpticalSystem({
    name: 'Thin Check',
    description: 'Check',
    entrancePupilDiameterMm: 10,
    fieldAnglesDeg: [0],
    wavelengthsNm: [587.56],
    targetEflMm: 96.8,
    focusMode: 'paraxial_d',
    surfaces: [
      { id: 's1', label: 'F', radiusMm: 100, thicknessMm: 0.01, semiApertureMm: 10, glassAfter: 'N-BK7' },
      { id: 's2', label: 'B', radiusMm: -100, thicknessMm: 0, semiApertureMm: 10, glassAfter: 'AIR' },
    ],
  });
  const ok = Math.abs(res.paraxialEflMm - 96.83) < 0.2;
  return {
    passed: ok,
    summary: ok
      ? `自检通过（有限球面预览）：薄透镜 EFL=${res.paraxialEflMm} mm`
      : `自检失败：EFL=${res.paraxialEflMm} mm`,
  };
}

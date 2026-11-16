// 评价标准组件：最小 RMS 光斑与焦距容差
export function evaluate(rawArtifacts, spec, params) {
  const required = ['rmsSpotRadiusUm', 'paraxialEflMm', 'clippedRayCount', 'tirRayCount'];
  const missing = required.filter((k) => typeof rawArtifacts?.[k] !== 'number');
  if (missing.length > 0) {
    return {
      passed: false,
      status: 'insufficient_artifacts',
      lossScore: null,
      summary: '已保存实验产物缺少必要指标，拒绝推测：' + missing.join(', '),
      checks: [],
      uncertainties: ['未在原始产物中找到所需物理量，请使用能产出该指标的求解器重新运行。'],
      missingArtifacts: missing,
    };
  }

  const maxRmsUm = Number(params.maxRmsUm ?? 65);
  const eflToleranceMm = Number(params.eflToleranceMm ?? 3.0);

  const eflError = Math.abs(rawArtifacts.paraxialEflMm - spec.targetEflMm);
  const eflOk = eflError <= eflToleranceMm;
  const spotOk = rawArtifacts.rmsSpotRadiusUm <= maxRmsUm;
  const raysOk = rawArtifacts.clippedRayCount === 0 && rawArtifacts.tirRayCount === 0;

  const lossScore = Number(
    (
      rawArtifacts.rmsSpotRadiusUm +
      eflError * 18 +
      (rawArtifacts.clippedRayCount + rawArtifacts.tirRayCount) * 500
    ).toFixed(3)
  );

  const passed = eflOk && spotOk && raysOk;
  return {
    passed,
    status: passed ? 'pass' : (spotOk && raysOk ? 'warning' : 'fail'),
    lossScore,
    summary: passed
      ? `RMS 光斑 ${rawArtifacts.rmsSpotRadiusUm} μm 与焦距误差 ${eflError.toFixed(2)} mm 均满足单色光斑阈值`
      : `未达标：RMS ${rawArtifacts.rmsSpotRadiusUm} μm（上限 ${maxRmsUm} μm），EFL 误差 ${eflError.toFixed(2)} mm`,
    checks: [
      {
        criterion: '多波段平均 RMS 光斑半径',
        measured: `${rawArtifacts.rmsSpotRadiusUm} μm`,
        threshold: `<= ${maxRmsUm} μm`,
        passed: spotOk,
      },
      {
        criterion: '有效焦距 (EFL) 偏差',
        measured: `${eflError.toFixed(2)} mm`,
        threshold: `<= ${eflToleranceMm} mm`,
        passed: eflOk,
      },
      {
        criterion: '孔径遮拦 / 全反射检查',
        measured: `${rawArtifacts.clippedRayCount} clipped / ${rawArtifacts.tirRayCount} TIR`,
        threshold: '0 异常光线',
        passed: raysOk,
      },
    ],
    uncertainties: [
      '该评价器未约束 F/C 轴向色差偏移，宽光谱成像下可能误判。',
      '仅检验轴上 0° 视场。',
    ],
  };
}

export function selfCheck(params) {
  const samplePass = evaluate(
    { rmsSpotRadiusUm: 25, paraxialEflMm: 100.2, clippedRayCount: 0, tirRayCount: 0 },
    { targetEflMm: 100 },
    params
  );
  const sampleMissing = evaluate({ paraxialEflMm: 100 }, { targetEflMm: 100 }, params);
  const ok = samplePass.passed === true && sampleMissing.status === 'insufficient_artifacts';
  return {
    passed: ok,
    summary: ok
      ? '自检通过：正常样本判定 pass，缺失产物拒绝推测 (insufficient_artifacts)'
      : '自检失败：契约边界返回值异常',
  };
}

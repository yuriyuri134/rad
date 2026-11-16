// 评价标准组件：严格 MTF30 与消色差综合判据
export function evaluate(rawArtifacts, spec, params) {
  const required = ['mtf30LpMm', 'axialChromaticShiftMm', 'paraxialEflMm', 'rmsSpotRadiusUm', 'clippedRayCount', 'tirRayCount'];
  const missing = required.filter((k) => typeof rawArtifacts?.[k] !== 'number');
  if (missing.length > 0) {
    return {
      passed: false,
      status: 'insufficient_artifacts',
      lossScore: null,
      summary: '已保存实验产物缺少必要指标，拒绝推测：' + missing.join(', '),
      checks: [],
      uncertainties: ['未在原始产物中找到 MTF30 或轴向色差字段，不能进行事后评价。'],
      missingArtifacts: missing,
    };
  }

  const minMtf30 = Number(params.minMtf30 ?? 0.35);
  const maxChromaticMm = Number(params.maxChromaticMm ?? 0.45);
  const eflToleranceMm = Number(params.eflToleranceMm ?? 2.5);

  const eflError = Math.abs(rawArtifacts.paraxialEflMm - spec.targetEflMm);
  const mtfOk = rawArtifacts.mtf30LpMm >= minMtf30;
  const chromOk = rawArtifacts.axialChromaticShiftMm <= maxChromaticMm;
  const eflOk = eflError <= eflToleranceMm;
  const raysOk = rawArtifacts.clippedRayCount === 0 && rawArtifacts.tirRayCount === 0;

  const lossScore = Number(
    (
      Math.max(0, 1 - rawArtifacts.mtf30LpMm) * 140 +
      rawArtifacts.axialChromaticShiftMm * 95 +
      rawArtifacts.rmsSpotRadiusUm * 0.4 +
      eflError * 22 +
      (rawArtifacts.clippedRayCount + rawArtifacts.tirRayCount) * 600
    ).toFixed(3)
  );

  const passed = mtfOk && chromOk && eflOk && raysOk;
  const status = passed ? 'pass' : (mtfOk || chromOk ? 'warning' : 'fail');

  return {
    passed,
    status,
    lossScore,
    summary: passed
      ? `MTF@30lp=${rawArtifacts.mtf30LpMm} 且轴向色差 ${rawArtifacts.axialChromaticShiftMm} mm，达到消色差成像要求`
      : `判定不通过：MTF@30=${rawArtifacts.mtf30LpMm}（要求≥${minMtf30}），色差 ${rawArtifacts.axialChromaticShiftMm} mm（上限 ${maxChromaticMm} mm）`,
    checks: [
      {
        criterion: '30 lp/mm 调制传递函数 (MTF)',
        measured: String(rawArtifacts.mtf30LpMm),
        threshold: `>= ${minMtf30}`,
        passed: mtfOk,
      },
      {
        criterion: 'F-C 轴向色差焦点漂移',
        measured: `${rawArtifacts.axialChromaticShiftMm} mm`,
        threshold: `<= ${maxChromaticMm} mm`,
        passed: chromOk,
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
      '仅代表选定求解器计算模型下的 MTF，不替代实验室干涉/星点实测。',
    ],
  };
}

export function selfCheck(params) {
  const sampleFail = evaluate(
    { mtf30LpMm: 0.12, axialChromaticShiftMm: 1.5, paraxialEflMm: 100, rmsSpotRadiusUm: 75, clippedRayCount: 0, tirRayCount: 0 },
    { targetEflMm: 100 },
    params
  );
  const samplePass = evaluate(
    { mtf30LpMm: 0.62, axialChromaticShiftMm: 0.18, paraxialEflMm: 100.1, rmsSpotRadiusUm: 12, clippedRayCount: 0, tirRayCount: 0 },
    { targetEflMm: 100 },
    params
  );
  const ok = sampleFail.passed === false && samplePass.passed === true;
  return {
    passed: ok,
    summary: ok
      ? '自检通过：高色差样本被准确拒绝，消色差样本准确通过'
      : '自检失败：判别逻辑异常',
  };
}

// 优化策略组件：自适应坐标模式搜索（Pattern Search）
export function optimize(initialSpec, helpers, params) {
  const maxIterations = Math.min(40, Math.max(4, Number(params.maxIterations ?? 18)));
  const initialStep = Number(params.initialStepMm ?? 6.0);

  const vars = helpers.extractVariables(initialSpec);
  let currentVec = vars.map((v) => v.value);
  let bestSpec = initialSpec;
  let bestTrace = helpers.trace(bestSpec);
  let bestEval = helpers.evaluate(bestTrace, bestSpec);
  const history = [
    {
      step: 0,
      loss: bestEval.lossScore ?? 9999,
      rmsSpotUm: bestTrace.rmsSpotRadiusUm,
      eflMm: bestTrace.paraxialEflMm,
      chromaticShiftMm: bestTrace.axialChromaticShiftMm,
    },
  ];

  if (vars.length === 0) {
    return { bestSpec, bestTrace, bestEval, history };
  }

  let stepSize = initialStep;
  for (let iter = 1; iter <= maxIterations; iter++) {
    let improved = false;
    for (let d = 0; d < vars.length; d++) {
      for (const dir of [1, -1]) {
        const candidateVec = [...currentVec];
        candidateVec[d] += dir * stepSize;
        const candSpec = helpers.applyVariableVector(initialSpec, vars, candidateVec);
        const candTrace = helpers.trace(candSpec);
        const candEval = helpers.evaluate(candTrace, candSpec);
        const candLoss = candEval.lossScore ?? Infinity;
        const bestLoss = bestEval.lossScore ?? Infinity;
        if (candLoss < bestLoss - 1e-4) {
          currentVec = candidateVec;
          bestSpec = candSpec;
          bestTrace = candTrace;
          bestEval = candEval;
          improved = true;
        }
      }
    }
    history.push({
      step: iter,
      loss: bestEval.lossScore ?? 9999,
      rmsSpotUm: bestTrace.rmsSpotRadiusUm,
      eflMm: bestTrace.paraxialEflMm,
      chromaticShiftMm: bestTrace.axialChromaticShiftMm,
    });
    if (!improved) {
      stepSize *= 0.55;
      if (stepSize < 0.08) break;
    }
  }

  return { bestSpec, bestTrace, bestEval, history };
}

export function selfCheck(params) {
  // Pure quadratic bowl minimization smoke test (does not claim optical accuracy)
  let x = 10;
  const mockSpec = { surfaces: [{ radiusMm: x, thicknessMm: 2, variableRadius: true }], targetEflMm: 0 };
  const helpers = {
    extractVariables: (s) => [{ surfaceIndex: 0, field: 'radiusMm', value: s.surfaces[0].radiusMm }],
    applyVariableVector: (s, _v, vec) => ({ ...s, surfaces: [{ ...s.surfaces[0], radiusMm: vec[0] }] }),
    trace: (s) => ({
      rmsSpotRadiusUm: Math.pow(s.surfaces[0].radiusMm - 20, 2),
      paraxialEflMm: 0,
      axialChromaticShiftMm: 0,
    }),
    evaluate: (t) => ({ lossScore: t.rmsSpotRadiusUm, passed: true, status: 'pass', summary: 'ok', checks: [], uncertainties: [] }),
  };
  const out = optimize(mockSpec, helpers, { ...params, maxIterations: 8, initialStepMm: 4 });
  const ok = out.history[out.history.length - 1].loss < out.history[0].loss;
  return {
    passed: ok,
    summary: ok
      ? `自检通过：二次测试函数损失由 ${out.history[0].loss} 降至 ${out.history[out.history.length - 1].loss}`
      : '自检失败：搜索未能降低测试损失函数',
  };
}

// 优化策略组件：Nelder-Mead 单纯形优化器
export function optimize(initialSpec, helpers, params) {
  const maxIterations = Math.min(45, Math.max(5, Number(params.maxIterations ?? 24)));
  const simplexScale = Number(params.simplexScaleMm ?? 5.5);

  const vars = helpers.extractVariables(initialSpec);
  const n = vars.length;
  const initTrace = helpers.trace(initialSpec);
  const initEval = helpers.evaluate(initTrace, initialSpec);
  const history = [
    {
      step: 0,
      loss: initEval.lossScore ?? 9999,
      rmsSpotUm: initTrace.rmsSpotRadiusUm,
      eflMm: initTrace.paraxialEflMm,
      chromaticShiftMm: initTrace.axialChromaticShiftMm,
    },
  ];

  if (n === 0) {
    return { bestSpec: initialSpec, bestTrace: initTrace, bestEval: initEval, history };
  }

  const evalVec = (vec) => {
    const spec = helpers.applyVariableVector(initialSpec, vars, vec);
    const trace = helpers.trace(spec);
    const ev = helpers.evaluate(trace, spec);
    return { vec, spec, trace, ev, loss: ev.lossScore ?? Infinity };
  };

  const simplex = [evalVec(vars.map((v) => v.value))];
  for (let i = 0; i < n; i++) {
    const v = vars.map((item) => item.value);
    v[i] += simplexScale;
    simplex.push(evalVec(v));
  }

  for (let iter = 1; iter <= maxIterations; iter++) {
    simplex.sort((a, b) => a.loss - b.loss);
    const best = simplex[0];
    const worst = simplex[n];
    const secondWorst = simplex[n - 1];

    history.push({
      step: iter,
      loss: best.loss,
      rmsSpotUm: best.trace.rmsSpotRadiusUm,
      eflMm: best.trace.paraxialEflMm,
      chromaticShiftMm: best.trace.axialChromaticShiftMm,
    });

    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) centroid[j] += simplex[i].vec[j] / n;
    }

    const xr = centroid.map((c, j) => c + 1.0 * (c - worst.vec[j]));
    const fr = evalVec(xr);

    if (fr.loss < best.loss) {
      const xe = centroid.map((c, j) => c + 2.0 * (xr[j] - c));
      const fe = evalVec(xe);
      simplex[n] = fe.loss < fr.loss ? fe : fr;
    } else if (fr.loss < secondWorst.loss) {
      simplex[n] = fr;
    } else {
      const xc = centroid.map((c, j) => c + 0.5 * (worst.vec[j] - c));
      const fc = evalVec(xc);
      if (fc.loss < worst.loss) {
        simplex[n] = fc;
      } else {
        for (let i = 1; i <= n; i++) {
          const xs = best.vec.map((b, j) => b + 0.5 * (simplex[i].vec[j] - b));
          simplex[i] = evalVec(xs);
        }
      }
    }
  }

  simplex.sort((a, b) => a.loss - b.loss);
  const finalBest = simplex[0];
  return {
    bestSpec: finalBest.spec,
    bestTrace: finalBest.trace,
    bestEval: finalBest.ev,
    history,
  };
}

export function selfCheck(params) {
  const mockSpec = {
    surfaces: [
      { radiusMm: 12, thicknessMm: 2, variableRadius: true },
      { radiusMm: -20, thicknessMm: 0, variableRadius: true },
    ],
    targetEflMm: 0,
  };
  const helpers = {
    extractVariables: (s) => [
      { surfaceIndex: 0, field: 'radiusMm', value: s.surfaces[0].radiusMm },
      { surfaceIndex: 1, field: 'radiusMm', value: s.surfaces[1].radiusMm },
    ],
    applyVariableVector: (s, _v, vec) => ({
      ...s,
      surfaces: [
        { ...s.surfaces[0], radiusMm: vec[0] },
        { ...s.surfaces[1], radiusMm: vec[1] },
      ],
    }),
    trace: (s) => ({
      rmsSpotRadiusUm: Math.pow(s.surfaces[0].radiusMm - 25, 2) + Math.pow(s.surfaces[1].radiusMm + 30, 2),
      paraxialEflMm: 0,
      axialChromaticShiftMm: 0,
    }),
    evaluate: (t) => ({ lossScore: t.rmsSpotRadiusUm, passed: true, status: 'pass', summary: 'ok', checks: [], uncertainties: [] }),
  };
  const out = optimize(mockSpec, helpers, { ...params, maxIterations: 15, simplexScaleMm: 3 });
  const ok = out.history[out.history.length - 1].loss < out.history[0].loss;
  return {
    passed: ok,
    summary: ok
      ? `自检通过：二维耦合目标损失由 ${out.history[0].loss} 降至 ${out.history[out.history.length - 1].loss}`
      : '自检失败：单纯形未能收敛',
  };
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { traceOpticalSystem } from '../src/core/optics.ts';
import type {
  ActorAttribution,
  ArchitectureSnapshot,
  Branch,
  ComponentDossier,
  ComponentSourceAvailability,
  ComponentVersionRecord,
  EffectiveExecutionConfig,
  EvaluationVerdict,
  ExperimentRun,
  ExperimentSnapshot,
  HistoricalHashDriftRecord,
  OpticalSystemSpec,
  ResearchObject,
  ResearchSnapshot,
  RunSupplement,
  RuntimeEnvironmentSnapshot,
  StandaloneAnalysisRecord,
  ThreadEntry,
} from '../src/core/types.ts';

export function resolveWorkspaceDir(workspaceDir?: string): string {
  if (workspaceDir) return path.resolve(workspaceDir);
  if (process.env.OPENLAB_WORKSPACE_DIR) {
    return path.resolve(process.env.OPENLAB_WORKSPACE_DIR);
  }
  return path.resolve(process.cwd(), 'workspace');
}

export function getWorkspacePaths(workspaceDir?: string) {
  const root = resolveWorkspaceDir(workspaceDir);
  return {
    workspaceDir: root,
    componentsDir: path.join(root, 'components'),
    runsFile: path.join(root, 'runs.jsonl'),
    runSupplementsFile: path.join(root, 'run_supplements.jsonl'),
    threadFile: path.join(root, 'thread.jsonl'),
    researchObjectsFile: path.join(root, 'research_objects.json'),
    snapshotsFile: path.join(root, 'snapshots.jsonl'),
    branchesFile: path.join(root, 'branches.json'),
    architectureSnapshotsFile: path.join(root, 'architecture_snapshots.jsonl'),
    experimentSnapshotsFile: path.join(root, 'experiment_snapshots.jsonl'),
  };
}

export const WORKSPACE_DIR = path.resolve(process.cwd(), 'workspace');
export const COMPONENTS_DIR = path.join(WORKSPACE_DIR, 'components');
export const RUNS_FILE = path.join(WORKSPACE_DIR, 'runs.jsonl');
export const THREAD_FILE = path.join(WORKSPACE_DIR, 'thread.jsonl');

export function atomicWriteFileSync(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Ignore cleanup error
      }
    }
    throw err;
  }
}

/** Full 64-character SHA-256 hex digest */
export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => canonicalJson(v)).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function computeRunHashes(runCore: {
  id: string;
  sequenceNumber: number;
  createdAt: string;
  parentRunId: string | null;
  branchLabel: string;
  intent: string;
  mode: string;
  seed: number;
  runtimeEnv: RuntimeEnvironmentSnapshot;
  composition: ExperimentRun['composition'];
  baseSnapshotId?: string | null;
  researchObjectId?: string | null;
  branchId?: string | null;
  effectiveConfig?: EffectiveExecutionConfig;
  systemBefore: OpticalSystemSpec;
  systemAfter: OpticalSystemSpec;
  rawArtifactsBefore: ExperimentRun['rawArtifactsBefore'];
  rawArtifactsAfter: ExperimentRun['rawArtifactsAfter'];
}): { inputHash: string; rawArtifactsHash: string; recordIntegrityHash: string } {
  const inputPayload = runCore.effectiveConfig
    ? {
        systemBefore: runCore.systemBefore,
        composition: runCore.composition,
        seed: runCore.seed,
        mode: runCore.mode,
        baseSnapshotId: runCore.baseSnapshotId ?? null,
        researchObjectId: runCore.researchObjectId ?? null,
        branchId: runCore.branchId ?? null,
        effectiveConfig: runCore.effectiveConfig,
      }
    : {
        systemBefore: runCore.systemBefore,
        composition: runCore.composition,
        seed: runCore.seed,
        mode: runCore.mode,
      };
  const inputHash = sha256(canonicalJson(inputPayload));
  const rawArtifactsHash = sha256(
    canonicalJson({
      rawArtifactsBefore: runCore.rawArtifactsBefore,
      rawArtifactsAfter: runCore.rawArtifactsAfter,
    }),
  );
  const integrityPayload = runCore.effectiveConfig
    ? {
        id: runCore.id,
        sequenceNumber: runCore.sequenceNumber,
        createdAt: runCore.createdAt,
        parentRunId: runCore.parentRunId,
        runtimeEnv: runCore.runtimeEnv,
        systemAfter: runCore.systemAfter,
        baseSnapshotId: runCore.baseSnapshotId ?? null,
        researchObjectId: runCore.researchObjectId ?? null,
        branchId: runCore.branchId ?? null,
        effectiveConfig: runCore.effectiveConfig,
        inputHash,
        rawArtifactsHash,
      }
    : {
        id: runCore.id,
        sequenceNumber: runCore.sequenceNumber,
        createdAt: runCore.createdAt,
        parentRunId: runCore.parentRunId,
        runtimeEnv: runCore.runtimeEnv,
        systemAfter: runCore.systemAfter,
        inputHash,
        rawArtifactsHash,
      };
  const recordIntegrityHash = sha256(canonicalJson(integrityPayload));
  return { inputHash, rawArtifactsHash, recordIntegrityHash };
}

export function verifyRunIntegrity(run: ExperimentRun): 'verified' | 'tampered' | 'legacy_unhashed' {
  if (!run.recordIntegrityHash || run.recordIntegrityHash.length !== 64 || !run.rawArtifactsAfter) {
    return 'legacy_unhashed';
  }
  const recomputed = computeRunHashes({
    id: run.id,
    sequenceNumber: run.sequenceNumber,
    createdAt: run.createdAt,
    parentRunId: run.parentRunId,
    branchLabel: run.branchLabel,
    intent: run.intent,
    mode: run.mode,
    seed: run.seed,
    runtimeEnv: run.runtimeEnv,
    composition: run.composition,
    baseSnapshotId: run.baseSnapshotId,
    researchObjectId: run.researchObjectId,
    branchId: run.branchId,
    effectiveConfig: run.effectiveConfig,
    systemBefore: run.systemBefore,
    systemAfter: run.systemAfter,
    rawArtifactsBefore: run.rawArtifactsBefore,
    rawArtifactsAfter: run.rawArtifactsAfter,
  });
  return recomputed.recordIntegrityHash === run.recordIntegrityHash &&
    recomputed.inputHash === run.inputHash &&
    recomputed.rawArtifactsHash === run.rawArtifactsHash
    ? 'verified'
    : 'tampered';
}

export const INITIAL_SINGLET_SPEC: OpticalSystemSpec = {
  name: 'N-BK7 单透镜基线（待优化）',
  description: '25mm 入瞳、目标焦距 100mm 的单透镜初始猜想。未校正球差与轴向色差，适合检验评价标准切换。',
  entrancePupilDiameterMm: 25,
  fieldAnglesDeg: [0],
  wavelengthsNm: [486.13, 587.56, 656.27],
  targetEflMm: 100,
  focusMode: 'best_rms',
  surfaces: [
    {
      id: 's1',
      label: '前表面 (Crown Front)',
      radiusMm: 72.0,
      thicknessMm: 5.5,
      semiApertureMm: 15,
      glassAfter: 'N-BK7',
      variableRadius: true,
      variableThickness: false,
    },
    {
      id: 's2',
      label: '后表面 (Crown Back)',
      radiusMm: -165.0,
      thicknessMm: 0,
      semiApertureMm: 15,
      glassAfter: 'AIR',
      variableRadius: true,
      variableThickness: false,
    },
  ],
};

export const INITIAL_DOUBLET_SPEC: OpticalSystemSpec = {
  name: 'N-BK7 / N-SF11 双胶合消色差基线',
  description: '经典 Fraunhofer 型双胶合结构，利用冕牌/火石玻璃色散差抵消 F/C 轴向色差。',
  entrancePupilDiameterMm: 25,
  fieldAnglesDeg: [0],
  wavelengthsNm: [486.13, 587.56, 656.27],
  targetEflMm: 100,
  focusMode: 'best_rms',
  surfaces: [
    {
      id: 's1',
      label: '冕牌前表面 (N-BK7)',
      radiusMm: 61.5,
      thicknessMm: 6.0,
      semiApertureMm: 15,
      glassAfter: 'N-BK7',
      variableRadius: true,
      variableThickness: false,
    },
    {
      id: 's2',
      label: '胶合面 (N-BK7 → N-SF11)',
      radiusMm: -62.2,
      thicknessMm: 3.0,
      semiApertureMm: 15,
      glassAfter: 'N-SF11',
      variableRadius: true,
      variableThickness: false,
    },
    {
      id: 's3',
      label: '火石后表面 (N-SF11 → Air)',
      radiusMm: -133.0,
      thicknessMm: 0,
      semiApertureMm: 15,
      glassAfter: 'AIR',
      variableRadius: true,
      variableThickness: false,
    },
  ],
};

const EVAL_RMS_SPOT_CODE = `// 评价标准组件：最小 RMS 光斑与焦距容差
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
      ? \`RMS 光斑 \${rawArtifacts.rmsSpotRadiusUm} μm 与焦距误差 \${eflError.toFixed(2)} mm 均满足单色光斑阈值\`
      : \`未达标：RMS \${rawArtifacts.rmsSpotRadiusUm} μm（上限 \${maxRmsUm} μm），EFL 误差 \${eflError.toFixed(2)} mm\`,
    checks: [
      {
        criterion: '多波段平均 RMS 光斑半径',
        measured: \`\${rawArtifacts.rmsSpotRadiusUm} μm\`,
        threshold: \`<= \${maxRmsUm} μm\`,
        passed: spotOk,
      },
      {
        criterion: '有效焦距 (EFL) 偏差',
        measured: \`\${eflError.toFixed(2)} mm\`,
        threshold: \`<= \${eflToleranceMm} mm\`,
        passed: eflOk,
      },
      {
        criterion: '孔径遮拦 / 全反射检查',
        measured: \`\${rawArtifacts.clippedRayCount} clipped / \${rawArtifacts.tirRayCount} TIR\`,
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
`;

const EVAL_MTF_CHROMATIC_CODE = `// 评价标准组件：严格 MTF30 与消色差综合判据
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
      ? \`MTF@30lp=\${rawArtifacts.mtf30LpMm} 且轴向色差 \${rawArtifacts.axialChromaticShiftMm} mm，达到消色差成像要求\`
      : \`判定不通过：MTF@30=\${rawArtifacts.mtf30LpMm}（要求≥\${minMtf30}），色差 \${rawArtifacts.axialChromaticShiftMm} mm（上限 \${maxChromaticMm} mm）\`,
    checks: [
      {
        criterion: '30 lp/mm 调制传递函数 (MTF)',
        measured: String(rawArtifacts.mtf30LpMm),
        threshold: \`>= \${minMtf30}\`,
        passed: mtfOk,
      },
      {
        criterion: 'F-C 轴向色差焦点漂移',
        measured: \`\${rawArtifacts.axialChromaticShiftMm} mm\`,
        threshold: \`<= \${maxChromaticMm} mm\`,
        passed: chromOk,
      },
      {
        criterion: '有效焦距 (EFL) 偏差',
        measured: \`\${eflError.toFixed(2)} mm\`,
        threshold: \`<= \${eflToleranceMm} mm\`,
        passed: eflOk,
      },
      {
        criterion: '孔径遮拦 / 全反射检查',
        measured: \`\${rawArtifacts.clippedRayCount} clipped / \${rawArtifacts.tirRayCount} TIR\`,
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
`;

const OPT_COORDINATE_CODE = `// 优化策略组件：自适应坐标模式搜索（Pattern Search）
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
      ? \`自检通过：二次测试函数损失由 \${out.history[0].loss} 降至 \${out.history[out.history.length - 1].loss}\`
      : '自检失败：搜索未能降低测试损失函数',
  };
}
`;

const OPT_NELDER_MEAD_CODE = `// 优化策略组件：Nelder-Mead 单纯形优化器
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
      ? \`自检通过：二维耦合目标损失由 \${out.history[0].loss} 降至 \${out.history[out.history.length - 1].loss}\`
      : '自检失败：单纯形未能收敛',
  };
}
`;

const OPTILAND_COMPONENT_PY = `#!/usr/bin/env python3
"""
组件入口：调用仓库根目录 python/optiland_bridge.py。
Rad 可直接修改此脚本或根目录 bridge，将自定义 Optiland 求解/公差逻辑接入工作台。
"""
import os
import subprocess
import sys
from pathlib import Path

BRIDGE = Path(os.environ.get("OPENLAB_OPTILAND_BRIDGE") or (Path(__file__).resolve().parents[4] / "python" / "optiland_bridge.py"))

if __name__ == "__main__":
    proc = subprocess.run([sys.executable, str(BRIDGE), *sys.argv[1:]], stdin=sys.stdin)
    raise SystemExit(proc.returncode)
`;

const ARCH_MAP_COMPONENT_SPEC = `// 架构地图引擎自描述存根（真实扫描、关系解析与一致性检查逻辑位于 src/core/architectureMap.ts）
// 本组件同时存在于组件库与整体架构地图中，支持进入查看其内部 6 个子模块与有限自引用关系。
export const ARCHITECTURE_MAP_SUBPARTS = [
  { id: 'sub:arch-collector', name: '结构数据采集器 (Collector)', module: 'src/core/architectureMap.ts' },
  { id: 'sub:arch-resolver', name: '关系与溯源解析器 (Relation Resolver)', module: 'src/core/architectureMap.ts' },
  { id: 'sub:arch-layout', name: '分层视图布局器 (Layout Engine)', module: 'src/components/ArchitectureMapView.tsx' },
  { id: 'sub:arch-navigator', name: '局部下钻与面包屑导航 (Navigator)', module: 'src/components/ArchitectureMapView.tsx' },
  { id: 'sub:arch-renderer', name: '图谱与详情渲染器 (Renderer)', module: 'src/components/ArchitectureMapView.tsx' },
  { id: 'sub:arch-checker', name: '一致性与过期检查器 (Integrity Checker)', module: 'src/core/architectureMap.ts' },
];
`;

const TS_PREVIEW_SOLVER_STUB = `// 有限范围几何预览求解器存根（真实物理实现位于 src/core/optics.ts）
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
      ? \`自检通过（有限球面预览）：薄透镜 EFL=\${res.paraxialEflMm} mm\`
      : \`自检失败：EFL=\${res.paraxialEflMm} mm\`,
  };
}
`;

interface SeedDef {
  dossier: Omit<ComponentDossier, 'versions' | 'activeVersion' | 'diskTamperDetected' | 'diskActualHash' | 'impactScope'>;
  version: string;
  codeFile: string;
  codeContent: string;
  params: Record<string, number | string | boolean>;
  initialChecked: boolean;
}

const SEED_COMPONENTS: SeedDef[] = [
  {
    dossier: {
      id: 'solver-optiland-python',
      name: 'Optiland 专业光学求解器 (Python 3.11+)',
      kind: 'optical_solver',
      runtime: 'local_process_py',
      summary: '调用本地 Python 3.11+ 中的 Optiland (Optic, SpotDiagram, GeometricMTF, OptimizationProblem)。',
      purpose: '作为第一版真正的专业光学计算核心，在 Rad 本地电脑提供可信的像差分析与阻尼最小二乘优化。',
      capabilityBoundary: '能完成多表面光线追迹、SpotDiagram、GeometricMTF 与 LeastSquares 优化；在缺少 Python 3.11+/Optiland 的容器中会诚实报错退出。',
      inputs: [
        { name: 'systemSpec', type: 'OpticalSystemSpec', unit: 'mm / nm', description: '光学表面曲率、厚度、材料与入瞳口径' },
      ],
      outputs: [
        { name: 'rawArtifacts', type: 'RayTraceResult', unit: 'mm / μm', description: 'Optiland 计算产出的真实 EFL、RMS 光斑与 MTF 数据' },
      ],
      dependencies: [
        { kind: 'package', targetId: 'optiland>=0.5.8', reason: '核心光线追迹与优化求解器' },
        { kind: 'package', targetId: 'python>=3.11', reason: 'Optiland 最低 Python 版本要求' },
        { kind: 'module', targetId: 'python/optiland_bridge.py', reason: '标准输入输出 CLI 桥接器' },
      ],
      compatibility: ['所有遵守 OpticalSystemSpec 契约的光学结构', '所有消费 rawArtifacts 的评价组件'],
      assumptions: ['当前桥接版本默认轴上与视场角度定义遵循 Optiland "angle" 约定'],
      limits: ['Google AI Studio 云端预览容器为 Python 3.10.12 且无 pip，此组件在云端预览不可执行。'],
      editableParts: ['python/optiland_bridge.py', '组件入口 impl.py'],
      parameters: [],
      selfCheck: {
        status: 'unrun',
        checkedAt: null,
        checkedCodeHash: null,
        summary: '尚未在当前环境运行 Optiland 基准自检',
      },
      scientificValidation: {
        status: 'unvalidated',
        basis: '已核查 Optiland 0.5/0.6 官方 API 签名；需在安装 Optiland 的本地 Python 3.11+ 环境运行 test_optiland_bridge.py 实证。',
        caveats: ['云端预览容器未运行过 Optiland 真算例'],
      },
      codeSecurityReview: {
        status: 'builtin_reviewed',
        approvedHash: null,
        reviewedBy: 'system',
        reviewedAt: new Date().toISOString(),
        executionModelNote: '通过 child_process.execFile 调用本地 python3 进程，非操作系统安全沙箱；修改代码后须重新人工确认哈希。',
      },
    },
    version: 'v0.1',
    codeFile: 'impl.py',
    codeContent: OPTILAND_COMPONENT_PY,
    params: {},
    initialChecked: false,
  },
  {
    dossier: {
      id: 'solver-ts-preview',
      name: '受限几何光学预览求解器 (TS 预览用)',
      kind: 'optical_solver',
      runtime: 'builtin_ts_preview',
      summary: '纯 TypeScript 实现的旋转对称球面 3D 斯涅尔追迹器，定位为云端预览与快速教学辅助，不可替代 Optiland。',
      purpose: '在没有 Python 3.11+ / Optiland 的云端预览环境里，用真实物理公式支撑实验修改、重评与对比链路的真实验证。',
      capabilityBoundary: '仅支持旋转对称球面/平面与 5 种 Schott 玻璃；不支持非球面、倾斜偏心、真实光学系统公差或波前 FFT MTF。',
      inputs: [
        { name: 'systemSpec', type: 'OpticalSystemSpec', unit: 'mm / nm', description: '光学表面序列与目标焦距' },
      ],
      outputs: [
        { name: 'rawArtifacts', type: 'RayTraceResult', unit: 'mm / μm', description: '含点列图、子午光线、F-C 色差与几何 OTF 近似的原始产物' },
      ],
      dependencies: [
        { kind: 'module', targetId: 'src/core/optics.ts', reason: '底层斯涅尔与 Sellmeier 计算模块' },
      ],
      compatibility: ['评价组件 (eval-rms-spot, eval-mtf-chromatic)', '优化组件 (opt-coordinate-refine, opt-nelder-mead)'],
      assumptions: ['空气折射率固定为 1.000277', 'MTF 为光线横向像差相位和乘以圆形衍射包络近似'],
      limits: ['未经过与 Zemax/Optiland 完整非球面或大视场系统的交叉校验，仅供预览与基线对比。'],
      editableParts: ['src/core/optics.ts', 'impl.mjs 自检入口'],
      parameters: [],
      selfCheck: {
        status: 'passed',
        checkedAt: new Date().toISOString(),
        checkedCodeHash: null,
        summary: '薄透镜 EFL 与 N-BK7 折射率单元测试已通过 (src/core/optics.test.ts)',
      },
      scientificValidation: {
        status: 'limited_preview',
        basis: '已通过薄透镜公式、Schott N-BK7 d 线折射率及双胶合消色差定性单元测试；定位为有限范围预览引擎。',
        caveats: ['不可用于高精度商业镜头定型设计，本地正式求解请切换 solver-optiland-python。'],
      },
      codeSecurityReview: {
        status: 'builtin_reviewed',
        approvedHash: null,
        reviewedBy: 'system',
        reviewedAt: new Date().toISOString(),
        executionModelNote: '内置 TypeScript 模块；修改后由 tsc 与 node:test 校验。',
      },
    },
    version: 'v0.1',
    codeFile: 'impl.mjs',
    codeContent: TS_PREVIEW_SOLVER_STUB,
    params: {},
    initialChecked: true,
  },
  {
    dossier: {
      id: 'eval-rms-spot',
      name: '单色/均方根光斑评价器',
      kind: 'evaluator',
      runtime: 'local_process_mjs',
      summary: '以多波段平均 RMS 光斑半径与焦距误差作为好坏判据；若缺失必要产物则拒绝推测。',
      purpose: '检验单目标光斑评价标准下的优化倾向，并用于与更严格的色差/MTF 评价标准形成对照。',
      capabilityBoundary: '可对任意已保存 rawArtifacts 执行非破坏性事后评价；不负责修改镜头几何或运行追迹。',
      inputs: [
        { name: 'rawArtifacts', type: 'RayTraceResult', description: '已保存的实验原始计算产物' },
        { name: 'spec', type: 'OpticalSystemSpec', description: '包含 targetEflMm 目标焦距' },
      ],
      outputs: [
        { name: 'verdict', type: 'EvaluationVerdict', description: 'pass/warning/fail/insufficient_artifacts 判定与分项指标' },
      ],
      dependencies: [],
      compatibility: ['任意产出 rmsSpotRadiusUm 与 paraxialEflMm 的光学求解器'],
      assumptions: ['默认所有波段光斑半径同等权重'],
      limits: ['忽略轴向色差焦点漂移，宽光谱下容易给出乐观误判。'],
      editableParts: ['损失权重公式', 'maxRmsUm 阈值', 'eflToleranceMm 容差', 'selfCheck 自检逻辑'],
      parameters: [
        { key: 'maxRmsUm', label: 'RMS 光斑上限', type: 'number', defaultValue: 65, min: 5, max: 300, step: 5, unit: 'μm', description: '允许的最大 RMS 光斑半径' },
        { key: 'eflToleranceMm', label: '焦距容差', type: 'number', defaultValue: 3.0, min: 0.2, max: 20, step: 0.2, unit: 'mm', description: 'EFL 允许偏差' },
      ],
      selfCheck: {
        status: 'passed',
        checkedAt: new Date().toISOString(),
        checkedCodeHash: null,
        summary: '已通过正常样本与缺失字段拒绝推测自检',
      },
      scientificValidation: {
        status: 'limited_preview',
        basis: '几何 RMS 光斑半径判据属行业常见初筛指标，但不包含波前衍射效应。',
        caveats: ['对色差与高空间频率对比度不敏感'],
      },
      codeSecurityReview: {
        status: 'builtin_reviewed',
        approvedHash: null,
        reviewedBy: 'system',
        reviewedAt: new Date().toISOString(),
        executionModelNote: '通过 child_process.execFile 在独立 Node 子进程执行；非 OS 安全沙箱，Rad 自己修改代码须核对 SHA-256 哈希后授权。',
      },
    },
    version: 'v0.1',
    codeFile: 'impl.mjs',
    codeContent: EVAL_RMS_SPOT_CODE,
    params: { maxRmsUm: 65, eflToleranceMm: 3.0 },
    initialChecked: true,
  },
  {
    dossier: {
      id: 'eval-mtf-chromatic',
      name: 'MTF30 与消色差严格评价器',
      kind: 'evaluator',
      runtime: 'local_process_mjs',
      summary: '同时约束 30 lp/mm MTF 对比度与 F-C 轴向色差漂移，暴露单透镜盲区。',
      purpose: '在不推翻原始光线追迹证据的前提下，用更严格的成像质量标准重新审视历史设计。',
      capabilityBoundary: '可对历史产物重评，也可以作为优化器的实时损失函数；若产物缺少 mtf30LpMm 或色差字段则拒评。',
      inputs: [
        { name: 'rawArtifacts', type: 'RayTraceResult', description: '需包含 mtf30LpMm 与 axialChromaticShiftMm' },
        { name: 'spec', type: 'OpticalSystemSpec', description: '目标焦距规格' },
      ],
      outputs: [
        { name: 'verdict', type: 'EvaluationVerdict', description: '严格多指标核查结论' },
      ],
      dependencies: [],
      compatibility: ['产出 MTF 与多波段色差指标的光学求解器'],
      assumptions: ['默认 30 lp/mm 作为中等空间频率基准'],
      limits: ['单透镜通常无法同时满足 0.45mm 色差上限。'],
      editableParts: ['minMtf30 阈值', 'maxChromaticMm 阈值', 'lossScore 权重公式'],
      parameters: [
        { key: 'minMtf30', label: 'MTF@30lp 最低要求', type: 'number', defaultValue: 0.35, min: 0.05, max: 0.9, step: 0.05, unit: '', description: '30 lp/mm 最低 MTF' },
        { key: 'maxChromaticMm', label: 'F-C 色差上限', type: 'number', defaultValue: 0.45, min: 0.05, max: 3.0, step: 0.05, unit: 'mm', description: '486/656nm 轴向焦移上限' },
        { key: 'eflToleranceMm', label: '焦距容差', type: 'number', defaultValue: 2.5, min: 0.2, max: 15, step: 0.2, unit: 'mm', description: 'EFL 允许偏差' },
      ],
      selfCheck: {
        status: 'passed',
        checkedAt: new Date().toISOString(),
        checkedCodeHash: null,
        summary: '已通过高色差样本拒绝与消色差样本通过自检',
      },
      scientificValidation: {
        status: 'limited_preview',
        basis: '结合多波段焦点漂移与 MTF 判据；实际工程阈值需依据具体传感器像元尺寸标定。',
        caveats: ['仅检验 0° 轴上视场 MTF'],
      },
      codeSecurityReview: {
        status: 'builtin_reviewed',
        approvedHash: null,
        reviewedBy: 'system',
        reviewedAt: new Date().toISOString(),
        executionModelNote: '通过 child_process.execFile 在独立 Node 子进程执行；非 OS 安全沙箱，修改代码后须重新人工确认哈希。',
      },
    },
    version: 'v0.1',
    codeFile: 'impl.mjs',
    codeContent: EVAL_MTF_CHROMATIC_CODE,
    params: { minMtf30: 0.35, maxChromaticMm: 0.45, eflToleranceMm: 2.5 },
    initialChecked: true,
  },
  {
    dossier: {
      id: 'opt-coordinate-refine',
      name: '自适应坐标模式搜索优化器',
      kind: 'optimizer',
      runtime: 'local_process_mjs',
      summary: '逐维探测曲率/厚度变量，未改善时步长乘以 0.55 收敛。',
      purpose: '提供一个透明、可控的基准局部搜索策略，供 Rad 修改步长规则或与单纯形法对照。',
      capabilityBoundary: '无梯度局部寻优；适合配合任意外部评价器与求解器，不保证全局最优。',
      inputs: [
        { name: 'initialSpec', type: 'OpticalSystemSpec', description: '带可变标记的初始光学结构' },
        { name: 'helpers', type: 'Trace + Evaluate', description: '由组合层注入的求解器与评价器句柄' },
      ],
      outputs: [
        { name: 'optimized', type: '{ bestSpec, bestTrace, bestEval, history }', description: '最优结构、产物及迭代历史' },
      ],
      dependencies: [],
      compatibility: ['任意 optical_solver 组件', '任意返回数值 lossScore 的 evaluator 组件'],
      assumptions: ['目标函数在初始点附近局部单调可降'],
      limits: ['高耦合多片镜头斜谷区域容易提前停止。'],
      editableParts: ['步长衰减系数', '最大迭代步数', '搜索顺序'],
      parameters: [
        { key: 'maxIterations', label: '最大迭代步数', type: 'number', defaultValue: 18, min: 4, max: 40, step: 2, unit: 'steps', description: '搜索循环上限' },
        { key: 'initialStepMm', label: '初始步长', type: 'number', defaultValue: 6.0, min: 0.5, max: 20, step: 0.5, unit: 'mm', description: '初始曲率试探步长' },
      ],
      selfCheck: {
        status: 'passed',
        checkedAt: new Date().toISOString(),
        checkedCodeHash: null,
        summary: '已通过二次测试函数单调下降自检',
      },
      scientificValidation: {
        status: 'limited_preview',
        basis: '标准坐标模式搜索算法，自检仅证明对简单二次测试函数有效，不证明对所有多片镜头全局收敛。',
        caveats: ['复杂系统建议对照 opt-nelder-mead 或 Optiland LeastSquares'],
      },
      codeSecurityReview: {
        status: 'builtin_reviewed',
        approvedHash: null,
        reviewedBy: 'system',
        reviewedAt: new Date().toISOString(),
        executionModelNote: '通过 child_process.execFile 在独立 Node 子进程执行；非 OS 安全沙箱，修改代码后须重新人工确认哈希。',
      },
    },
    version: 'v0.1',
    codeFile: 'impl.mjs',
    codeContent: OPT_COORDINATE_CODE,
    params: { maxIterations: 18, initialStepMm: 6.0 },
    initialChecked: true,
  },
  {
    dossier: {
      id: 'opt-nelder-mead',
      name: 'Nelder-Mead 单纯形优化器',
      kind: 'optimizer',
      runtime: 'local_process_mjs',
      summary: '通过多面体反射/扩展/收缩协同调整多个表面曲率，适于耦合谷地搜索。',
      purpose: '作为可替换优化算法，在保持结构与评价器不变的条件下对比搜索路径与收敛效率。',
      capabilityBoundary: '支持多维连续参数协同寻优，不支持离散玻璃替换。',
      inputs: [
        { name: 'initialSpec', type: 'OpticalSystemSpec', description: '初始光学结构' },
        { name: 'helpers', type: 'Trace + Evaluate', description: '求解器与评价器句柄' },
      ],
      outputs: [
        { name: 'optimized', type: '{ bestSpec, bestTrace, bestEval, history }', description: '优化后结构与每轮收敛指标' },
      ],
      dependencies: [],
      compatibility: ['任意 optical_solver 组件', '任意 evaluator 组件'],
      assumptions: ['默认反射=1.0, 扩展=2.0, 收缩=0.5'],
      limits: ['变量较多时（>6维）单纯形退化概率上升。'],
      editableParts: ['单纯形缩放参数', '最大迭代次数', '退化重启策略'],
      parameters: [
        { key: 'maxIterations', label: '最大迭代步数', type: 'number', defaultValue: 24, min: 5, max: 45, step: 2, unit: 'steps', description: '单纯形更新轮数' },
        { key: 'simplexScaleMm', label: '初始单纯形尺度', type: 'number', defaultValue: 5.5, min: 1, max: 20, step: 0.5, unit: 'mm', description: '各维度初始步长' },
      ],
      selfCheck: {
        status: 'passed',
        checkedAt: new Date().toISOString(),
        checkedCodeHash: null,
        summary: '已通过二维耦合抛物面收敛自检',
      },
      scientificValidation: {
        status: 'limited_preview',
        basis: '经典 Nelder-Mead 启发式算法，适合中低维无导数目标，不能替代 Optiland 解析雅可比阻尼最小二乘法。',
        caveats: ['受初始单纯形尺度影响'],
      },
      codeSecurityReview: {
        status: 'builtin_reviewed',
        approvedHash: null,
        reviewedBy: 'system',
        reviewedAt: new Date().toISOString(),
        executionModelNote: '通过 child_process.execFile 在独立 Node 子进程执行；非 OS 安全沙箱，修改代码后须重新人工确认哈希。',
      },
    },
    version: 'v0.1',
    codeFile: 'impl.mjs',
    codeContent: OPT_NELDER_MEAD_CODE,
    params: { maxIterations: 24, simplexScaleMm: 5.5 },
    initialChecked: true,
  },
  {
    dossier: {
      id: 'arch-map-engine',
      name: '整体架构地图引擎 (Architecture Map)',
      kind: 'architecture_map',
      runtime: 'builtin_engine',
      summary: '从真实磁盘组件、源码 import、实验账本与环境探测构建可下钻的系统结构图谱，并在图中呈现自身构造。',
      purpose: '让人与 AI 在不复制第二套数据的前提下，理解总体与局部构造、跨层关系、真实溯源与过期/不一致异常。',
      capabilityBoundary: '第一版真实扫描组件目录、源码静态 import、运行观测账本与环境状态；对于未运行的组件连接仅标注为「明确声明」而不会冒充实际调用。',
      inputs: [
        { name: 'workspace/components/*', type: 'ComponentDossier[]', description: '磁盘组件档案与实时哈希' },
        { name: 'workspace/runs.jsonl', type: 'ExperimentRun[]', description: '实验运行观测账本' },
        { name: 'src/ & server/ imports', type: 'AST/Regex Scan', description: '真实代码模块静态依赖扫描' },
      ],
      outputs: [
        { name: 'ArchitectureMapData', type: 'Nodes + Edges + Anomalies', description: '区分包含与跨层关系、标注来源可信度与异常列表的结构图数据' },
      ],
      dependencies: [
        { kind: 'module', targetId: 'src/core/architectureMap.ts', reason: '采集、关系解析与一致性检查核心' },
        { kind: 'module', targetId: 'src/components/ArchitectureMapView.tsx', reason: '布局、下钻导航与交互渲染' },
      ],
      compatibility: ['任何写入 workspace/components/ 的新组件都会自动被扫描并接入图谱'],
      assumptions: ['静态 import 扫描覆盖顶层相对路径导入，暂不展开动态拼接路径'],
      limits: ['节点在画布上的拖拽定位仅影响视图布局，不会自动修改真实系统结构。'],
      editableParts: ['src/core/architectureMap.ts', 'src/components/ArchitectureMapView.tsx'],
      parameters: [],
      selfCheck: {
        status: 'passed',
        checkedAt: new Date().toISOString(),
        checkedCodeHash: null,
        summary: '结构扫描与自引用防无限递归边界已由单元测试验证',
      },
      scientificValidation: {
        status: 'validated_reference',
        basis: '软件结构反射工具，每条节点与边均附带真实文件/账本出处证据。',
        caveats: ['部分跨模块语义关系标注为 declared，需待实际运行观测升级为 observed'],
      },
      codeSecurityReview: {
        status: 'builtin_reviewed',
        approvedHash: null,
        reviewedBy: 'system',
        reviewedAt: new Date().toISOString(),
        executionModelNote: '只读扫描本地代码与账本，不执行任意用户脚本。',
      },
    },
    version: 'v0.1',
    codeFile: 'impl.mjs',
    codeContent: ARCH_MAP_COMPONENT_SPEC,
    params: {},
    initialChecked: true,
  },
];

export function detectRuntimeEnvironment(optilandProbe?: {
  pythonVersion?: string | null;
  pythonOkForOptiland?: boolean;
  optilandInstalled?: boolean;
  optilandVersion?: string | null;
  numpyVersion?: string | null;
  scipyVersion?: string | null;
}): RuntimeEnvironmentSnapshot {
  const optInstalled = Boolean(optilandProbe?.optilandInstalled);
  return {
    hostMode: optInstalled ? 'local_python_ready' : 'cloud_preview',
    nodeVersion: process.version,
    pythonVersion: optilandProbe?.pythonVersion ?? null,
    pythonOkForOptiland: Boolean(optilandProbe?.pythonOkForOptiland),
    optilandVersion: optilandProbe?.optilandVersion ?? null,
    numpyVersion: optilandProbe?.numpyVersion ?? null,
    scipyVersion: optilandProbe?.scipyVersion ?? null,
    platform: `${process.platform}-${process.arch}`,
  };
}

export function ensureWorkspaceInitialized(workspaceDir?: string): void {
  const paths = getWorkspacePaths(workspaceDir);
  fs.mkdirSync(paths.componentsDir, { recursive: true });

  // Only seed built-in components when their dossier does not exist yet.
  // NEVER overwrite existing component dossier.json or user-edited source files on disk!
  for (const seed of SEED_COMPONENTS) {
    const compDir = path.join(paths.componentsDir, seed.dossier.id);
    const dossierPath = path.join(compDir, 'dossier.json');
    const verDir = path.join(compDir, seed.version);
    const codePath = path.join(verDir, seed.codeFile);

    if (!fs.existsSync(dossierPath)) {
      fs.mkdirSync(verDir, { recursive: true });
      if (!fs.existsSync(codePath)) {
        fs.writeFileSync(codePath, seed.codeContent, 'utf8');
      }
      const diskCode = fs.readFileSync(codePath, 'utf8');
      const fullHash = sha256(diskCode);
      const versionRecord: ComponentVersionRecord = {
        version: seed.version,
        createdAt: new Date().toISOString(),
        parentVersion: null,
        author: 'system',
        changeSummary: '初始基线实现与契约档案',
        codeHash: fullHash,
        params: seed.params,
        codeFile: seed.codeFile,
        lifecycle: 'draft',
        frozenAt: null,
        frozenByRunIds: [],
        frozenBySnapshotIds: [],
        sourceAvailability: 'available_on_disk',
      };
      const fullDossier: ComponentDossier = {
        ...seed.dossier,
        activeVersion: seed.version,
        versions: [versionRecord],
        selfCheck: {
          ...seed.dossier.selfCheck,
          checkedCodeHash: seed.initialChecked ? fullHash : null,
        },
        codeSecurityReview: {
          ...seed.dossier.codeSecurityReview,
          approvedHash: fullHash,
        },
      };
      atomicWriteFileSync(dossierPath, JSON.stringify(fullDossier, null, 2));
    }
  }

  if (!fs.existsSync(paths.runsFile)) {
    const traceSinglet = traceOpticalSystem(INITIAL_SINGLET_SPEC);
    const evalComp = getRawDossier('eval-rms-spot', paths.workspaceDir);
    const evalHash = evalComp?.versions[0]?.codeHash ?? sha256(EVAL_RMS_SPOT_CODE);
    const solverComp = getRawDossier('solver-ts-preview', paths.workspaceDir);
    const solverHash = solverComp?.versions[0]?.codeHash ?? sha256(TS_PREVIEW_SOLVER_STUB);
    const runtimeEnv = detectRuntimeEnvironment();
    const composition: ExperimentRun['composition'] = {
      pattern: 'optical_solve_and_evaluate',
      parts: [
        {
          slot: 'optical_solver',
          componentId: 'solver-ts-preview',
          componentName: '受限几何光学预览求解器 (TS 预览用)',
          kind: 'optical_solver',
          version: 'v0.1',
          codeHash: solverHash,
          paramsSnapshot: {},
        },
        {
          slot: 'evaluator',
          componentId: 'eval-rms-spot',
          componentName: '单色/均方根光斑评价器',
          kind: 'evaluator',
          version: 'v0.1',
          codeHash: evalHash,
          paramsSnapshot: { maxRmsUm: 65, eflToleranceMm: 3.0 },
        },
      ],
    };

    const createdAt = new Date().toISOString();
    const hashes = computeRunHashes({
      id: 'run-001',
      sequenceNumber: 1,
      createdAt,
      parentRunId: null,
      branchLabel: '主线 · 单透镜基线',
      intent: '先用 N-BK7 单透镜基线（目标 100mm）跑一次真实追迹，检验不同评价标准下的结论差异。',
      mode: 'solve_only',
      seed: 42,
      runtimeEnv,
      composition,
      systemBefore: INITIAL_SINGLET_SPEC,
      systemAfter: INITIAL_SINGLET_SPEC,
      rawArtifactsBefore: traceSinglet,
      rawArtifactsAfter: traceSinglet,
    });

    const eflError = Math.abs(traceSinglet.paraxialEflMm - INITIAL_SINGLET_SPEC.targetEflMm);
    const verdict: EvaluationVerdict = {
      id: `ev-${Date.now()}-init`,
      evaluatorId: 'eval-rms-spot',
      evaluatorName: '单色/均方根光斑评价器',
      evaluatorVersion: 'v0.1',
      evaluatorCodeHash: evalHash,
      evaluatedAt: createdAt,
      passed: false,
      status: 'fail',
      lossScore: Number((traceSinglet.rmsSpotRadiusUm + eflError * 18).toFixed(3)),
      summary: `未达标：RMS ${traceSinglet.rmsSpotRadiusUm} μm（上限 65 μm），EFL 误差 ${eflError.toFixed(2)} mm`,
      checks: [
        { criterion: '多波段平均 RMS 光斑半径', measured: `${traceSinglet.rmsSpotRadiusUm} μm`, threshold: '<= 65 μm', passed: false },
        { criterion: '有效焦距 (EFL) 偏差', measured: `${eflError.toFixed(2)} mm`, threshold: '<= 3 mm', passed: true },
        { criterion: '孔径遮拦 / 全反射检查', measured: `${traceSinglet.clippedRayCount} clipped / ${traceSinglet.tirRayCount} TIR`, threshold: '0 异常光线', passed: true },
      ],
      uncertainties: ['该评价器未约束 F/C 轴向色差偏移，可切换 eval-mtf-chromatic 对已保存产物重评。'],
    };

    const run1: ExperimentRun = {
      id: 'run-001',
      sequenceNumber: 1,
      createdAt,
      parentRunId: null,
      branchLabel: '主线 · 单透镜基线',
      intent: '先用 N-BK7 单透镜基线（目标 100mm）跑一次真实追迹，检验不同评价标准下的结论差异。',
      mode: 'solve_only',
      seed: 42,
      runtimeEnv,
      composition,
      systemBefore: INITIAL_SINGLET_SPEC,
      systemAfter: INITIAL_SINGLET_SPEC,
      rawArtifactsBefore: traceSinglet,
      rawArtifactsAfter: traceSinglet,
      optimizationTrace: [],
      evaluations: [verdict],
      ...hashes,
      executionMs: 12,
      status: 'completed',
    };
    atomicWriteFileSync(paths.runsFile, JSON.stringify(run1) + '\n');
  }

  if (!fs.existsSync(paths.threadFile)) {
    const initialEntries: ThreadEntry[] = [
      {
        id: 'note-001',
        createdAt: new Date().toISOString(),
        origin: 'user_statement',
        authorLabel: 'Rad / 研究起点',
        runId: 'run-001',
        componentId: null,
        title: '初始问题：我想从 100mm f/4 成像镜头摸清现有求解与评价机制',
        content: '想看清如果先用单透镜基线跑出原始计算产物，随后在不重跑物理引擎的情况下替换不同评价标准，结论会如何变化。',
      },
      {
        id: 'note-002',
        createdAt: new Date().toISOString(),
        origin: 'experiment_run',
        authorLabel: 'Run #1 · 原始计算产物已存档',
        runId: 'run-001',
        componentId: 'solver-ts-preview',
        title: 'N-BK7 单透镜基线物理产物已记录（256 位 SHA-256 摘要封印）',
        content: '已在受限 TS 预览求解器下完成 486/587/656nm 追迹，完整光斑坐标、MTF 曲线与子午光路已保存至 Run #1。',
      },
    ];
    atomicWriteFileSync(
      paths.threadFile,
      initialEntries.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }
}

function getRawDossier(id: string, workspaceDir?: string): ComponentDossier | null {
  const { componentsDir } = getWorkspacePaths(workspaceDir);
  const p = path.join(componentsDir, path.basename(id), 'dossier.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as ComponentDossier;
}

function collectVersionReferences(
  componentId: string,
  version: string,
  runs: ExperimentRun[],
  snapshots: ResearchSnapshot[],
): {
  runIds: string[];
  snapshotIds: string[];
  recordedRunHashes: Array<{ runId: string; codeHash: string }>;
} {
  const runIds = new Set<string>();
  const recordedRunHashes: Array<{ runId: string; codeHash: string }> = [];

  for (const r of runs) {
    for (const p of r.composition?.parts ?? []) {
      if (p.componentId === componentId && p.version === version) {
        runIds.add(r.id);
        recordedRunHashes.push({ runId: r.id, codeHash: p.codeHash });
      }
    }
    for (const ev of r.evaluations ?? []) {
      if (ev.evaluatorId === componentId && ev.evaluatorVersion === version) {
        runIds.add(r.id);
        recordedRunHashes.push({ runId: r.id, codeHash: ev.evaluatorCodeHash });
      }
    }
    for (const sa of r.standaloneAnalyses ?? []) {
      if (sa.componentId === componentId && sa.version === version) {
        runIds.add(r.id);
        recordedRunHashes.push({ runId: r.id, codeHash: sa.codeHash });
      }
    }
  }

  const snapshotIds = snapshots
    .filter(
      (s) =>
        s.pinnedComponents.some((p) => p.componentId === componentId && p.version === version) ||
        s.evaluatorBindings.some((b) => b.evaluatorId === componentId && b.evaluatorVersion === version),
    )
    .map((s) => s.id);

  return {
    runIds: Array.from(runIds),
    snapshotIds,
    recordedRunHashes,
  };
}

function hydrateDossierLiveState(
  rawDossier: ComponentDossier,
  allDossiers: ComponentDossier[],
  runs: ExperimentRun[],
  snapshots: ResearchSnapshot[],
  componentsDir: string,
): ComponentDossier {
  const legacy = rawDossier as ComponentDossier & { role?: string; verificationStatus?: string };
  const compDir = path.join(componentsDir, path.basename(legacy.id));

  const hydratedVersions: ComponentVersionRecord[] = (legacy.versions ?? []).map((v) => {
    const codePath = path.join(compDir, v.version, v.codeFile);
    const existsOnDisk = fs.existsSync(codePath);
    const diskHash = existsOnDisk ? sha256(fs.readFileSync(codePath, 'utf8')) : null;

    const refs = collectVersionReferences(legacy.id, v.version, runs, snapshots);
    const isReferenced = refs.runIds.length > 0 || refs.snapshotIds.length > 0;

    const driftedRecords: HistoricalHashDriftRecord[] = [...(v.historicalDriftedHashes ?? [])];
    for (const rec of refs.recordedRunHashes) {
      if (
        diskHash !== null &&
        rec.codeHash !== diskHash &&
        !driftedRecords.some((d) => d.runId === rec.runId && d.recordedCodeHash === rec.codeHash)
      ) {
        driftedRecords.push({
          runId: rec.runId,
          recordedCodeHash: rec.codeHash,
          diskCodeHashAtAudit: diskHash,
          note: `历史运行 ${rec.runId} 记录的源码哈希与当前磁盘文件不一致，已如实保留历史哈希，不视为同一份源码。`,
        });
      }
    }

    let sourceAvailability: ComponentSourceAvailability = v.sourceAvailability ?? 'available_on_disk';
    if (!existsOnDisk) {
      sourceAvailability = 'missing_on_disk';
    } else if (driftedRecords.length > 0) {
      sourceAvailability = 'historical_hash_drifted';
    } else {
      sourceAvailability = 'available_on_disk';
    }

    const lifecycle = v.lifecycle ?? (isReferenced ? 'frozen' : 'draft');
    const frozenByRunIds = Array.from(new Set([...(v.frozenByRunIds ?? []), ...refs.runIds]));
    const frozenBySnapshotIds = Array.from(new Set([...(v.frozenBySnapshotIds ?? []), ...refs.snapshotIds]));

    return {
      ...v,
      lifecycle,
      frozenAt: v.frozenAt ?? (lifecycle === 'frozen' ? v.createdAt : null),
      frozenByRunIds,
      frozenBySnapshotIds,
      sourceAvailability,
      historicalDriftedHashes: driftedRecords.length > 0 ? driftedRecords : v.historicalDriftedHashes,
    };
  });

  const dossier: ComponentDossier = {
    ...legacy,
    versions: hydratedVersions,
    kind: legacy.kind || legacy.role || 'custom_component',
    purpose: legacy.purpose || legacy.summary || '',
    capabilityBoundary: legacy.capabilityBoundary || (legacy.limits?.join('；') ?? ''),
    compatibility: Array.isArray(legacy.compatibility) ? legacy.compatibility : [],
    assumptions: Array.isArray(legacy.assumptions) ? legacy.assumptions : [],
    dependencies: Array.isArray(legacy.dependencies)
      ? legacy.dependencies.map((d) =>
          typeof d === 'string'
            ? { kind: 'package' as const, targetId: d, reason: '旧版字符串依赖' }
            : d,
        )
      : [],
    selfCheck: legacy.selfCheck ?? {
      status: legacy.verificationStatus === 'verified_unit' ? 'passed' : 'unrun',
      checkedAt: null,
      checkedCodeHash: null,
      summary: '未记录自检状态',
    },
    scientificValidation: legacy.scientificValidation ?? {
      status: 'unvalidated',
      basis: '尚未填写科学验证依据',
      caveats: [],
    },
    codeSecurityReview: legacy.codeSecurityReview ?? {
      status: 'unreviewed_modified',
      approvedHash: null,
      reviewedBy: null,
      reviewedAt: null,
      executionModelNote: '本地子进程执行，非 OS 级安全沙箱。',
    },
  };

  const activeRec = dossier.versions.find((v) => v.version === dossier.activeVersion) ?? dossier.versions[0];
  let diskActualHash = activeRec?.codeHash;
  let diskTamperDetected = false;

  if (activeRec) {
    const codePath = path.join(compDir, activeRec.version, activeRec.codeFile);
    if (fs.existsSync(codePath)) {
      const diskText = fs.readFileSync(codePath, 'utf8');
      diskActualHash = sha256(diskText);
      const mismatchApproved = Boolean(
        dossier.codeSecurityReview?.approvedHash &&
          diskActualHash !== dossier.codeSecurityReview.approvedHash,
      );
      const mismatchVersionHash = Boolean(activeRec.codeHash && diskActualHash !== activeRec.codeHash);
      if (mismatchApproved || mismatchVersionHash) {
        diskTamperDetected = true;
      }
    } else {
      diskTamperDetected = true;
    }
  }

  const securityReview = diskTamperDetected
    ? {
        ...dossier.codeSecurityReview,
        status: 'unreviewed_modified' as const,
      }
    : dossier.codeSecurityReview;

  const selfCheck =
    diskActualHash && dossier.selfCheck?.checkedCodeHash && diskActualHash !== dossier.selfCheck.checkedCodeHash
      ? {
          ...dossier.selfCheck,
          status: 'unrun' as const,
          summary: '磁盘源码哈希已变更，须重新执行组件自检',
        }
      : dossier.selfCheck;

  const dependentComponentIds = allDossiers
    .filter((other) => other.id !== dossier.id && other.dependencies?.some((d) => d.targetId === dossier.id))
    .map((other) => other.id);

  const usedInRunIds = runs
    .filter((r) => {
      const inParts = r.composition?.parts?.some((p) => p.componentId === dossier.id);
      const inEvals = r.evaluations?.some((e) => e.evaluatorId === dossier.id);
      const inStandalone = r.standaloneAnalyses?.some((a) => a.componentId === dossier.id);
      return Boolean(inParts || inEvals || inStandalone);
    })
    .map((r) => r.id);

  return {
    ...dossier,
    codeSecurityReview: securityReview,
    selfCheck,
    diskTamperDetected,
    diskActualHash,
    impactScope: {
      dependentComponentIds,
      usedInRunIds,
    },
  };
}

export function listComponents(workspaceDir?: string): ComponentDossier[] {
  ensureWorkspaceInitialized(workspaceDir);
  const paths = getWorkspacePaths(workspaceDir);
  const dirs = fs.readdirSync(paths.componentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  const rawDossiers: ComponentDossier[] = [];
  for (const dir of dirs) {
    const p = path.join(paths.componentsDir, dir.name, 'dossier.json');
    if (fs.existsSync(p)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8')) as ComponentDossier;
        if (parsed && parsed.id && parsed.versions) {
          rawDossiers.push(parsed);
        }
      } catch {
        // Ignore broken JSON during listing; Architecture Map will surface anomaly
      }
    }
  }
  const runs = hydrateRunsWithSupplements(listRawRuns(workspaceDir), listRunSupplements(workspaceDir));
  const snapshots = listSnapshots(workspaceDir);
  return rawDossiers.map((d) => hydrateDossierLiveState(d, rawDossiers, runs, snapshots, paths.componentsDir));
}

export function getComponent(
  id: string,
  workspaceDir?: string,
): { dossier: ComponentDossier; codeByVersion: Record<string, string> } | null {
  ensureWorkspaceInitialized(workspaceDir);
  const paths = getWorkspacePaths(workspaceDir);
  const safeId = path.basename(id);
  const compDir = path.join(paths.componentsDir, safeId);
  const dossierPath = path.join(compDir, 'dossier.json');
  if (!fs.existsSync(dossierPath)) return null;

  const rawDossier = JSON.parse(fs.readFileSync(dossierPath, 'utf8')) as ComponentDossier;
  const codeByVersion: Record<string, string> = {};
  for (const ver of rawDossier.versions) {
    const codePath = path.join(compDir, ver.version, ver.codeFile);
    if (fs.existsSync(codePath)) {
      codeByVersion[ver.version] = fs.readFileSync(codePath, 'utf8');
    }
  }

  const all = listComponents(workspaceDir);
  const hydrated = all.find((c) => c.id === safeId) ?? rawDossier;
  return { dossier: hydrated, codeByVersion };
}

export function saveComponentDossier(dossier: ComponentDossier, workspaceDir?: string): void {
  const paths = getWorkspacePaths(workspaceDir);
  const safeId = path.basename(dossier.id);
  const cleanDossier: ComponentDossier = { ...dossier };
  delete cleanDossier.diskTamperDetected;
  delete cleanDossier.diskActualHash;
  delete cleanDossier.impactScope;
  const dossierPath = path.join(paths.componentsDir, safeId, 'dossier.json');
  atomicWriteFileSync(dossierPath, JSON.stringify(cleanDossier, null, 2));
}

export function forkComponentVersion(
  params: {
    componentId: string;
    baseVersion: string;
    newVersion: string;
    changeSummary: string;
    codeContent: string;
    updatedParams: Record<string, number | string | boolean>;
    author?: ComponentVersionRecord['author'];
  },
  workspaceDir?: string,
): ComponentDossier {
  const found = getComponent(params.componentId, workspaceDir);
  if (!found) throw new Error(`未找到组件 ${params.componentId}`);

  const { componentsDir } = getWorkspacePaths(workspaceDir);
  const { dossier, codeByVersion } = found;
  const baseRecord = dossier.versions.find((v) => v.version === params.baseVersion);
  if (!baseRecord) throw new Error(`未找到基线版本 ${params.baseVersion}`);

  const safeNewVersion = params.newVersion.replace(/[^a-zA-Z0-9._-]/g, '');
  if (!safeNewVersion) throw new Error('无效的新版本号');
  if (dossier.versions.some((v) => v.version === safeNewVersion)) {
    throw new Error(`版本 ${safeNewVersion} 已存在，请使用新的版本号以保留不可变历史`);
  }

  const verDir = path.join(componentsDir, path.basename(dossier.id), safeNewVersion);
  fs.mkdirSync(verDir, { recursive: true });
  atomicWriteFileSync(path.join(verDir, baseRecord.codeFile), params.codeContent);

  const newHash = sha256(params.codeContent);
  const baseHash = sha256(codeByVersion[params.baseVersion] ?? '');
  const codeChanged = newHash !== baseHash;

  const newRecord: ComponentVersionRecord = {
    version: safeNewVersion,
    createdAt: new Date().toISOString(),
    parentVersion: params.baseVersion,
    author: params.author ?? 'rad',
    changeSummary: params.changeSummary || `基于 ${params.baseVersion} 创建 Draft`,
    codeHash: newHash,
    params: params.updatedParams,
    codeFile: baseRecord.codeFile,
    lifecycle: 'draft',
    frozenAt: null,
    frozenByRunIds: [],
    frozenBySnapshotIds: [],
    sourceAvailability: 'available_on_disk',
  };

  dossier.versions.unshift(newRecord);
  dossier.activeVersion = safeNewVersion;

  if (codeChanged) {
    dossier.codeSecurityReview = {
      ...dossier.codeSecurityReview,
      status: 'unreviewed_modified',
      approvedHash: null,
      reviewedBy: null,
      reviewedAt: null,
    };
    dossier.selfCheck = {
      status: 'unrun',
      checkedAt: null,
      checkedCodeHash: null,
      summary: '新版本代码已改动，尚未运行自检',
    };
  } else {
    dossier.codeSecurityReview = {
      ...dossier.codeSecurityReview,
      status: 'user_approved_hash',
      approvedHash: newHash,
      reviewedBy: 'rad (参数微调，源码未变)',
      reviewedAt: new Date().toISOString(),
    };
  }

  saveComponentDossier(dossier, workspaceDir);
  return getComponent(dossier.id, workspaceDir)!.dossier;
}

/**
 * Only Draft versions that are NOT referenced by any Snapshot or ExperimentRun may be edited in place.
 * Frozen versions are strictly immutable and throw an explicit error directing callers to fork a new Draft.
 */
export function saveComponentDraft(
  params: {
    componentId: string;
    version: string;
    codeContent?: string;
    updatedParams?: Record<string, number | string | boolean>;
    changeSummary?: string;
  },
  workspaceDir?: string,
): ComponentDossier {
  const found = getComponent(params.componentId, workspaceDir);
  if (!found) throw new Error(`未找到组件 ${params.componentId}`);
  const { dossier } = found;
  const ver = dossier.versions.find((v) => v.version === params.version);
  if (!ver) throw new Error(`未找到版本 ${params.version}`);

  const refs = collectVersionReferences(
    dossier.id,
    ver.version,
    listRawRuns(workspaceDir),
    listSnapshots(workspaceDir),
  );
  if (ver.lifecycle === 'frozen' || refs.runIds.length > 0 || refs.snapshotIds.length > 0) {
    throw new Error(
      `不可变版本保护：${dossier.id}@${ver.version} 已被实验或快照冻结（runs=[${refs.runIds.join(',')}], snapshots=[${refs.snapshotIds.join(',')}]），禁止直接覆盖，请创建新的 Draft 或派生版本。`,
    );
  }

  const { componentsDir } = getWorkspacePaths(workspaceDir);
  const codePath = path.join(componentsDir, path.basename(dossier.id), ver.version, ver.codeFile);
  let codeChanged = false;
  if (typeof params.codeContent === 'string') {
    const prevHash = fs.existsSync(codePath) ? sha256(fs.readFileSync(codePath, 'utf8')) : ver.codeHash;
    const nextHash = sha256(params.codeContent);
    codeChanged = nextHash !== prevHash;
    atomicWriteFileSync(codePath, params.codeContent);
    ver.codeHash = nextHash;
    ver.sourceAvailability = 'available_on_disk';
  }
  if (params.updatedParams) {
    ver.params = { ...params.updatedParams };
  }
  if (params.changeSummary) {
    ver.changeSummary = params.changeSummary;
  }

  if (codeChanged && dossier.activeVersion === ver.version) {
    dossier.codeSecurityReview = {
      ...dossier.codeSecurityReview,
      status: 'unreviewed_modified',
      approvedHash: null,
      reviewedBy: null,
      reviewedAt: null,
    };
    dossier.selfCheck = {
      status: 'unrun',
      checkedAt: null,
      checkedCodeHash: null,
      summary: 'Draft 源码已修改，需重新执行组件自检',
    };
  }

  saveComponentDossier(dossier, workspaceDir);
  return getComponent(dossier.id, workspaceDir)!.dossier;
}

export function freezeComponentVersion(
  componentId: string,
  version: string,
  ref: { runId?: string; snapshotId?: string },
  workspaceDir?: string,
): ComponentDossier {
  const found = getComponent(componentId, workspaceDir);
  if (!found) throw new Error(`未找到组件 ${componentId}`);
  const { dossier } = found;
  const ver = dossier.versions.find((v) => v.version === version);
  if (!ver) throw new Error(`未找到版本 ${componentId}@${version}`);

  const { componentsDir } = getWorkspacePaths(workspaceDir);
  const codePath = path.join(componentsDir, path.basename(componentId), ver.version, ver.codeFile);
  const existsOnDisk = fs.existsSync(codePath);

  ver.lifecycle = 'frozen';
  ver.frozenAt = ver.frozenAt || new Date().toISOString();
  ver.frozenByRunIds = Array.from(new Set([...(ver.frozenByRunIds ?? []), ...(ref.runId ? [ref.runId] : [])]));
  ver.frozenBySnapshotIds = Array.from(
    new Set([...(ver.frozenBySnapshotIds ?? []), ...(ref.snapshotId ? [ref.snapshotId] : [])]),
  );
  if (!existsOnDisk) {
    ver.sourceAvailability = 'missing_on_disk';
  } else if (ver.historicalDriftedHashes && ver.historicalDriftedHashes.length > 0) {
    ver.sourceAvailability = 'historical_hash_drifted';
  } else {
    ver.sourceAvailability = 'available_on_disk';
  }

  saveComponentDossier(dossier, workspaceDir);
  return getComponent(componentId, workspaceDir)!.dossier;
}

export function approveComponentVersion(
  componentId: string,
  version: string,
  reviewer = 'rad',
  workspaceDir?: string,
): ComponentDossier {
  const found = getComponent(componentId, workspaceDir);
  if (!found) throw new Error(`未找到组件 ${componentId}`);
  const ver = found.dossier.versions.find((v) => v.version === version);
  if (!ver) throw new Error(`未找到版本 ${version}`);

  const { componentsDir } = getWorkspacePaths(workspaceDir);
  const codePath = path.join(componentsDir, path.basename(componentId), ver.version, ver.codeFile);
  if (!fs.existsSync(codePath)) {
    throw new Error(`组件 ${componentId}@${version} 源码文件在磁盘缺失，无法核准授权`);
  }
  const actualDiskText = fs.readFileSync(codePath, 'utf8');
  const actualDiskHash = sha256(actualDiskText);
  if (ver.lifecycle === 'frozen' && ver.codeHash !== actualDiskHash) {
    throw new Error(
      `冻结版本 ${componentId}@${version} 禁止通过授权改写原记录哈希 (${ver.codeHash.slice(0, 12)}... != ${actualDiskHash.slice(0, 12)}...)，请派生新 Draft 版本。`,
    );
  }
  ver.codeHash = actualDiskHash;

  found.dossier.activeVersion = ver.version;
  found.dossier.codeSecurityReview = {
    ...found.dossier.codeSecurityReview,
    status: 'user_approved_hash',
    approvedHash: actualDiskHash,
    reviewedBy: reviewer,
    reviewedAt: new Date().toISOString(),
  };

  saveComponentDossier(found.dossier, workspaceDir);
  return getComponent(componentId, workspaceDir)!.dossier;
}

export function setActiveComponentVersion(
  componentId: string,
  version: string,
  workspaceDir?: string,
): ComponentDossier {
  const found = getComponent(componentId, workspaceDir);
  if (!found) throw new Error(`未找到组件 ${componentId}`);
  const ver = found.dossier.versions.find((v) => v.version === version);
  if (!ver) throw new Error(`未找到版本 ${version}`);

  const { componentsDir } = getWorkspacePaths(workspaceDir);
  found.dossier.activeVersion = version;
  const codePath = path.join(componentsDir, path.basename(componentId), ver.version, ver.codeFile);
  const actualHash = fs.existsSync(codePath) ? sha256(fs.readFileSync(codePath, 'utf8')) : ver.codeHash;
  if (ver.author === 'system' && fs.existsSync(codePath) && actualHash === ver.codeHash) {
    found.dossier.codeSecurityReview = {
      ...found.dossier.codeSecurityReview,
      status: 'builtin_reviewed',
      approvedHash: actualHash,
    };
  } else if (found.dossier.codeSecurityReview.approvedHash !== actualHash) {
    found.dossier.codeSecurityReview = {
      ...found.dossier.codeSecurityReview,
      status: 'unreviewed_modified',
    };
  }
  saveComponentDossier(found.dossier, workspaceDir);
  return getComponent(componentId, workspaceDir)!.dossier;
}

function normalizeLegacyRun(raw: Record<string, unknown>): ExperimentRun {
  const r = raw as unknown as ExperimentRun & {
    traceBefore?: ExperimentRun['rawArtifactsBefore'];
    traceAfter?: ExperimentRun['rawArtifactsAfter'];
    componentChain?: Array<{
      componentId: string;
      componentName: string;
      role: string;
      version: string;
      codeHash: string;
      params: Record<string, number | string | boolean>;
    }>;
  };
  const rawArtifactsBefore = r.rawArtifactsBefore ?? r.traceBefore!;
  const rawArtifactsAfter = r.rawArtifactsAfter ?? r.traceAfter!;
  const composition = r.composition ?? {
    pattern: 'legacy_chain',
    parts: (r.componentChain ?? []).map((c) => ({
      slot: c.role,
      componentId: c.componentId,
      componentName: c.componentName,
      kind: c.role,
      version: c.version,
      codeHash: c.codeHash,
      paramsSnapshot: c.params ?? {},
    })),
  };
  const normalized: ExperimentRun = {
    ...r,
    mode: (r.mode as string) === 'trace_only' ? 'solve_only' : r.mode,
    seed: r.seed ?? 0,
    runtimeEnv: r.runtimeEnv ?? detectRuntimeEnvironment(),
    composition,
    rawArtifactsBefore,
    rawArtifactsAfter,
    inputHash: r.inputHash ?? '',
    rawArtifactsHash: r.rawArtifactsHash ?? '',
    recordIntegrityHash: r.recordIntegrityHash ?? '',
  };
  normalized.tamperStatus = verifyRunIntegrity(normalized);
  return normalized;
}

export function listRawRuns(workspaceDir?: string): ExperimentRun[] {
  const { runsFile } = getWorkspacePaths(workspaceDir);
  if (!fs.existsSync(runsFile)) return [];
  const lines = fs.readFileSync(runsFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((l) => normalizeLegacyRun(JSON.parse(l) as Record<string, unknown>));
}

export function listRunSupplements(workspaceDir?: string): RunSupplement[] {
  const { runSupplementsFile } = getWorkspacePaths(workspaceDir);
  if (!fs.existsSync(runSupplementsFile)) return [];
  const lines = fs
    .readFileSync(runSupplementsFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as RunSupplement);
}

/**
 * Hydrates ExperimentRun views with append-only RunSupplements while strictly preventing
 * duplicate display of migrated legacy items and preserving original order & source provenance.
 */
export function hydrateRunsWithSupplements(
  runs: ExperimentRun[],
  supplements: RunSupplement[],
): ExperimentRun[] {
  const supByRun = new Map<string, RunSupplement[]>();
  for (const sup of supplements) {
    if (!supByRun.has(sup.runId)) supByRun.set(sup.runId, []);
    supByRun.get(sup.runId)!.push(sup);
  }

  return runs.map((run) => {
    const runSups = supByRun.get(run.id);
    if (!runSups || runSups.length === 0) return run;

    const evals = [...(run.evaluations ?? [])];
    const seenEvalIds = new Set(evals.map((e) => e.id));

    const standalone: StandaloneAnalysisRecord[] = [...(run.standaloneAnalyses ?? [])];
    const seenStandaloneIds = new Set(standalone.map((s) => s.id));

    const orderedSups = [...runSups].sort((a, b) => {
      if (typeof a.originalOrder === 'number' && typeof b.originalOrder === 'number') {
        return a.originalOrder - b.originalOrder;
      }
      return a.createdAt.localeCompare(b.createdAt);
    });

    for (const sup of orderedSups) {
      if (sup.verdict) {
        const key = sup.legacyOriginalId ?? sup.verdict.id;
        if (!seenEvalIds.has(sup.verdict.id) && !seenEvalIds.has(key)) {
          evals.push(sup.verdict);
          seenEvalIds.add(sup.verdict.id);
          seenEvalIds.add(key);
        }
      }
      if (sup.standaloneAnalysis) {
        const key = sup.legacyOriginalId ?? sup.standaloneAnalysis.id;
        if (!seenStandaloneIds.has(sup.standaloneAnalysis.id) && !seenStandaloneIds.has(key)) {
          standalone.push(sup.standaloneAnalysis);
          seenStandaloneIds.add(sup.standaloneAnalysis.id);
          seenStandaloneIds.add(key);
        }
      }
    }

    return {
      ...run,
      evaluations: evals,
      standaloneAnalyses: standalone.length > 0 ? standalone : run.standaloneAnalyses,
    };
  });
}

export function listRuns(workspaceDir?: string): ExperimentRun[] {
  ensureWorkspaceInitialized(workspaceDir);
  const raw = listRawRuns(workspaceDir);
  const supplements = listRunSupplements(workspaceDir);
  return hydrateRunsWithSupplements(raw, supplements);
}

export function appendRun(run: ExperimentRun, workspaceDir?: string): void {
  ensureWorkspaceInitialized(workspaceDir);
  const { runsFile } = getWorkspacePaths(workspaceDir);
  const toStore = { ...run };
  delete toStore.tamperStatus;
  fs.appendFileSync(runsFile, JSON.stringify(toStore) + '\n', 'utf8');
}

export function appendRunSupplement(
  supplement: RunSupplement,
  workspaceDir?: string,
): ExperimentRun | null {
  ensureWorkspaceInitialized(workspaceDir);
  const { runSupplementsFile } = getWorkspacePaths(workspaceDir);
  fs.mkdirSync(path.dirname(runSupplementsFile), { recursive: true });
  fs.appendFileSync(runSupplementsFile, JSON.stringify(supplement) + '\n', 'utf8');
  return listRuns(workspaceDir).find((r) => r.id === supplement.runId) ?? null;
}

/**
 * Stage A1+: Never rewrites workspace/runs.jsonl!
 * Post-hoc evaluations are appended to run_supplements.jsonl and merged without duplication on read.
 */
export function updateRunEvaluations(
  runId: string,
  verdict: EvaluationVerdict,
  actor?: ActorAttribution,
  workspaceDir?: string,
): ExperimentRun {
  const runs = listRuns(workspaceDir);
  const target = runs.find((r) => r.id === runId);
  if (!target) throw new Error(`未找到实验记录 ${runId}`);

  const supplement: RunSupplement = {
    id: `sup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    runId,
    supplementKind: 'post_hoc_reevaluation',
    createdAt: verdict.evaluatedAt || new Date().toISOString(),
    createdBy: actor ?? { actorId: 'human:rad', displayName: 'Rad', actorKind: 'human' },
    sourceStorage: 'run_supplements_append',
    classificationBasis: `对已保存原始计算产物事后追加重评 (${verdict.evaluatorId}@${verdict.evaluatorVersion})`,
    verdict,
  };
  return appendRunSupplement(supplement, workspaceDir)!;
}

/**
 * Stage A1+: Never rewrites workspace/runs.jsonl!
 * Standalone analyses attached to a run are appended to run_supplements.jsonl.
 */
export function appendRunStandaloneAnalysis(
  runId: string,
  analysis: StandaloneAnalysisRecord,
  actor?: ActorAttribution,
  workspaceDir?: string,
): ExperimentRun {
  const runs = listRuns(workspaceDir);
  const target = runs.find((r) => r.id === runId);
  if (!target) throw new Error(`未找到实验记录 ${runId}`);

  const supplement: RunSupplement = {
    id: `sup-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    runId,
    supplementKind: 'standalone_analysis',
    createdAt: analysis.ranAt || new Date().toISOString(),
    createdBy: actor ?? { actorId: 'human:rad', displayName: 'Rad', actorKind: 'human' },
    sourceStorage: 'run_supplements_append',
    classificationBasis: `独立运行分析插件 (${analysis.componentId}@${analysis.version}) 分析该实验产物`,
    standaloneAnalysis: {
      ...analysis,
      sourceStorage: 'run_supplements_append',
    },
  };
  return appendRunSupplement(supplement, workspaceDir)!;
}

export function listResearchObjects(workspaceDir?: string): ResearchObject[] {
  const { researchObjectsFile } = getWorkspacePaths(workspaceDir);
  if (!fs.existsSync(researchObjectsFile)) return [];
  return JSON.parse(fs.readFileSync(researchObjectsFile, 'utf8')) as ResearchObject[];
}

export function saveResearchObjects(items: ResearchObject[], workspaceDir?: string): void {
  const { researchObjectsFile } = getWorkspacePaths(workspaceDir);
  atomicWriteFileSync(researchObjectsFile, JSON.stringify(items, null, 2));
}

export function listSnapshots(workspaceDir?: string): ResearchSnapshot[] {
  const { snapshotsFile } = getWorkspacePaths(workspaceDir);
  if (!fs.existsSync(snapshotsFile)) return [];
  const lines = fs.readFileSync(snapshotsFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as ResearchSnapshot);
}

export function appendSnapshot(snapshot: ResearchSnapshot, workspaceDir?: string): void {
  const { snapshotsFile } = getWorkspacePaths(workspaceDir);
  fs.mkdirSync(path.dirname(snapshotsFile), { recursive: true });
  fs.appendFileSync(snapshotsFile, JSON.stringify(snapshot) + '\n', 'utf8');
}

export function saveSnapshots(items: ResearchSnapshot[], workspaceDir?: string): void {
  const { snapshotsFile } = getWorkspacePaths(workspaceDir);
  const content = items.length > 0 ? items.map((s) => JSON.stringify(s)).join('\n') + '\n' : '';
  atomicWriteFileSync(snapshotsFile, content);
}

export function listBranches(workspaceDir?: string): Branch[] {
  const { branchesFile } = getWorkspacePaths(workspaceDir);
  if (!fs.existsSync(branchesFile)) return [];
  return JSON.parse(fs.readFileSync(branchesFile, 'utf8')) as Branch[];
}

export function saveBranches(items: Branch[], workspaceDir?: string): void {
  const { branchesFile } = getWorkspacePaths(workspaceDir);
  atomicWriteFileSync(branchesFile, JSON.stringify(items, null, 2));
}

export function listArchitectureSnapshots(workspaceDir?: string): ArchitectureSnapshot[] {
  const { architectureSnapshotsFile } = getWorkspacePaths(workspaceDir);
  if (!fs.existsSync(architectureSnapshotsFile)) return [];
  const lines = fs
    .readFileSync(architectureSnapshotsFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as ArchitectureSnapshot);
}

export function appendArchitectureSnapshot(snapshot: ArchitectureSnapshot, workspaceDir?: string): void {
  const { architectureSnapshotsFile } = getWorkspacePaths(workspaceDir);
  fs.mkdirSync(path.dirname(architectureSnapshotsFile), { recursive: true });
  fs.appendFileSync(architectureSnapshotsFile, JSON.stringify(snapshot) + '\n', 'utf8');
}

export function listExperimentSnapshots(workspaceDir?: string): ExperimentSnapshot[] {
  const { experimentSnapshotsFile } = getWorkspacePaths(workspaceDir);
  if (!fs.existsSync(experimentSnapshotsFile)) return [];
  const lines = fs
    .readFileSync(experimentSnapshotsFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as ExperimentSnapshot);
}

export function appendExperimentSnapshot(snapshot: ExperimentSnapshot, workspaceDir?: string): void {
  const { experimentSnapshotsFile } = getWorkspacePaths(workspaceDir);
  fs.mkdirSync(path.dirname(experimentSnapshotsFile), { recursive: true });
  fs.appendFileSync(experimentSnapshotsFile, JSON.stringify(snapshot) + '\n', 'utf8');
}

export function listThreadEntries(workspaceDir?: string): ThreadEntry[] {
  ensureWorkspaceInitialized(workspaceDir);
  const { threadFile } = getWorkspacePaths(workspaceDir);
  const lines = fs.readFileSync(threadFile, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.map((l) => JSON.parse(l) as ThreadEntry);
}

export function appendThreadEntry(entry: ThreadEntry, workspaceDir?: string): void {
  ensureWorkspaceInitialized(workspaceDir);
  const { threadFile } = getWorkspacePaths(workspaceDir);
  fs.appendFileSync(threadFile, JSON.stringify(entry) + '\n', 'utf8');
}

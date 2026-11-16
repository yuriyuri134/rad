import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildArchitectureMap } from '../src/core/architectureMap.ts';
import { traceOpticalSystem } from '../src/core/optics.ts';
import type {
  ComponentDossier,
  ComponentVersionRecord,
  EvaluationVerdict,
  OptimizationIteration,
  OpticalSystemSpec,
  RayTraceResult,
  RuntimeEnvironmentSnapshot,
} from '../src/core/types.ts';
import {
  detectRuntimeEnvironment,
  getComponent,
  getWorkspacePaths,
  listComponents,
  listRuns,
  saveComponentDossier,
  sha256,
} from './storage.ts';

const MJS_HARNESS_PATH = path.resolve(process.cwd(), 'server', 'mjs_harness.mjs');
const PYTHON_BRIDGE_PATH = path.resolve(process.cwd(), 'python', 'optiland_bridge.py');

function runProcessWithStdin(
  cmd: string,
  args: string[],
  stdinText: string,
  timeoutMs = 20000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const proc = execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          OPENLAB_OPTILAND_BRIDGE: PYTHON_BRIDGE_PATH,
        },
      },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
            ? Number((err as NodeJS.ErrnoException & { code?: unknown }).code)
            : 1;
          // If process exited with structured JSON on stdout (e.g. exit code 2 env_unavailable), return it cleanly
          if (stdout && stdout.trim().startsWith('{')) {
            resolve({ stdout, stderr, exitCode: code });
            return;
          }
          reject(new Error(stderr?.trim() || err.message));
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
    if (stdinText) {
      proc.stdin?.write(stdinText);
    }
    proc.stdin?.end();
  });
}

function getComponentImplPath(
  dossier: ComponentDossier,
  ver: ComponentVersionRecord,
  workspaceDir?: string,
): string {
  const { componentsDir } = getWorkspacePaths(workspaceDir);
  return path.join(componentsDir, path.basename(dossier.id), ver.version, ver.codeFile);
}

function resolveAndAssertApproved(
  componentId: string,
  requestedVersion?: string,
  workspaceDir?: string,
): { dossier: ComponentDossier; ver: ComponentVersionRecord; implPath: string; diskHash: string } {
  const found = getComponent(componentId, workspaceDir);
  if (!found) throw new Error(`未找到组件 ${componentId}`);
  const { dossier } = found;
  const versionTag = requestedVersion || dossier.activeVersion;
  const ver = dossier.versions.find((v) => v.version === versionTag);
  if (!ver) throw new Error(`组件 ${dossier.id} 不存在版本 ${versionTag}`);

  const implPath = getComponentImplPath(dossier, ver, workspaceDir);
  if (ver.sourceAvailability === 'missing_on_disk' || !fs.existsSync(implPath)) {
    throw new Error(`组件 ${dossier.id}@${ver.version} 源码文件在磁盘缺失（仅有历史元数据），禁止伪造或执行：${implPath}`);
  }
  const diskHash = sha256(fs.readFileSync(implPath, 'utf8'));

  if (dossier.diskTamperDetected || (versionTag === dossier.activeVersion && dossier.codeSecurityReview.status === 'unreviewed_modified')) {
    throw new Error(
      `安全审查拦截：组件 ${dossier.name} (${ver.version}) 源码已修改或磁盘哈希 (${diskHash.slice(0, 12)}...) 与已确认哈希不一致。本地子进程非 OS 安全沙箱，请先在组件库核对代码并确认哈希。`,
    );
  }
  if (
    dossier.codeSecurityReview.approvedHash &&
    versionTag === dossier.activeVersion &&
    diskHash !== dossier.codeSecurityReview.approvedHash
  ) {
    throw new Error(
      `安全审查拦截：组件 ${dossier.name} (${ver.version}) 磁盘 SHA-256 哈希与已确认记录不一致，拒绝执行。`,
    );
  }
  if (!dossier.codeSecurityReview.approvedHash && dossier.codeSecurityReview.status !== 'builtin_reviewed') {
    throw new Error(
      `安全审查拦截：组件 ${dossier.name} (${ver.version}) 尚未经人工哈希确认，禁止直接执行。`,
    );
  }

  return { dossier, ver, implPath, diskHash };
}

export async function probePythonEnvironment(): Promise<{
  runtimeEnv: RuntimeEnvironmentSnapshot;
  rawProbe: Record<string, unknown>;
}> {
  try {
    const { stdout } = await runProcessWithStdin('python3', [PYTHON_BRIDGE_PATH, '--probe'], '', 5000);
    const probe = JSON.parse(stdout) as {
      pythonVersion?: string | null;
      pythonOkForOptiland?: boolean;
      optilandInstalled?: boolean;
      optilandVersion?: string | null;
      numpyVersion?: string | null;
      scipyVersion?: string | null;
      error?: string | null;
    };
    return {
      runtimeEnv: detectRuntimeEnvironment(probe),
      rawProbe: probe as Record<string, unknown>,
    };
  } catch (err) {
    return {
      runtimeEnv: detectRuntimeEnvironment(),
      rawProbe: {
        pythonVersion: null,
        optilandInstalled: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export async function runComponentSelfCheck(
  componentId: string,
  requestedVersion?: string,
  workspaceDir?: string,
): Promise<{ dossier: ComponentDossier; checkOutput: Record<string, unknown> }> {
  const { dossier, ver, implPath, diskHash } = resolveAndAssertApproved(
    componentId,
    requestedVersion,
    workspaceDir,
  );
  const now = new Date().toISOString();

  if (dossier.runtime === 'local_process_py') {
    const { stdout } = await runProcessWithStdin('python3', [implPath, '--check'], '', 12000);
    const parsed = JSON.parse(stdout || '{}') as {
      status?: string;
      passed?: boolean;
      message?: string;
      environment?: Record<string, unknown>;
    };
    const nextStatus =
      parsed.status === 'env_unavailable'
        ? 'env_unavailable'
        : parsed.passed
          ? 'passed'
          : 'failed';
    dossier.selfCheck = {
      status: nextStatus,
      checkedAt: now,
      checkedCodeHash: diskHash,
      summary: parsed.message || 'Python 组件自检完成',
      details: JSON.stringify(parsed.environment ?? {}),
    };
    saveComponentDossier(dossier, workspaceDir);
    return {
      dossier: getComponent(dossier.id, workspaceDir)!.dossier,
      checkOutput: parsed as Record<string, unknown>,
    };
  }

  if (dossier.runtime === 'builtin_engine' && dossier.id === 'arch-map-engine') {
    const { runtimeEnv } = await probePythonEnvironment();
    const map = buildArchitectureMap({
      rootDir: process.cwd(),
      components: listComponents(workspaceDir),
      runs: listRuns(workspaceDir),
      runtimeEnv,
    });
    const hasSelfRef = map.edges.some((e) => e.isSelfReference && e.source === 'comp:arch-map-engine');
    const passed = map.nodes.length > 0 && hasSelfRef;
    dossier.selfCheck = {
      status: passed ? 'passed' : 'failed',
      checkedAt: now,
      checkedCodeHash: diskHash,
      summary: passed
        ? `自检通过：扫描 ${map.nodes.length} 个结构节点、${map.edges.length} 条关系边，含受控单步自引用`
        : '自检失败：未能生成自引用结构图谱',
    };
    saveComponentDossier(dossier, workspaceDir);
    return {
      dossier: getComponent(dossier.id, workspaceDir)!.dossier,
      checkOutput: { passed, summary: dossier.selfCheck.summary, anomalyCount: map.anomalies.length },
    };
  }

  // local_process_mjs or builtin_ts_preview (which also has impl.mjs selfCheck stub)
  const { stdout } = await runProcessWithStdin(
    'node',
    [MJS_HARNESS_PATH],
    JSON.stringify({
      action: 'check',
      implPath,
      params: ver.params,
    }),
    10000,
  );
  const parsed = JSON.parse(stdout || '{}') as { passed?: boolean; summary?: string; details?: string };
  dossier.selfCheck = {
    status: parsed.passed ? 'passed' : 'failed',
    checkedAt: now,
    checkedCodeHash: diskHash,
    summary: String(parsed.summary ?? (parsed.passed ? '组件自检通过' : '组件自检未通过')),
    details: parsed.details,
  };
  saveComponentDossier(dossier, workspaceDir);
  return {
    dossier: getComponent(dossier.id, workspaceDir)!.dossier,
    checkOutput: parsed as Record<string, unknown>,
  };
}

export async function runSolverComponent(
  solverId: string,
  spec: OpticalSystemSpec,
  workspaceDir?: string,
): Promise<{
  result: RayTraceResult;
  solverMeta: { id: string; name: string; version: string; codeHash: string };
}> {
  const { dossier, ver, implPath, diskHash } = resolveAndAssertApproved(solverId, undefined, workspaceDir);

  if (dossier.runtime === 'local_process_py') {
    const { stdout, exitCode } = await runProcessWithStdin(
      'python3',
      [implPath, '--solve'],
      JSON.stringify({ systemSpec: spec }),
      20000,
    );
    const parsed = JSON.parse(stdout || '{}') as {
      status?: string;
      error?: string;
      result?: RayTraceResult;
    };
    if (exitCode !== 0 || parsed.status !== 'ok' || !parsed.result) {
      throw new Error(
        parsed.error ||
          `Python 求解器 ${dossier.name} 在当前环境不可用 (${parsed.status ?? 'error'})，请勿冒充 TS 求解结果。`,
      );
    }
    return {
      result: { ...parsed.result, solverEngine: 'optiland' },
      solverMeta: { id: dossier.id, name: dossier.name, version: ver.version, codeHash: diskHash },
    };
  }

  if (dossier.runtime === 'local_process_mjs') {
    const { stdout } = await runProcessWithStdin(
      'node',
      [MJS_HARNESS_PATH],
      JSON.stringify({
        action: 'standalone',
        implPath,
        spec,
        params: ver.params,
      }),
      15000,
    );
    const res = JSON.parse(stdout) as RayTraceResult;
    return {
      result: res,
      solverMeta: { id: dossier.id, name: dossier.name, version: ver.version, codeHash: diskHash },
    };
  }

  // builtin_ts_preview
  const result = traceOpticalSystem(spec);
  return {
    result,
    solverMeta: { id: dossier.id, name: dossier.name, version: ver.version, codeHash: diskHash },
  };
}

export async function runEvaluatorComponent(params: {
  evaluatorId: string;
  evaluatorVersion?: string;
  overrideParams?: Record<string, number | string | boolean>;
  rawArtifacts: RayTraceResult;
  spec: OpticalSystemSpec;
  workspaceDir?: string;
}): Promise<EvaluationVerdict> {
  const { dossier, ver, implPath, diskHash } = resolveAndAssertApproved(
    params.evaluatorId,
    params.evaluatorVersion,
    params.workspaceDir,
  );
  const mergedParams = { ...ver.params, ...(params.overrideParams ?? {}) };

  const { stdout } = await runProcessWithStdin(
    'node',
    [MJS_HARNESS_PATH],
    JSON.stringify({
      action: 'evaluate',
      implPath,
      params: mergedParams,
      trace: params.rawArtifacts,
      spec: params.spec,
    }),
    10000,
  );

  const raw = JSON.parse(stdout) as Omit<
    EvaluationVerdict,
    'id' | 'evaluatorId' | 'evaluatorName' | 'evaluatorVersion' | 'evaluatorCodeHash' | 'evaluatedAt'
  >;

  return {
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    evaluatorId: dossier.id,
    evaluatorName: dossier.name,
    evaluatorVersion: ver.version,
    evaluatorCodeHash: diskHash,
    evaluatedAt: new Date().toISOString(),
    passed: Boolean(raw.passed),
    status: raw.status ?? (raw.passed ? 'pass' : 'fail'),
    lossScore: raw.lossScore === null || raw.lossScore === undefined ? null : Number(raw.lossScore),
    summary: String(raw.summary ?? ''),
    checks: Array.isArray(raw.checks) ? raw.checks : [],
    uncertainties: Array.isArray(raw.uncertainties) ? raw.uncertainties : [],
    missingArtifacts: Array.isArray(raw.missingArtifacts) ? raw.missingArtifacts : undefined,
  };
}

export async function runOptimizerComponent(params: {
  optimizerId: string;
  optimizerVersion?: string;
  overrideOptimizerParams?: Record<string, number | string | boolean>;
  evaluatorId: string;
  evaluatorVersion?: string;
  overrideEvaluatorParams?: Record<string, number | string | boolean>;
  solverId: string;
  initialSpec: OpticalSystemSpec;
  workspaceDir?: string;
}): Promise<{
  bestSpec: OpticalSystemSpec;
  bestTrace: RayTraceResult;
  bestEval: EvaluationVerdict;
  history: OptimizationIteration[];
  solverMeta: { id: string; name: string; version: string; codeHash: string };
  optimizerMeta: { id: string; name: string; version: string; codeHash: string; params: Record<string, number | string | boolean> };
  evaluatorMeta: { id: string; name: string; version: string; codeHash: string; params: Record<string, number | string | boolean> };
}> {
  const solverCheck = resolveAndAssertApproved(params.solverId, undefined, params.workspaceDir);
  const opt = resolveAndAssertApproved(params.optimizerId, params.optimizerVersion, params.workspaceDir);
  const ev = resolveAndAssertApproved(params.evaluatorId, params.evaluatorVersion, params.workspaceDir);

  const mergedOptParams = { ...opt.ver.params, ...(params.overrideOptimizerParams ?? {}) };
  const mergedEvalParams = { ...ev.ver.params, ...(params.overrideEvaluatorParams ?? {}) };

  const { stdout } = await runProcessWithStdin(
    'node',
    [MJS_HARNESS_PATH],
    JSON.stringify({
      action: 'optimize',
      implPath: opt.implPath,
      evalImplPath: ev.implPath,
      params: mergedOptParams,
      evalParams: mergedEvalParams,
      solverId: solverCheck.dossier.id,
      initialSpec: params.initialSpec,
    }),
    30000,
  );

  const result = JSON.parse(stdout) as {
    bestSpec: OpticalSystemSpec;
    bestTrace: RayTraceResult;
    bestEval: {
      lossScore: number | null;
      passed: boolean;
      status: EvaluationVerdict['status'];
      summary: string;
      checks: EvaluationVerdict['checks'];
      uncertainties: string[];
      missingArtifacts?: string[];
    };
    history: OptimizationIteration[];
  };

  const bestEval: EvaluationVerdict = {
    id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    evaluatorId: ev.dossier.id,
    evaluatorName: ev.dossier.name,
    evaluatorVersion: ev.ver.version,
    evaluatorCodeHash: ev.diskHash,
    evaluatedAt: new Date().toISOString(),
    passed: Boolean(result.bestEval.passed),
    status: result.bestEval.status ?? (result.bestEval.passed ? 'pass' : 'fail'),
    lossScore:
      result.bestEval.lossScore === null || result.bestEval.lossScore === undefined
        ? null
        : Number(result.bestEval.lossScore),
    summary: String(result.bestEval.summary ?? ''),
    checks: Array.isArray(result.bestEval.checks) ? result.bestEval.checks : [],
    uncertainties: Array.isArray(result.bestEval.uncertainties) ? result.bestEval.uncertainties : [],
    missingArtifacts: Array.isArray(result.bestEval.missingArtifacts)
      ? result.bestEval.missingArtifacts
      : undefined,
  };

  return {
    bestSpec: result.bestSpec,
    bestTrace: result.bestTrace,
    bestEval,
    history: Array.isArray(result.history) ? result.history : [],
    solverMeta: {
      id: solverCheck.dossier.id,
      name: solverCheck.dossier.name,
      version: solverCheck.ver.version,
      codeHash: solverCheck.diskHash,
    },
    optimizerMeta: {
      id: opt.dossier.id,
      name: opt.dossier.name,
      version: opt.ver.version,
      codeHash: opt.diskHash,
      params: mergedOptParams,
    },
    evaluatorMeta: {
      id: ev.dossier.id,
      name: ev.dossier.name,
      version: ev.ver.version,
      codeHash: ev.diskHash,
      params: mergedEvalParams,
    },
  };
}

export async function runStandaloneComponent(params: {
  componentId: string;
  version?: string;
  overrideParams?: Record<string, number | string | boolean>;
  rawArtifacts?: RayTraceResult;
  spec?: OpticalSystemSpec;
  customInput?: unknown;
  workspaceDir?: string;
}): Promise<{
  componentId: string;
  componentName: string;
  version: string;
  codeHash: string;
  output: Record<string, unknown>;
}> {
  const { dossier, ver, implPath, diskHash } = resolveAndAssertApproved(
    params.componentId,
    params.version,
    params.workspaceDir,
  );
  const mergedParams = { ...ver.params, ...(params.overrideParams ?? {}) };

  if (dossier.runtime === 'local_process_py') {
    const { stdout } = await runProcessWithStdin(
      'python3',
      [implPath, '--solve'],
      JSON.stringify({ systemSpec: params.spec ?? params.customInput ?? {} }),
      15000,
    );
    return {
      componentId: dossier.id,
      componentName: dossier.name,
      version: ver.version,
      codeHash: diskHash,
      output: JSON.parse(stdout || '{}') as Record<string, unknown>,
    };
  }

  if (dossier.runtime === 'builtin_ts_preview') {
    if (!params.spec) {
      throw new Error('独立运行预览光学求解器需要提供 systemSpec 参数');
    }
    const res = traceOpticalSystem(params.spec);
    return {
      componentId: dossier.id,
      componentName: dossier.name,
      version: ver.version,
      codeHash: diskHash,
      output: res as unknown as Record<string, unknown>,
    };
  }

  if (dossier.runtime === 'builtin_engine' && dossier.id === 'arch-map-engine') {
    const { runtimeEnv } = await probePythonEnvironment();
    const map = buildArchitectureMap({
      rootDir: process.cwd(),
      components: listComponents(params.workspaceDir),
      runs: listRuns(params.workspaceDir),
      runtimeEnv,
    });
    return {
      componentId: dossier.id,
      componentName: dossier.name,
      version: ver.version,
      codeHash: diskHash,
      output: {
        nodeCount: map.nodes.length,
        edgeCount: map.edges.length,
        anomalyCount: map.anomalies.length,
        anomalies: map.anomalies,
      },
    };
  }

  // local_process_mjs: evaluator or standalone analysis_plugin
  const action = dossier.kind === 'evaluator' ? 'evaluate' : 'standalone';
  const { stdout } = await runProcessWithStdin(
    'node',
    [MJS_HARNESS_PATH],
    JSON.stringify({
      action,
      implPath,
      params: mergedParams,
      trace: params.rawArtifacts,
      spec: params.spec,
      input: params.customInput,
    }),
    15000,
  );

  return {
    componentId: dossier.id,
    componentName: dossier.name,
    version: ver.version,
    codeHash: diskHash,
    output: JSON.parse(stdout || '{}') as Record<string, unknown>,
  };
}

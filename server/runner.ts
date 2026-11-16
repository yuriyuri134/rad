import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildArchitectureMap } from '../src/core/architectureMap.ts';
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
  discoverDeclaredHostModules,
  discoverLocalRelativeDependencies,
  getComponent,
  getWorkspacePaths,
  listComponents,
  listRuns,
  readCasBlob,
  resolveRepoRoot,
  saveComponentDossier,
  sha256,
} from './storage.ts';

const MJS_HARNESS_PATH = path.resolve(process.cwd(), 'server', 'mjs_harness.mjs');
const PYTHON_BRIDGE_PATH = path.resolve(process.cwd(), 'python', 'optiland_bridge.py');

const PYTHON_VERIFIED_BOOTSTRAP = [
  'import base64, hashlib, os, sys',
  'code_bytes = base64.b64decode(os.environ["OPENLAB_PY_SOURCE_B64"])',
  'actual_hash = hashlib.sha256(code_bytes).hexdigest()',
  'expected_hash = os.environ["OPENLAB_EXPECTED_HASH"]',
  'if actual_hash != expected_hash:',
  '    sys.stderr.write(f"TOCTOU/哈希校验失败: actual={actual_hash} expected={expected_hash}\\n")',
  '    sys.exit(1)',
  'impl_path = os.environ.get("OPENLAB_IMPL_PATH", "impl.py")',
  'sys.argv = [impl_path, *sys.argv[1:]]',
  'ns = {"__name__": "__main__", "__file__": impl_path}',
  'exec(compile(code_bytes.decode("utf-8"), impl_path, "exec"), ns)',
].join('\n');

function runProcessWithStdin(
  cmd: string,
  args: string[],
  stdinText: string,
  timeoutMs = 20000,
  extraEnv?: Record<string, string>,
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
          ...(extraEnv ?? {}),
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

function runVerifiedPythonComponent(
  verifiedCode: string,
  verifiedHash: string,
  implPath: string,
  cliFlag: string,
  stdinText: string,
  timeoutMs = 15000,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runProcessWithStdin(
    'python3',
    ['-c', PYTHON_VERIFIED_BOOTSTRAP, cliFlag],
    stdinText,
    timeoutMs,
    {
      OPENLAB_PY_SOURCE_B64: Buffer.from(verifiedCode, 'utf8').toString('base64'),
      OPENLAB_EXPECTED_HASH: verifiedHash,
      OPENLAB_IMPL_PATH: implPath,
    },
  );
}

function getComponentImplPath(
  dossier: ComponentDossier,
  ver: ComponentVersionRecord,
  workspaceDir?: string,
): string {
  const { componentsDir } = getWorkspacePaths(workspaceDir);
  return path.join(componentsDir, path.basename(dossier.id), ver.version, ver.codeFile);
}

export interface ApprovedComponentExecutionContext {
  dossier: ComponentDossier;
  ver: ComponentVersionRecord;
  implPath: string;
  verifiedCode: string;
  verifiedHash: string;
  verifiedRelativeDeps: Record<string, { code: string; codeHash: string }>;
  verifiedHostModules: Record<string, { targetId: string; code: string; codeHash: string }>;
  executedFromCas: boolean;
  frozenWorkspaceModified: boolean;
}

function getDeclaredHostTargets(dependencies: ComponentDossier['dependencies'] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dep of dependencies ?? []) {
    const rawTarget = typeof dep === 'string' ? dep : dep.kind === 'module' ? dep.targetId : '';
    const targetId = path.posix.normalize(rawTarget.replace(/\\/g, '/'));
    if (targetId.startsWith('src/core/') && !seen.has(targetId)) {
      seen.add(targetId);
      out.push(targetId);
    }
  }
  return out.sort();
}

export function resolveAndAssertApproved(
  componentId: string,
  requestedVersion?: string,
  workspaceDir?: string,
): ApprovedComponentExecutionContext {
  const found = getComponent(componentId, workspaceDir);
  if (!found) throw new Error(`未找到组件 ${componentId}`);
  const { dossier } = found;
  const versionTag = requestedVersion || dossier.activeVersion;
  const ver = dossier.versions.find((v) => v.version === versionTag);
  if (!ver) throw new Error(`组件 ${dossier.id} 不存在版本 ${versionTag}`);

  const { componentsDir } = getWorkspacePaths(workspaceDir);
  const versionDir = path.join(componentsDir, path.basename(dossier.id), ver.version);
  const implPath = getComponentImplPath(dossier, ver, workspaceDir);
  const declaredHostTargets = getDeclaredHostTargets(dossier.dependencies);

  // If this version is pinned to CAS, ALWAYS verify the CAS blob directly first
  // so CAS corruption is never silently masked by an intact workspace copy.
  if (ver.lifecycle === 'frozen' && ver.immutableBlobHash) {
    const casCode = readCasBlob(ver.immutableBlobHash, workspaceDir); // Throws immediately if CAS corrupted
    const verifiedRelativeDeps: Record<string, { code: string; codeHash: string }> = {};
    let depsCasMissing = false;

    for (const dep of ver.pinnedRelativeDeps ?? []) {
      const depDiskPath = path.join(versionDir, dep.relativePath);
      if (dep.immutableBlobHash) {
        const depCas = readCasBlob(dep.immutableBlobHash, workspaceDir); // Throws immediately if CAS corrupted
        if (depCas !== null) {
          if (sha256(depCas) !== dep.codeHash) {
            throw new Error(
              `CAS 不可变存储哈希冲突：${dossier.id}@${ver.version}/${dep.relativePath} 预期 ${dep.codeHash}`,
            );
          }
          verifiedRelativeDeps[dep.relativePath] = { code: depCas, codeHash: dep.codeHash };
          continue;
        }
        depsCasMissing = true;
      }
      // Fallback for deleted CAS relative dep: only allowed if workspace copy matches pinned hash
      if (fs.existsSync(depDiskPath)) {
        const depDisk = fs.readFileSync(depDiskPath, 'utf8');
        if (sha256(depDisk) === dep.codeHash) {
          verifiedRelativeDeps[dep.relativePath] = { code: depDisk, codeHash: dep.codeHash };
          continue;
        }
      }
      throw new Error(
        `安全校验失败：冻结组件 ${dossier.id}@${ver.version} 的相对依赖 ${dep.relativePath} 在 CAS 与工作区均不可用或哈希不匹配`,
      );
    }

    const verifiedHostModules: Record<string, { targetId: string; code: string; codeHash: string }> = {};
    let hostCasMissing = false;
    if (declaredHostTargets.length > 0 && (!ver.pinnedHostModules || ver.pinnedHostModules.length === 0)) {
      throw new Error(
        `安全校验失败：冻结组件 ${dossier.id}@${ver.version} 声明的宿主模块 (${declaredHostTargets.join(', ')}) 未在 CAS 固定，禁止直接执行。`,
      );
    }
    for (const hostMod of ver.pinnedHostModules ?? []) {
      if (hostMod.immutableBlobHash) {
        const casHost = readCasBlob(hostMod.immutableBlobHash, workspaceDir); // Throws immediately if CAS corrupted
        if (casHost !== null) {
          if (sha256(casHost) !== hostMod.codeHash) {
            throw new Error(
              `CAS 不可变存储哈希冲突：${dossier.id}@${ver.version} 宿主模块 ${hostMod.targetId} 预期 ${hostMod.codeHash}`,
            );
          }
          verifiedHostModules[hostMod.targetId] = {
            targetId: hostMod.targetId,
            code: casHost,
            codeHash: hostMod.codeHash,
          };
          continue;
        }
        hostCasMissing = true;
      } else {
        hostCasMissing = true;
      }
      // Fallback for deleted CAS host module: only allowed if repo disk copy strictly matches pinned SHA-256
      const hostDiskPath = path.resolve(resolveRepoRoot(), hostMod.targetId);
      if (fs.existsSync(hostDiskPath) && !fs.statSync(hostDiskPath).isDirectory()) {
        const hostDisk = fs.readFileSync(hostDiskPath, 'utf8');
        if (sha256(hostDisk) === hostMod.codeHash) {
          verifiedHostModules[hostMod.targetId] = {
            targetId: hostMod.targetId,
            code: hostDisk,
            codeHash: hostMod.codeHash,
          };
          continue;
        }
      }
      throw new Error(
        `安全校验失败：冻结组件 ${dossier.id}@${ver.version} 的宿主模块 ${hostMod.targetId} 在 CAS 与工作区均不可用或哈希不匹配，明确阻断执行`,
      );
    }
    for (const targetId of declaredHostTargets) {
      if (!verifiedHostModules[targetId]) {
        throw new Error(
          `安全校验失败：冻结组件 ${dossier.id}@${ver.version} 声明的宿主模块 ${targetId} 未在 pinnedHostModules 固定，禁止执行`,
        );
      }
    }

    if (casCode !== null) {
      const casHash = sha256(casCode);
      if (casHash !== ver.immutableBlobHash || casHash !== ver.codeHash) {
        throw new Error(
          `CAS 不可变存储哈希冲突：${dossier.id}@${ver.version} 预期 ${ver.codeHash}，CAS 实际 ${casHash}`,
        );
      }

      const isActive = versionTag === dossier.activeVersion;
      const review = dossier.codeSecurityReview;
      const approvedForCas = isActive
        ? review.approvedHash === casHash || (!review.approvedHash && review.status === 'builtin_reviewed')
        : ver.author === 'system' ||
          (ver.frozenByRunIds && ver.frozenByRunIds.length > 0) ||
          review.approvedHash === casHash;

      if (!approvedForCas) {
        throw new Error(
          `安全审查拦截：冻结组件 ${dossier.name} (${ver.version}) 尚未经人工哈希确认，禁止直接执行。`,
        );
      }

      return {
        dossier,
        ver,
        implPath,
        verifiedCode: casCode,
        verifiedHash: casHash,
        verifiedRelativeDeps,
        verifiedHostModules,
        executedFromCas: !depsCasMissing && !hostCasMissing,
        frozenWorkspaceModified: Boolean(ver.frozenWorkspaceModified),
      };
    }
    // If primary CAS blob was deleted (casCode === null), fall through to strict disk verification:
    // if workspace copy was also modified/deleted, below will reject it; if workspace copy is intact and matches ver.codeHash, it can still run with executedFromCas=false.
  }

  // Non-frozen Draft (or legacy/deleted-CAS frozen fallback): strictly read & verify disk copy ONCE
  if (ver.sourceAvailability === 'missing_on_disk' || !fs.existsSync(implPath)) {
    throw new Error(`组件 ${dossier.id}@${ver.version} 源码文件在磁盘缺失（仅有历史元数据），禁止伪造或执行：${implPath}`);
  }
  const diskCode = fs.readFileSync(implPath, 'utf8');
  const diskHash = sha256(diskCode);

  if (
    diskHash !== ver.codeHash ||
    (versionTag === dossier.activeVersion && dossier.diskTamperDetected) ||
    (versionTag === dossier.activeVersion && dossier.codeSecurityReview.status === 'unreviewed_modified')
  ) {
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

  const discoveredDeps = discoverLocalRelativeDependencies(versionDir, ver.codeFile, dossier.dependencies);
  if (ver.pinnedRelativeDeps && ver.pinnedRelativeDeps.length > 0) {
    const mismatch =
      ver.pinnedRelativeDeps.length !== discoveredDeps.length ||
      ver.pinnedRelativeDeps.some((pinned, idx) => {
        const cur = discoveredDeps[idx];
        return !cur || cur.relativePath !== pinned.relativePath || cur.codeHash !== pinned.codeHash;
      });
    if (mismatch) {
      throw new Error(
        `安全审查拦截：组件 ${dossier.name} (${ver.version}) 的相对依赖已发生变更或缺失，请重新核对并确认哈希。`,
      );
    }
  } else if (discoveredDeps.length > 0 && ver.lifecycle === 'frozen') {
    throw new Error(
      `安全校验失败：冻结组件 ${dossier.id}@${ver.version} 包含未在 CAS 固定的相对依赖，禁止直接执行。`,
    );
  }

  const verifiedRelativeDeps: Record<string, { code: string; codeHash: string }> = {};
  for (const dep of discoveredDeps) {
    verifiedRelativeDeps[dep.relativePath] = { code: dep.codeContent, codeHash: dep.codeHash };
  }

  const discoveredHostMods = discoverDeclaredHostModules(dossier.dependencies);
  if (ver.pinnedHostModules && ver.pinnedHostModules.length > 0) {
    const hostMismatch =
      ver.pinnedHostModules.length !== discoveredHostMods.length ||
      ver.pinnedHostModules.some((pinned, idx) => {
        const cur = discoveredHostMods[idx];
        return !cur || cur.targetId !== pinned.targetId || cur.codeHash !== pinned.codeHash;
      });
    if (hostMismatch) {
      throw new Error(
        `安全审查拦截：组件 ${dossier.name} (${ver.version}) 声明的宿主模块已发生变更或缺失，请重新核对并确认哈希。`,
      );
    }
  } else if (discoveredHostMods.length > 0 && ver.lifecycle === 'frozen') {
    throw new Error(
      `安全校验失败：冻结组件 ${dossier.id}@${ver.version} 声明的宿主模块未在 CAS 固定，禁止直接执行。`,
    );
  }

  const verifiedHostModules: Record<string, { targetId: string; code: string; codeHash: string }> = {};
  for (const mod of discoveredHostMods) {
    verifiedHostModules[mod.targetId] = {
      targetId: mod.targetId,
      code: mod.codeContent,
      codeHash: mod.codeHash,
    };
  }

  return {
    dossier,
    ver,
    implPath,
    verifiedCode: diskCode,
    verifiedHash: diskHash,
    verifiedRelativeDeps,
    verifiedHostModules,
    executedFromCas: false,
    frozenWorkspaceModified: false,
  };
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
  const { dossier, ver, implPath, verifiedCode, verifiedHash, verifiedRelativeDeps, verifiedHostModules } =
    resolveAndAssertApproved(componentId, requestedVersion, workspaceDir);
  const now = new Date().toISOString();

  if (dossier.runtime === 'local_process_py') {
    const { stdout } = await runVerifiedPythonComponent(verifiedCode, verifiedHash, implPath, '--check', '', 12000);
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
      checkedCodeHash: verifiedHash,
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
      checkedCodeHash: verifiedHash,
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
    ['--no-warnings', MJS_HARNESS_PATH],
    JSON.stringify({
      action: 'check',
      implPath,
      verifiedCode,
      expectedCodeHash: verifiedHash,
      verifiedRelativeDeps,
      verifiedHostModules,
      params: ver.params,
    }),
    10000,
  );
  const parsed = JSON.parse(stdout || '{}') as { passed?: boolean; summary?: string; details?: string };
  dossier.selfCheck = {
    status: parsed.passed ? 'passed' : 'failed',
    checkedAt: now,
    checkedCodeHash: verifiedHash,
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
  const { dossier, ver, implPath, verifiedCode, verifiedHash, verifiedRelativeDeps, verifiedHostModules } =
    resolveAndAssertApproved(solverId, undefined, workspaceDir);

  if (dossier.runtime === 'local_process_py') {
    const { stdout, exitCode } = await runVerifiedPythonComponent(
      verifiedCode,
      verifiedHash,
      implPath,
      '--solve',
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
      solverMeta: { id: dossier.id, name: dossier.name, version: ver.version, codeHash: verifiedHash },
    };
  }

  if (dossier.runtime === 'local_process_mjs') {
    const { stdout } = await runProcessWithStdin(
      'node',
      ['--no-warnings', MJS_HARNESS_PATH],
      JSON.stringify({
        action: 'standalone',
        implPath,
        verifiedCode,
        expectedCodeHash: verifiedHash,
        verifiedRelativeDeps,
        verifiedHostModules,
        spec,
        params: ver.params,
      }),
      15000,
    );
    const res = JSON.parse(stdout) as RayTraceResult;
    return {
      result: res,
      solverMeta: { id: dossier.id, name: dossier.name, version: ver.version, codeHash: verifiedHash },
    };
  }

  // builtin_ts_preview: execute verified host module bytes via memory data URL inside mjs_harness
  const { stdout } = await runProcessWithStdin(
    'node',
    ['--no-warnings', MJS_HARNESS_PATH],
    JSON.stringify({
      action: 'trace_host',
      implPath,
      verifiedCode,
      expectedCodeHash: verifiedHash,
      verifiedRelativeDeps,
      verifiedHostModules,
      spec,
      params: ver.params,
    }),
    15000,
  );
  const result = JSON.parse(stdout) as RayTraceResult;
  return {
    result,
    solverMeta: { id: dossier.id, name: dossier.name, version: ver.version, codeHash: verifiedHash },
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
  const { dossier, ver, implPath, verifiedCode, verifiedHash, verifiedRelativeDeps, verifiedHostModules } =
    resolveAndAssertApproved(params.evaluatorId, params.evaluatorVersion, params.workspaceDir);
  const mergedParams = { ...ver.params, ...(params.overrideParams ?? {}) };

  const { stdout } = await runProcessWithStdin(
    'node',
    ['--no-warnings', MJS_HARNESS_PATH],
    JSON.stringify({
      action: 'evaluate',
      implPath,
      verifiedCode,
      expectedCodeHash: verifiedHash,
      verifiedRelativeDeps,
      verifiedHostModules,
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
    evaluatorCodeHash: verifiedHash,
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
    ['--no-warnings', MJS_HARNESS_PATH],
    JSON.stringify({
      action: 'optimize',
      implPath: opt.implPath,
      verifiedCode: opt.verifiedCode,
      expectedCodeHash: opt.verifiedHash,
      verifiedRelativeDeps: opt.verifiedRelativeDeps,
      verifiedHostModules: opt.verifiedHostModules,
      solverVerifiedHostModules: solverCheck.verifiedHostModules,
      evalImplPath: ev.implPath,
      evalVerifiedCode: ev.verifiedCode,
      expectedEvalCodeHash: ev.verifiedHash,
      evalVerifiedRelativeDeps: ev.verifiedRelativeDeps,
      evalVerifiedHostModules: ev.verifiedHostModules,
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
    evaluatorCodeHash: ev.verifiedHash,
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
      codeHash: solverCheck.verifiedHash,
    },
    optimizerMeta: {
      id: opt.dossier.id,
      name: opt.dossier.name,
      version: opt.ver.version,
      codeHash: opt.verifiedHash,
      params: mergedOptParams,
    },
    evaluatorMeta: {
      id: ev.dossier.id,
      name: ev.dossier.name,
      version: ev.ver.version,
      codeHash: ev.verifiedHash,
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
  const { dossier, ver, implPath, verifiedCode, verifiedHash, verifiedRelativeDeps, verifiedHostModules } =
    resolveAndAssertApproved(params.componentId, params.version, params.workspaceDir);
  const mergedParams = { ...ver.params, ...(params.overrideParams ?? {}) };

  if (dossier.runtime === 'local_process_py') {
    const { stdout } = await runVerifiedPythonComponent(
      verifiedCode,
      verifiedHash,
      implPath,
      '--solve',
      JSON.stringify({ systemSpec: params.spec ?? params.customInput ?? {} }),
      15000,
    );
    return {
      componentId: dossier.id,
      componentName: dossier.name,
      version: ver.version,
      codeHash: verifiedHash,
      output: JSON.parse(stdout || '{}') as Record<string, unknown>,
    };
  }

  if (dossier.runtime === 'builtin_ts_preview') {
    if (!params.spec) {
      throw new Error('独立运行预览光学求解器需要提供 systemSpec 参数');
    }
    const { stdout } = await runProcessWithStdin(
      'node',
      ['--no-warnings', MJS_HARNESS_PATH],
      JSON.stringify({
        action: 'trace_host',
        implPath,
        verifiedCode,
        expectedCodeHash: verifiedHash,
        verifiedRelativeDeps,
        verifiedHostModules,
        spec: params.spec,
        params: mergedParams,
      }),
      15000,
    );
    const res = JSON.parse(stdout) as RayTraceResult;
    return {
      componentId: dossier.id,
      componentName: dossier.name,
      version: ver.version,
      codeHash: verifiedHash,
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
      codeHash: verifiedHash,
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
    ['--no-warnings', MJS_HARNESS_PATH],
    JSON.stringify({
      action,
      implPath,
      verifiedCode,
      expectedCodeHash: verifiedHash,
      verifiedRelativeDeps,
      verifiedHostModules,
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
    codeHash: verifiedHash,
    output: JSON.parse(stdout || '{}') as Record<string, unknown>,
  };
}


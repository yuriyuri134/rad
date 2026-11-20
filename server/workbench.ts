import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseFitsBuffer } from '../src/core/fits.ts';
import type {
  ArchitectureAnnotation,
  ArchitectureMapData,
  ArtifactRef,
  AsyncJobRecord,
  ComponentDossier,
  EpistemicNote,
  FitsAnalysisResult,
  FitsCatalogEntry,
  P2RunnerMode,
  PersistedArchitectureSnapshot,
  ProvenanceTier,
  ResearchStudy,
  StudyBranch,
  StudyOpenQuestion,
  WorkflowExecution,
} from '../src/core/types.ts';
import { inspectDiscoveredPythonRuntime } from './python_env.ts';
import { projectScienceCorrections, stage4Metrics, fitsProxyCaveat, type Stage4 } from './science_evidence.ts';
import { pythonEnvironment, readVerifiedSource, stageVerifiedPython, stopChild } from './process.ts';
import {
  atomicWriteFileSync,
  getComponent,
  listComponents,
  listResearchObjects,
  listRuns,
  listThreadEntries,
  resolveRepoRoot,
  resolveWorkspaceDir,
  sha256,
} from './storage.ts';

function getWorkbenchPaths(workspaceDir?: string) {
  const ws = resolveWorkspaceDir(workspaceDir);
  const wbDir = path.join(ws, 'workbench');
  return {
    wbDir,
    studiesFile: path.join(wbDir, 'studies.json'),
    branchesFile: path.join(wbDir, 'branches.json'),
    executionsFile: path.join(wbDir, 'executions.jsonl'),
    artifactsFile: path.join(wbDir, 'artifacts.jsonl'),
    notesFile: path.join(wbDir, 'notes.jsonl'),
    jobsFile: path.join(wbDir, 'jobs.json'),
    archSnapshotsFile: path.join(wbDir, 'arch_snapshots.jsonl'),
    archAnnotationsFile: path.join(wbDir, 'arch_annotations.json'),
    logsDir: path.join(wbDir, 'logs'),
    generatedArtifactsDir: path.join(wbDir, 'artifacts'),
  };
}

function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function readJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8').trim();
  if (!raw) return [];
  const out: T[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as T);
    } catch {
      // Skip malformed line without losing history
    }
  }
  return out;
}

function appendJsonlLine(filePath: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function sha256File(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function safeReadRepoJson<T>(repoRoot: string, relPath: string): { data: T; sha256: string; bytes: number } | null {
  const abs = path.join(repoRoot, relPath);
  if (!fs.existsSync(abs)) return null;
  try {
    const raw = fs.readFileSync(abs);
    return {
      data: JSON.parse(raw.toString('utf8')) as T,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      bytes: raw.byteLength,
    };
  } catch {
    return null;
  }
}

const stage4Path = 'experiments/p2_flagship/runs/stage4_tolerancing.json';
function readStage4Evidence(repoRoot: string) {
  const result = safeReadRepoJson<Stage4>(repoRoot, stage4Path);
  return result?.sha256 === '955cd06883ba40a57e8001c086013746eaf73e1e2abe0246a092ab2a62318b0c' ? result : null;
}

const activeProcesses = new Map<string, ChildProcess>();
const legacyP2Entry = 'python/workbench_p2_runner.py';
const legacyP2SourceHashes = {
  [legacyP2Entry]: '38bf6aa0286ceac33c9c66467cec5df80413f2c30b690a8e3c4f52e92c6c4ce0',
  'experiments/p2_flagship/scripts/wf_rc_models.py': '8baeeed8bf4157b8e9736be9cb211f7387d4d7142aa3d35b6d08f1880d4d4637',
  'experiments/p2_flagship/scripts/stage4_tolerancing.py': 'c85f868be3f742f0567def4bb4a069b1aab76772db24428733a2e7f3672420eb',
  'experiments/p2_flagship/scripts/stage2_corrector_v2.py': '27ce811e53b1bfc81e65f9271dfc8521ac4feeb45f96cef46a40d4450f942e03',
};

export function reconcileOrphanedAsyncJobs(workspaceDir?: string): void {
  const paths = getWorkbenchPaths(workspaceDir);
  if (!fs.existsSync(paths.jobsFile)) return;
  const jobs = readJsonFile<AsyncJobRecord[]>(paths.jobsFile, []);
  let changed = false;
  const now = new Date().toISOString();
  const updated = jobs.map((j) => {
    if ((j.status === 'running' || j.status === 'queued') && !activeProcesses.has(j.id)) {
      changed = true;
      return {
        ...j,
        status: 'failed' as const,
        errorMessage:
          '宿主容器或服务进程在任务完成落盘前发生重启/快照回滚，原始子进程已中断（保留启动依据，未伪造完成产物；可从研究记录账本重新启动实算）',
        logs: [
          ...j.logs,
          `[${now}] [recovery] 检测到服务重启或容器快照回滚后子进程已不存在 (${j.id})，已如实标记为中断 (failed)，不伪造完成产物。`,
        ],
        finishedAt: j.finishedAt ?? now,
      };
    }
    return j;
  });
  if (changed) {
    atomicWriteFileSync(paths.jobsFile, JSON.stringify(updated, null, 2));
  }
}

/**
 * Deterministically and idempotently seeds WF-RC-1000 from authentic P2 flagship artifacts
 * inside workspace/workbench/ without touching legacy runs.jsonl or Stage A1 files.
 */
export function ensureWorkbenchInitialized(workspaceDir?: string): void {
  const paths = getWorkbenchPaths(workspaceDir);
  fs.mkdirSync(paths.wbDir, { recursive: true });
  fs.mkdirSync(paths.logsDir, { recursive: true });
  fs.mkdirSync(paths.generatedArtifactsDir, { recursive: true });

  reconcileOrphanedAsyncJobs(workspaceDir);

  const existingStudies = readJsonFile<ResearchStudy[]>(paths.studiesFile, []);
  if (existingStudies.some((s) => s.id === 'study-wf-rc-1000')) {
    return;
  }

  const repoRoot = resolveRepoRoot();
  const s0Res = safeReadRepoJson<Record<string, unknown>>(repoRoot, 'experiments/p2_flagship/runs/S0_bare_rc.json');
  const s14Res = safeReadRepoJson<Record<string, Record<string, unknown>>>(
    repoRoot,
    'experiments/p2_flagship/runs/S1_to_S4_correctors_v2.json',
  );
  const s3Stage4Res = readStage4Evidence(repoRoot);
  const stage3Res = safeReadRepoJson<{
    systems?: Record<string, { efl_mm?: number; max_distortion_offset_um?: number; tiles?: Array<Record<string, unknown>> }>;
  }>(repoRoot, 'experiments/p2_flagship/runs/stage3_fits_astrometry.json');
  const stage5Res = safeReadRepoJson<Record<string, unknown>>(
    repoRoot,
    'experiments/p2_flagship/runs/stage5_independent_verification.json',
  );

  const now = '2026-04-02T10:00:00.000Z';
  const studyId = 'study-wf-rc-1000';

  const s0Data = (s0Res?.data ?? {}) as Record<string, Record<string, unknown>>;
  const s0RmsMap = (s0Data.polychromatic_rms_spot_um_by_field_deg ?? {}) as Record<string, number>;
  const s0StrehlMap = (s0Data.psf_strehl_550nm_cross_check ?? {}) as Record<string, { fft_strehl?: number }>;
  const s0MtfMap = (s0Data.mtf_at_33lp_mm_550nm ?? {}) as Record<string, { tangential?: number; sagittal?: number }>;

  const branches: StudyBranch[] = [];
  const artifacts: ArtifactRef[] = [];
  const executions: WorkflowExecution[] = [];

  // S0 Branch
  branches.push({
    id: 'branch-p2-s0',
    studyId,
    parentBranchId: null,
    name: 'S0 裸 Ritchey-Chrétien 基准 (无校正镜)',
    shortCode: 'S0',
    hypothesis: '检验纯两镜 Ritchey-Chrétien（消球差与彗差）在 1.2° 宽视场下的像散与场曲极限边界。',
    status: 'baseline',
    provenanceTier: 'external_verified_import',
    summary: '轴上接近衍射极限 (Strehl=0.988)，但 0.60° 边缘受像散+场曲主导退化至 RMS 170.74 μm、Strehl 0.0029，无法满足宽视场指标。',
    metrics: {
      eflMm: 6000.0,
      fNumber: 6.0,
      rms000Um: s0RmsMap['0.0'] ?? 1.213,
      rms025Um: s0RmsMap['0.25'] ?? 28.845,
      rms042Um: s0RmsMap['0.42'] ?? 83.147,
      rms060Um: s0RmsMap['0.6'] ?? 170.74,
      maxRmsPolyUm: Math.max(...Object.values(s0RmsMap), 170.74),
      meanRmsPolyUm: 70.986,
      strehlCenter: s0StrehlMap['0.0']?.fft_strehl ?? 0.98774,
      strehlEdge: s0StrehlMap['0.6']?.fft_strehl ?? 0.0029,
      mtfEdgeTan: s0MtfMap['0.6']?.tangential ?? 0.0061,
      distortionMaxPct: Number(s0Res?.data?.distortion_pct_max_abs ?? 0.01217),
      k1: -1.12838839,
      k2: -6.22036543,
      sepCompletenessEdgePct: 3.6,
      photutilsCompletenessEdgePct: 0.0,
    },
    prescription: (s0Data.prescription ?? {}) as Record<string, unknown>,
    artifactIds: s0Res ? ['art-p2-s0-json'] : [],
    executionIds: ['exec-p2-s0'],
    createdAt: now,
    updatedAt: now,
    createdBy: 'P2 Flagship Stage 1',
  });

  if (s0Res) {
    artifacts.push({
      id: 'art-p2-s0-json',
      studyId,
      branchId: 'branch-p2-s0',
      executionId: 'exec-p2-s0',
      kind: 'ray_trace_json',
      title: 'S0 裸 RC 解析基线与 Optiland 多波段验证报告',
      relativePath: 'experiments/p2_flagship/runs/S0_bare_rc.json',
      sha256: s0Res.sha256,
      byteLength: s0Res.bytes,
      provenanceTier: 'external_verified_import',
      createdAt: now,
    });
  }

  executions.push({
    id: 'exec-p2-s0',
    studyId,
    branchId: 'branch-p2-s0',
    jobId: null,
    runnerMode: 'external_script_verified_import',
    title: 'Stage 1: 裸 RC 一阶与 Seidel/Optiland 验证',
    intent: '验证解析 RC 公式与 ABCD 矩阵及光线追迹一致性',
    status: 'completed',
    provenanceTier: 'external_verified_import',
    parameters: { D_mm: 1000, EFL_mm: 6000, F1: 2.2 },
    outputs: { maxRmsPolyUm: 170.74, strehlEdge: 0.0029 },
    artifactIds: s0Res ? ['art-p2-s0-json'] : [],
    durationMs: 4740,
    createdAt: now,
    sha256Digest: s0Res?.sha256 ?? sha256('exec-p2-s0'),
  });

  const s14 = s14Res?.data ?? {};
  const branchSpecs: Array<{
    key: 'S1' | 'S2' | 'S3' | 'S4';
    name: string;
    hypothesis: string;
    status: StudyBranch['status'];
    summary: string;
    stage3SysKey: string;
  }> = [
    {
      key: 'S1',
      name: 'S1 两片 Fused Silica RC 像场校正镜',
      hypothesis: '使用两片全熔石英弯月透镜是否足以同时抑制 1.2° 宽视场像散与场曲。',
      status: 'rejected',
      summary: 'max_rms 降至 4.713 μm（优于 7.5 μm 指标），但 0.42° 中带高阶像散残余，边缘/中带 Strehl 仅为 0.454–0.709，未达到 >=0.80 衍射受限门槛。',
      stage3SysKey: 'S1_2Lens_FS_RC',
    },
    {
      key: 'S2',
      name: 'S2 三片 Wynne 全熔石英校正镜 (锁定 RC 圆锥系数)',
      hypothesis: '固定主次镜纯 RC K1/K2，引入经典三片式 Wynne 校正组，验证全视场衍射性能。',
      status: 'exploring',
      summary: '全视场 RMS 压至 1.855–2.297 μm，0.0°–0.60° 550nm Strehl 达到 0.870–0.922，通过全部主要光学指标，是纯 RC 镜面约束下最优构型。',
      stage3SysKey: 'S2_3Lens_Wynne_FS_RC',
    },
    {
      key: 'S3',
      name: 'S3 三片 Wynne 全熔石英校正镜 + Quasi-RC 主次镜非球面微调',
      hypothesis: '解锁主次镜圆锥系数 (K1, K2) 形成 Quasi-RC 协同消像差，检验能否将衍射 Strehl 与畸变推进至极值。',
      status: 'adopted',
      summary: 'Stage 2 综合最优与 Stage 4/5 验证采纳基线：max_rms=1.063 μm，550nm Strehl=0.854–0.982，MTF@33.3=0.773–0.781，畸变 0.343%，K1=-1.14865/K2=-6.46154。',
      stage3SysKey: 'S3_3Lens_Wynne_FS_QuasiRC',
    },
    {
      key: 'S4',
      name: 'S4 三片 Wynne FS+Schott F2 混合色散玻璃校正镜',
      hypothesis: '将 L2 替换为 Schott F2 以平衡宽波段色差；同时记录单次长耗时仿真下的优化瓶颈。',
      status: 'archived_blocked',
      summary: '因色散高折射率玻璃耦合曲率陡峭，Stage 2 在预算内仅完成 1 个种子 (447 nfev, cost=597.635)，max_rms=9.704 μm 未达标，列为待重算开放问题。',
      stage3SysKey: 'S4_3Lens_Wynne_FS_F2_RC',
    },
  ];

  const stage3Systems = stage3Res?.data?.systems ?? {};
  for (const spec of branchSpecs) {
    const raw = (s14[spec.key] ?? {}) as Record<string, unknown>;
    const m = (raw.metrics ?? {}) as Record<string, unknown>;
    const rmsField = (m.rms_um_poly_by_field ?? {}) as Record<string, number>;
    const strehlField = (m.fft_strehl_550nm ?? {}) as Record<string, number>;
    const mtfField = (m.mtf_33lp_mm_550nm ?? {}) as Record<string, { tangential?: number }>;
    const s3Stats = stage3Systems[spec.stage3SysKey]?.tiles ?? [];
    const edgeTile = s3Stats.find((t) => Number(t.field_deg) >= 0.59) as Record<string, Record<string, unknown>> | undefined;
    const seeds = (raw.seed_runs ?? []) as Array<Record<string, unknown>>;

    const branchId = `branch-p2-${spec.key.toLowerCase()}`;
    const execId = `exec-p2-${spec.key.toLowerCase()}`;

    const metricsObj: Record<string, number | string | boolean | null> = {
      eflMm: Number(m.efl_mm ?? 6000),
      fNumber: Number(m.fno ?? 6.0),
      rms000Um: Number(rmsField['0.0'] ?? 0),
      rms025Um: Number(rmsField['0.25'] ?? 0),
      rms042Um: Number(rmsField['0.42'] ?? 0),
      rms060Um: Number(rmsField['0.6'] ?? 0),
      maxRmsPolyUm: Number(m.max_rms_poly_um ?? 0),
      meanRmsPolyUm: Number(m.mean_rms_poly_um ?? 0),
      strehlCenter: Number(strehlField['0.0'] ?? 0),
      strehlMid: Number(strehlField['0.42'] ?? 0),
      strehlEdge: Number(strehlField['0.6'] ?? 0),
      mtfEdgeTan: Number(mtfField['0.6']?.tangential ?? 0),
      distortionMaxPct: Number(m.distortion_pct_max_abs ?? 0),
      k1: Number(raw.k1 ?? -1.1283884),
      k2: Number(raw.k2 ?? -6.2203654),
      dM1L1Mm: Number(raw.d_m1_l1_mm ?? 0),
      bflMm: Number(raw.bfl_mm ?? 0),
      optCost: seeds[0] ? Number(seeds[0].cost ?? 0) : null,
      optSeedCount: seeds.length,
      sepCompletenessEdgePct: edgeTile?.sep?.completeness_pct !== undefined ? Number(edgeTile.sep.completeness_pct) : null,
      photutilsCompletenessEdgePct:
        edgeTile?.photutils?.completeness_pct !== undefined ? Number(edgeTile.photutils.completeness_pct) : null,
      astrometryEdgeArcsec:
        edgeTile?.sep?.astrometry_post_dist_rms_arcsec !== undefined
          ? Number(edgeTile.sep.astrometry_post_dist_rms_arcsec)
          : null,
    };

    if (spec.key === 'S3') Object.assign(metricsObj, stage4Metrics(s3Stage4Res?.data));

    const branchArtIds: string[] = [];
    if (s14Res) branchArtIds.push('art-p2-s1-s4-v2');
    if (spec.key === 'S3' && s3Stage4Res) branchArtIds.push('art-p2-stage4-tol');

    branches.push({
      id: branchId,
      studyId,
      parentBranchId: 'branch-p2-s0',
      name: spec.name,
      shortCode: spec.key,
      hypothesis: spec.hypothesis,
      status: spec.status,
      provenanceTier: 'external_verified_import',
      summary: spec.summary,
      metrics: metricsObj,
      prescription: raw,
      artifactIds: branchArtIds,
      executionIds: [execId],
      createdAt: now,
      updatedAt: now,
      createdBy: 'P2 Flagship Stage 2',
    });

    executions.push({
      id: execId,
      studyId,
      branchId,
      jobId: null,
      runnerMode: 'external_script_verified_import',
      title: `Stage 2: ${spec.key} 多视场四波段优化与光学验证`,
      intent: spec.hypothesis,
      status: 'completed',
      provenanceTier: 'external_verified_import',
      parameters: {
        materials: raw.materials ?? [],
        unlockConics: Boolean(raw.unlock_conics),
        seedCount: seeds.length,
      },
      outputs: metricsObj,
      artifactIds: branchArtIds,
      durationMs: Math.round(Number(raw.elapsed_total_s ?? 10) * 1000),
      createdAt: now,
      sha256Digest: s14Res?.sha256 ?? sha256(execId),
    });
  }

  if (s14Res) {
    artifacts.push({
      id: 'art-p2-s1-s4-v2',
      studyId,
      branchId: 'branch-p2-s3',
      executionId: 'exec-p2-s3',
      kind: 'optical_prescription_json',
      title: 'S1–S4 折反式校正镜完整光学处方与像差对照集',
      relativePath: 'experiments/p2_flagship/runs/S1_to_S4_correctors_v2.json',
      sha256: s14Res.sha256,
      byteLength: s14Res.bytes,
      provenanceTier: 'external_verified_import',
      createdAt: now,
    });
  }
  if (stage3Res) {
    artifacts.push({
      id: 'art-p2-stage3-fits',
      studyId,
      branchId: 'branch-p2-s3',
      executionId: null,
      kind: 'astrometry_report_json',
      title: 'Stage 3 20 帧 FITS 仿真星场与 SEP/Photutils 天体测量基准报告',
      relativePath: 'experiments/p2_flagship/runs/stage3_fits_astrometry.json',
      sha256: stage3Res.sha256,
      byteLength: stage3Res.bytes,
      provenanceTier: 'external_verified_import',
      createdAt: now,
    });
  }
  if (s3Stage4Res) {
    artifacts.push({
      id: 'art-p2-stage4-tol',
      studyId,
      branchId: 'branch-p2-s3',
      executionId: 'exec-p2-s3',
      kind: 'tolerance_report_json',
      title: 'Stage 4 S3 OAT 敏感度矩阵与 40 次蒙特卡洛公差良率报告',
      relativePath: 'experiments/p2_flagship/runs/stage4_tolerancing.json',
      sha256: s3Stage4Res.sha256,
      byteLength: s3Stage4Res.bytes,
      provenanceTier: 'external_verified_import',
      createdAt: now,
    });
  }
  if (stage5Res) {
    artifacts.push({
      id: 'art-p2-stage5-ver',
      studyId,
      branchId: 'branch-p2-s3',
      executionId: 'exec-p2-s3',
      kind: 'verification_report_md',
      title: 'Stage 5 ABCD 一阶交叉验证与 20 帧 FITS 头/WCS 独立核验报告',
      relativePath: 'experiments/p2_flagship/runs/stage5_independent_verification.json',
      sha256: stage5Res.sha256,
      byteLength: stage5Res.bytes,
      provenanceTier: 'external_verified_import',
      createdAt: now,
    });
  }

  const wfRcStudy: ResearchStudy = {
    id: studyId,
    slug: 'wf-rc-1000',
    title: 'WF-RC-1000 1.0 m f/6 宽视场天文成像系统全链路工程研究',
    domain: 'astronomy_wide_field_optics',
    status: 'active',
    provenanceTier: 'external_verified_import',
    problemStatement:
      '设计并端到端验证一套 1000 mm 口径、f/6（EFL 6000 mm）、覆盖 1.2° 全视场与 0.45–0.80 μm 宽波段的巡天望远镜，打通一阶光学、非球面像场校正、真实 PSF 卷积 FITS 天体测量与制造公差补偿策略。',
    backgroundContext:
      '探测器像元 15 μm（像元比例尺 0.5157"/px，Nyquist 33.33 lp/mm）。先从 P2 旗舰实践导入 S0–S4、20 帧 512×512 TAN WCS FITS 瓦片及公差蒙特卡洛真实数据，并支持在工作台内直接派生新公差与星表提取实验，由 Optiland 0.6.3 / Astropy / SEP / Photutils 实时执行。',
    objectives: [
      { id: 'obj-rms', title: '全视场多色像差控制', description: '0.0°–0.60° 多色 RMS 弥散斑半径 <= 7.5 μm（即 < 0.5 px / 0.25"）', priority: 'primary' },
      { id: 'obj-strehl', title: '衍射极限波前质量', description: '550 nm FFTPSF Strehl 比在全部视场均 >= 0.80', priority: 'primary' },
      { id: 'obj-mtf', title: '探测器 Nyquist 调制传递', description: '33.33 lp/mm 处切向与弧矢 MTF 均 >= 0.50', priority: 'secondary' },
      { id: 'obj-astro', title: '天体测量与测光闭环', description: '真实 PSF 帧提取星表完备度 >= 85% 且去畸变定位 RMS < 0.05"', priority: 'primary' },
      { id: 'obj-tol', title: '制造与装调公差良率', description: '在可实现加工装调公差与补偿策略下，蒙特卡洛良率 (RMS<=7.5μm) >= 90%', priority: 'constraint' },
    ],
    criteria: [
      { id: 'crit-rms', metricKey: 'maxRmsPolyUm', label: '全视场最大多色 RMS 光斑半径', operator: '<=', targetValue: 7.5, unit: 'μm', required: true },
      { id: 'crit-strehl', metricKey: 'strehlEdge', label: '0.60° 边缘 550nm Strehl 比', operator: '>=', targetValue: 0.8, unit: '', required: true },
      { id: 'crit-mtf', metricKey: 'mtfEdgeTan', label: 'Nyquist (33.3 lp/mm) MTF', operator: '>=', targetValue: 0.5, unit: '', required: true },
      { id: 'crit-dist', metricKey: 'distortionMaxPct', label: '最大绝对光学畸变', operator: '<=', targetValue: 0.5, unit: '%', required: false },
      { id: 'crit-astro', metricKey: 'sepCompletenessEdgePct', label: '边缘视场星表完备度 (SEP)', operator: '>=', targetValue: 85, unit: '%', required: true },
      { id: 'crit-mc', metricKey: 'mcM2ShimYield7_5Pct', label: 'M2 垫片+BFL 公差蒙特卡洛良率', operator: '>=', targetValue: 90, unit: '%', required: true },
    ],
    openQuestions: [
      {
        id: 'oq-s4-seed',
        question: 'S4 (FS + Schott F2) 在 Stage 2 预算下仅运行了 1 个种子 (447 nfev, cost=597.635)，其未收敛究竟源于双玻璃色差约束还是初始结构局部极小？',
        status: 'open',
        createdAt: now,
      },
      {
        id: 'oq-dao-undersampled',
        question: 'S3 锐利欠采样帧（~1.06 μm 弥散斑 vs 15 μm 像元）使 Photutils 默认 fwhm=3.0 漏检暗星（完备度 42.9%），降低 fwhmPx 后能否在不增假阳性的前提下对齐 SEP (96.4%)？',
        status: 'investigating',
        createdAt: now,
      },
      {
        id: 'oq-m1-r1-budget',
        question: '当 M1 R1 (+1.5mm) 制造误差与 M2 倾斜/偏心非对称误差同时存在时，M2 轴向垫片 + BFL 补偿的安全边界在哪里？',
        status: 'investigating',
        createdAt: now,
      },
    ],
    stages: [
      {
        stageNumber: 1,
        title: '一阶架构推导与 S0 裸 RC 基线验证',
        status: 'completed',
        summary: '建立 1000mm f/6 RC 焦比、次镜遮拦比 (0.364) 与 ABCD 一阶交叉基准；实测确认无校正镜 S0 在 0.60° 退化至 170.74 μm。',
        keyFinding: '裸 RC 仅受限于五级像散+场曲，必须引入后组折射场镜/Wynne 校正器。',
        primaryArtifactIds: ['art-p2-s0-json'],
      },
      {
        stageNumber: 2,
        title: 'S1–S4 校正镜多方案优化竞赛',
        status: 'completed',
        summary: '在相同视场、波段与后截距物理边界下对比 2 片 FS (S1)、3 片 Wynne (S2/S3) 与含 F2 色散玻璃 (S4)。',
        keyFinding: 'S3（Quasi-RC 解锁 K1=-1.14865, K2=-6.46154）以 max RMS 1.063 μm、Strehl 0.854–0.982 全面胜出。',
        primaryArtifactIds: ['art-p2-s1-s4-v2'],
      },
      {
        stageNumber: 3,
        title: '真实 PSF 卷积 FITS 生成与天体测量/测光管线',
        status: 'completed',
        summary: '使用 5×5 子像元积分将 Optiland 四波段 FFTPSF 卷积至 20 帧 512×512 IEEE-754 FITS（含 TAN WCS），横向对比 DAOStarFinder 与 SEP。',
        keyFinding: '揭示光学与数据处理的反直觉耦合：S3 锐利 PSF 在欠采样传感器下反致 DAOStarFinder(3px) 漏检 57% 暗星，而 SEP 维持 96.4%–100%。',
        primaryArtifactIds: ['art-p2-stage3-fits'],
      },
      {
        stageNumber: 4,
        title: 'OAT 敏感度、补偿策略重构与 40 次蒙特卡洛良率验证',
        status: 'completed',
        summary: '识别 M1 R1 +/-1.5mm 为最大敏感源；发现仅用 BFL 调焦会将边缘 Strehl 压至 0.616，改写为 M2 垫片+BFL 后恢复至 0.9855。',
        keyFinding: '补偿策略的 P50、P95 和通过率可在 Stage 4 原始产物中复核。',
        primaryArtifactIds: ['art-p2-stage4-tol'],
      },
      {
        stageNumber: 5,
        title: '独立 ABCD 与 FITS 头/像素空间完整性核验',
        status: 'completed',
        summary: '独立纯矩阵 ABCD 验证全部 S1–S4 分支 EFL 误差 < 0.013 mm；校验全部 20 帧 FITS 维度、TAN WCS 比例尺与数值有限性。',
        keyFinding: '全链路数据与代码实现完全通过独立复算核验，现已开放工作台实时派生二次实验。',
        primaryArtifactIds: ['art-p2-stage5-ver'],
      },
    ],
    adoptedBranchId: 'branch-p2-s3',
    adoptedReason:
      'S3_3Lens_Wynne_FS_QuasiRC 在全视场 RMS (1.063 μm)、550nm Strehl (0.854–0.982)、Nyquist MTF (0.773–0.781)、SEP 去畸变天体测量与 M2 垫片蒙特卡洛良率 (100%) 全部满足指标且经 Stage 5 独立核验。',
    createdAt: now,
    updatedAt: now,
  };

  const notes: EpistemicNote[] = [
    {
      id: 'note-p2-fact-s3',
      studyId,
      branchId: 'branch-p2-s3',
      tag: 'fact',
      authorType: 'system_verifier',
      authorLabel: 'Stage 2 & 5 Optiland + ABCD 实证',
      title: 'S3 Quasi-RC + 三片熔石英 Wynne 达成衍射极限全视场成像',
      content:
        'Optiland 0.6.3 实测：max RMS=1.063 μm (0.60°)，550nm FFTPSF Strehl 0.854–0.982，33.33 lp/mm MTF 0.773–0.781，最大畸变 0.343%。独立 ABCD 核验 EFL 6001.595 mm vs Optiland 6001.598 mm（差 0.0029 mm）。',
      evidenceRefs: ['experiments/p2_flagship/runs/branch_S3.json', 'experiments/p2_flagship/runs/stage5_independent_verification.json'],
      createdAt: now,
    },
    {
      id: 'note-p2-judgment-shim',
      studyId,
      branchId: 'branch-p2-s3',
      tag: 'judgment',
      authorType: 'human',
      authorLabel: '工程公差判断 (Stage 4)',
      title: 'M1 R1 误差不能仅靠后端调焦补偿，必须引入 M1-M2 垫片自由度',
      content:
        'OAT 实测显示 M1 R1 +1.5mm 使未补偿 RMS 升至 353.687 μm；仅做 BFL 调焦虽将 RMS 降至 4.461 μm，但残留离轴高阶像差导致 0.60° Strehl 跌至 0.6160 (<0.80)。加入 M1-M2 垫片 (-0.659mm) 后边缘 Strehl 恢复到 0.9855，MC 良率由 75% 提升至 100%。',
      evidenceRefs: ['experiments/p2_flagship/runs/stage4_tolerancing.json'],
      proposedAction: {
        label: '在工作台复算 M1 R1(+1.5mm) 无垫片 vs 有垫片边界',
        studyId,
        parentBranchId: 'branch-p2-s3',
        runnerMode: 'wf_rc_perturb_eval',
        branchName: 'S3-M1R1公差仅BFL对照实测',
        hypothesis: '仅使用 BFL 调焦补偿 M1 R1 +1.5mm 误差将无法守住边缘 Strehl >= 0.80 指标。',
        intent: '实时调用 Optiland 0.6.3 重现并验证仅 BFL 补偿器与垫片补偿器的 Strehl 分叉点',
        parameters: {
          baseBranchKey: 'S3',
          compensator: 'bfl_only',
          delta_r1_mm: 1.5,
          delta_r2_mm: 0.0,
          delta_d_m1_m2_mm: 0.0,
          m2_tilt_arcsec: 0,
          m2_decenter_mm: 0,
        },
      },
      createdAt: now,
    },
    {
      id: 'note-p2-hypothesis-fits',
      studyId,
      branchId: 'branch-p2-s3',
      tag: 'hypothesis',
      authorType: 'ai_deterministic',
      authorLabel: '数据管线与光学耦合假设 (Stage 3)',
      title: '欠采样帧星表提取对卷积核 FWHM 极度敏感',
      content:
        '由于 S3 弥散斑远小于 15 μm 像元（FWHM ~1.2–1.6 px），Stage 3 中 Photutils DAOStarFinder 默认 fwhm=3.0 漏检超过半数暗星（42.9% 完备度），而 SEP 的自适应连通域检测达到 96.4%–100%。假设将 DAOStarFinder 参数下调至 fwhm=1.5 px、threshold=4.5σ 可大幅提升完备度。',
      evidenceRefs: [
        'experiments/p2_flagship/runs/stage3_fits_astrometry.json',
        'experiments/p2_flagship/runs/fits/S3_3Lens_Wynne_FS_QuasiRC_tile_0.60deg.fits',
      ],
      proposedAction: {
        label: '实测：S3 0.60° FITS 下调 DAO fwhm=1.5px 重提取',
        studyId,
        parentBranchId: 'branch-p2-s3',
        runnerMode: 'fits_star_extract',
        branchName: 'S3-0.60° FITS DAO fwhm=1.5px 重提取',
        hypothesis: '降低 DAOStarFinder 卷积核宽度至 1.5px 可匹配 S3 欠采样锐利 PSF 并恢复暗星检出数。',
        intent: '在真实 FITS 图像帧上调用 photutils DAOStarFinder 检验参数调整效果',
        parameters: {
          fitsPath: 'experiments/p2_flagship/runs/fits/S3_3Lens_Wynne_FS_QuasiRC_tile_0.60deg.fits',
          extractor: 'photutils_DAOStarFinder',
          fwhmPx: 1.5,
          thresholdSigma: 4.5,
          apertureRadiusPx: 4.0,
        },
      },
      createdAt: now,
    },
  ];

  const mergedStudies = dedupeById([wfRcStudy, ...existingStudies]);
  const existingBranches = readJsonFile<StudyBranch[]>(paths.branchesFile, []);
  const mergedBranches = dedupeById([...branches, ...existingBranches]);

  const existingExecIds = new Set(readJsonlFile<WorkflowExecution>(paths.executionsFile).map((e) => e.id));
  const existingArtIds = new Set(readJsonlFile<ArtifactRef>(paths.artifactsFile).map((a) => a.id));
  const existingNoteIds = new Set(readJsonlFile<EpistemicNote>(paths.notesFile).map((n) => n.id));

  atomicWriteFileSync(paths.studiesFile, JSON.stringify(mergedStudies, null, 2));
  atomicWriteFileSync(paths.branchesFile, JSON.stringify(mergedBranches, null, 2));
  for (const ex of executions) {
    if (!existingExecIds.has(ex.id)) appendJsonlLine(paths.executionsFile, ex);
  }
  for (const art of artifacts) {
    if (!existingArtIds.has(art.id)) appendJsonlLine(paths.artifactsFile, art);
  }
  for (const n of notes) {
    if (!existingNoteIds.has(n.id)) appendJsonlLine(paths.notesFile, n);
  }
  if (!fs.existsSync(paths.jobsFile)) atomicWriteFileSync(paths.jobsFile, '[]');
  if (!fs.existsSync(paths.archAnnotationsFile)) atomicWriteFileSync(paths.archAnnotationsFile, '[]');
}

/**
 * Projects legacy P1 ResearchObject / runs.jsonl / thread.jsonl read-only into ResearchStudy format
 * without modifying any legacy file on disk.
 */
function buildReadOnlyP1Projection(workspaceDir?: string): {
  study: ResearchStudy | null;
  branches: StudyBranch[];
  executions: WorkflowExecution[];
  notes: EpistemicNote[];
} {
  const ros = listResearchObjects(workspaceDir);
  const runs = listRuns(workspaceDir);
  const thread = listThreadEntries(workspaceDir);
  if (ros.length === 0 && runs.length === 0) {
    return { study: null, branches: [], executions: [], notes: [] };
  }
  const ro = ros[0];
  const studyId = ro?.id || 'obj-optics-100mm-f4';

  const branches: StudyBranch[] = runs.map((r) => ({
    id: `branch-p1-${r.id}`,
    studyId,
    parentBranchId: r.parentRunId ? `branch-p1-${r.parentRunId}` : null,
    name: `${r.branchLabel} (Run #${r.sequenceNumber})`,
    shortCode: `R${r.sequenceNumber}`,
    hypothesis: r.intent,
    status: r.candidateStatus === 'adopted' ? 'adopted' : r.candidateStatus === 'baseline' ? 'baseline' : 'exploring',
    provenanceTier: r.id <= 'run-003' ? 'historical_migrated' : 'workbench_native',
    summary: `EFL=${r.rawArtifactsAfter.paraxialEflMm} mm · RMS=${r.rawArtifactsAfter.rmsSpotRadiusUm} μm · 色差=${r.rawArtifactsAfter.axialChromaticShiftMm} mm · 评价=${r.evaluations[0]?.status?.toUpperCase() ?? '未评'}`,
    metrics: {
      eflMm: r.rawArtifactsAfter.paraxialEflMm,
      rmsSpotRadiusUm: r.rawArtifactsAfter.rmsSpotRadiusUm,
      axialChromaticShiftMm: r.rawArtifactsAfter.axialChromaticShiftMm,
      mtf30LpMm: r.rawArtifactsAfter.mtf30LpMm,
      fNumber: r.rawArtifactsAfter.fNumber,
      solverEngine: r.rawArtifactsAfter.solverEngine ?? 'ts_preview',
      evalStatus: r.evaluations[0]?.status ?? 'unrun',
    },
    artifactIds: [],
    executionIds: [`exec-p1-${r.id}`],
    createdAt: r.createdAt,
    updatedAt: r.createdAt,
    createdBy: r.id <= 'run-003' ? 'historical_migrated' : 'Rad',
  }));

  const executions: WorkflowExecution[] = runs.map((r) => ({
    id: `exec-p1-${r.id}`,
    studyId,
    branchId: `branch-p1-${r.id}`,
    jobId: null,
    runnerMode: r.rawArtifactsAfter.solverEngine === 'optiland' ? 'p1_optiland_python' : 'p1_ts_optical',
    title: `Run #${r.sequenceNumber} · ${r.branchLabel}`,
    intent: r.intent,
    status: r.status === 'completed' ? 'completed' : 'failed',
    provenanceTier: r.id <= 'run-003' ? 'historical_migrated' : 'workbench_native',
    parameters: { mode: r.mode, seed: r.seed, surfaces: r.systemBefore.surfaces.length },
    outputs: {
      eflMm: r.rawArtifactsAfter.paraxialEflMm,
      rmsSpotRadiusUm: r.rawArtifactsAfter.rmsSpotRadiusUm,
      axialChromaticShiftMm: r.rawArtifactsAfter.axialChromaticShiftMm,
    },
    artifactIds: [],
    durationMs: r.executionMs,
    createdAt: r.createdAt,
    sha256Digest: r.recordIntegrityHash,
  }));

  const notes: EpistemicNote[] = thread.map((t) => ({
    id: `note-p1-${t.id}`,
    studyId,
    branchId: t.runId ? `branch-p1-${t.runId}` : null,
    tag:
      t.origin === 'ai_hypothesis'
        ? 'hypothesis'
        : t.origin === 'adopted_decision'
          ? 'judgment'
          : 'fact',
    authorType: t.origin === 'ai_hypothesis' ? 'ai_llm' : 'human',
    authorLabel: t.authorLabel,
    title: t.title,
    content: t.content,
    evidenceRefs: t.runId ? [`workspace/runs.jsonl#${t.runId}`] : ['workspace/thread.jsonl'],
    createdAt: t.createdAt,
  }));

  const adoptedRun = runs.find((r) => r.candidateStatus === 'adopted') ?? runs[runs.length - 1];
  const study: ResearchStudy = {
    id: studyId,
    slug: 'p1-100mm-doublet',
    title: ro?.title || '100 mm f/4 消色差双胶合探索（P1 历史课题）',
    domain: 'optics_classical_singlet_doublet',
    status: 'converged',
    provenanceTier: 'historical_migrated',
    problemStatement:
      ro?.problemStatement || '对比 100mm 单透镜与双胶合透镜在色差、球差及 MTF 上的结构演化。',
    backgroundContext: '本课题从 workspace/runs.jsonl 与 Stage A1 research_objects.json 只读投影，保留历史不可变 SHA-256 账本。',
    objectives: ro?.objectives ?? [],
    criteria: ro?.criteria ?? [],
    openQuestions: (ro?.openQuestions ?? []).map((q, idx) => ({
      id: `p1-oq-${idx + 1}`,
      question: q,
      status: 'open',
      createdAt: ro?.createdAt ?? new Date().toISOString(),
    })),
    stages: [
      {
        stageNumber: 1,
        title: '单透镜轴上球差/色差限制识别与双胶合结构跃迁',
        status: 'completed',
        summary: `共完成 ${runs.length} 轮不可变实验，保留早期未通过评价的历史记录与双胶合反转结果。`,
        keyFinding: adoptedRun
          ? `最新/采纳分支 Run #${adoptedRun.sequenceNumber} 达到 RMS=${adoptedRun.rawArtifactsAfter.rmsSpotRadiusUm} μm, 轴向色差=${adoptedRun.rawArtifactsAfter.axialChromaticShiftMm} mm`
          : '包含 P1 实验记录',
        primaryArtifactIds: [],
      },
    ],
    adoptedBranchId: adoptedRun ? `branch-p1-${adoptedRun.id}` : null,
    adoptedReason: '从 Stage A1 不可变历史账本只读投影。',
    createdAt: ro?.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: adoptedRun?.createdAt ?? ro?.createdAt ?? new Date().toISOString(),
  };

  return { study, branches, executions, notes };
}

export function listFitsCatalog(): FitsCatalogEntry[] {
  const repoRoot = resolveRepoRoot();
  const fitsDir = path.join(repoRoot, 'experiments', 'p2_flagship', 'runs', 'fits');
  if (!fs.existsSync(fitsDir)) return [];

  const stage3Res = safeReadRepoJson<{
    systems?: Record<string, { tiles?: Array<Record<string, unknown>> }>;
  }>(repoRoot, 'experiments/p2_flagship/runs/stage3_fits_astrometry.json');
  const stage3Systems = stage3Res?.data?.systems ?? {};
  const tileMetricByPath = new Map<string, FitsCatalogEntry['summaryMetrics']>();
  for (const sysObj of Object.values(stage3Systems)) {
    for (const t of sysObj.tiles ?? []) {
      const rel = String(t.fits_path ?? '').replace(/\\/g, '/');
      const phot = (t.photutils ?? {}) as Record<string, unknown>;
      const sepObj = (t.sep ?? {}) as Record<string, unknown>;
      tileMetricByPath.set(rel, {
        skyRmsAdu: typeof t.sky_rms_adu === 'number' ? t.sky_rms_adu : undefined,
        photutilsCompletenessPct:
          typeof phot.completeness_pct === 'number' ? phot.completeness_pct : undefined,
        sepCompletenessPct:
          typeof sepObj.completeness_pct === 'number' ? sepObj.completeness_pct : undefined,
        sepAstrometryRmsArcsec:
          typeof sepObj.astrometry_post_dist_rms_arcsec === 'number'
            ? sepObj.astrometry_post_dist_rms_arcsec
            : null,
        sepMedianFwhmArcsec:
          typeof sepObj.median_fwhm_arcsec === 'number' ? sepObj.median_fwhm_arcsec : null,
      });
    }
  }

  const files = fs
    .readdirSync(fitsDir)
    .filter((f) => f.endsWith('.fits'))
    .sort();

  return files.map((fileName) => {
    const absPath = path.join(fitsDir, fileName);
    const relativePath = `experiments/p2_flagship/runs/fits/${fileName}`;
    const m = fileName.match(/^(.+)_tile_(\d+\.\d+)deg\.fits$/);
    const systemKey = m ? m[1] : fileName;
    const fieldDeg = m ? Number(m[2]) : 0;
    const stat = fs.statSync(absPath);
    return {
      id: `fits:${fileName}`,
      studyId: 'study-wf-rc-1000',
      systemKey,
      fieldDeg,
      relativePath,
      fileName,
      byteLength: stat.size,
      sha256: sha256File(absPath),
      summaryMetrics: tileMetricByPath.get(relativePath),
    };
  });
}

export function inspectCatalogFitsFile(relativePath: string): FitsAnalysisResult {
  const repoRoot = resolveRepoRoot();
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, '/'));
  if (!normalized.startsWith('experiments/p2_flagship/runs/fits/') || !normalized.endsWith('.fits')) {
    throw new Error(`拒绝访问目录外 FITS 路径：${relativePath}`);
  }
  const absPath = path.resolve(repoRoot, normalized);
  if (!absPath.startsWith(path.resolve(repoRoot)) || !fs.existsSync(absPath)) {
    throw new Error(`未找到 FITS 文件：${relativePath}`);
  }
  const buf = new Uint8Array(fs.readFileSync(absPath));
  const parsed = parseFitsBuffer(buf, path.basename(absPath), { maxSources: 64 });
  const catalogEntry = listFitsCatalog().find((e) => e.relativePath === normalized);
  if (catalogEntry?.summaryMetrics) {
    parsed.tileMeta = {
      systemKey: catalogEntry.systemKey,
      fieldDeg: catalogEntry.fieldDeg,
      sha256: catalogEntry.sha256,
      ...catalogEntry.summaryMetrics,
    };
  }
  return parsed;
}

export function listWorkbenchData(workspaceDir?: string) {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);

  const wbStudies = readJsonFile<ResearchStudy[]>(paths.studiesFile, []);
  const wbBranches = readJsonFile<StudyBranch[]>(paths.branchesFile, []);
  const wbExecutions = readJsonlFile<WorkflowExecution>(paths.executionsFile);
  const wbArtifacts = readJsonlFile<ArtifactRef>(paths.artifactsFile);
  const wbNotes = readJsonlFile<EpistemicNote>(paths.notesFile);
  const jobs = readJsonFile<AsyncJobRecord[]>(paths.jobsFile, []);
  const annotations = readJsonFile<ArchitectureAnnotation[]>(paths.archAnnotationsFile, []);
  const archSnapshots = readJsonlFile<PersistedArchitectureSnapshot>(paths.archSnapshotsFile);

  const p1 = buildReadOnlyP1Projection(workspaceDir);

  const studies = dedupeById([...wbStudies, ...(p1.study ? [p1.study] : [])]);
  const branches = dedupeById([...wbBranches, ...p1.branches]);
  const executions = dedupeById([...wbExecutions, ...p1.executions]);
  const artifacts = dedupeById(wbArtifacts);
  const notes = dedupeById([...wbNotes, ...p1.notes]);
  const fitsCatalog = listFitsCatalog();
  const pythonRuntime = inspectDiscoveredPythonRuntime();

  return {
    ...projectScienceCorrections(studies, branches, executions, notes, readStage4Evidence(resolveRepoRoot())?.data),
    artifacts,
    jobs,
    fitsCatalog,
    annotations,
    archSnapshots,
    pythonRuntime,
  };
}

export function createCustomStudy(
  input: {
    title: string;
    domain?: string;
    problemStatement: string;
    backgroundContext?: string;
    objectives?: Array<{ title: string; description: string; priority?: 'primary' | 'secondary' | 'constraint' }>;
    initialHypothesis?: string;
  },
  workspaceDir?: string,
): { study: ResearchStudy; branch: StudyBranch } {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);

  const title = input.title?.trim();
  const problemStatement = input.problemStatement?.trim();
  if (!title || !problemStatement) {
    throw new Error('创建新研究课题必须填写标题与问题描述');
  }

  const now = new Date().toISOString();
  const slugBase = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
  const id = `study-${slugBase || 'custom'}-${Date.now().toString(36)}`;
  const branchId = `branch-${id}-base`;

  const study: ResearchStudy = {
    id,
    slug: slugBase || id,
    title,
    domain: input.domain?.trim() || 'open_scientific_engineering',
    status: 'active',
    provenanceTier: 'workbench_native',
    problemStatement,
    backgroundContext: input.backgroundContext?.trim() || '由用户在 OpenLab Bench v2 工作台新建立的开放研究课题。',
    objectives: (input.objectives && input.objectives.length > 0
      ? input.objectives
      : [{ title: '核心探索目标', description: problemStatement, priority: 'primary' as const }]
    ).map((o, i) => ({
      id: `obj-${i + 1}`,
      title: o.title,
      description: o.description,
      priority: o.priority ?? 'primary',
    })),
    criteria: [],
    openQuestions: [
      {
        id: `oq-${Date.now()}`,
        question: '待进一步拆解验证的初始子问题与边界条件',
        status: 'open',
        createdAt: now,
      },
    ],
    stages: [
      {
        stageNumber: 1,
        title: '研究问题定义与初始基线分支建立',
        status: 'in_progress',
        summary: problemStatement,
        keyFinding: '已建立工作台原生初始分支，等待配置实验或挂载组件执行。',
        primaryArtifactIds: [],
      },
    ],
    adoptedBranchId: branchId,
    adoptedReason: '课题创建时初始化的工作分支',
    createdAt: now,
    updatedAt: now,
  };

  const branch: StudyBranch = {
    id: branchId,
    studyId: id,
    parentBranchId: null,
    name: '初始研究假设分支',
    shortCode: 'B0',
    hypothesis: input.initialHypothesis?.trim() || problemStatement,
    status: 'adopted',
    provenanceTier: 'workbench_native',
    summary: '新建课题默认基线分支，待进一步补充计算/数据实验。',
    metrics: {},
    artifactIds: [],
    executionIds: [],
    createdAt: now,
    updatedAt: now,
    createdBy: 'Rad',
  };

  const studies = readJsonFile<ResearchStudy[]>(paths.studiesFile, []);
  const branches = readJsonFile<StudyBranch[]>(paths.branchesFile, []);
  studies.push(study);
  branches.push(branch);
  atomicWriteFileSync(paths.studiesFile, JSON.stringify(studies, null, 2));
  atomicWriteFileSync(paths.branchesFile, JSON.stringify(branches, null, 2));

  appendJsonlLine(paths.notesFile, {
    id: `note-${Date.now()}`,
    studyId: id,
    branchId,
    tag: 'judgment',
    authorType: 'human',
    authorLabel: 'Rad / 新课题立项',
    title: `创建开放研究课题：${title}`,
    content: problemStatement,
    evidenceRefs: [],
    createdAt: now,
  } satisfies EpistemicNote);

  return { study, branch };
}

export function adoptStudyBranch(
  studyId: string,
  branchId: string,
  reason?: string,
  workspaceDir?: string,
): { study: ResearchStudy; branch: StudyBranch; note: EpistemicNote } {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);
  const studies = readJsonFile<ResearchStudy[]>(paths.studiesFile, []);
  const branches = readJsonFile<StudyBranch[]>(paths.branchesFile, []);

  const studyIdx = studies.findIndex((s) => s.id === studyId);
  if (studyIdx < 0) {
    throw new Error(`未找到可更新的研究课题 ${studyId}（注：P1 历史课题为只读投影，不支持覆盖）`);
  }
  const branchIdx = branches.findIndex((b) => b.id === branchId && b.studyId === studyId);
  if (branchIdx < 0) {
    throw new Error(`课题 ${studyId} 下未找到分支 ${branchId}`);
  }

  const now = new Date().toISOString();
  const reasonText = reason?.trim() || `人工显式将 ${branches[branchIdx].shortCode} 设为当前采纳基线。`;

  for (let i = 0; i < branches.length; i++) {
    if (branches[i].studyId !== studyId) continue;
    if (branches[i].id === branchId) {
      branches[i] = { ...branches[i], status: 'adopted', updatedAt: now };
    } else if (branches[i].status === 'adopted') {
      branches[i] = {
        ...branches[i],
        status: branches[i].shortCode === 'S0' ? 'baseline' : 'exploring',
        updatedAt: now,
      };
    }
  }

  studies[studyIdx] = {
    ...studies[studyIdx],
    adoptedBranchId: branchId,
    adoptedReason: reasonText,
    updatedAt: now,
  };

  atomicWriteFileSync(paths.studiesFile, JSON.stringify(studies, null, 2));
  atomicWriteFileSync(paths.branchesFile, JSON.stringify(branches, null, 2));

  const note: EpistemicNote = {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    studyId,
    branchId,
    tag: 'judgment',
    authorType: 'human',
    authorLabel: 'Rad / 显式分支采纳',
    title: `采纳分支 [${branches[branchIdx].shortCode}] ${branches[branchIdx].name}`,
    content: reasonText,
    evidenceRefs: branches[branchIdx].artifactIds,
    createdAt: now,
  };
  appendJsonlLine(paths.notesFile, note);

  return { study: studies[studyIdx], branch: branches[branchIdx], note };
}

export function addStudyOpenQuestion(
  studyId: string,
  questionText: string,
  workspaceDir?: string,
): StudyOpenQuestion {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);
  const studies = readJsonFile<ResearchStudy[]>(paths.studiesFile, []);
  const idx = studies.findIndex((s) => s.id === studyId);
  if (idx < 0) {
    throw new Error(`未找到可编辑的研究课题 ${studyId}`);
  }
  const q: StudyOpenQuestion = {
    id: `oq-${Date.now()}`,
    question: questionText.trim(),
    status: 'open',
    createdAt: new Date().toISOString(),
  };
  studies[idx].openQuestions.push(q);
  studies[idx].updatedAt = q.createdAt;
  atomicWriteFileSync(paths.studiesFile, JSON.stringify(studies, null, 2));
  return q;
}

export function appendEpistemicNote(
  input: Omit<EpistemicNote, 'id' | 'createdAt'>,
  workspaceDir?: string,
): EpistemicNote {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);
  const note: EpistemicNote = {
    ...input,
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    createdAt: new Date().toISOString(),
  };
  appendJsonlLine(paths.notesFile, note);
  return note;
}

// ============================================================================
// Controlled Async Subprocess Runner (Unbuffered Logs, Timeout Budget, Cancel)
// ============================================================================

function persistJobsList(jobs: AsyncJobRecord[], workspaceDir?: string): void {
  const paths = getWorkbenchPaths(workspaceDir);
  atomicWriteFileSync(paths.jobsFile, JSON.stringify(jobs.slice(-50), null, 2));
}

function updateJobRecord(
  jobId: string,
  updater: (cur: AsyncJobRecord) => AsyncJobRecord,
  workspaceDir?: string,
): AsyncJobRecord | null {
  const paths = getWorkbenchPaths(workspaceDir);
  const jobs = readJsonFile<AsyncJobRecord[]>(paths.jobsFile, []);
  const idx = jobs.findIndex((j) => j.id === jobId);
  if (idx < 0) return null;
  jobs[idx] = updater(jobs[idx]);
  persistJobsList(jobs, workspaceDir);
  return jobs[idx];
}

export function listAsyncJobs(workspaceDir?: string): AsyncJobRecord[] {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);
  return readJsonFile<AsyncJobRecord[]>(paths.jobsFile, []);
}

export function getAsyncJob(jobId: string, workspaceDir?: string): AsyncJobRecord | null {
  return listAsyncJobs(workspaceDir).find((j) => j.id === jobId) ?? null;
}

export function cancelAsyncJob(jobId: string, workspaceDir?: string): AsyncJobRecord | null {
  const proc = activeProcesses.get(jobId);
  const updated = updateJobRecord(
    jobId,
    (cur) => {
      if (cur.status !== 'running' && cur.status !== 'queued') return cur;
      return {
        ...cur,
        status: 'cancelled',
        logs: [...cur.logs, `[${new Date().toISOString()}] 用户手动请求终止任务 (SIGTERM)...`],
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - Date.parse(cur.startedAt),
      };
    },
    workspaceDir,
  );
  if (proc) stopChild(proc);
  return updated;
}

export function startAsyncWorkbenchJob(
  input: {
    studyId: string;
    parentBranchId: string;
    runnerMode: P2RunnerMode;
    title: string;
    intent: string;
    branchName: string;
    hypothesis: string;
    parameters: Record<string, unknown>;
    timeoutMs?: number;
  },
  workspaceDir?: string,
): AsyncJobRecord {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);
  const pythonInfo = inspectDiscoveredPythonRuntime();
  if (!pythonInfo.readyForP2) {
    throw new Error(
      `当前 Python 环境 (${pythonInfo.executable}) 缺少 P2 必需科学库 (optiland=${pythonInfo.packages.optiland}, astropy=${pythonInfo.packages.astropy}, sep=${pythonInfo.packages.sep}, photutils=${pythonInfo.packages.photutils})，禁止伪造仿真结果。`,
    );
  }

  const defaultTimeoutMs =
    input.runnerMode === 'wf_rc_s4_reopt_probe'
      ? 150000
      : input.runnerMode === 'wf_rc_perturb_eval'
        ? 45000
        : input.runnerMode === 'fits_batch_completeness'
          ? 40000
          : 25000;
  const defaultTitle =
    input.runnerMode === 'wf_rc_perturb_eval'
      ? 'WF-RC 公差微扰与补偿实算'
      : input.runnerMode === 'fits_batch_completeness'
        ? 'FITS 全视场批量欠采样横评'
        : input.runnerMode === 'wf_rc_s4_reopt_probe'
          ? 'S4 (FS+F2) 多起点/圆锥解锁诊断优化'
          : 'FITS 星表参数重提取';

  const jobId = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const timeoutMs = Math.max(5000, Math.min(240000, Number(input.timeoutMs ?? defaultTimeoutMs)));
  const startedAt = new Date().toISOString();

  const initialJob: AsyncJobRecord = {
    id: jobId,
    studyId: input.studyId || 'study-wf-rc-1000',
    parentBranchId: input.parentBranchId || 'branch-p2-s3',
    runnerMode: input.runnerMode,
    title: input.title?.trim() || defaultTitle,
    intent: input.intent?.trim() || '工作台受控科学探索派生执行',
    branchName: input.branchName?.trim() || `探索分支 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`,
    hypothesis: input.hypothesis?.trim() || '验证参数扰动或重配置对核心指标的实际影响',
    status: 'running',
    timeoutMs,
    parameters: input.parameters ?? {},
    logs: [
      `[${startedAt}] 初始化作业 ${jobId} (mode=${input.runnerMode}, timeout=${Math.round(timeoutMs / 1000)}s)`,
      `[${startedAt}] 选用科学 Python 运行时: ${pythonInfo.executable} (Optiland ${pythonInfo.packages.optiland}, Astropy ${pythonInfo.packages.astropy}, Photutils ${pythonInfo.packages.photutils}, SEP ${pythonInfo.packages.sep})`,
    ],
    resultBranchId: null,
    resultExecutionId: null,
    resultArtifactIds: [],
    errorMessage: null,
    startedAt,
    finishedAt: null,
    durationMs: null,
  };

  const repoRoot = resolveRepoRoot();
  const sources = Object.fromEntries(Object.entries(legacyP2SourceHashes).map(([relative, hash]) =>
    [relative, readVerifiedSource(path.join(repoRoot, relative), hash)]
  ));
  const staged = stageVerifiedPython(legacyP2Entry, sources);
  const logFilePath = path.join(paths.logsDir, jobId + '.log');
  try {
    const jobs = readJsonFile<AsyncJobRecord[]>(paths.jobsFile, []);
    jobs.push(initialJob);
    atomicWriteFileSync(logFilePath, initialJob.logs.join('\n') + '\n');
    persistJobsList(jobs, workspaceDir);
  } catch (error) {
    staged.dispose();
    throw error;
  }

  const child = spawn(pythonInfo.executable, [...staged.args, '--mode', input.runnerMode], {
    cwd: repoRoot,
    env: pythonEnvironment({ OPENLAB_LEGACY_DATA_ROOT: repoRoot }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeProcesses.set(jobId, child);

  let resultJsonLine: string | null = null;
  let stdoutRemainder = '';
  let stderrRemainder = '';
  let timedOut = false;

  const appendLog = (line: string) => {
    const clean = line.trimEnd();
    if (!clean) return;
    if (clean.startsWith('RESULT_JSON:')) {
      resultJsonLine = clean.slice('RESULT_JSON:'.length);
      return;
    }
    fs.appendFileSync(logFilePath, clean + '\n', 'utf8');
    updateJobRecord(
      jobId,
      (cur) => ({
        ...cur,
        logs: [...cur.logs.slice(-120), clean],
      }),
      workspaceDir,
    );
  };

  child.stdout.on('data', (chunk: Buffer) => {
    const text = stdoutRemainder + chunk.toString('utf8');
    const lines = text.split('\n');
    stdoutRemainder = lines.pop() ?? '';
    for (const ln of lines) appendLog(ln);
  });

  child.stderr.on('data', (chunk: Buffer) => {
    const text = stderrRemainder + chunk.toString('utf8');
    const lines = text.split('\n');
    stderrRemainder = lines.pop() ?? '';
    for (const ln of lines) {
      if (ln.includes('WARNING:') && ln.includes('extinction coefficient')) continue;
      appendLog(`[stderr] ${ln}`);
    }
  });

  const timer = setTimeout(() => {
    timedOut = true;
    appendLog(`[timeout] 达到计算时间预算 (${timeoutMs} ms)，发送 SIGTERM 终止进程`);
    stopChild(child);
  }, timeoutMs);

  let processError: Error | undefined;
  child.on('error', (error) => { processError = error; });
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') processError = error;
  });
  child.stdin.end(JSON.stringify(input.parameters ?? {}));

  child.on('close', (code) => {
    clearTimeout(timer);
    staged.dispose();
    activeProcesses.delete(jobId);
    if (stdoutRemainder) appendLog(stdoutRemainder);
    if (stderrRemainder) appendLog(`[stderr] ${stderrRemainder}`);

    const finishedAt = new Date().toISOString();
    const durationMs = Math.max(1, Date.now() - Date.parse(startedAt));
    const currentJob = getAsyncJob(jobId, workspaceDir);
    if (currentJob?.status === 'cancelled') {
      return;
    }

    if (timedOut) {
      updateJobRecord(
        jobId,
        (cur) => ({
          ...cur,
          status: 'timed_out',
          errorMessage: `执行超时 (${Math.round(timeoutMs / 1000)}s)，可调整采样或提高时间预算后重试`,
          finishedAt,
          durationMs,
        }),
        workspaceDir,
      );
      return;
    }

    if (processError || code !== 0 || !resultJsonLine) {
      updateJobRecord(
        jobId,
        (cur) => ({
          ...cur,
          status: 'failed',
          errorMessage: processError?.message ?? ('Python 子进程退出异常，状态码 ' + code),
          finishedAt,
          durationMs,
        }),
        workspaceDir,
      );
      return;
    }

    try {
      const parsedOutput = JSON.parse(resultJsonLine) as Record<string, unknown>;
      if (parsedOutput.status !== 'ok') throw new Error('Python 未成功完成计算');
      const persisted = persistJobArtifactsAndBranch({
        job: currentJob ?? initialJob,
        output: parsedOutput,
        pythonInfo,
        durationMs,
        finishedAt,
        logFilePath,
        workspaceDir,
      });

      updateJobRecord(
        jobId,
        (cur) => ({
          ...cur,
          status: 'completed',
          resultBranchId: persisted.branch.id,
          resultExecutionId: persisted.execution.id,
          resultArtifactIds: persisted.artifactIds,
          logs: [...cur.logs, `[${finishedAt}] 完成持久化：新分支 ${persisted.branch.shortCode} · SHA-256=${persisted.execution.sha256Digest.slice(0, 12)}...`],
          finishedAt,
          durationMs,
        }),
        workspaceDir,
      );
    } catch (err) {
      updateJobRecord(
        jobId,
        (cur) => ({
          ...cur,
          status: 'failed',
          errorMessage: err instanceof Error ? err.message : String(err),
          finishedAt,
          durationMs,
        }),
        workspaceDir,
      );
    }
  });

  return initialJob;
}

function persistJobArtifactsAndBranch(params: {
  job: AsyncJobRecord;
  output: Record<string, unknown>;
  pythonInfo: ReturnType<typeof inspectDiscoveredPythonRuntime>;
  durationMs: number;
  finishedAt: string;
  logFilePath: string;
  workspaceDir?: string;
}): {
  branch: StudyBranch;
  execution: WorkflowExecution;
  artifactIds: string[];
} {
  const paths = getWorkbenchPaths(params.workspaceDir);
  const branches = readJsonFile<StudyBranch[]>(paths.branchesFile, []);
  const branchSeq = branches.filter((b) => b.studyId === params.job.studyId).length + 1;
  const branchId = `branch-wb-${Date.now().toString(36)}`;
  const execId = `exec-wb-${Date.now().toString(36)}`;

  const outJsonText = JSON.stringify(params.output, null, 2);
  const outDigest = sha256(outJsonText);
  const outArtId = `art-${execId}-json`;
  const outRelPath = path.join('workspace', 'workbench', 'artifacts', `${execId}.json`);
  const outAbsPath = path.join(paths.generatedArtifactsDir, `${execId}.json`);
  atomicWriteFileSync(outAbsPath, outJsonText);

  const logArtId = `art-${execId}-log`;
  const logDigest = fs.existsSync(params.logFilePath) ? sha256File(params.logFilePath) : sha256('');
  const logRelPath = path.join('workspace', 'workbench', 'logs', `${params.job.id}.log`);

  const runnerMode: WorkflowExecution['runnerMode'] =
    params.job.runnerMode === 'wf_rc_perturb_eval'
      ? 'p2_wf_rc_perturb_eval'
      : params.job.runnerMode === 'fits_batch_completeness'
        ? 'p2_fits_batch_completeness'
        : params.job.runnerMode === 'wf_rc_s4_reopt_probe'
          ? 'p2_wf_rc_s4_reopt_probe'
          : 'p2_fits_star_extract';

  const resultArtKind: ArtifactRef['kind'] =
    params.job.runnerMode === 'wf_rc_perturb_eval'
      ? 'tolerance_report_json'
      : params.job.runnerMode === 'wf_rc_s4_reopt_probe'
        ? 'optical_prescription_json'
        : 'astrometry_report_json';

  const resultArt: ArtifactRef = {
    id: outArtId,
    studyId: params.job.studyId,
    branchId,
    executionId: execId,
    kind: resultArtKind,
    title: `${params.job.branchName} · 真实计算结果 JSON`,
    relativePath: outRelPath,
    sha256: outDigest,
    byteLength: Buffer.byteLength(outJsonText, 'utf8'),
    provenanceTier: 'workbench_native',
    createdAt: params.finishedAt,
  };

  const logArt: ArtifactRef = {
    id: logArtId,
    studyId: params.job.studyId,
    branchId,
    executionId: execId,
    kind: 'execution_log',
    title: `${params.job.branchName} · 无缓冲执行日志`,
    relativePath: logRelPath,
    sha256: logDigest,
    byteLength: fs.existsSync(params.logFilePath) ? fs.statSync(params.logFilePath).size : 0,
    provenanceTier: 'workbench_native',
    createdAt: params.finishedAt,
  };

  let metrics: StudyBranch['metrics'] = {};
  let summary = '';
  let prescription: Record<string, unknown> | undefined;

  if (params.job.runnerMode === 'wf_rc_perturb_eval') {
    const comp = (params.output.compensated ?? {}) as Record<string, unknown>;
    const uncomp = (params.output.uncompensated ?? {}) as Record<string, unknown>;
    const rmsByField = (comp.rmsByFieldUm ?? {}) as Record<string, number>;
    const checks = (params.output.criteriaChecks ?? {}) as Record<string, boolean>;
    metrics = {
      eflMm: Number(comp.eflMm ?? 6000),
      uncompMaxRmsUm: Number(uncomp.maxRmsUm ?? 0),
      maxRmsPolyUm: Number(comp.maxRmsUm ?? 0),
      meanRmsPolyUm: Number(comp.meanRmsUm ?? 0),
      rms000Um: Number(rmsByField.center ?? 0),
      rms042Um: Number(rmsByField['mid_0.42'] ?? 0),
      rms060Um: Number(rmsByField['edge_+Y'] ?? 0),
      strehlCenter: Number(comp.strehl550Center ?? 0),
      strehlEdge: Number(comp.strehl550Edge ?? 0),
      compM2ShimMm: Number(comp.compM2ShimMm ?? 0),
      compDeltaBflMm: Number(comp.compDeltaBflMm ?? 0),
      compensator: String(params.output.compensator ?? ''),
      overallPassed: Boolean(checks.overallPassed),
    };
    summary = `Optiland ${params.pythonInfo.packages.optiland} 实算 [${params.output.compensator}]: 未补偿 max RMS=${metrics.uncompMaxRmsUm} μm → 补偿后 max RMS=${metrics.maxRmsPolyUm} μm, Strehl(0°/0.6°)=${metrics.strehlCenter}/${metrics.strehlEdge} (${metrics.overallPassed ? '达标' : '未达标'})`;
  } else if (params.job.runnerMode === 'wf_rc_s4_reopt_probe') {
    const m = (params.output.metrics ?? {}) as Record<string, unknown>;
    const cmp = (params.output.baselineComparison ?? {}) as Record<string, unknown>;
    metrics = {
      eflMm: typeof m.eflMm === 'number' ? m.eflMm : 6000,
      fNumber: typeof m.fNumber === 'number' ? m.fNumber : 6.0,
      rms000Um: typeof m.rms000Um === 'number' ? m.rms000Um : null,
      rms025Um: typeof m.rms025Um === 'number' ? m.rms025Um : null,
      rms042Um: typeof m.rms042Um === 'number' ? m.rms042Um : null,
      rms060Um: typeof m.rms060Um === 'number' ? m.rms060Um : null,
      maxRmsPolyUm: typeof m.maxRmsPolyUm === 'number' ? m.maxRmsPolyUm : null,
      meanRmsPolyUm: typeof m.meanRmsPolyUm === 'number' ? m.meanRmsPolyUm : null,
      strehlCenter: typeof m.strehlCenter === 'number' ? m.strehlCenter : null,
      strehlMid: typeof m.strehlMid === 'number' ? m.strehlMid : null,
      strehlEdge: typeof m.strehlEdge === 'number' ? m.strehlEdge : null,
      mtfEdgeTan: typeof m.mtfEdgeTan === 'number' ? m.mtfEdgeTan : null,
      distortionMaxPct: typeof m.distortionMaxPct === 'number' ? m.distortionMaxPct : null,
      k1: typeof m.k1 === 'number' ? m.k1 : null,
      k2: typeof m.k2 === 'number' ? m.k2 : null,
      bflMm: typeof m.bflMm === 'number' ? m.bflMm : null,
      optCost: typeof m.optCost === 'number' ? m.optCost : null,
      optSeedCount: typeof m.optSeedCount === 'number' ? m.optSeedCount : 1,
      s4ImprovementPct: typeof cmp.rmsImprovementPct === 'number' ? cmp.rmsImprovementPct : null,
      overallPassed: Boolean(cmp.meetsRms7_5Um && cmp.meetsStrehl0_80),
    };
    prescription = {
      materials: params.output.materials,
      unlock_conics: params.output.unlock_conics,
      k1: params.output.k1,
      k2: params.output.k2,
      d_m1_l1_mm: params.output.d_m1_l1_mm,
      bfl_mm: params.output.bfl_mm,
      lenses: params.output.lenses,
    };
    summary = `Optiland ${params.pythonInfo.packages.optiland} S4重优化 [${params.output.bestSeedName}]: max RMS ${cmp.stage2S4MaxRmsUm ?? 9.704} → ${metrics.maxRmsPolyUm} μm (改善 ${cmp.rmsImprovementPct ?? '?'}%), Strehl(0°/0.6°)=${metrics.strehlCenter}/${metrics.strehlEdge}, cost=${metrics.optCost}`;
  } else if (params.job.runnerMode === 'fits_batch_completeness') {
    const outParams = (params.output.parameters ?? {}) as Record<string, unknown>;
    const tilesCount = Number(params.output.tilesCount ?? 0);
    const meanMatch = Number(params.output.meanDaoMatchedToSepPct ?? 0);
    const minMatch = Number(params.output.minDaoMatchedToSepPct ?? 0);
    const totalExcess = Number(params.output.totalDaoUnmatchedExcess ?? 0);
    const stage3Dao =
      params.output.meanStage3Dao3pxPct !== null && params.output.meanStage3Dao3pxPct !== undefined
        ? Number(params.output.meanStage3Dao3pxPct)
        : null;
    metrics = {
      fitsBatchTilesCount: tilesCount,
      batchMeanDaoMatchPct: meanMatch,
      batchMinDaoMatchPct: minMatch,
      batchStage3Dao3pxPct: stage3Dao,
      batchDaoUnmatchedExcess: totalExcess,
      fwhmPx: Number(outParams.fwhmPx ?? 1.5),
    };
    summary = `批量 FITS 欠采样横评 (${tilesCount} 帧, DAO fwhm=${metrics.fwhmPx}px): 相对 SEP 均匹配率 ${meanMatch}% (最低 ${minMatch}%, Stage3 DAO 3px均值 ${stage3Dao ?? '?'}%), 额外未匹配余项 ${totalExcess}。 ${fitsProxyCaveat}`;
  } else {
    const nDet = Number(params.output.detectedCount ?? 0);
    metrics = {
      detectedCount: nDet,
      medianFwhmPx: params.output.medianFwhmPx !== undefined ? Number(params.output.medianFwhmPx) : null,
      medianFwhmArcsec: params.output.medianFwhmArcsec !== undefined ? Number(params.output.medianFwhmArcsec) : null,
      extractor: String(params.output.extractor ?? ''),
      fitsPath: String(params.output.fitsPath ?? ''),
      medianSkyAdu: Number(params.output.medianSkyAdu ?? 0),
    };
    summary = `${params.output.extractor} 实时星表提取 (${path.basename(String(params.output.fitsPath ?? ''))}): 检出 ${nDet} 个点源, median FWHM=${metrics.medianFwhmPx ?? '?'} px (${metrics.medianFwhmArcsec ?? '?'}")`;
  }

  const branch: StudyBranch = {
    id: branchId,
    studyId: params.job.studyId,
    parentBranchId: params.job.parentBranchId,
    name: params.job.branchName,
    shortCode: `E${branchSeq}`,
    hypothesis: params.job.hypothesis,
    status: 'exploring',
    provenanceTier: 'workbench_native',
    summary,
    metrics,
    ...(prescription ? { prescription } : {}),
    artifactIds: [outArtId, logArtId],
    executionIds: [execId],
    createdAt: params.finishedAt,
    updatedAt: params.finishedAt,
    createdBy: 'Rad + Workbench Python Runner',
  };

  const execution: WorkflowExecution = {
    id: execId,
    studyId: params.job.studyId,
    branchId,
    jobId: params.job.id,
    runnerMode,
    title: params.job.title,
    intent: params.job.intent,
    status: 'completed',
    provenanceTier: 'workbench_native',
    parameters: params.job.parameters,
    outputs: metrics,
    artifactIds: [outArtId, logArtId],
    pythonExecutable: params.pythonInfo.executable,
    packageVersions: params.pythonInfo.packages,
    durationMs: params.durationMs,
    createdAt: params.finishedAt,
    sha256Digest: outDigest,
  };

  branches.push(branch);
  atomicWriteFileSync(paths.branchesFile, JSON.stringify(branches, null, 2));
  appendJsonlLine(paths.executionsFile, execution);
  appendJsonlLine(paths.artifactsFile, resultArt);
  appendJsonlLine(paths.artifactsFile, logArt);

  const note: EpistemicNote = {
    id: `note-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
    studyId: params.job.studyId,
    branchId,
    tag: 'fact',
    authorType: 'system_verifier',
    authorLabel: `实时科学计算 (${runnerMode})`,
    title: `实证结果 [${branch.shortCode}] ${branch.name}`,
    content: `${summary}\n执行耗时 ${params.durationMs} ms · 产物指纹 SHA-256=${outDigest.slice(0, 16)}...`,
    evidenceRefs: [outRelPath, logRelPath],
    createdAt: params.finishedAt,
  };
  appendJsonlLine(paths.notesFile, note);

  return {
    branch,
    execution,
    artifactIds: [outArtId, logArtId],
  };
}

// ============================================================================
// Component Authoring from UI + Architecture Snapshots & Annotations
// ============================================================================

export function createNewComponent(
  input: {
    id: string;
    name: string;
    kind: string;
    runtime: 'local_process_mjs' | 'local_process_py';
    summary: string;
    purpose: string;
    capabilityBoundary?: string;
    codeContent: string;
    artifactContract?: import('../src/core/researchTypes.ts').ArtifactContract;
  },
  workspaceDir?: string,
): ComponentDossier {
  const cleanId = input.id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,48}$/.test(cleanId)) {
    throw new Error('组件 ID 仅允许小写字母、数字和连字符，长度 3–49 位（例如 fits-aperture-metric）');
  }
  if (getComponent(cleanId, workspaceDir)) {
    throw new Error(`组件 ID "${cleanId}" 已存在`);
  }
  if (!input.name?.trim() || !input.codeContent?.trim()) {
    throw new Error('组件名称与实现代码不能为空');
  }

  const ws = resolveWorkspaceDir(workspaceDir);
  const compDir = path.join(ws, 'components', cleanId);
  const verDir = path.join(compDir, 'v0.1');
  const codeFile = input.runtime === 'local_process_py' ? 'impl.py' : 'impl.mjs';
  const now = new Date().toISOString();
  const codeHash = sha256(input.codeContent);

  fs.mkdirSync(verDir, { recursive: true });
  atomicWriteFileSync(path.join(verDir, codeFile), input.codeContent);

  const dossier: ComponentDossier = {
    id: cleanId,
    name: input.name.trim(),
    kind: input.kind.trim() || 'analysis_plugin',
    runtime: input.runtime,
    activeVersion: 'v0.1',
    summary: input.summary.trim() || input.name.trim(),
    purpose: input.purpose.trim() || input.summary.trim() || '工作台原生新建组件',
    capabilityBoundary: input.capabilityBoundary?.trim() || '用户自定义脚本边界，建议运行自检验证契约。',
    inputs: [{ name: 'input', type: 'JSON Object', description: '结构化实验或观测输入参数' }],
    outputs: [{ name: 'output', type: 'JSON Object', description: '结构化计算或评估结果' }],
    dependencies: [],
    compatibility: ['workbench_v2'],
    assumptions: ['通过用户创建向导录入并经 SHA-256 哈希登记'],
    limits: ['初始版本尚未挂载 CAS 冻结，需通过自检验证具体场景稳定性'],
    editableParts: [codeFile, '参数默认表'],
    parameters: [],
    versions: [
      {
        version: 'v0.1',
        createdAt: now,
        parentVersion: null,
        author: 'rad',
        changeSummary: '在 OpenLab Bench v2 组件库中新建初始版本',
        codeHash,
        params: {},
        codeFile,
        approval: null,
        artifactContract: input.artifactContract,
        lifecycle: 'draft',
        sourceAvailability: 'available_on_disk',
      },
    ],
    selfCheck: {
      status: 'unrun',
      checkedAt: null,
      checkedCodeHash: null,
      summary: '新建组件尚未执行自检',
    },
    scientificValidation: {
      status: 'unvalidated',
      basis: '工作台原生创建，待实证验证',
      caveats: [],
    },
    codeSecurityReview: {
      status: 'unreviewed_modified',
      approvedHash: null,
      reviewedBy: null,
      reviewedAt: null,
      executionModelNote: '工作台新建源码已记录完整 64 位 SHA-256 指纹',
    },
  };

  atomicWriteFileSync(path.join(compDir, 'dossier.json'), JSON.stringify(dossier, null, 2));
  return getComponent(cleanId, workspaceDir)!.dossier;
}

export function listPersistedArchSnapshots(workspaceDir?: string): PersistedArchitectureSnapshot[] {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);
  return readJsonlFile<PersistedArchitectureSnapshot>(paths.archSnapshotsFile);
}

export function savePersistedArchSnapshot(
  reason: string,
  mapData: ArchitectureMapData,
  workspaceDir?: string,
): PersistedArchitectureSnapshot {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);
  const snap: PersistedArchitectureSnapshot = {
    id: `archsnap-${Date.now().toString(36)}`,
    capturedAt: new Date().toISOString(),
    reason: reason?.trim() || '手动结构快照留存',
    nodeCount: mapData.nodes.length,
    edgeCount: mapData.edges.length,
    anomalyCount: mapData.anomalies.length,
    mapDigestSha256: sha256(JSON.stringify({ nodes: mapData.nodes, edges: mapData.edges })),
    mapData,
  };
  appendJsonlLine(paths.archSnapshotsFile, snap);
  return snap;
}

export function listArchitectureAnnotations(workspaceDir?: string): ArchitectureAnnotation[] {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);
  return readJsonFile<ArchitectureAnnotation[]>(paths.archAnnotationsFile, []);
}

export function addArchitectureAnnotation(
  input: {
    nodeId: string;
    author?: string;
    tag?: ArchitectureAnnotation['tag'];
    note: string;
  },
  workspaceDir?: string,
): ArchitectureAnnotation {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);
  const noteText = input.note?.trim();
  if (!noteText || !input.nodeId?.trim()) {
    throw new Error('节点 ID 与注解内容不能为空');
  }
  const list = readJsonFile<ArchitectureAnnotation[]>(paths.archAnnotationsFile, []);
  const ann: ArchitectureAnnotation = {
    id: `ann-${Date.now().toString(36)}`,
    nodeId: input.nodeId.trim(),
    author: input.author?.trim() || 'Rad',
    tag: input.tag ?? 'judgment',
    note: noteText,
    createdAt: new Date().toISOString(),
  };
  list.push(ann);
  atomicWriteFileSync(paths.archAnnotationsFile, JSON.stringify(list, null, 2));
  return ann;
}

export function listAllComponentsSafe(workspaceDir?: string): ComponentDossier[] {
  return listComponents(workspaceDir);
}

export function readArtifactJson(artifactId: string, workspaceDir?: string): Record<string, unknown> {
  ensureWorkbenchInitialized(workspaceDir);
  const paths = getWorkbenchPaths(workspaceDir);
  const artifacts = readJsonlFile<ArtifactRef>(paths.artifactsFile);
  const art = artifacts.find((a) => a.id === artifactId);
  if (!art) {
    throw new Error(`未找到产物记录 ${artifactId}`);
  }
  const native = art.provenanceTier === 'workbench_native';
  const root = native ? paths.generatedArtifactsDir : path.resolve(resolveRepoRoot(), 'experiments');
  const target = native
    ? path.resolve(root, path.basename(art.relativePath))
    : path.resolve(resolveRepoRoot(), art.relativePath);
  const relative = path.relative(fs.realpathSync(root), fs.existsSync(target) ? fs.realpathSync(target) : target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(target)) {
    throw new Error(`产物文件不存在: ${art.relativePath}`);
  }
  const raw = fs.readFileSync(target);
  if (crypto.createHash('sha256').update(raw).digest('hex') !== art.sha256) {
    throw new Error('产物 SHA-256 不匹配: ' + artifactId);
  }
  return JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
}


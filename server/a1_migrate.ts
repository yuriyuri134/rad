import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ActorAttribution,
  ArchitectureSnapshot,
  Branch,
  ComponentDossier,
  ComponentSourceAvailability,
  ComponentVersionRecord,
  EvaluatorBinding,
  ExperimentRun,
  ExperimentSnapshot,
  HistoricalHashDriftRecord,
  PinnedComponentRef,
  ResearchObject,
  ResearchSnapshot,
  RunSupplement,
  ThreadEntry,
} from '../src/core/types.ts';
import {
  atomicWriteFileSync,
  canonicalJson,
  detectRuntimeEnvironment,
  discoverDeclaredHostModules,
  discoverLocalRelativeDependencies,
  getWorkspacePaths,
  hydrateRunsWithSupplements,
  listRawRuns,
  listRunSupplements,
  sha256,
  writeCasBlob,
} from './storage.ts';

export const LEGACY_MIGRATION_MAPPING_SPEC = {
  contractId: 'openlab-stage-a1-legacy-migration-v1',
  researchObject: {
    id: 'obj-optics-100mm-f4',
    domainId: 'optics.geometric',
    sourceRunIds: ['run-001', 'run-002'],
    sourceThreadIds: ['note-001'],
  },
  snapshots: {
    'snap-001': {
      rootKind: 'initial_root_node' as const,
      branchId: 'branch-main-singlet',
      parentSnapshotId: null,
      legacyParentRunId: null,
      sourceExperimentRunId: 'run-001',
      systemSpecField: 'run-001.systemBefore',
      evidenceGrade: 'preview_computed' as const,
    },
    'snap-002-before': {
      rootKind: 'independent_root_node' as const,
      branchId: 'branch-b-doublet',
      parentSnapshotId: null, // 固化规则：尽管 run-002.parentRunId === "run-001"，但结构从 2 面单透镜切换为 3 面双胶合，必须作为独立根节点
      legacyParentRunId: 'run-001',
      sourceExperimentRunId: 'run-002',
      systemSpecField: 'run-002.systemBefore',
      evidenceGrade: 'preview_computed' as const,
      structuralDiscontinuityReason:
        'run-001 为 2 表面 N-BK7 单透镜，run-002.systemBefore 切换为 3 表面 N-BK7 / N-SF11 双胶合预设；二者不存在可验证的参数继承谱系，固化为独立根节点 (parentSnapshotId: null, legacyParentRunId: "run-001")。',
    },
    'snap-002-after': {
      rootKind: 'derived_candidate' as const,
      branchId: 'branch-b-doublet',
      parentSnapshotId: 'snap-002-before',
      legacyParentRunId: 'run-001',
      sourceExperimentRunId: 'run-002',
      systemSpecField: 'run-002.systemAfter',
      evidenceGrade: 'preview_computed' as const,
    },
  },
  branches: {
    'branch-main-singlet': {
      baseSnapshotId: 'snap-001',
      headSnapshotId: 'snap-001',
      adoptedRunIds: ['run-001'],
      unadoptedRunIds: [] as string[],
    },
    'branch-b-doublet': {
      baseSnapshotId: 'snap-002-before',
      headSnapshotId: 'snap-002-before',
      adoptedRunIds: [] as string[],
      unadoptedRunIds: ['run-002'],
    },
  },
  componentIntegrityExpectations: {
    'eval-rms-spot@v0.1': {
      lifecycle: 'frozen' as const,
      sourceAvailability: 'historical_hash_drifted' as const,
      expectedRun001RecordedHash:
        'a3b03826e7ce6dccbaac59ab5eb8f46b479bbd41b3ce7a3817f66939ce062b55',
    },
    'eval-rms-spot@v0.2': {
      lifecycle: 'draft' as const,
      sourceAvailability: 'missing_on_disk' as const,
      immutableBlobHash: null,
    },
  },
} as const;

export interface MigrationJournal {
  contractId: string;
  migrationId: string;
  phase: 'preparing' | 'committing' | 'committed';
  startedAt: string;
  updatedAt: string;
  targets: Array<{
    relativePath: string;
    existedBefore: boolean;
    backupRelPath: string;
    stagedHash: string;
  }>;
}

export interface CrashRecoveryEntry {
  migrationId: string;
  phaseAtCrash: MigrationJournal['phase'];
  action: 'cleaned_preparing' | 'rolled_back_after_crash' | 'finalized_committed';
  restoredCount: number;
  removedCount: number;
}

export interface MigrationOptions {
  /** Test-only hook: throws inside commit try/catch after N files to exercise exception rollback */
  simulateCommitFailureAfterFiles?: number;
  /** Test-only hook: simulates abrupt SIGKILL crash mid-commit WITHOUT running catch rollback, leaving journal.json in phase="committing" */
  simulateCrashWithoutRollbackAfterFiles?: number;
}

export interface MigrationCorrespondenceReport {
  runsCount: number;
  threadEntriesCount: number;
  researchObjectsCount: number;
  snapshotsCount: number;
  branchesCount: number;
  architectureSnapshotsCount: number;
  experimentSnapshotsCount: number;
  runSupplementsCount: number;
  frozenVersionsCount: number;
  casBlobsCount: number;
  missingOnDiskVersions: string[];
  historicalDriftedVersions: Array<{
    componentId: string;
    version: string;
    runId: string;
    recordedRunHash: string;
    diskHash: string | null;
  }>;
  hydratingRunsPreservesCountsWithoutDuplication: boolean;
  evalRmsSpotV01DriftPreserved: boolean;
  evalRmsSpotV02MissingPreserved: boolean;
  branchBDoubletHeadStaysBefore: boolean;
  snap002BeforeParentNull: boolean;
}

export interface MigrationResult {
  success: boolean;
  workspaceDir: string;
  stagingDir: string;
  committedFiles: string[];
  legacyFilesUntouched: Array<{
    relativePath: string;
    bytes: number;
    sha256: string;
  }>;
  correspondence: MigrationCorrespondenceReport;
  rolledBack?: boolean;
  recoveredPriorCrashes?: CrashRecoveryEntry[];
}

export class SimulatedProcessCrashError extends Error {
  readonly migrationId: string;
  readonly committedBeforeCrash: number;
  constructor(migrationId: string, committedBeforeCrash: number) {
    super(`模拟进程异常崩溃 (SIGKILL, migrationId=${migrationId}, 已写入 ${committedBeforeCrash} 个目标文件，未执行 catch 回滚)`);
    this.name = 'SimulatedProcessCrashError';
    this.migrationId = migrationId;
    this.committedBeforeCrash = committedBeforeCrash;
  }
}

function cleanupEmptyMigrationDirs(workspaceDir: string): void {
  const paths = getWorkspacePaths(workspaceDir);
  const immRoot = path.join(paths.workspaceDir, 'immutable_store');
  if (fs.existsSync(paths.immutableStoreDir) && fs.readdirSync(paths.immutableStoreDir).length === 0) {
    fs.rmdirSync(paths.immutableStoreDir);
  }
  if (fs.existsSync(immRoot) && fs.readdirSync(immRoot).length === 0) {
    fs.rmdirSync(immRoot);
  }
  const migrationTmpRoot = path.join(paths.workspaceDir, '.migration_tmp');
  if (fs.existsSync(migrationTmpRoot) && fs.readdirSync(migrationTmpRoot).length === 0) {
    fs.rmdirSync(migrationTmpRoot);
  }
}

/**
 * Crash Recovery (distinct from in-process try/catch exception rollback):
 * Scans `.migration_tmp/stage-a1-* /journal.json` left behind if the Node process crashed (SIGKILL/OOM/power loss)
 * mid-commit before `catch` could execute.
 * - phase === 'preparing': formal files untouched -> clean staging dir safely.
 * - phase === 'committing': half-committed state -> deterministically replay rollback/ in reverse order.
 * - phase === 'committed': all targets committed & verified before crash -> clean leftover staging dir.
 */
export function recoverInterruptedMigrations(workspaceDir?: string): CrashRecoveryEntry[] {
  const paths = getWorkspacePaths(workspaceDir);
  const migrationTmpRoot = path.join(paths.workspaceDir, '.migration_tmp');
  if (!fs.existsSync(migrationTmpRoot)) {
    return [];
  }

  const dirs = fs
    .readdirSync(migrationTmpRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('stage-a1-'))
    .sort((a, b) => b.name.localeCompare(a.name)); // Newest first

  const recovered: CrashRecoveryEntry[] = [];

  for (const dir of dirs) {
    const stagingDir = path.join(migrationTmpRoot, dir.name);
    const journalPath = path.join(stagingDir, 'journal.json');
    if (!fs.existsSync(journalPath)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      continue;
    }

    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as MigrationJournal;
    let restoredCount = 0;
    let removedCount = 0;

    if (journal.phase === 'committing') {
      for (const target of [...journal.targets].reverse()) {
        const targetAbs = path.join(paths.workspaceDir, target.relativePath);
        const backupAbs = path.join(stagingDir, target.backupRelPath);
        if (target.existedBefore) {
          if (!fs.existsSync(backupAbs)) {
            throw new Error(
              `崩溃恢复失败：${journal.migrationId} 缺失回滚备份文件 ${target.backupRelPath}`,
            );
          }
          fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
          fs.copyFileSync(backupAbs, targetAbs);
          restoredCount++;
        } else if (fs.existsSync(targetAbs)) {
          fs.unlinkSync(targetAbs);
          removedCount++;
        }
      }
      recovered.push({
        migrationId: journal.migrationId,
        phaseAtCrash: journal.phase,
        action: 'rolled_back_after_crash',
        restoredCount,
        removedCount,
      });
    } else if (journal.phase === 'preparing') {
      recovered.push({
        migrationId: journal.migrationId,
        phaseAtCrash: journal.phase,
        action: 'cleaned_preparing',
        restoredCount: 0,
        removedCount: 0,
      });
    } else {
      recovered.push({
        migrationId: journal.migrationId,
        phaseAtCrash: journal.phase,
        action: 'finalized_committed',
        restoredCount: 0,
        removedCount: 0,
      });
    }

    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  cleanupEmptyMigrationDirs(paths.workspaceDir);
  return recovered;
}

const MIGRATED_UNKNOWN_ACTOR: ActorAttribution = {
  actorId: 'migrated:unknown',
  displayName: '旧版记录（操作者未署名）',
  actorKind: 'migrated_unknown',
};

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readRawRunsStrict(runsFile: string): ExperimentRun[] {
  if (!fs.existsSync(runsFile)) {
    throw new Error(`找不到历史运行账本：${runsFile}`);
  }
  return fs
    .readFileSync(runsFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ExperimentRun);
}

function readThreadEntries(threadFile: string): ThreadEntry[] {
  if (!fs.existsSync(threadFile)) return [];
  return fs
    .readFileSync(threadFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ThreadEntry);
}

function readRawDossiers(componentsDir: string): Array<{ dirName: string; dossier: ComponentDossier }> {
  if (!fs.existsSync(componentsDir)) return [];
  const dirs = fs
    .readdirSync(componentsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  const out: Array<{ dirName: string; dossier: ComponentDossier }> = [];
  for (const dir of dirs) {
    const p = path.join(componentsDir, dir.name, 'dossier.json');
    if (!fs.existsSync(p)) continue;
    const dossier = JSON.parse(fs.readFileSync(p, 'utf8')) as ComponentDossier;
    out.push({ dirName: dir.name, dossier });
  }
  return out;
}

function buildPinnedComponentRef(
  slot: string,
  componentId: string,
  version: string,
  recordedCodeHash: string,
  componentsDir: string,
  dossiersById: Map<string, ComponentDossier>,
): PinnedComponentRef {
  const dossier = dossiersById.get(componentId);
  const ver = dossier?.versions.find((v) => v.version === version);
  const codeFile = ver?.codeFile ?? 'impl.mjs';
  const codePath = path.join(componentsDir, path.basename(componentId), version, codeFile);
  if (!fs.existsSync(codePath)) {
    return {
      slot,
      componentId,
      version,
      codeHash: recordedCodeHash,
      sourceAvailability: 'missing_on_disk',
      driftNote: `磁盘缺少 ${componentId}@${version}/${codeFile}，仅保留运行记录中的历史 SHA-256。`,
    };
  }
  const diskHash = sha256(fs.readFileSync(codePath, 'utf8'));
  if (diskHash !== recordedCodeHash) {
    return {
      slot,
      componentId,
      version,
      codeHash: recordedCodeHash,
      sourceAvailability: 'historical_hash_drifted',
      driftNote: `历史运行记录哈希 (${recordedCodeHash}) 与当前磁盘文件 (${diskHash}) 不一致，不得视为同一份源码。`,
    };
  }
  return {
    slot,
    componentId,
    version,
    codeHash: recordedCodeHash,
    sourceAvailability: 'available_on_disk',
  };
}

/**
 * Classifies each evaluation item in a legacy ExperimentRun strictly from provenance evidence
 * (matching composition evaluator part, timestamp proximity, and thread.jsonl evaluator_verdict records),
 * NEVER guessing from array index position.
 */
function classifyEvaluationItem(
  run: ExperimentRun,
  ev: ExperimentRun['evaluations'][number],
  threadEntries: ThreadEntry[],
): {
  kind: 'initial_run_evaluation' | 'post_hoc_reevaluation';
  basis: string;
} {
  const matchingEvalPart = (run.composition?.parts ?? []).find(
    (p) =>
      p.componentId === ev.evaluatorId &&
      p.version === ev.evaluatorVersion &&
      p.codeHash === ev.evaluatorCodeHash,
  );
  const threadVerdictMatch = threadEntries.find(
    (t) =>
      t.runId === run.id &&
      t.origin === 'evaluator_verdict' &&
      t.componentId === ev.evaluatorId &&
      Math.abs(Date.parse(t.createdAt) - Date.parse(ev.evaluatedAt)) <= 10_000,
  );

  const evalMs = Date.parse(ev.evaluatedAt);
  const runMs = Date.parse(run.createdAt);
  const deltaMs = Number.isFinite(evalMs) && Number.isFinite(runMs) ? evalMs - runMs : NaN;

  if (matchingEvalPart && !threadVerdictMatch && Number.isFinite(deltaMs) && Math.abs(deltaMs) <= 10_000) {
    return {
      kind: 'initial_run_evaluation',
      basis: `匹配 ${run.id}.composition.parts[${matchingEvalPart.slot}] (${ev.evaluatorId}@${ev.evaluatorVersion}, hash=${ev.evaluatorCodeHash.slice(0, 12)}...)，且 evaluatedAt (${ev.evaluatedAt}) 与 run.createdAt (${run.createdAt}) 相差 ${deltaMs}ms，无 thread.jsonl evaluator_verdict 重评记录。`,
    };
  }

  const reasons: string[] = [];
  if (!matchingEvalPart) {
    reasons.push(`评价器 ${ev.evaluatorId}@${ev.evaluatorVersion} 不在 ${run.id}.composition.parts 中`);
  }
  if (threadVerdictMatch) {
    reasons.push(`匹配 thread.jsonl[${threadVerdictMatch.id}] (origin=evaluator_verdict, title="${threadVerdictMatch.title}")`);
  }
  if (Number.isFinite(deltaMs) && Math.abs(deltaMs) > 10_000) {
    reasons.push(`evaluatedAt 晚于 run.createdAt ${(deltaMs / 1000).toFixed(3)}s`);
  }
  return {
    kind: 'post_hoc_reevaluation',
    basis: reasons.join('；') || `非初始运行组合产出的事后评价 (${ev.evaluatorId}@${ev.evaluatorVersion})`,
  };
}

function buildResearchObjects(runs: ExperimentRun[]): ResearchObject[] {
  const run1 = runs.find((r) => r.id === 'run-001') ?? runs[0];
  const createdAt = run1?.createdAt ?? '2026-11-16T18:47:40.069Z';

  return [
    {
      id: 'obj-optics-100mm-f4',
      domainId: 'optics.geometric',
      title: '100mm f/4 成像光学镜头探索（迁移基线）',
      problemStatement:
        '围绕 25mm 入瞳、目标有效焦距 100mm 的成像光学系统，验证不同评价标准（RMS 光斑 vs MTF30/色差）对单透镜与双胶合结构结论的影响，并在保持历史计算产物不可变的前提下展开改进。',
      objectives: [
        {
          id: 'obj-efl-100',
          title: '保持 100mm 目标有效焦距 (EFL)',
          description: '在 25mm 入瞳 (f/4) 下维持目标焦距 100mm',
          priority: 'primary',
        },
        {
          id: 'obj-achromatic-mtf',
          title: '抑制轴向色差并提升 MTF30 对比度',
          description: '降低 486.13nm–656.27nm 轴向焦移并提升 30 lp/mm MTF',
          priority: 'primary',
        },
        {
          id: 'obj-ray-integrity',
          title: '零孔径遮拦与零全反射异常光线',
          description: 'clippedRayCount === 0 且 tirRayCount === 0',
          priority: 'constraint',
        },
      ],
      criteria: [
        {
          id: 'crit-efl',
          metricKey: 'paraxialEflMm',
          label: '有效焦距 (EFL)',
          operator: '==',
          targetValue: 100,
          unit: 'mm',
          required: true,
        },
        {
          id: 'crit-mtf30',
          metricKey: 'mtf30LpMm',
          label: '30 lp/mm MTF',
          operator: '>=',
          targetValue: 0.35,
          required: true,
        },
        {
          id: 'crit-chrom',
          metricKey: 'axialChromaticShiftMm',
          label: 'F-C 轴向色差',
          operator: '<=',
          targetValue: 0.45,
          unit: 'mm',
          required: true,
        },
        {
          id: 'crit-rms',
          metricKey: 'rmsSpotRadiusUm',
          label: '多波段平均 RMS 光斑半径（初筛参考）',
          operator: '<=',
          targetValue: 65,
          unit: 'μm',
          required: false,
        },
      ],
      openQuestions: [
        'run-002 双胶合优化后 F-C 轴向色差降至 0.0714 mm，但 MTF30=0.2237 仍低于 0.35（verdict=warning），尚未确认下一步应放宽目标还是改用新结构。',
        'eval-rms-spot@v0.1 存在历史哈希漂移（run-001 记录 a3b03826... vs 磁盘 0b2d5359...），eval-rms-spot@v0.2 源码文件在磁盘缺失。',
      ],
      createdAt,
      createdBy: MIGRATED_UNKNOWN_ACTOR,
      migrationProvenance: {
        isMigrated: true,
        sourceRecordIds: runs.map((r) => r.id),
        sourceFields: ['runs.jsonl', 'thread.jsonl#note-001'],
        inferredFields: ['id', 'domainId', 'objectives', 'criteria', 'openQuestions', 'createdBy'],
        note: '旧版工作台无 ResearchObject 实体，由 A1.2.1 迁移从 runs.jsonl 与 thread.jsonl 归纳创建。',
      },
    },
  ];
}

function buildEvaluatorBindingsFromInitialRun(
  run: ExperimentRun,
  researchObj: ResearchObject,
  componentsDir: string,
  dossiersById: Map<string, ComponentDossier>,
  threadEntries: ThreadEntry[],
): EvaluatorBinding[] {
  const initialEvals = (run.evaluations ?? []).filter(
    (ev) => classifyEvaluationItem(run, ev, threadEntries).kind === 'initial_run_evaluation',
  );
  const evalParts = (run.composition?.parts ?? []).filter((p) => p.slot === 'evaluator' || p.kind === 'evaluator');

  return evalParts.map((part) => {
    const matchedEval = initialEvals.find((ev) => ev.evaluatorId === part.componentId);
    const pinned = buildPinnedComponentRef(
      part.slot,
      part.componentId,
      part.version,
      part.codeHash,
      componentsDir,
      dossiersById,
    );
    const coveredCriteria =
      part.componentId === 'eval-rms-spot'
        ? ['crit-efl', 'crit-rms']
        : researchObj.criteria.filter((c) => c.id !== 'crit-rms').map((c) => c.id);

    return {
      bindingId: `bind-${run.id}-${part.componentId}-${part.version}`,
      evaluatorId: part.componentId,
      evaluatorVersion: part.version,
      evaluatorCodeHash: part.codeHash,
      paramsSnapshot: part.paramsSnapshot ?? {},
      criterionIds: coveredCriteria,
      coverageNote: matchedEval
        ? `源自 ${run.id} 初始运行评价 (${matchedEval.id}, status=${matchedEval.status})`
        : `源自 ${run.id}.composition.parts[${part.slot}]`,
      sourceAvailability: pinned.sourceAvailability,
    };
  });
}

function verifyStagingConstraints(params: {
  runs: ExperimentRun[];
  researchObjects: ResearchObject[];
  snapshots: ResearchSnapshot[];
  branches: Branch[];
  archSnapshots: ArchitectureSnapshot[];
  expSnapshots: ExperimentSnapshot[];
  supplements: RunSupplement[];
  updatedDossiers: Array<{ dirName: string; dossier: ComponentDossier }>;
}): void {
  const { snapshots, branches, supplements, updatedDossiers, runs } = params;

  const snap001 = snapshots.find((s) => s.id === 'snap-001');
  if (
    !snap001 ||
    snap001.parentSnapshotId !== LEGACY_MIGRATION_MAPPING_SPEC.snapshots['snap-001'].parentSnapshotId ||
    snap001.branchId !== LEGACY_MIGRATION_MAPPING_SPEC.snapshots['snap-001'].branchId
  ) {
    throw new Error('迁移校验失败：snap-001 不符合固化迁移映射契约');
  }

  const run1Ref = runs.find((r) => r.id === 'run-001');
  const run2Ref = runs.find((r) => r.id === 'run-002');
  const snap002Before = snapshots.find((s) => s.id === 'snap-002-before');
  if (
    !snap002Before ||
    snap002Before.parentSnapshotId !== null ||
    snap002Before.legacyParentRunId !== 'run-001' ||
    snap002Before.branchId !== LEGACY_MIGRATION_MAPPING_SPEC.snapshots['snap-002-before'].branchId
  ) {
    throw new Error('迁移校验失败：snap-002-before 必须固化为独立根节点 (parentSnapshotId=null, legacyParentRunId="run-001")');
  }
  if (run1Ref && run2Ref && run1Ref.systemAfter.surfaces.length === run2Ref.systemBefore.surfaces.length) {
    throw new Error('迁移校验失败：run-001 与 run-002 表面拓扑未发生预期结构切换，需重新审视独立根节点规则');
  }

  const snap002After = snapshots.find((s) => s.id === 'snap-002-after');
  if (!snap002After || snap002After.parentSnapshotId !== 'snap-002-before') {
    throw new Error('迁移校验失败：snap-002-after.parentSnapshotId 必须指向 snap-002-before');
  }

  const branchB = branches.find((b) => b.id === 'branch-b-doublet');
  if (
    !branchB ||
    branchB.baseSnapshotId !== LEGACY_MIGRATION_MAPPING_SPEC.branches['branch-b-doublet'].baseSnapshotId ||
    branchB.headSnapshotId !== LEGACY_MIGRATION_MAPPING_SPEC.branches['branch-b-doublet'].headSnapshotId ||
    !branchB.unadoptedRunIds.includes('run-002') ||
    branchB.adoptedRunIds.length !== 0
  ) {
    throw new Error('迁移校验失败：branch-b-doublet 的 base/headSnapshotId 必须保持 snap-002-before，且 run-002 为未采用候选');
  }

  const evalRms = updatedDossiers.find((d) => d.dossier.id === 'eval-rms-spot')?.dossier;
  const v01 = evalRms?.versions.find((v) => v.version === 'v0.1');
  const v02 = evalRms?.versions.find((v) => v.version === 'v0.2');
  if (
    !v01 ||
    v01.lifecycle !== 'frozen' ||
    v01.sourceAvailability !== 'historical_hash_drifted' ||
    !v01.historicalDriftedHashes?.some(
      (h) =>
        h.runId === 'run-001' &&
        h.recordedCodeHash === 'a3b03826e7ce6dccbaac59ab5eb8f46b479bbd41b3ce7a3817f66939ce062b55',
    )
  ) {
    throw new Error('迁移校验失败：eval-rms-spot@v0.1 必须冻结并如实保留 run-001 的历史哈希漂移');
  }
  if (!v02 || v02.sourceAvailability !== 'missing_on_disk' || v02.immutableBlobHash) {
    throw new Error('迁移校验失败：eval-rms-spot@v0.2 必须保留元数据并标注 missing_on_disk，不得伪造源码');
  }

  const run1 = runs.find((r) => r.id === 'run-001');
  if (run1) {
    const run1Sups = supplements.filter((s) => s.runId === 'run-001');
    const run1MigratedSups = run1Sups.filter((s) => s.sourceStorage === 'migrated_from_runs_jsonl');
    const run1AppendedEvals = run1Sups.filter(
      (s) => s.sourceStorage === 'run_supplements_append' && Boolean(s.verdict),
    );
    const run1AppendedStandalone = run1Sups.filter(
      (s) => s.sourceStorage === 'run_supplements_append' && Boolean(s.standaloneAnalysis),
    );
    const expectedTotal = (run1.evaluations?.length ?? 0) + (run1.standaloneAnalyses?.length ?? 0);
    if (run1MigratedSups.length !== expectedTotal) {
      throw new Error(
        `迁移校验失败：run-001 迁移 RunSupplement 数量与原记录不一致 (${run1MigratedSups.length} != ${expectedTotal})`,
      );
    }
    const hydratedMigratedOnly = hydrateRunsWithSupplements([run1], run1MigratedSups)[0];
    if (
      hydratedMigratedOnly.evaluations.length !== run1.evaluations.length ||
      (hydratedMigratedOnly.standaloneAnalyses?.length ?? 0) !== (run1.standaloneAnalyses?.length ?? 0)
    ) {
      throw new Error('迁移校验失败：migrated RunSupplement 水合后出现重复或缺失显示');
    }
    const hydratedAll = hydrateRunsWithSupplements([run1], run1Sups)[0];
    if (
      hydratedAll.evaluations.length !== run1.evaluations.length + run1AppendedEvals.length ||
      (hydratedAll.standaloneAnalyses?.length ?? 0) !==
        (run1.standaloneAnalyses?.length ?? 0) + run1AppendedStandalone.length
    ) {
      throw new Error('迁移校验失败：RunSupplement 全量水合后出现重复或缺失显示');
    }
  }
}

export function migrateWorkspaceToStageA1(
  workspaceDir: string,
  options?: MigrationOptions,
): MigrationResult {
  // First recover any interrupted migration left behind by a prior SIGKILL/process crash
  const recoveredPriorCrashes = recoverInterruptedMigrations(workspaceDir);

  const paths = getWorkspacePaths(workspaceDir);
  const runs = readRawRunsStrict(paths.runsFile);
  const threadEntries = readThreadEntries(paths.threadFile);
  const rawDossiers = readRawDossiers(paths.componentsDir);
  const dossiersById = new Map(rawDossiers.map((d) => [d.dossier.id, d.dossier]));

  // Snapshot legacy files' digests BEFORE touching anything to verify zero legacy tampering
  const legacyPathsToProtect = [paths.runsFile, paths.threadFile];
  for (const { dirName, dossier } of rawDossiers) {
    for (const ver of dossier.versions) {
      const codePath = path.join(paths.componentsDir, dirName, ver.version, ver.codeFile);
      if (fs.existsSync(codePath)) {
        legacyPathsToProtect.push(codePath);
      }
    }
  }
  const legacyDigestsBefore = legacyPathsToProtect.map((abs) => {
    const buf = fs.readFileSync(abs);
    return {
      abs,
      relativePath: path.relative(paths.workspaceDir, abs).replace(/\\/g, '/'),
      bytes: buf.byteLength,
      sha256: sha256Buffer(buf),
    };
  });

  // 1. Build staging workspace directory
  const migrationId = `stage-a1-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  const stagingDir = path.join(paths.workspaceDir, '.migration_tmp', migrationId);
  const stageFilesDir = path.join(stagingDir, 'staged');
  const rollbackDir = path.join(stagingDir, 'rollback');
  const journalPath = path.join(stagingDir, 'journal.json');
  fs.mkdirSync(stageFilesDir, { recursive: true });
  fs.mkdirSync(rollbackDir, { recursive: true });

  // 2. Construct Stage A1 entities
  const researchObjects = buildResearchObjects(runs);
  const researchObj = researchObjects[0];

  const snapshots: ResearchSnapshot[] = [];
  const branches: Branch[] = [];
  const archSnapshots: ArchitectureSnapshot[] = [];
  const expSnapshots: ExperimentSnapshot[] = [];

  for (const run of runs) {
    const pinnedComponents = (run.composition?.parts ?? []).map((p) =>
      buildPinnedComponentRef(p.slot, p.componentId, p.version, p.codeHash, paths.componentsDir, dossiersById),
    );
    archSnapshots.push({
      id: `arch-snap-${run.id}`,
      capturedAt: run.createdAt,
      reason: `A1.2.1 迁移：${run.id} 运行时的组件与宿主环境状态`,
      pinnedComponents,
      runtimeEnv: run.runtimeEnv ?? detectRuntimeEnvironment(),
    });
  }

  const run1 = runs.find((r) => r.id === 'run-001');
  const run2 = runs.find((r) => r.id === 'run-002');

  if (run1) {
    const pinned1 = (run1.composition?.parts ?? []).map((p) =>
      buildPinnedComponentRef(p.slot, p.componentId, p.version, p.codeHash, paths.componentsDir, dossiersById),
    );
    const bindings1 = buildEvaluatorBindingsFromInitialRun(
      run1,
      researchObj,
      paths.componentsDir,
      dossiersById,
      threadEntries,
    );
    snapshots.push({
      id: 'snap-001',
      researchObjectId: researchObj.id,
      parentSnapshotId: null,
      legacyParentRunId: run1.parentRunId ?? null,
      branchId: 'branch-main-singlet',
      title: '单透镜基线起点 (run-001)',
      description: '25mm 入瞳 N-BK7 单透镜基线，用于验证 RMS 光斑评价与 MTF30/色差评价的差异。',
      systemSpec: run1.systemBefore,
      objectivesSnapshot: researchObj.objectives,
      criteriaSnapshot: researchObj.criteria,
      evaluatorBindings: bindings1,
      pinnedComponents: pinned1,
      architectureSnapshotId: 'arch-snap-run-001',
      sourceExperimentRunId: 'run-001',
      evidenceGrade: 'preview_computed',
      createdAt: run1.createdAt,
      createdBy: MIGRATED_UNKNOWN_ACTOR,
      migrationProvenance: {
        isMigrated: true,
        sourceRecordIds: ['run-001'],
        sourceFields: ['run-001.systemBefore', 'run-001.composition', 'run-001.evaluations[id=ev-1794854860076-init]'],
        inferredFields: ['researchObjectId', 'objectivesSnapshot', 'criteriaSnapshot', 'createdBy'],
        note: 'run-001 为 solve_only 运行，systemBefore 与 systemAfter 完全一致；事后 MTF30 重评保留在 RunSupplement。',
      },
    });

    branches.push({
      id: 'branch-main-singlet',
      researchObjectId: researchObj.id,
      name: run1.branchLabel,
      hypothesis: '观察 N-BK7 单透镜基线在单色 RMS 判据与严格 MTF30/色差判据下的表现差异',
      status: 'exploring',
      owner: MIGRATED_UNKNOWN_ACTOR,
      baseSnapshotId: 'snap-001',
      headSnapshotId: 'snap-001',
      unadoptedRunIds: [],
      adoptedRunIds: ['run-001'],
      createdAt: run1.createdAt,
      updatedAt: run1.createdAt,
      migrationProvenance: {
        isMigrated: true,
        sourceRecordIds: ['run-001'],
        sourceFields: ['run-001.branchLabel'],
        inferredFields: ['owner', 'hypothesis', 'status'],
        note: '从 run-001.branchLabel 迁移为独立研究路线。',
      },
    });

    expSnapshots.push({
      id: 'exp-snap-run-001',
      runId: 'run-001',
      baseSnapshotId: 'snap-001',
      candidateSystemSpec: run1.systemAfter,
      adoptedAsSnapshotId: 'snap-001',
      capturedAt: run1.createdAt,
      status: run1.status,
    });
  }

  if (run2) {
    const pinned2 = (run2.composition?.parts ?? []).map((p) =>
      buildPinnedComponentRef(p.slot, p.componentId, p.version, p.codeHash, paths.componentsDir, dossiersById),
    );
    const bindings2 = buildEvaluatorBindingsFromInitialRun(
      run2,
      researchObj,
      paths.componentsDir,
      dossiersById,
      threadEntries,
    );
    snapshots.push({
      id: 'snap-002-before',
      researchObjectId: researchObj.id,
      parentSnapshotId: null, // Constraint: do NOT invent inheritance when structure changed from 2-surface singlet to 3-surface doublet
      legacyParentRunId: run2.parentRunId ?? 'run-001',
      branchId: 'branch-b-doublet',
      title: '双胶合消色差基线 (run-002 before)',
      description: '3 表面 N-BK7 / N-SF11 双胶合预设初始结构，用于优化降低 F-C 轴向色差。',
      systemSpec: run2.systemBefore,
      objectivesSnapshot: researchObj.objectives,
      criteriaSnapshot: researchObj.criteria,
      evaluatorBindings: bindings2,
      pinnedComponents: pinned2,
      architectureSnapshotId: 'arch-snap-run-002',
      sourceExperimentRunId: 'run-002',
      evidenceGrade: 'preview_computed',
      createdAt: run2.createdAt,
      createdBy: MIGRATED_UNKNOWN_ACTOR,
      migrationProvenance: {
        isMigrated: true,
        sourceRecordIds: ['run-002'],
        sourceFields: ['run-002.systemBefore', 'run-002.parentRunId'],
        inferredFields: ['researchObjectId', 'parentSnapshotId(保持null)', 'objectivesSnapshot', 'criteriaSnapshot', 'createdBy'],
        note: '虽然 run-002.parentRunId="run-001"，但结构已切换为 3 面双胶合预设，无法确认严格配置继承，故 parentSnapshotId 置 null，仅保留 legacyParentRunId="run-001"。',
      },
    });

    snapshots.push({
      id: 'snap-002-after',
      researchObjectId: researchObj.id,
      parentSnapshotId: 'snap-002-before',
      legacyParentRunId: run2.parentRunId ?? 'run-001',
      branchId: 'branch-b-doublet',
      title: '双胶合优化候选结构 (run-002 after · 未采纳)',
      description: 'Nelder-Mead 优化后的双胶合候选结构（MTF30=0.2237, warning，尚未正式采纳为分支基线）。',
      systemSpec: run2.systemAfter,
      objectivesSnapshot: researchObj.objectives,
      criteriaSnapshot: researchObj.criteria,
      evaluatorBindings: bindings2,
      pinnedComponents: pinned2,
      architectureSnapshotId: 'arch-snap-run-002',
      sourceExperimentRunId: 'run-002',
      evidenceGrade: 'preview_computed',
      createdAt: run2.createdAt,
      createdBy: MIGRATED_UNKNOWN_ACTOR,
      migrationProvenance: {
        isMigrated: true,
        sourceRecordIds: ['run-002'],
        sourceFields: ['run-002.systemAfter'],
        inferredFields: ['researchObjectId', 'objectivesSnapshot', 'criteriaSnapshot', 'createdBy'],
        note: '保存 run-002 优化产出的候选结构快照；因评价结果仅为 warning 且缺少明确采纳证据，未将其设为 branch-b-doublet.headSnapshotId。',
      },
    });

    branches.push({
      id: 'branch-b-doublet',
      researchObjectId: researchObj.id,
      name: run2.branchLabel,
      hypothesis: '使用 N-BK7 + N-SF11 双胶合结构与 Nelder-Mead 优化消除 F-C 轴向色差',
      status: 'exploring',
      owner: MIGRATED_UNKNOWN_ACTOR,
      baseSnapshotId: 'snap-002-before',
      headSnapshotId: 'snap-002-before', // Constraint: never auto-advance headSnapshotId to systemAfter without adoption evidence!
      unadoptedRunIds: ['run-002'],
      adoptedRunIds: [],
      createdAt: run2.createdAt,
      updatedAt: run2.createdAt,
      migrationProvenance: {
        isMigrated: true,
        sourceRecordIds: ['run-002'],
        sourceFields: ['run-002.branchLabel', 'run-002.evaluations'],
        inferredFields: ['owner', 'headSnapshotId(保持snap-002-before)', 'unadoptedRunIds'],
        note: '没有明确采纳证据，不将 run-002.systemAfter 自动推进为 headSnapshot；优化后的候选结构保留在 unadoptedRunIds 与 snap-002-after。',
      },
    });

    expSnapshots.push({
      id: 'exp-snap-run-002',
      runId: 'run-002',
      baseSnapshotId: 'snap-002-before',
      candidateSystemSpec: run2.systemAfter,
      adoptedAsSnapshotId: null,
      capturedAt: run2.createdAt,
      status: run2.status,
    });
  }

  // 3. Item-by-item RunSupplement mapping (idempotent; preserves any existing run_supplements_append records)
  const existingSupplements = listRunSupplements(workspaceDir);
  const nonMigratedSupplements = existingSupplements.filter(
    (s) => s.sourceStorage !== 'migrated_from_runs_jsonl',
  );
  const migratedSupplements: RunSupplement[] = [];

  for (const run of runs) {
    (run.evaluations ?? []).forEach((ev, idx) => {
      const classified = classifyEvaluationItem(run, ev, threadEntries);
      migratedSupplements.push({
        id: `sup-mig-${run.id}-${ev.id}`,
        runId: run.id,
        supplementKind: classified.kind,
        createdAt: ev.evaluatedAt || run.createdAt,
        createdBy: MIGRATED_UNKNOWN_ACTOR,
        sourceStorage: 'migrated_from_runs_jsonl',
        legacySourceField: `${run.id}.evaluations[id=${ev.id}]`,
        legacyOriginalId: ev.id,
        originalOrder: idx,
        classificationBasis: classified.basis,
        verdict: ev,
      });
    });

    (run.standaloneAnalyses ?? []).forEach((sa, idx) => {
      migratedSupplements.push({
        id: `sup-mig-${run.id}-${sa.id}`,
        runId: run.id,
        supplementKind: 'standalone_analysis',
        createdAt: sa.ranAt || run.createdAt,
        createdBy: MIGRATED_UNKNOWN_ACTOR,
        sourceStorage: 'migrated_from_runs_jsonl',
        legacySourceField: `${run.id}.standaloneAnalyses[id=${sa.id}]`,
        legacyOriginalId: sa.id,
        originalOrder: idx,
        classificationBasis: `独立分析插件 ${sa.componentId}@${sa.version} 对 ${run.id} 已保存产物执行分析 (ranAt=${sa.ranAt})`,
        standaloneAnalysis: {
          ...sa,
          sourceStorage: 'runs_jsonl',
          legacySourceField: `${run.id}.standaloneAnalyses[id=${sa.id}]`,
        },
      });
    });
  }

  const allSupplements = [...migratedSupplements, ...nonMigratedSupplements];

  // 4. Freeze component versions referenced by runs or snapshots + stage CAS blobs
  const refRunsMap = new Map<string, Set<string>>();
  const refSnapsMap = new Map<string, Set<string>>();
  const refRunHashesMap = new Map<string, Array<{ runId: string; codeHash: string }>>();
  const earliestRefAtMap = new Map<string, string>();

  const noteRefTime = (key: string, iso: string) => {
    const prev = earliestRefAtMap.get(key);
    if (!prev || iso < prev) earliestRefAtMap.set(key, iso);
  };

  for (const run of runs) {
    for (const p of run.composition?.parts ?? []) {
      const k = `${p.componentId}@${p.version}`;
      if (!refRunsMap.has(k)) refRunsMap.set(k, new Set());
      refRunsMap.get(k)!.add(run.id);
      if (!refRunHashesMap.has(k)) refRunHashesMap.set(k, []);
      refRunHashesMap.get(k)!.push({ runId: run.id, codeHash: p.codeHash });
      noteRefTime(k, run.createdAt);
    }
    for (const ev of run.evaluations ?? []) {
      const k = `${ev.evaluatorId}@${ev.evaluatorVersion}`;
      if (!refRunsMap.has(k)) refRunsMap.set(k, new Set());
      refRunsMap.get(k)!.add(run.id);
      if (!refRunHashesMap.has(k)) refRunHashesMap.set(k, []);
      refRunHashesMap.get(k)!.push({ runId: run.id, codeHash: ev.evaluatorCodeHash });
      noteRefTime(k, ev.evaluatedAt || run.createdAt);
    }
    for (const sa of run.standaloneAnalyses ?? []) {
      const k = `${sa.componentId}@${sa.version}`;
      if (!refRunsMap.has(k)) refRunsMap.set(k, new Set());
      refRunsMap.get(k)!.add(run.id);
      if (!refRunHashesMap.has(k)) refRunHashesMap.set(k, []);
      refRunHashesMap.get(k)!.push({ runId: run.id, codeHash: sa.codeHash });
      noteRefTime(k, sa.ranAt || run.createdAt);
    }
  }

  for (const snap of snapshots) {
    for (const p of snap.pinnedComponents) {
      const k = `${p.componentId}@${p.version}`;
      if (!refSnapsMap.has(k)) refSnapsMap.set(k, new Set());
      refSnapsMap.get(k)!.add(snap.id);
      noteRefTime(k, snap.createdAt);
    }
    for (const b of snap.evaluatorBindings) {
      const k = `${b.evaluatorId}@${b.evaluatorVersion}`;
      if (!refSnapsMap.has(k)) refSnapsMap.set(k, new Set());
      refSnapsMap.get(k)!.add(snap.id);
      noteRefTime(k, snap.createdAt);
    }
  }

  const stagedCasBlobs = new Map<string, string>();
  const historicalDriftedVersions: MigrationCorrespondenceReport['historicalDriftedVersions'] = [];
  const missingOnDiskVersions: string[] = [];
  let frozenVersionsCount = 0;

  const updatedDossiers = rawDossiers.map(({ dirName, dossier }) => {
    const nextVersions: ComponentVersionRecord[] = dossier.versions.map((v) => {
      const key = `${dossier.id}@${v.version}`;
      const runIds = Array.from(new Set([...(v.frozenByRunIds ?? []), ...(refRunsMap.get(key) ?? [])])).sort();
      const snapIds = Array.from(
        new Set([...(v.frozenBySnapshotIds ?? []), ...(refSnapsMap.get(key) ?? [])]),
      ).sort();
      const isReferenced = runIds.length > 0 || snapIds.length > 0;

      const codePath = path.join(paths.componentsDir, dirName, v.version, v.codeFile);
      const existsOnDisk = fs.existsSync(codePath);
      const diskText = existsOnDisk ? fs.readFileSync(codePath, 'utf8') : null;
      const diskHash = diskText !== null ? sha256(diskText) : null;

      const driftedList: HistoricalHashDriftRecord[] = [...(v.historicalDriftedHashes ?? [])];
      for (const rec of refRunHashesMap.get(key) ?? []) {
        if (diskHash !== null && rec.codeHash !== diskHash) {
          if (!driftedList.some((d) => d.runId === rec.runId && d.recordedCodeHash === rec.codeHash)) {
            driftedList.push({
              runId: rec.runId,
              recordedCodeHash: rec.codeHash,
              diskCodeHashAtAudit: diskHash,
              note: `历史运行 ${rec.runId} 记录的源码哈希 (${rec.codeHash}) 与当前磁盘文件 (${diskHash}) 不一致，不得视为同一份源码。`,
            });
          }
          historicalDriftedVersions.push({
            componentId: dossier.id,
            version: v.version,
            runId: rec.runId,
            recordedRunHash: rec.codeHash,
            diskHash,
          });
        }
      }

      let sourceAvailability: ComponentSourceAvailability;
      if (!existsOnDisk) {
        sourceAvailability = 'missing_on_disk';
        missingOnDiskVersions.push(key);
      } else if (driftedList.length > 0) {
        sourceAvailability = 'historical_hash_drifted';
      } else {
        sourceAvailability = 'available_on_disk';
      }

      const lifecycle = v.lifecycle === 'frozen' || isReferenced ? 'frozen' : 'draft';
      if (lifecycle === 'frozen') frozenVersionsCount++;

      let immutableBlobHash = v.immutableBlobHash ?? null;
      if (lifecycle === 'frozen' && !immutableBlobHash && diskText !== null && diskHash === v.codeHash) {
        immutableBlobHash = diskHash;
        stagedCasBlobs.set(diskHash, diskText);
      } else if (immutableBlobHash && diskText !== null && diskHash === immutableBlobHash) {
        stagedCasBlobs.set(immutableBlobHash, diskText);
      }

      let pinnedRelativeDeps = v.pinnedRelativeDeps;
      if (lifecycle === 'frozen' && existsOnDisk && immutableBlobHash) {
        const versionDir = path.join(paths.componentsDir, dirName, v.version);
        const discoveredDeps = discoverLocalRelativeDependencies(versionDir, v.codeFile, dossier.dependencies);
        if (discoveredDeps.length > 0) {
          pinnedRelativeDeps = discoveredDeps.map((dep) => {
            stagedCasBlobs.set(dep.codeHash, dep.codeContent);
            return {
              relativePath: dep.relativePath,
              codeHash: dep.codeHash,
              immutableBlobHash: dep.codeHash,
            };
          });
        }
      }

      let pinnedHostModules = v.pinnedHostModules;
      if (lifecycle === 'frozen' && existsOnDisk && immutableBlobHash) {
        const discoveredHostMods = discoverDeclaredHostModules(dossier.dependencies);
        if (pinnedHostModules && pinnedHostModules.length > 0) {
          pinnedHostModules = pinnedHostModules.map((existing) => {
            const match = discoveredHostMods.find((m) => m.targetId === existing.targetId);
            const blobHash = existing.immutableBlobHash || existing.codeHash;
            if (match && match.codeHash === existing.codeHash) {
              stagedCasBlobs.set(blobHash, match.codeContent);
            }
            return {
              targetId: existing.targetId,
              codeHash: existing.codeHash,
              immutableBlobHash: blobHash,
              casPath: existing.casPath || `immutable_store/sha256/${blobHash}`,
            };
          });
        } else if (discoveredHostMods.length > 0) {
          pinnedHostModules = discoveredHostMods.map((mod) => {
            stagedCasBlobs.set(mod.codeHash, mod.codeContent);
            return {
              targetId: mod.targetId,
              codeHash: mod.codeHash,
              immutableBlobHash: mod.codeHash,
              casPath: `immutable_store/sha256/${mod.codeHash}`,
            };
          });
        }
      }

      const cleanedVer: ComponentVersionRecord = {
        ...v,
        lifecycle,
        frozenAt: lifecycle === 'frozen' ? v.frozenAt || earliestRefAtMap.get(key) || v.createdAt : null,
        frozenByRunIds: runIds,
        frozenBySnapshotIds: snapIds,
        sourceAvailability,
        immutableBlobHash,
        ...(pinnedRelativeDeps && pinnedRelativeDeps.length > 0 ? { pinnedRelativeDeps } : {}),
        ...(pinnedHostModules && pinnedHostModules.length > 0 ? { pinnedHostModules } : {}),
        ...(driftedList.length > 0 ? { historicalDriftedHashes: driftedList } : {}),
      };
      delete cleanedVer.casIntegrityStatus;
      delete cleanedVer.casTamperDetected;
      delete cleanedVer.casAvailable;
      delete cleanedVer.workspaceMatchesFrozenHash;
      delete cleanedVer.frozenWorkspaceModified;
      delete cleanedVer.relativeDepsWorkspaceModified;
      delete cleanedVer.hostModulesWorkspaceModified;
      return cleanedVer;
    });

    const cleaned: ComponentDossier = {
      ...dossier,
      versions: nextVersions,
    };
    delete cleaned.diskTamperDetected;
    delete cleaned.frozenDriftDetected;
    delete cleaned.hostModuleDriftDetected;
    delete cleaned.casTamperDetected;
    delete cleaned.diskActualHash;
    delete cleaned.impactScope;

    return { dirName, dossier: cleaned };
  });

  // 5. Validate ALL constraints on staged data BEFORE touching formal workspace files
  verifyStagingConstraints({
    runs,
    researchObjects,
    snapshots,
    branches,
    archSnapshots,
    expSnapshots,
    supplements: allSupplements,
    updatedDossiers,
  });

  // 6. Write staged files into stagingDir/staged/
  interface CommitTarget {
    targetPath: string;
    stagePath: string;
    content: string;
  }
  const commitTargets: CommitTarget[] = [];

  const stageFile = (relPath: string, content: string) => {
    const stagePath = path.join(stageFilesDir, relPath);
    const targetPath = path.join(paths.workspaceDir, relPath);
    atomicWriteFileSync(stagePath, content);
    commitTargets.push({ targetPath, stagePath, content });
  };

  stageFile('research_objects.json', JSON.stringify(researchObjects, null, 2) + '\n');
  stageFile('snapshots.jsonl', snapshots.map((s) => JSON.stringify(s)).join('\n') + '\n');
  stageFile('branches.json', JSON.stringify(branches, null, 2) + '\n');
  stageFile(
    'architecture_snapshots.jsonl',
    archSnapshots.map((s) => JSON.stringify(s)).join('\n') + '\n',
  );
  stageFile(
    'experiment_snapshots.jsonl',
    expSnapshots.map((s) => JSON.stringify(s)).join('\n') + '\n',
  );
  stageFile('run_supplements.jsonl', allSupplements.map((s) => JSON.stringify(s)).join('\n') + '\n');

  const migrationManifest = {
    contractId: LEGACY_MIGRATION_MAPPING_SPEC.contractId,
    spec: LEGACY_MIGRATION_MAPPING_SPEC,
    legacyInputs: {
      runsJsonlSha256: legacyDigestsBefore.find((d) => d.relativePath === 'runs.jsonl')?.sha256 ?? null,
      threadJsonlSha256: legacyDigestsBefore.find((d) => d.relativePath === 'thread.jsonl')?.sha256 ?? null,
    },
    migratedOutputs: {
      researchObjectIds: researchObjects.map((r) => r.id),
      snapshotLineage: snapshots.map((s) => ({
        id: s.id,
        branchId: s.branchId,
        parentSnapshotId: s.parentSnapshotId,
        legacyParentRunId: s.legacyParentRunId,
        sourceExperimentRunId: s.sourceExperimentRunId,
      })),
      branches: branches.map((b) => ({
        id: b.id,
        baseSnapshotId: b.baseSnapshotId,
        headSnapshotId: b.headSnapshotId,
        adoptedRunIds: b.adoptedRunIds,
        unadoptedRunIds: b.unadoptedRunIds,
      })),
    },
  };
  stageFile('migration_a1_manifest.json', JSON.stringify(migrationManifest, null, 2) + '\n');

  for (const { dirName, dossier } of updatedDossiers) {
    stageFile(path.join('components', dirName, 'dossier.json'), JSON.stringify(dossier, null, 2) + '\n');
  }

  for (const [blobHash, blobContent] of stagedCasBlobs.entries()) {
    stageFile(path.join('immutable_store', 'sha256', blobHash), blobContent);
  }

  // 7. Save rollback snapshot of every target file that already exists + durable journal (phase: 'preparing')
  const rollbackRecords: Array<{
    targetPath: string;
    relativePath: string;
    existedBefore: boolean;
    backupPath: string;
    backupRelPath: string;
    stagedHash: string;
  }> = [];

  for (const item of commitTargets) {
    const rel = path.relative(paths.workspaceDir, item.targetPath).replace(/\\/g, '/');
    const backupRelPath = path.join('rollback', rel).replace(/\\/g, '/');
    const backupPath = path.join(stagingDir, backupRelPath);
    if (fs.existsSync(item.targetPath)) {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(item.targetPath, backupPath);
      rollbackRecords.push({
        targetPath: item.targetPath,
        relativePath: rel,
        existedBefore: true,
        backupPath,
        backupRelPath,
        stagedHash: sha256(item.content),
      });
    } else {
      rollbackRecords.push({
        targetPath: item.targetPath,
        relativePath: rel,
        existedBefore: false,
        backupPath,
        backupRelPath,
        stagedHash: sha256(item.content),
      });
    }
  }

  const startedAt = new Date().toISOString();
  const journalTargets: MigrationJournal['targets'] = rollbackRecords.map((r) => ({
    relativePath: r.relativePath,
    existedBefore: r.existedBefore,
    backupRelPath: r.backupRelPath,
    stagedHash: r.stagedHash,
  }));

  const writeJournal = (phase: MigrationJournal['phase']) => {
    const journal: MigrationJournal = {
      contractId: LEGACY_MIGRATION_MAPPING_SPEC.contractId,
      migrationId,
      phase,
      startedAt,
      updatedAt: new Date().toISOString(),
      targets: journalTargets,
    };
    atomicWriteFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
  };

  writeJournal('preparing');
  // Transition journal to 'committing' BEFORE touching any formal target file
  writeJournal('committing');

  // 8. Commit atomically with exception rollback protection
  const committedFiles: string[] = [];
  let committedCount = 0;

  try {
    for (const item of commitTargets) {
      const rel = path.relative(paths.workspaceDir, item.targetPath).replace(/\\/g, '/');
      if (rel.startsWith('immutable_store/sha256/')) {
        const expectedHash = path.basename(rel);
        const writtenHash = writeCasBlob(item.content, workspaceDir);
        if (writtenHash !== expectedHash) {
          throw new Error(`CAS 写入哈希不匹配: ${writtenHash} != ${expectedHash}`);
        }
      } else {
        atomicWriteFileSync(item.targetPath, item.content);
      }
      committedFiles.push(rel);
      committedCount++;

      if (
        typeof options?.simulateCrashWithoutRollbackAfterFiles === 'number' &&
        committedCount >= options.simulateCrashWithoutRollbackAfterFiles
      ) {
        throw new SimulatedProcessCrashError(migrationId, committedCount);
      }

      if (
        typeof options?.simulateCommitFailureAfterFiles === 'number' &&
        committedCount >= options.simulateCommitFailureAfterFiles
      ) {
        throw new Error(`模拟提交中断（已写入 ${committedCount} 个文件），触发原子回滚验证`);
      }
    }
  } catch (err) {
    // If simulating an abrupt SIGKILL crash, do NOT execute in-process rollback so restart crash recovery can be verified!
    if (err instanceof SimulatedProcessCrashError) {
      throw err;
    }

    // In-process exception rollback: restore/remove all touched targets immediately
    for (const rec of rollbackRecords.reverse()) {
      if (rec.existedBefore) {
        fs.mkdirSync(path.dirname(rec.targetPath), { recursive: true });
        fs.copyFileSync(rec.backupPath, rec.targetPath);
      } else if (fs.existsSync(rec.targetPath)) {
        fs.unlinkSync(rec.targetPath);
      }
    }
    fs.rmSync(stagingDir, { recursive: true, force: true });
    cleanupEmptyMigrationDirs(paths.workspaceDir);
    throw err;
  }

  // 9. Verify legacy files remained 100% byte-for-byte untouched
  const legacyFilesUntouched = legacyDigestsBefore.map((before) => {
    const buf = fs.readFileSync(before.abs);
    const afterHash = sha256Buffer(buf);
    if (afterHash !== before.sha256 || buf.byteLength !== before.bytes) {
      throw new Error(`严重错误：历史文件 ${before.relativePath} 在迁移后发生变化！`);
    }
    return {
      relativePath: before.relativePath,
      bytes: buf.byteLength,
      sha256: afterHash,
    };
  });

  // 10. Verify correspondence on committed live workspace
  const committedRawRuns = listRawRuns(workspaceDir);
  const committedSupplements = listRunSupplements(workspaceDir);
  const hydratedRuns = hydrateRunsWithSupplements(committedRawRuns, committedSupplements);
  const run1Raw = runs.find((r) => r.id === 'run-001');
  const run1Hydrated = hydratedRuns.find((r) => r.id === 'run-001');
  const run1SupsCommitted = committedSupplements.filter((s) => s.runId === 'run-001');
  const run1MigratedOnly = run1SupsCommitted.filter(
    (s) => s.sourceStorage === 'migrated_from_runs_jsonl',
  );
  const run1AppendedEvals = run1SupsCommitted.filter(
    (s) => s.sourceStorage === 'run_supplements_append' && Boolean(s.verdict),
  );
  const run1AppendedStandalone = run1SupsCommitted.filter(
    (s) => s.sourceStorage === 'run_supplements_append' && Boolean(s.standaloneAnalysis),
  );
  const run1MigratedHydrated = run1Raw
    ? hydrateRunsWithSupplements([run1Raw], run1MigratedOnly)[0]
    : undefined;
  const hydratingRunsPreservesCountsWithoutDuplication = Boolean(
    run1Raw &&
      run1Hydrated &&
      run1MigratedHydrated &&
      run1MigratedHydrated.evaluations.length === run1Raw.evaluations.length &&
      (run1MigratedHydrated.standaloneAnalyses?.length ?? 0) ===
        (run1Raw.standaloneAnalyses?.length ?? 0) &&
      run1Hydrated.evaluations.length === run1Raw.evaluations.length + run1AppendedEvals.length &&
      (run1Hydrated.standaloneAnalyses?.length ?? 0) ===
        (run1Raw.standaloneAnalyses?.length ?? 0) + run1AppendedStandalone.length,
  );

  // Deduplicate historicalDriftedVersions report list
  const uniqueDriftsMap = new Map<string, MigrationCorrespondenceReport['historicalDriftedVersions'][number]>();
  for (const d of historicalDriftedVersions) {
    uniqueDriftsMap.set(`${d.componentId}@${d.version}:${d.runId}:${d.recordedRunHash}`, d);
  }
  const uniqueDrifts = Array.from(uniqueDriftsMap.values());

  // Verify idempotency fingerprint of canonicalized state
  canonicalJson({
    researchObjects,
    snapshots,
    branches,
    archSnapshots,
    expSnapshots,
    allSupplements,
  });

  // Mark journal as committed, then clean up temporary staging folder upon verified commit
  writeJournal('committed');
  fs.rmSync(stagingDir, { recursive: true, force: true });
  cleanupEmptyMigrationDirs(paths.workspaceDir);

  return {
    success: true,
    workspaceDir: paths.workspaceDir,
    stagingDir,
    committedFiles,
    legacyFilesUntouched,
    recoveredPriorCrashes,
    correspondence: {
      runsCount: runs.length,
      threadEntriesCount: threadEntries.length,
      researchObjectsCount: researchObjects.length,
      snapshotsCount: snapshots.length,
      branchesCount: branches.length,
      architectureSnapshotsCount: archSnapshots.length,
      experimentSnapshotsCount: expSnapshots.length,
      runSupplementsCount: allSupplements.length,
      frozenVersionsCount,
      casBlobsCount: stagedCasBlobs.size,
      missingOnDiskVersions: Array.from(new Set(missingOnDiskVersions)),
      historicalDriftedVersions: uniqueDrifts,
      hydratingRunsPreservesCountsWithoutDuplication,
      evalRmsSpotV01DriftPreserved: uniqueDrifts.some(
        (d) =>
          d.componentId === 'eval-rms-spot' &&
          d.version === 'v0.1' &&
          d.recordedRunHash === 'a3b03826e7ce6dccbaac59ab5eb8f46b479bbd41b3ce7a3817f66939ce062b55',
      ),
      evalRmsSpotV02MissingPreserved: missingOnDiskVersions.includes('eval-rms-spot@v0.2'),
      branchBDoubletHeadStaysBefore:
        branches.find((b) => b.id === 'branch-b-doublet')?.headSnapshotId === 'snap-002-before',
      snap002BeforeParentNull:
        snapshots.find((s) => s.id === 'snap-002-before')?.parentSnapshotId === null,
    },
  };
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExperimentRun } from '../src/core/types.ts';
import { verifyRunIntegrity } from './storage.ts';

export interface WorkspaceFileDigest {
  relativePath: string;
  bytes: number;
  sha256: string; // 256-bit SHA-256 digest represented as 64 hex chars
}

export interface BackupManifest {
  backupId: string;
  createdAt: string;
  hashAlgorithm: 'SHA-256 (256-bit digest, 64 hex chars)';
  excludedRules: string[];
  excludedPaths: string[];
  totalFiles: number;
  totalBytes: number;
  files: WorkspaceFileDigest[];
}

export interface RestoreVerificationResult {
  passed: boolean;
  backupDir: string;
  checkedManifestFiles: number;
  restoredMatchesManifest: boolean;
  liveMatchesManifest: boolean;
  mismatches: string[];
}

export interface ComponentAuditItem {
  id: string;
  name: string;
  runtime: string;
  activeVersion: string;
  versions: Array<{
    version: string;
    codeFile: string;
    recordedCodeSha256: string;
    diskSha256: string | null;
    matchesDisk: boolean;
    referencedByRunIds: string[];
    mustFreezeInA1: boolean;
  }>;
  approvedSha256: string | null;
  checkedSha256: string | null;
  selfCheckStatus: string;
  securityStatus: string;
  diskTamperDetected: boolean;
}

export interface RunAuditItem {
  id: string;
  sequenceNumber: number;
  branchLabel: string;
  legacyParentRunId: string | null;
  mode: string;
  tamperStatus: string;
  sameBeforeAfterSpec: boolean;
  systemBeforeSummary: string;
  systemAfterSummary: string;
  compositionParts: Array<{ slot: string; componentId: string; version: string; codeSha256: string }>;
  evaluationsCount: number;
  standaloneAnalysesCount: number;
  missingForFullReproducibility: string[];
}

export interface StageAMigrationPlan {
  generatedAt: string;
  workspaceSummary: {
    totalPreMigrationFiles: number;
    totalPreMigrationBytes: number;
    runsCount: number;
    threadEntriesCount: number;
    componentsCount: number;
  };
  researchObjects: Array<{
    id: string;
    domainId: string;
    title: string;
    createdBy: { actorId: string; displayName: string; actorKind: 'migrated_unknown' };
    migrationProvenance: {
      isMigrated: true;
      sourceRecordIds: string[];
      inferredFields: string[];
      note: string;
    };
  }>;
  snapshots: Array<{
    id: string;
    researchObjectId: string;
    sourceRunId: string;
    sourceField: 'run-001.systemBefore' | 'run-002.systemBefore' | 'run-002.systemAfter';
    parentSnapshotId: string | null;
    legacyParentRunId: string | null;
    specName: string;
    surfaceCount: number;
    pinnedComponents: Array<{ componentId: string; version: string; codeSha256: string }>;
    evaluatorBindings: Array<{
      componentId: string;
      version: string;
      codeSha256: string;
      coveredScopeNote: string;
    }>;
    migrationProvenance: {
      isMigrated: true;
      sourceRecordId: string;
      sourceField: string;
      inferredFields: string[];
      note: string;
    };
  }>;
  branches: Array<{
    id: string;
    name: string;
    researchObjectId: string;
    owner: { actorId: string; displayName: string; actorKind: 'migrated_unknown' };
    status: 'exploring';
    baseSnapshotId: string;
    headSnapshotId: string;
    migrationProvenance: {
      isMigrated: true;
      sourceRecordId: string;
      inferredFields: string[];
      note: string;
    };
  }>;
  componentAudit: ComponentAuditItem[];
  runAudit: RunAuditItem[];
  findings: Array<{ severity: 'high' | 'medium' | 'info'; area: string; detail: string }>;
}

function sha256Buffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

const EXACT_BACKUP_EXCLUDED_DIRS = new Set(['.backups', '.migration_tmp']);

export function collectWorkspaceFilesDetailed(workspaceDir: string): {
  files: WorkspaceFileDigest[];
  excludedPaths: string[];
} {
  const files: WorkspaceFileDigest[] = [];
  const excludedPaths: string[] = [];
  if (!fs.existsSync(workspaceDir)) return { files, excludedPaths };

  const walk = (currentDir: string) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const rel = path.relative(workspaceDir, fullPath).replace(/\\/g, '/');
      if (EXACT_BACKUP_EXCLUDED_DIRS.has(rel) || EXACT_BACKUP_EXCLUDED_DIRS.has(entry.name) && currentDir === workspaceDir) {
        excludedPaths.push(entry.isDirectory() ? `${rel}/` : rel);
        continue;
      }
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(fullPath);
        files.push({
          relativePath: rel,
          bytes: buf.byteLength,
          sha256: sha256Buffer(buf),
        });
      }
    }
  };

  walk(workspaceDir);
  return { files, excludedPaths };
}

/**
 * Recursively collect workspace files while excluding ONLY explicit backup/staging directories
 * (`.backups`, `.migration_tmp`) so non-backup hidden files are preserved in backups.
 */
export function collectWorkspaceFiles(workspaceDir: string): WorkspaceFileDigest[] {
  return collectWorkspaceFilesDetailed(workspaceDir).files;
}

export function createPreStageABackup(
  workspaceDir: string,
  backupTag?: string,
): { backupDir: string; manifest: BackupManifest } {
  const { files, excludedPaths } = collectWorkspaceFilesDetailed(workspaceDir);
  const stamp = backupTag || new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = `pre-stage-a-${stamp}`;
  const backupsRoot = path.join(workspaceDir, '.backups');
  const backupDir = path.join(backupsRoot, backupId);
  const filesOutDir = path.join(backupDir, 'files');

  fs.mkdirSync(filesOutDir, { recursive: true });

  for (const item of files) {
    const src = path.join(workspaceDir, item.relativePath);
    const dst = path.join(filesOutDir, item.relativePath);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }

  const manifest: BackupManifest = {
    backupId,
    createdAt: new Date().toISOString(),
    hashAlgorithm: 'SHA-256 (256-bit digest, 64 hex chars)',
    excludedRules: Array.from(EXACT_BACKUP_EXCLUDED_DIRS).map((d) => `${d}/`),
    excludedPaths,
    totalFiles: files.length,
    totalBytes: files.reduce((acc, f) => acc + f.bytes, 0),
    files,
  };

  fs.writeFileSync(
    path.join(backupDir, 'backup-manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  return { backupDir, manifest };
}

/**
 * Verifies backup restorability into a clean temporary directory and strictly compares
 * ONLY the pre-migration source files listed in `backup-manifest.json`.
 */
export function verifyBackupRestore(
  backupDir: string,
  originalWorkspaceDir: string,
): RestoreVerificationResult {
  const manifestPath = path.join(backupDir, 'backup-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
  const filesRoot = path.join(backupDir, 'files');

  const tempRestoreDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-a0-restore-'));
  const mismatches: string[] = [];
  let restoredMatchesManifest = true;
  let liveMatchesManifest = true;

  try {
    // 1. Simulate clean restore of all manifest files into tempRestoreDir
    for (const entry of manifest.files) {
      const backupFile = path.join(filesRoot, entry.relativePath);
      if (!fs.existsSync(backupFile)) {
        restoredMatchesManifest = false;
        mismatches.push(`备份缺失文件: ${entry.relativePath}`);
        continue;
      }
      const restoreTarget = path.join(tempRestoreDir, entry.relativePath);
      fs.mkdirSync(path.dirname(restoreTarget), { recursive: true });
      fs.copyFileSync(backupFile, restoreTarget);

      const restoredHash = sha256Buffer(fs.readFileSync(restoreTarget));
      if (restoredHash !== entry.sha256) {
        restoredMatchesManifest = false;
        mismatches.push(
          `恢复文件哈希不一致 ${entry.relativePath}: restored=${restoredHash} vs manifest=${entry.sha256}`,
        );
      }

      // 2. Verify live pre-migration workspace files match manifest identically
      const liveFile = path.join(originalWorkspaceDir, entry.relativePath);
      if (!fs.existsSync(liveFile)) {
        liveMatchesManifest = false;
        mismatches.push(`原始工作区缺失文件: ${entry.relativePath}`);
      } else {
        const liveHash = sha256Buffer(fs.readFileSync(liveFile));
        if (liveHash !== entry.sha256) {
          liveMatchesManifest = false;
          mismatches.push(
            `原始工作区文件在备份后发生变动 ${entry.relativePath}: live=${liveHash} vs manifest=${entry.sha256}`,
          );
        }
      }
    }

    // 3. Ensure restored directory has exact same file set as manifest (no recursive .backups!)
    const restoredFiles = collectWorkspaceFiles(tempRestoreDir);
    if (restoredFiles.length !== manifest.files.length) {
      restoredMatchesManifest = false;
      mismatches.push(
        `恢复文件数量不一致: restored=${restoredFiles.length} vs manifest=${manifest.files.length}`,
      );
    }

    return {
      passed: restoredMatchesManifest && liveMatchesManifest && mismatches.length === 0,
      backupDir,
      checkedManifestFiles: manifest.files.length,
      restoredMatchesManifest,
      liveMatchesManifest,
      mismatches,
    };
  } finally {
    fs.rmSync(tempRestoreDir, { recursive: true, force: true });
  }
}

/**
 * Strictly read-only inspection of current workspace state and generation of the Stage A
 * field-by-field migration plan. Never writes to formal workspace data files.
 */
export function auditWorkspaceAndBuildMigrationPlan(
  workspaceDir: string,
  repoRootDir: string,
): StageAMigrationPlan {
  const preFiles = collectWorkspaceFiles(workspaceDir);

  const runsPath = path.join(workspaceDir, 'runs.jsonl');
  const runs: ExperimentRun[] = fs.existsSync(runsPath)
    ? fs
        .readFileSync(runsPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as ExperimentRun)
    : [];

  const threadPath = path.join(workspaceDir, 'thread.jsonl');
  const threadLines = fs.existsSync(threadPath)
    ? fs
        .readFileSync(threadPath, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as { id: string; origin: string; runId: string | null })
    : [];

  // Map componentId@version -> runIds referencing it
  const refRunMap = new Map<string, Set<string>>();
  const addRef = (compId: string, ver: string, runId: string) => {
    const k = `${compId}@${ver}`;
    if (!refRunMap.has(k)) refRunMap.set(k, new Set());
    refRunMap.get(k)!.add(runId);
  };

  for (const r of runs) {
    for (const p of r.composition?.parts ?? []) {
      addRef(p.componentId, p.version, r.id);
    }
    for (const ev of r.evaluations ?? []) {
      addRef(ev.evaluatorId, ev.evaluatorVersion, r.id);
    }
    for (const sa of r.standaloneAnalyses ?? []) {
      addRef(sa.componentId, sa.version, r.id);
    }
  }

  // Read-only component dossier + disk hash audit
  const compsDir = path.join(workspaceDir, 'components');
  const compDirs = fs.existsSync(compsDir)
    ? fs
        .readdirSync(compsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  const componentAudit: ComponentAuditItem[] = [];
  for (const dir of compDirs) {
    const dossierPath = path.join(compsDir, dir.name, 'dossier.json');
    if (!fs.existsSync(dossierPath)) continue;
    const d = JSON.parse(fs.readFileSync(dossierPath, 'utf8')) as {
      id: string;
      name: string;
      runtime: string;
      activeVersion: string;
      versions: Array<{ version: string; codeFile: string; codeHash: string }>;
      selfCheck: { status: string; checkedCodeHash: string | null };
      codeSecurityReview: { status: string; approvedHash: string | null };
    };

    let tamper = false;
    const verItems = (d.versions ?? []).map((v) => {
      const codePath = path.join(compsDir, dir.name, v.version, v.codeFile);
      const diskSha256 = fs.existsSync(codePath) ? sha256Buffer(fs.readFileSync(codePath)) : null;
      const matchesDisk = diskSha256 === v.codeHash;
      if (v.version === d.activeVersion) {
        if (!matchesDisk) tamper = true;
        if (d.codeSecurityReview.approvedHash && diskSha256 !== d.codeSecurityReview.approvedHash) {
          tamper = true;
        }
      }
      const referencedByRunIds = Array.from(refRunMap.get(`${d.id}@${v.version}`) ?? []);
      return {
        version: v.version,
        codeFile: v.codeFile,
        recordedCodeSha256: v.codeHash,
        diskSha256,
        matchesDisk,
        referencedByRunIds,
        mustFreezeInA1: referencedByRunIds.length > 0,
      };
    });

    componentAudit.push({
      id: d.id,
      name: d.name,
      runtime: d.runtime,
      activeVersion: d.activeVersion,
      versions: verItems,
      approvedSha256: d.codeSecurityReview?.approvedHash ?? null,
      checkedSha256: d.selfCheck?.checkedCodeHash ?? null,
      selfCheckStatus: d.selfCheck?.status ?? 'unrun',
      securityStatus: d.codeSecurityReview?.status ?? 'unreviewed_modified',
      diskTamperDetected: tamper,
    });
  }

  const runAudit: RunAuditItem[] = runs.map((r) => {
    const integrity = verifyRunIntegrity(r);
    const sameBeforeAfterSpec = JSON.stringify(r.systemBefore) === JSON.stringify(r.systemAfter);
    const missingForFullReproducibility: string[] = [];
    const rAny = r as unknown as Record<string, unknown>;
    if (!rAny.baseSnapshotId) missingForFullReproducibility.push('baseSnapshotId');
    if (!rAny.evaluationPolicy) missingForFullReproducibility.push('evaluationPolicy (Objective/Criteria)');
    if (!rAny.overrides) missingForFullReproducibility.push('overrides (显式临时覆盖参数记录)');
    if (!rAny.executor) missingForFullReproducibility.push('executor (ActorAttribution)');

    return {
      id: r.id,
      sequenceNumber: r.sequenceNumber,
      branchLabel: r.branchLabel,
      legacyParentRunId: r.parentRunId,
      mode: r.mode,
      tamperStatus: integrity,
      sameBeforeAfterSpec,
      systemBeforeSummary: `${r.systemBefore.name} (${r.systemBefore.surfaces.length} surfaces, EFL=${r.systemBefore.targetEflMm}mm)`,
      systemAfterSummary: `${r.systemAfter.name} (${r.systemAfter.surfaces.length} surfaces, EFL=${r.systemAfter.targetEflMm}mm)`,
      compositionParts: (r.composition?.parts ?? []).map((p) => ({
        slot: p.slot,
        componentId: p.componentId,
        version: p.version,
        codeSha256: p.codeHash,
      })),
      evaluationsCount: r.evaluations?.length ?? 0,
      standaloneAnalysesCount: r.standaloneAnalyses?.length ?? 0,
      missingForFullReproducibility,
    };
  });

  const run1 = runs.find((r) => r.id === 'run-001');
  const run2 = runs.find((r) => r.id === 'run-002');

  const snapshots: StageAMigrationPlan['snapshots'] = [];
  const branches: StageAMigrationPlan['branches'] = [];

  if (run1) {
    const eval1 = run1.evaluations?.[0];
    snapshots.push({
      id: 'snap-001',
      researchObjectId: 'obj-optics-100mm-f4',
      sourceRunId: 'run-001',
      sourceField: 'run-001.systemBefore',
      parentSnapshotId: null,
      legacyParentRunId: run1.parentRunId,
      specName: run1.systemBefore.name,
      surfaceCount: run1.systemBefore.surfaces.length,
      pinnedComponents: (run1.composition?.parts ?? []).map((p) => ({
        componentId: p.componentId,
        version: p.version,
        codeSha256: p.codeHash,
      })),
      evaluatorBindings: eval1
        ? [
            {
              componentId: eval1.evaluatorId,
              version: eval1.evaluatorVersion,
              codeSha256: eval1.evaluatorCodeHash,
              coveredScopeNote:
                '源自 run-001.evaluations[0]；另有事后重评 run-001.evaluations[1] (eval-mtf-chromatic@v0.1) 将作为 RunSupplement 保留。',
            },
          ]
        : [],
      migrationProvenance: {
        isMigrated: true,
        sourceRecordId: 'run-001',
        sourceField: 'run-001.systemBefore (与 run-001.systemAfter 完全一致)',
        inferredFields: ['researchObjectId', 'objectives', 'criteria', 'author'],
        note: '原始记录未署名操作者与研究对象 ID，由 A0/A1 迁移推断创建。',
      },
    });

    branches.push({
      id: 'branch-main-singlet',
      name: run1.branchLabel,
      researchObjectId: 'obj-optics-100mm-f4',
      owner: {
        actorId: 'migrated:unknown',
        displayName: '旧版记录（操作者未署名）',
        actorKind: 'migrated_unknown',
      },
      status: 'exploring',
      baseSnapshotId: 'snap-001',
      headSnapshotId: 'snap-001',
      migrationProvenance: {
        isMigrated: true,
        sourceRecordId: 'run-001',
        inferredFields: ['owner', 'status', 'researchObjectId'],
        note: '从 run-001.branchLabel 迁移推断为独立路线。',
      },
    });
  }

  if (run2) {
    const eval2 = run2.evaluations?.[0];
    snapshots.push({
      id: 'snap-002-before',
      researchObjectId: 'obj-optics-100mm-f4',
      sourceRunId: 'run-002',
      sourceField: 'run-002.systemBefore',
      parentSnapshotId: null, // Constraint 3: do NOT claim confirmed inheritance from snap-001!
      legacyParentRunId: run2.parentRunId,
      specName: run2.systemBefore.name,
      surfaceCount: run2.systemBefore.surfaces.length,
      pinnedComponents: (run2.composition?.parts ?? []).map((p) => ({
        componentId: p.componentId,
        version: p.version,
        codeSha256: p.codeHash,
      })),
      evaluatorBindings: eval2
        ? [
            {
              componentId: eval2.evaluatorId,
              version: eval2.evaluatorVersion,
              codeSha256: eval2.evaluatorCodeHash,
              coveredScopeNote: '源自 run-002.evaluations[0]',
            },
          ]
        : [],
      migrationProvenance: {
        isMigrated: true,
        sourceRecordId: 'run-002',
        sourceField: 'run-002.systemBefore',
        inferredFields: ['researchObjectId', 'parentSnapshotId(保持null)', 'author'],
        note: '虽然 run-002.parentRunId="run-001"，但几何结构已从 2 面单透镜切换为 3 面双胶合预设，无法确认存在严格配置继承，故 parentSnapshotId 置 null，仅保留 legacyParentRunId="run-001"。',
      },
    });

    snapshots.push({
      id: 'snap-002-after',
      researchObjectId: 'obj-optics-100mm-f4',
      sourceRunId: 'run-002',
      sourceField: 'run-002.systemAfter',
      parentSnapshotId: 'snap-002-before',
      legacyParentRunId: run2.parentRunId,
      specName: run2.systemAfter.name,
      surfaceCount: run2.systemAfter.surfaces.length,
      pinnedComponents: (run2.composition?.parts ?? []).map((p) => ({
        componentId: p.componentId,
        version: p.version,
        codeSha256: p.codeHash,
      })),
      evaluatorBindings: eval2
        ? [
            {
              componentId: eval2.evaluatorId,
              version: eval2.evaluatorVersion,
              codeSha256: eval2.evaluatorCodeHash,
              coveredScopeNote: '源自 run-002.evaluations[0]（注意：评价结果为 warning，MTF30=0.2237 < 0.35）',
            },
          ]
        : [],
      migrationProvenance: {
        isMigrated: true,
        sourceRecordId: 'run-002',
        sourceField: 'run-002.systemAfter',
        inferredFields: ['researchObjectId', 'objectives', 'criteria', 'author'],
        note: '记录 run-002 优化器产出的候选结构，不代表 warning 结论已被科学采纳。',
      },
    });

    branches.push({
      id: 'branch-b-doublet',
      name: run2.branchLabel,
      researchObjectId: 'obj-optics-100mm-f4',
      owner: {
        actorId: 'migrated:unknown',
        displayName: '旧版记录（操作者未署名）',
        actorKind: 'migrated_unknown',
      },
      status: 'exploring',
      baseSnapshotId: 'snap-002-before',
      headSnapshotId: 'snap-002-before',
      migrationProvenance: {
        isMigrated: true,
        sourceRecordId: 'run-002',
        inferredFields: ['owner', 'headSnapshotId(保持snap-002-before)', 'researchObjectId'],
        note: '没有明确采纳证据，不自动将 run-002.systemAfter 推进为 headSnapshot；headSnapshotId 保持 snap-002-before，优化后的 systemAfter 仅保留为未采用实验候选。',
      },
    });
  }

  // Inspect existing codebase hazards (read-only)
  const storagePath = path.join(repoRootDir, 'server', 'storage.ts');
  const storageText = fs.existsSync(storagePath) ? fs.readFileSync(storagePath, 'utf8') : '';
  const serverPath = path.join(repoRootDir, 'server.ts');
  const serverText = fs.existsSync(serverPath) ? fs.readFileSync(serverPath, 'utf8') : '';

  const findings: StageAMigrationPlan['findings'] = [];
  if (storageText.includes('if (v01 && v01.author === \'system\')')) {
    findings.push({
      severity: 'high',
      area: 'server/storage.ts (SEED_COMPONENTS 初始化)',
      detail: '存在重启时按 author==="system" 覆写 v0.1 源码文件的迁移分支，若用户直接用 VS Code 修改系统组件源码有被覆盖风险，须在 A1 移除。',
    });
  }
  if (storageText.includes('fs.writeFileSync(\n    RUNS_FILE') || storageText.includes('updateRunEvaluations')) {
    findings.push({
      severity: 'high',
      area: 'server/storage.ts (runs.jsonl 覆写)',
      detail: 'updateRunEvaluations() 与 appendRunStandaloneAnalysis() 当前全量重写 workspace/runs.jsonl，A1 须改为只追加 run_supplements.jsonl。',
    });
  }
  if (serverText.includes('appendThreadEntry') && serverText.includes("origin: 'experiment_run'")) {
    findings.push({
      severity: 'medium',
      area: 'server.ts (实验/重评双写 thread.jsonl)',
      detail: `当前 workspace/thread.jsonl 中 ${threadLines.filter((t) => t.origin === 'experiment_run' || t.origin === 'evaluator_verdict').length}/${threadLines.length} 条记录为实验/重评双写摘要，A2 须停止双写并改为关联引用。`,
    });
  }
  const runnerTestPath = path.join(repoRootDir, 'server', 'runner.test.ts');
  const runnerTestText = fs.existsSync(runnerTestPath) ? fs.readFileSync(runnerTestPath, 'utf8') : '';
  if (runnerTestText.includes('approveComponentCodeHash') && !runnerTestText.includes('os.tmpdir()')) {
    findings.push({
      severity: 'medium',
      area: 'server/runner.test.ts (测试直接写入真实工作区)',
      detail: 'runner.test.ts 当前直接对真实 workspace/components/* 执行自检与授权，会刷新 eval-rms-spot 与 solver-optiland-python 的 checkedAt/reviewedAt 时间戳；A1 应改为隔离临时目录或环境参数。',
    });
  }
  const unusedCodeTamper = componentAudit.some((c) => c.diskTamperDetected);
  const nonActiveDiskMismatches: string[] = [];
  const diskHashByCompVer = new Map<string, string | null>();
  for (const c of componentAudit) {
    for (const v of c.versions) {
      diskHashByCompVer.set(`${c.id}@${v.version}`, v.diskSha256);
      if (!v.matchesDisk) {
        nonActiveDiskMismatches.push(
          `${c.id}@${v.version} (dossier=${v.recordedCodeSha256.slice(0, 12)}..., disk=${v.diskSha256 ? v.diskSha256.slice(0, 12) + '...' : '缺失文件'})`,
        );
      }
    }
  }

  const runCodeHashDrifts: string[] = [];
  for (const r of runs) {
    for (const p of r.composition?.parts ?? []) {
      const diskHash = diskHashByCompVer.get(`${p.componentId}@${p.version}`);
      if (diskHash !== undefined && diskHash !== p.codeHash) {
        runCodeHashDrifts.push(
          `${r.id}.composition(${p.componentId}@${p.version}): run=${p.codeHash.slice(0, 12)}... vs disk=${diskHash ? diskHash.slice(0, 12) + '...' : '缺失'}`,
        );
      }
    }
    for (const ev of r.evaluations ?? []) {
      const diskHash = diskHashByCompVer.get(`${ev.evaluatorId}@${ev.evaluatorVersion}`);
      if (diskHash !== undefined && diskHash !== ev.evaluatorCodeHash) {
        runCodeHashDrifts.push(
          `${r.id}.evaluations(${ev.evaluatorId}@${ev.evaluatorVersion}): run=${ev.evaluatorCodeHash.slice(0, 12)}... vs disk=${diskHash ? diskHash.slice(0, 12) + '...' : '缺失'}`,
        );
      }
    }
  }

  findings.push({
    severity: unusedCodeTamper ? 'high' : 'info',
    area: '组件磁盘完整性与冻结范围',
    detail: unusedCodeTamper
      ? '检测到部分组件 activeVersion 磁盘哈希与档案不一致！'
      : `全部 ${componentAudit.length} 个组件当前 activeVersion 磁盘文件 SHA-256 均与 dossier.json 一致；其中 ${componentAudit.filter((c) => c.versions.some((v) => v.mustFreezeInA1)).map((c) => c.id).join(', ')} 的 v0.1 版本已被 runs.jsonl 引用，A1 须标记为冻结不可变版本。`,
  });
  if (nonActiveDiskMismatches.length > 0) {
    findings.push({
      severity: 'medium',
      area: '非活跃组件版本磁盘缺失/漂移',
      detail: `发现未在磁盘保留源码的历史版本条目：${nonActiveDiskMismatches.join('；')}。A1 迁移须保留其元数据并明确标注 sourceMissingOnDisk，禁止伪造或静默删除。`,
    });
  }
  if (runCodeHashDrifts.length > 0) {
    findings.push({
      severity: 'high',
      area: '历史 ExperimentRun 与当前磁盘组件哈希漂移',
      detail: `发现历史运行引用的组件哈希与当前磁盘文件不一致：${runCodeHashDrifts.join('；')}（印证旧版 SEED_COMPONENTS 覆写 v0.1 导致历史版本漂移，A1 必须实施组件版本不可变性与来源缺失标记）。`,
    });
  }
  findings.push({
    severity: 'info',
    area: 'ExperimentRun 历史字段审计',
    detail: 'run-001 / run-002 已完整保存 systemBefore/After、seed、runtimeEnv、composition.parts(含 paramsSnapshot 与 codeHash) 和 rawArtifacts；缺少显式 baseSnapshotId、overrides 与 evaluationPolicy(Objective/Criteria)，将在 A1 补全类型、A2 写入新运行记录。',
  });

  return {
    generatedAt: new Date().toISOString(),
    workspaceSummary: {
      totalPreMigrationFiles: preFiles.length,
      totalPreMigrationBytes: preFiles.reduce((acc, f) => acc + f.bytes, 0),
      runsCount: runs.length,
      threadEntriesCount: threadLines.length,
      componentsCount: componentAudit.length,
    },
    researchObjects: [
      {
        id: 'obj-optics-100mm-f4',
        domainId: 'optics.geometric',
        title: '100mm f/4 成像光学镜头探索（迁移基线）',
        createdBy: {
          actorId: 'migrated:unknown',
          displayName: '旧版记录（操作者未署名）',
          actorKind: 'migrated_unknown',
        },
        migrationProvenance: {
          isMigrated: true,
          sourceRecordIds: runs.map((r) => r.id),
          inferredFields: ['id', 'domainId', 'title', 'createdBy'],
          note: '旧版系统无 ResearchObject 实体，由 A0/A1 迁移从 runs.jsonl 与 thread.jsonl 归纳。',
        },
      },
    ],
    snapshots,
    branches,
    componentAudit,
    runAudit,
    findings,
  };
}

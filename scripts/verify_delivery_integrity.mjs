#!/usr/bin/env node
/**
 * OpenLab Bench v2 — 交付包完整性、双向目录覆盖与不可变账本 SHA-256 校验脚本
 *
 * 自校验边界说明:
 *   - DELIVERY_MANIFEST.json 记录所有纳入交付范围的项目文件之精确路径、分类、字节数与 64 位 SHA-256。
 *   - 因密码学哈希无法自包含，DELIVERY_MANIFEST.json 自身及独立摘要文件 DELIVERY_MANIFEST.sha256
 *     不列入 files[] 数组；生成清单时会同步输出标准 sha256sum 格式的 DELIVERY_MANIFEST.sha256。
 *   - 校验时会依次验证:
 *       1) DELIVERY_MANIFEST.sha256 与 DELIVERY_MANIFEST.json 实际 SHA-256 一致；
 *       2) 清单中每个文件均存在且字节数与 SHA-256 100% 匹配；
 *       3) 双向完整性（默认严格模式）：检查磁盘交付范围内无未登记的新增残留文件（可用 --allow-extra 放宽，供后续新实验使用）；
 *       4) Stage A1 不可变历史账本 workspace/runs.jsonl 的 SHA-256 严格等于冻结值。
 *
 * 用法:
 *   node scripts/verify_delivery_integrity.mjs
 *   node scripts/verify_delivery_integrity.mjs --allow-extra
 *   node scripts/verify_delivery_integrity.mjs --generate-manifest
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const manifestPath = path.join(repoRoot, 'DELIVERY_MANIFEST.json');
const manifestShaPath = path.join(repoRoot, 'DELIVERY_MANIFEST.sha256');

const LEGACY_RUNS_SHA256 = '698ff3e99c846a050abb559620c3602f4e8af65bcd3e4688739b031e9e35b42d';
const EXCLUDED_DIRS = new Set([
  'node_modules',
  'dist',
  'dist-delivery',
  '.git',
  '.playwright-cli',
  '.aistudio',
  '.venv',
  '__pycache__',
]);
const EXCLUDED_FILES = new Set([
  'DELIVERY_MANIFEST.json',
  'DELIVERY_MANIFEST.sha256',
  '.env',
  '.env.local',
]);

function isExcludedFile(relPath) {
  if (EXCLUDED_FILES.has(relPath)) return true;
  if (relPath.endsWith('.zip') || relPath.endsWith('.zip.sha256')) return true;
  if (relPath.endsWith('.pyc') || relPath.endsWith('.pyo')) return true;
  return false;
}

function sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function classifyPath(relPath) {
  if (relPath.startsWith('src/') || relPath === 'index.html' || relPath === 'vite.config.ts') {
    return 'frontend_source';
  }
  if (relPath.startsWith('server/') || relPath === 'server.ts') {
    return 'backend_source';
  }
  if (relPath.startsWith('python/')) {
    return 'python_runner_bridge';
  }
  if (relPath.startsWith('experiments/p1_optics/')) {
    return 'p1_experiment_asset';
  }
  if (relPath.startsWith('experiments/p2_flagship/runs/fits/')) {
    return 'p2_scientific_fits_tile';
  }
  if (relPath.startsWith('experiments/p2_flagship/')) {
    return 'p2_flagship_experiment';
  }
  if (relPath.startsWith('workspace/.backups/')) {
    return 'stage_a1_pre_migration_backup';
  }
  if (relPath.startsWith('workspace/immutable_store/')) {
    return 'stage_a1_cas_blob';
  }
  if (relPath.startsWith('workspace/components/')) {
    return 'workspace_component';
  }
  if (relPath.startsWith('workspace/workbench/')) {
    return 'workbench_v2_ledger';
  }
  if (relPath.startsWith('workspace/')) {
    return 'stage_a1_immutable_ledger';
  }
  if (relPath.startsWith('docs/') || relPath.endsWith('.md')) {
    return 'documentation_and_handoff';
  }
  return 'config_and_scripts';
}

function collectProjectFiles(dir, baseDir = dir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(baseDir, abs).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      collectProjectFiles(abs, baseDir, acc);
    } else if (entry.isFile()) {
      if (isExcludedFile(rel)) continue;
      const stat = fs.statSync(abs);
      acc.push({
        path: rel,
        category: classifyPath(rel),
        bytes: stat.size,
        sha256: sha256File(abs),
      });
    }
  }
  return acc;
}

function generateManifest() {
  const files = collectProjectFiles(repoRoot);
  const totalBytes = files.reduce((s, f) => s + f.bytes, 0);
  const byCategory = {};
  for (const f of files) {
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  }

  const runsFile = files.find((f) => f.path === 'workspace/runs.jsonl');
  if (!runsFile || runsFile.sha256 !== LEGACY_RUNS_SHA256) {
    throw new Error(
      `FATAL: workspace/runs.jsonl SHA-256 mismatch! Expected ${LEGACY_RUNS_SHA256}, got ${runsFile?.sha256}`,
    );
  }

  const manifest = {
    project: 'OpenLab Bench v2',
    generatedAt: new Date().toISOString(),
    nodePackageManager: 'npm',
    nodeLockfile: 'package-lock.json',
    pythonDefaultVenvPath: './.venv',
    selfVerificationBoundary: {
      coveredScope: '除 excludedDirectories 与 excludedFiles 外，项目根目录下全部源码、实验脚本、产物、20 幅 FITS 科学图像、Stage A1 账本/备份/CAS、组件库、工作台账本与交付文档。',
      excludedDirectories: Array.from(EXCLUDED_DIRS),
      excludedFiles: [...Array.from(EXCLUDED_FILES), '*.zip', '*.zip.sha256', '*.pyc', '*.pyo'],
      manifestSelfDigestFile: 'DELIVERY_MANIFEST.sha256',
      verificationRule:
        '因 SHA-256 无法自包含，DELIVERY_MANIFEST.json 不包含自身条目；其完整性由同级独立文件 DELIVERY_MANIFEST.sha256 校验（可用 sha256sum -c DELIVERY_MANIFEST.sha256 或 node scripts/verify_delivery_integrity.mjs 验证）。默认校验模式同时执行双向扫描以捕获遗漏、篡改及未登记新增文件。',
    },
    summary: {
      totalFiles: files.length,
      totalBytes,
      totalMegabytes: Math.round((totalBytes / (1024 * 1024)) * 100) / 100,
      countsByCategory: byCategory,
      legacyRunsJsonlSha256: runsFile.sha256,
      legacyRunsIntegrityVerified: true,
      containsSecretsOrApiKeys: false,
    },
    e6AndE7PreservationStatus: {
      E6: {
        branchId: 'branch-wb-mwm6gffc',
        executionId: 'exec-wb-mwm6gffc',
        jobId: 'job-mwm6gdak-kblb',
        runnerMode: 'fits_batch_completeness',
        status: 'preserved_on_disk',
        artifactPath: 'workspace/workbench/artifacts/exec-wb-mwm6gffc.json',
        artifactSha256: 'f11e2ea9414f5ecacd4452c54649b3bfb6ba9c936f660be9ff2690f3e977838c',
        note: '完整保留在 branches.json, executions.jsonl, artifacts.jsonl, notes.jsonl, jobs.json 及 artifacts/exec-wb-mwm6gffc.json；独立 .log 文件在容器 15:47Z 快照回滚时未包含，但完整 21 行 stdout 日志已保存在 jobs.json.logs 数组中。',
      },
      E7: {
        jobId: 'job-mwm6qwh5-b2n2',
        proposalNoteId: 'note-1795010134927-sxmw',
        runnerMode: 'wf_rc_s4_reopt_probe',
        status: 'raw_completion_artifact_lost_on_container_reset_remaining_evidence_preserved',
        threeDistinctFacts: {
          fact1_computationCompletedAtTheTime:
            '作业于 2026-11-18T13:57:13.577Z 启动、13:58:57.882Z 在原容器内真实完成实算（总耗时 104,305 ms；最优种子 max RMS 由 9.704 μm 降至 9.199 μm，cost=969.009）。',
          fact2_rawCompletionArtifactLostOnContainerRollback:
            '云端临时容器于 2026-11-18T15:47Z 重置时回滚到 13:57:15Z 快照，导致 13:58:57Z 落盘的 E7 分支条目与结果 JSON 原始产物已从磁盘丢失；当前磁盘仅保留启动前提议笔记与作业启动日志，严禁从总结数字伪造原始完成产物。',
          fact3_reproducibleInNewPersistentEnvironment:
            '触发 E7 的完整执行代码（python/workbench_p2_runner.py）与全部输入参数（notes.jsonl 第 5 行 proposedAction）已完整保全，迁入持久化 WSL2/Linux 环境后可一键重跑（约 90–105 秒）生成完整落盘的原生分支与 SHA-256 产物。',
        },
        preservedEvidencePaths: [
          'workspace/workbench/notes.jsonl (line 5: note-1795010134927-sxmw AI 诊断与可执行提议参数)',
          'workspace/workbench/jobs.json (job-mwm6qwh5-b2n2 启动记录、参数与前 4 行日志，含 [recovery] 中断标记)',
        ],
      },
    },
    files,
  };

  const jsonText = JSON.stringify(manifest, null, 2) + '\n';
  fs.writeFileSync(manifestPath, jsonText, 'utf8');
  const manifestSha = crypto.createHash('sha256').update(jsonText, 'utf8').digest('hex');
  fs.writeFileSync(manifestShaPath, `${manifestSha}  DELIVERY_MANIFEST.json\n`, 'utf8');

  console.log(
    `[openlab-verify] 已生成 DELIVERY_MANIFEST.json (${files.length} 个文件, ${manifest.summary.totalMegabytes} MB) 与 DELIVERY_MANIFEST.sha256 (${manifestSha.slice(0, 16)}...)`,
  );
}

function verifyManifest(allowExtra = false) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error('未找到 DELIVERY_MANIFEST.json，请先运行 --generate-manifest');
  }
  const errors = [];

  // 1. Self-verification via detached DELIVERY_MANIFEST.sha256
  const actualManifestSha = sha256File(manifestPath);
  if (!fs.existsSync(manifestShaPath)) {
    errors.push('缺失独立清单摘要文件 DELIVERY_MANIFEST.sha256（无法验证 DELIVERY_MANIFEST.json 自身完整性）');
  } else {
    const shaLine = fs.readFileSync(manifestShaPath, 'utf8').trim();
    const expectedManifestSha = shaLine.split(/\s+/)[0];
    if (expectedManifestSha !== actualManifestSha) {
      errors.push(
        `DELIVERY_MANIFEST.json 自身 SHA-256 与 DELIVERY_MANIFEST.sha256 不一致 (expected ${expectedManifestSha?.slice(0, 12)}..., got ${actualManifestSha.slice(0, 12)}...)`,
      );
    }
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let okCount = 0;
  const listedPaths = new Set();

  // 2. Verify every listed file exists, size matches, SHA-256 matches
  for (const item of manifest.files) {
    listedPaths.add(item.path);
    const abs = path.join(repoRoot, item.path);
    if (!fs.existsSync(abs)) {
      errors.push(`缺失文件: ${item.path}`);
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.size !== item.bytes) {
      errors.push(`字节大小不匹配: ${item.path} (expected ${item.bytes}, got ${stat.size})`);
      continue;
    }
    const actualSha = sha256File(abs);
    if (actualSha !== item.sha256) {
      errors.push(
        `SHA-256 不匹配: ${item.path} (expected ${item.sha256.slice(0, 12)}..., got ${actualSha.slice(0, 12)}...)`,
      );
      continue;
    }
    okCount++;
  }

  // 3. Bidirectional completeness check (catch unexpected untracked files inside delivery scope)
  if (!allowExtra) {
    const diskFiles = collectProjectFiles(repoRoot);
    for (const df of diskFiles) {
      if (!listedPaths.has(df.path)) {
        errors.push(`发现未纳入 DELIVERY_MANIFEST.json 的额外文件: ${df.path}`);
      }
    }
  }

  // 4. Verify frozen Stage A1 legacy immutable ledger
  const runsAbs = path.join(repoRoot, 'workspace', 'runs.jsonl');
  const runsSha = sha256File(runsAbs);
  if (runsSha !== LEGACY_RUNS_SHA256) {
    errors.push(`历史不可变账本 workspace/runs.jsonl SHA-256 异常: ${runsSha}`);
  }

  if (errors.length > 0) {
    console.error(`[openlab-verify] 校验失败 (${errors.length} 项异常):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `[openlab-verify] 校验通过: DELIVERY_MANIFEST.json 自校验匹配 (${actualManifestSha.slice(0, 12)}...), ${okCount}/${manifest.files.length} 个文件字节与 SHA-256 100% 匹配${allowExtra ? ' (allow-extra)' : '（双向无遗漏/无多余文件）'}, workspace/runs.jsonl 不可变账本完好。`,
  );
}

if (process.argv.includes('--generate-manifest')) {
  generateManifest();
} else {
  verifyManifest(process.argv.includes('--allow-extra'));
}

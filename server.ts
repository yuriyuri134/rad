import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import {
  buildArchitectureMap,
  diffArchitectureSnapshots,
} from './src/core/architectureMap.ts';
import { buildSampleFitsBuffer, parseFitsBuffer } from './src/core/fits.ts';
import type {
  ArchitectureMapData,
  CompositionPartRef,
  EffectiveExecutionConfig,
  EvaluationVerdict,
  EvaluatorBinding,
  ExperimentOverrideRecord,
  ExperimentRun,
  OpticalSystemSpec,
  P2RunnerMode,
  SourceOrigin,
  ThreadEntry,
} from './src/core/types.ts';
import { requestAiCritique, requestStudyCollaboration } from './server/ai.ts';
import { recoverInterruptedMigrations } from './server/a1_migrate.ts';
import {
  addArchitectureAnnotation,
  addStudyOpenQuestion,
  adoptStudyBranch,
  appendEpistemicNote,
  cancelAsyncJob,
  createCustomStudy,
  createNewComponent,
  ensureWorkbenchInitialized,
  getAsyncJob,
  inspectCatalogFitsFile,
  listArchitectureAnnotations,
  listAsyncJobs,
  listFitsCatalog,
  listPersistedArchSnapshots,
  listWorkbenchData,
  readArtifactJson,
  savePersistedArchSnapshot,
  startAsyncWorkbenchJob,
} from './server/workbench.ts';
import {
  probePythonEnvironment,
  runComponentSelfCheck,
  runEvaluatorComponent,
  runOptimizerComponent,
  runSolverComponent,
  runStandaloneComponent,
} from './server/runner.ts';
import {
  appendRun,
  appendRunStandaloneAnalysis,
  appendThreadEntry,
  approveComponentVersion,
  computeRunHashes,
  ensureWorkspaceInitialized,
  forkComponentVersion,
  freezeComponentVersion,
  getComponent,
  INITIAL_DOUBLET_SPEC,
  INITIAL_SINGLET_SPEC,
  listComponents,
  listResearchObjects,
  listRuns,
  listThreadEntries,
  restoreFrozenComponentWorkspaceFile,
  saveComponentDraft,
  setActiveComponentVersion,
  updateRunEvaluations,
} from './server/storage.ts';

async function startServer() {
  recoverInterruptedMigrations();
  ensureWorkspaceInitialized();
  ensureWorkbenchInitialized();

  const app = express();
  const PORT = Number(process.env.PORT || 3000);

  app.use(express.json({ limit: '15mb' }));

  app.get('/api/environment', async (_req, res) => {
    try {
      const env = await probePythonEnvironment();
      res.json({
        ...env,
        localGuide: 'README_LOCAL.md',
        pyprojectFile: 'pyproject.toml',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/bootstrap', async (_req, res) => {
    try {
      const components = listComponents();
      const runs = listRuns();
      const thread = listThreadEntries();
      const { runtimeEnv } = await probePythonEnvironment();
      const apiKey = process.env.GEMINI_API_KEY;
      const aiAvailable = Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
      res.json({
        components,
        runs,
        thread,
        presets: {
          singlet: INITIAL_SINGLET_SPEC,
          doublet: INITIAL_DOUBLET_SPEC,
        },
        aiAvailable,
        runtimeEnv,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/workbench/bootstrap', async (_req, res) => {
    try {
      const components = listComponents();
      const runs = listRuns();
      const thread = listThreadEntries();
      const { runtimeEnv } = await probePythonEnvironment();
      const apiKey = process.env.GEMINI_API_KEY;
      const aiAvailable = Boolean(apiKey && apiKey !== 'MY_GEMINI_API_KEY');
      const wb = listWorkbenchData();
      res.json({
        ...wb,
        components,
        runs,
        thread,
        presets: {
          singlet: INITIAL_SINGLET_SPEC,
          doublet: INITIAL_DOUBLET_SPEC,
        },
        aiAvailable,
        runtimeEnv,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/studies', (req, res) => {
    try {
      const { title, domain, problemStatement, backgroundContext, initialHypothesis } = req.body as {
        title: string;
        domain?: string;
        problemStatement: string;
        backgroundContext?: string;
        initialHypothesis?: string;
      };
      const created = createCustomStudy({
        title,
        domain,
        problemStatement,
        backgroundContext,
        initialHypothesis,
      });
      res.json(created);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/studies/:id/branches/:branchId/adopt', (req, res) => {
    try {
      const { reason } = (req.body ?? {}) as { reason?: string };
      const result = adoptStudyBranch(req.params.id, req.params.branchId, reason);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/studies/:id/open-questions', (req, res) => {
    try {
      const { question } = req.body as { question: string };
      if (!question?.trim()) {
        res.status(400).json({ error: '开放问题不能为空' });
        return;
      }
      const created = addStudyOpenQuestion(req.params.id, question);
      res.json({ openQuestion: created });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/notes', (req, res) => {
    try {
      const { studyId, branchId, tag, authorLabel, title, content, evidenceRefs } = req.body as {
        studyId: string;
        branchId?: string | null;
        tag?: 'fact' | 'judgment' | 'hypothesis' | 'proposal';
        authorLabel?: string;
        title: string;
        content: string;
        evidenceRefs?: string[];
      };
      if (!content?.trim()) {
        res.status(400).json({ error: '记录内容不能为空' });
        return;
      }
      const note = appendEpistemicNote({
        studyId: studyId || 'study-wf-rc-1000',
        branchId: branchId ?? null,
        tag: tag ?? 'judgment',
        authorType: 'human',
        authorLabel: authorLabel?.trim() || 'Rad / 研究记录',
        title: title?.trim() || '研究者记录',
        content: content.trim(),
        evidenceRefs: Array.isArray(evidenceRefs) ? evidenceRefs : [],
      });
      res.json({ note });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/jobs/start', (req, res) => {
    try {
      const {
        studyId,
        parentBranchId,
        runnerMode,
        title,
        intent,
        branchName,
        hypothesis,
        parameters,
        timeoutMs,
      } = req.body as {
        studyId: string;
        parentBranchId: string;
        runnerMode: P2RunnerMode;
        title: string;
        intent: string;
        branchName: string;
        hypothesis: string;
        parameters: Record<string, unknown>;
        timeoutMs?: number;
      };
      const allowedModes: P2RunnerMode[] = [
        'wf_rc_perturb_eval',
        'fits_star_extract',
        'fits_batch_completeness',
        'wf_rc_s4_reopt_probe',
      ];
      if (!allowedModes.includes(runnerMode)) {
        res.status(400).json({ error: `不支持的运行器模式: ${String(runnerMode)}` });
        return;
      }
      const job = startAsyncWorkbenchJob({
        studyId,
        parentBranchId,
        runnerMode,
        title,
        intent,
        branchName,
        hypothesis,
        parameters: parameters ?? {},
        timeoutMs,
      });
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/jobs', (_req, res) => {
    try {
      res.json({ jobs: listAsyncJobs() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/jobs/:id', (req, res) => {
    try {
      const job = getAsyncJob(req.params.id);
      if (!job) {
        res.status(404).json({ error: `未找到任务 ${req.params.id}` });
        return;
      }
      res.json({ job });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/jobs/:id/cancel', (req, res) => {
    try {
      const job = cancelAsyncJob(req.params.id);
      if (!job) {
        res.status(404).json({ error: `未找到任务 ${req.params.id}` });
        return;
      }
      res.json({ job });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/fits/catalog', (_req, res) => {
    try {
      res.json({ catalog: listFitsCatalog() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/fits/sample', (_req, res) => {
    try {
      const buf = buildSampleFitsBuffer();
      const analysis = parseFitsBuffer(buf, 'M42_CALIB_SAMPLE.fits');
      res.json({ analysis });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/fits/inspect', (req, res) => {
    try {
      const relPath = String(req.query.path ?? '');
      if (!relPath) {
        res.status(400).json({ error: '缺少查询参数 path' });
        return;
      }
      const analysis = inspectCatalogFitsFile(relPath);
      res.json({ analysis });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/fits/inspect-artifact', (req, res) => {
    try {
      const artifactId = String(req.query.artifactId ?? '');
      if (!artifactId) {
        res.status(400).json({ error: '缺少查询参数 artifactId' });
        return;
      }
      const payload = readArtifactJson(artifactId);
      res.json(payload);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post(
    '/api/fits/upload-raw',
    express.raw({ type: 'application/octet-stream', limit: '25mb' }),
    (req, res) => {
      try {
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.byteLength < 2880) {
          res.status(400).json({ error: '未接收到有效的 FITS 二进制数据流' });
          return;
        }
        const rawName = String(req.headers['x-fits-filename'] || 'uploaded.fits');
        const fileName = decodeURIComponent(rawName);
        const analysis = parseFitsBuffer(new Uint8Array(body), fileName);
        res.json({ analysis });
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post('/api/components/create', (req, res) => {
    try {
      const { id, name, kind, runtime, summary, purpose, capabilityBoundary, codeContent } = req.body as {
        id: string;
        name: string;
        kind: string;
        runtime: 'local_process_mjs' | 'local_process_py';
        summary: string;
        purpose: string;
        capabilityBoundary?: string;
        codeContent: string;
      };
      const dossier = createNewComponent({
        id,
        name,
        kind,
        runtime,
        summary,
        purpose,
        capabilityBoundary,
        codeContent,
      });
      res.json({ dossier, components: listComponents() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/ai/collaborate', async (req, res) => {
    try {
      const { studyId, question } = req.body as { studyId?: string; question: string };
      if (!question?.trim()) {
        res.status(400).json({ error: '请输入需要研判或建议的研究问题' });
        return;
      }
      const wb = listWorkbenchData();
      const study = wb.studies.find((s) => s.id === (studyId || 'study-wf-rc-1000')) ?? wb.studies[0];
      if (!study) {
        res.status(404).json({ error: '未找到目标研究课题' });
        return;
      }
      const studyBranches = wb.branches.filter((b) => b.studyId === study.id);
      const studyExecs = wb.executions.filter((e) => e.studyId === study.id);
      const studyNotes = wb.notes.filter((n) => n.studyId === study.id);

      const collab = await requestStudyCollaboration({
        study,
        branches: studyBranches,
        executions: studyExecs,
        notes: studyNotes,
        fitsCatalog: wb.fitsCatalog,
        question: question.trim(),
      });

      const note = appendEpistemicNote({
        studyId: study.id,
        branchId: study.adoptedBranchId,
        tag: collab.tag,
        authorType: collab.analyzerKind,
        authorLabel:
          collab.analyzerKind === 'ai_llm'
            ? 'AI 协作者 (Gemini + 实证约束)'
            : '确定性实证协作者 (Empirical Analyzer)',
        title: collab.title,
        content: [
          collab.content,
          collab.unverifiedAssumptions.length
            ? `未验证假设：${collab.unverifiedAssumptions.join('；')}`
            : '',
        ]
          .filter(Boolean)
          .join('\n'),
        evidenceRefs: collab.evidenceRefs,
        proposedAction: collab.proposedAction,
      });

      res.json({ collab, note });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/architecture-map', async (_req, res) => {
    try {
      const { runtimeEnv } = await probePythonEnvironment();
      const wb = listWorkbenchData();
      const map = buildArchitectureMap({
        rootDir: process.cwd(),
        components: listComponents(),
        runs: listRuns(),
        runtimeEnv,
        studies: wb.studies,
        branches: wb.branches,
        executions: wb.executions,
        artifacts: wb.artifacts,
        annotations: wb.annotations,
        pythonEnvDetails: {
          executable: wb.pythonRuntime.executable,
          packages: wb.pythonRuntime.packages,
        },
      });
      res.json(map);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/architecture-snapshots', (_req, res) => {
    try {
      res.json({ snapshots: listPersistedArchSnapshots(), annotations: listArchitectureAnnotations() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/architecture-snapshots', async (req, res) => {
    try {
      const { reason } = (req.body ?? {}) as { reason?: string };
      const { runtimeEnv } = await probePythonEnvironment();
      const wb = listWorkbenchData();
      const map = buildArchitectureMap({
        rootDir: process.cwd(),
        components: listComponents(),
        runs: listRuns(),
        runtimeEnv,
        studies: wb.studies,
        branches: wb.branches,
        executions: wb.executions,
        artifacts: wb.artifacts,
        annotations: wb.annotations,
        pythonEnvDetails: {
          executable: wb.pythonRuntime.executable,
          packages: wb.pythonRuntime.packages,
        },
      });
      const snapshot = savePersistedArchSnapshot(reason || '工作台人工留存结构快照', map);
      res.json({ snapshot, snapshots: listPersistedArchSnapshots() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/architecture-annotations', (req, res) => {
    try {
      const { nodeId, author, tag, note } = req.body as {
        nodeId: string;
        author?: string;
        tag?: 'fact' | 'judgment' | 'hypothesis' | 'proposal';
        note: string;
      };
      const annotation = addArchitectureAnnotation({ nodeId, author, tag, note });
      res.json({ annotation, annotations: listArchitectureAnnotations() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/architecture-map/snapshot-diff', async (req, res) => {
    try {
      const { beforeSnapshot } = req.body as { beforeSnapshot: ArchitectureMapData };
      if (!beforeSnapshot || !Array.isArray(beforeSnapshot.nodes)) {
        res.status(400).json({ error: '缺少有效的基线快照 beforeSnapshot' });
        return;
      }
      const { runtimeEnv } = await probePythonEnvironment();
      const wb = listWorkbenchData();
      const afterSnapshot = buildArchitectureMap({
        rootDir: process.cwd(),
        components: listComponents(),
        runs: listRuns(),
        runtimeEnv,
        studies: wb.studies,
        branches: wb.branches,
        executions: wb.executions,
        artifacts: wb.artifacts,
        annotations: wb.annotations,
        pythonEnvDetails: {
          executable: wb.pythonRuntime.executable,
          packages: wb.pythonRuntime.packages,
        },
      });
      const diff = diffArchitectureSnapshots(beforeSnapshot, afterSnapshot);
      res.json({ afterSnapshot, diff });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get('/api/components/:id', (req, res) => {
    try {
      const found = getComponent(req.params.id);
      if (!found) {
        res.status(404).json({ error: `未找到组件 ${req.params.id}` });
        return;
      }
      res.json(found);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/components/:id/fork', (req, res) => {
    try {
      const { baseVersion, newVersion, changeSummary, codeContent, updatedParams } = req.body as {
        baseVersion: string;
        newVersion: string;
        changeSummary: string;
        codeContent: string;
        updatedParams: Record<string, number | string | boolean>;
      };
      const dossier = forkComponentVersion({
        componentId: req.params.id,
        baseVersion,
        newVersion,
        changeSummary,
        codeContent,
        updatedParams: updatedParams ?? {},
      });
      const updated = getComponent(dossier.id);
      appendThreadEntry({
        id: `note-${Date.now()}`,
        createdAt: new Date().toISOString(),
        origin: 'adopted_decision',
        authorLabel: 'Rad / 组件演化',
        runId: null,
        componentId: dossier.id,
        title: `派生组件版本：${dossier.name} (${baseVersion} → ${newVersion})`,
        content: changeSummary || `基于 ${baseVersion} 创建并修改了新版本 ${newVersion}`,
      });
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/components/:id/draft', (req, res) => {
    try {
      const { version, codeContent, updatedParams, changeSummary } = req.body as {
        version: string;
        codeContent?: string;
        updatedParams?: Record<string, number | string | boolean>;
        changeSummary?: string;
      };
      saveComponentDraft({
        componentId: req.params.id,
        version,
        codeContent,
        updatedParams,
        changeSummary,
      });
      res.json(getComponent(req.params.id));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/components/:id/approve', (req, res) => {
    try {
      const { version, reviewer } = req.body as { version: string; reviewer?: string };
      const dossier = approveComponentVersion(req.params.id, version, reviewer || 'rad');
      res.json(getComponent(dossier.id));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/components/:id/activate', (req, res) => {
    try {
      const { version } = req.body as { version: string };
      const dossier = setActiveComponentVersion(req.params.id, version);
      res.json(getComponent(dossier.id));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/components/:id/restore-frozen', (req, res) => {
    try {
      const { version, preserveWorkspaceEditAsDraft, newDraftVersion } = req.body as {
        version: string;
        preserveWorkspaceEditAsDraft?: boolean;
        newDraftVersion?: string;
      };
      const restored = restoreFrozenComponentWorkspaceFile(req.params.id, version, {
        preserveWorkspaceEditAsDraft,
        newDraftVersion,
      });
      res.json({
        ...restored,
        component: getComponent(req.params.id),
      });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/components/:id/check', async (req, res) => {
    try {
      const { version } = (req.body ?? {}) as { version?: string };
      const { dossier, checkOutput } = await runComponentSelfCheck(req.params.id, version);
      res.json({ dossier, checkOutput, components: listComponents() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/components/:id/run-standalone', async (req, res) => {
    try {
      const { version, overrideParams, runId, spec, customInput } = (req.body ?? {}) as {
        version?: string;
        overrideParams?: Record<string, number | string | boolean>;
        runId?: string;
        spec?: OpticalSystemSpec;
        customInput?: unknown;
      };

      let targetRun = runId ? listRuns().find((r) => r.id === runId) : undefined;
      if (runId && !targetRun) {
        res.status(404).json({ error: `未找到历史运行 ${runId}` });
        return;
      }

      const result = await runStandaloneComponent({
        componentId: req.params.id,
        version,
        overrideParams,
        rawArtifacts: targetRun?.rawArtifactsAfter,
        spec: spec ?? targetRun?.systemAfter,
        customInput,
      });

      let updatedRun = targetRun ?? null;
      if (targetRun) {
        updatedRun = appendRunStandaloneAnalysis(
          targetRun.id,
          {
            id: `sa-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            componentId: result.componentId,
            componentName: result.componentName,
            version: result.version,
            codeHash: result.codeHash,
            ranAt: new Date().toISOString(),
            paramsSnapshot: overrideParams,
            output: result.output,
          },
          { actorId: 'human:rad', displayName: 'Rad', actorKind: 'human' },
        );
        appendThreadEntry({
          id: `note-${Date.now()}`,
          createdAt: new Date().toISOString(),
          origin: 'experiment_run',
          authorLabel: `${result.componentName}@${result.version}`,
          runId: targetRun.id,
          componentId: result.componentId,
          title: `独立运行组件 [${result.componentName}] 分析 Run #${targetRun.sequenceNumber}`,
          content: JSON.stringify(result.output),
        });
      }

      res.json({ result, updatedRun, components: listComponents() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/experiments/run', async (req, res) => {
    const startMs = Date.now();
    try {
      const {
        intent,
        branchLabel,
        parentRunId,
        baseSnapshotId,
        researchObjectId,
        branchId,
        mode,
        seed,
        systemSpec,
        solverId,
        evaluatorId,
        evaluatorVersion,
        evaluatorParams,
        optimizerId,
        optimizerVersion,
        optimizerParams,
      } = req.body as {
        intent: string;
        branchLabel?: string;
        parentRunId?: string | null;
        baseSnapshotId?: string | null;
        researchObjectId?: string | null;
        branchId?: string | null;
        mode: 'solve_only' | 'optimize';
        seed?: number;
        systemSpec: OpticalSystemSpec;
        solverId?: string;
        evaluatorId: string;
        evaluatorVersion?: string;
        evaluatorParams?: Record<string, number | string | boolean>;
        optimizerId?: string;
        optimizerVersion?: string;
        optimizerParams?: Record<string, number | string | boolean>;
      };

      if (!systemSpec || !Array.isArray(systemSpec.surfaces) || systemSpec.surfaces.length === 0) {
        res.status(400).json({ error: '缺少有效的光学表面序列 systemSpec.surfaces' });
        return;
      }

      const activeSolverId = solverId || 'solver-ts-preview';
      const activeEvalId = evaluatorId || 'eval-rms-spot';
      const activeOptId = optimizerId || 'opt-coordinate-refine';
      const numericSeed = Number.isFinite(Number(seed)) ? Number(seed) : 42;

      const { runtimeEnv } = await probePythonEnvironment();
      const existingRuns = listRuns();
      const seq = existingRuns.length + 1;
      const runId = `run-${String(seq).padStart(3, '0')}`;
      const createdAt = new Date().toISOString();

      const beforeSolve = await runSolverComponent(activeSolverId, systemSpec);
      const rawArtifactsBefore = beforeSolve.result;

      let systemAfter = systemSpec;
      let rawArtifactsAfter = rawArtifactsBefore;
      let optimizationTrace: ExperimentRun['optimizationTrace'] = [];
      const parts: CompositionPartRef[] = [];
      let verdict: EvaluationVerdict;
      const overrides: ExperimentOverrideRecord[] = [];

      if (mode === 'optimize') {
        const optComp = getComponent(activeOptId);
        const optBaseVer = optComp?.dossier.versions.find(
          (v) => v.version === (optimizerVersion || optComp.dossier.activeVersion),
        );
        for (const [k, val] of Object.entries(optimizerParams ?? {})) {
          if (optBaseVer?.params?.[k] !== val) {
            overrides.push({
              targetScope: 'optimizer',
              componentId: activeOptId,
              key: k,
              baseValue: optBaseVer?.params?.[k],
              overrideValue: val,
            });
          }
        }
        const evalComp = getComponent(activeEvalId);
        const evalBaseVer = evalComp?.dossier.versions.find(
          (v) => v.version === (evaluatorVersion || evalComp.dossier.activeVersion),
        );
        for (const [k, val] of Object.entries(evaluatorParams ?? {})) {
          if (evalBaseVer?.params?.[k] !== val) {
            overrides.push({
              targetScope: 'evaluator',
              componentId: activeEvalId,
              key: k,
              baseValue: evalBaseVer?.params?.[k],
              overrideValue: val,
            });
          }
        }

        const optOut = await runOptimizerComponent({
          optimizerId: activeOptId,
          optimizerVersion,
          overrideOptimizerParams: optimizerParams,
          evaluatorId: activeEvalId,
          evaluatorVersion,
          overrideEvaluatorParams: evaluatorParams,
          solverId: activeSolverId,
          initialSpec: systemSpec,
        });
        systemAfter = optOut.bestSpec;
        rawArtifactsAfter = optOut.bestTrace;
        verdict = optOut.bestEval;
        optimizationTrace = optOut.history;
        parts.push(
          {
            slot: 'optical_solver',
            componentId: optOut.solverMeta.id,
            componentName: optOut.solverMeta.name,
            kind: 'optical_solver',
            version: optOut.solverMeta.version,
            codeHash: optOut.solverMeta.codeHash,
            paramsSnapshot: {},
          },
          {
            slot: 'optimizer',
            componentId: optOut.optimizerMeta.id,
            componentName: optOut.optimizerMeta.name,
            kind: 'optimizer',
            version: optOut.optimizerMeta.version,
            codeHash: optOut.optimizerMeta.codeHash,
            paramsSnapshot: optOut.optimizerMeta.params,
          },
          {
            slot: 'evaluator',
            componentId: optOut.evaluatorMeta.id,
            componentName: optOut.evaluatorMeta.name,
            kind: 'evaluator',
            version: optOut.evaluatorMeta.version,
            codeHash: optOut.evaluatorMeta.codeHash,
            paramsSnapshot: optOut.evaluatorMeta.params,
          },
        );
      } else {
        verdict = await runEvaluatorComponent({
          evaluatorId: activeEvalId,
          evaluatorVersion,
          overrideParams: evaluatorParams,
          rawArtifacts: rawArtifactsAfter,
          spec: systemAfter,
        });
        const evalComp = getComponent(activeEvalId);
        const usedVer = evalComp?.dossier.versions.find((v) => v.version === verdict.evaluatorVersion);
        for (const [k, val] of Object.entries(evaluatorParams ?? {})) {
          if (usedVer?.params?.[k] !== val) {
            overrides.push({
              targetScope: 'evaluator',
              componentId: activeEvalId,
              key: k,
              baseValue: usedVer?.params?.[k],
              overrideValue: val,
            });
          }
        }
        parts.push(
          {
            slot: 'optical_solver',
            componentId: beforeSolve.solverMeta.id,
            componentName: beforeSolve.solverMeta.name,
            kind: 'optical_solver',
            version: beforeSolve.solverMeta.version,
            codeHash: beforeSolve.solverMeta.codeHash,
            paramsSnapshot: {},
          },
          {
            slot: 'evaluator',
            componentId: verdict.evaluatorId,
            componentName: verdict.evaluatorName,
            kind: 'evaluator',
            version: verdict.evaluatorVersion,
            codeHash: verdict.evaluatorCodeHash,
            paramsSnapshot: { ...(usedVer?.params ?? {}), ...(evaluatorParams ?? {}) },
          },
        );
      }

      const composition: ExperimentRun['composition'] = {
        pattern: mode === 'optimize' ? 'solve_optimize_evaluate' : 'solve_and_evaluate',
        parts,
      };
      const branchText = branchLabel?.trim() || `分支 #${seq}`;
      const intentText = intent?.trim() || (mode === 'optimize' ? '优化当前光学参数' : '直接光学求解验证');

      const roList = listResearchObjects();
      const resolvedResearchObj = researchObjectId
        ? roList.find((r) => r.id === researchObjectId)
        : roList[0];
      const evalPart = parts.find((p) => p.slot === 'evaluator');
      const evaluatorBindings: EvaluatorBinding[] = evalPart
        ? [
            {
              bindingId: `bind-${runId}-${evalPart.componentId}`,
              evaluatorId: evalPart.componentId,
              evaluatorVersion: evalPart.version,
              evaluatorCodeHash: evalPart.codeHash,
              paramsSnapshot: evalPart.paramsSnapshot,
              criterionIds: (resolvedResearchObj?.criteria ?? []).map((c) => c.id),
              coverageNote: '实验主评价器绑定',
              sourceAvailability: 'available_on_disk',
            },
          ]
        : [];
      const effectiveConfig: EffectiveExecutionConfig = {
        effectiveSystemSpec: systemSpec,
        effectiveParts: parts,
        overrides,
        evaluationPolicy: {
          researchObjectId: resolvedResearchObj?.id ?? researchObjectId ?? null,
          policyVersion: 'v1.1',
          objectives: resolvedResearchObj?.objectives ?? [],
          criteria: resolvedResearchObj?.criteria ?? [],
          evaluatorBindings,
        },
        executor: {
          actorId: 'human:rad',
          displayName: 'Rad',
          actorKind: 'human',
        },
      };

      const hashes = computeRunHashes({
        id: runId,
        sequenceNumber: seq,
        createdAt,
        parentRunId: parentRunId ?? null,
        branchLabel: branchText,
        intent: intentText,
        mode,
        seed: numericSeed,
        runtimeEnv,
        composition,
        baseSnapshotId: baseSnapshotId ?? null,
        researchObjectId: resolvedResearchObj?.id ?? researchObjectId ?? null,
        branchId: branchId ?? null,
        effectiveConfig,
        systemBefore: systemSpec,
        systemAfter,
        rawArtifactsBefore,
        rawArtifactsAfter,
      });

      const run: ExperimentRun = {
        id: runId,
        sequenceNumber: seq,
        createdAt,
        parentRunId: parentRunId ?? null,
        branchLabel: branchText,
        intent: intentText,
        mode,
        seed: numericSeed,
        runtimeEnv,
        composition,
        baseSnapshotId: baseSnapshotId ?? null,
        researchObjectId: resolvedResearchObj?.id ?? researchObjectId ?? null,
        branchId: branchId ?? null,
        effectiveConfig,
        candidateStatus: 'unadopted',
        systemBefore: systemSpec,
        systemAfter,
        rawArtifactsBefore,
        rawArtifactsAfter,
        optimizationTrace,
        evaluations: [verdict],
        ...hashes,
        tamperStatus: 'verified',
        executionMs: Math.max(1, Date.now() - startMs),
        status: 'completed',
      };

      appendRun(run);
      for (const p of parts) {
        freezeComponentVersion(p.componentId, p.version, { runId: run.id });
      }
      const entry: ThreadEntry = {
        id: `note-${Date.now()}`,
        createdAt: new Date().toISOString(),
        origin: 'experiment_run',
        authorLabel: `实验运行 · Run #${seq}`,
        runId: run.id,
        componentId: mode === 'optimize' ? activeOptId : activeSolverId,
        title: `${run.branchLabel}（${mode === 'optimize' ? '优化运行' : '直接求解'} · ${beforeSolve.solverMeta.id}）`,
        content: `意图：${run.intent}。计算引擎 [${beforeSolve.solverMeta.name}]：EFL=${rawArtifactsAfter.paraxialEflMm}mm，RMS 光斑=${rawArtifactsAfter.rmsSpotRadiusUm}μm，F-C 色差=${rawArtifactsAfter.axialChromaticShiftMm}mm，MTF@30=${rawArtifactsAfter.mtf30LpMm}。评价组件 [${verdict.evaluatorName}@${verdict.evaluatorVersion}] 判定：${verdict.status.toUpperCase()}（${verdict.summary}）。`,
      };
      appendThreadEntry(entry);

      res.json({ run, entry, components: listComponents(), runtimeEnv });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/experiments/:id/reevaluate', async (req, res) => {
    try {
      const { evaluatorId, evaluatorVersion, evaluatorParams } = req.body as {
        evaluatorId: string;
        evaluatorVersion?: string;
        evaluatorParams?: Record<string, number | string | boolean>;
      };
      const runs = listRuns();
      const target = runs.find((r) => r.id === req.params.id);
      if (!target) {
        res.status(404).json({ error: `未找到实验 ${req.params.id}` });
        return;
      }

      const verdict = await runEvaluatorComponent({
        evaluatorId,
        evaluatorVersion,
        overrideParams: evaluatorParams,
        rawArtifacts: target.rawArtifactsAfter,
        spec: target.systemAfter,
      });

      const updatedRun = updateRunEvaluations(target.id, verdict);
      const prevVerdict = target.evaluations[0];
      const flipped = prevVerdict && prevVerdict.passed !== verdict.passed;

      const entry: ThreadEntry = {
        id: `note-${Date.now()}`,
        createdAt: new Date().toISOString(),
        origin: 'evaluator_verdict',
        authorLabel: `${verdict.evaluatorName}@${verdict.evaluatorVersion}`,
        runId: target.id,
        componentId: verdict.evaluatorId,
        title:
          verdict.status === 'insufficient_artifacts'
            ? `拒绝推测：Run #${target.sequenceNumber} 原始产物缺少字段，无法评价`
            : flipped
              ? `结论翻转：Run #${target.sequenceNumber} 在新评价器下由 ${prevVerdict.status.toUpperCase()} 变为 ${verdict.status.toUpperCase()}`
              : `对 Run #${target.sequenceNumber} 执行非破坏性重评：${verdict.status.toUpperCase()}`,
        content: `${verdict.summary}（已保存原始计算产物未修改，SHA-256=${target.rawArtifactsHash.slice(0, 12)}...）`,
      };
      appendThreadEntry(entry);

      res.json({ run: updatedRun, verdict, entry });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/thread', (req, res) => {
    try {
      const { origin, authorLabel, title, content, runId, componentId } = req.body as {
        origin: SourceOrigin;
        authorLabel?: string;
        title: string;
        content: string;
        runId?: string | null;
        componentId?: string | null;
      };
      if (!content?.trim()) {
        res.status(400).json({ error: '记录内容不能为空' });
        return;
      }
      const entry: ThreadEntry = {
        id: `note-${Date.now()}`,
        createdAt: new Date().toISOString(),
        origin: origin || 'user_statement',
        authorLabel: authorLabel || 'Rad / 研究记录',
        runId: runId ?? null,
        componentId: componentId ?? null,
        title: title?.trim() || '人工记录',
        content: content.trim(),
      };
      appendThreadEntry(entry);
      res.json({ entry });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/ai/critique', async (req, res) => {
    try {
      const { question } = req.body as { question: string };
      if (!question?.trim()) {
        res.status(400).json({ error: '请输入需要 AI 分析或质疑的问题' });
        return;
      }
      const runs = listRuns();
      const components = listComponents();
      const recentThread = listThreadEntries();
      const { runtimeEnv } = await probePythonEnvironment();
      const map = buildArchitectureMap({
        rootDir: process.cwd(),
        components,
        runs,
        runtimeEnv,
      });

      const critique = await requestAiCritique({
        question: question.trim(),
        runs,
        components,
        recentThread,
        anomalies: map.anomalies,
      });

      const entry: ThreadEntry = {
        id: `note-${Date.now()}`,
        createdAt: new Date().toISOString(),
        origin: 'ai_hypothesis',
        authorLabel: 'AI 协作者（待实证检验）',
        runId: runs[runs.length - 1]?.id ?? null,
        componentId: null,
        title: `AI 对「${question.trim().slice(0, 32)}」的反例与假设分析`,
        content: [
          `观察：${critique.observation}`,
          critique.unverifiedAssumptions.length
            ? `未验证假设：${critique.unverifiedAssumptions.join('；')}`
            : '',
          critique.counterexample ? `反例与冲突：${critique.counterexample}` : '',
          critique.suggestedExperiment ? `建议下一步实验：${critique.suggestedExperiment}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      };
      appendThreadEntry(entry);
      res.json({ critique, entry });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`OpenLab Bench running at http://localhost:${PORT}`);
  });
}

startServer();

import { useCallback, useEffect, useState } from 'react';
import type {
  ArtifactRef,
  AsyncJobRecord,
  ComponentDossier,
  EpistemicNote,
  EpistemicTag,
  ExperimentRun,
  FitsCatalogEntry,
  FitsSourceDetection,
  OpticalSystemSpec,
  P2RunnerMode,
  ResearchStudy,
  RuntimeEnvironmentSnapshot,
  SourceOrigin,
  StudyBranch,
  ThreadEntry,
  WorkflowExecution,
} from './core/types.ts';
import { TopBar, type WorkspaceTab } from './components/TopBar.tsx';
import { ResearchStudio, type DiscoveredPythonRuntime } from './components/ResearchStudio.tsx';
import { ArtifactsAndCompareView, type CompareSubTab } from './components/ArtifactsAndCompareView.tsx';
import { ComponentLibrary } from './components/ComponentLibrary.tsx';
import { ArchitectureMapView } from './components/ArchitectureMapView.tsx';
import {
  ResearchArtifacts, ResearchComponentContract, ResearchExecutionDialog, ResearchObservedMap,
  ResearchRunControls, researchFetch, type ResearchState,
} from './components/ResearchExecutionView.tsx';

interface WorkbenchBootstrapPayload {
  studies: ResearchStudy[];
  branches: StudyBranch[];
  executions: WorkflowExecution[];
  artifacts: ArtifactRef[];
  notes: EpistemicNote[];
  jobs: AsyncJobRecord[];
  fitsCatalog: FitsCatalogEntry[];
  pythonRuntime: DiscoveredPythonRuntime;
  components: ComponentDossier[];
  runs: ExperimentRun[];
  thread: ThreadEntry[];
  presets: {
    singlet: OpticalSystemSpec;
    doublet: OpticalSystemSpec;
  };
  aiAvailable: boolean;
  runtimeEnv: RuntimeEnvironmentSnapshot;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('experiment');
  const [compareSubTab, setCompareSubTab] = useState<CompareSubTab>('matrix');
  const [selectedFitsPath, setSelectedFitsPath] = useState<string | null>(null);
  const [research, setResearch] = useState<ResearchState>({ artifacts: [], executions: [], recipeRuns: [] });
  const [researchError, setResearchError] = useState('');
  const [openExecutionId, setOpenExecutionId] = useState('');
  const [researchArtifactId, setResearchArtifactId] = useState('');

  const refreshResearch = useCallback(async () => {
    try {
      setResearch(await researchFetch<ResearchState>('/api/research/state'));
      setResearchError('');
    } catch (error) {
      setResearchError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const researchRunning = research.recipeRuns.some((run) => run.status === 'running') ||
    research.executions.some((run) => run.status === 'running');
  useEffect(() => { void refreshResearch(); }, [refreshResearch, activeTab]);
  useEffect(() => {
    if (!researchRunning) return;
    const timer = window.setInterval(() => { void refreshResearch(); }, 1600);
    return () => window.clearInterval(timer);
  }, [researchRunning, refreshResearch]);

  const inspectResearchArtifact = (id: string) => {
    setResearchArtifactId(id);
    setActiveTab('compare');
  };

  // V2 Study & Execution state
  const [studies, setStudies] = useState<ResearchStudy[]>([]);
  const [selectedStudyId, setSelectedStudyId] = useState<string>('study-wf-rc-1000');
  const [branches, setBranches] = useState<StudyBranch[]>([]);
  const [executions, setExecutions] = useState<WorkflowExecution[]>([]);
  const [artifacts, setArtifacts] = useState<ArtifactRef[]>([]);
  const [notes, setNotes] = useState<EpistemicNote[]>([]);
  const [jobs, setJobs] = useState<AsyncJobRecord[]>([]);
  const [activeJob, setActiveJob] = useState<AsyncJobRecord | null>(null);
  const [fitsCatalog, setFitsCatalog] = useState<FitsCatalogEntry[]>([]);
  const [pythonRuntime, setPythonRuntime] = useState<DiscoveredPythonRuntime | null>(null);
  const [pythonFitsResult, setPythonFitsResult] = useState<{
    extractor: string;
    fitsPath: string;
    detectedSources: FitsSourceDetection[];
    medianSkyAdu?: number;
    skyNoiseSigmaAdu?: number;
    medianFwhmPx?: number | null;
    medianFwhmArcsec?: number | null;
  } | null>(null);

  // Legacy P1 state (preserved read/append compatible)
  const [components, setComponents] = useState<ComponentDossier[]>([]);
  const [runs, setRuns] = useState<ExperimentRun[]>([]);
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [presets, setPresets] = useState<WorkbenchBootstrapPayload['presets'] | null>(null);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [runtimeEnv, setRuntimeEnv] = useState<RuntimeEnvironmentSnapshot | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [systemSpec, setSystemSpec] = useState<OpticalSystemSpec | null>(null);
  const [specEpoch, setSpecEpoch] = useState(0);
  const [selectedSolverId, setSelectedSolverId] = useState('solver-ts-preview');
  const [selectedOptimizerId, setSelectedOptimizerId] = useState('opt-coordinate-refine');
  const [selectedEvaluatorId, setSelectedEvaluatorId] = useState('eval-rms-spot');
  const [runMode, setRunMode] = useState<'solve_only' | 'optimize'>('optimize');
  const [seed, setSeed] = useState<number>(42);
  const [intentText, setIntentText] = useState(
    '用当前优化策略与评价标准调整曲率半径，观察光斑与焦距变化',
  );
  const [branchLabel, setBranchLabel] = useState('主线优化尝试');
  const [isP1Running, setIsP1Running] = useState(false);
  const [p1RunError, setP1RunError] = useState<string | null>(null);

  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
  const [archFocusNodeId, setArchFocusNodeId] = useState<string | null>(null);

  const handleUpdateSystemSpec = (next: OpticalSystemSpec) => {
    setSpecEpoch((e) => e + 1);
    setSystemSpec(next);
  };

  const fetchBootstrap = useCallback(async () => {
    try {
      const res = await fetch('/api/workbench/bootstrap');
      const data = (await res.json()) as WorkbenchBootstrapPayload & { error?: string };
      if (!res.ok) throw new Error(data.error || '加载开放科研工作台失败');

      setStudies(data.studies);
      setBranches(data.branches);
      setExecutions(data.executions);
      setArtifacts(data.artifacts);
      setNotes(data.notes);
      setJobs(data.jobs);
      setFitsCatalog(data.fitsCatalog);
      setPythonRuntime(data.pythonRuntime);

      setSelectedStudyId((prev) =>
        data.studies.some((s) => s.id === prev)
          ? prev
          : data.studies.find((s) => s.id === 'study-wf-rc-1000')?.id ?? data.studies[0]?.id ?? '',
      );

      setComponents(data.components);
      setRuns(data.runs);
      setThread(data.thread);
      setPresets(data.presets);
      setAiAvailable(data.aiAvailable);
      setRuntimeEnv(data.runtimeEnv);
      setSystemSpec(
        (prev) => prev ?? data.runs[data.runs.length - 1]?.systemAfter ?? data.presets.singlet,
      );
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchBootstrap();
  }, [fetchBootstrap]);

  // Poll running async Python jobs
  useEffect(() => {
    if (!activeJob || (activeJob.status !== 'running' && activeJob.status !== 'queued')) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(activeJob.id)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { job: AsyncJobRecord };
        setActiveJob(data.job);
        if (data.job.status !== 'running' && data.job.status !== 'queued') {
          await fetchBootstrap();
        }
      } catch {
        // Ignore transient network poll error
      }
    }, 700);
    return () => window.clearInterval(timer);
  }, [activeJob?.id, activeJob?.status, fetchBootstrap]);

  // When a fits_star_extract execution finishes, pull its parsed output JSON so FitsWorkspace can overlay the exact Python detections
  useEffect(() => {
    if (!activeJob || activeJob.status !== 'completed' || activeJob.runnerMode !== 'fits_star_extract') {
      return;
    }
    const exec = executions.find((e) => e.id === activeJob.resultExecutionId);
    const outArtId = activeJob.resultArtifactIds[0];
    const art = artifacts.find((a) => a.id === outArtId);
    if (!art && !exec) return;

    // Fetch exact output payload via artifacts relative path if served, or reload job log metadata
    if (exec) {
      fetch(`/api/jobs/${encodeURIComponent(activeJob.id)}`)
        .then((r) => r.json())
        .then(async (payload) => {
          const j = payload.job as AsyncJobRecord;
          if (!j.resultArtifactIds[0]) return;
          // Note: pythonFitsResult uses the detections from execution or artifact endpoint
          const artRes = await fetch(`/api/fits/inspect-artifact?artifactId=${encodeURIComponent(j.resultArtifactIds[0])}`);
          if (artRes.ok) {
            const parsed = await artRes.json();
            if (Array.isArray(parsed.detectedSources)) {
              setPythonFitsResult({
                extractor: String(parsed.extractor ?? j.parameters.extractor ?? 'photutils_DAOStarFinder'),
                fitsPath: String(parsed.fitsPath ?? j.parameters.fitsPath ?? ''),
                detectedSources: parsed.detectedSources as FitsSourceDetection[],
                medianSkyAdu: typeof parsed.medianSkyAdu === 'number' ? parsed.medianSkyAdu : undefined,
                skyNoiseSigmaAdu:
                  typeof parsed.skyNoiseSigmaAdu === 'number' ? parsed.skyNoiseSigmaAdu : undefined,
                medianFwhmPx: parsed.medianFwhmPx ?? null,
                medianFwhmArcsec: parsed.medianFwhmArcsec ?? null,
              });
            }
          }
        })
        .catch(() => {});
    }
  }, [activeJob?.id, activeJob?.status, executions, artifacts]);

  const handleStartAsyncJob = async (payload: {
    studyId: string;
    parentBranchId: string;
    runnerMode: P2RunnerMode;
    title: string;
    intent: string;
    branchName: string;
    hypothesis: string;
    parameters: Record<string, unknown>;
    timeoutMs: number;
  }): Promise<AsyncJobRecord | null> => {
    const res = await fetch('/api/jobs/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || '启动异步计算失败');
    }
    setActiveJob(data.job as AsyncJobRecord);
    return data.job as AsyncJobRecord;
  };

  const handleCancelAsyncJob = async (jobId: string) => {
    const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: 'POST',
    });
    const data = await res.json();
    if (res.ok && data.job) {
      setActiveJob(data.job as AsyncJobRecord);
      await fetchBootstrap();
    }
  };

  const handleAdoptBranch = async (studyId: string, branchId: string, reason?: string) => {
    const res = await fetch(
      `/api/studies/${encodeURIComponent(studyId)}/branches/${encodeURIComponent(branchId)}/adopt`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '采纳分支失败');
    await fetchBootstrap();
  };

  const handleCreateStudy = async (payload: {
    title: string;
    domain: string;
    problemStatement: string;
    backgroundContext?: string;
    initialHypothesis?: string;
  }) => {
    const res = await fetch('/api/studies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '新建课题失败');
    await fetchBootstrap();
    setSelectedStudyId(data.study.id);
    setActiveTab('experiment');
  };

  const handleAddOpenQuestion = async (studyId: string, question: string) => {
    const res = await fetch(`/api/studies/${encodeURIComponent(studyId)}/open-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    if (res.ok) await fetchBootstrap();
  };

  const handleAddEpistemicNote = async (payload: {
    studyId: string;
    branchId: string | null;
    tag: EpistemicTag;
    title: string;
    content: string;
    evidenceRefs?: string[];
  }) => {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (res.ok) await fetchBootstrap();
  };

  const handleAskAiCollaborator = async (studyId: string, question: string) => {
    const res = await fetch('/api/ai/collaborate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ studyId, question }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI 研判请求失败');
    await fetchBootstrap();
  };

  const handleTriggerPythonExtractFromFits = async (params: {
    fitsPath: string;
    extractor: 'photutils_DAOStarFinder' | 'sep_extract';
    fwhmPx: number;
    thresholdSigma: number;
    apertureRadiusPx: number;
  }) => {
    const wfStudy = studies.find((s) => s.id === 'study-wf-rc-1000') ?? studies[0];
    if (!wfStudy) return;
    setSelectedFitsPath(params.fitsPath);
    const parentId = wfStudy.adoptedBranchId || 'branch-p2-s3';
    await handleStartAsyncJob({
      studyId: wfStudy.id,
      parentBranchId: parentId,
      runnerMode: 'fits_star_extract',
      title: `FITS 查看器实算 (${params.extractor}, FWHM=${params.fwhmPx}px)`,
      intent: `从 2D FITS 检查器发起真实 Python 提取: ${params.fitsPath.split('/').pop()}`,
      branchName: `FITS 检查 (${params.extractor}, fwhm=${params.fwhmPx}px)`,
      hypothesis: `验证 FWHM=${params.fwhmPx}px、阈值 ${params.thresholdSigma}σ 下的真实检测源分布`,
      parameters: params,
      timeoutMs: 25000,
    });
    setActiveTab('experiment');
  };

  // Legacy P1 handlers
  const handleExecuteP1Run = async (parentRunId: string | null): Promise<ExperimentRun | null> => {
    if (!systemSpec) return null;
    const launchEpoch = specEpoch;
    setIsP1Running(true);
    setP1RunError(null);
    try {
      const res = await fetch('/api/experiments/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: intentText,
          branchLabel,
          parentRunId,
          mode: runMode,
          seed,
          systemSpec,
          solverId: selectedSolverId,
          evaluatorId: selectedEvaluatorId,
          optimizerId: selectedOptimizerId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '实验执行失败');
      setRuns((prev) => [...prev, data.run as ExperimentRun]);
      setThread((prev) => [...prev, data.entry as ThreadEntry]);
      if (data.components) setComponents(data.components);
      if (data.runtimeEnv) setRuntimeEnv(data.runtimeEnv);
      setSpecEpoch((cur) => {
        if (cur === launchEpoch) {
          setSystemSpec(data.run.systemAfter);
        }
        return cur;
      });
      await fetchBootstrap();
      return data.run as ExperimentRun;
    } catch (err) {
      setP1RunError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsP1Running(false);
    }
  };

  const handleReevaluateP1Run = async (runId: string, evaluatorId: string) => {
    setP1RunError(null);
    const res = await fetch(`/api/experiments/${encodeURIComponent(runId)}/reevaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evaluatorId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setP1RunError(data.error || '重评失败');
      return;
    }
    setRuns((prev) => prev.map((r) => (r.id === runId ? (data.run as ExperimentRun) : r)));
    setThread((prev) => [...prev, data.entry as ThreadEntry]);
  };

  const handleAddP1Note = async (
    origin: SourceOrigin,
    title: string,
    content: string,
    runId: string | null,
  ) => {
    const res = await fetch('/api/thread', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin, title, content, runId }),
    });
    const data = await res.json();
    if (res.ok && data.entry) {
      setThread((prev) => [...prev, data.entry as ThreadEntry]);
    }
  };

  const handleRequestP1AiCritique = async (question: string) => {
    const res = await fetch('/api/ai/critique', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'AI 协作请求失败');
    if (data.entry) {
      setThread((prev) => [...prev, data.entry as ThreadEntry]);
    }
  };

  const handleTopBarPrimaryAction = () => {
    setActiveTab('experiment');
  };

  const handleJumpFromArchitecture = (target: {
    tab: 'experiment' | 'components' | 'compare' | 'architecture';
    targetId: string;
  }) => {
    if (target.tab === 'components') {
      setSelectedComponentId(target.targetId);
    }
    if (target.targetId.startsWith('study:')) {
      setSelectedStudyId(target.targetId.replace(/^study:/, ''));
    } else if (target.targetId.startsWith('branch:')) {
      const bId = target.targetId.replace(/^branch:/, '');
      const b = branches.find((x) => x.id === bId);
      if (b) setSelectedStudyId(b.studyId);
    }
    setActiveTab(target.tab);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-slate-600 font-mono">
        正在初始化 OpenLab Bench 开放科研工作台与 WF-RC-1000 证据账本...
      </div>
    );
  }

  if (loadError || !presets || !systemSpec || !runtimeEnv || !pythonRuntime) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md bg-white border border-rose-200 rounded-md p-6 space-y-3 text-sm">
          <div className="font-semibold text-rose-800">工作台初始化失败</div>
          <p className="text-slate-600">{loadError || '缺少课题或运行环境数据'}</p>
          <button
            type="button"
            onClick={fetchBootstrap}
            className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 rounded cursor-pointer"
          >
            重新加载
          </button>
        </div>
      </div>
    );
  }

  const activeStudy = studies.find((s) => s.id === selectedStudyId) ?? studies[0];
  const activeBranches = branches.filter((b) => b.studyId === activeStudy?.id);
  const activeExecutions = executions.filter((e) => e.studyId === activeStudy?.id);
  const activeArtifacts = artifacts.filter((a) => a.studyId === activeStudy?.id);

  const isJobRunning = activeJob?.status === 'running' || activeJob?.status === 'queued';

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onPrimaryAction={handleTopBarPrimaryAction}
        activeJob={activeJob}
        isBusy={isP1Running}
      />

      <main className="flex-1">
        {researchError && <p role="alert" className="p-3 text-sm text-rose-700">科研执行 · {researchError}</p>}
        {activeTab === 'experiment' && activeStudy && <ResearchRunControls
          key={activeStudy.id}
          studyId={activeStudy.id}
          components={components}
          state={research}
          refresh={refreshResearch}
          openExecution={setOpenExecutionId}
          openComparison={() => setActiveTab('compare')}
        />}
        {activeTab === 'compare' && activeStudy && <ResearchArtifacts
          key={activeStudy.id}
          studyId={activeStudy.id}
          state={research}
          selectedId={researchArtifactId}
          inspect={inspectResearchArtifact}
          openExecution={setOpenExecutionId}
        />}
        {activeTab === 'components' && <ResearchComponentContract
          dossier={components.find((item) => item.id === selectedComponentId)}
          state={research}
          openExecution={setOpenExecutionId}
        />}
        {activeTab === 'architecture' && <ResearchObservedMap
          state={research}
          openExecution={setOpenExecutionId}
          inspect={inspectResearchArtifact}
        />}
        {activeTab === 'experiment' && (
          <ResearchStudio
            studies={studies}
            selectedStudyId={selectedStudyId}
            onSelectStudyId={setSelectedStudyId}
            branches={branches}
            executions={executions}
            artifacts={artifacts}
            notes={notes}
            fitsCatalog={fitsCatalog}
            pythonRuntime={pythonRuntime}
            activeJob={activeJob}
            jobs={jobs}
            onStartAsyncJob={handleStartAsyncJob}
            onCancelAsyncJob={handleCancelAsyncJob}
            onAdoptBranch={handleAdoptBranch}
            onCreateStudy={handleCreateStudy}
            onAddOpenQuestion={handleAddOpenQuestion}
            onAddEpistemicNote={handleAddEpistemicNote}
            onAskAiCollaborator={handleAskAiCollaborator}
            onNavigateToCompare={(sub, fitsP) => {
              if (sub) setCompareSubTab(sub);
              if (fitsP) setSelectedFitsPath(fitsP);
              setActiveTab('compare');
            }}
            onInspectInArchitecture={(nodeId) => {
              setArchFocusNodeId(nodeId);
              setActiveTab('architecture');
            }}
            components={components}
            runs={runs}
            thread={thread}
            presets={presets}
            aiAvailable={aiAvailable}
            runtimeEnv={runtimeEnv}
            systemSpec={systemSpec}
            onChangeSystemSpec={handleUpdateSystemSpec}
            selectedSolverId={selectedSolverId}
            onChangeSolverId={setSelectedSolverId}
            selectedOptimizerId={selectedOptimizerId}
            onChangeOptimizerId={setSelectedOptimizerId}
            selectedEvaluatorId={selectedEvaluatorId}
            onChangeEvaluatorId={setSelectedEvaluatorId}
            runMode={runMode}
            onChangeRunMode={setRunMode}
            seed={seed}
            onChangeSeed={setSeed}
            intentText={intentText}
            onChangeIntentText={setIntentText}
            branchLabel={branchLabel}
            onChangeBranchLabel={setBranchLabel}
            onExecuteP1Run={handleExecuteP1Run}
            isP1Running={isP1Running}
            p1RunError={p1RunError}
            onInspectComponent={(id) => {
              setSelectedComponentId(id);
              setActiveTab('components');
            }}
            onReevaluateP1Run={handleReevaluateP1Run}
            onAddP1Note={handleAddP1Note}
            onRequestP1AiCritique={handleRequestP1AiCritique}
          />
        )}

        {activeTab === 'compare' && activeStudy && (
          <ArtifactsAndCompareView
            study={activeStudy}
            branches={activeBranches}
            executions={activeExecutions}
            artifacts={activeArtifacts}
            fitsCatalog={fitsCatalog}
            legacyRuns={runs}
            activeSubTab={compareSubTab}
            onChangeSubTab={setCompareSubTab}
            initialFitsPath={selectedFitsPath}
            pythonFitsResult={pythonFitsResult}
            onAdoptBranch={handleAdoptBranch}
            onSelectFitsPath={(p) => setSelectedFitsPath(p)}
            onTriggerPythonExtract={handleTriggerPythonExtractFromFits}
            isJobRunning={isJobRunning}
          />
        )}

        {activeTab === 'components' && (
          <ComponentLibrary
            components={components}
            runs={runs}
            selectedId={selectedComponentId}
            onSelectId={setSelectedComponentId}
            onInspectInArchitecture={(nodeId) => {
              setArchFocusNodeId(nodeId);
              setActiveTab('architecture');
            }}
            onRefresh={fetchBootstrap}
            pythonRuntime={pythonRuntime}
          />
        )}

        {activeTab === 'architecture' && (
          <ArchitectureMapView
            initialFocusNodeId={archFocusNodeId}
            onJumpToTarget={handleJumpFromArchitecture}
          />
        )}
      </main>
      {openExecutionId && <ResearchExecutionDialog
        key={openExecutionId}
        id={openExecutionId}
        close={() => setOpenExecutionId('')}
        inspect={inspectResearchArtifact}
        openExecution={setOpenExecutionId}
        refresh={refreshResearch}
      />}
    </div>
  );
}

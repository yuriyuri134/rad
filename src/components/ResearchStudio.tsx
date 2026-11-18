import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  FlaskConical,
  GitBranch,
  Network,
  Plus,
  Send,
  Square,
  Telescope,
  Terminal,
} from 'lucide-react';
import type {
  ArtifactRef,
  AsyncJobRecord,
  ComponentDossier,
  EpistemicNote,
  EpistemicTag,
  ExperimentRun,
  FitsCatalogEntry,
  OpticalSystemSpec,
  P2RunnerMode,
  ProposedExperimentAction,
  ProvenanceTier,
  ResearchStudy,
  RuntimeEnvironmentSnapshot,
  SourceOrigin,
  StudyBranch,
  ThreadEntry,
  WorkflowExecution,
} from '../core/types.ts';
import { ExperimentWorkspace } from './ExperimentWorkspace.tsx';

export type DiscoveredPythonRuntime = {
  executable: string;
  source: string;
  pythonVersion: string | null;
  packages: {
    optiland: string | null;
    numpy: string | null;
    scipy: string | null;
    astropy: string | null;
    sep: string | null;
    photutils: string | null;
  };
};

interface ResearchStudioProps {
  studies: ResearchStudy[];
  selectedStudyId: string;
  onSelectStudyId: (studyId: string) => void;
  branches: StudyBranch[];
  executions: WorkflowExecution[];
  artifacts: ArtifactRef[];
  notes: EpistemicNote[];
  fitsCatalog: FitsCatalogEntry[];
  pythonRuntime: DiscoveredPythonRuntime;
  activeJob: AsyncJobRecord | null;
  jobs: AsyncJobRecord[];
  onStartAsyncJob: (payload: {
    studyId: string;
    parentBranchId: string;
    runnerMode: P2RunnerMode;
    title: string;
    intent: string;
    branchName: string;
    hypothesis: string;
    parameters: Record<string, unknown>;
    timeoutMs: number;
  }) => Promise<AsyncJobRecord | null>;
  onCancelAsyncJob: (jobId: string) => Promise<void>;
  onAdoptBranch: (studyId: string, branchId: string, reason?: string) => Promise<void>;
  onCreateStudy: (payload: {
    title: string;
    domain: string;
    problemStatement: string;
    backgroundContext?: string;
    initialHypothesis?: string;
  }) => Promise<void>;
  onAddOpenQuestion: (studyId: string, question: string) => Promise<void>;
  onAddEpistemicNote: (payload: {
    studyId: string;
    branchId: string | null;
    tag: EpistemicTag;
    title: string;
    content: string;
    evidenceRefs?: string[];
  }) => Promise<void>;
  onAskAiCollaborator: (studyId: string, question: string) => Promise<void>;
  onNavigateToCompare: (subTab?: 'matrix' | 'fits' | 'artifacts', fitsPath?: string) => void;
  onInspectInArchitecture: (nodeId: string) => void;
  // Legacy P1 compatibility props when study-p1-100mm-optics is selected
  components: ComponentDossier[];
  runs: ExperimentRun[];
  thread: ThreadEntry[];
  presets: { singlet: OpticalSystemSpec; doublet: OpticalSystemSpec };
  aiAvailable: boolean;
  runtimeEnv: RuntimeEnvironmentSnapshot;
  systemSpec: OpticalSystemSpec;
  onChangeSystemSpec: (spec: OpticalSystemSpec) => void;
  selectedSolverId: string;
  onChangeSolverId: (id: string) => void;
  selectedOptimizerId: string;
  onChangeOptimizerId: (id: string) => void;
  selectedEvaluatorId: string;
  onChangeEvaluatorId: (id: string) => void;
  runMode: 'solve_only' | 'optimize';
  onChangeRunMode: (mode: 'solve_only' | 'optimize') => void;
  seed: number;
  onChangeSeed: (seed: number) => void;
  intentText: string;
  onChangeIntentText: (s: string) => void;
  branchLabel: string;
  onChangeBranchLabel: (s: string) => void;
  onExecuteP1Run: (parentRunId: string | null) => Promise<ExperimentRun | null>;
  isP1Running: boolean;
  p1RunError: string | null;
  onInspectComponent: (id: string) => void;
  onReevaluateP1Run: (runId: string, evaluatorId: string) => Promise<void>;
  onAddP1Note: (origin: SourceOrigin, title: string, content: string, runId: string | null) => Promise<void>;
  onRequestP1AiCritique: (question: string) => Promise<void>;
}

const PROVENANCE_BADGE: Record<ProvenanceTier, { label: string; cls: string }> = {
  external_verified_import: {
    label: '外部验证导入 (external_verified_import)',
    cls: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  },
  workbench_native: {
    label: '工作台原生实算 (workbench_native)',
    cls: 'bg-blue-50 text-blue-800 border-blue-200',
  },
  historical_migrated: {
    label: '历史迁移只读 (historical_migrated)',
    cls: 'bg-slate-100 text-slate-700 border-slate-300',
  },
};

const TAG_META: Record<EpistemicTag, { label: string; cls: string }> = {
  fact: { label: '[事实]', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  judgment: { label: '[判断]', cls: 'bg-blue-50 text-blue-800 border-blue-200' },
  hypothesis: { label: '[假设]', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  proposal: { label: '[提议]', cls: 'bg-violet-50 text-violet-800 border-violet-200' },
};

export function ResearchStudio(props: ResearchStudioProps) {
  const {
    studies,
    selectedStudyId,
    onSelectStudyId,
    branches,
    executions,
    notes,
    fitsCatalog,
    pythonRuntime,
    activeJob,
    jobs,
    onStartAsyncJob,
    onCancelAsyncJob,
    onAdoptBranch,
    onCreateStudy,
    onAddOpenQuestion,
    onAddEpistemicNote,
    onAskAiCollaborator,
    onNavigateToCompare,
    onInspectInArchitecture,
  } = props;

  const activeStudy = studies.find((s) => s.id === selectedStudyId) ?? studies[0];
  const studyBranches = branches.filter((b) => b.studyId === activeStudy?.id);
  const studyExecs = executions.filter((e) => e.studyId === activeStudy?.id);
  const studyNotes = Array.from(
    new Map(notes.filter((n) => n.studyId === activeStudy?.id).map((n) => [n.id, n])).values(),
  );
  const adoptedBranch =
    studyBranches.find((b) => b.id === activeStudy?.adoptedBranchId) ?? studyBranches[0] ?? null;

  // Create custom study inline drawer state
  const [showCreateStudy, setShowCreateStudy] = useState(false);
  const [newStudyTitle, setNewStudyTitle] = useState('');
  const [newStudyDomain, setNewStudyDomain] = useState('scientific_instrumentation');
  const [newStudyProblem, setNewStudyProblem] = useState('');
  const [newStudyHypothesis, setNewStudyHypothesis] = useState('');
  const [creatingStudy, setCreatingStudy] = useState(false);
  const [studyError, setStudyError] = useState<string | null>(null);

  // Open question input
  const [newQuestion, setNewQuestion] = useState('');
  const [addingQuestion, setAddingQuestion] = useState(false);

  // Async Experiment Workbench state
  const [runnerTab, setRunnerTab] = useState<P2RunnerMode>('wf_rc_perturb_eval');
  const [parentBranchId, setParentBranchId] = useState<string>('branch-p2-s3');
  const [branchName, setBranchName] = useState('S3 公差验证探索分支');
  const [hypothesis, setHypothesis] = useState(
    '检验主镜曲率偏差 ΔR1 与次镜倾斜对 550 nm 边缘 Strehl 的影响，并比较 M2 垫片+BFL 补偿能否挽回指标。',
  );
  // Tab A: Optiland tolerance params
  const [baseBranchKey, setBaseBranchKey] = useState('S3');
  const [compensator, setCompensator] = useState<'m2_shim_plus_bfl' | 'bfl_only' | 'none'>(
    'm2_shim_plus_bfl',
  );
  const [deltaR1Mm, setDeltaR1Mm] = useState<number>(1.2);
  const [deltaR2Mm, setDeltaR2Mm] = useState<number>(0);
  const [deltaDM1M2Mm, setDeltaDM1M2Mm] = useState<number>(0);
  const [m2TiltArcsec, setM2TiltArcsec] = useState<number>(15);
  const [m2DecenterMm, setM2DecenterMm] = useState<number>(0);
  const [optTimeoutSec, setOptTimeoutSec] = useState<number>(45);

  // Tab B: FITS star extraction params
  const [fitsPath, setFitsPath] = useState<string>(
    fitsCatalog.find((f) => f.fileName.includes('S3_3Lens') && f.fieldDeg === 0.6)?.relativePath ||
      fitsCatalog[0]?.relativePath ||
      '',
  );
  const [fitsExtractor, setFitsExtractor] = useState<'photutils_DAOStarFinder' | 'sep_extract'>(
    'photutils_DAOStarFinder',
  );
  const [fwhmPx, setFwhmPx] = useState<number>(1.5);
  const [thresholdSigma, setThresholdSigma] = useState<number>(4.5);
  const [apertureRadiusPx, setApertureRadiusPx] = useState<number>(4.0);
  const [fitsTimeoutSec, setFitsTimeoutSec] = useState<number>(25);

  // Tab C: Batch FITS completeness sweep params
  const [batchScope, setBatchScope] = useState<'S1_S4' | 'ALL_20' | 'S3_ONLY'>('S1_S4');
  const [batchFwhmPx, setBatchFwhmPx] = useState<number>(1.5);
  const [batchThresholdSigma, setBatchThresholdSigma] = useState<number>(4.5);
  const [batchMatchRadiusPx, setBatchMatchRadiusPx] = useState<number>(3.5);
  const [batchTimeoutSec, setBatchTimeoutSec] = useState<number>(40);

  // Tab D: S4 multi-seed / conic-unlocked reopt params
  const [s4Strategy, setS4Strategy] = useState<
    'unlock_conics_multi_seed' | 'conic_locked_scaled_seed' | 'both_compare'
  >('unlock_conics_multi_seed');
  const [s4MaxNfev, setS4MaxNfev] = useState<number>(25);
  const [s4NumRaysOpt, setS4NumRaysOpt] = useState<number>(4);
  const [s4TimeoutSec, setS4TimeoutSec] = useState<number>(150);

  const [launchError, setLaunchError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  // Epistemic Note & AI Collaborator state
  const [noteTag, setNoteTag] = useState<EpistemicTag>('judgment');
  const [noteTitle, setNoteTitle] = useState('');
  const [noteContent, setNoteContent] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const [aiQuestion, setAiQuestion] = useState('');
  const [askingAi, setAskingAi] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    if (adoptedBranch) {
      setParentBranchId(adoptedBranch.id);
    } else if (studyBranches[0]) {
      setParentBranchId(studyBranches[0].id);
    }
  }, [activeStudy?.id, adoptedBranch?.id]);

  useEffect(() => {
    if (!fitsPath && fitsCatalog.length > 0) {
      const s3Edge = fitsCatalog.find((f) => f.fileName.includes('S3_3Lens') && f.fieldDeg === 0.6);
      setFitsPath(s3Edge?.relativePath ?? fitsCatalog[0].relativePath);
    }
  }, [fitsCatalog, fitsPath]);

  if (!activeStudy) {
    return (
      <div className="max-w-[1440px] mx-auto px-6 py-8 text-sm text-slate-600">
        当前工作区暂无已加载的研究课题。
      </div>
    );
  }

  const isLegacyP1 = activeStudy.provenanceTier === 'historical_migrated';
  const isJobRunning = activeJob?.status === 'running' || activeJob?.status === 'queued';
  const displayedJob =
    activeJob ?? jobs.find((j) => j.studyId === activeStudy.id) ?? jobs[0] ?? null;

  const switchRunnerTab = (mode: P2RunnerMode) => {
    setRunnerTab(mode);
    setLaunchError(null);
    if (mode === 'wf_rc_perturb_eval') {
      if (studyBranches.some((b) => b.id === 'branch-p2-s3')) setParentBranchId('branch-p2-s3');
      setBranchName('S3 公差验证探索分支');
      setHypothesis('检验主镜曲率偏差 ΔR1 与次镜倾斜对 550 nm 边缘 Strehl 的影响，并比较 M2 垫片+BFL 补偿能否挽回指标。');
    } else if (mode === 'fits_star_extract') {
      if (studyBranches.some((b) => b.id === 'branch-p2-s3')) setParentBranchId('branch-p2-s3');
      setBranchName('S3 欠采样单帧 FITS 重提取');
      setHypothesis('降低 DAOStarFinder fwhmPx 至 1.5 px，检验能否显著恢复锐利欠采样帧中的暗星检出数。');
    } else if (mode === 'fits_batch_completeness') {
      if (studyBranches.some((b) => b.id === 'branch-p2-s3')) setParentBranchId('branch-p2-s3');
      setBranchName('S1-S4 16帧批量 FITS 欠采样横评');
      setHypothesis('跨 S1–S4 全部视场与像斑尺度验证 DAO(fwhm=1.5px) 与 SEP 的交叉匹配率，同时检查假阳性余项。');
    } else {
      if (studyBranches.some((b) => b.id === 'branch-p2-s4')) setParentBranchId('branch-p2-s4');
      setBranchName('S4 (FS+F2) 多起点与圆锥解锁重优化');
      setHypothesis('检验解锁 Quasi-RC 圆锥系数 (K1/K2) 与多起点初始曲率能否使 S4 逃离 cost=597.635 局部极小。');
    }
  };

  const handleLaunch = async (overrideAction?: ProposedExperimentAction) => {
    setLaunchError(null);
    setLaunching(true);
    try {
      if (overrideAction) {
        const mode = overrideAction.runnerMode;
        setRunnerTab(mode);
        const p = overrideAction.parameters;
        if (mode === 'fits_star_extract') {
          if (typeof p.fitsPath === 'string') setFitsPath(p.fitsPath);
          if (p.extractor === 'sep_extract' || p.extractor === 'photutils_DAOStarFinder') {
            setFitsExtractor(p.extractor);
          }
          if (typeof p.fwhmPx === 'number') setFwhmPx(p.fwhmPx);
          if (typeof p.thresholdSigma === 'number') setThresholdSigma(p.thresholdSigma);
          if (typeof p.apertureRadiusPx === 'number') setApertureRadiusPx(p.apertureRadiusPx);
        } else if (mode === 'fits_batch_completeness') {
          if (typeof p.fwhmPx === 'number') setBatchFwhmPx(p.fwhmPx);
          if (typeof p.thresholdSigma === 'number') setBatchThresholdSigma(p.thresholdSigma);
          if (typeof p.matchRadiusPx === 'number') setBatchMatchRadiusPx(p.matchRadiusPx);
        } else if (mode === 'wf_rc_s4_reopt_probe') {
          if (
            p.strategy === 'unlock_conics_multi_seed' ||
            p.strategy === 'conic_locked_scaled_seed' ||
            p.strategy === 'both_compare'
          ) {
            setS4Strategy(p.strategy);
          }
          if (typeof p.maxNfev === 'number') setS4MaxNfev(p.maxNfev);
          if (typeof p.numRaysOpt === 'number') setS4NumRaysOpt(p.numRaysOpt);
        } else {
          if (typeof p.baseBranchKey === 'string') setBaseBranchKey(p.baseBranchKey);
          if (
            p.compensator === 'none' ||
            p.compensator === 'bfl_only' ||
            p.compensator === 'm2_shim_plus_bfl'
          ) {
            setCompensator(p.compensator);
          }
          if (typeof p.delta_r1_mm === 'number') setDeltaR1Mm(p.delta_r1_mm);
          if (typeof p.delta_r2_mm === 'number') setDeltaR2Mm(p.delta_r2_mm);
          if (typeof p.delta_d_m1_m2_mm === 'number') setDeltaDM1M2Mm(p.delta_d_m1_m2_mm);
          if (typeof p.m2_tilt_arcsec === 'number') setM2TiltArcsec(p.m2_tilt_arcsec);
          if (typeof p.m2_decenter_mm === 'number') setM2DecenterMm(p.m2_decenter_mm);
        }
        setBranchName(overrideAction.branchName);
        setHypothesis(overrideAction.hypothesis);
        setParentBranchId(overrideAction.parentBranchId);

        const timeoutByMode =
          mode === 'wf_rc_s4_reopt_probe'
            ? 150000
            : mode === 'wf_rc_perturb_eval'
              ? 45000
              : mode === 'fits_batch_completeness'
                ? 40000
                : 25000;

        await onStartAsyncJob({
          studyId: overrideAction.studyId,
          parentBranchId: overrideAction.parentBranchId,
          runnerMode: mode,
          title: overrideAction.label,
          intent: overrideAction.intent,
          branchName: overrideAction.branchName,
          hypothesis: overrideAction.hypothesis,
          parameters: overrideAction.parameters,
          timeoutMs: timeoutByMode,
        });
        return;
      }

      if (runnerTab === 'wf_rc_perturb_eval') {
        await onStartAsyncJob({
          studyId: activeStudy.id,
          parentBranchId,
          runnerMode: 'wf_rc_perturb_eval',
          title: `Optiland 0.6.3 公差实算 (${baseBranchKey} / ${compensator})`,
          intent: `检验 ΔR1=${deltaR1Mm}mm, Δd=${deltaDM1M2Mm}mm, tilt=${m2TiltArcsec}" 下的多视场 RMS 与 550nm Strehl`,
          branchName: branchName.trim() || `${baseBranchKey} 公差微扰分支`,
          hypothesis: hypothesis.trim() || '测试光学加工与装调微扰后的补偿极限',
          parameters: {
            baseBranchKey,
            compensator,
            delta_r1_mm: deltaR1Mm,
            delta_r2_mm: deltaR2Mm,
            delta_d_m1_m2_mm: deltaDM1M2Mm,
            m2_tilt_arcsec: m2TiltArcsec,
            m2_decenter_mm: m2DecenterMm,
          },
          timeoutMs: Math.max(15, Math.min(120, optTimeoutSec)) * 1000,
        });
      } else if (runnerTab === 'fits_batch_completeness') {
        const systemKeys =
          batchScope === 'ALL_20'
            ? ['ALL']
            : batchScope === 'S3_ONLY'
              ? ['S3_3Lens_Wynne_FS_QuasiRC']
              : ['S1_2Lens_FS_RC', 'S2_3Lens_Wynne_FS_RC', 'S3_3Lens_Wynne_FS_QuasiRC', 'S4_3Lens_Wynne_FS_F2_RC'];
        await onStartAsyncJob({
          studyId: activeStudy.id,
          parentBranchId,
          runnerMode: 'fits_batch_completeness',
          title: `批量 FITS 欠采样横评 (${batchScope}, FWHM=${batchFwhmPx}px)`,
          intent: `在 ${batchScope} 真实 FITS 瓦片上批量比对 Photutils DAO(fwhm=${batchFwhmPx}px) 与 SEP 交叉匹配率及假阳性余项`,
          branchName: branchName.trim() || `FITS 批量横评 (FWHM=${batchFwhmPx}px)`,
          hypothesis: hypothesis.trim() || '验证全视场下调 DAO fwhmPx 对对齐 SEP 完备度的有效性',
          parameters: {
            systemKeys,
            fwhmPx: batchFwhmPx,
            thresholdSigma: batchThresholdSigma,
            sepThresholdSigma: batchThresholdSigma,
            sepMinArea: 4,
            matchRadiusPx: batchMatchRadiusPx,
          },
          timeoutMs: Math.max(15, Math.min(90, batchTimeoutSec)) * 1000,
        });
      } else if (runnerTab === 'wf_rc_s4_reopt_probe') {
        await onStartAsyncJob({
          studyId: activeStudy.id,
          parentBranchId,
          runnerMode: 'wf_rc_s4_reopt_probe',
          title: `S4 (FS+F2) 诊断重优化 (${s4Strategy}, maxNfev=${s4MaxNfev})`,
          intent: `在 Optiland 0.6.3 上实测 S4 (${s4Strategy}) 能否突破 Stage 2 cost=597.635 / RMS=9.704μm 局部极小`,
          branchName: branchName.trim() || `S4 重优化诊断 (${s4Strategy})`,
          hypothesis: hypothesis.trim() || '检验解锁 K1/K2 与调整 F2 初始曲率起点对 S4 收敛的影响',
          parameters: {
            strategy: s4Strategy,
            maxNfev: s4MaxNfev,
            numRaysOpt: s4NumRaysOpt,
            evalNumRays: 12,
          },
          timeoutMs: Math.max(30, Math.min(240, s4TimeoutSec)) * 1000,
        });
      } else {
        if (!fitsPath) {
          throw new Error('请先选择一帧 FITS 图像文件');
        }
        await onStartAsyncJob({
          studyId: activeStudy.id,
          parentBranchId,
          runnerMode: 'fits_star_extract',
          title: `FITS 星表重提取 (${fitsExtractor}, FWHM=${fwhmPx}px)`,
          intent: `在真实 FITS 帧 ${fitsPath.split('/').pop()} 上验证欠采样点源检测完备度`,
          branchName: branchName.trim() || `FITS 提取探索 (${fitsExtractor})`,
          hypothesis: hypothesis.trim() || '检验减小 FWHM 核对欠采样点源完备度的提升作用',
          parameters: {
            fitsPath,
            extractor: fitsExtractor,
            fwhmPx,
            thresholdSigma,
            apertureRadiusPx,
          },
          timeoutMs: Math.max(10, Math.min(90, fitsTimeoutSec)) * 1000,
        });
      }
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  };

  const handleSubmitCreateStudy = async (e: React.FormEvent) => {
    e.preventDefault();
    setStudyError(null);
    setCreatingStudy(true);
    try {
      await onCreateStudy({
        title: newStudyTitle,
        domain: newStudyDomain,
        problemStatement: newStudyProblem,
        initialHypothesis: newStudyHypothesis,
      });
      setShowCreateStudy(false);
      setNewStudyTitle('');
      setNewStudyProblem('');
      setNewStudyHypothesis('');
    } catch (err) {
      setStudyError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingStudy(false);
    }
  };

  const handleSubmitQuestion = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newQuestion.trim()) return;
    setAddingQuestion(true);
    try {
      await onAddOpenQuestion(activeStudy.id, newQuestion.trim());
      setNewQuestion('');
    } finally {
      setAddingQuestion(false);
    }
  };

  const handleSubmitNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteContent.trim()) return;
    setSavingNote(true);
    try {
      await onAddEpistemicNote({
        studyId: activeStudy.id,
        branchId: adoptedBranch?.id ?? null,
        tag: noteTag,
        title: noteTitle.trim() || '研究者记录',
        content: noteContent.trim(),
      });
      setNoteTitle('');
      setNoteContent('');
    } finally {
      setSavingNote(false);
    }
  };

  const handleAskAi = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiQuestion.trim()) return;
    setAiError(null);
    setAskingAi(true);
    try {
      await onAskAiCollaborator(activeStudy.id, aiQuestion.trim());
      setAiQuestion('');
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAskingAi(false);
    }
  };

  return (
    <div className="max-w-[1440px] mx-auto px-6 py-6 space-y-6">
      {/* Study Switcher & Creation Bar */}
      <section className="bg-white border border-slate-200 rounded-md p-4 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider mr-1">
              研究课题入口
            </span>
            {studies.map((s) => {
              const selected = s.id === activeStudy.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => onSelectStudyId(s.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded border transition-colors cursor-pointer ${
                    selected
                      ? 'bg-blue-700 text-white border-blue-700'
                      : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  {s.title}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setShowCreateStudy((v) => !v)}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" aria-hidden="true" />
              <span>新建开放研究课题</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-slate-600">
            <span>
              Python: {pythonRuntime.pythonVersion ?? '未探测'} ({pythonRuntime.executable.split('/').pop()})
            </span>
            {pythonRuntime.packages.optiland && <span>optiland {pythonRuntime.packages.optiland}</span>}
            {pythonRuntime.packages.astropy && <span>astropy {pythonRuntime.packages.astropy}</span>}
            {pythonRuntime.packages.photutils && <span>photutils {pythonRuntime.packages.photutils}</span>}
          </div>
        </div>

        {/* Inline New Custom Study Form */}
        {showCreateStudy && (
          <form
            onSubmit={handleSubmitCreateStudy}
            className="p-4 bg-slate-50 border border-slate-200 rounded space-y-3 text-xs"
          >
            <div className="font-semibold text-slate-900">新建自由开放研究课题（持久化至 workspace/workbench/studies.json）</div>
            {studyError && (
              <div className="p-2 bg-rose-50 border border-rose-200 text-rose-800 rounded">{studyError}</div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">课题标题</label>
                <input
                  type="text"
                  required
                  value={newStudyTitle}
                  onChange={(e) => setNewStudyTitle(e.target.value)}
                  placeholder="例如：宽场消色差折反相机热变形补偿研究"
                  className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">研究领域标识</label>
                <input
                  type="text"
                  value={newStudyDomain}
                  onChange={(e) => setNewStudyDomain(e.target.value)}
                  className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded font-mono"
                />
              </div>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">核心科学/工程问题陈述</label>
              <textarea
                required
                rows={2}
                value={newStudyProblem}
                onChange={(e) => setNewStudyProblem(e.target.value)}
                placeholder="描述开放问题、目标物理量、限制条件与可检验成果..."
                className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">初始研究假设（用于初始化 B0 分支）</label>
              <input
                type="text"
                value={newStudyHypothesis}
                onChange={(e) => setNewStudyHypothesis(e.target.value)}
                placeholder="例如：利用双通道灵敏度分析验证结构稳健性"
                className="w-full px-3 py-1.5 bg-white border border-slate-300 rounded"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreateStudy(false)}
                className="px-3 py-1.5 text-slate-700 bg-white border border-slate-300 rounded cursor-pointer"
              >
                取消
              </button>
              <button
                type="submit"
                disabled={creatingStudy}
                className="px-4 py-1.5 font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded cursor-pointer"
              >
                {creatingStudy ? '创建中...' : '创建并进入课题'}
              </button>
            </div>
          </form>
        )}
      </section>

      {/* If P1 Historical Read-only Study is selected, delegate smoothly to existing P1 Workspace */}
      {isLegacyP1 ? (
        <div className="space-y-4">
          <div className="bg-slate-100 border border-slate-300 rounded-md px-4 py-3 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-semibold text-slate-900">历史迁移课题 (historical_migrated · P1)：</span>
              以下为 100 mm f/4 经典双胶合/单透镜实验工作区。原始 <code className="font-mono">runs.jsonl</code> 与 SHA-256 账本受严格只读保护，新增实验以追加方式写入工作区。
            </div>
          </div>
          <ExperimentWorkspace
            components={props.components}
            runs={props.runs}
            thread={props.thread}
            presets={props.presets}
            aiAvailable={props.aiAvailable}
            runtimeEnv={props.runtimeEnv}
            systemSpec={props.systemSpec}
            onChangeSystemSpec={props.onChangeSystemSpec}
            selectedSolverId={props.selectedSolverId}
            onChangeSolverId={props.onChangeSolverId}
            selectedOptimizerId={props.selectedOptimizerId}
            onChangeOptimizerId={props.onChangeOptimizerId}
            selectedEvaluatorId={props.selectedEvaluatorId}
            onChangeEvaluatorId={props.onChangeEvaluatorId}
            runMode={props.runMode}
            onChangeRunMode={props.onChangeRunMode}
            seed={props.seed}
            onChangeSeed={props.onChangeSeed}
            intentText={props.intentText}
            onChangeIntentText={props.onChangeIntentText}
            branchLabel={props.branchLabel}
            onChangeBranchLabel={props.onChangeBranchLabel}
            onExecuteRun={props.onExecuteP1Run}
            isRunning={props.isP1Running}
            runError={props.p1RunError}
            onInspectComponent={props.onInspectComponent}
            onInspectInArchitecture={props.onInspectInArchitecture}
            onReevaluateRun={props.onReevaluateP1Run}
            onAddNote={props.onAddP1Note}
            onRequestAiCritique={props.onRequestP1AiCritique}
          />
        </div>
      ) : (
        /* WF-RC-1000 & Open Scientific Studies Workbench */
        <div className="space-y-6">
          {/* Top Overview Header + Provenance Legend + Adopted Baseline */}
          <section className="bg-white border border-slate-200 rounded-md p-5 space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-2 max-w-4xl">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span
                    className={`px-2 py-0.5 border rounded-sm font-medium ${PROVENANCE_BADGE[activeStudy.provenanceTier].cls}`}
                  >
                    {PROVENANCE_BADGE[activeStudy.provenanceTier].label}
                  </span>
                  <span className="font-mono text-slate-500">ID: {activeStudy.id}</span>
                  <span className="font-mono text-slate-500">分支数: {studyBranches.length}</span>
                  <span className="font-mono text-slate-500">执行记录: {studyExecs.length}</span>
                </div>
                <h1 className="text-xl font-bold text-slate-900">{activeStudy.title}</h1>
                <p className="text-sm text-slate-700 leading-relaxed">{activeStudy.problemStatement}</p>
                {activeStudy.backgroundContext && (
                  <p className="text-xs text-slate-500 leading-relaxed">{activeStudy.backgroundContext}</p>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onNavigateToCompare('matrix')}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                >
                  <GitBranch className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>对比 S0–S4 与派生分支</span>
                </button>
                {fitsCatalog.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      const s3Edge = fitsCatalog.find(
                        (f) => f.fileName.includes('S3_3Lens') && f.fieldDeg === 0.6,
                      );
                      onNavigateToCompare('fits', s3Edge?.relativePath ?? fitsCatalog[0].relativePath);
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded cursor-pointer"
                  >
                    <Telescope className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>打开 2D FITS 星场 (0.60°)</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onInspectInArchitecture(`study:${activeStudy.id}`)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 rounded cursor-pointer"
                >
                  <Network className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>在架构地图中定位</span>
                </button>
              </div>
            </div>

            {/* Adopted Baseline Banner & Multi-Domain Criteria Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pt-2 border-t border-slate-100">
              <div className="lg:col-span-2 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                {activeStudy.criteria.map((c) => (
                  <div key={c.id} className="p-3 bg-slate-50 border border-slate-200 rounded text-xs space-y-1">
                    <div className="text-slate-500 font-medium">{c.label}</div>
                    <div className="font-mono tabular-nums text-sm font-bold text-slate-900">
                      {c.operator} {String(c.targetValue)} {c.unit ?? ''}
                    </div>
                    <div className="text-[11px] font-mono text-slate-500">{c.metricKey}</div>
                  </div>
                ))}
                {activeStudy.criteria.length === 0 && (
                  <div className="col-span-full p-3 bg-slate-50 border border-slate-200 rounded text-xs text-slate-600">
                    开放课题尚未固化数值判据，请通过下方实验分支演化后逐步明确判据。
                  </div>
                )}
              </div>

              {/* Current Adopted Branch Summary */}
              {adoptedBranch && (
                <div className="p-3.5 bg-blue-50/50 border border-blue-200 rounded space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold text-blue-900 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5 text-blue-700" aria-hidden="true" />
                      当前采纳基线：[{adoptedBranch.shortCode}]
                    </span>
                    <span className="px-1.5 py-0.5 text-[10px] border rounded-sm bg-white text-slate-700 border-slate-300">
                      {PROVENANCE_BADGE[adoptedBranch.provenanceTier].label.split(' ')[0]}
                    </span>
                  </div>
                  <div className="font-semibold text-slate-900">{adoptedBranch.name}</div>
                  <p className="text-slate-600 leading-relaxed">{adoptedBranch.summary}</p>
                  {typeof adoptedBranch.metrics.maxRmsPolyUm === 'number' && (
                    <div className="grid grid-cols-3 gap-2 pt-1 font-mono tabular-nums text-[11px]">
                      <div>
                        <div className="text-slate-500">Max RMS</div>
                        <div className="font-bold text-emerald-700">
                          {Number(adoptedBranch.metrics.maxRmsPolyUm).toFixed(3)} μm
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">边缘 Strehl</div>
                        <div className="font-bold text-slate-900">
                          {typeof adoptedBranch.metrics.strehlEdge === 'number'
                            ? adoptedBranch.metrics.strehlEdge.toFixed(3)
                            : '—'}
                        </div>
                      </div>
                      <div>
                        <div className="text-slate-500">MC 良率</div>
                        <div className="font-bold text-emerald-700">
                          {typeof adoptedBranch.metrics.mcM2ShimYield7_5Pct === 'number'
                            ? `${adoptedBranch.metrics.mcM2ShimYield7_5Pct}%`
                            : '—'}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 5-Stage Research Lineage Strip */}
            {activeStudy.stages.length > 0 && (
              <div className="pt-2 border-t border-slate-100">
                <div className="text-xs font-semibold text-slate-600 mb-2">多阶段研究演化过程 (Stages 1–{activeStudy.stages.length})</div>
                <div className="grid grid-cols-1 md:grid-cols-5 gap-2.5">
                  {activeStudy.stages.map((st) => (
                    <div key={st.stageNumber} className="p-2.5 bg-slate-50 border border-slate-200 rounded text-xs space-y-1">
                      <div className="flex items-center justify-between font-mono text-[11px]">
                        <span className="font-bold text-slate-900">Stage {st.stageNumber}</span>
                        <span className={st.status === 'completed' ? 'text-emerald-700' : 'text-amber-700'}>
                          {st.status === 'completed' ? '已验证' : '探索中'}
                        </span>
                      </div>
                      <div className="font-semibold text-slate-800">{st.title}</div>
                      <p className="text-[11px] text-slate-600 leading-snug">{st.keyFinding}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Main 2-Column Interactive Workbench: Left = Async Experiment Runner + Live Logs; Right = Epistemic Notes + AI + Open Questions */}
          <div className="grid grid-cols-1 xl:grid-cols-[1.2fr_1fr] gap-6 items-start">
            {/* Left Column: Controlled Fork & Async Python Real Calculation Workbench */}
            <section className="bg-white border border-slate-200 rounded-md p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-200">
                <div>
                  <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
                    <FlaskConical className="w-4 h-4 text-blue-700" aria-hidden="true" />
                    <span>分支派生与受控异步实算台（无缓冲实时日志 + 超时/取消保护）</span>
                  </h2>
                  <p className="text-xs text-slate-500 mt-0.5">
                    每次运行通过 <code className="font-mono">python -u</code> 在独立子进程执行真实物理计算，完成后自动新建工作台分支并持久化 SHA-256 产物，绝不覆盖 S0–S4 基准。
                  </p>
                </div>
              </div>

              {/* Runner Mode Tabs */}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => switchRunnerTab('wf_rc_perturb_eval')}
                  className={`px-3 py-1.5 text-xs font-medium rounded border cursor-pointer ${
                    runnerTab === 'wf_rc_perturb_eval'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  Optiland 0.6.3 光学公差与补偿实算
                </button>
                <button
                  type="button"
                  onClick={() => switchRunnerTab('fits_star_extract')}
                  className={`px-3 py-1.5 text-xs font-medium rounded border cursor-pointer ${
                    runnerTab === 'fits_star_extract'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  单帧 FITS 星表提取
                </button>
                <button
                  type="button"
                  onClick={() => switchRunnerTab('fits_batch_completeness')}
                  className={`px-3 py-1.5 text-xs font-medium rounded border cursor-pointer ${
                    runnerTab === 'fits_batch_completeness'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  批量 FITS 欠采样横评 (S0–S4)
                </button>
                <button
                  type="button"
                  onClick={() => switchRunnerTab('wf_rc_s4_reopt_probe')}
                  className={`px-3 py-1.5 text-xs font-medium rounded border cursor-pointer ${
                    runnerTab === 'wf_rc_s4_reopt_probe'
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                  }`}
                >
                  S4 (FS+F2) 多起点/圆锥解锁重优化诊断
                </button>
              </div>

              {/* Branch Lineage & Hypothesis Metadata */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block font-medium text-slate-700 mb-1">派生自基线分支</label>
                  <select
                    value={parentBranchId}
                    onChange={(e) => setParentBranchId(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-slate-50 border border-slate-300 rounded font-mono"
                  >
                    {studyBranches.map((b) => (
                      <option key={b.id} value={b.id}>
                        [{b.shortCode}] {b.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">新实验分支名称</label>
                  <input
                    type="text"
                    value={branchName}
                    onChange={(e) => setBranchName(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block font-medium text-slate-700 mb-1">实验物理假设（写入新分支档案）</label>
                  <input
                    type="text"
                    value={hypothesis}
                    onChange={(e) => setHypothesis(e.target.value)}
                    className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded"
                  />
                </div>
              </div>

              {/* Runner-specific Parameter Controls */}
              {runnerTab === 'wf_rc_perturb_eval' ? (
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded space-y-3 text-xs">
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">基准光学处方</label>
                      <select
                        value={baseBranchKey}
                        onChange={(e) => setBaseBranchKey(e.target.value)}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono"
                      >
                        <option value="S3">S3 (准 RC + 3片FS)</option>
                        <option value="S2">S2 (锁定 RC + 3片FS)</option>
                        <option value="S1">S1 (RC + 2片FS)</option>
                        <option value="S4">S4 (RC + FS+F2)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">装配补偿策略</label>
                      <select
                        value={compensator}
                        onChange={(e) =>
                          setCompensator(
                            e.target.value as 'm2_shim_plus_bfl' | 'bfl_only' | 'none',
                          )
                        }
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono"
                      >
                        <option value="m2_shim_plus_bfl">M2 垫片 + BFL 调焦</option>
                        <option value="bfl_only">仅 BFL 后焦调焦</option>
                        <option value="none">无补偿 (none)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">超时预算 (秒)</label>
                      <input
                        type="number"
                        min={15}
                        max={120}
                        value={optTimeoutSec}
                        onChange={(e) => setOptTimeoutSec(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">M1 曲率 ΔR1 (mm)</label>
                      <input
                        type="number"
                        step={0.1}
                        value={deltaR1Mm}
                        onChange={(e) => setDeltaR1Mm(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">M2 曲率 ΔR2 (mm)</label>
                      <input
                        type="number"
                        step={0.1}
                        value={deltaR2Mm}
                        onChange={(e) => setDeltaR2Mm(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">M1-M2 间距 Δd (mm)</label>
                      <input
                        type="number"
                        step={0.05}
                        value={deltaDM1M2Mm}
                        onChange={(e) => setDeltaDM1M2Mm(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">M2 倾斜 (arcsec)</label>
                      <input
                        type="number"
                        step={1}
                        value={m2TiltArcsec}
                        onChange={(e) => setM2TiltArcsec(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">M2 偏心 (mm)</label>
                      <input
                        type="number"
                        step={0.05}
                        value={m2DecenterMm}
                        onChange={(e) => setM2DecenterMm(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                  </div>
                </div>
              ) : runnerTab === 'fits_batch_completeness' ? (
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded space-y-3 text-xs">
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">批量扫频范围 (FITS 组)</label>
                      <select
                        value={batchScope}
                        onChange={(e) => setBatchScope(e.target.value as 'S1_S4' | 'ALL_20' | 'S3_ONLY')}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono"
                      >
                        <option value="S1_S4">S1–S4 校正镜组 (16 帧)</option>
                        <option value="ALL_20">S0–S4 全部光学系统 (20 帧)</option>
                        <option value="S3_ONLY">仅基线 S3 全视场 (4 帧)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">DAOStarFinder FWHM (px)</label>
                      <input
                        type="number"
                        step={0.1}
                        min={0.8}
                        max={6}
                        value={batchFwhmPx}
                        onChange={(e) => setBatchFwhmPx(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">检测阈值 (σ)</label>
                      <input
                        type="number"
                        step={0.5}
                        min={2}
                        max={15}
                        value={batchThresholdSigma}
                        onChange={(e) => setBatchThresholdSigma(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">交叉匹配半径 (px)</label>
                      <input
                        type="number"
                        step={0.5}
                        min={1}
                        max={10}
                        value={batchMatchRadiusPx}
                        onChange={(e) => setBatchMatchRadiusPx(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">超时预算 (秒)</label>
                      <input
                        type="number"
                        min={15}
                        max={90}
                        value={batchTimeoutSec}
                        onChange={(e) => setBatchTimeoutSec(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                  </div>
                </div>
              ) : runnerTab === 'wf_rc_s4_reopt_probe' ? (
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded space-y-3 text-xs">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="sm:col-span-2">
                      <label className="block font-medium text-slate-700 mb-1">S4 (FS + F2 + FS) 重优化诊断策略</label>
                      <select
                        value={s4Strategy}
                        onChange={(e) =>
                          setS4Strategy(
                            e.target.value as
                              | 'unlock_conics_multi_seed'
                              | 'conic_locked_scaled_seed'
                              | 'both_compare',
                          )
                        }
                        className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded font-mono"
                      >
                        <option value="unlock_conics_multi_seed">
                          解锁 Quasi-RC (K1/K2) + 双起点并行对照 (S2/S3 圆锥起点)
                        </option>
                        <option value="conic_locked_scaled_seed">
                          锁定纯 RC 圆锥 + F2 光焦度重定标起点 (验证局部曲率陷阱)
                        </option>
                        <option value="both_compare">
                          双机制交叉对照 (锁定 RC 重定标 vs 解锁 K1/K2)
                        </option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">单种子迭代预算 maxNfev</label>
                      <input
                        type="number"
                        min={15}
                        max={90}
                        step={5}
                        value={s4MaxNfev}
                        onChange={(e) => setS4MaxNfev(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">光瞳采样环数 / 超时预算(s)</label>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          min={3}
                          max={6}
                          value={s4NumRaysOpt}
                          onChange={(e) => setS4NumRaysOpt(Number(e.target.value))}
                          className="w-1/2 px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                        />
                        <input
                          type="number"
                          min={30}
                          max={240}
                          value={s4TimeoutSec}
                          onChange={(e) => setS4TimeoutSec(Number(e.target.value))}
                          className="w-1/2 px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded space-y-3 text-xs">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="md:col-span-2">
                      <label className="block font-medium text-slate-700 mb-1">目标 FITS 科学图像帧</label>
                      <select
                        value={fitsPath}
                        onChange={(e) => setFitsPath(e.target.value)}
                        className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded font-mono"
                      >
                        {fitsCatalog.map((f) => (
                          <option key={f.id} value={f.relativePath}>
                            {f.systemKey} · {f.fieldDeg.toFixed(2)}° — {f.fileName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">星表提取算法</label>
                      <select
                        value={fitsExtractor}
                        onChange={(e) =>
                          setFitsExtractor(
                            e.target.value as 'photutils_DAOStarFinder' | 'sep_extract',
                          )
                        }
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono"
                      >
                        <option value="photutils_DAOStarFinder">Photutils DAOStarFinder</option>
                        <option value="sep_extract">SEP (Source Extractor Python)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">检测核 FWHM (px)</label>
                      <input
                        type="number"
                        step={0.1}
                        min={0.8}
                        max={8}
                        value={fwhmPx}
                        onChange={(e) => setFwhmPx(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">信噪比阈值 (σ)</label>
                      <input
                        type="number"
                        step={0.5}
                        min={1.5}
                        max={20}
                        value={thresholdSigma}
                        onChange={(e) => setThresholdSigma(Number(e.target.value))}
                        className="w-full px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                      />
                    </div>
                    <div>
                      <label className="block font-medium text-slate-700 mb-1">测光孔径半径 (px) / 超时(s)</label>
                      <div className="flex gap-2">
                        <input
                          type="number"
                          step={0.5}
                          value={apertureRadiusPx}
                          onChange={(e) => setApertureRadiusPx(Number(e.target.value))}
                          className="w-1/2 px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                        />
                        <input
                          type="number"
                          min={10}
                          max={90}
                          value={fitsTimeoutSec}
                          onChange={(e) => setFitsTimeoutSec(Number(e.target.value))}
                          className="w-1/2 px-2 py-1.5 bg-white border border-slate-300 rounded font-mono tabular-nums"
                        />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {launchError && (
                <div className="p-2.5 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{launchError}</span>
                </div>
              )}

              {/* Run / Cancel Controls */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-xs text-slate-500">
                  {runnerTab === 'wf_rc_perturb_eval'
                    ? '预计耗时：无补偿 ~3s，M2 垫片+BFL 优化 ~14–18s'
                    : runnerTab === 'fits_batch_completeness'
                      ? '预计耗时：16–20 帧批量 Photutils + SEP 交叉匹配 ~2–4s'
                      : runnerTab === 'wf_rc_s4_reopt_probe'
                        ? '预计耗时：Optiland 0.6.3 多种子 TRF 优化 + Strehl/MTF 评估 ~20–45s'
                        : '预计耗时：Astropy/Photutils/SEP 单帧提取 ~2–3s'}
                </div>
                <div className="flex items-center gap-2">
                  {isJobRunning && activeJob && (
                    <button
                      type="button"
                      onClick={() => onCancelAsyncJob(activeJob.id)}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-rose-700 bg-rose-50 hover:bg-rose-100 border border-rose-200 rounded cursor-pointer"
                    >
                      <Square className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>安全中止任务</span>
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={launching || isJobRunning}
                    onClick={() => handleLaunch()}
                    className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded cursor-pointer"
                  >
                    <Activity className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>
                      {isJobRunning
                        ? 'Python 子进程计算中...'
                        : launching
                          ? '启动中...'
                          : '启动异步 Python 实算并派生分支'}
                    </span>
                  </button>
                </div>
              </div>

              {/* Live Streaming Terminal Log Panel */}
              {displayedJob && (
                <div className="border border-slate-200 rounded overflow-hidden">
                  <div className="px-3 py-2 bg-slate-100 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2 font-mono">
                      <Terminal className="w-3.5 h-3.5 text-slate-700" aria-hidden="true" />
                      <span className="font-semibold text-slate-900">{displayedJob.title}</span>
                      <span className="text-slate-500">({displayedJob.id})</span>
                    </div>
                    <div className="font-mono tabular-nums text-[11px]">
                      <span
                        className={
                          displayedJob.status === 'completed'
                            ? 'text-emerald-700 font-semibold'
                            : displayedJob.status === 'running' || displayedJob.status === 'queued'
                              ? 'text-blue-700 font-semibold'
                              : 'text-rose-700 font-semibold'
                        }
                      >
                        状态: {displayedJob.status}
                      </span>
                      {typeof displayedJob.durationMs === 'number' && (
                        <span className="ml-2 text-slate-500">{displayedJob.durationMs} ms</span>
                      )}
                    </div>
                  </div>
                  <pre className="p-3 bg-slate-950 text-slate-100 font-mono text-[11px] leading-relaxed max-h-60 overflow-y-auto whitespace-pre-wrap">
                    {displayedJob.logs.length > 0
                      ? displayedJob.logs.join('\n')
                      : '等待 Python 无缓冲输出流...'}
                  </pre>
                  {displayedJob.status === 'completed' && displayedJob.resultBranchId && (
                    <div className="px-3 py-2.5 bg-emerald-50 border-t border-emerald-200 flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-emerald-900 font-medium">
                        已创建新分支 ({displayedJob.branchName}) 并登记 SHA-256 产物 ({displayedJob.resultArtifactIds.length} 项)。
                      </span>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => onNavigateToCompare('matrix')}
                          className="px-2.5 py-1 bg-white border border-emerald-300 text-emerald-800 hover:bg-emerald-100 rounded cursor-pointer"
                        >
                          查看对比矩阵
                        </button>
                        {displayedJob.runnerMode === 'fits_star_extract' &&
                          typeof displayedJob.parameters.fitsPath === 'string' && (
                            <button
                              type="button"
                              onClick={() =>
                                onNavigateToCompare('fits', String(displayedJob.parameters.fitsPath))
                              }
                              className="px-2.5 py-1 bg-white border border-blue-300 text-blue-800 hover:bg-blue-50 rounded cursor-pointer"
                            >
                              在 FITS 检查器叠看星点
                            </button>
                          )}
                        <button
                          type="button"
                          onClick={() =>
                            onAdoptBranch(
                              displayedJob.studyId,
                              displayedJob.resultBranchId!,
                              `经真实计算 ${displayedJob.id} 验证后显式采纳`,
                            )
                          }
                          className="px-2.5 py-1 bg-blue-700 text-white hover:bg-blue-800 rounded cursor-pointer font-semibold"
                        >
                          采纳为课题基线
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Right Column: Epistemic Notes Ledger + AI Scientific Collaborator + Open Questions */}
            <div className="space-y-6">
              {/* Open Questions Panel */}
              <section className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
                <h2 className="text-sm font-semibold text-slate-900">
                  待解决开放科学问题 ({activeStudy.openQuestions.length})
                </h2>
                <ul className="space-y-1.5 text-xs">
                  {activeStudy.openQuestions.map((oq) => (
                    <li
                      key={oq.id}
                      className="p-2 bg-slate-50 border border-slate-200 rounded flex items-start justify-between gap-2"
                    >
                      <span className="text-slate-800 leading-relaxed">{oq.question}</span>
                      <span className="font-mono text-[10px] text-amber-700 shrink-0">{oq.status}</span>
                    </li>
                  ))}
                </ul>
                <form onSubmit={handleSubmitQuestion} className="flex gap-2">
                  <input
                    type="text"
                    value={newQuestion}
                    onChange={(e) => setNewQuestion(e.target.value)}
                    placeholder="添加新的开放子问题或待证伪边界..."
                    className="flex-1 px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded"
                  />
                  <button
                    type="submit"
                    disabled={addingQuestion || !newQuestion.trim()}
                    className="px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded cursor-pointer"
                  >
                    添加问题
                  </button>
                </form>
              </section>

              {/* AI Scientific Collaborator */}
              <section className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
                    <Bot className="w-4 h-4 text-violet-700" aria-hidden="true" />
                    <span>实证受限 AI 科研协作者（可一键生成并载入实算提议）</span>
                  </h2>
                </div>
                <p className="text-xs text-slate-500">
                  区分已有事实与待检验假设。例如询问：“为什么 S3 在 0.60° 视场 DAOStarFinder 完备度只有 4.7%？下一步该如何实验验证？”
                </p>
                {aiError && (
                  <div className="p-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800">
                    {aiError}
                  </div>
                )}
                <form onSubmit={handleAskAi} className="space-y-2">
                  <textarea
                    rows={2}
                    value={aiQuestion}
                    onChange={(e) => setAiQuestion(e.target.value)}
                    placeholder="输入需要协同分析的物理冲突、公差策略或观测提取异常..."
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-300 rounded"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        onClick={() =>
                          setAiQuestion('请分析 S4 (FS+F2) 为什么在 Stage 2 卡在 cost=597.635，并建议多起点诊断实算。')
                        }
                        className="px-2 py-1 text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 rounded cursor-pointer"
                      >
                        示例: S4 未收敛诊断
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setAiQuestion(
                            '批量全视场验证 16 帧 FITS 下将 DAOStarFinder fwhm 降至 1.5px 能否对齐 SEP 且不增加假阳性？',
                          )
                        }
                        className="px-2 py-1 text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 rounded cursor-pointer"
                      >
                        示例: 批量 FITS 16帧验证
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setAiQuestion('主镜 ΔR1=1.2mm 偏差下，只调 BFL 能否救回 S3？需要 M2 垫片吗？')
                        }
                        className="px-2 py-1 text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-700 rounded cursor-pointer"
                      >
                        示例: 公差与垫片补偿
                      </button>
                    </div>
                    <button
                      type="submit"
                      disabled={askingAi || !aiQuestion.trim()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-violet-700 hover:bg-violet-800 disabled:opacity-50 rounded cursor-pointer"
                    >
                      <Send className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{askingAi ? '研判中...' : '请求实证分析与提议'}</span>
                    </button>
                  </div>
                </form>
              </section>

              {/* Epistemic Notes Timeline (Fact / Judgment / Hypothesis / Proposal) */}
              <section className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-900">
                    认识论研究记录账本 ({studyNotes.length} 条)
                  </h2>
                  <span className="text-[11px] text-slate-500">严格区分 [事实] [判断] [假设] [提议]</span>
                </div>

                <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
                  {[...studyNotes].reverse().map((note) => {
                    const tagMeta = TAG_META[note.tag] ?? TAG_META.judgment;
                    return (
                      <div key={note.id} className="p-3 border border-slate-200 rounded bg-slate-50/70 space-y-1.5 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5">
                            <span className={`px-1.5 py-0.5 text-[11px] font-semibold border rounded-sm ${tagMeta.cls}`}>
                              {tagMeta.label}
                            </span>
                            <span className="font-semibold text-slate-900">{note.title}</span>
                          </div>
                          <span className="font-mono text-[10px] text-slate-500">
                            {note.authorLabel}
                          </span>
                        </div>
                        <p className="text-slate-700 whitespace-pre-wrap leading-relaxed">{note.content}</p>
                        {note.proposedAction && (
                          <div className="pt-1.5 flex items-center justify-between gap-2 border-t border-slate-200">
                            <span className="text-[11px] font-mono text-violet-800 truncate">
                              可执行提议: {note.proposedAction.label}
                            </span>
                            <button
                              type="button"
                              disabled={isJobRunning}
                              onClick={() => handleLaunch(note.proposedAction!)}
                              className="px-2.5 py-1 text-[11px] font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded shrink-0 cursor-pointer"
                            >
                              载入提议并启动实算
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Add Human Note Form */}
                <form onSubmit={handleSubmitNote} className="pt-2 border-t border-slate-200 space-y-2 text-xs">
                  <div className="flex gap-2">
                    <select
                      value={noteTag}
                      onChange={(e) => setNoteTag(e.target.value as EpistemicTag)}
                      className="px-2 py-1.5 bg-white border border-slate-300 rounded font-medium"
                    >
                      <option value="fact">[事实]</option>
                      <option value="judgment">[判断]</option>
                      <option value="hypothesis">[假设]</option>
                      <option value="proposal">[提议]</option>
                    </select>
                    <input
                      type="text"
                      value={noteTitle}
                      onChange={(e) => setNoteTitle(e.target.value)}
                      placeholder="记录标题..."
                      className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded"
                    />
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={noteContent}
                      onChange={(e) => setNoteContent(e.target.value)}
                      placeholder="追加一条带标签的研究判断、实验观察或反例记录..."
                      className="flex-1 px-2.5 py-1.5 bg-white border border-slate-300 rounded"
                    />
                    <button
                      type="submit"
                      disabled={savingNote || !noteContent.trim()}
                      className="px-3 py-1.5 font-medium text-white bg-slate-800 hover:bg-slate-900 rounded cursor-pointer"
                    >
                      {savingNote ? '写入中...' : '追加记录'}
                    </button>
                  </div>
                </form>
              </section>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

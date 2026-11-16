import { useState } from 'react';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ExternalLink,
  GitBranch,
  Network,
  Play,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import type {
  ComponentDossier,
  ExperimentRun,
  GlassName,
  OpticalSystemSpec,
  RuntimeEnvironmentSnapshot,
  SourceOrigin,
  ThreadEntry,
} from '../core/types.ts';
import { OpticalViewport } from './OpticalViewport.tsx';

interface ExperimentWorkspaceProps {
  components: ComponentDossier[];
  runs: ExperimentRun[];
  thread: ThreadEntry[];
  presets: {
    singlet: OpticalSystemSpec;
    doublet: OpticalSystemSpec;
  };
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
  onExecuteRun: (parentRunId: string | null) => Promise<ExperimentRun | null>;
  isRunning: boolean;
  runError: string | null;
  onInspectComponent: (id: string) => void;
  onInspectInArchitecture: (nodeId: string) => void;
  onReevaluateRun: (runId: string, evaluatorId: string) => Promise<void>;
  onAddNote: (origin: SourceOrigin, title: string, content: string, runId: string | null) => Promise<void>;
  onRequestAiCritique: (question: string) => Promise<void>;
}

const ORIGIN_META: Record<SourceOrigin, { label: string; tone: string }> = {
  user_statement: { label: '用户原话', tone: 'text-slate-900 font-semibold' },
  experiment_run: { label: '真实计算证据', tone: 'text-blue-700 font-semibold' },
  evaluator_verdict: { label: '评价判定', tone: 'text-amber-700 font-semibold' },
  ai_hypothesis: { label: 'AI 推测与质疑（待验证）', tone: 'text-violet-700 font-semibold' },
  adopted_decision: { label: '已采用决策 / 组件变更', tone: 'text-emerald-700 font-semibold' },
};

const GLASS_OPTIONS: GlassName[] = ['AIR', 'N-BK7', 'N-SF11', 'N-F2', 'FUSED_SILICA', 'N-LAK9'];

export function ExperimentWorkspace({
  components,
  runs,
  thread,
  presets,
  aiAvailable,
  runtimeEnv,
  systemSpec,
  onChangeSystemSpec,
  selectedSolverId,
  onChangeSolverId,
  selectedOptimizerId,
  onChangeOptimizerId,
  selectedEvaluatorId,
  onChangeEvaluatorId,
  runMode,
  onChangeRunMode,
  seed,
  onChangeSeed,
  intentText,
  onChangeIntentText,
  branchLabel,
  onChangeBranchLabel,
  onExecuteRun,
  isRunning,
  runError,
  onInspectComponent,
  onInspectInArchitecture,
  onReevaluateRun,
  onAddNote,
  onRequestAiCritique,
}: ExperimentWorkspaceProps) {
  const [viewedRunId, setViewedRunId] = useState<string>(runs[runs.length - 1]?.id ?? '');
  const [reevalTargetId, setReevalTargetId] = useState<string>('eval-mtf-chromatic');
  const [reevalBusy, setReevalBusy] = useState(false);
  const [showHashes, setShowHashes] = useState(false);

  const [noteInput, setNoteInput] = useState('');
  const [noteOrigin, setNoteOrigin] = useState<SourceOrigin>('user_statement');
  const [aiEnabled, setAiEnabled] = useState<boolean>(aiAvailable);
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const viewedRun = runs.find((r) => r.id === viewedRunId) ?? runs[runs.length - 1];
  const solvers = components.filter((c) => c.kind === 'optical_solver');
  const evaluators = components.filter((c) => c.kind === 'evaluator');
  const optimizers = components.filter((c) => c.kind === 'optimizer');

  const activeSolver = solvers.find((s) => s.id === selectedSolverId);
  const activeOpt = optimizers.find((o) => o.id === selectedOptimizerId);
  const activeEval = evaluators.find((e) => e.id === selectedEvaluatorId);

  const updateSurface = (
    idx: number,
    patch: Partial<OpticalSystemSpec['surfaces'][number]>,
  ) => {
    const nextSurfaces = systemSpec.surfaces.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChangeSystemSpec({ ...systemSpec, surfaces: nextSurfaces });
  };

  const handleRunClick = async () => {
    const created = await onExecuteRun(viewedRun?.id ?? null);
    if (created) {
      setViewedRunId(created.id);
    }
  };

  const handleReevaluate = async () => {
    if (!viewedRun) return;
    setReevalBusy(true);
    try {
      await onReevaluateRun(viewedRun.id, reevalTargetId);
    } finally {
      setReevalBusy(false);
    }
  };

  const handleNoteSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteInput.trim()) return;
    await onAddNote(
      noteOrigin,
      noteOrigin === 'user_statement' ? '研究记录 / 人工观察' : '方向决策记录',
      noteInput.trim(),
      viewedRun?.id ?? null,
    );
    setNoteInput('');
  };

  const handleAiSubmit = async () => {
    if (!aiEnabled) return;
    const q = aiQuestion.trim() || '请检查当前最新实验结果与所选评价标准之间是否存在盲区、冲突或未验证前提。';
    setAiLoading(true);
    setAiError(null);
    try {
      await onRequestAiCritique(q);
      setAiQuestion('');
    } catch (err) {
      setAiError(err instanceof Error ? err.message : String(err));
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="max-w-[1440px] mx-auto px-6 py-5 space-y-5">
      {/* Environment Honesty Banner */}
      <div className="bg-white border border-slate-200 rounded-md px-4 py-2.5 flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2 text-slate-700">
          <span className="font-semibold text-slate-900">
            运行环境：{runtimeEnv.hostMode === 'local_python_ready' ? '本地 Python 3.11+ / Optiland 已就绪' : '云端受限预览'}
          </span>
          <span aria-hidden="true">·</span>
          <span className="font-mono text-slate-600">
            Node {runtimeEnv.nodeVersion} · Python {runtimeEnv.pythonVersion ?? '未检出'} · Optiland{' '}
            {runtimeEnv.optilandVersion ?? '未安装'}
          </span>
          {runtimeEnv.hostMode !== 'local_python_ready' && (
            <>
              <span aria-hidden="true">·</span>
              <span className="text-amber-800">
                当前容器无 Optiland，仅受限 TS 预览求解器可用于联调；完整工程项目与安装说明见根目录 README_LOCAL.md。
              </span>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => onInspectInArchitecture('scope:runtime-host')}
          className="inline-flex items-center gap-1 text-blue-700 hover:underline cursor-pointer shrink-0"
        >
          <Network className="w-3.5 h-3.5" aria-hidden="true" />
          <span>在架构地图查看环境状态</span>
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[370px_1fr] gap-6 items-start">
        {/* Left Column: Optical System Parameters + Flexible Component Composition */}
        <aside className="bg-white border border-slate-200 rounded-md divide-y divide-slate-200">
          {/* 1. Optical System Spec */}
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">1. 光学结构参数</h2>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onChangeSystemSpec(presets.singlet)}
                  className="px-2 py-1 text-[11px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                >
                  单透镜
                </button>
                <button
                  type="button"
                  onClick={() => onChangeSystemSpec(presets.doublet)}
                  className="px-2 py-1 text-[11px] font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                >
                  双胶合
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div>
                <label htmlFor="target-efl" className="block text-slate-500 mb-1">
                  目标焦距 (mm)
                </label>
                <input
                  id="target-efl"
                  type="number"
                  value={systemSpec.targetEflMm}
                  onChange={(e) =>
                    onChangeSystemSpec({ ...systemSpec, targetEflMm: Number(e.target.value) || 100 })
                  }
                  className="w-full px-2.5 py-1.5 font-mono bg-slate-50 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label htmlFor="pupil-diam" className="block text-slate-500 mb-1">
                  入瞳直径 (mm)
                </label>
                <input
                  id="pupil-diam"
                  type="number"
                  value={systemSpec.entrancePupilDiameterMm}
                  onChange={(e) =>
                    onChangeSystemSpec({
                      ...systemSpec,
                      entrancePupilDiameterMm: Math.max(4, Number(e.target.value) || 25),
                    })
                  }
                  className="w-full px-2.5 py-1.5 font-mono bg-slate-50 border border-slate-300 rounded"
                />
              </div>
            </div>

            <div className="space-y-2 pt-1">
              {systemSpec.surfaces.map((surf, idx) => (
                <div key={surf.id} className="p-2.5 bg-slate-50 border border-slate-200 rounded space-y-2 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-slate-800">{surf.label}</span>
                    <label className="inline-flex items-center gap-1 text-[11px] text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(surf.variableRadius)}
                        onChange={(e) => updateSurface(idx, { variableRadius: e.target.checked })}
                      />
                      <span>可调曲率</span>
                    </label>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    <div>
                      <span className="text-[10px] text-slate-500 block">半径 R (mm)</span>
                      <input
                        type="number"
                        step="0.5"
                        aria-label={`${surf.label} 曲率半径`}
                        value={surf.radiusMm ?? 0}
                        onChange={(e) => updateSurface(idx, { radiusMm: Number(e.target.value) })}
                        className="w-full px-1.5 py-1 font-mono bg-white border border-slate-300 rounded"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 block">厚度 T (mm)</span>
                      <input
                        type="number"
                        step="0.5"
                        aria-label={`${surf.label} 厚度`}
                        value={surf.thicknessMm}
                        onChange={(e) => updateSurface(idx, { thicknessMm: Number(e.target.value) })}
                        className="w-full px-1.5 py-1 font-mono bg-white border border-slate-300 rounded"
                      />
                    </div>
                    <div>
                      <span className="text-[10px] text-slate-500 block">后方介质</span>
                      <select
                        aria-label={`${surf.label} 介质`}
                        value={surf.glassAfter}
                        onChange={(e) => updateSurface(idx, { glassAfter: e.target.value as GlassName })}
                        className="w-full px-1 py-1 font-mono bg-white border border-slate-300 rounded"
                      >
                        {GLASS_OPTIONS.map((g) => (
                          <option key={g} value={g}>
                            {g}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 2. Flexible Component Composition */}
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-900">2. 选择与组合独立组件</h2>
              <span className="text-[11px] text-slate-500">组件也可独立运行</span>
            </div>

            {/* Optical Solver selector */}
            <div className="space-y-1 text-xs">
              <div className="flex items-center justify-between">
                <label htmlFor="select-solver" className="text-slate-500">
                  物理求解器 (Solver)
                </label>
                {activeSolver && (
                  <button
                    type="button"
                    onClick={() => onInspectComponent(activeSolver.id)}
                    className="inline-flex items-center gap-1 text-blue-700 hover:underline cursor-pointer"
                  >
                    <span>档案 ({activeSolver.activeVersion})</span>
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                  </button>
                )}
              </div>
              <select
                id="select-solver"
                value={selectedSolverId}
                onChange={(e) => onChangeSolverId(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded"
              >
                {solvers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.activeVersion})
                    {s.runtime === 'local_process_py' && !runtimeEnv.optilandVersion ? ' [当前环境缺 Optiland]' : ''}
                  </option>
                ))}
              </select>
            </div>

            {/* Evaluator selector */}
            <div className="space-y-1 text-xs">
              <div className="flex items-center justify-between">
                <label htmlFor="select-evaluator" className="text-slate-500">
                  评价标准组件 (Evaluator)
                </label>
                {activeEval && (
                  <button
                    type="button"
                    onClick={() => onInspectComponent(activeEval.id)}
                    className="inline-flex items-center gap-1 text-blue-700 hover:underline cursor-pointer"
                  >
                    <span>档案 ({activeEval.activeVersion})</span>
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                  </button>
                )}
              </div>
              <select
                id="select-evaluator"
                value={selectedEvaluatorId}
                onChange={(e) => onChangeEvaluatorId(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded"
              >
                {evaluators.map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.name} ({ev.activeVersion})
                  </option>
                ))}
              </select>
            </div>

            {/* Optimizer selector */}
            <div className="space-y-1 text-xs">
              <div className="flex items-center justify-between">
                <label htmlFor="select-optimizer" className="text-slate-500">
                  优化策略组件 (Optimizer)
                </label>
                {activeOpt && (
                  <button
                    type="button"
                    onClick={() => onInspectComponent(activeOpt.id)}
                    className="inline-flex items-center gap-1 text-blue-700 hover:underline cursor-pointer"
                  >
                    <span>档案 ({activeOpt.activeVersion})</span>
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                  </button>
                )}
              </div>
              <select
                id="select-optimizer"
                value={selectedOptimizerId}
                onChange={(e) => onChangeOptimizerId(e.target.value)}
                disabled={runMode === 'solve_only'}
                className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded disabled:opacity-50"
              >
                {optimizers.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.name} ({opt.activeVersion})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* 3. Run Trigger, Mode, Seed & Intent */}
          <div className="p-4 space-y-3">
            <h2 className="text-sm font-semibold text-slate-900">3. 设定模式、种子并执行</h2>
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-md">
              <button
                type="button"
                onClick={() => onChangeRunMode('optimize')}
                className={`flex-1 py-1.5 text-xs font-medium rounded cursor-pointer ${
                  runMode === 'optimize' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                运行参数优化
              </button>
              <button
                type="button"
                onClick={() => onChangeRunMode('solve_only')}
                className={`flex-1 py-1.5 text-xs font-medium rounded cursor-pointer ${
                  runMode === 'solve_only' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
                }`}
              >
                仅光学求解评价
              </button>
            </div>

            <div className="grid grid-cols-[1fr_100px] gap-2">
              <div>
                <label htmlFor="branch-label" className="block text-xs text-slate-500 mb-1">
                  分支名称
                </label>
                <input
                  id="branch-label"
                  type="text"
                  placeholder="例如：分支 B · 严格色差约束优化"
                  value={branchLabel}
                  onChange={(e) => onChangeBranchLabel(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label htmlFor="experiment-seed" className="block text-xs text-slate-500 mb-1">
                  随机种子
                </label>
                <input
                  id="experiment-seed"
                  type="number"
                  value={seed}
                  onChange={(e) => onChangeSeed(Number(e.target.value) || 0)}
                  className="w-full px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded"
                />
              </div>
            </div>

            <div>
              <label htmlFor="experiment-intent" className="block text-xs text-slate-500 mb-1">
                本次尝试的假设或意图
              </label>
              <textarea
                id="experiment-intent"
                rows={2}
                placeholder="说明为什么要修改这些参数或更换组件..."
                value={intentText}
                onChange={(e) => onChangeIntentText(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded"
              />
            </div>

            {runError && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" />
                <span>{runError}</span>
              </div>
            )}

            <button
              type="button"
              onClick={handleRunClick}
              disabled={isRunning}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-md cursor-pointer"
            >
              <Play className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{isRunning ? '正在子进程执行真实计算...' : '执行并写入不可变账本'}</span>
            </button>
          </div>
        </aside>

        {/* Main Stage */}
        <main className="space-y-5 min-w-0">
          {/* Run Switcher Ribbon */}
          <div className="bg-white border border-slate-200 rounded-md p-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 overflow-x-auto">
              <span className="text-xs font-medium text-slate-500 shrink-0">历史运行谱系：</span>
              {runs.map((r) => {
                const active = viewedRun?.id === r.id;
                const latestEv = r.evaluations[r.evaluations.length - 1];
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setViewedRunId(r.id)}
                    className={`px-3 py-1.5 text-xs font-mono rounded border whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-blue-50 border-blue-600 text-blue-800 font-semibold'
                        : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    #{r.sequenceNumber} · {r.branchLabel}{' '}
                    {latestEv ? (latestEv.passed ? '✓' : '!') : ''}
                  </button>
                );
              })}
            </div>
            {viewedRun && (
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => onInspectInArchitecture(`run:${viewedRun.id}`)}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                >
                  <Network className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>在架构图查看</span>
                </button>
                <button
                  type="button"
                  onClick={() => onChangeSystemSpec(viewedRun.systemAfter)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                >
                  <GitBranch className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>从此结果派生分支</span>
                </button>
              </div>
            )}
          </div>

          {viewedRun && (
            <>
              {/* Reproducibility & Integrity Strip */}
              <div className="bg-white border border-slate-200 rounded-md px-4 py-2.5 text-xs space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex flex-wrap items-center gap-2 font-mono text-slate-700">
                    <span className="inline-flex items-center gap-1 font-sans font-semibold">
                      {viewedRun.tamperStatus === 'verified' ? (
                        <>
                          <ShieldCheck className="w-4 h-4 text-emerald-700" aria-hidden="true" />
                          <span className="text-emerald-800">SHA-256 完整性已校验</span>
                        </>
                      ) : viewedRun.tamperStatus === 'tampered' ? (
                        <>
                          <ShieldAlert className="w-4 h-4 text-rose-700" aria-hidden="true" />
                          <span className="text-rose-800">警告：账本记录校验失败（可能已被篡改）</span>
                        </>
                      ) : (
                        <span className="text-amber-700">历史无指纹记录</span>
                      )}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>引擎={viewedRun.rawArtifactsAfter.solverEngine ?? 'ts_preview'}</span>
                    <span aria-hidden="true">·</span>
                    <span>seed={viewedRun.seed}</span>
                    <span aria-hidden="true">·</span>
                    <span>
                      组合={viewedRun.composition.parts.map((p) => `${p.componentId}@${p.version}`).join(' + ')}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setShowHashes((v) => !v)}
                    className="text-blue-700 hover:underline cursor-pointer shrink-0"
                  >
                    {showHashes ? '隐藏完整 64 位指纹' : '查看 64 位 SHA-256 指纹与环境'}
                  </button>
                </div>
                {showHashes && (
                  <div className="pt-2 border-t border-slate-100 grid grid-cols-1 md:grid-cols-2 gap-2 font-mono text-[11px] text-slate-600 break-all">
                    <div>inputHash: {viewedRun.inputHash}</div>
                    <div>rawArtifactsHash: {viewedRun.rawArtifactsHash}</div>
                    <div>recordIntegrityHash: {viewedRun.recordIntegrityHash}</div>
                    <div>
                      runtimeEnv: Node {viewedRun.runtimeEnv.nodeVersion} · Python{' '}
                      {viewedRun.runtimeEnv.pythonVersion ?? 'none'} · Optiland{' '}
                      {viewedRun.runtimeEnv.optilandVersion ?? 'none'}
                    </div>
                  </div>
                )}
              </div>

              {/* Quantitative Metrics Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="bg-white border border-slate-200 rounded-md p-3.5">
                  <div className="text-[11px] text-slate-500">有效焦距 EFL</div>
                  <div className="mt-1 text-xl font-mono font-semibold text-slate-900 tabular-nums">
                    {viewedRun.rawArtifactsAfter.paraxialEflMm.toFixed(2)}
                    <span className="text-xs text-slate-400 ml-1">mm</span>
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-md p-3.5">
                  <div className="text-[11px] text-slate-500">RMS 光斑半径</div>
                  <div className="mt-1 text-xl font-mono font-semibold text-slate-900 tabular-nums">
                    {viewedRun.rawArtifactsAfter.rmsSpotRadiusUm.toFixed(1)}
                    <span className="text-xs text-slate-400 ml-1">μm</span>
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-md p-3.5">
                  <div className="text-[11px] text-slate-500">F-C 轴向色差</div>
                  <div className="mt-1 text-xl font-mono font-semibold text-slate-900 tabular-nums">
                    {viewedRun.rawArtifactsAfter.axialChromaticShiftMm.toFixed(3)}
                    <span className="text-xs text-slate-400 ml-1">mm</span>
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-md p-3.5">
                  <div className="text-[11px] text-slate-500">MTF @ 30 lp/mm</div>
                  <div className="mt-1 text-xl font-mono font-semibold text-slate-900 tabular-nums">
                    {viewedRun.rawArtifactsAfter.mtf30LpMm.toFixed(3)}
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-md p-3.5">
                  <div className="text-[11px] text-slate-500">追迹异常光线</div>
                  <div className="mt-1 text-xl font-mono font-semibold text-slate-900 tabular-nums">
                    {viewedRun.rawArtifactsAfter.clippedRayCount + viewedRun.rawArtifactsAfter.tirRayCount}
                    <span className="text-xs text-slate-400 ml-1">/ {viewedRun.rawArtifactsAfter.totalRayCount}</span>
                  </div>
                </div>
              </div>

              {/* Evaluator Verdicts + Non-Destructive Re-Evaluation Bar */}
              <div className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-100">
                  <div>
                    <h3 className="text-sm font-semibold text-slate-900">
                      Run #{viewedRun.sequenceNumber} · 评价判定记录（基于不可变原始产物，支持事后追加重评）
                    </h3>
                    <p className="text-xs text-slate-500 mt-0.5">
                      实验意图：{viewedRun.intent}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <label htmlFor="reeval-select" className="sr-only">
                      选择重评组件
                    </label>
                    <select
                      id="reeval-select"
                      value={reevalTargetId}
                      onChange={(e) => setReevalTargetId(e.target.value)}
                      className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded"
                    >
                      {evaluators.map((ev) => (
                        <option key={ev.id} value={ev.id}>
                          {ev.name} ({ev.activeVersion})
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleReevaluate}
                      disabled={reevalBusy}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                    >
                      <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                      <span>{reevalBusy ? '重评中...' : '用此评价器重评（不重算）'}</span>
                    </button>
                  </div>
                </div>

                <div className="space-y-3">
                  {viewedRun.evaluations.map((verdict, idx) => {
                    const icon =
                      verdict.status === 'pass' ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" aria-hidden="true" />
                      ) : verdict.status === 'warning' || verdict.status === 'insufficient_artifacts' ? (
                        <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
                      ) : (
                        <XCircle className="w-4 h-4 text-rose-700 shrink-0" aria-hidden="true" />
                      );
                    const tone =
                      verdict.status === 'pass'
                        ? 'text-emerald-800 bg-emerald-50/70 border-emerald-200'
                        : verdict.status === 'warning' || verdict.status === 'insufficient_artifacts'
                          ? 'text-amber-800 bg-amber-50/70 border-amber-200'
                          : 'text-rose-800 bg-rose-50/70 border-rose-200';
                    const statusLabel =
                      verdict.status === 'pass'
                        ? '通过'
                        : verdict.status === 'warning'
                          ? '部分警告'
                          : verdict.status === 'insufficient_artifacts'
                            ? '缺少产物 · 拒绝推测'
                            : '未通过';
                    return (
                      <div key={verdict.id} className={`p-3 border rounded text-xs space-y-2 ${tone}`}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 font-semibold">
                            {icon}
                            <span>
                              判定 #{idx + 1} · {verdict.evaluatorName} ({verdict.evaluatorVersion}) — {statusLabel}
                            </span>
                          </div>
                          <span className="font-mono">
                            lossScore = {verdict.lossScore === null ? 'N/A (拒绝推测)' : verdict.lossScore}
                          </span>
                        </div>
                        <p>{verdict.summary}</p>
                        {verdict.missingArtifacts && verdict.missingArtifacts.length > 0 && (
                          <div className="font-mono text-[11px] bg-white/80 border border-amber-300 rounded px-2.5 py-1.5">
                            缺失原始字段：{verdict.missingArtifacts.join(', ')}
                          </div>
                        )}
                        {verdict.checks.length > 0 && (
                          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 pt-1">
                            {verdict.checks.map((chk, ci) => (
                              <div key={ci} className="bg-white/80 border border-slate-200/80 rounded px-2.5 py-1.5 text-[11px] font-mono text-slate-700">
                                <div className="font-sans text-slate-500">{chk.criterion}</div>
                                <div className="mt-0.5 font-semibold text-slate-900">
                                  {chk.measured}{' '}
                                  <span className={chk.passed ? 'text-emerald-700' : 'text-rose-700'}>
                                    ({chk.passed ? '✓' : '✖'} {chk.threshold})
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {verdict.uncertainties.length > 0 && (
                          <div className="text-[11px] text-slate-600 pt-1">
                            未验证边界：{verdict.uncertainties.join('；')}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Standalone Analyses attached to this run */}
              {viewedRun.standaloneAnalyses && viewedRun.standaloneAnalyses.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-md p-4 space-y-2">
                  <h3 className="text-sm font-semibold text-slate-900">
                    独立组件事后分析记录 (Standalone Analyses)
                  </h3>
                  <div className="space-y-2">
                    {viewedRun.standaloneAnalyses.map((sa) => (
                      <div key={sa.id} className="p-3 bg-slate-50 border border-slate-200 rounded text-xs space-y-1">
                        <div className="flex items-center justify-between font-mono text-slate-700">
                          <span className="font-sans font-semibold text-slate-900">
                            {sa.componentName} ({sa.version})
                          </span>
                          <span>hash:{sa.codeHash.slice(0, 12)}...</span>
                        </div>
                        <pre className="text-[11px] font-mono text-slate-700 overflow-x-auto whitespace-pre-wrap">
                          {JSON.stringify(sa.output, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Optical Ray-Trace, Spot Diagram & MTF */}
              <OpticalViewport spec={viewedRun.systemAfter} trace={viewedRun.rawArtifactsAfter} />
            </>
          )}

          {/* Source-Attributed Research Thread + Pluggable AI Collaborator */}
          <section className="bg-white border border-slate-200 rounded-md p-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  研究脉络与来源区分记录（保留原始出处，不覆盖历史）
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  严格区分「用户原话 / 真实计算证据 / 评价判定 / AI 推测与质疑 / 已采用决策」
                </p>
              </div>
              <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={aiEnabled}
                  onChange={(e) => setAiEnabled(e.target.checked)}
                />
                <span>启用 AI 协作者（{aiAvailable ? '服务端模型已就绪' : '未检测到 Key · 仅离线可用'}）</span>
              </label>
            </div>

            <div className="space-y-3 max-h-96 overflow-y-auto pr-1">
              {thread.map((entry) => {
                const meta = ORIGIN_META[entry.origin];
                return (
                  <article key={entry.id} className="pb-3 border-b border-slate-100 last:border-b-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                      <span className={meta.tone}>{meta.label}</span>
                      <span aria-hidden="true">·</span>
                      <span>{entry.authorLabel}</span>
                      {entry.runId && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{entry.runId}</span>
                        </>
                      )}
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{new Date(entry.createdAt).toLocaleTimeString('zh-CN')}</span>
                    </div>
                    <h4 className="text-sm font-medium text-slate-900">{entry.title}</h4>
                    <p className="text-xs text-slate-700 whitespace-pre-wrap leading-relaxed">{entry.content}</p>
                  </article>
                );
              })}
            </div>

            {/* Add Note + Optional AI Critique Controls */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-3 border-t border-slate-200">
              <form onSubmit={handleNoteSubmit} className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="manual-note" className="text-xs font-medium text-slate-700">
                    记录你的观察或决策
                  </label>
                  <select
                    aria-label="记录来源类型"
                    value={noteOrigin}
                    onChange={(e) => setNoteOrigin(e.target.value as SourceOrigin)}
                    className="text-xs bg-slate-50 border border-slate-300 rounded px-2 py-0.5"
                  >
                    <option value="user_statement">用户原话 / 问题</option>
                    <option value="adopted_decision">已采用决策</option>
                  </select>
                </div>
                <div className="flex gap-2">
                  <input
                    id="manual-note"
                    type="text"
                    placeholder="写下你的判断、质疑或想调整的方向..."
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    className="flex-1 px-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                  >
                    <Send className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>记入脉络</span>
                  </button>
                </div>
              </form>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="ai-critique-input" className="text-xs font-medium text-slate-700">
                    可选 AI 协作（找反例 / 指出未验证假设）
                  </label>
                  {!aiEnabled && (
                    <span className="text-[11px] text-slate-500">当前为纯确定性离线模式</span>
                  )}
                </div>
                <div className="flex gap-2">
                  <input
                    id="ai-critique-input"
                    type="text"
                    disabled={!aiEnabled || aiLoading}
                    placeholder={aiEnabled ? '问 AI：这套结果漏了什么约束？下一步改哪个组件？' : '勾选上方“启用 AI 协作者”即可提问'}
                    value={aiQuestion}
                    onChange={(e) => setAiQuestion(e.target.value)}
                    className="flex-1 px-3 py-1.5 text-xs bg-slate-50 border border-slate-300 rounded disabled:opacity-50"
                  />
                  <button
                    type="button"
                    onClick={handleAiSubmit}
                    disabled={!aiEnabled || aiLoading}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-slate-800 hover:bg-slate-900 disabled:opacity-40 rounded cursor-pointer"
                  >
                    <Bot className="w-3.5 h-3.5" aria-hidden="true" />
                    <span>{aiLoading ? '分析中...' : '请 AI 质疑'}</span>
                  </button>
                </div>
                {aiError && <p className="text-xs text-rose-700">{aiError}</p>}
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}

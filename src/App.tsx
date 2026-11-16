import { useCallback, useEffect, useState } from 'react';
import type {
  ComponentDossier,
  ExperimentRun,
  OpticalSystemSpec,
  RuntimeEnvironmentSnapshot,
  SourceOrigin,
  ThreadEntry,
} from './core/types.ts';
import { TopBar, type WorkspaceTab } from './components/TopBar.tsx';
import { ExperimentWorkspace } from './components/ExperimentWorkspace.tsx';
import { ComponentLibrary } from './components/ComponentLibrary.tsx';
import { RunComparison } from './components/RunComparison.tsx';
import { ArchitectureMapView } from './components/ArchitectureMapView.tsx';

interface BootstrapPayload {
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
  const [components, setComponents] = useState<ComponentDossier[]>([]);
  const [runs, setRuns] = useState<ExperimentRun[]>([]);
  const [thread, setThread] = useState<ThreadEntry[]>([]);
  const [presets, setPresets] = useState<BootstrapPayload['presets'] | null>(null);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [runtimeEnv, setRuntimeEnv] = useState<RuntimeEnvironmentSnapshot | null>(null);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Active experiment workbench state
  const [systemSpec, setSystemSpec] = useState<OpticalSystemSpec | null>(null);
  const [specEpoch, setSpecEpoch] = useState(0);
  const [selectedSolverId, setSelectedSolverId] = useState('solver-ts-preview');
  const [selectedOptimizerId, setSelectedOptimizerId] = useState('opt-coordinate-refine');
  const [selectedEvaluatorId, setSelectedEvaluatorId] = useState('eval-rms-spot');
  const [runMode, setRunMode] = useState<'solve_only' | 'optimize'>('optimize');
  const [seed, setSeed] = useState<number>(42);
  const [intentText, setIntentText] = useState('用当前优化策略与评价标准调整曲率半径，观察光斑与焦距变化');
  const [branchLabel, setBranchLabel] = useState('主线优化尝试');
  const [isRunning, setIsRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [selectedComponentId, setSelectedComponentId] = useState<string | null>(null);
  const [archFocusNodeId, setArchFocusNodeId] = useState<string | null>(null);

  const handleUpdateSystemSpec = (next: OpticalSystemSpec) => {
    setSpecEpoch((e) => e + 1);
    setSystemSpec(next);
  };

  const fetchBootstrap = useCallback(async () => {
    try {
      const res = await fetch('/api/bootstrap');
      const data = (await res.json()) as BootstrapPayload & { error?: string };
      if (!res.ok) throw new Error(data.error || '加载工作台失败');
      setComponents(data.components);
      setRuns(data.runs);
      setThread(data.thread);
      setPresets(data.presets);
      setAiAvailable(data.aiAvailable);
      setRuntimeEnv(data.runtimeEnv);
      setSystemSpec((prev) => prev ?? data.runs[data.runs.length - 1]?.systemAfter ?? data.presets.singlet);
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

  const handleExecuteRun = async (parentRunId: string | null): Promise<ExperimentRun | null> => {
    if (!systemSpec) return null;
    const launchEpoch = specEpoch;
    setIsRunning(true);
    setRunError(null);
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
      return data.run as ExperimentRun;
    } catch (err) {
      setRunError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setIsRunning(false);
    }
  };

  const handleQuickRunFromTopBar = async () => {
    setActiveTab('experiment');
    await handleExecuteRun(runs[runs.length - 1]?.id ?? null);
  };

  const handleReevaluateRun = async (runId: string, evaluatorId: string) => {
    setRunError(null);
    const res = await fetch(`/api/experiments/${encodeURIComponent(runId)}/reevaluate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ evaluatorId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setRunError(data.error || '重评失败');
      return;
    }
    setRuns((prev) => prev.map((r) => (r.id === runId ? (data.run as ExperimentRun) : r)));
    setThread((prev) => [...prev, data.entry as ThreadEntry]);
  };

  const handleAddNote = async (
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

  const handleRequestAiCritique = async (question: string) => {
    const res = await fetch('/api/ai/critique', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || 'AI 协作请求失败');
    }
    if (data.entry) {
      setThread((prev) => [...prev, data.entry as ThreadEntry]);
    }
  };

  const handleInspectComponent = (id: string) => {
    setSelectedComponentId(id);
    setActiveTab('components');
  };

  const handleInspectInArchitecture = (nodeId: string) => {
    setArchFocusNodeId(nodeId);
    setActiveTab('architecture');
  };

  const handleJumpFromArchitecture = (target: {
    tab: 'experiment' | 'components' | 'compare' | 'architecture';
    targetId: string;
  }) => {
    if (target.tab === 'components') {
      setSelectedComponentId(target.targetId);
    }
    setActiveTab(target.tab);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-slate-600 font-mono">
        正在加载 OpenLab Bench 与组件档案...
      </div>
    );
  }

  if (loadError || !presets || !systemSpec || !runtimeEnv) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-md bg-white border border-rose-200 rounded-md p-6 space-y-3 text-sm">
          <div className="font-semibold text-rose-800">工作台初始化失败</div>
          <p className="text-slate-600">{loadError || '缺少预设光学配置或运行环境信息'}</p>
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

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <TopBar
        activeTab={activeTab}
        onSelectTab={setActiveTab}
        onQuickRun={handleQuickRunFromTopBar}
        isRunning={isRunning}
      />

      <div className="flex-1">
        {activeTab === 'experiment' && (
          <ExperimentWorkspace
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
            onExecuteRun={handleExecuteRun}
            isRunning={isRunning}
            runError={runError}
            onInspectComponent={handleInspectComponent}
            onInspectInArchitecture={handleInspectInArchitecture}
            onReevaluateRun={handleReevaluateRun}
            onAddNote={handleAddNote}
            onRequestAiCritique={handleRequestAiCritique}
          />
        )}

        {activeTab === 'components' && (
          <ComponentLibrary
            components={components}
            runs={runs}
            selectedId={selectedComponentId}
            onSelectId={setSelectedComponentId}
            onInspectInArchitecture={handleInspectInArchitecture}
            onRefresh={fetchBootstrap}
          />
        )}

        {activeTab === 'compare' && <RunComparison runs={runs} />}

        {activeTab === 'architecture' && (
          <ArchitectureMapView
            initialFocusNodeId={archFocusNodeId}
            onJumpToTarget={handleJumpFromArchitecture}
          />
        )}
      </div>
    </div>
  );
}

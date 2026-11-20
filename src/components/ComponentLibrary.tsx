import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Copy,
  FlaskConical,
  Network,
  Play,
  Plus,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type { ComponentDossier, ExperimentRun } from '../core/types.ts';
import type { DiscoveredPythonRuntime } from './ResearchStudio.tsx';

interface ComponentLibraryProps {
  components: ComponentDossier[];
  runs: ExperimentRun[];
  selectedId: string | null;
  onSelectId: (id: string) => void;
  onInspectInArchitecture: (nodeId: string) => void;
  onRefresh: () => Promise<void>;
  pythonRuntime?: DiscoveredPythonRuntime;
}

const KIND_LABELS: Record<string, string> = {
  optical_solver: '光学物理求解器',
  evaluator: '评价标准组件',
  optimizer: '优化策略组件',
  architecture_map: '整体架构地图引擎',
  analysis_plugin: '独立分析插件',
  fits_analyzer: 'FITS 观测解析 (阶段二)',
};

function selfCheckLabel(status: ComponentDossier['selfCheck']['status']): { text: string; tone: string } {
  switch (status) {
    case 'passed':
      return { text: '✓ 自检通过', tone: 'text-emerald-700' };
    case 'failed':
      return { text: '✖ 自检失败', tone: 'text-rose-700' };
    case 'env_unavailable':
      return { text: '○ 当前环境不可用', tone: 'text-amber-700' };
    default:
      return { text: '○ 尚未运行 / 已过期', tone: 'text-amber-700' };
  }
}

function sciValidationLabel(status: ComponentDossier['scientificValidation']['status']): {
  text: string;
  tone: string;
} {
  switch (status) {
    case 'validated_reference':
      return { text: '已对标参考基准', tone: 'text-emerald-700' };
    case 'limited_preview':
      return { text: '受限预览模型', tone: 'text-amber-700' };
    default:
      return { text: '尚未实证标定', tone: 'text-slate-700' };
  }
}

function securityLabel(status: ComponentDossier['codeSecurityReview']['status']): {
  text: string;
  tone: string;
} {
  switch (status) {
    case 'builtin_reviewed':
      return { text: '内置基线已核对', tone: 'text-emerald-700' };
    case 'user_approved_hash':
      return { text: '用户已确认 64 位哈希', tone: 'text-blue-700' };
    default:
      return { text: '代码已改 · 未经哈希确认 (已禁止执行)', tone: 'text-rose-700' };
  }
}

export function ComponentLibrary({
  components,
  runs,
  selectedId,
  onSelectId,
  onInspectInArchitecture,
  onRefresh,
  pythonRuntime,
}: ComponentLibraryProps) {
  const activeId = selectedId || components[0]?.id || '';
  const [dossier, setDossier] = useState<ComponentDossier | null>(null);
  const [codeByVersion, setCodeByVersion] = useState<Record<string, string>>({});
  const [inspectVersion, setInspectVersion] = useState<string>('v0.1');

  // Create new component drawer state
  const [showCreateComp, setShowCreateComp] = useState(false);
  const [newCompId, setNewCompId] = useState('');
  const [newCompName, setNewCompName] = useState('');
  const [newCompKind, setNewCompKind] = useState('analysis_plugin');
  const [newCompRuntime, setNewCompRuntime] = useState<'local_process_mjs' | 'local_process_py'>('local_process_mjs');
  const [newCompSummary, setNewCompSummary] = useState('');
  const [newCompCode, setNewCompCode] = useState(
`export async function main(input) {
  if (process.argv.includes('--check')) {
    console.log(JSON.stringify({ ok: true, summary: '自定义组件自检通过' }));
    return;
  }
  console.log(JSON.stringify({ ok: true, echoedInput: input }));
}
`,
  );
  const [creatingComp, setCreatingComp] = useState(false);

  // Fork editor state
  const [isForking, setIsForking] = useState(false);
  const [newVersionTag, setNewVersionTag] = useState('v0.2');
  const [changeSummary, setChangeSummary] = useState('');
  const [draftCode, setDraftCode] = useState('');
  const [draftParams, setDraftParams] = useState<Record<string, number | string | boolean>>({});
  const [saving, setSaving] = useState(false);

  // Action states
  const [checking, setChecking] = useState(false);
  const [standaloneOpen, setStandaloneOpen] = useState(false);
  const [standaloneRunId, setStandaloneRunId] = useState<string>(runs[0]?.id ?? '');
  const [standaloneBusy, setStandaloneBusy] = useState(false);
  const [standaloneResult, setStandaloneResult] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const prevActiveIdRef = useRef<string>('');

  useEffect(() => {
    if (!standaloneRunId && runs[0]?.id) {
      setStandaloneRunId(runs[0].id);
    }
  }, [runs, standaloneRunId]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    const isSwitchingComponent = prevActiveIdRef.current !== activeId;
    prevActiveIdRef.current = activeId;

    if (isSwitchingComponent) {
      setErrorMsg(null);
      setActionMsg(null);
      setIsForking(false);
      setStandaloneResult(null);
    }

    fetch(`/api/components/${encodeURIComponent(activeId)}`)
      .then((r) => r.json())
      .then((data: { dossier: ComponentDossier; codeByVersion: Record<string, string> }) => {
        if (cancelled) return;
        setDossier(data.dossier);
        setCodeByVersion(data.codeByVersion);
        if (isSwitchingComponent) {
          setInspectVersion(data.dossier.activeVersion);
          const curVer = data.dossier.versions.find((v) => v.version === data.dossier.activeVersion);
          setDraftParams({ ...(curVer?.params ?? {}) });
          setDraftCode(data.codeByVersion[data.dossier.activeVersion] ?? '');
        }
      })
      .catch((err) => {
        if (!cancelled) setErrorMsg(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
    };
  }, [activeId, components]);

  const currentVersionRecord =
    dossier?.versions.find((v) => v.version === inspectVersion) ?? dossier?.versions[0];

  const startFork = () => {
    if (!dossier || !currentVersionRecord) return;
    const nextNum = dossier.versions.length + 1;
    setNewVersionTag(`v0.${nextNum}`);
    setChangeSummary('');
    setDraftCode(codeByVersion[currentVersionRecord.version] ?? '');
    setDraftParams({ ...currentVersionRecord.params });
    setIsForking(true);
    setErrorMsg(null);
    setActionMsg(null);
  };

  const handleSaveFork = async () => {
    if (!dossier || !currentVersionRecord) return;
    setSaving(true);
    setErrorMsg(null);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/components/${encodeURIComponent(dossier.id)}/fork`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseVersion: currentVersionRecord.version,
          newVersion: newVersionTag.trim(),
          changeSummary: changeSummary.trim() || `基于 ${currentVersionRecord.version} 修改参数或逻辑`,
          codeContent: draftCode,
          updatedParams: draftParams,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '派生新版本失败');
      setDossier(data.dossier);
      setCodeByVersion(data.codeByVersion);
      setInspectVersion(data.dossier.activeVersion);
      setIsForking(false);
      setActionMsg(
        data.dossier.codeSecurityReview.status === 'unreviewed_modified'
          ? `已保存新版本 ${data.dossier.activeVersion}。由于源码已改动，请核对代码并确认 64 位 SHA-256 哈希后再运行自检或实验。`
          : `参数已更新并保存为新版本 ${data.dossier.activeVersion}（源码哈希未变，可直接用于实验）。`,
      );
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async (version: string) => {
    if (!dossier) return;
    setErrorMsg(null);
    try {
      const source = codeByVersion[version];
      if (source === undefined) throw new Error('请先打开要审阅的版本源码');
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      const expectedHash = Array.from(new Uint8Array(hash), (value) => value.toString(16).padStart(2, '0')).join('');
      const res = await fetch(`/api/components/${encodeURIComponent(dossier.id)}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, reviewer: 'rad', expectedHash }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '确认哈希失败');
      setDossier(data.dossier);
      setActionMsg(
        `已记录版本 ${version} 的 64 位 SHA-256 确认哈希（本地子进程执行权限已开启，注意这并非 OS 安全沙箱）。`,
      );
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleActivate = async (version: string) => {
    if (!dossier) return;
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/components/${encodeURIComponent(dossier.id)}/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '切换版本失败');
      setDossier(data.dossier);
      setActionMsg(`已将 ${version} 设为当前活跃版本。`);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRunSelfCheck = async () => {
    if (!dossier) return;
    setChecking(true);
    setErrorMsg(null);
    setActionMsg(null);
    try {
      const res = await fetch(`/api/components/${encodeURIComponent(dossier.id)}/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: inspectVersion }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '自检运行失败');
      setDossier(data.dossier);
      setActionMsg(`自检完成：${data.dossier.selfCheck.summary}`);
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };

  const handleRunStandalone = async () => {
    if (!dossier) return;
    setStandaloneBusy(true);
    setErrorMsg(null);
    setStandaloneResult(null);
    try {
      const res = await fetch(`/api/components/${encodeURIComponent(dossier.id)}/run-standalone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          version: inspectVersion,
          runId: standaloneRunId || runs[0]?.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '独立试运行失败');
      setStandaloneResult(JSON.stringify(data.result.output, null, 2));
      setActionMsg(
        standaloneRunId
          ? `已独立运行 ${dossier.name} 并关联观测到 ${standaloneRunId}（架构地图已更新为 observed 调用）。`
          : `已独立运行 ${dossier.name}。`,
      );
      await onRefresh();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setStandaloneBusy(false);
    }
  };

  const handleCreateComponent = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreatingComp(true);
    setErrorMsg(null);
    setActionMsg(null);
    try {
      const res = await fetch('/api/components/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: newCompId.trim(),
          name: newCompName.trim(),
          kind: newCompKind,
          runtime: newCompRuntime,
          summary: newCompSummary.trim() || newCompName.trim(),
          purpose: newCompSummary.trim() || '在工作台组件库新建的可复用计算/评估组件',
          codeContent: newCompCode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '新建组件失败');
      setShowCreateComp(false);
      setNewCompId('');
      setNewCompName('');
      setNewCompSummary('');
      await onRefresh();
      onSelectId(data.dossier.id);
      setActionMsg(`已在 workspace/components/${data.dossier.id} 创建新组件，并登记 SHA-256 哈希。`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingComp(false);
    }
  };

  const canFork =
    dossier?.runtime === 'local_process_mjs' || dossier?.runtime === 'local_process_py';
  const checkMeta = dossier ? selfCheckLabel(dossier.selfCheck.status) : null;
  const sciMeta = dossier ? sciValidationLabel(dossier.scientificValidation.status) : null;
  const secMeta = dossier ? securityLabel(dossier.codeSecurityReview.status) : null;
  const needsApproval =
    dossier &&
    (dossier.diskTamperDetected || dossier.codeSecurityReview.status === 'unreviewed_modified');

  return (
    <div className="max-w-[1440px] mx-auto px-6 py-6 space-y-5">
      {/* Python Environment & Authoring Header */}
      <div className="bg-white border border-slate-200 rounded-md p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-sm font-semibold text-slate-900">
            工作区外部科学运行环境与独立组件编排目录
          </div>
          {pythonRuntime ? (
            <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-slate-600 tabular-nums">
              <span>解释器: {pythonRuntime.executable}</span>
              <span>Python {pythonRuntime.pythonVersion ?? '未知'}</span>
              <span>optiland {pythonRuntime.packages.optiland ?? '—'}</span>
              <span>astropy {pythonRuntime.packages.astropy ?? '—'}</span>
              <span>photutils {pythonRuntime.packages.photutils ?? '—'}</span>
              <span>sep {pythonRuntime.packages.sep ?? '—'}</span>
            </div>
          ) : (
            <div className="text-xs text-slate-500">正在探测本地科学计算栈...</div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setShowCreateComp((v) => !v)}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" />
          <span>新建独立组件</span>
        </button>
      </div>

      {/* Create New Component Drawer */}
      {showCreateComp && (
        <form
          onSubmit={handleCreateComponent}
          className="bg-white border border-blue-200 rounded-md p-5 space-y-4 text-xs"
        >
          <div className="flex items-center justify-between border-b border-slate-100 pb-2">
            <span className="text-sm font-semibold text-slate-900">
              新建独立磁盘组件（持久化至 workspace/components/&lt;id&gt;/v0.1/）
            </span>
            <button
              type="button"
              onClick={() => setShowCreateComp(false)}
              className="text-slate-500 hover:text-slate-800 cursor-pointer"
            >
              关闭
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="block font-medium text-slate-700 mb-1">组件 ID (kebab-case)</label>
              <input
                type="text"
                required
                placeholder="如 fits-snr-auditor"
                value={newCompId}
                onChange={(e) => setNewCompId(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded font-mono"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">组件显示名称</label>
              <input
                type="text"
                required
                placeholder="如 FITS 信噪比统计审计器"
                value={newCompName}
                onChange={(e) => setNewCompName(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">组件类别</label>
              <select
                value={newCompKind}
                onChange={(e) => setNewCompKind(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded font-mono"
              >
                <option value="analysis_plugin">analysis_plugin (独立分析)</option>
                <option value="evaluator">evaluator (评价准则)</option>
                <option value="optical_solver">optical_solver (光学求解器)</option>
                <option value="fits_analyzer">fits_analyzer (观测解析)</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">执行环境</label>
              <select
                value={newCompRuntime}
                onChange={(e) => {
                  const rt = e.target.value as 'local_process_mjs' | 'local_process_py';
                  setNewCompRuntime(rt);
                  if (rt === 'local_process_py') {
                    setNewCompCode(
`import sys, json

if '--check' in sys.argv:
    print(json.dumps({"ok": True, "summary": "Python 自定义组件自检通过"}))
    sys.exit(0)

print(json.dumps({"ok": True, "note": "custom python component ready"}))
`
                    );
                  }
                }}
                className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded font-mono"
              >
                <option value="local_process_mjs">Node.js 子进程 (.mjs)</option>
                <option value="local_process_py">Python 子进程 (.py)</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">能力定位与物理边界说明</label>
            <input
              type="text"
              placeholder="说明该组件的输入契约、计算假设与物理边界..."
              value={newCompSummary}
              onChange={(e) => setNewCompSummary(e.target.value)}
              className="w-full px-2.5 py-1.5 bg-white border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">初始实现源码</label>
            <textarea
              rows={7}
              required
              value={newCompCode}
              onChange={(e) => setNewCompCode(e.target.value)}
              className="w-full p-3 bg-slate-900 text-slate-100 font-mono text-xs rounded border border-slate-700"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreateComp(false)}
              className="px-3 py-1.5 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={creatingComp}
              className="px-4 py-1.5 font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded cursor-pointer"
            >
              {creatingComp ? '写入磁盘中...' : '创建组件并登记哈希'}
            </button>
          </div>
        </form>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[330px_1fr] gap-6 items-start">
      {/* Left Component Directory */}
      <aside className="bg-white border border-slate-200 rounded-md overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50">
          <h2 className="text-sm font-semibold text-slate-900">独立组件档案目录</h2>
          <p className="text-xs text-slate-500 mt-0.5">
            目录扫描自 workspace/components/*，支持独立执行与版本派生
          </p>
        </div>
        <div className="divide-y divide-slate-100">
          {components.map((comp) => {
            const selected = comp.id === activeId;
            const ck = selfCheckLabel(comp.selfCheck.status);
            return (
              <button
                key={comp.id}
                type="button"
                onClick={() => onSelectId(comp.id)}
                className={`w-full text-left px-4 py-3 transition-colors cursor-pointer focus-visible:outline-2 focus-visible:outline-blue-600 ${
                  selected ? 'bg-blue-50/70' : 'hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-sm font-medium ${selected ? 'text-blue-800' : 'text-slate-900'}`}>
                    {comp.name}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-slate-500 font-mono">
                  <span>{KIND_LABELS[comp.kind] ?? comp.kind}</span>
                  <span aria-hidden="true">·</span>
                  <span>{comp.activeVersion}</span>
                  <span aria-hidden="true">·</span>
                  <span className={comp.diskTamperDetected ? 'text-rose-700 font-semibold' : ck.tone}>
                    {comp.diskTamperDetected ? '✖ 磁盘源码已修改' : ck.text}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* Right Dossier & Code Inspector */}
      {dossier ? (
        <section className="bg-white border border-slate-200 rounded-md p-6 space-y-6">
          {/* Header */}
          <div className="flex flex-wrap items-start justify-between gap-4 pb-5 border-b border-slate-200">
            <div className="space-y-1 max-w-2xl">
              <div className="flex flex-wrap items-center gap-2 text-xs font-mono text-slate-500">
                <span>{dossier.id}</span>
                <span aria-hidden="true">·</span>
                <span>{KIND_LABELS[dossier.kind] ?? dossier.kind}</span>
                <span aria-hidden="true">·</span>
                <span>执行模型：{dossier.runtime}</span>
                <span aria-hidden="true">·</span>
                <span>活跃版本：{dossier.activeVersion}</span>
              </div>
              <h1 className="text-xl font-semibold text-slate-900">{dossier.name}</h1>
              <p className="text-sm text-slate-600 leading-relaxed">{dossier.summary}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleRunSelfCheck}
                disabled={checking}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
              >
                <FlaskConical className="w-3.5 h-3.5" aria-hidden="true" />
                <span>{checking ? '自检运行中...' : '运行自检 (--check)'}</span>
              </button>
              <button
                type="button"
                onClick={() => setStandaloneOpen((v) => !v)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
              >
                <Play className="w-3.5 h-3.5" aria-hidden="true" />
                <span>独立试运行</span>
              </button>
              <button
                type="button"
                onClick={() => onInspectInArchitecture(`comp:${dossier.id}`)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded-md cursor-pointer"
              >
                <Network className="w-3.5 h-3.5" aria-hidden="true" />
                <span>架构地图定位</span>
              </button>
              {canFork && !isForking && (
                <button
                  type="button"
                  onClick={startFork}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded-md cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>派生新版本并修改</span>
                </button>
              )}
            </div>
          </div>

          {/* Standalone Execution Panel */}
          {standaloneOpen && (
            <div className="p-4 bg-slate-50 border border-slate-200 rounded space-y-3 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-semibold text-slate-900">独立调用此组件（脱离固定流水线）</div>
                  <div className="text-slate-500 mt-0.5">
                    选择一个历史运行作为输入原始产物 (rawArtifacts / spec)，直接触发该组件并将真实调用写入观测记录。
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <select
                    aria-label="选择独立试运行的输入历史实验"
                    value={standaloneRunId}
                    onChange={(e) => setStandaloneRunId(e.target.value)}
                    className="px-2.5 py-1.5 bg-white border border-slate-300 rounded font-mono"
                  >
                    {runs.map((r) => (
                      <option key={r.id} value={r.id}>
                        Run #{r.sequenceNumber} · {r.branchLabel}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={handleRunStandalone}
                    disabled={standaloneBusy}
                    className="px-3 py-1.5 font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded cursor-pointer"
                  >
                    {standaloneBusy ? '执行中...' : '立即执行'}
                  </button>
                </div>
              </div>
              {standaloneResult && (
                <pre className="p-3 bg-slate-900 text-slate-100 rounded font-mono text-[11px] overflow-x-auto whitespace-pre-wrap">
                  {standaloneResult}
                </pre>
              )}
            </div>
          )}

          {/* Disk Tamper / Unreviewed Warning */}
          {dossier.diskTamperDetected && (
            <div className="p-3.5 bg-rose-50 border border-rose-300 rounded text-xs text-rose-900 space-y-2">
              <div className="flex items-center justify-between gap-2 font-semibold">
                <span className="inline-flex items-center gap-1.5">
                  <ShieldAlert className="w-4 h-4 text-rose-700" aria-hidden="true" />
                  <span>检测到磁盘源码在工作台外部被修改（例如通过 VS Code 编辑）</span>
                </span>
                <button
                  type="button"
                  onClick={() => handleApprove(dossier.activeVersion)}
                  className="px-3 py-1 font-semibold text-white bg-rose-700 hover:bg-rose-800 rounded cursor-pointer"
                >
                  我已核对磁盘源码，确认新 64 位哈希
                </button>
              </div>
              <div className="font-mono text-[11px] text-rose-800 break-all">
                磁盘实际 SHA-256: {dossier.diskActualHash} <br />
                此前确认 SHA-256: {dossier.codeSecurityReview.approvedHash ?? '无'}
              </div>
            </div>
          )}

          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{errorMsg}</span>
            </div>
          )}
          {actionMsg && (
            <div className="p-3 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800 flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>{actionMsg}</span>
            </div>
          )}

          {/* Strict 3-Layer Trust Panels (Never conflated) */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Layer 1: Self Check */}
            <div className="border border-slate-200 rounded p-3.5 space-y-1.5 text-xs">
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                1. 组件自检 (--check)
              </div>
              {checkMeta && <div className={`font-semibold ${checkMeta.tone}`}>{checkMeta.text}</div>}
              <p className="text-slate-700">{dossier.selfCheck.summary}</p>
              <div className="font-mono text-[10px] text-slate-500 break-all pt-1">
                checkedHash: {dossier.selfCheck.checkedCodeHash ? `${dossier.selfCheck.checkedCodeHash.slice(0, 20)}...` : 'null'}
              </div>
              <p className="text-[11px] text-slate-400">
                仅证明代码能跑通基准烟雾测试，不代表科学结果真实或代码安全。
              </p>
            </div>

            {/* Layer 2: Scientific Validation */}
            <div className="border border-slate-200 rounded p-3.5 space-y-1.5 text-xs">
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                2. 独立科学验证定位
              </div>
              {sciMeta && <div className={`font-semibold ${sciMeta.tone}`}>{sciMeta.text}</div>}
              <p className="text-slate-700">{dossier.scientificValidation.basis}</p>
              {dossier.scientificValidation.caveats.length > 0 && (
                <ul className="list-disc pl-4 text-[11px] text-slate-500 space-y-0.5">
                  {dossier.scientificValidation.caveats.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              )}
            </div>

            {/* Layer 3: Code Security Review */}
            <div className="border border-slate-200 rounded p-3.5 space-y-1.5 text-xs">
              <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                3. 代码安全与执行模型审查
              </div>
              {secMeta && <div className={`font-semibold ${secMeta.tone}`}>{secMeta.text}</div>}
              <p className="text-slate-700">{dossier.codeSecurityReview.executionModelNote}</p>
              <div className="font-mono text-[10px] text-slate-500 break-all pt-1">
                approvedHash: {dossier.codeSecurityReview.approvedHash ? `${dossier.codeSecurityReview.approvedHash.slice(0, 20)}...` : '未确认'}
              </div>
              {needsApproval && (
                <button
                  type="button"
                  onClick={() => handleApprove(dossier.activeVersion)}
                  className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-amber-600 hover:bg-amber-700 rounded cursor-pointer"
                >
                  <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
                  <span>核对代码并确认哈希</span>
                </button>
              )}
            </div>
          </div>

          {/* Structured Mecha Dossier */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">
                  存在目的与能力边界
                </h3>
                <p className="text-sm text-slate-800 leading-relaxed">{dossier.purpose}</p>
                <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                  能力边界：{dossier.capabilityBoundary}
                </p>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  输入契约 (Inputs)
                </h3>
                <div className="border border-slate-200 rounded divide-y divide-slate-100">
                  {dossier.inputs.map((inp) => (
                    <div key={inp.name} className="px-3 py-2 text-xs">
                      <div className="font-mono font-semibold text-slate-900">
                        {inp.name}{' '}
                        <span className="font-normal text-slate-500">
                          ({inp.type}{inp.unit ? `, ${inp.unit}` : ''})
                        </span>
                      </div>
                      <div className="text-slate-600 mt-0.5">{inp.description}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  输出契约 (Outputs)
                </h3>
                <div className="border border-slate-200 rounded divide-y divide-slate-100">
                  {dossier.outputs.map((out) => (
                    <div key={out.name} className="px-3 py-2 text-xs">
                      <div className="font-mono font-semibold text-slate-900">
                        {out.name}{' '}
                        <span className="font-normal text-slate-500">
                          ({out.type}{out.unit ? `, ${out.unit}` : ''})
                        </span>
                      </div>
                      <div className="text-slate-600 mt-0.5">{out.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  隐含假设与已知限制
                </h3>
                <ul className="space-y-1 text-xs text-slate-700 list-disc pl-4">
                  {dossier.assumptions.map((a, i) => (
                    <li key={`a-${i}`}>假设：{a}</li>
                  ))}
                  {dossier.limits.map((lim, i) => (
                    <li key={`l-${i}`}>限制：{lim}</li>
                  ))}
                </ul>
              </div>

              <div>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  依赖关系、兼容范围与修改影响面
                </h3>
                <div className="text-xs text-slate-700 space-y-1.5">
                  <div>
                    依赖项：
                    {dossier.dependencies.length > 0
                      ? dossier.dependencies.map((d) => `${d.kind}:${d.targetId} (${d.reason})`).join('；')
                      : '无显式外部依赖'}
                  </div>
                  <div>兼容对象：{dossier.compatibility.join(' · ') || '通用契约'}</div>
                  <div className="p-2.5 bg-slate-50 border border-slate-200 rounded space-y-1">
                    <div className="font-semibold text-slate-800">若修改此组件，受影响对象：</div>
                    <div>
                      下游组件：{dossier.impactScope?.dependentComponentIds.join(' · ') || '无其他组件声明依赖此组件'}
                    </div>
                    <div>
                      已关联实验：{dossier.impactScope?.usedInRunIds.join(' · ') || '尚无实验运行记录使用此组件'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Version Lineage List */}
              <div>
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5">
                  版本演化谱系（完整 64 位 SHA-256 指纹）
                </h3>
                <div className="border border-slate-200 rounded divide-y divide-slate-100">
                  {dossier.versions.map((ver) => {
                    const isInspecting = ver.version === inspectVersion;
                    const isActive = ver.version === dossier.activeVersion;
                    return (
                      <div
                        key={ver.version}
                        className={`px-3 py-2 flex items-center justify-between gap-2 text-xs ${
                          isInspecting ? 'bg-slate-50' : ''
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setInspectVersion(ver.version);
                            setDraftParams({ ...ver.params });
                            setDraftCode(codeByVersion[ver.version] ?? '');
                            setIsForking(false);
                          }}
                          className="text-left flex-1 min-w-0 cursor-pointer"
                        >
                          <div className="font-mono font-semibold text-slate-900">
                            {ver.version}{' '}
                            {isActive && <span className="text-blue-700 font-normal">· 当前默认</span>}
                          </div>
                          <div className="text-slate-500 truncate mt-0.5 font-mono text-[11px]">
                            {ver.changeSummary} · sha256:{ver.codeHash.slice(0, 16)}...
                          </div>
                        </button>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {!isActive && (
                            <button
                              type="button"
                              onClick={() => handleActivate(ver.version)}
                              className="px-2 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
                            >
                              设为默认
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* Code & Parameters Inspector / Fork Editor */}
          <div className="pt-4 border-t border-slate-200 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <Code2 className="w-4 h-4 text-slate-500" aria-hidden="true" />
                <span>
                  {isForking
                    ? `正在基于 ${currentVersionRecord?.version} 创建新版本`
                    : `真实磁盘源码（workspace/components/${dossier.id}/${currentVersionRecord?.version}/${currentVersionRecord?.codeFile}）`}
                </span>
              </div>
              {currentVersionRecord && (
                <span className="font-mono text-[11px] text-slate-500 break-all">
                  SHA-256: {currentVersionRecord.codeHash}
                </span>
              )}
            </div>

            {isForking && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-50 border border-slate-200 rounded p-4">
                <div>
                  <label htmlFor="fork-version-tag" className="block text-xs font-medium text-slate-700 mb-1">
                    新版本号（保留旧版本不覆盖）
                  </label>
                  <input
                    id="fork-version-tag"
                    type="text"
                    value={newVersionTag}
                    onChange={(e) => setNewVersionTag(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm font-mono bg-white border border-slate-300 rounded"
                  />
                </div>
                <div>
                  <label htmlFor="fork-change-summary" className="block text-xs font-medium text-slate-700 mb-1">
                    改动原因 / 实验假设说明
                  </label>
                  <input
                    id="fork-change-summary"
                    type="text"
                    placeholder="例如：调整色差惩罚权重或新增计算输出"
                    value={changeSummary}
                    onChange={(e) => setChangeSummary(e.target.value)}
                    className="w-full px-3 py-1.5 text-sm bg-white border border-slate-300 rounded"
                  />
                </div>
              </div>
            )}

            {/* Editable default parameters */}
            {dossier.parameters.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {dossier.parameters.map((spec) => {
                  const val = isForking
                    ? draftParams[spec.key] ?? spec.defaultValue
                    : currentVersionRecord?.params[spec.key] ?? spec.defaultValue;
                  return (
                    <div key={spec.key} className="border border-slate-200 rounded p-3 bg-slate-50/50">
                      <label htmlFor={`param-${spec.key}`} className="block text-xs font-medium text-slate-700">
                        {spec.label} {spec.unit ? `(${spec.unit})` : ''}
                      </label>
                      <input
                        id={`param-${spec.key}`}
                        type="number"
                        step={spec.step ?? 0.1}
                        disabled={!isForking}
                        value={Number(val)}
                        onChange={(e) =>
                          setDraftParams((prev) => ({ ...prev, [spec.key]: Number(e.target.value) }))
                        }
                        className="mt-1 w-full px-2.5 py-1 text-sm font-mono bg-white border border-slate-300 rounded disabled:bg-slate-100 disabled:text-slate-600"
                      />
                      <p className="text-[11px] text-slate-500 mt-1">{spec.description}</p>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Source code textarea */}
            <div>
              <label htmlFor="component-code-editor" className="sr-only">
                组件实现源码
              </label>
              <textarea
                id="component-code-editor"
                readOnly={!isForking}
                value={isForking ? draftCode : codeByVersion[currentVersionRecord?.version ?? ''] ?? ''}
                onChange={(e) => setDraftCode(e.target.value)}
                rows={15}
                spellCheck={false}
                className={`w-full p-4 text-xs font-mono leading-relaxed rounded border ${
                  isForking
                    ? 'bg-white border-blue-400 text-slate-900 focus:outline-2 focus:outline-blue-600'
                    : 'bg-slate-900 border-slate-800 text-slate-100'
                }`}
              />
            </div>

            {isForking && (
              <div className="flex items-center justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsForking(false)}
                  className="px-4 py-2 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-md cursor-pointer"
                >
                  取消修改
                </button>
                <button
                  type="button"
                  onClick={handleSaveFork}
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 disabled:opacity-50 rounded-md cursor-pointer"
                >
                  {saving ? '保存版本中...' : `保存为 ${newVersionTag}`}
                </button>
              </div>
            )}
          </div>
        </section>
      ) : (
        <div className="p-8 text-sm text-slate-500">请选择左侧组件查看其结构档案。</div>
      )}
      </div>
    </div>
  );
}

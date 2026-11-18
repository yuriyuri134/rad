import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronRight,
  ExternalLink,
  FolderOpen,
  GitCompare,
  Home,
  RefreshCw,
  RotateCcw,
  Search,
} from 'lucide-react';
import type {
  ArchEdge,
  ArchNode,
  ArchProvenance,
  ArchRelationType,
  ArchitectureAnnotation,
  ArchitectureMapData,
  ArchitectureSnapshotDiff,
  EpistemicTag,
  PersistedArchitectureSnapshot,
} from '../core/types.ts';

interface ArchitectureMapViewProps {
  initialFocusNodeId?: string | null;
  onJumpToTarget: (target: { tab: 'experiment' | 'components' | 'compare' | 'architecture'; targetId: string }) => void;
}

const NODE_KIND_LABELS: Record<ArchNode['kind'], string> = {
  scope: '作用域',
  component: '独立组件',
  subpart: '子模块',
  experiment_run: '历史运行',
  source_module: '源码文件',
  artifact_store: '数据账本/产物',
  research_study: '研究课题',
  branch: '研究分支',
  workflow_execution: '工作流实算',
  runtime_host: '科学计算环境',
};

const RELATION_META: Record<ArchRelationType, { label: string; color: string; dash?: string }> = {
  contains: { label: '包含 (contains)', color: '#64748b' },
  depends_on: { label: '依赖 (depends_on)', color: '#1d4ed8' },
  uses: { label: '使用 (uses)', color: '#059669' },
  produces: { label: '产出 (produces)', color: '#0891b2' },
  derives_from: { label: '派生 (derives_from)', color: '#7c3aed', dash: '5 3' },
  represents: { label: '表示/自引用 (represents)', color: '#d97706', dash: '4 4' },
};

const PROVENANCE_META: Record<ArchProvenance, string> = {
  scanned: '真实扫描 (scanned)',
  observed: '运行观测 (observed)',
  declared: '显式声明 (declared)',
  manual: '人工标注 (manual)',
  inferred: '推断 (inferred)',
};

const STATUS_STYLE: Record<ArchNode['status'], { stroke: string; fill: string; text: string; badge: string }> = {
  healthy: { stroke: '#cbd5e1', fill: '#ffffff', text: '#0f172a', badge: '正常' },
  warning: { stroke: '#d97706', fill: '#fffbeb', text: '#92400e', badge: '待检/警告' },
  error: { stroke: '#dc2626', fill: '#fef2f2', text: '#991b1b', badge: '异常/篡改' },
  unmapped: { stroke: '#ea580c', fill: '#fff7ed', text: '#9a3412', badge: '未建档目录' },
  unavailable: { stroke: '#64748b', fill: '#f8fafc', text: '#475569', badge: '环境不可用' },
};

function truncateVisualLabel(label: string, maxUnits: number): string {
  let units = 0;
  let out = '';
  for (const ch of label) {
    const w = ch.charCodeAt(0) > 0x2e7f ? 2 : 1.05;
    if (units + w > maxUnits) {
      return `${out}…`;
    }
    out += ch;
    units += w;
  }
  return out;
}

export function ArchitectureMapView({ initialFocusNodeId, onJumpToTarget }: ArchitectureMapViewProps) {
  const [mapData, setMapData] = useState<ArchitectureMapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Scope navigation path (unlimited depth)
  const [scopeStack, setScopeStack] = useState<string[]>(['scope:openlab-bench']);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('scope:openlab-bench');

  // Filters & search
  const [activeRelations, setActiveRelations] = useState<Set<ArchRelationType>>(
    () => new Set(['contains', 'depends_on', 'uses', 'produces', 'derives_from', 'represents']),
  );
  const [activeProvenances, setActiveProvenances] = useState<Set<ArchProvenance>>(
    () => new Set(['scanned', 'observed', 'declared', 'manual', 'inferred']),
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightImpact, setHighlightImpact] = useState(true);

  // Layout-only coordinate overrides (explicitly never mutates architecture)
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const dragStateRef = useRef<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Snapshot diff & persisted snapshot state
  const [baselineSnapshot, setBaselineSnapshot] = useState<ArchitectureMapData | null>(null);
  const [persistedSnapshots, setPersistedSnapshots] = useState<PersistedArchitectureSnapshot[]>([]);
  const [annotations, setAnnotations] = useState<ArchitectureAnnotation[]>([]);
  const [snapshotDiff, setSnapshotDiff] = useState<ArchitectureSnapshotDiff | null>(null);
  const [savingSnap, setSavingSnap] = useState(false);

  // Manual annotation form
  const [annoTag, setAnnoTag] = useState<EpistemicTag>('judgment');
  const [annoText, setAnnoText] = useState('');
  const [savingAnno, setSavingAnno] = useState(false);

  const loadMap = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mapRes, snapRes] = await Promise.all([
        fetch('/api/architecture-map'),
        fetch('/api/architecture-snapshots'),
      ]);
      const data = await mapRes.json();
      if (!mapRes.ok) throw new Error(data.error || '加载架构地图失败');
      setMapData(data as ArchitectureMapData);
      if (snapRes.ok) {
        const sd = await snapRes.json();
        setPersistedSnapshots(sd.snapshots ?? []);
        setAnnotations(sd.annotations ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadMap();
  }, [loadMap]);

  // Focus specific node when navigated from another tab
  useEffect(() => {
    if (!mapData || !initialFocusNodeId) return;
    const nodeMap = new Map(mapData.nodes.map((n) => [n.id, n]));
    const target = nodeMap.get(initialFocusNodeId);
    if (!target) return;

    // Build path from root to target's parent (or target itself if scope)
    const chain: string[] = [];
    let cursor: ArchNode | undefined = target.kind === 'scope' ? target : target.parentId ? nodeMap.get(target.parentId) : undefined;
    const guard = new Set<string>();
    while (cursor && !guard.has(cursor.id)) {
      guard.add(cursor.id);
      chain.unshift(cursor.id);
      cursor = cursor.parentId ? nodeMap.get(cursor.parentId) : undefined;
    }
    if (chain.length === 0) chain.push(mapData.rootScopeId);
    setScopeStack(chain);
    setSelectedNodeId(target.id);
  }, [mapData, initialFocusNodeId]);

  const currentScopeId = scopeStack[scopeStack.length - 1] ?? 'scope:openlab-bench';

  const childrenMap = useMemo(() => {
    const m = new Map<string, ArchNode[]>();
    if (!mapData) return m;
    for (const n of mapData.nodes) {
      if (n.parentId) {
        const list = m.get(n.parentId) ?? [];
        list.push(n);
        m.set(n.parentId, list);
      }
    }
    return m;
  }, [mapData]);

  const nodeMap = useMemo(() => {
    const m = new Map<string, ArchNode>();
    if (!mapData) return m;
    for (const n of mapData.nodes) m.set(n.id, n);
    return m;
  }, [mapData]);

  const enterNodeScope = (nodeId: string) => {
    const children = childrenMap.get(nodeId) ?? [];
    if (children.length === 0) return;
    setScopeStack((prev) => {
      const idx = prev.indexOf(nodeId);
      if (idx >= 0) return prev.slice(0, idx + 1);
      return [...prev, nodeId];
    });
    setSelectedNodeId(nodeId);
    setPositions({});
  };

  const navigateBack = () => {
    if (scopeStack.length <= 1) return;
    const nextStack = scopeStack.slice(0, -1);
    setScopeStack(nextStack);
    setSelectedNodeId(nextStack[nextStack.length - 1]);
    setPositions({});
  };

  const navigateToStackIdx = (idx: number) => {
    const nextStack = scopeStack.slice(0, idx + 1);
    setScopeStack(nextStack);
    setSelectedNodeId(nextStack[nextStack.length - 1]);
    setPositions({});
  };

  // Visible nodes in current scope + connected external neighbors
  const { scopeChildren, externalNeighbors, visibleEdges, impactSet } = useMemo(() => {
    if (!mapData) {
      return {
        scopeChildren: [] as ArchNode[],
        externalNeighbors: [] as ArchNode[],
        visibleEdges: [] as ArchEdge[],
        impactSet: new Set<string>(),
      };
    }

    const q = searchQuery.trim().toLowerCase();
    const rawChildren = childrenMap.get(currentScopeId) ?? [];
    const filteredChildren = q
      ? rawChildren.filter(
          (n) =>
            n.label.toLowerCase().includes(q) ||
            n.id.toLowerCase().includes(q) ||
            n.summary.toLowerCase().includes(q),
        )
      : rawChildren;

    const childIdSet = new Set(filteredChildren.map((n) => n.id));
    childIdSet.add(currentScopeId);

    const matchingEdges = mapData.edges.filter((e) => {
      if (!activeRelations.has(e.relation)) return false;
      if (!activeProvenances.has(e.provenance)) return false;
      return childIdSet.has(e.source) || childIdSet.has(e.target);
    });

    const extIds = new Set<string>();
    for (const e of matchingEdges) {
      if (!childIdSet.has(e.source)) extIds.add(e.source);
      if (!childIdSet.has(e.target)) extIds.add(e.target);
    }

    const extNodes = Array.from(extIds)
      .map((id) => nodeMap.get(id))
      .filter((n): n is ArchNode => Boolean(n))
      .slice(0, 10); // keep cross-boundary lane legible

    const visibleIdSet = new Set([
      ...filteredChildren.map((n) => n.id),
      ...extNodes.map((n) => n.id),
      currentScopeId,
    ]);
    const finalEdges = matchingEdges.filter((e) => visibleIdSet.has(e.source) && visibleIdSet.has(e.target));

    const imp = new Set<string>();
    if (highlightImpact && selectedNodeId) {
      imp.add(selectedNodeId);
      for (const e of mapData.edges) {
        if (e.source === selectedNodeId) imp.add(e.target);
        if (e.target === selectedNodeId) imp.add(e.source);
      }
    }

    return {
      scopeChildren: filteredChildren,
      externalNeighbors: extNodes,
      visibleEdges: finalEdges,
      impactSet: imp,
    };
  }, [mapData, currentScopeId, childrenMap, nodeMap, activeRelations, activeProvenances, searchQuery, highlightImpact, selectedNodeId]);

  // Compute default spatial layout for SVG canvas
  const layoutPositions = useMemo(() => {
    const coords: Record<string, { x: number; y: number }> = {};
    // Current scope header anchor at left-center
    coords[currentScopeId] = positions[currentScopeId] ?? { x: 110, y: 225 };

    // Children grid in center zone
    const cols = scopeChildren.length <= 4 ? 1 : 2;
    scopeChildren.forEach((node, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      const rowsInCol = Math.ceil(scopeChildren.length / cols);
      const spacingY = Math.min(82, Math.max(52, 390 / Math.max(1, rowsInCol)));
      const defaultX = cols === 1 ? 370 : col === 0 ? 310 : 535;
      const defaultY = 58 + row * spacingY;
      coords[node.id] = positions[node.id] ?? { x: defaultX, y: defaultY };
    });

    // External boundary neighbors in right lane
    externalNeighbors.forEach((node, idx) => {
      const spacingY = Math.min(68, Math.max(44, 390 / Math.max(1, externalNeighbors.length)));
      coords[node.id] = positions[node.id] ?? { x: 790, y: 54 + idx * spacingY };
    });

    return coords;
  }, [currentScopeId, scopeChildren, externalNeighbors, positions]);

  const toSvgCoords = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width) * 920,
      y: ((clientY - rect.top) / rect.height) * 460,
    };
  };

  const handlePointerDown = (nodeId: string, e: React.PointerEvent) => {
    e.stopPropagation();
    setSelectedNodeId(nodeId);
    const pt = toSvgCoords(e.clientX, e.clientY);
    const cur = layoutPositions[nodeId] ?? { x: pt.x, y: pt.y };
    dragStateRef.current = { nodeId, offsetX: pt.x - cur.x, offsetY: pt.y - cur.y };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragStateRef.current) return;
    const pt = toSvgCoords(e.clientX, e.clientY);
    const { nodeId, offsetX, offsetY } = dragStateRef.current;
    setPositions((prev) => ({
      ...prev,
      [nodeId]: {
        x: Math.max(80, Math.min(840, pt.x - offsetX)),
        y: Math.max(30, Math.min(430, pt.y - offsetY)),
      },
    }));
  };

  const handlePointerUp = () => {
    dragStateRef.current = null;
  };

  const toggleRelation = (rel: ArchRelationType) => {
    setActiveRelations((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  };

  const toggleProvenance = (prov: ArchProvenance) => {
    setActiveProvenances((prev) => {
      const next = new Set(prev);
      if (next.has(prov)) next.delete(prov);
      else next.add(prov);
      return next;
    });
  };

  const handleSaveSnapshot = async () => {
    if (!mapData) return;
    setSavingSnap(true);
    try {
      const res = await fetch('/api/architecture-snapshots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: `工作台手动留存 (${mapData.nodes.length} 节点)` }),
      });
      const data = await res.json();
      if (res.ok && data.snapshot) {
        setPersistedSnapshots(data.snapshots ?? []);
        setBaselineSnapshot(data.snapshot.mapData);
        setSnapshotDiff(null);
      } else {
        setBaselineSnapshot(mapData);
      }
    } finally {
      setSavingSnap(false);
    }
  };

  const handleComputeDiff = async (beforeOverride?: ArchitectureMapData) => {
    const base = beforeOverride ?? baselineSnapshot;
    if (!base) return;
    const res = await fetch('/api/architecture-map/snapshot-diff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ beforeSnapshot: base }),
    });
    const data = await res.json();
    if (res.ok) {
      setMapData(data.afterSnapshot);
      setSnapshotDiff(data.diff);
    }
  };

  const handleAddAnnotation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!annoText.trim()) return;
    setSavingAnno(true);
    try {
      const res = await fetch('/api/architecture-annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: selectedNodeId,
          tag: annoTag,
          note: annoText.trim(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setAnnotations(data.annotations ?? []);
        setAnnoText('');
        await loadMap();
      }
    } finally {
      setSavingAnno(false);
    }
  };

  if (loading && !mapData) {
    return (
      <div className="max-w-[1440px] mx-auto px-6 py-12 text-center text-sm text-slate-500 font-mono">
        正在扫描工作区真实组件、静态 import 与实验账本...
      </div>
    );
  }

  if (error || !mapData) {
    return (
      <div className="max-w-[1440px] mx-auto px-6 py-8">
        <div className="p-4 bg-rose-50 border border-rose-200 rounded text-xs text-rose-800">
          {error || '无法构建架构地图'}
        </div>
      </div>
    );
  }

  const selectedNode = nodeMap.get(selectedNodeId) ?? nodeMap.get(currentScopeId)!;
  const selectedChildren = childrenMap.get(selectedNode.id) ?? [];
  const selectedOutgoing = mapData.edges.filter((e) => e.source === selectedNode.id);
  const selectedIncoming = mapData.edges.filter((e) => e.target === selectedNode.id);

  const canvasNodes: Array<{ node: ArchNode; isBoundaryScope?: boolean; isExternal?: boolean }> = [
    { node: nodeMap.get(currentScopeId)!, isBoundaryScope: true },
    ...scopeChildren.map((n) => ({ node: n })),
    ...externalNeighbors.map((n) => ({ node: n, isExternal: true })),
  ].filter((item) => Boolean(item.node));

  return (
    <div className="max-w-[1440px] mx-auto px-6 py-6 space-y-5">
      {/* Top Navigation & Controls */}
      <div className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold text-slate-900">
              整体架构地图（实时自举扫描 · 多关系多层级可下钻）
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              直接读取 workspace/components/*、源码 import 与 runs.jsonl 账本；包含架构地图自身（comp:arch-map-engine）内部构造与受控自引用。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={loadMap}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>重新扫描真实结构</span>
            </button>
            <button
              type="button"
              onClick={handleSaveSnapshot}
              disabled={savingSnap}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
            >
              <Camera className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{savingSnap ? '保存中...' : '保存并留存持久化快照'}</span>
            </button>
            {persistedSnapshots.length > 0 && (
              <select
                aria-label="选择已留存的架构快照用于对比"
                value={baselineSnapshot?.generatedAt ?? ''}
                onChange={(e) => {
                  const found = persistedSnapshots.find((s) => s.mapData.generatedAt === e.target.value);
                  if (found) {
                    setBaselineSnapshot(found.mapData);
                    handleComputeDiff(found.mapData);
                  }
                }}
                className="px-2.5 py-1.5 text-xs font-mono bg-slate-50 border border-slate-300 rounded"
              >
                <option value="">已存快照 ({persistedSnapshots.length})…</option>
                {persistedSnapshots.map((s) => (
                  <option key={s.id} value={s.mapData.generatedAt}>
                    {s.id} ({s.nodeCount}节点)
                  </option>
                ))}
              </select>
            )}
            {baselineSnapshot && (
              <button
                type="button"
                onClick={() => handleComputeDiff()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded cursor-pointer"
              >
                <GitCompare className="w-3.5 h-3.5" aria-hidden="true" />
                <span>对比当前结构差异</span>
              </button>
            )}
          </div>
        </div>

        {/* Breadcrumbs */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={navigateBack}
              disabled={scopeStack.length <= 1}
              className="inline-flex items-center gap-1 px-2 py-1 text-slate-700 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
              <span>返回上一层</span>
            </button>
            <button
              type="button"
              onClick={() => navigateToStackIdx(0)}
              className="inline-flex items-center gap-1 px-2 py-1 text-slate-700 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
            >
              <Home className="w-3.5 h-3.5" aria-hidden="true" />
              <span>总体</span>
            </button>
            <nav aria-label="架构层级面包屑" className="flex flex-wrap items-center gap-1 ml-1 font-mono">
              {scopeStack.map((sid, idx) => {
                const sNode = nodeMap.get(sid);
                const isLast = idx === scopeStack.length - 1;
                return (
                  <span key={sid} className="inline-flex items-center gap-1">
                    {idx > 0 && <ChevronRight className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />}
                    <button
                      type="button"
                      onClick={() => navigateToStackIdx(idx)}
                      className={`px-1.5 py-0.5 rounded cursor-pointer ${
                        isLast ? 'bg-blue-50 text-blue-800 font-semibold' : 'text-slate-600 hover:underline'
                      }`}
                    >
                      {sNode?.label ?? sid}
                    </button>
                  </span>
                );
              })}
            </nav>
          </div>

          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden="true" />
              <input
                type="text"
                placeholder="筛选当前作用域节点..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 pr-3 py-1 text-xs bg-slate-50 border border-slate-300 rounded w-52"
              />
            </div>
            <button
              type="button"
              onClick={() => setPositions({})}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs text-slate-600 bg-slate-100 hover:bg-slate-200 rounded cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" aria-hidden="true" />
              <span>重置视图布局</span>
            </button>
          </div>
        </div>

        {/* Relation & Provenance Filters */}
        <div className="flex flex-wrap items-center justify-between gap-4 pt-2 border-t border-slate-100 text-[11px]">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-semibold text-slate-600">关系类型：</span>
            {(Object.keys(RELATION_META) as ArchRelationType[]).map((rel) => (
              <label key={rel} className="inline-flex items-center gap-1 cursor-pointer text-slate-700">
                <input
                  type="checkbox"
                  checked={activeRelations.has(rel)}
                  onChange={() => toggleRelation(rel)}
                />
                <span className="w-2.5 h-0.5 inline-block" style={{ backgroundColor: RELATION_META[rel].color }} />
                <span>{RELATION_META[rel].label}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-semibold text-slate-600">来源可信度：</span>
            {(Object.keys(PROVENANCE_META) as ArchProvenance[]).map((prov) => (
              <label key={prov} className="inline-flex items-center gap-1 cursor-pointer text-slate-700">
                <input
                  type="checkbox"
                  checked={activeProvenances.has(prov)}
                  onChange={() => toggleProvenance(prov)}
                />
                <span>{PROVENANCE_META[prov]}</span>
              </label>
            ))}
            <label className="inline-flex items-center gap-1 cursor-pointer text-blue-800 font-medium ml-2">
              <input
                type="checkbox"
                checked={highlightImpact}
                onChange={(e) => setHighlightImpact(e.target.checked)}
              />
              <span>高亮影响范围</span>
            </label>
          </div>
        </div>
      </div>

      {/* Main Grid: Interactive Graph + Inspector */}
      <div className="grid grid-cols-1 xl:grid-cols-[1fr_400px] gap-6 items-start">
        {/* Interactive Spatial SVG Graph */}
        <div className="bg-white border border-slate-200 rounded-md p-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>
              当前作用域：<strong className="text-slate-900">{nodeMap.get(currentScopeId)?.label}</strong> ·{' '}
              内部节点 {scopeChildren.length} 个 · 跨层关联外部节点 {externalNeighbors.length} 个（双击可进入内部）
            </span>
            <span className="text-[11px] text-slate-400">
              画布拖拽仅调整当前视图坐标，不会修改磁盘代码或真实系统结构
            </span>
          </div>

          <svg
            ref={svgRef}
            viewBox="0 0 920 460"
            className="w-full h-[460px] bg-slate-50 border border-slate-200 rounded select-none"
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            role="img"
            aria-label="OpenLab Bench 交互式架构地图"
            data-testid="architecture-map-svg"
          >
            <defs>
              <marker id="arch-arrow" markerWidth="8" markerHeight="6" refX="7" refY="3" orient="auto">
                <path d="M0,0 L8,3 L0,6 Z" fill="#64748b" />
              </marker>
            </defs>

            {/* Zone labels */}
            <text x="16" y="20" className="fill-slate-400 text-[10px] font-mono">
              当前位置
            </text>
            <text x="240" y="20" className="fill-slate-400 text-[10px] font-mono">
              内部构成 (双击进入下一层)
            </text>
            <text x="720" y="20" className="fill-slate-400 text-[10px] font-mono">
              跨界关联对象 (单实体不复制)
            </text>

            {/* Edges */}
            {visibleEdges.map((edge) => {
              const p1 = layoutPositions[edge.source];
              const p2 = layoutPositions[edge.target];
              if (!p1 || !p2) return null;
              const meta = RELATION_META[edge.relation];
              const dimmed =
                highlightImpact &&
                selectedNodeId &&
                !(edge.source === selectedNodeId || edge.target === selectedNodeId);
              const mx = (p1.x + p2.x) / 2;
              const my = (p1.y + p2.y) / 2 - (edge.isSelfReference ? 28 : 0);
              return (
                <g key={edge.id} opacity={dimmed ? 0.18 : 0.85}>
                  <path
                    d={
                      edge.isSelfReference
                        ? `M${p1.x},${p1.y} Q${mx},${my - 35} ${p2.x},${p2.y}`
                        : `M${p1.x},${p1.y} L${p2.x},${p2.y}`
                    }
                    fill="none"
                    stroke={meta.color}
                    strokeWidth={edge.source === selectedNodeId || edge.target === selectedNodeId ? 2 : 1.3}
                    strokeDasharray={meta.dash}
                    markerEnd="url(#arch-arrow)"
                  />
                  {edge.relation !== 'contains' && (
                    <text
                      x={mx}
                      y={my - 4}
                      textAnchor="middle"
                      className="fill-slate-600 text-[9px] font-mono"
                    >
                      {edge.relation}
                      {edge.isSelfReference ? ' [自引用]' : ''}
                    </text>
                  )}
                </g>
              );
            })}

            {/* Nodes */}
            {canvasNodes.map(({ node, isBoundaryScope, isExternal }) => {
              const pos = layoutPositions[node.id];
              if (!pos) return null;
              const st = STATUS_STYLE[node.status];
              const isSelected = node.id === selectedNodeId;
              const hasKids = (childrenMap.get(node.id)?.length ?? 0) > 0;
              const dimmed = highlightImpact && selectedNodeId && !impactSet.has(node.id) && !isBoundaryScope;
              const boxW = isBoundaryScope ? 174 : 200;
              const boxH = 42;
              const shortLabel = truncateVisualLabel(node.label, isBoundaryScope ? 22 : 26);

              return (
                <g
                  key={node.id}
                  transform={`translate(${pos.x - boxW / 2}, ${pos.y - boxH / 2})`}
                  onPointerDown={(e) => handlePointerDown(node.id, e)}
                  onDoubleClick={() => hasKids && enterNodeScope(node.id)}
                  className="cursor-grab active:cursor-grabbing"
                  opacity={dimmed ? 0.3 : 1}
                  data-node-id={node.id}
                >
                  <rect
                    width={boxW}
                    height={boxH}
                    rx="4"
                    fill={isSelected ? '#eff6ff' : st.fill}
                    stroke={isSelected ? '#1d4ed8' : st.stroke}
                    strokeWidth={isSelected ? 2 : 1.2}
                    strokeDasharray={isExternal ? '4 2' : undefined}
                  />
                  <text x="10" y="16" className="text-[11px] font-semibold" fill={st.text}>
                    {shortLabel}
                  </text>
                  <text x="10" y="32" className="text-[9px] font-mono" fill="#64748b">
                    {NODE_KIND_LABELS[node.kind] ?? node.kind} · {node.provenance}
                    {hasKids && !isBoundaryScope ? ` · +${childrenMap.get(node.id)?.length}内部` : ''}
                  </text>
                </g>
              );
            })}
          </svg>
        </div>

        {/* Right Inspector Panel */}
        <aside className="bg-white border border-slate-200 rounded-md p-4 space-y-4 text-xs">
          <div className="pb-3 border-b border-slate-200 space-y-1.5">
            <div className="flex items-center justify-between gap-2 font-mono text-[11px] text-slate-500">
              <span>{selectedNode.id}</span>
              <span className="font-sans font-semibold text-slate-800">
                状态：{STATUS_STYLE[selectedNode.status].badge}
              </span>
            </div>
            <h2 className="text-base font-semibold text-slate-900">{selectedNode.label}</h2>
            <p className="text-slate-600 leading-relaxed">{selectedNode.summary}</p>
          </div>

          {/* Provenance & Evidence */}
          <div className="space-y-1 bg-slate-50 border border-slate-200 rounded p-3">
            <div className="font-semibold text-slate-800">来源可信度：{PROVENANCE_META[selectedNode.provenance]}</div>
            <div className="text-slate-600">依据：{selectedNode.evidence}</div>
            {selectedNode.sourceFilePath && (
              <div className="font-mono text-[11px] text-slate-700 pt-1">
                磁盘位置：{selectedNode.sourceFilePath}
              </div>
            )}
            {selectedNode.codeHash && (
              <div className="font-mono text-[10px] text-slate-500 break-all">
                SHA-256: {selectedNode.codeHash}
              </div>
            )}
          </div>

          {/* Navigation / Drill-down / Cross-view Jump Actions */}
          <div className="flex flex-wrap gap-2">
            {selectedChildren.length > 0 && selectedNode.id !== currentScopeId && (
              <button
                type="button"
                onClick={() => enterNodeScope(selectedNode.id)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-semibold text-white bg-blue-700 hover:bg-blue-800 rounded cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5" aria-hidden="true" />
                <span>进入查看内部 ({selectedChildren.length})</span>
              </button>
            )}
            {selectedNode.linkTarget && selectedNode.linkTarget.tab !== 'architecture' && (
              <button
                type="button"
                onClick={() => onJumpToTarget(selectedNode.linkTarget!)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-medium text-blue-700 bg-blue-50 hover:bg-blue-100 rounded cursor-pointer"
              >
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
                <span>
                  跳转到
                  {selectedNode.linkTarget.tab === 'components'
                    ? '组件档案'
                    : selectedNode.linkTarget.tab === 'compare'
                      ? '方案对比'
                      : '实验台'}
                </span>
              </button>
            )}
          </div>

          {/* Internal Children Quick List */}
          {selectedChildren.length > 0 && (
            <div className="space-y-1.5">
              <div className="font-semibold text-slate-700">内部子部分 ({selectedChildren.length})</div>
              <div className="max-h-40 overflow-y-auto border border-slate-200 rounded divide-y divide-slate-100">
                {selectedChildren.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    onClick={() => {
                      if (selectedNode.id !== currentScopeId) {
                        enterNodeScope(selectedNode.id);
                      }
                      setSelectedNodeId(child.id);
                    }}
                    className="w-full text-left px-2.5 py-1.5 hover:bg-slate-50 flex items-center justify-between gap-2 cursor-pointer"
                  >
                    <span className="truncate font-medium text-slate-800">{child.label}</span>
                    <span className="font-mono text-[10px] text-slate-400 shrink-0">{child.kind}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Outgoing & Incoming Edges */}
          <div className="space-y-2">
            <div className="font-semibold text-slate-700">
              关联关系（出边 {selectedOutgoing.length} · 入边 {selectedIncoming.length}）
            </div>
            <div className="max-h-52 overflow-y-auto space-y-1.5 pr-1">
              {selectedOutgoing.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setSelectedNodeId(e.target)}
                  className="w-full text-left p-2 border border-slate-200 rounded hover:bg-slate-50 space-y-0.5 cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="font-semibold" style={{ color: RELATION_META[e.relation].color }}>
                      → {e.relation} {e.isSelfReference ? '[自引用]' : ''}
                    </span>
                    <span className="text-slate-400">{e.provenance}</span>
                  </div>
                  <div className="font-medium text-slate-800 flex items-center gap-1">
                    <ArrowRight className="w-3 h-3 text-slate-400 shrink-0" aria-hidden="true" />
                    <span className="truncate">{nodeMap.get(e.target)?.label ?? e.target}</span>
                  </div>
                  <div className="text-[11px] text-slate-500">{e.evidence}</div>
                </button>
              ))}
              {selectedIncoming.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => setSelectedNodeId(e.source)}
                  className="w-full text-left p-2 border border-slate-200 rounded hover:bg-slate-50 space-y-0.5 cursor-pointer"
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-[11px]">
                    <span className="font-semibold" style={{ color: RELATION_META[e.relation].color }}>
                      ← {e.relation}
                    </span>
                    <span className="text-slate-400">{e.provenance}</span>
                  </div>
                  <div className="font-medium text-slate-800 truncate">
                    来自：{nodeMap.get(e.source)?.label ?? e.source}
                  </div>
                  <div className="text-[11px] text-slate-500">{e.evidence}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Manual Epistemic Annotations for this Node */}
          <div className="pt-3 border-t border-slate-200 space-y-2">
            <div className="font-semibold text-slate-800">
              节点人工架构标注 (manual provenance)
            </div>
            {annotations
              .filter((a) => a.nodeId === selectedNode.id)
              .map((a) => (
                <div key={a.id} className="p-2 bg-amber-50/70 border border-amber-200 rounded text-[11px] space-y-0.5">
                  <div className="font-mono text-amber-900 font-semibold">
                    [{a.tag}] · {a.author}
                  </div>
                  <div className="text-slate-800">{a.note}</div>
                </div>
              ))}
            <form onSubmit={handleAddAnnotation} className="space-y-1.5">
              <div className="flex gap-1.5">
                <select
                  value={annoTag}
                  onChange={(e) => setAnnoTag(e.target.value as EpistemicTag)}
                  className="px-2 py-1 bg-white border border-slate-300 rounded text-[11px]"
                >
                  <option value="judgment">[判断]</option>
                  <option value="fact">[事实]</option>
                  <option value="hypothesis">[假设]</option>
                  <option value="proposal">[提议]</option>
                </select>
                <input
                  type="text"
                  value={annoText}
                  onChange={(e) => setAnnoText(e.target.value)}
                  placeholder="为当前节点添加人工边界标注或演化注记..."
                  className="flex-1 px-2 py-1 bg-white border border-slate-300 rounded text-[11px]"
                />
              </div>
              <button
                type="submit"
                disabled={savingAnno || !annoText.trim()}
                className="w-full py-1 text-[11px] font-medium text-slate-800 bg-slate-100 hover:bg-slate-200 border border-slate-300 rounded cursor-pointer"
              >
                {savingAnno ? '写入标注中...' : '保存节点标注'}
              </button>
            </form>
          </div>
        </aside>
      </div>

      {/* Snapshot Diff Panel (if computed) */}
      {snapshotDiff && (
        <section className="bg-white border border-blue-200 rounded-md p-4 space-y-3 text-xs">
          <h2 className="text-sm font-semibold text-slate-900">
            结构快照前后对比 (Structural Diff)
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3 font-mono">
            <div className="p-3 bg-slate-50 border border-slate-200 rounded">
              <div className="text-slate-500">新增节点 ({snapshotDiff.addedNodes.length})</div>
              <div className="mt-1 space-y-0.5 text-emerald-800">
                {snapshotDiff.addedNodes.length === 0
                  ? '无'
                  : snapshotDiff.addedNodes.map((n) => <div key={n.id}>+ {n.id}</div>)}
              </div>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded">
              <div className="text-slate-500">移除节点 ({snapshotDiff.removedNodes.length})</div>
              <div className="mt-1 space-y-0.5 text-rose-800">
                {snapshotDiff.removedNodes.length === 0
                  ? '无'
                  : snapshotDiff.removedNodes.map((n) => <div key={n.id}>- {n.id}</div>)}
              </div>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded">
              <div className="text-slate-500">状态/哈希变更 ({snapshotDiff.changedNodes.length})</div>
              <div className="mt-1 space-y-0.5 text-amber-800">
                {snapshotDiff.changedNodes.map((c) => (
                  <div key={c.id}>
                    ~ {c.id} ({c.beforeStatus} → {c.afterStatus})
                  </div>
                ))}
              </div>
            </div>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded">
              <div className="text-slate-500">新增关系边 ({snapshotDiff.addedEdges.length})</div>
              <div className="mt-1 space-y-0.5 text-blue-800 max-h-28 overflow-y-auto">
                {snapshotDiff.addedEdges.map((e) => (
                  <div key={e.id}>
                    + {e.source} → {e.target} ({e.relation}/{e.provenance})
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Bottom Panels: Anomalies + Honest Capability Matrix */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <section className="bg-white border border-slate-200 rounded-md p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-900">
              一致性与异常检测清单 ({mapData.anomalies.length})
            </h2>
            <span className="text-xs text-slate-500">真实扫描校验发现</span>
          </div>
          {mapData.anomalies.length === 0 ? (
            <div className="text-xs text-emerald-700">未发现目录未映射、哈希不一致或账本篡改异常。</div>
          ) : (
            <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
              {mapData.anomalies.map((anom, idx) => (
                <div
                  key={`${anom.code}-${anom.nodeId}-${idx}`}
                  className={`p-2.5 border rounded text-xs space-y-1 ${
                    anom.severity === 'error'
                      ? 'bg-rose-50/70 border-rose-200 text-rose-900'
                      : anom.severity === 'warning'
                        ? 'bg-amber-50/70 border-amber-200 text-amber-900'
                        : 'bg-slate-50 border-slate-200 text-slate-800'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 font-semibold">
                    <span className="inline-flex items-center gap-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      <span>[{anom.code}] {anom.message}</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setSelectedNodeId(anom.nodeId)}
                      className="text-blue-700 hover:underline font-normal shrink-0 cursor-pointer"
                    >
                      定位节点
                    </button>
                  </div>
                  <div className="font-mono text-[11px] opacity-80">{anom.evidence}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="bg-white border border-slate-200 rounded-md p-4 space-y-3 text-xs">
          <h2 className="text-sm font-semibold text-slate-900">
            架构地图当前第一版真实能力边界（不夸大静态扫描）
          </h2>
          <div className="space-y-2">
            <div>
              <div className="font-semibold text-emerald-800 mb-1">1. 真实扫描与运行观测实现</div>
              <ul className="list-disc pl-4 space-y-1 text-slate-700">
                {mapData.capabilitiesSummary.realImplemented.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
            <div className="pt-2 border-t border-slate-100">
              <div className="font-semibold text-amber-800 mb-1">2. 显式声明 / 尚未自动化扫描边界</div>
              <ul className="list-disc pl-4 space-y-1 text-slate-700">
                {mapData.capabilitiesSummary.declaredOrInferred.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

import fs from 'node:fs';
import path from 'node:path';
import type {
  ArchAnomaly,
  ArchEdge,
  ArchNode,
  ArchitectureMapData,
  ArchitectureSnapshotDiff,
  ComponentDossier,
  ExperimentRun,
  RuntimeEnvironmentSnapshot,
} from './types.ts';

export interface BuildArchitectureMapInput {
  rootDir: string;
  components: ComponentDossier[];
  runs: ExperimentRun[];
  runtimeEnv: RuntimeEnvironmentSnapshot;
}

const SOURCE_SCAN_TARGETS = [
  'server.ts',
  'server/storage.ts',
  'server/runner.ts',
  'server/ai.ts',
  'server/mjs_harness.mjs',
  'src/App.tsx',
  'src/core/types.ts',
  'src/core/optics.ts',
  'src/core/fits.ts',
  'src/core/architectureMap.ts',
  'src/components/TopBar.tsx',
  'src/components/ExperimentWorkspace.tsx',
  'src/components/ComponentLibrary.tsx',
  'src/components/RunComparison.tsx',
  'src/components/ArchitectureMapView.tsx',
  'src/components/OpticalViewport.tsx',
  'python/optiland_bridge.py',
];

function extractRelativeImports(filePath: string, rootDir: string): Array<{ targetRel: string; rawSpec: string }> {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, 'utf8');
  const results: Array<{ targetRel: string; rawSpec: string }> = [];
  const importRegex = /(?:import|from)\s+(?:[^'"]+\s+from\s+)?['"](\.[^'"]+)['"]/g;
  const dir = path.dirname(filePath);

  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(text)) !== null) {
    const rawSpec = match[1];
    const resolved = path.resolve(dir, rawSpec);
    const rel = path.relative(rootDir, resolved).replace(/\\/g, '/');
    results.push({ targetRel: rel, rawSpec });
  }
  return results;
}

export function buildArchitectureMap(input: BuildArchitectureMapInput): ArchitectureMapData {
  const { rootDir, components, runs, runtimeEnv } = input;
  const nodes: ArchNode[] = [];
  const edges: ArchEdge[] = [];
  const anomalies: ArchAnomaly[] = [];
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  const addNode = (node: ArchNode) => {
    if (!nodeIds.has(node.id)) {
      nodeIds.add(node.id);
      nodes.push(node);
    }
  };

  const addEdge = (edge: ArchEdge) => {
    if (!edgeIds.has(edge.id)) {
      edgeIds.add(edge.id);
      edges.push(edge);
    }
  };

  const rootScopeId = 'scope:openlab-bench';
  addNode({
    id: rootScopeId,
    label: 'OpenLab Bench 工作台总体结构',
    kind: 'scope',
    parentId: null,
    provenance: 'declared',
    evidence: '当前工作台顶层作用域，聚合磁盘组件、源码模块、实验账本与运行环境。',
    status: 'healthy',
    summary: '可自由拆解、编辑与重组的开放科学实验系统。支持从整体逐层进入局部，并在任意层级返回。',
  });

  // Top-level structural scopes
  const scopes: Array<{ id: string; label: string; summary: string; linkTab?: 'experiment' | 'components' | 'compare' | 'architecture' }> = [
    {
      id: 'scope:components',
      label: '独立组件库 (workspace/components)',
      summary: '文件系统优先的可替换零件层：求解器、评价器、优化器、分析插件及架构地图引擎自身。',
      linkTab: 'components',
    },
    {
      id: 'scope:experiments',
      label: '实验谱系与不可变账本 (workspace/runs.jsonl)',
      summary: '记录光学系统前后状态、完整原始计算产物、随机种子、环境版本与 64 位 SHA-256 指纹。',
      linkTab: 'experiment',
    },
    {
      id: 'scope:source-core',
      label: '核心源码与执行桥梁 (src/ · server/ · python/)',
      summary: '基于真实文件系统静态 import 扫描的前后端与本地进程执行桥梁。',
    },
    {
      id: 'scope:runtime-host',
      label: `宿主运行环境 (${runtimeEnv.hostMode === 'local_python_ready' ? '本地 Python+Optiland 就绪' : '云端受限预览'})`,
      summary: `Node ${runtimeEnv.nodeVersion} · Python ${runtimeEnv.pythonVersion ?? '未检出'} · Optiland ${runtimeEnv.optilandVersion ?? '未安装'}`,
    },
  ];

  for (const sc of scopes) {
    addNode({
      id: sc.id,
      label: sc.label,
      kind: 'scope',
      parentId: rootScopeId,
      provenance: 'scanned',
      evidence: `真实工作区顶层划分：${sc.id}`,
      status:
        sc.id === 'scope:runtime-host' && !runtimeEnv.optilandVersion ? 'unavailable' : 'healthy',
      summary: sc.summary,
      linkTarget: sc.linkTab ? { tab: sc.linkTab, targetId: sc.id } : undefined,
    });
    addEdge({
      id: `e:${rootScopeId}->${sc.id}:contains`,
      source: rootScopeId,
      target: sc.id,
      relation: 'contains',
      provenance: 'scanned',
      evidence: '顶层架构作用域包含关系',
    });
  }

  // 1. Scan workspace/components directory directly for unmapped folders too
  const componentsDir = path.join(rootDir, 'workspace', 'components');
  const knownComponentIds = new Set(components.map((c) => c.id));
  if (fs.existsSync(componentsDir)) {
    const entries = fs.readdirSync(componentsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const dir of entries) {
      const dossierPath = path.join(componentsDir, dir.name, 'dossier.json');
      if (!fs.existsSync(dossierPath) || !knownComponentIds.has(dir.name)) {
        const unmappedId = `unmapped:${dir.name}`;
        addNode({
          id: unmappedId,
          label: `未建档目录: ${dir.name}`,
          kind: 'component',
          parentId: 'scope:components',
          provenance: 'scanned',
          evidence: `磁盘存在目录 workspace/components/${dir.name}，但缺少有效 dossier.json`,
          status: 'unmapped',
          summary: '磁盘发现未映射目录，需补全 dossier.json 契约或清理。',
          sourceFilePath: `workspace/components/${dir.name}`,
        });
        addEdge({
          id: `e:scope:components->${unmappedId}:contains`,
          source: 'scope:components',
          target: unmappedId,
          relation: 'contains',
          provenance: 'scanned',
          evidence: `fs.readdirSync(workspace/components) 发现目录 ${dir.name}`,
        });
        anomalies.push({
          severity: 'warning',
          code: 'unmapped_directory',
          nodeId: unmappedId,
          message: `目录 workspace/components/${dir.name} 缺少有效 dossier.json，未纳入受控组件清单`,
          evidence: dossierPath,
        });
      }
    }
  }

  // 2. Scan real source modules & static imports
  const knownSourceSet = new Set(SOURCE_SCAN_TARGETS);
  for (const rel of SOURCE_SCAN_TARGETS) {
    const absPath = path.join(rootDir, rel);
    if (!fs.existsSync(absPath)) continue;
    const modId = `mod:${rel}`;
    addNode({
      id: modId,
      label: rel,
      kind: 'source_module',
      parentId: 'scope:source-core',
      provenance: 'scanned',
      evidence: `真实存在于磁盘的文件 ${rel}`,
      status:
        rel === 'python/optiland_bridge.py' && !runtimeEnv.optilandVersion ? 'unavailable' : 'healthy',
      summary: `源码模块 ${rel}`,
      sourceFilePath: rel,
    });
    addEdge({
      id: `e:scope:source-core->${modId}:contains`,
      source: 'scope:source-core',
      target: modId,
      relation: 'contains',
      provenance: 'scanned',
      evidence: `磁盘文件扫描: ${rel}`,
    });

    const imports = extractRelativeImports(absPath, rootDir);
    for (const imp of imports) {
      if (knownSourceSet.has(imp.targetRel)) {
        const targetModId = `mod:${imp.targetRel}`;
        addEdge({
          id: `e:${modId}->${targetModId}:depends_on`,
          source: modId,
          target: targetModId,
          relation: 'depends_on',
          provenance: 'scanned',
          evidence: `${rel} 静态 import '${imp.rawSpec}'`,
        });
      }
    }
  }

  // Declared bridge connection from server/mjs_harness.mjs and server/runner.ts to python/optiland_bridge.py
  if (knownSourceSet.has('server/runner.ts') && knownSourceSet.has('python/optiland_bridge.py')) {
    addEdge({
      id: 'e:mod:server/runner.ts->mod:python/optiland_bridge.py:uses',
      source: 'mod:server/runner.ts',
      target: 'mod:python/optiland_bridge.py',
      relation: 'uses',
      provenance: 'declared',
      evidence: 'server/runner.ts 通过 child_process.execFile 调用 python/optiland_bridge.py',
    });
  }
  if (knownSourceSet.has('server/runner.ts') && knownSourceSet.has('server/mjs_harness.mjs')) {
    addEdge({
      id: 'e:mod:server/runner.ts->mod:server/mjs_harness.mjs:uses',
      source: 'mod:server/runner.ts',
      target: 'mod:server/mjs_harness.mjs',
      relation: 'uses',
      provenance: 'declared',
      evidence: 'server/runner.ts 通过 child_process.execFile 调用 server/mjs_harness.mjs',
    });
  }

  // 3. Register all ComponentDossiers and their internal parts & anomalies
  const observedComponentUsage = new Set<string>();
  for (const run of runs) {
    for (const part of run.composition?.parts ?? []) {
      observedComponentUsage.add(part.componentId);
    }
    for (const ev of run.evaluations ?? []) {
      observedComponentUsage.add(ev.evaluatorId);
    }
    for (const sa of run.standaloneAnalyses ?? []) {
      observedComponentUsage.add(sa.componentId);
    }
  }

  for (const comp of components) {
    const compNodeId = `comp:${comp.id}`;
    const envBlocked = comp.runtime === 'local_process_py' && !runtimeEnv.optilandVersion;
    const isStaleCheck = comp.selfCheck.status === 'unrun' || comp.selfCheck.status === 'failed';
    let compStatus: ArchNode['status'] = 'healthy';
    if (comp.diskTamperDetected) compStatus = 'error';
    else if (envBlocked) compStatus = 'unavailable';
    else if (isStaleCheck || comp.codeSecurityReview.status === 'unreviewed_modified') compStatus = 'warning';

    const activeVer = comp.versions.find((v) => v.version === comp.activeVersion) ?? comp.versions[0];
    const activeCodeRel = activeVer ? `workspace/components/${comp.id}/${activeVer.version}/${activeVer.codeFile}` : undefined;

    addNode({
      id: compNodeId,
      label: `${comp.name} (${comp.activeVersion})`,
      kind: 'component',
      parentId: 'scope:components',
      provenance: 'scanned',
      evidence: `扫描自 workspace/components/${comp.id}/dossier.json`,
      status: compStatus,
      summary: comp.summary,
      codeHash: comp.diskActualHash ?? activeVer?.codeHash,
      sourceFilePath: activeCodeRel,
      linkTarget: { tab: 'components', targetId: comp.id },
    });
    addEdge({
      id: `e:scope:components->${compNodeId}:contains`,
      source: 'scope:components',
      target: compNodeId,
      relation: 'contains',
      provenance: 'scanned',
      evidence: `workspace/components/${comp.id}/dossier.json`,
    });

    // Version subparts inside component (enables entering ANY component to inspect its internal versions/code)
    for (const ver of comp.versions) {
      const verNodeId = `sub:${comp.id}@${ver.version}`;
      const isActive = ver.version === comp.activeVersion;
      addNode({
        id: verNodeId,
        label: `${ver.version} (${ver.codeFile})${isActive ? ' · 当前默认' : ''}`,
        kind: 'subpart',
        parentId: compNodeId,
        provenance: 'scanned',
        evidence: `版本档案记录与磁盘文件 workspace/components/${comp.id}/${ver.version}/${ver.codeFile}`,
        status: isActive && comp.diskTamperDetected ? 'error' : 'healthy',
        summary: ver.changeSummary,
        codeHash: ver.codeHash,
        sourceFilePath: `workspace/components/${comp.id}/${ver.version}/${ver.codeFile}`,
        linkTarget: { tab: 'components', targetId: comp.id },
      });
      addEdge({
        id: `e:${compNodeId}->${verNodeId}:contains`,
        source: compNodeId,
        target: verNodeId,
        relation: 'contains',
        provenance: 'scanned',
        evidence: 'dossier.versions[]',
      });
      if (ver.parentVersion) {
        const parentVerNodeId = `sub:${comp.id}@${ver.parentVersion}`;
        addEdge({
          id: `e:${verNodeId}->${parentVerNodeId}:derives_from`,
          source: verNodeId,
          target: parentVerNodeId,
          relation: 'derives_from',
          provenance: 'scanned',
          evidence: `parentVersion = ${ver.parentVersion}`,
        });
      }
    }

    // Dependencies declared in dossier
    for (const dep of comp.dependencies) {
      if (dep.kind === 'module') {
        const targetModId = `mod:${dep.targetId}`;
        if (knownSourceSet.has(dep.targetId)) {
          addEdge({
            id: `e:${compNodeId}->${targetModId}:depends_on`,
            source: compNodeId,
            target: targetModId,
            relation: 'depends_on',
            provenance: 'declared',
            evidence: `${comp.id} 档案声明依赖源码 ${dep.targetId}：${dep.reason}`,
          });
        }
      } else if (dep.kind === 'component') {
        const targetCompId = `comp:${dep.targetId}`;
        addEdge({
          id: `e:${compNodeId}->${targetCompId}:depends_on`,
          source: compNodeId,
          target: targetCompId,
          relation: 'depends_on',
          provenance: 'declared',
          evidence: `${comp.id} 档案声明依赖组件 ${dep.targetId}：${dep.reason}`,
        });
        if (!knownComponentIds.has(dep.targetId)) {
          anomalies.push({
            severity: 'error',
            code: 'unobserved_declared_dependency',
            nodeId: compNodeId,
            message: `${comp.name} 声明依赖组件 ${dep.targetId}，但在当前组件库中未找到`,
            evidence: dep.reason,
          });
        }
      }
    }

    // Anomaly: disk hash mismatch
    if (comp.diskTamperDetected) {
      anomalies.push({
        severity: 'error',
        code: 'disk_hash_mismatch',
        nodeId: compNodeId,
        message: `${comp.name} 磁盘源码实际哈希与已确认哈希不一致，执行已自动阻止`,
        evidence: `disk=${comp.diskActualHash?.slice(0, 16)}... vs approved=${comp.codeSecurityReview.approvedHash?.slice(0, 16) ?? 'none'}...`,
      });
    }

    // Anomaly: stale or failed self-check
    if (comp.selfCheck.status === 'unrun' && !envBlocked) {
      anomalies.push({
        severity: 'warning',
        code: 'stale_self_check',
        nodeId: compNodeId,
        message: `${comp.name} 尚未运行自检或源码变更后自检已过期`,
        evidence: comp.selfCheck.summary,
      });
    } else if (comp.selfCheck.status === 'failed') {
      anomalies.push({
        severity: 'error',
        code: 'stale_self_check',
        nodeId: compNodeId,
        message: `${comp.name} 自检失败`,
        evidence: comp.selfCheck.summary,
      });
    }

    // Anomaly: Python/Optiland unavailable in current host
    if (envBlocked) {
      anomalies.push({
        severity: 'info',
        code: 'env_unavailable',
        nodeId: compNodeId,
        message: `${comp.name} 在当前环境不可执行（缺少 Python >= 3.11 或 optiland）`,
        evidence: `当前 Python=${runtimeEnv.pythonVersion ?? 'none'}, Optiland=${runtimeEnv.optilandVersion ?? 'none'}`,
      });
    }

    // Anomaly: component has never been observed in any run (except arch-map-engine and dormant fits)
    if (
      comp.id !== 'arch-map-engine' &&
      comp.id !== 'fits-photometry-reader' &&
      !envBlocked &&
      !observedComponentUsage.has(comp.id)
    ) {
      anomalies.push({
        severity: 'info',
        code: 'unobserved_declared_dependency',
        nodeId: compNodeId,
        message: `${comp.name} 已在磁盘建档，但尚未在 workspace/runs.jsonl 任何实验中观测到调用记录`,
        evidence: '待在实验台或独立测试中运行后将建立 observed 调用边',
      });
    }
  }

  // 4. Self-representing Architecture Map Engine subparts (bounded 1-step self-reference)
  if (knownComponentIds.has('arch-map-engine')) {
    const archCompNodeId = 'comp:arch-map-engine';
    const subParts: Array<{
      id: string;
      label: string;
      summary: string;
      targetId: string;
      relation: 'uses' | 'depends_on';
    }> = [
      {
        id: 'sub:arch-collector',
        label: '结构数据采集器 (Collector)',
        summary: '读取 workspace/components/*、静态 import 与 runs.jsonl 原始记录。',
        targetId: 'mod:server/storage.ts',
        relation: 'uses',
      },
      {
        id: 'sub:arch-resolver',
        label: '关系与溯源解析器 (Relation Resolver)',
        summary: '区分 contains / depends_on / uses / produces / derives_from / represents 与来源可信度。',
        targetId: 'mod:src/core/architectureMap.ts',
        relation: 'depends_on',
      },
      {
        id: 'sub:arch-checker',
        label: '一致性与过期检查器 (Integrity Checker)',
        summary: '交叉核验磁盘 SHA-256、自检过期、运行环境缺失与未建档目录。',
        targetId: 'store:runs-jsonl',
        relation: 'uses',
      },
      {
        id: 'sub:arch-layout',
        label: '分层视图布局器 (Layout Engine)',
        summary: '按作用域层次排列节点；支持视图拖拽但明确不修改真实结构。',
        targetId: 'mod:src/components/ArchitectureMapView.tsx',
        relation: 'depends_on',
      },
      {
        id: 'sub:arch-navigator',
        label: '局部下钻与面包屑导航 (Navigator)',
        summary: '维护任意层级的进入与返回路径栈。',
        targetId: 'mod:src/components/ArchitectureMapView.tsx',
        relation: 'depends_on',
      },
      {
        id: 'sub:arch-renderer',
        label: '图谱与详情渲染器 (Renderer)',
        summary: '渲染关系过滤、影响高亮、异常清单与结构快照 Diff。',
        targetId: 'mod:src/components/ArchitectureMapView.tsx',
        relation: 'depends_on',
      },
    ];

    for (const sp of subParts) {
      addNode({
        id: sp.id,
        label: sp.label,
        kind: 'subpart',
        parentId: archCompNodeId,
        provenance: 'declared',
        evidence: 'arch-map-engine 自描述内部构造拆分',
        status: 'healthy',
        summary: sp.summary,
        sourceFilePath: sp.targetId.startsWith('mod:') ? sp.targetId.slice(4) : undefined,
        linkTarget: { tab: 'architecture', targetId: sp.id },
      });
      addEdge({
        id: `e:${archCompNodeId}->${sp.id}:contains`,
        source: archCompNodeId,
        target: sp.id,
        relation: 'contains',
        provenance: 'declared',
        evidence: '整体架构地图引擎内部子部件',
      });
      addEdge({
        id: `e:${sp.id}->${sp.targetId}:${sp.relation}`,
        source: sp.id,
        target: sp.targetId,
        relation: sp.relation,
        provenance: 'declared',
        evidence: `${sp.label} 实现模块映射`,
      });
    }

    // Controlled, non-infinite self-reference edge
    addEdge({
      id: `e:${archCompNodeId}->${rootScopeId}:represents`,
      source: archCompNodeId,
      target: rootScopeId,
      relation: 'represents',
      provenance: 'observed',
      evidence: '受控单步自引用：架构地图引擎作为系统组件，实时观测并映射整个 OpenLab Bench（渲染时阻断无限递归）。',
      isSelfReference: true,
    });
  }

  // 5. Artifact stores & Experiment Runs from runs.jsonl
  addNode({
    id: 'store:runs-jsonl',
    label: '实验账本 (workspace/runs.jsonl)',
    kind: 'artifact_store',
    parentId: 'scope:experiments',
    provenance: 'scanned',
    evidence: `真实账本文件，共 ${runs.length} 条实验记录`,
    status: runs.some((r) => r.tamperStatus === 'tampered') ? 'error' : 'healthy',
    summary: '不可变追加实验历史，含系统配置、rawArtifacts 原始产物与 64 位 SHA-256 哈希。',
    sourceFilePath: 'workspace/runs.jsonl',
    linkTarget: { tab: 'compare', targetId: 'store:runs-jsonl' },
  });
  addEdge({
    id: 'e:scope:experiments->store:runs-jsonl:contains',
    source: 'scope:experiments',
    target: 'store:runs-jsonl',
    relation: 'contains',
    provenance: 'scanned',
    evidence: 'workspace/runs.jsonl',
  });

  addNode({
    id: 'store:thread-jsonl',
    label: '研究脉络账本 (workspace/thread.jsonl)',
    kind: 'artifact_store',
    parentId: 'scope:experiments',
    provenance: 'scanned',
    evidence: '记录用户原话、计算证据、评价判定与 AI 假设（明确区分来源）',
    status: 'healthy',
    summary: '研究脉络与决策记录账本。',
    sourceFilePath: 'workspace/thread.jsonl',
    linkTarget: { tab: 'experiment', targetId: 'store:thread-jsonl' },
  });
  addEdge({
    id: 'e:scope:experiments->store:thread-jsonl:contains',
    source: 'scope:experiments',
    target: 'store:thread-jsonl',
    relation: 'contains',
    provenance: 'scanned',
    evidence: 'workspace/thread.jsonl',
  });

  for (const run of runs) {
    const runNodeId = `run:${run.id}`;
    const tampered = run.tamperStatus === 'tampered';
    addNode({
      id: runNodeId,
      label: `Run #${run.sequenceNumber} · ${run.branchLabel}`,
      kind: 'experiment_run',
      parentId: 'scope:experiments',
      provenance: 'observed',
      evidence: `从 workspace/runs.jsonl 读取真实记录 ${run.id} (${run.tamperStatus ?? 'verified'})`,
      status: tampered ? 'error' : run.status === 'failed' ? 'warning' : 'healthy',
      summary: `${run.intent} (seed=${run.seed}, EFL=${run.rawArtifactsAfter?.paraxialEflMm ?? '?'}mm, RMS=${run.rawArtifactsAfter?.rmsSpotRadiusUm ?? '?'}μm)`,
      codeHash: run.recordIntegrityHash,
      linkTarget: { tab: 'experiment', targetId: run.id },
    });

    addEdge({
      id: `e:scope:experiments->${runNodeId}:contains`,
      source: 'scope:experiments',
      target: runNodeId,
      relation: 'contains',
      provenance: 'observed',
      evidence: `workspace/runs.jsonl 中的运行记录 ${run.id}`,
    });

    addEdge({
      id: `e:${runNodeId}->store:runs-jsonl:produces`,
      source: runNodeId,
      target: 'store:runs-jsonl',
      relation: 'produces',
      provenance: 'observed',
      evidence: `产出不可变计算产物与完整性指纹 ${run.rawArtifactsHash.slice(0, 12)}...`,
    });

    if (run.parentRunId) {
      const parentRunNode = `run:${run.parentRunId}`;
      addEdge({
        id: `e:${runNodeId}->${parentRunNode}:derives_from`,
        source: runNodeId,
        target: parentRunNode,
        relation: 'derives_from',
        provenance: 'observed',
        evidence: `parentRunId = ${run.parentRunId}`,
      });
    }

    for (const part of run.composition?.parts ?? []) {
      const targetCompId = `comp:${part.componentId}`;
      if (nodeIds.has(targetCompId)) {
        addEdge({
          id: `e:${runNodeId}->${targetCompId}:uses:${part.slot}`,
          source: runNodeId,
          target: targetCompId,
          relation: 'uses',
          provenance: 'observed',
          evidence: `运行槽位 [${part.slot}] 实际执行了 ${part.componentId}@${part.version}`,
        });
      }
    }

    for (const ev of run.evaluations ?? []) {
      const targetCompId = `comp:${ev.evaluatorId}`;
      if (nodeIds.has(targetCompId)) {
        addEdge({
          id: `e:${runNodeId}->${targetCompId}:uses:reeval:${ev.id}`,
          source: runNodeId,
          target: targetCompId,
          relation: 'uses',
          provenance: 'observed',
          evidence: `对已保存原始产物执行评价 (${ev.evaluatorVersion} → ${ev.status})`,
        });
      }
    }

    for (const sa of run.standaloneAnalyses ?? []) {
      const targetCompId = `comp:${sa.componentId}`;
      if (nodeIds.has(targetCompId)) {
        addEdge({
          id: `e:${runNodeId}->${targetCompId}:uses:standalone:${sa.id}`,
          source: runNodeId,
          target: targetCompId,
          relation: 'uses',
          provenance: 'observed',
          evidence: `独立运行插件 ${sa.componentId}@${sa.version} 分析该运行原始产物`,
        });
      }
    }

    if (tampered) {
      anomalies.push({
        severity: 'error',
        code: 'tampered_run_record',
        nodeId: runNodeId,
        message: `Run #${run.sequenceNumber} (${run.id}) 的 64 位 SHA-256 完整性校验失败，可能已被人工篡改`,
        evidence: `recordIntegrityHash=${run.recordIntegrityHash}`,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    rootScopeId,
    nodes,
    edges,
    anomalies,
    capabilitiesSummary: {
      realImplemented: [
        '实时扫描 workspace/components/* 目录、dossier.json 与磁盘源码 SHA-256 哈希',
        '真实正则扫描 src/、server/、python/ 顶层相对路径 static import 依赖',
        '读取 workspace/runs.jsonl 还原真实实验组合调用 (observed uses)、父子派生 (derives_from) 与重评记录',
        '实时探测宿主机 Node/Python/Optiland 状态、未建档目录、自检过期与实验篡改异常',
        '通过受控单步自引用 (isSelfReference=true) 将架构地图引擎自身纳入结构图谱且防止无限递归',
      ],
      declaredOrInferred: [
        'arch-map-engine 内部的 6 个子模块分工边为显式架构声明 (declared)',
        '尚未在 runs.jsonl 出现过的独立组件依赖标注为声明 (declared) 并提示未观测到调用',
        '暂未展开动态路径拼接或函数级 AST 调用图，也不支持在画布拖拽后反向改写源码',
      ],
    },
  };
}

export function diffArchitectureSnapshots(
  before: ArchitectureMapData,
  after: ArchitectureMapData,
): ArchitectureSnapshotDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));
  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdges = new Map(after.edges.map((e) => [e.id, e]));

  const addedNodes = after.nodes.filter((n) => !beforeNodes.has(n.id));
  const removedNodes = before.nodes.filter((n) => !afterNodes.has(n.id));
  const changedNodes: ArchitectureSnapshotDiff['changedNodes'] = [];

  for (const afterNode of after.nodes) {
    const prev = beforeNodes.get(afterNode.id);
    if (prev && (prev.status !== afterNode.status || prev.codeHash !== afterNode.codeHash)) {
      changedNodes.push({
        id: afterNode.id,
        label: afterNode.label,
        beforeStatus: prev.status,
        afterStatus: afterNode.status,
        beforeHash: prev.codeHash,
        afterHash: afterNode.codeHash,
      });
    }
  }

  const addedEdges = after.edges.filter((e) => !beforeEdges.has(e.id));
  const removedEdges = before.edges.filter((e) => !afterEdges.has(e.id));

  const anomalyKey = (a: ArchAnomaly) => `${a.code}::${a.nodeId}::${a.message}`;
  const beforeAnomSet = new Set(before.anomalies.map(anomalyKey));
  const afterAnomSet = new Set(after.anomalies.map(anomalyKey));

  const addedAnomalies = after.anomalies.filter((a) => !beforeAnomSet.has(anomalyKey(a)));
  const resolvedAnomalies = before.anomalies.filter((a) => !afterAnomSet.has(anomalyKey(a)));

  return {
    addedNodes,
    removedNodes,
    changedNodes,
    addedEdges,
    removedEdges,
    addedAnomalies,
    resolvedAnomalies,
  };
}

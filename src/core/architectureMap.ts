import fs from 'node:fs';
import path from 'node:path';
import type {
  ArchAnomaly,
  ArchEdge,
  ArchNode,
  ArchitectureAnnotation,
  ArchitectureMapData,
  ArchitectureSnapshotDiff,
  ArtifactRef,
  ComponentDossier,
  ExperimentRun,
  ResearchStudy,
  RuntimeEnvironmentSnapshot,
  StudyBranch,
  WorkflowExecution,
} from './types.ts';

export interface BuildArchitectureMapInput {
  rootDir: string;
  components: ComponentDossier[];
  runs: ExperimentRun[];
  runtimeEnv: RuntimeEnvironmentSnapshot;
  studies?: ResearchStudy[];
  branches?: StudyBranch[];
  executions?: WorkflowExecution[];
  artifacts?: ArtifactRef[];
  annotations?: ArchitectureAnnotation[];
  pythonEnvDetails?: {
    executable: string | null;
    packages: Record<string, string | null>;
  };
}

function discoverRepoSourceFiles(rootDir: string): string[] {
  const roots = [
    'server.ts',
    'src',
    'server',
    'python',
    path.join('experiments', 'p2_flagship', 'scripts'),
  ];
  const collected: string[] = [];
  const exts = new Set(['.ts', '.tsx', '.mjs', '.py']);

  const walk = (absDir: string) => {
    if (!fs.existsSync(absDir)) return;
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__pycache__') {
        continue;
      }
      const absChild = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(absChild);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (exts.has(ext) && !entry.name.endsWith('.test.ts')) {
          collected.push(path.relative(rootDir, absChild).replace(/\\/g, '/'));
        }
      }
    }
  };

  for (const r of roots) {
    const abs = path.join(rootDir, r);
    if (!fs.existsSync(abs)) continue;
    const stat = fs.statSync(abs);
    if (stat.isFile()) {
      collected.push(r.replace(/\\/g, '/'));
    } else if (stat.isDirectory()) {
      walk(abs);
    }
  }

  return Array.from(new Set(collected)).sort();
}

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
  const {
    rootDir,
    components,
    runs,
    runtimeEnv,
    studies = [],
    branches = [],
    executions = [],
    artifacts = [],
    annotations = [],
    pythonEnvDetails,
  } = input;
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
    evidence: '当前工作台顶层作用域，聚合研究课题分支、磁盘组件、源码模块、异步执行器、P1/P2 产物与运行环境。',
    status: 'healthy',
    summary: '可自由拆解、编辑与重组的开放科学实验系统。支持从整体逐层进入局部，并在任意层级返回。',
  });

  const scopes: Array<{ id: string; label: string; summary: string; linkTab?: 'experiment' | 'components' | 'compare' | 'architecture' }> = [
    ...(studies.length > 0
      ? [
          {
            id: 'scope:studies',
            label: `研究课题与探索分支 (${studies.length} 课题 · ${branches.length} 分支)`,
            summary: '围绕开放科学工程问题组织的研究对象、阶段演进、多分支假设与显式采纳状态。',
            linkTab: 'experiment' as const,
          },
        ]
      : []),
    {
      id: 'scope:components',
      label: '独立组件库 (workspace/components)',
      summary: '文件系统优先的可替换零件层：求解器、评价器、优化器、FITS 分析插件及架构地图引擎自身。',
      linkTab: 'components',
    },
    {
      id: 'scope:experiments',
      label: '实验谱系与不可变账本 (workspace/runs.jsonl)',
      summary: '记录光学系统前后状态、完整原始计算产物、随机种子、环境版本与 64 位 SHA-256 指纹。',
      linkTab: 'compare',
    },
    {
      id: 'scope:source-core',
      label: '核心源码与执行桥梁 (src/ · server/ · python/ · experiments/)',
      summary: '基于真实文件系统动态递归扫描的前后端模块、Python 科学桥接与脚本。',
    },
    {
      id: 'scope:runtime-host',
      label: `宿主运行环境 (${runtimeEnv.hostMode === 'local_python_ready' ? 'Python 科学环境就绪' : '云端受限预览'})`,
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

  if (pythonEnvDetails?.executable || runtimeEnv.optilandVersion) {
    const pkgSummary = pythonEnvDetails?.packages
      ? Object.entries(pythonEnvDetails.packages)
          .filter(([, v]) => Boolean(v))
          .map(([k, v]) => `${k}==${v}`)
          .join(' · ')
      : `optiland==${runtimeEnv.optilandVersion ?? '?'}`;
    addNode({
      id: 'runtime:python-scientific-env',
      label: `Python 科学计算宿主 (${runtimeEnv.optilandVersion ? `Optiland ${runtimeEnv.optilandVersion}` : '受限'})`,
      kind: 'runtime_host',
      parentId: 'scope:runtime-host',
      provenance: 'observed',
      evidence: `动态探针探测可执行文件 ${pythonEnvDetails?.executable ?? 'python3'}`,
      status: runtimeEnv.optilandVersion ? 'healthy' : 'unavailable',
      summary: pkgSummary || '未检出科学计算包',
      sourceFilePath: pythonEnvDetails?.executable ?? undefined,
    });
    addEdge({
      id: 'e:scope:runtime-host->runtime:python-scientific-env:contains',
      source: 'scope:runtime-host',
      target: 'runtime:python-scientific-env',
      relation: 'contains',
      provenance: 'observed',
      evidence: '宿主机 Python 环境实时探针',
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

  // 2. Scan real source modules & static imports dynamically across src/, server/, python/, experiments/p2_flagship/scripts/
  const discoveredSourceFiles = discoverRepoSourceFiles(rootDir);
  const knownSourceSet = new Set(discoveredSourceFiles);
  for (const rel of discoveredSourceFiles) {
    const absPath = path.join(rootDir, rel);
    if (!fs.existsSync(absPath)) continue;
    const modId = `mod:${rel}`;
    const isPyBridge = rel.startsWith('python/') || rel.startsWith('experiments/');
    addNode({
      id: modId,
      label: rel,
      kind: 'source_module',
      parentId: 'scope:source-core',
      provenance: 'scanned',
      evidence: `真实存在于磁盘的文件 ${rel}`,
      status: isPyBridge && !runtimeEnv.optilandVersion ? 'unavailable' : 'healthy',
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
      const candidates = [imp.targetRel, `${imp.targetRel}.ts`, `${imp.targetRel}.tsx`, `${imp.targetRel}.mjs`];
      const matchedRel = candidates.find((c) => knownSourceSet.has(c));
      if (matchedRel) {
        const targetModId = `mod:${matchedRel}`;
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

  // Declared bridge connections to subprocess runners
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
  if (knownSourceSet.has('server/workbench.ts') && knownSourceSet.has('python/workbench_p2_runner.py')) {
    addEdge({
      id: 'e:mod:server/workbench.ts->mod:python/workbench_p2_runner.py:uses',
      source: 'mod:server/workbench.ts',
      target: 'mod:python/workbench_p2_runner.py',
      relation: 'uses',
      provenance: 'declared',
      evidence: 'server/workbench.ts 通过受控异步 spawn 调用 python/workbench_p2_runner.py',
    });
  }
  if (
    knownSourceSet.has('python/workbench_p2_runner.py') &&
    knownSourceSet.has('experiments/p2_flagship/scripts/wf_rc_models.py')
  ) {
    addEdge({
      id: 'e:mod:python/workbench_p2_runner.py->mod:experiments/p2_flagship/scripts/wf_rc_models.py:depends_on',
      source: 'mod:python/workbench_p2_runner.py',
      target: 'mod:experiments/p2_flagship/scripts/wf_rc_models.py',
      relation: 'depends_on',
      provenance: 'declared',
      evidence: 'workbench_p2_runner.py 导入 P2 真实参数化望远镜物理模型',
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

  // 6. ResearchStudies, StudyBranches, WorkflowExecutions & Typed Artifacts (OpenLab Bench v2)
  for (const study of studies) {
    const studyNodeId = `study:${study.id}`;
    addNode({
      id: studyNodeId,
      label: study.title,
      kind: 'research_study',
      parentId: 'scope:studies',
      provenance: study.provenanceTier === 'workbench_native' ? 'observed' : 'scanned',
      provenanceTier: study.provenanceTier,
      evidence: `研究课题 [${study.slug}] (${study.provenanceTier})`,
      status: study.status === 'archived' ? 'warning' : 'healthy',
      summary: study.problemStatement,
      linkTarget: { tab: 'experiment', targetId: study.id },
    });
    addEdge({
      id: `e:scope:studies->${studyNodeId}:contains`,
      source: 'scope:studies',
      target: studyNodeId,
      relation: 'contains',
      provenance: 'observed',
      evidence: `课题归属于当前工作台研究空间`,
    });
  }

  for (const branch of branches) {
    const branchNodeId = `branch:${branch.id}`;
    const parentId = nodeIds.has(`study:${branch.studyId}`) ? `study:${branch.studyId}` : 'scope:studies';
    addNode({
      id: branchNodeId,
      label: `${branch.shortCode} · ${branch.name}${branch.status === 'adopted' ? ' [已采纳]' : ''}`,
      kind: 'branch',
      parentId,
      provenance: branch.provenanceTier === 'workbench_native' ? 'observed' : 'scanned',
      provenanceTier: branch.provenanceTier,
      evidence: `分支 ${branch.id} (${branch.status} · ${branch.provenanceTier})`,
      status: branch.status === 'rejected' || branch.status === 'archived_blocked' ? 'warning' : 'healthy',
      summary: branch.hypothesis || branch.summary,
      linkTarget: { tab: 'compare', targetId: branch.id },
    });
    addEdge({
      id: `e:${parentId}->${branchNodeId}:contains`,
      source: parentId,
      target: branchNodeId,
      relation: 'contains',
      provenance: 'observed',
      evidence: `课题 ${branch.studyId} 包含探索分支 ${branch.shortCode}`,
    });
    if (branch.parentBranchId) {
      addEdge({
        id: `e:${branchNodeId}->branch:${branch.parentBranchId}:derives_from`,
        source: branchNodeId,
        target: `branch:${branch.parentBranchId}`,
        relation: 'derives_from',
        provenance: 'observed',
        evidence: `派生自父分支 ${branch.parentBranchId}`,
      });
    }
  }

  for (const exec of executions) {
    const execNodeId = `exec:${exec.id}`;
    const parentId = nodeIds.has(`branch:${exec.branchId}`) ? `branch:${exec.branchId}` : 'scope:studies';
    addNode({
      id: execNodeId,
      label: `${exec.title} (${exec.runnerMode})`,
      kind: 'workflow_execution',
      parentId,
      provenance: 'observed',
      provenanceTier: exec.provenanceTier,
      evidence: `执行记录 ${exec.id} (SHA-256=${exec.sha256Digest.slice(0, 12)}..., ${exec.durationMs}ms)`,
      status: exec.status === 'completed' ? 'healthy' : 'error',
      summary: exec.intent,
      codeHash: exec.sha256Digest,
      linkTarget: { tab: 'experiment', targetId: exec.studyId },
    });
    addEdge({
      id: `e:${parentId}->${execNodeId}:contains`,
      source: parentId,
      target: execNodeId,
      relation: 'contains',
      provenance: 'observed',
      evidence: `分支执行记录`,
    });
    if (
      (exec.runnerMode === 'p2_wf_rc_perturb_eval' || exec.runnerMode === 'p2_fits_star_extract') &&
      nodeIds.has('runtime:python-scientific-env')
    ) {
      addEdge({
        id: `e:${execNodeId}->runtime:python-scientific-env:uses`,
        source: execNodeId,
        target: 'runtime:python-scientific-env',
        relation: 'uses',
        provenance: 'observed',
        evidence: `通过 ${exec.pythonExecutable ?? 'python'} 执行科学计算`,
      });
    }
  }

  for (const art of artifacts) {
    const artNodeId = `art:${art.id}`;
    const parentId = nodeIds.has(`branch:${art.branchId}`) ? `branch:${art.branchId}` : 'scope:studies';
    addNode({
      id: artNodeId,
      label: `${art.title} (${art.kind})`,
      kind: 'subpart',
      parentId,
      provenance: 'scanned',
      provenanceTier: art.provenanceTier,
      evidence: `${art.relativePath} · SHA-256=${art.sha256.slice(0, 12)}...`,
      status: 'healthy',
      summary: `类型化科研产物：${art.relativePath}`,
      codeHash: art.sha256,
      sourceFilePath: art.relativePath,
      linkTarget: { tab: 'compare', targetId: art.id },
    });
    addEdge({
      id: `e:${parentId}->${artNodeId}:produces`,
      source: parentId,
      target: artNodeId,
      relation: 'produces',
      provenance: 'observed',
      evidence: `分支生成/关联产物 ${art.relativePath}`,
    });
    if (art.executionId && nodeIds.has(`exec:${art.executionId}`)) {
      addEdge({
        id: `e:exec:${art.executionId}->${artNodeId}:produces`,
        source: `exec:${art.executionId}`,
        target: artNodeId,
        relation: 'produces',
        provenance: 'observed',
        evidence: `执行记录直接产出 ${art.relativePath}`,
      });
    }
  }

  // Merge manual architecture annotations into node summaries (clearly marked as manual notes, never silent mutation)
  for (const ann of annotations) {
    const target = nodes.find((n) => n.id === ann.nodeId);
    if (target) {
      target.summary = `${target.summary}\n[人工注解·${ann.author}] ${ann.note}`;
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
        '实时递归扫描 src/、server/、python/、experiments/p2_flagship/scripts/ 真实文件与相对 import 依赖',
        '实时扫描 workspace/components/* 目录、dossier.json 与磁盘源码 SHA-256 哈希',
        '读取 workspace/runs.jsonl 与 workspace/workbench/ 还原 P1 光学账本与 P2 WF-RC-1000 多分支/产物/执行边',
        '实时探测宿主机 Node/Python/Optiland/Astropy/SEP/Photutils 可执行路径与版本',
        '通过受控单步自引用 (isSelfReference=true) 将架构地图引擎自身纳入结构图谱且防止无限递归',
      ],
      declaredOrInferred: [
        'arch-map-engine 内部的 6 个子模块分工边为显式架构声明 (declared)',
        '子进程调用边（server -> python runner）为声明边 (declared)，实际运行后生成 observed 边',
        '结构人工注解 (manual annotation) 仅附注于节点视图，不自动改写磁盘代码',
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

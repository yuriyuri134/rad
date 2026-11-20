import { GoogleGenAI, Type } from '@google/genai';
import type {
  ArchAnomaly,
  ComponentDossier,
  EpistemicNote,
  ExperimentRun,
  FitsCatalogEntry,
  ProposedExperimentAction,
  ResearchStudy,
  StudyBranch,
  ThreadEntry,
  WorkflowExecution,
} from '../src/core/types.ts';

export interface AiCritiqueResponse {
  observation: string;
  unverifiedAssumptions: string[];
  counterexample: string;
  suggestedExperiment: string;
}

export interface StudyCollaborationResponse {
  tag: 'fact' | 'judgment' | 'hypothesis' | 'proposal';
  title: string;
  content: string;
  evidenceRefs: string[];
  unverifiedAssumptions: string[];
  proposedAction: ProposedExperimentAction | null;
  analyzerKind: 'ai_llm' | 'ai_deterministic';
}

export async function requestAiCritique(params: {
  question: string;
  runs: ExperimentRun[];
  components: ComponentDossier[];
  recentThread: ThreadEntry[];
  anomalies?: ArchAnomaly[];
}): Promise<AiCritiqueResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('服务端未配置有效的 GEMINI_API_KEY，当前请使用离线确定性实验功能。');
  }

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });

  const compactRuns = params.runs.slice(-4).map((r) => ({
    id: r.id,
    seq: r.sequenceNumber,
    branch: r.branchLabel,
    intent: r.intent,
    mode: r.mode,
    seed: r.seed,
    hostMode: r.runtimeEnv?.hostMode,
    parts: r.composition?.parts?.map((p) => `${p.slot}:${p.componentId}@${p.version}`) ?? [],
    after: {
      solverEngine: r.rawArtifactsAfter?.solverEngine,
      eflMm: r.rawArtifactsAfter?.paraxialEflMm,
      fNumber: r.rawArtifactsAfter?.fNumber,
      rmsSpotUm: r.rawArtifactsAfter?.rmsSpotRadiusUm,
      axialChromaticShiftMm: r.rawArtifactsAfter?.axialChromaticShiftMm,
      mtf30: r.rawArtifactsAfter?.mtf30LpMm,
      clipped: r.rawArtifactsAfter?.clippedRayCount,
    },
    evaluations: r.evaluations.map((e) => ({
      evaluator: `${e.evaluatorId}@${e.evaluatorVersion}`,
      status: e.status,
      lossScore: e.lossScore,
      summary: e.summary,
    })),
  }));

  const compactComponents = params.components.map((c) => ({
    id: c.id,
    name: c.name,
    kind: c.kind,
    runtime: c.runtime,
    activeVersion: c.activeVersion,
    limits: c.limits,
    selfCheckStatus: c.selfCheck.status,
    scientificValidationStatus: c.scientificValidation.status,
    securityStatus: c.codeSecurityReview.status,
  }));

  const compactThread = params.recentThread.slice(-6).map((t) => ({
    origin: t.origin,
    title: t.title,
    content: t.content,
  }));

  const prompt = [
    '你是嵌入在开放科学探索工作台中的独立批判性协作者。',
    '请基于真实的物理计算指标、运行环境与组件限制档案回答，不要编造未运行的数据，不要把你的猜测包装成已经证实的结论。',
    `用户当前问题或请求：${params.question}`,
    `最近实验运行真实证据：${JSON.stringify(compactRuns)}`,
    `可用组件、三层信任状态与已知限制：${JSON.stringify(compactComponents)}`,
    `架构一致性检查异常：${JSON.stringify(params.anomalies ?? [])}`,
    `研究脉络记录：${JSON.stringify(compactThread)}`,
    '请给出简练、可检验的中文分析：1) 真实指标说明了什么（注意区分 TS 预览求解器与 Optiland）；2) 当前实验、组合方式或评价标准隐含了哪些未验证假设；3) 一个具体的物理反例或冲突；4) 下一步建议修改哪一个组件（或哪一个参数）来验证。',
  ].join('\n\n');

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      systemInstruction:
        '你是一个严谨、克制的光学与科学实验协作者。严格区分真实计算证据与模型推测，始终指出组件限制、求解器适用边界或评价盲区。用中文输出 JSON。',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          observation: { type: Type.STRING, description: '基于现有实验数据观察到的真实物理现象与差异' },
          unverifiedAssumptions: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: '当前评价器、透镜结构或优化策略尚未验证的前提假设',
          },
          counterexample: { type: Type.STRING, description: '一个能推翻当前结论或暴露边界的物理反例' },
          suggestedExperiment: { type: Type.STRING, description: '具体可操作的下一步实验或组件修改建议' },
        },
      },
    },
  });

  const text = (response.text ?? '{}').trim();
  const parsed = JSON.parse(text) as Partial<AiCritiqueResponse>;
  return {
    observation: parsed.observation ?? '未返回观察摘要',
    unverifiedAssumptions: Array.isArray(parsed.unverifiedAssumptions) ? parsed.unverifiedAssumptions : [],
    counterexample: parsed.counterexample ?? '',
    suggestedExperiment: parsed.suggestedExperiment ?? '',
  };
}

export function buildDeterministicCollaboration(params: {
  study: ResearchStudy;
  branches: StudyBranch[];
  executions: WorkflowExecution[];
  notes: EpistemicNote[];
  fitsCatalog: FitsCatalogEntry[];
  question: string;
}): StudyCollaborationResponse {
  const q = params.question.toLowerCase();
  const s3 = params.branches.find((b) => b.shortCode === 'S3') ?? params.branches[0];
  const s0 = params.branches.find((b) => b.shortCode === 'S0');
  const s4 = params.branches.find((b) => b.shortCode === 'S4');
  const adopted = params.branches.find((b) => b.id === params.study.adoptedBranchId) ?? s3;

  if (params.study.id === 'study-wf-rc-1000') {
    const isBatchFitsQuestion =
      (q.includes('批量') || q.includes('全视场') || q.includes('横评') || q.includes('多帧')) &&
      (q.includes('fits') || q.includes('dao') || q.includes('sep') || q.includes('完备度') || q.includes('欠采样'));

    const isFitsQuestion =
      q.includes('fits') ||
      q.includes('星表') ||
      q.includes('完备度') ||
      q.includes('dao') ||
      q.includes('fwhm') ||
      q.includes('sep') ||
      q.includes('欠采样');

    const isS4Question =
      q.includes('s4') || q.includes('f2') || q.includes('caf2') || q.includes('4片') || q.includes('种子') || q.includes('多种子');

    if (isBatchFitsQuestion) {
      return {
        tag: 'proposal',
        title: '关于 S1–S4 全视场 16 帧 FITS 批量验证 DAO(fwhm=1.5px) vs SEP 对齐度的提议',
        content: [
          '【事实】单帧 S3 0.60° 验证后仍需检验在 S1–S4 不同像斑尺度 (1.06–9.70 μm) 下，下调 DAOStarFinder fwhmPx=1.5 px 是否在全视场均能对齐 SEP，且不引入噪声假阳性。',
          '【判断】仅看单一 0.60° 帧无法排除较小 fwhmPx 在模糊星斑 (S1/S4) 处分裂出多峰假阳性，必须对全部真实 FITS 瓦片执行跨系统批量横评。',
          '【假设】在 S1–S4 共 16 帧瓦片上采用 fwhmPx=1.5 px, threshold=4.5σ，采用同一组真值可测量下调核宽是否改善完备率。旧模式仅能观察与 SEP 的代理匹配，应保留 DAO 独有检出待核验。',
          '【提议】立即在工作台运行全视场 16 帧批量 Astropy/Photutils/SEP 交叉匹配实验。',
        ].join('\n'),
        evidenceRefs: ['experiments/p2_flagship/runs/stage3_fits_astrometry.json'],
        unverifiedAssumptions: ['需同时检查 daoUnmatchedExcess 确认锐化卷积核未放大天光背景假阳性。'],
        proposedAction: {
          label: '实测：S1–S4 16 帧 FITS 批量 DAO(1.5px) vs SEP 交叉横评',
          studyId: params.study.id,
          parentBranchId: s3?.id ?? 'branch-p2-s3',
          runnerMode: 'fits_batch_completeness',
          branchName: 'S1-S4 16帧 FITS 批量完备度横评 (FWHM=1.5px)',
          hypothesis: '在 S1–S4 全视场瓦片中下调 DAOStarFinder FWHM=1.5px 可系统性对齐 SEP 检测率并控制假阳性余项。',
          intent: '在全部 16 帧 S1–S4 FITS 科学帧上批量执行 Photutils 与 SEP 交叉匹配核验',
          parameters: {
            systemKeys: ['S1_2Lens_FS_RC', 'S2_3Lens_Wynne_FS_RC', 'S3_3Lens_Wynne_FS_QuasiRC', 'S4_3Lens_Wynne_FS_F2_RC'],
            fwhmPx: 1.5,
            thresholdSigma: 4.5,
            sepThresholdSigma: 4.5,
            sepMinArea: 4,
            matchRadiusPx: 3.5,
          },
        },
        analyzerKind: 'ai_deterministic',
      };
    }

    if (isFitsQuestion) {
      return {
        tag: 'proposal',
        title: '关于 S3 欠采样星点导致 DAOStarFinder 漏检的假设与实测提议',
        content: [
          '【事实】Stage 3 记录显示，S3_3Lens_Wynne_FS_QuasiRC 在 0.60° 边缘视场的光斑仅 ~1.06 μm（Pixel=15 μm，系统大幅欠采样），Photutils DAOStarFinder 默认 fwhm=3.0 px 仅检出 12/28 颗星（完备度 42.9%），而 SEP 检出 27/28（96.4%）。',
          '【判断】漏检并非光学系统退化，而是平滑高斯核 FWHM 参数与实际锐利 PSF（~1.2–1.5 px）严重失配，导致低 SNR 暗星在卷积匹配后低于阈值。',
          '【假设】将 DAOStarFinder 的 fwhmPx 下调至 1.5 px 并调整阈值至 4.5σ，可在保持低误报的同时把边缘视场完备度提升至 80%+（与 SEP 对齐）。',
          '【提议】建议立即在真实 512×512 瓦片 S3_3Lens_Wynne_FS_QuasiRC_tile_0.60deg.fits 上执行参数化重提取对比实验。',
        ].join('\n'),
        evidenceRefs: [
          'experiments/p2_flagship/runs/stage3_fits_astrometry.json',
          'experiments/p2_flagship/runs/fits/S3_3Lens_Wynne_FS_QuasiRC_tile_0.60deg.fits',
        ],
        unverifiedAssumptions: [
          '降宽 fwhmPx 至 1.5 px 后在高天光噪声涨落处是否会引入宇宙线/单像素噪声假阳性尚未在此帧重测。',
        ],
        proposedAction: {
          label: '实测：S3 0.60° FITS 降低 DAOStarFinder FWHM=1.5px 重提取',
          studyId: params.study.id,
          parentBranchId: s3?.id ?? 'branch-p2-s3',
          runnerMode: 'fits_star_extract',
          branchName: 'S3-DAO-FWHM1.5 欠采样星表验证',
          hypothesis: '将 DAOStarFinder fwhmPx 由 3.0 降为 1.5 px 可显著恢复 S3 锐利欠采样帧的暗星检出数。',
          intent: '基于真实 FITS 瓦片检验 DAOStarFinder 卷积核匹配参数对欠采样宽视场星表完备度的影响',
          parameters: {
            fitsPath: 'experiments/p2_flagship/runs/fits/S3_3Lens_Wynne_FS_QuasiRC_tile_0.60deg.fits',
            extractor: 'photutils_DAOStarFinder',
            fwhmPx: 1.5,
            thresholdSigma: 4.5,
            apertureRadiusPx: 4.0,
          },
        },
        analyzerKind: 'ai_deterministic',
      };
    }

    if (isS4Question) {
      return {
        tag: 'proposal',
        title: 'S4 (FS + Schott F2) 未收敛成因诊断与有限预算重优化实测提议',
        content: [
          `【事实】Stage 2 的 S4 (Fused Silica + Schott F2 + Fused Silica) 在锁定 RC 圆锥系数 (K1=-1.128, K2=-6.220) 且仅从 S2 全熔石英曲率单起点出发时，经 447 次函数评估后陷入 cost=597.635（max RMS=9.704 μm, 550nm Strehl=0.076–0.346），而同期 S3 (Quasi-RC 解锁 K1/K2) 达到 1.063 μm。`,
          '【判断】S4 失败不应直接归因于 F2 玻璃本身物理不可行：Stage 2 将高折射率 F2 (nd≈1.620) 直接套用熔石英 (nd≈1.459) 初始曲率并锁定了主次镜圆锥系数，极可能困在局部陡峭极小值。',
          '【假设】在受控有限评估预算 (maxNfev=40) 下，通过解锁 Quasi-RC (K1/K2) 与多起点搜索对比，可直接验证 S4 的最大 RMS 是否能突破 7.5 μm 指标，及其能否追平 S3。',
          '【提议】立即在工作台启动真实 Optiland 0.6.3 诊断重优化子进程，实测多种子与圆锥系数解锁对 S4 局部极小的突破幅度。',
        ].join('\n'),
        evidenceRefs: [
          'experiments/p2_flagship/runs/branch_S4.json',
          'experiments/p2_flagship/runs/S1_to_S4_correctors_v2.json',
        ],
        unverifiedAssumptions: [
          '即使多起点与圆锥系数解锁降低 RMS，F2 玻璃在 0.45–0.80 μm 的高二级色散与热膨胀是否仍弱于全熔石英 S3 需看最终 Strehl 与 MTF 实算输出。',
        ],
        proposedAction: {
          label: '实测：S4 (FS+F2+FS) 解锁 K1/K2 多起点诊断重优化',
          studyId: params.study.id,
          parentBranchId: s4?.id ?? 'branch-p2-s4',
          runnerMode: 'wf_rc_s4_reopt_probe',
          branchName: 'S4-多起点与圆锥解锁诊断优化分支',
          hypothesis: '解锁 Quasi-RC 圆锥系数并更换初始起点可使 S4 逃离 Stage 2 cost=597.635 局部极小并检验其真实色差物理极限。',
          intent: '在 Optiland 0.6.3 中用受控评估预算运行 S4 多起点与圆锥解锁重优化，与原 S4 (9.704 μm) 及 S3 (1.063 μm) 直接对照',
          parameters: {
            strategy: 'unlock_conics_multi_seed',
            maxNfev: 25,
            numRaysOpt: 4,
            evalNumRays: 12,
          },
        },
        analyzerKind: 'ai_deterministic',
      };
    }

    // Default tolerance/system question for WF-RC-1000
    return {
      tag: 'proposal',
      title: 'WF-RC-1000 当前状态研判与 M2 倾斜+曲率耦合敏感度测试提议',
      content: [
        `【事实】当前采纳基线 [${adopted?.shortCode ?? 'S3'}] 已通过 Optiland 0.6.3 真实光线追迹验证：全视场 0°–0.60° 最大多色 RMS=${s3?.metrics.maxRmsPolyUm ?? 1.063} μm（远优于 7.5 μm 指标与裸 RC S0 的 ${s0?.metrics.maxRmsPolyUm ?? 73.175} μm），550nm 衍射 Strehl=0.854–0.982。Stage 4 暴露单一 BFL 调焦在 M1 R1+1.5mm 下会使边缘 Strehl 降至 0.6160，而加入 M2 垫片 (-0.6591mm) 可将其拉回 0.9855。`,
        `【判断】标称光学设计已经满足成像与 Nyquist MTF@33.3 (>=0.77) 指标，系统真正瓶颈在于装配阶段轴向/倾斜公差的耦合余量，以及 S4 多种子收敛与欠采样星表匹配策略（共 ${params.study.openQuestions.filter((o) => o.status !== 'resolved').length} 项开放问题）。`,
        '【假设】如果在 M1 R1 制造误差的基础上叠加 15" 次镜倾斜与 0.04mm 偏心，轴对称垫片补偿无法消除全部离轴彗差，0.60° 边缘 Strehl 将逼近 0.80 红线。',
        '【提议】在 Optiland 中运行一次带有真实非对称倾斜/偏心的 S3 衍生分支，观测 best_fit FFTPSF Strehl 是否守住 >= 0.80 门槛。',
      ].join('\n'),
      evidenceRefs: [
        'experiments/p2_flagship/runs/branch_S3.json',
        'experiments/p2_flagship/runs/stage4_tolerancing.json',
        'experiments/p2_flagship/runs/stage5_independent_verification.json',
      ],
      unverifiedAssumptions: [
        '当前未包含温度梯度（-10°C 到 +25°C）对镜筒间距的热胀冷缩耦合项',
        `S4 分支（cost=${s4?.metrics.optCost ?? 597.635}）仅完成单一随机种子`,
      ],
      proposedAction: {
        label: '实测：S3 在 M1 R1+1.2mm + M2 15"倾斜下的垫片补偿边界',
        studyId: params.study.id,
        parentBranchId: s3?.id ?? 'branch-p2-s3',
        runnerMode: 'wf_rc_perturb_eval',
        branchName: 'S3-倾斜耦合公差实测分支',
        hypothesis: '15" M2 倾斜叠加 M1 R1(+1.2mm) 时，M2 垫片+BFL 可校正轴向球差与离焦，但偏轴慧差导致边缘 Strehl 小幅低于 0.90。',
        intent: '用真实 Optiland 光线追迹与 best_fit FFTPSF 测试非对称倾斜公差耦合效应',
        parameters: {
          baseBranchKey: 'S3',
          compensator: 'm2_shim_plus_bfl',
          delta_r1_mm: 1.2,
          delta_r2_mm: 0.5,
          delta_d_m1_m2_mm: 0.02,
          m2_tilt_arcsec: 15,
          m2_decenter_mm: 0.04,
        },
      },
      analyzerKind: 'ai_deterministic',
    };
  }

  // Generic deterministic summary for P1 or newly created studies
  const branchSummaries = params.branches
    .slice(0, 5)
    .map((b) => `${b.shortCode}(${b.status}): ${b.summary}`)
    .join('\n- ');
  return {
    tag: 'judgment',
    title: `课题「${params.study.title}」基于现有分支的确定性研究研判`,
    content: [
      `【事实】当前课题共有 ${params.branches.length} 个探索分支、${params.executions.length} 次记录执行与 ${params.study.openQuestions.length} 个开放问题。`,
      params.branches.length > 0 ? `主要分支摘要：\n- ${branchSummaries}` : '当前尚未记录探索分支。',
      `【判断】建议针对问题「${params.question}」构建明确的对照变量并绑定可复现的物理/数据评价器。`,
    ].join('\n'),
    evidenceRefs: params.executions.slice(-3).map((e) => e.id),
    unverifiedAssumptions: ['当前使用离线确定性证据引擎分析（未配置外网 GEMINI_API_KEY）。'],
    proposedAction: null,
    analyzerKind: 'ai_deterministic',
  };
}

export async function requestStudyCollaboration(params: {
  study: ResearchStudy;
  branches: StudyBranch[];
  executions: WorkflowExecution[];
  notes: EpistemicNote[];
  fitsCatalog: FitsCatalogEntry[];
  question: string;
}): Promise<StudyCollaborationResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return buildDeterministicCollaboration(params);
  }

  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' },
      },
    });

    const compactBranches = params.branches.map((b) => ({
      id: b.id,
      shortCode: b.shortCode,
      name: b.name,
      status: b.status,
      provenanceTier: b.provenanceTier,
      metrics: b.metrics,
    }));

    const prompt = [
      '你是 OpenLab Bench 中的科研工程协作者。请严格基于真实数据区分【事实】【判断】【假设】【提议】，绝不编造参数或未执行的结果。',
      `课题：${params.study.title} (${params.study.id})`,
      `问题陈述：${params.study.problemStatement}`,
      `验收标准：${JSON.stringify(params.study.criteria)}`,
      `开放问题：${JSON.stringify(params.study.openQuestions)}`,
      `已有分支：${JSON.stringify(compactBranches)}`,
      `最近记录执行：${JSON.stringify(params.executions.slice(-5).map((e) => ({ id: e.id, mode: e.runnerMode, params: e.parameters })))}`,
      `用户当前问题：${params.question}`,
    ].join('\n\n');

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        systemInstruction:
          '用中文输出 JSON，严格区分事实/判断/假设/提议，给出清晰可核查的证据引用。如果当前是 WF-RC-1000，可提出具体公差微扰或 FITS 重提取参数。',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            tag: { type: Type.STRING, description: 'fact | judgment | hypothesis | proposal' },
            title: { type: Type.STRING },
            content: { type: Type.STRING },
            evidenceRefs: { type: Type.ARRAY, items: { type: Type.STRING } },
            unverifiedAssumptions: { type: Type.ARRAY, items: { type: Type.STRING } },
          },
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim()) as Partial<StudyCollaborationResponse>;
    const det = buildDeterministicCollaboration(params);
    const validTag =
      parsed.tag === 'fact' || parsed.tag === 'judgment' || parsed.tag === 'hypothesis' || parsed.tag === 'proposal'
        ? parsed.tag
        : 'judgment';

    return {
      tag: validTag,
      title: parsed.title || det.title,
      content: parsed.content || det.content,
      evidenceRefs: Array.isArray(parsed.evidenceRefs) ? parsed.evidenceRefs : det.evidenceRefs,
      unverifiedAssumptions: Array.isArray(parsed.unverifiedAssumptions)
        ? parsed.unverifiedAssumptions
        : det.unverifiedAssumptions,
      proposedAction: det.proposedAction,
      analyzerKind: 'ai_llm',
    };
  } catch {
    return buildDeterministicCollaboration(params);
  }
}

import { GoogleGenAI, Type } from '@google/genai';
import type { ArchAnomaly, ComponentDossier, ExperimentRun, ThreadEntry } from '../src/core/types.ts';

export interface AiCritiqueResponse {
  observation: string;
  unverifiedAssumptions: string[];
  counterexample: string;
  suggestedExperiment: string;
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

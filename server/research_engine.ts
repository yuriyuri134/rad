import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type {
  ArtifactContract, ArtifactRecord, ExecutionRecord, ExecutionRequest,
  RecipeRunRecord, WorkflowRecipe,
} from '../src/core/researchTypes.ts';
import { resolveAndAssertApproved, type ApprovedComponentExecutionContext } from './runner.ts';
import { pythonEnvironment, runLocalProcess, stageVerifiedPython, stageVerifiedSources } from './process.ts';
import { checkId, controlledFile, isRecord, ResearchStore, sameKeys, validateContract, validateSchema } from './research_store.ts';
import { canonicalJson } from './storage.ts';
import { resolvePythonBinary } from './python_env.ts';

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function environment(ctx: ApprovedComponentExecutionContext, contract: ArtifactContract): ExecutionRecord['environment'] {
  if (ctx.dossier.runtime === 'local_process_mjs') {
    return { runtime: 'node', executable: process.execPath, version: process.version, packages: {}, platform: process.platform };
  }
  const { executable } = resolvePythonBinary();
  const details = JSON.parse(execFileSync(executable, [
    '-I', '-c',
    'import importlib.metadata as m, json, platform; print(json.dumps(dict(version=platform.python_version(), packages={d.metadata["Name"].lower().replace("_","-"): d.version for d in m.distributions()}, platform=platform.platform())))',
  ], { env: pythonEnvironment(), timeout: 5000, encoding: 'utf8' })) as Omit<ExecutionRecord['environment'], 'runtime' | 'executable'>;
  for (const [name, required] of Object.entries(contract.pythonPackages ?? {})) {
    const installed = details.packages[name.toLowerCase().replaceAll('_', '-')];
    if (installed !== required) throw new Error(name + ' 需要版本 ' + required + '，当前为 ' + (installed ?? '未安装'));
  }
  return { runtime: 'python', executable, ...details };
}

function compatible(output: Pick<ArtifactRecord, 'schemaId' | 'mediaType'>, input: typeof output): boolean {
  return output.schemaId === input.schemaId && output.mediaType === input.mediaType;
}

export class ResearchEngine {
  readonly store: ResearchStore;
  private active = new Map<string, AbortController>();

  constructor(private workspaceDir?: string) {
    this.store = new ResearchStore(workspaceDir);
  }

  private prepare(request: ExecutionRequest) {
    checkId(request.studyId, '课题');
    if (request.branchId !== undefined) checkId(request.branchId, '分支');
    checkId(request.componentId, '组件');
    if (typeof request.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(request.version)) {
      throw new Error('必须指定有效的组件版本');
    }
    if (!isRecord(request.inputs) || !isRecord(request.parameters)) throw new Error('缺少端口或参数映射');
    const ctx = resolveAndAssertApproved(request.componentId, request.version, this.workspaceDir);
    const contract = ctx.ver.artifactContract;
    validateContract(contract);
    if (!['local_process_py', 'local_process_mjs'].includes(ctx.dossier.runtime)) throw new Error('组件运行时不支持文件协议');
    if (Object.keys(ctx.verifiedHostModules).length) throw new Error('文件组件需要将本地依赖声明在版本目录内');
    if (!sameKeys(request.inputs, contract.inputs)) throw new Error('输入端口与组件契约不符');
    validateSchema(contract.parameters, request.parameters, '执行参数');
    return { ctx, contract };
  }

  startExecution(request: ExecutionRequest, options: { rerunOf?: string; recipeRunId?: string; recipeStepId?: string } = {}) {
    const { ctx, contract } = this.prepare(request);
    const catalog = new Map(this.store.listArtifacts().map((artifact) => [artifact.id, artifact]));
    const inputs = Object.fromEntries(Object.entries(contract.inputs).map(([port, want]) => {
      const artifact = catalog.get(request.inputs[port]);
      if (!artifact) throw new Error('缺少输入产物 ' + port);
      if (!compatible(artifact, want)) throw new Error('输入产物类型或 Schema 不匹配: ' + port);
      return [port, artifact];
    }));
    const entry = path.basename(ctx.ver.codeFile);
    const sources = { ...ctx.verifiedRelativeDeps, [entry]: { code: ctx.verifiedCode, codeHash: ctx.verifiedHash } };
    const record: ExecutionRecord = {
      id: 'execution-' + randomUUID(),
      request,
      status: 'running',
      startedAt: new Date().toISOString(),
      ...options,
      inputs,
      outputs: {},
      component: {
        componentId: request.componentId, version: request.version,
        contract, codeHash: ctx.verifiedHash,
        sources: Object.fromEntries(Object.entries(sources).map(([name, value]) => [name, value.codeHash])),
      },
      environment: environment(ctx, contract),
    };
    if (options.rerunOf) {
      const original = this.store.getExecution(options.rerunOf);
      if (!original || canonicalJson(original.component) !== canonicalJson(record.component)) {
        throw new Error('原执行的组件版本或契约已经改变。请显式选择已审批版本发起新执行。');
      }
    }
    const controller = new AbortController();
    this.store.saveExecution(record);
    this.active.set(record.id, controller);
    const done = this.execute(record, entry, sources, controller.signal)
      .finally(() => this.active.delete(record.id));
    return { record, done };
  }

  private async execute(
    record: ExecutionRecord, entry: string,
    sources: Parameters<typeof stageVerifiedPython>[1], signal: AbortSignal,
  ): Promise<ExecutionRecord> {
    let outcome: ExecutionRecord;
    let directory: string | undefined;
    let cleanup: (() => void) | undefined;
    const log = this.store.logPath(record.id);
    try {
      directory = this.store.stage();
      const inputDir = path.join(directory, 'inputs');
      const outputDir = path.join(directory, 'outputs');
      fs.mkdirSync(inputDir);
      fs.mkdirSync(outputDir);
      const inputs: Record<string, { id: string; path: string; sha256: string; schemaId: string; mediaType: string }> = {};
      for (const [port, artifact] of Object.entries(record.inputs)) {
        const destination = path.join(inputDir, port);
        await this.store.copyInput(artifact, record.component.contract.inputs[port], destination);
        inputs[port] = { id: artifact.id, path: destination, sha256: artifact.sha256, schemaId: artifact.schemaId, mediaType: artifact.mediaType };
      }
      const isPython = record.environment.runtime === 'python';
      const stage = isPython ? stageVerifiedPython(entry, sources) : stageVerifiedSources(entry, sources);
      cleanup = stage.dispose;
      for (const [relative, hash] of Object.entries(record.component.sources)) {
        const saved = await this.store.archiveFile(controlledFile(stage.directory, relative));
        if (saved.sha256 !== hash) throw new Error('执行源码归档哈希不匹配');
      }
      const manifestPath = path.join(outputDir, 'result.json');
      const payload = JSON.stringify({ protocol: 'openlab-files/v1', inputs, outputDir, manifestPath, parameters: record.request.parameters });
      const result = await runLocalProcess(
        record.environment.executable, 'args' in stage ? stage.args as string[] : [stage.entry],
        payload, record.component.contract.timeoutMs ?? 60000, isPython ? pythonEnvironment() : process.env,
        { cwd: directory, signal, log: (chunk) => fs.appendFileSync(log, chunk), maxBuffer: 1024 * 1024 },
      );
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || '组件退出状态 ' + result.exitCode);
      const manifestFile = controlledFile(outputDir, path.basename(manifestPath));
      if (fs.statSync(manifestFile).size > 65536) throw new Error('输出清单超出 64 KiB');
      const manifest: unknown = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const ports = record.component.contract.outputs;
      if (!isRecord(manifest) || !isRecord(manifest.outputs) || !sameKeys(manifest.outputs, ports)) {
        throw new Error('输出清单与命名端口不符');
      }
      const outputs: Record<string, ArtifactRecord> = {};
      const seenFiles = new Set([fs.realpathSync(manifestFile)]);
      for (const [port, output] of Object.entries(manifest.outputs)) {
        if (typeof output !== 'string') throw new Error('输出清单需要独立文件路径');
        const file = controlledFile(outputDir, output);
        const actual = fs.realpathSync(file);
        if (seenFiles.has(actual)) throw new Error('输出端口必须引用各自的文件');
        seenFiles.add(actual);
        outputs[port] = await this.store.publishOutput(file, ports[port], record, port);
      }
      if (signal.aborted) throw new Error('执行已取消');
      outcome = { ...record, status: 'completed', outputs, finishedAt: new Date().toISOString() };
    } catch (error) {
      outcome = {
        ...record, status: signal.aborted ? 'cancelled' : 'failed',
        error: errorMessage(error), finishedAt: new Date().toISOString(),
      };
      fs.appendFileSync(log, '\n' + outcome.error + '\n');
    } finally {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
      cleanup?.();
    }
    this.store.saveExecution(outcome);
    return outcome;
  }

  cancel(id: string): boolean {
    const active = this.active.get(id);
    active?.abort();
    return Boolean(active);
  }

  rerunExecution(id: string, overrides: Partial<Pick<ExecutionRequest, 'inputs' | 'parameters'>> = {}) {
    const original = this.store.getExecution(id);
    if (!original || original.status === 'running') throw new Error('原执行尚不可复跑');
    return this.startExecution({ ...original.request, ...overrides }, { rerunOf: id });
  }

  startRecipe(recipe: WorkflowRecipe, options: { continuedFrom?: string; rerunStep?: string } = {}) {
    if (!Array.isArray(recipe.steps) || !recipe.steps.length || recipe.steps.length > 256 ||
        typeof recipe.name !== 'string' || !recipe.name.trim()) throw new Error('工作流需要名称和 1–256 项有序步骤');
    const artifacts = new Map(this.store.listArtifacts().map((artifact) => [artifact.id, artifact]));
    const contracts = new Map<string, ArtifactContract>();
    for (const step of recipe.steps) {
      checkId(step.id, '步骤');
      if (contracts.has(step.id) || !isRecord(step.inputs)) throw new Error('步骤 ID 重复或缺少输入');
      const { contract } = this.prepare({
        studyId: recipe.studyId, branchId: recipe.branchId, componentId: step.componentId, version: step.version,
        inputs: Object.fromEntries(Object.keys(step.inputs).map((port) => [port, 'preflight'])),
        parameters: step.parameters,
      });
      for (const [port, edge] of Object.entries(step.inputs)) {
        if (!isRecord(edge)) throw new Error('缺少配方产物引用');
        const source = 'artifactId' in edge
          ? artifacts.get(edge.artifactId)
          : contracts.get(edge.stepId)?.outputs[edge.outputPort];
        if (!source || !compatible(source, contract.inputs[port])) throw new Error('无效的配方连接: ' + step.id + '.' + port);
      }
      contracts.set(step.id, contract);
    }
    const previous = options.continuedFrom ? this.store.getRecipeRun(options.continuedFrom) : undefined;
    if (options.continuedFrom && (!previous || previous.status === 'running' ||
        canonicalJson(previous.recipe) !== canonicalJson(recipe))) throw new Error('续跑需要已结束且配方一致的运行');
    if (options.rerunStep && !contracts.has(options.rerunStep)) throw new Error('找不到要重跑的步骤');
    const initial: RecipeRunRecord = {
      id: 'recipe-' + randomUUID(), recipe, status: 'running', startedAt: new Date().toISOString(),
      continuedFrom: previous?.id, executions: {},
    };
    const controller = new AbortController();
    this.store.saveRecipeRun(initial);
    this.active.set(initial.id, controller);
    const done = this.executeRecipe(initial, controller.signal, previous, options.rerunStep)
      .finally(() => this.active.delete(initial.id));
    return { record: initial, done };
  }

  private async executeRecipe(initial: RecipeRunRecord, signal: AbortSignal, previous?: RecipeRunRecord, rerunStep?: string) {
    const executionIds: Record<string, string> = {};
    const byStep = new Map<string, ExecutionRecord>();
    let error: string | undefined;
    try {
      for (const step of initial.recipe.steps) {
        if (signal.aborted) throw new Error('配方已取消');
        const inputs = Object.fromEntries(Object.entries(step.inputs).map(([key, edge]) => [
          key, 'artifactId' in edge ? edge.artifactId : byStep.get(edge.stepId)?.outputs[edge.outputPort].id,
        ])) as Record<string, string>;
        const priorId = previous?.executions[step.id];
        const prior = priorId ? this.store.getExecution(priorId) : undefined;
        const request = {
          studyId: initial.recipe.studyId, branchId: initial.recipe.branchId,
          componentId: step.componentId, version: step.version, inputs, parameters: step.parameters,
        };
        let result: ExecutionRecord;
        if (prior?.status === 'completed' && step.id !== rerunStep &&
            canonicalJson(prior.request.inputs) === canonicalJson(inputs)) {
          await Promise.all([...Object.values(prior.inputs), ...Object.values(prior.outputs)].map((artifact) => this.store.openArtifact(artifact)));
          result = prior;
        } else {
          const job = this.startExecution(request, { recipeRunId: initial.id, recipeStepId: step.id });
          executionIds[step.id] = job.record.id;
          this.store.saveRecipeRun({ ...initial, executions: executionIds });
          const cancel = () => this.cancel(job.record.id);
          signal.addEventListener('abort', cancel, { once: true });
          try { result = await job.done; } finally { signal.removeEventListener('abort', cancel); }
        }
        if (result.status !== 'completed') throw new Error(step.label + ': ' + (result.error ?? result.status));
        byStep.set(step.id, result);
        executionIds[step.id] = result.id;
        this.store.saveRecipeRun({ ...initial, executions: executionIds });
      }
    } catch (cause) {
      error = errorMessage(cause);
    }
    const outcome: RecipeRunRecord = {
      ...initial, status: signal.aborted ? 'cancelled' : error ? 'failed' : 'completed',
      executions: executionIds, finishedAt: new Date().toISOString(), error,
    };
    this.store.saveRecipeRun(outcome);
    return outcome;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import type { ArtifactContract, ArtifactPort, ArtifactRecord, ExecutionRecord, RecipeRunRecord } from '../src/core/researchTypes.ts';
import { canonicalJson, resolveWorkspaceDir, sha256 } from './storage.ts';

const ajv = new Ajv({ strict: true, allErrors: true });
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function checkId(value: unknown, label = 'ID'): asserts value is string {
  if (typeof value !== 'string' || !identifier.test(value)) throw new Error('无效 ' + label);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function sameKeys(value: Record<string, unknown>, expected: Record<string, unknown>) {
  return Object.keys(value).length === Object.keys(expected).length &&
    Object.keys(expected).every((key) => Object.hasOwn(value, key));
}

export function validateSchema(schema: Record<string, unknown> | undefined, value: unknown, label: string): void {
  if (!schema) return;
  const validate = ajv.compile(schema);
  if (!validate(value)) throw new Error(label + ' 不符合 JSON Schema: ' + ajv.errorsText(validate.errors));
}

export function validateContract(contract: unknown): asserts contract is ArtifactContract {
  if (!isRecord(contract) || contract.protocol !== 'openlab-files/v1' ||
      !isRecord(contract.inputs) || !isRecord(contract.outputs) || !Object.keys(contract.outputs).length) {
    throw new Error('缺少有效的文件执行契约');
  }
  for (const [name, port] of [...Object.entries(contract.inputs), ...Object.entries(contract.outputs)]) {
    checkId(name, '端口');
    if (!isRecord(port) || typeof port.schemaId !== 'string' || !port.schemaId.trim() ||
        typeof port.mediaType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(port.mediaType)) {
      throw new Error('无效产物端口 ' + name);
    }
    if (port.jsonSchema !== undefined) {
      if (port.mediaType !== 'application/json' || !isRecord(port.jsonSchema)) throw new Error('JSON Schema 只适用于 JSON 产物');
      ajv.compile(port.jsonSchema);
    }
  }
  if (contract.parameters !== undefined) {
    if (!isRecord(contract.parameters)) throw new Error('参数契约无效');
    ajv.compile(contract.parameters);
  }
  if (contract.pythonPackages !== undefined && (!isRecord(contract.pythonPackages) ||
      Object.entries(contract.pythonPackages).some(([name, version]) => !/^[a-zA-Z0-9._-]+$/.test(name) || typeof version !== 'string'))) {
    throw new Error('Python 依赖需指定准确版本');
  }
  if (contract.timeoutMs !== undefined && (typeof contract.timeoutMs !== 'number' ||
      !Number.isSafeInteger(contract.timeoutMs) || contract.timeoutMs < 100 || contract.timeoutMs > 600000)) {
    throw new Error('无效的组件超时限制');
  }
}

async function fileDigest(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function controlledFile(directory: string, relative: string): string {
  const within = (location: string) => Boolean(location && !location.startsWith('..') && !path.isAbsolute(location));
  const candidate = path.resolve(directory, relative);
  if (!within(path.relative(directory, candidate))) throw new Error('文件路径越界');
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('预期常规文件');
  if (!within(path.relative(fs.realpathSync(directory), fs.realpathSync(candidate)))) throw new Error('文件路径越界');
  return candidate;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

function publishJson(file: string, value: unknown) {
  const pending = file + '.tmp-' + randomUUID();
  try {
    fs.writeFileSync(pending, JSON.stringify(value, null, 2), { encoding: 'utf8', flag: 'wx', flush: true });
    fs.renameSync(pending, file);
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

async function validateArtifactFile(file: string, port: ArtifactPort) {
  if (port.mediaType === 'application/json') {
    if (fs.statSync(file).size > 32 * 1024 * 1024) throw new Error('JSON 产物超出 32 MiB 校验上限');
    validateSchema(port.jsonSchema, readJson(file), port.schemaId);
  }
  if (port.mediaType === 'application/fits' || port.mediaType === 'image/fits') {
    const header = Buffer.alloc(80);
    const fd = fs.openSync(file, 'r');
    try {
      if (fs.readSync(fd, header, 0, 80, 0) !== 80 ||
          !header.toString('ascii').startsWith('SIMPLE  =') || fs.fstatSync(fd).size % 2880 !== 0) {
        throw new Error('产物没有有效的 FITS 主头或块长度');
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

export class ResearchStore {
  readonly root: string;

  constructor(workspaceDir?: string) {
    this.root = path.join(resolveWorkspaceDir(workspaceDir), 'workbench', 'research');
    for (const folder of ['records', 'recipes', 'imports', 'blobs', 'logs', 'staging']) {
      fs.mkdirSync(path.join(this.root, folder), { recursive: true });
    }
  }

  private records<T>(folder: string): T[] {
    const base = path.join(this.root, folder);
    return fs.readdirSync(base).filter((name) => name.endsWith('.json'))
      .map((name) => readJson<T>(path.join(base, name)));
  }

  listExecutions(): ExecutionRecord[] {
    return this.records<ExecutionRecord>('records').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  listRecipeRuns(): RecipeRunRecord[] {
    return this.records<RecipeRunRecord>('recipes').sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  listArtifacts(executions = this.listExecutions()): ArtifactRecord[] {
    return [
      ...this.records<ArtifactRecord>('imports'),
      ...executions.filter((run) => run.status === 'completed').flatMap((run) => Object.values(run.outputs)),
    ];
  }

  getExecution(id: string): ExecutionRecord | undefined {
    checkId(id);
    const file = path.join(this.root, 'records', id + '.json');
    return fs.existsSync(file) ? readJson<ExecutionRecord>(file) : undefined;
  }

  getRecipeRun(id: string): RecipeRunRecord | undefined {
    checkId(id);
    const file = path.join(this.root, 'recipes', id + '.json');
    return fs.existsSync(file) ? readJson<RecipeRunRecord>(file) : undefined;
  }

  saveExecution(record: ExecutionRecord) {
    const existing = this.getExecution(record.id);
    if (existing && existing.status !== 'running') throw new Error('执行已结束');
    publishJson(path.join(this.root, 'records', record.id + '.json'), record);
  }

  saveRecipeRun(record: RecipeRunRecord) {
    const existing = this.getRecipeRun(record.id);
    if (existing && existing.status !== 'running') throw new Error('配方运行已结束');
    publishJson(path.join(this.root, 'recipes', record.id + '.json'), record);
  }

  logPath(id: string): string {
    checkId(id);
    return path.join(this.root, 'logs', id + '.log');
  }

  stage(): string {
    return fs.mkdtempSync(path.join(this.root, 'staging', 'job-'));
  }

  async openArtifact(artifact: ArtifactRecord) {
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error('产物哈希格式无效');
    const file = controlledFile(path.join(this.root, 'blobs'), artifact.sha256);
    if (fs.statSync(file).size !== artifact.byteLength || await fileDigest(file) !== artifact.sha256) {
      throw new Error('产物 SHA-256 不匹配: ' + artifact.id);
    }
    return file;
  }

  async copyInput(artifact: ArtifactRecord, port: ArtifactPort, destination: string) {
    const source = await this.openArtifact(artifact);
    await fs.promises.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    if (await fileDigest(destination) !== artifact.sha256) throw new Error('输入复制期间发生变更');
    await validateArtifactFile(destination, port);
  }

  async archiveFile(source: string) {
    const digest = await fileDigest(source);
    const byteLength = fs.statSync(source).size;
    const blobs = path.join(this.root, 'blobs');
    const destination = path.join(blobs, digest);
    if (!fs.existsSync(destination)) {
      const pending = path.join(blobs, '.tmp-' + randomUUID());
      try {
        await fs.promises.copyFile(source, pending, fs.constants.COPYFILE_EXCL);
        if (await fileDigest(pending) !== digest) throw new Error('文件在归档时发生变更');
        const file = fs.openSync(pending, 'r+');
        try { fs.fsyncSync(file); } finally { fs.closeSync(file); }
        try { fs.linkSync(pending, destination); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      } finally {
        fs.rmSync(pending, { force: true });
      }
    }
    const archived = controlledFile(blobs, digest);
    if (await fileDigest(archived) !== digest) throw new Error('已有归档内容与哈希不符');
    return { sha256: digest, byteLength };
  }

  async publishOutput(source: string, port: ArtifactPort, record: ExecutionRecord, outputPort: string) {
    await validateArtifactFile(source, port);
    return {
      ...await this.archiveFile(source),
      id: 'artifact-' + randomUUID(),
      name: path.basename(source),
      mediaType: port.mediaType,
      schemaId: port.schemaId,
      provenance: 'workbench_native',
      studyId: record.request.studyId,
      executionId: record.id,
      outputPort,
      createdAt: new Date().toISOString(),
    } satisfies ArtifactRecord;
  }

  async importArtifact(file: string, port: ArtifactPort, options: {
    studyId: string; importedFrom: string; expectedHash?: string; name?: string;
    provenance?: ArtifactRecord['provenance'];
  }) {
    checkId(options.studyId, '课题');
    await validateArtifactFile(file, port);
    const bytes = await this.archiveFile(file);
    if (options.expectedHash && options.expectedHash !== bytes.sha256) throw new Error('导入文件的哈希与基准不符');
    const id = 'import-' + sha256(canonicalJson([options.studyId, options.importedFrom, bytes.sha256, port.mediaType, port.schemaId]));
    const target = path.join(this.root, 'imports', id + '.json');
    if (fs.existsSync(target)) return readJson<ArtifactRecord>(target);
    const artifact: ArtifactRecord = {
      ...bytes, id, name: options.name ?? path.basename(file), mediaType: port.mediaType, schemaId: port.schemaId,
      studyId: options.studyId, provenance: options.provenance ?? 'external_verified_import',
      importedFrom: options.importedFrom, executionId: null, outputPort: null, createdAt: new Date().toISOString(),
    };
    publishJson(target, artifact);
    return artifact;
  }

  recoverInterrupted() {
    const finishedAt = new Date().toISOString();
    const error = '服务中断，保留已提交的执行及产物。';
    const executions = this.listExecutions();
    for (const execution of executions) {
      if (execution.status === 'running') this.saveExecution({ ...execution, status: 'failed', finishedAt, error });
    }
    for (const recipe of this.listRecipeRuns()) {
      if (recipe.status !== 'running') continue;
      const completed = executions.filter((execution) =>
        execution.recipeRunId === recipe.id && execution.recipeStepId && execution.status === 'completed');
      const committed = Object.fromEntries(completed.map((execution) => [execution.recipeStepId!, execution.id]));
      this.saveRecipeRun({
        ...recipe, status: 'failed', finishedAt, error,
        executions: { ...recipe.executions, ...committed },
      });
    }
  }
}

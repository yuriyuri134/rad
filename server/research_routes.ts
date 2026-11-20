import type { Express, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { ArtifactPort, ExecutionRequest, WorkflowRecipe } from '../src/core/researchTypes.ts';
import { parseFitsBuffer } from '../src/core/fits.ts';
import { ResearchEngine } from './research_engine.ts';
import { checkId, validateContract } from './research_store.ts';
import { listWorkbenchData } from './workbench.ts';

export function installResearchRoutes(app: Express, engine: ResearchEngine) {
  function action(handler: (req: Request, res: Response) => unknown) {
    return async (req: Request, res: Response) => {
      try {
        await handler(req, res);
      } catch (error) {
        res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
      }
    };
  }

  function checkStudy(studyId: string, branchId?: string) {
    const state = listWorkbenchData();
    if (!state.studies.some((study) => study.id === studyId)) throw new Error('找不到研究课题');
    if (branchId && !state.branches.some((branch) => branch.studyId === studyId && branch.id === branchId)) {
      throw new Error('研究分支不属于所选课题');
    }
  }

  function track(done: Promise<unknown>) {
    void done.catch((error) => console.error('研究记录落盘失败', error));
  }

  app.get('/api/research/state', action((_req, res) => {
    const executions = engine.store.listExecutions();
    res.json({ executions, artifacts: engine.store.listArtifacts(executions), recipeRuns: engine.store.listRecipeRuns() });
  }));
  app.post('/api/research/executions', action((req, res) => {
    const payload = req.body as ExecutionRequest;
    checkStudy(payload.studyId, payload.branchId);
    const job = engine.startExecution(payload);
    track(job.done);
    res.status(202).json(job.record);
  }));
  app.get('/api/research/executions/:id', action((req, res) => {
    const record = engine.store.getExecution(req.params.id);
    if (!record) throw new Error('找不到执行');
    const logFile = engine.store.logPath(record.id);
    let log = '';
    if (fs.existsSync(logFile)) {
      const fd = fs.openSync(logFile, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(Math.min(size, 32768));
        fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
        log = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    }
    res.json({ record, log });
  }));
  app.post('/api/research/executions/:id/rerun', action((req, res) => {
    const { inputs, parameters } = req.body ?? {};
    const job = engine.rerunExecution(req.params.id, {
      ...(inputs === undefined ? {} : { inputs }),
      ...(parameters === undefined ? {} : { parameters }),
    });
    track(job.done);
    res.status(202).json(job.record);
  }));
  app.post('/api/research/recipes', action((req, res) => {
    const recipe = req.body as WorkflowRecipe;
    checkStudy(recipe.studyId, recipe.branchId);
    const job = engine.startRecipe(recipe);
    track(job.done);
    res.status(202).json(job.record);
  }));
  app.post('/api/research/recipes/:id/continue', action((req, res) => {
    const previous = engine.store.getRecipeRun(req.params.id);
    if (!previous) throw new Error('找不到工作流记录');
    const job = engine.startRecipe(previous.recipe, { continuedFrom: previous.id, rerunStep: req.body?.rerunStep });
    track(job.done);
    res.status(202).json(job.record);
  }));
  app.post('/api/research/cancel/:id', action((req, res) => {
    if (!engine.cancel(req.params.id)) throw new Error('运行已结束或不在本进程');
    res.status(202).json({ id: req.params.id });
  }));
  app.post('/api/research/import-json', action(async (req, res) => {
    const { studyId, name, schemaId, source, data } = req.body;
    checkStudy(studyId);
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]+\.json$/.test(name) ||
        typeof source !== 'string' || !source.trim()) throw new Error('请输入 JSON 文件名和来源');
    const port: ArtifactPort = { mediaType: 'application/json', schemaId };
    validateContract({ protocol: 'openlab-files/v1', inputs: {}, outputs: { imported: port } });
    const staging = engine.store.stage();
    try {
      const file = path.join(staging, name);
      fs.writeFileSync(file, JSON.stringify(data), 'utf8');
      const artifact = await engine.store.importArtifact(file, port, {
        studyId, importedFrom: source, provenance: 'user_import',
      });
      res.status(201).json(artifact);
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }));
  app.get('/api/research/artifacts/:id', action(async (req, res) => {
    checkId(req.params.id);
    const artifact = engine.store.listArtifacts().find((item) => item.id === req.params.id);
    if (!artifact) throw new Error('找不到产物');
    const file = await engine.store.openArtifact(artifact);
    if (req.query.preview === '1' && artifact.byteLength <= 32 * 1024 * 1024) {
      const raw = fs.readFileSync(file);
      if (artifact.mediaType === 'application/json') {
        res.json({ artifact, data: JSON.parse(raw.toString('utf8')) });
        return;
      }
      if (artifact.mediaType.endsWith('/fits')) {
        res.json({ artifact, fits: parseFitsBuffer(new Uint8Array(raw), artifact.name, { maxSources: 64 }) });
        return;
      }
      if (artifact.mediaType.startsWith('text/')) {
        res.json({ artifact, text: raw.toString('utf8') });
        return;
      }
    }
    res.download(file, artifact.name, { headers: { 'X-Content-Type-Options': 'nosniff' } });
  }));
}

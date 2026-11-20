import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

export interface VerifiedSource {
  code: string;
  codeHash: string;
}

function hash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function readVerifiedSource(filePath: string, expectedHash: string): VerifiedSource {
  const code = fs.readFileSync(filePath, 'utf8');
  if (hash(code) !== expectedHash) throw new Error('代码 SHA-256 不匹配: ' + filePath);
  return { code, codeHash: expectedHash };
}

export function stopChild(child: ChildProcess): void {
  const running = () => child.exitCode === null && child.signalCode === null;
  if (!running()) return;
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    // ChildProcess.killed indicates a sent signal rather than an observed exit.
    if (running()) child.kill('SIGKILL');
  }, 1500);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

export function stageVerifiedSources(entry: string, sources: Record<string, VerifiedSource>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openlab-python-'));
  const dispose = () => fs.rmSync(directory, { recursive: true, force: true });
  try {
    if (!Object.hasOwn(sources, entry)) throw new Error('缺少已核验的 Python 入口');
    for (const [relative, { code, codeHash }] of Object.entries(sources)) {
      const fullPath = path.resolve(directory, relative);
      const relativeToStage = path.relative(directory, fullPath);
      if (!relativeToStage || relativeToStage.startsWith('..') || path.isAbsolute(relativeToStage) || hash(code) !== codeHash) {
        throw new Error('拒绝暂存未核验的代码：' + relative);
      }
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, code, { encoding: 'utf8', flag: 'wx' });
    }
  } catch (error) {
    dispose();
    throw error;
  }
  return { directory, entry: path.join(directory, entry), dispose };
}

export function stageVerifiedPython(entry: string, sources: Record<string, VerifiedSource>) {
  const stage = stageVerifiedSources(entry, sources);
  const args = [
    '-I', '-B', '-u', '-c',
    'import os, runpy, sys; entry = sys.argv.pop(1); sys.argv[0] = entry; sys.path.insert(0, os.path.dirname(entry)); runpy.run_path(entry, run_name="__main__")',
    stage.entry,
  ];
  return { ...stage, args };
}

export function pythonEnvironment(extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PYTHON/i.test(key)));
  return { ...env, PYTHONNOUSERSITE: '1', ...extraEnv };
}

export function runLocalProcess(
  executable: string,
  args: string[],
  input: string,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
  options: { cwd?: string; signal?: AbortSignal; log?: (chunk: Buffer) => void; maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error('执行已取消'));
      return;
    }
    const child = spawn(executable, args, { cwd: options.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const streams = [child.stdout, child.stderr];
    const buffers = [Buffer.alloc(0), Buffer.alloc(0)];
    let failure: Error | undefined;
    const abort = (error: Error) => {
      if (failure) return;
      failure = error;
      stopChild(child);
    };
    const timer = setTimeout(() => abort(new Error('执行超出时间预算')), timeoutMs);
    const cancel = () => abort(new Error('执行已取消'));
    options.signal?.addEventListener('abort', cancel, { once: true });
    streams.forEach((stream, index) => stream.on('data', (chunk: Buffer) => {
      if (failure) return;
      try {
        options.log?.(chunk);
      } catch (error) {
        abort(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (buffers[index].byteLength + chunk.byteLength > (options.maxBuffer ?? 16 * 1024 * 1024)) {
        abort(new Error('执行输出超出缓冲区限制'));
        return;
      }
      buffers[index] = Buffer.concat([buffers[index], chunk]);
    }));
    child.once('error', abort);
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') abort(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', cancel);
      const [stdout, stderr] = buffers.map((buffer) => buffer.toString('utf8'));
      if (failure) reject(failure);
      else if (code === 0 || stdout.trimStart().startsWith('{')) resolve({ stdout, stderr, exitCode: code ?? 1 });
      else reject(new Error(stderr.trim() || '子进程异常退出，状态码 ' + code));
    });
    child.stdin.end(input);
  });
}

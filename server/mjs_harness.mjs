import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  applyVariableVector,
  extractVariables,
  traceOpticalSystem,
} from '../src/core/optics.ts';

function readStdin() {
  return fs.readFileSync(0, 'utf8').trim();
}

function buildTraceHelper(solverId, pythonBridgePath) {
  if (solverId === 'solver-optiland-python') {
    return (spec) => {
      const stdout = execFileSync('python3', [pythonBridgePath, '--solve'], {
        input: JSON.stringify({ systemSpec: spec }),
        encoding: 'utf8',
        timeout: 15000,
      });
      const parsed = JSON.parse(stdout);
      if (parsed.status !== 'ok') {
        throw new Error(parsed.error || 'Optiland solver failed');
      }
      return parsed.result;
    };
  }
  return (spec) => traceOpticalSystem(spec);
}

async function main() {
  const raw = readStdin();
  const payload = JSON.parse(raw || '{}');
  const { action, implPath, evalImplPath, params, evalParams, solverId, trace, spec, initialSpec } = payload;

  const mod = await import(pathToFileURL(path.resolve(implPath)).href);

  if (action === 'check') {
    if (typeof mod.selfCheck !== 'function') {
      throw new Error('组件未导出 selfCheck(params) 自检函数');
    }
    const out = await mod.selfCheck(params || {});
    process.stdout.write(JSON.stringify(out));
    return;
  }

  if (action === 'evaluate') {
    if (typeof mod.evaluate !== 'function') {
      throw new Error('评价组件未导出 evaluate(rawArtifacts, spec, params)');
    }
    const out = await mod.evaluate(trace, spec, params || {});
    process.stdout.write(JSON.stringify(out));
    return;
  }

  if (action === 'optimize') {
    if (typeof mod.optimize !== 'function') {
      throw new Error('优化组件未导出 optimize(initialSpec, helpers, params)');
    }
    const evalMod = await import(pathToFileURL(path.resolve(evalImplPath)).href);
    if (typeof evalMod.evaluate !== 'function') {
      throw new Error('搭配的评价组件未导出 evaluate(rawArtifacts, spec, params)');
    }
    const pythonBridgePath = path.resolve(process.cwd(), 'python', 'optiland_bridge.py');
    const traceFn = buildTraceHelper(solverId, pythonBridgePath);
    const helpers = {
      extractVariables,
      applyVariableVector,
      trace: traceFn,
      evaluate: (t, s) => evalMod.evaluate(t, s, evalParams || {}),
    };
    const out = await mod.optimize(initialSpec, helpers, params || {});
    process.stdout.write(JSON.stringify(out));
    return;
  }

  if (action === 'standalone') {
    const fn = mod.analyze || mod.run || mod.evaluate;
    if (typeof fn !== 'function') {
      throw new Error('组件未导出可独立调用的 analyze / run / evaluate 函数');
    }
    const out = await fn(trace || spec || payload.input || {}, spec || {}, params || {});
    process.stdout.write(JSON.stringify(out));
    return;
  }

  throw new Error(`未知子进程执行动作: ${action}`);
}

main().catch((err) => {
  process.stderr.write(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

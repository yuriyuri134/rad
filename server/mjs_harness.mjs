import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

function readStdin() {
  return fs.readFileSync(0, 'utf8').trim();
}

function sha256(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizePosix(p) {
  return path.posix.normalize(p.replace(/\\/g, '/'));
}

const RELATIVE_IMPORT_REGEX =
  /((?:(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?|import\s*\(\s*))(['"])(\.\.?\/[^'"]+)\2/g;

function resolveRelativeDepKey(fromRelPath, spec) {
  const fromDir = path.posix.dirname(normalizePosix(fromRelPath));
  const joined = fromDir === '.' ? normalizePosix(spec) : path.posix.normalize(path.posix.join(fromDir, spec));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) {
    throw new Error(
      `相对依赖安全拦截：${fromRelPath} 引用了越界路径 "${spec}"，禁止访问组件版本目录之外的相对模块`,
    );
  }
  return joined;
}

function compileVerifiedHostModule(spec, verifiedHostModules, hostMemo, visiting = new Set(), fromTargetId = null) {
  if (!verifiedHostModules || typeof verifiedHostModules !== 'object') {
    return null;
  }

  let normalized = null;
  if (fromTargetId === null) {
    if (!spec.startsWith('../')) return null;
    normalized = path.posix.normalize(spec.replace(/^(\.\.\/)+/, ''));
  } else if (spec.startsWith('./') || spec.startsWith('../')) {
    const baseDir = path.posix.dirname(normalizePosix(fromTargetId));
    normalized = path.posix.normalize(path.posix.join(baseDir, spec));
  } else {
    return null;
  }

  const hostEntry = verifiedHostModules[normalized];
  if (!hostEntry) {
    if (fromTargetId !== null) {
      throw new Error(
        `宿主模块相对依赖未固定 (${fromTargetId})：引用了 "${spec}" (${normalized})，禁止从磁盘加载`,
      );
    }
    return null;
  }

  if (typeof hostEntry.code !== 'string' || typeof hostEntry.codeHash !== 'string') {
    throw new Error(
      `宿主模块安全校验失败 (${normalized})：缺少经校验的 code 字节或 codeHash，禁止通过 fileUrl 加载`,
    );
  }

  if (hostMemo.has(normalized)) {
    return hostMemo.get(normalized);
  }
  if (visiting.has(normalized)) {
    throw new Error(`宿主模块循环依赖禁止执行：检测到 ${normalized} 循环引用`);
  }

  const actualHash = sha256(hostEntry.code);
  if (actualHash !== hostEntry.codeHash) {
    throw new Error(
      `宿主模块哈希校验失败 (${normalized})：实际 ${actualHash} 与预期 ${hostEntry.codeHash} 不一致`,
    );
  }

  visiting.add(normalized);
  let jsCode = /\.(ts|mts)$/i.test(normalized)
    ? stripTypeScriptTypes(hostEntry.code)
    : hostEntry.code;

  jsCode = jsCode.replace(RELATIVE_IMPORT_REGEX, (_m, prefix, quote, subSpec) => {
    const depUrl = compileVerifiedHostModule(subSpec, verifiedHostModules, hostMemo, visiting, normalized);
    return `${prefix}${quote}${depUrl}${quote}`;
  });
  visiting.delete(normalized);

  const dataUrl = `data:text/javascript;base64,${Buffer.from(jsCode, 'utf8').toString('base64')}`;
  hostMemo.set(normalized, dataUrl);
  return dataUrl;
}

function compileVerifiedModuleTree(
  entryRelPath,
  verifiedCode,
  expectedCodeHash,
  verifiedRelativeDeps,
  verifiedHostModules,
  label,
) {
  if (typeof verifiedCode !== 'string' || typeof expectedCodeHash !== 'string') {
    throw new Error(`安全校验失败 (${label})：缺少 verifiedCode 或 expectedCodeHash，禁止从磁盘路径直接加载`);
  }
  const actualHash = sha256(verifiedCode);
  if (actualHash !== expectedCodeHash) {
    throw new Error(
      `TOCTOU/哈希校验失败 (${label})：执行字节 SHA-256 (${actualHash}) 与预期 (${expectedCodeHash}) 不一致，拒绝执行`,
    );
  }

  const depsMap = verifiedRelativeDeps && typeof verifiedRelativeDeps === 'object' ? verifiedRelativeDeps : {};
  const memo = new Map();
  const hostMemo = new Map();
  const visiting = new Set();

  const compileModule = (relPath, codeText, expectedHash) => {
    if (memo.has(relPath)) return memo.get(relPath);
    if (visiting.has(relPath)) {
      throw new Error(`循环相对依赖禁止执行 (${label})：检测到 ${relPath} 循环引用`);
    }
    const actual = sha256(codeText);
    if (actual !== expectedHash) {
      throw new Error(
        `TOCTOU/相对依赖哈希校验失败 (${label}/${relPath})：实际 ${actual} 与预期 ${expectedHash} 不一致`,
      );
    }

    visiting.add(relPath);
    const rewritten = codeText.replace(RELATIVE_IMPORT_REGEX, (_m, prefix, quote, spec) => {
      const hostDataUrl = compileVerifiedHostModule(spec, verifiedHostModules, hostMemo);
      if (hostDataUrl) {
        return `${prefix}${quote}${hostDataUrl}${quote}`;
      }
      const targetKey = resolveRelativeDepKey(relPath, spec);
      const depEntry = depsMap[targetKey];
      if (!depEntry || typeof depEntry.code !== 'string' || typeof depEntry.codeHash !== 'string') {
        throw new Error(
          `相对依赖未固定或不可用 (${label})：${relPath} 引用的 "${spec}" (${targetKey}) 不在已验证依赖清单中，禁止从磁盘读取`,
        );
      }
      const depDataUrl = compileModule(targetKey, depEntry.code, depEntry.codeHash);
      return `${prefix}${quote}${depDataUrl}${quote}`;
    });
    visiting.delete(relPath);

    const dataUrl = `data:text/javascript;base64,${Buffer.from(rewritten, 'utf8').toString('base64')}`;
    memo.set(relPath, dataUrl);
    return dataUrl;
  };

  return compileModule(normalizePosix(entryRelPath || 'impl.mjs'), verifiedCode, expectedCodeHash);
}

async function importVerifiedModule(
  verifiedCode,
  expectedCodeHash,
  baseImplPath,
  verifiedRelativeDeps,
  verifiedHostModules,
  label,
) {
  const entryName = baseImplPath ? path.basename(baseImplPath) : 'impl.mjs';
  const dataUrl = compileVerifiedModuleTree(
    entryName,
    verifiedCode,
    expectedCodeHash,
    verifiedRelativeDeps,
    verifiedHostModules,
    label,
  );
  return await import(dataUrl);
}

async function importVerifiedOpticsHostModule(verifiedHostModules) {
  const hostMemo = new Map();
  const dataUrl = compileVerifiedHostModule('../../../../src/core/optics.ts', verifiedHostModules, hostMemo);
  if (!dataUrl) {
    throw new Error('宿主模块安全校验失败：未提供已校验的 src/core/optics.ts 字节，拒绝执行');
  }
  return await import(dataUrl);
}

function buildTraceHelper(solverId, pythonBridgePath, opticsMod) {
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
  return (spec) => opticsMod.traceOpticalSystem(spec);
}

async function main() {
  const raw = readStdin();
  const payload = JSON.parse(raw || '{}');
  const {
    action,
    implPath,
    verifiedCode,
    expectedCodeHash,
    verifiedRelativeDeps,
    verifiedHostModules,
    solverVerifiedHostModules,
    evalImplPath,
    evalVerifiedCode,
    expectedEvalCodeHash,
    evalVerifiedRelativeDeps,
    evalVerifiedHostModules,
    params,
    evalParams,
    solverId,
    trace,
    spec,
    initialSpec,
  } = payload;

  if (action === 'trace_host') {
    await importVerifiedModule(
      verifiedCode,
      expectedCodeHash,
      implPath,
      verifiedRelativeDeps,
      verifiedHostModules,
      'solver_stub',
    );
    const opticsMod = await importVerifiedOpticsHostModule(verifiedHostModules);
    const out = opticsMod.traceOpticalSystem(spec);
    process.stdout.write(JSON.stringify(out));
    return;
  }

  const mod = await importVerifiedModule(
    verifiedCode,
    expectedCodeHash,
    implPath,
    verifiedRelativeDeps,
    verifiedHostModules,
    'primary',
  );

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
    const evalMod = await importVerifiedModule(
      evalVerifiedCode,
      expectedEvalCodeHash,
      evalImplPath,
      evalVerifiedRelativeDeps,
      evalVerifiedHostModules,
      'evaluator',
    );
    if (typeof evalMod.evaluate !== 'function') {
      throw new Error('搭配的评价组件未导出 evaluate(rawArtifacts, spec, params)');
    }
    const hostMap = solverVerifiedHostModules || verifiedHostModules;
    const opticsMod =
      hostMap && hostMap['src/core/optics.ts']
        ? await importVerifiedOpticsHostModule(hostMap)
        : await import('../src/core/optics.ts');
    const pythonBridgePath =
      process.env.OPENLAB_OPTILAND_BRIDGE || path.resolve(process.cwd(), 'python', 'optiland_bridge.py');
    const traceFn = buildTraceHelper(solverId, pythonBridgePath, opticsMod);
    const helpers = {
      extractVariables: opticsMod.extractVariables,
      applyVariableVector: opticsMod.applyVariableVector,
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


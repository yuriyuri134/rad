import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface DiscoveredPythonRuntime {
  executable: string;
  source: 'env_override' | 'tmp_p2_venv' | 'local_venv' | 'system_path';
  pythonVersion: string | null;
  packages: {
    optiland: string | null;
    numpy: string | null;
    scipy: string | null;
    astropy: string | null;
    sep: string | null;
    photutils: string | null;
  };
  readyForP2: boolean;
}

const PROBE_SCRIPT = [
  'import importlib.metadata, json, platform',
  'pkgs = {}',
  'for p in ("optiland", "numpy", "scipy", "astropy", "sep", "photutils"):',
  '    try:',
  '        pkgs[p] = importlib.metadata.version(p)',
  '    except Exception:',
  '        pkgs[p] = None',
  'print(json.dumps({"pythonVersion": platform.python_version(), "packages": pkgs}))',
].join('\n');

export function resolvePythonBinary(): { executable: string; source: DiscoveredPythonRuntime['source'] } {
  const candidates: Array<{ exe: string; source: DiscoveredPythonRuntime['source'] }> = [];
  if (process.env.OPENLAB_PYTHON_BIN?.trim()) {
    candidates.push({ exe: process.env.OPENLAB_PYTHON_BIN.trim(), source: 'env_override' });
  }
  candidates.push(
    { exe: path.resolve(process.cwd(), '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'), source: 'local_venv' },
    { exe: '/tmp/p2_venv/bin/python', source: 'tmp_p2_venv' },
    { exe: 'python3', source: 'system_path' },
  );

  for (const c of candidates) {
    if (c.source === 'system_path') {
      return { executable: c.exe, source: c.source };
    }
    if (fs.existsSync(c.exe)) {
      return { executable: c.exe, source: c.source };
    }
  }
  return { executable: 'python3', source: 'system_path' };
}

export function inspectDiscoveredPythonRuntime(): DiscoveredPythonRuntime {
  const { executable, source } = resolvePythonBinary();
  try {
    const out = execFileSync(executable, ['-c', PROBE_SCRIPT], {
      timeout: 5000,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out.trim()) as {
      pythonVersion?: string | null;
      packages?: Partial<DiscoveredPythonRuntime['packages']>;
    };
    const packages = {
      optiland: parsed.packages?.optiland ?? null,
      numpy: parsed.packages?.numpy ?? null,
      scipy: parsed.packages?.scipy ?? null,
      astropy: parsed.packages?.astropy ?? null,
      sep: parsed.packages?.sep ?? null,
      photutils: parsed.packages?.photutils ?? null,
    };
    return {
      executable,
      source,
      pythonVersion: parsed.pythonVersion ?? null,
      packages,
      readyForP2: Boolean(packages.optiland && packages.astropy && packages.sep && packages.photutils),
    };
  } catch {
    return {
      executable,
      source,
      pythonVersion: null,
      packages: {
        optiland: null,
        numpy: null,
        scipy: null,
        astropy: null,
        sep: null,
        photutils: null,
      },
      readyForP2: false,
    };
  }
}

# OpenLab Bench v2 — 本地与持久化环境运行指南（Windows + WSL2 / Linux）

OpenLab Bench 是一个面向真实科研工程任务（首先以光学设计及天文观测数据处理为主线）的**可拆解、可追溯、可组合、可演化 AI 科研工程工作台**。

若你是接手本项目的新 Agent 或开发者，请**首先阅读根目录下的 [`PROJECT_HANDOFF.md`](./PROJECT_HANDOFF.md)** 获取完整项目背景、架构演进脉络、P1/P2 实验全貌、E6/E7 真实状态与下一步研究路线。

---

## 1. 环境要求

- **操作系统**：推荐 **Windows 10/11 + WSL2 (Ubuntu 22.04 / 24.04)**、原生 Linux 或 macOS。
  - *注意*：在 WSL2 中，请将项目存放在 Linux 原生文件系统（如 `~/projects/openlab-bench`），**不要放在 `/mnt/c/...`**，以避免跨文件系统 I/O 性能损耗与文件锁问题。
- **Node.js & 包管理器**：
  - `Node.js >= 22.13.0`（组件隔离执行器 `server/mjs_harness.mjs` 依赖 Node 22.13+ 内置 `module.stripTypeScriptTypes()`）。
  - **统一包管理器与锁文件**：本仓库已统一使用 **`npm`** 与 **`package-lock.json`**（已移除旧容器遗留的 `bun.lock`，并消除 `esbuild` 与 `vite 8.3` 的 peer 冲突）。在干净环境中请严格使用 **`npm ci`** 按锁文件恢复依赖。
- **Python**：`>= 3.11`（推荐 `Python 3.12`，用于运行 `optiland==0.6.3`、`astropy`、`photutils`、`sep`、`scipy`、`numpy`）。

---

## 2. 快速安装与启动（3 步跑通完整环境）

### 第一步：校验交付包与 Manifest 完整性（推荐）

```bash
# 方式 A：运行完整 4 重自检（含 DELIVERY_MANIFEST.sha256 自校验、全部文件字节与 SHA-256、双向无遗漏检查及 runs.jsonl 冻结校验）
node scripts/verify_delivery_integrity.mjs

# 方式 B（可选）：用系统 sha256sum 独立验证清单文件自身
sha256sum -c DELIVERY_MANIFEST.sha256
```

> **后续新实验提示**：当你在新环境中运行新实验并生成新文件后，若只想验证原始交付基线文件是否被篡改，可加 `--allow-extra` 参数运行：`node scripts/verify_delivery_integrity.mjs --allow-extra`。

### 第二步：一键构建持久化科学 Python 虚拟环境（默认 `./.venv`）

```bash
bash scripts/setup_python_env.sh
```

- 默认直接在项目根目录创建持久化 **`./.venv`**（位于 WSL2/Linux 项目磁盘中，**不会安装到 `/tmp`**），并按 [`requirements-scientific.lock.txt`](./requirements-scientific.lock.txt) 安装经实测验证的 `optiland==0.6.3`、`astropy==8.0.3`、`photutils==3.1.1`、`sep==1.4.1`、`numpy==2.5.5`、`scipy==1.18.1`。
- `server/python_env.ts` 的自动探测优先级为：
  1. 环境变量 `OPENLAB_PYTHON_BIN`（如 `export OPENLAB_PYTHON_BIN=/custom/venv/bin/python`）
  2. **`./.venv/bin/python`**（本地持久化项目目录，**最高默认优先级**）
  3. `/tmp/p2_venv/bin/python`（仅作旧云端临时容器兼容回退）
  4. 系统 `python3`
- *说明*：`experiments/p2_flagship/scripts/ensure_env.sh` 是历史 P2 Stage 1 留存脚本（当时写死 `/tmp/p2_venv`），作为历史资产原样保留；在持久化环境中请始终使用根目录 `scripts/setup_python_env.sh`。

### 第三步：严格按锁文件安装 Node 依赖、运行测试并启动工作台

```bash
# 严格按 package-lock.json 恢复精确依赖版本（已在干净目录实测通过）
npm ci

# 运行全套 35 项单元与集成测试（含 Stage A1 CAS 校验、Optiland/FITS/WCS 与 v2 工作台测试）
npx tsx --test server/*.test.ts src/core/*.test.ts

# 类型检查与前端构建
npm run lint
npm run build

# 启动开发/研究服务器（默认监听 http://localhost:3000）
npm run dev
```

打开浏览器访问 `http://localhost:3000`，顶部状态栏会显示已探测到的本地 `./.venv` Python 3.12 及 `optiland 0.6.3 · astropy 8.0.3 · photutils 3.1.1`。

---

## 3. 通过 ZIP 导出或 GitHub 迁移至 WSL2

### 方案 A：从交付 ZIP 解压（推荐离线/直接导出）

若已下载交付压缩包 `dist-delivery/openlab-bench-v2-delivery.zip` 及校验文件 `dist-delivery/openlab-bench-v2-delivery.zip.sha256`：

```bash
mkdir -p ~/projects/openlab-bench
# 校验 ZIP 完整性（若同时拷贝了 .sha256）
sha256sum -c openlab-bench-v2-delivery.zip.sha256
# 解压并保持完整目录结构
unzip openlab-bench-v2-delivery.zip -d ~/projects/openlab-bench
cd ~/projects/openlab-bench
node scripts/verify_delivery_integrity.mjs
```

### 方案 B：通过 GitHub 私有仓库提交与拉取交接

若你更希望用 Git/GitHub 完成首次建库与后续同步（确保在项目根目录执行，`.gitignore` 已排除 `node_modules/`、`dist/`、`.venv/`、`dist-delivery/`、`*.zip`、`.env`）：

```bash
# 1. 在导出目录初始化 Git 并提交首版基线（不包含敏感密钥和虚拟环境）
git init -b main
git add .
git status   # 确认未包含 .env、node_modules/、.venv/、dist-delivery/
git commit -m "chore: initial persistent handoff of OpenLab Bench v2"

# 2. 推送到你新建的 GitHub 私有仓库（替换为你的实际仓库地址）
git remote add origin git@github.com:<your-username>/openlab-bench.git
git push -u origin main

# 3. 在目标 WSL2 / Linux 服务器克隆并校验
git clone git@github.com:<your-username>/openlab-bench.git ~/projects/openlab-bench
cd ~/projects/openlab-bench
node scripts/verify_delivery_integrity.mjs
bash scripts/setup_python_env.sh
npm ci
```

---

## 4. 配置 AI 协作者（可选）

- 工作台内置了**确定性实证协作者（Deterministic Empirical Collaborator，`server/ai.ts`）**，即使不配置任何外部 LLM API Key，也能基于磁盘真实实验产物给出严格区分 `[事实] / [判断] / [假设] / [提议]` 的诊断并生成可一键启动的 Python 实算提议。
- 若需启用 Gemini 大模型在线协同分析，可复制 `.env.example` 为 `.env` 并填入你自己的 `GEMINI_API_KEY`（**切勿将 `.env` 提交至 Git 仓库**）。

---

## 5. 目录与数据持久性边界

| 路径 | 角色与修改策略 |
| :--- | :--- |
| `src/`、`server/`、`python/`、`server.ts` | OpenLab Bench v2 前后端与 Python 异步执行器源码（纳入 Git 版本控制） |
| `package.json`、`package-lock.json` | 统一的 Node.js 依赖清单与精确锁文件（`npm ci` 唯一依据） |
| `pyproject.toml`、`requirements-scientific.lock.txt`、`scripts/setup_python_env.sh` | Python 科学环境依赖锁定与 `./.venv` 幂等重建脚本 |
| `experiments/p1_optics/` | P1（100mm f/4 单/双胶合）实验脚本、13 个 JSON 产物与 8 份总结报告 |
| `experiments/p2_flagship/` | P2（`WF-RC-1000` 1.0m f/6 宽视场天文望远镜）审计脚本、Stages 1–5 脚本、JSON 产物、20 幅 `512×512` 真实 FITS 图像及阶段报告 |
| `workspace/runs.jsonl`、`thread.jsonl`、`immutable_store/`、`workspace/.backups/` | **Stage A1 不可变历史账本、迁移前备份与 CAS 冻结存储（严禁覆盖或手工篡改；`runs.jsonl` SHA-256 固定为 `698ff3e9...`）** |
| `workspace/components/*` | 文件级可拆解组件库（9 个组件档案与 `v0.1` 源码） |
| `workspace/workbench/*` | OpenLab Bench v2 增量研究账本（课题、分支、异步作业、执行记录、产物引用、认识论笔记、架构快照与标注） |
| `PROJECT_HANDOFF.md` | **新会话 / 新 Agent 零上下文接力总手册** |
| `DELIVERY_MANIFEST.json` & `DELIVERY_MANIFEST.sha256` | 全仓交付文件清单、字节大小、分类、64 位 SHA-256 校验账本及清单自身独立摘要 |

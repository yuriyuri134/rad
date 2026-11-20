# OpenLab Bench — 全量项目保全与跨会话/跨环境接力总手册 (`PROJECT_HANDOFF.md`)

> **致新会话 / 新 Agent / 接手开发者**：  
> 本文件是 OpenLab Bench 从云端临时预览容器迁出至持久化开发环境时的**唯一权威事实基准（Single Source of Truth）**。  
> 你**不需要**阅读此前长会话的聊天记录，只需按本文件顶部的“5 分钟接手清单”读取磁盘上的真实代码、实验产物与 `DELIVERY_MANIFEST.json`，即可零损失接续全部研究与工程工作。

---

## 零、新 Agent 5 分钟零上下文接手清单（先做这 5 步）

1. **校验磁盘交付完整性**：运行 `node scripts/verify_delivery_integrity.mjs`（同步验证 `DELIVERY_MANIFEST.sha256` 自校验、全部 199 个交付文件字节与 SHA-256、双向无多余/缺失文件，以及 Stage A1 `workspace/runs.jsonl` 不可变哈希）。
2. **确认环境依赖就绪**：
   - Node.js（已统一为 **`npm` + `package-lock.json`**）：执行 `npm ci`。
   - Python（默认安装到项目持久目录 **`./.venv`**，而非 `/tmp`）：执行 `bash scripts/setup_python_env.sh`。
3. **验证测试与编译基线**：执行 `npx tsx --test server/*.test.ts src/core/*.test.ts`（35/35 全通）与 `npm run lint && npm run build`。
4. **阅读关键真相文件**（不必通读全部历史报告）：
   - 架构与产品背景：本文件 + `docs/openlab-product-audit-and-v2-plan.md` + `docs/stage-a1-2-delivery.md`
   - P2 旗舰科学结论：`experiments/p2_flagship/reports/p2_flagship_stage1_report.md`
   - 当前工作台持久化状态：`workspace/workbench/studies.json`、`branches.json`、`jobs.json`、`notes.jsonl`
5. **启动服务核验 UI**：执行 `npm run dev`，访问 `http://localhost:3000`。

---

## 一、项目是什么、最终追求什么

### 1. 项目定位与双核心目标
OpenLab Bench 源于用户与朋友 Rad 关于 AI、光学设计、科研工具与 Agent 的长期探索。它追求两个同等重要且相互促进的目标：

- **目标 A（解决真实科研工程问题）**：从光学设计及其与天文观测数据处理的完整链路入手（想要的效果 → 工程要求 → 数学指标 → 初始结构 → 物理仿真 → 评价函数 → 参数优化 → 公差验证 → 探测器成像与星表反演），构建真正能帮助研究者学习、探索、设计、仿真、优化、验证和组织研究过程的工具。**绝不能只是概念 Demo，也绝不能只是给现有软件套一个聊天界面。**
- **目标 B（探索通用 AI 科研工程系统）**：通过真实科研工程任务检验 AI 如何理解开放问题、发现未知、调用专业工具（如 Optiland、Astropy、Photutils、SEP 等）、组织多分支并行探索、根据实验反馈修正假设，以及**当现有系统架构无法满足新科研任务时，如何识别不适配并演化系统自身结构**。

### 2. 核心设计戒律（新 Agent 必须严格遵守）
1. **不是固定光学实验软件**：光学设计是第一条真实检验主线，不是系统的终极边界。不要把当前四个 Tab、既有光学数据结构或 B0 v0.2 视为不可改变的前提。
2. **用实践检验架构，而不是让实践迁就架构**：遇到新任务（如离轴 TMA、光栅光谱仪、新物理求解器）时，先独立理解任务需要什么；若现有组件或数据表示不支持，允许使用外部脚本、建立新表示或重构局部架构，并在实践后总结不适配与信息损失。
3. **事实与认识论分层**：任何结论、笔记与 AI 分析必须严格区分 **`[事实]`**（已由代码、运行、实验或可靠资料验证）、**`[判断]`**（基于事实的解释与结论）、**`[假设]`**（尚未验证的可能性）、**`[提议]`**（下一步可执行方案）。未运行真实物理仿真时，严禁声称已完成物理验证；严禁编造缺失参数或伪造运行产物。
4. **不可变历史保护**：必须严格区分**历史实验原始记录**（`historical_migrated`）、**外部已验证导入**（`external_verified_import`）与**工作台原生执行记录**（`workbench_native`）。对 Stage A1 已冻结的 `workspace/runs.jsonl` 与 `workspace/immutable_store/sha256/*` 严禁覆盖或篡改。

---

## 二、当前系统真正实现了什么（以磁盘真实文件为准）

当前交付包覆盖 **199 个项目文件**（共约 **23.2 MB**，不含 `node_modules`、`./.venv`、构建产物 `dist/` 与导出压缩包 `dist-delivery/`，详见 `DELIVERY_MANIFEST.json`），由**三大真实工程层次**构成：

### 1. 第一层：Stage A1 / A1.2 不可变底座与安全组件执行器
- **位置**：`server/storage.ts`、`server/a1_migrate.ts`、`server/runner.ts`、`server/mjs_harness.mjs`、`workspace/`（根目录级文件及 `workspace/.backups/`）。
- **已实现能力**：
  - **不可变实验账本**：`workspace/runs.jsonl`（SHA-256 固定为 `698ff3e99c846a050abb559620c3602f4e8af65bcd3e4688739b031e9e35b42d`）与 `workspace/thread.jsonl`，外加只读追加补充账本 `workspace/run_supplements.jsonl`。
  - **内容寻址存储（CAS）与防篡改执行**：`workspace/immutable_store/sha256/` 下冻结了 6 个核心组件/宿主模块 Blob。`server/runner.ts` 与 `server/mjs_harness.mjs` 在执行 `frozen` 组件时直接校验 64 位 SHA-256 并通过内存 `data:` URL 加载（包括锁定的 `src/core/optics.ts` 宿主模块），杜绝磁盘 TOCTOU 与越界 `../` 导入；任何 CAS 篡改直接 Fail-Closed 阻断。
  - **迁移崩溃恢复日志**：`server/a1_migrate.ts` 实现了 `.migration_tmp/<id>/journal.json` 两阶段崩溃恢复与幂等迁移契约（详见 `docs/stage-a1-2-delivery.md`）。

### 2. 第二层：P1 与 P2 两大真实光学与天文工程实验资产
- **P1（`experiments/p1_optics/`，26 个文件）——100 mm f/4 单透镜到双胶合消色差探索**：
  - 包含 `run_experiments.py`、`verify_physics.py`、`test_p1_physics.py`、`task_spec.json`。
  - `artifacts/` 下包含 `A0`–`A3`、`B0`–`B3`、`C1`、`experiments_ledger.json`、`physics_verification.json` 共 13 个真实运行产物。
  - `reports/` 下包含 `01_environment_and_tool_audit.md` 至 `08_b0_v02_revision_recommendations.md` 共 8 份深度报告。
- **P2（`experiments/p2_flagship/`，37 个脚本/审计/JSON/报告 + 20 幅真实 FITS = 57 个文件）——`WF-RC-1000` 1.0 m f/6（EFL 6000 mm, 1.2° FoV, 0.45–0.80 μm, 15 μm 像元）宽视场巡天望远镜全链路工程研究**：
  - **能力边界独立审计（`audits/`）**：6 个独立 Python 脚本（`audit_01` 至 `audit_05` 及 `audit_02b`）与对应的 JSON/FITS 实测产物（含 1 幅测试 FITS `audit04_test_starfield.fits`），彻底摸清了 `Optiland 0.6.3` 在共轴折反、离轴 TMA、光栅色散、`ImageSimulationEngine`、内置公差及 `Astropy/Photutils/SEP` 上的真实能力与报错机理。
  - **五阶段全链路脚本（`scripts/`）与原始产物（`runs/`）**：
    - `stage1_rc_baseline.py` → `runs/S0_bare_rc.json`（解析推导三阶消像差裸 RC，实测 0.60° 边缘受像散+场曲主导退化至 `RMS=170.74 μm`、`Strehl=0.0029`）。
    - `stage2_corrector_v2.py` → `runs/S1_to_S4_correctors_v2.json` 及 `branch_S1..S4.json`、`checkpoint_S1..S4.json`（四条场镜路线优化对比：`S1` 2片熔石英、`S2` 3片 Wynne 锁定 RC 圆锥、`S3` 3片 Wynne + 解锁 Quasi-RC 主次镜圆锥 `K1=-1.14865, K2=-6.46154`、`S4` 3片 `FS+F2+FS`。其中 **`S3` 以全视场 `max RMS = 1.063 μm`、`550nm Strehl = 0.854–0.982`、`MTF@33.33 = 0.773–0.781`、最大畸变 `0.343%` 全面胜出**）。
    - `stage3_fits_astrometry_pipeline.py` → `runs/stage3_fits_astrometry.json` 及 **`runs/fits/*.fits`（20 幅 `512×512` 32-bit IEEE-754 真实 FITS 图像，每幅 `1,054,080` 字节，合计 `20.1 MB`，含 IAU `RA---TAN / DEC--TAN` WCS）**。揭示了关键物理与算法耦合现象：`S3` 弥散斑极锐利（`~1.06 μm` vs `15 μm` 像元），处于轻度欠采样，导致 `Photutils DAOStarFinder` 默认 `fwhm=3.0 px` 漏检过半暗星（完备率仅 `42.9%–67.9%`），而 `SEP` 达 `96.4%–100.0%`（去畸变天测 RMS `0.0259"–0.0370"`）。
    - `stage4_tolerancing.py` → `runs/stage4_tolerancing.json`（绕开 Optiland 内置 `tolerancing` 的 `+z` 限制，自研 3D 扰动与双补偿优化器：证明对最敏感的 `M1 R1 +1.5 mm` 误差，仅靠 `BFL` 调焦会使 0.60° `Strehl` 跌至 `0.6160`；引入 **M2 轴向垫片 `-0.659 mm` + BFL 微调** 后恢复至 `0.9855`，40 次蒙特卡洛良率达 `100%`，`P95 RMS = 3.086 μm`）。
    - `stage5_independent_verifier.py` → `runs/stage5_independent_verification.json`（独立纯 NumPy `2×2 ABCD` 矩阵核验全分支 EFL 误差 `< 0.013 mm`，并校验全部 20 幅 FITS 头与像素有限性）。
  - **阶段总结报告**：`experiments/p2_flagship/reports/p2_flagship_stage1_report.md`。

### 3. 第三层：OpenLab Bench v2 开放科研工作台（前后端与 Python 异步执行桥）
- **关键源码与 API 速查表**：

| 模块 / 文件 | 职责与核心接口 |
| :--- | :--- |
| `server.ts` | Express 入口（端口 `3000`），挂载 Vite 开发中间件及全部 REST API：`/api/environment`、`/api/workbench/bootstrap`、`/api/studies`、`/api/studies/:id/branches/:branchId/adopt`、`/api/notes`、`/api/jobs/start`、`/api/jobs/:id`、`/api/jobs/:id/cancel`、`/api/fits/{catalog,sample,inspect,inspect-artifact,upload-raw}`、`/api/ai/collaborate`、`/api/architecture-map`、`/api/architecture-snapshots`、`/api/components/{create,:id,:id/fork,:id/draft,:id/approve,:id/activate,:id/check,:id/run-standalone}` 及 P1 兼容路由 `/api/bootstrap`、`/api/experiments/run` |
| `server/workbench.ts` | v2 增量研究账本（`workspace/workbench/*`）读写、ID 幂等去重、异步 Python 子进程管理（流式无缓冲日志、超时预算、安全取消、孤儿作业重启恢复 `reconcileOrphanedAsyncJobs`） |
| `server/python_env.ts` | Python 科学运行时探测，按 **`OPENLAB_PYTHON_BIN` → `./.venv/bin/python` → `/tmp/p2_venv/bin/python` → `python3`** 顺序发现并核查 `optiland/astropy/photutils/sep/numpy/scipy` |
| `server/ai.ts` | 实证受限 AI 科研协作者：无密钥时自动运行确定性实证推理（`buildDeterministicCollaboration`），有 `GEMINI_API_KEY` 时可调用 Gemini API；所有输出强制区分 `[事实]/[判断]/[假设]/[提议]` 并可附带可执行 `proposedAction` |
| `python/workbench_p2_runner.py` | 工作台原生异步实算执行桥，支持 4 种真实计算模式：`wf_rc_perturb_eval`（公差扰动与双补偿）、`fits_star_extract`（单帧 FITS 重提取）、`fits_batch_completeness`（16/20 帧批量欠采样横评）、`wf_rc_s4_reopt_probe`（S4 多起点/解锁圆锥重优化） |
| `src/App.tsx` + `src/components/*` | 四大工作区：`ResearchStudio.tsx`（研究工作台，含 P1 切换挂载 `ExperimentWorkspace.tsx`）、`ArtifactsAndCompareView.tsx`（对比矩阵 + `FitsWorkspace.tsx` + `RunComparison.tsx`）、`ComponentLibrary.tsx`（组件与工作流）、`ArchitectureMapView.tsx`（动态自引用架构地图） |

- **v2 工作台与底层 Stage A1 的关系**：
  - Stage A1（`workspace/runs.jsonl`, `immutable_store/`, `components/`）是不可变历史记录与 CAS 冻结执行底座；
  - OpenLab Bench v2 在 `workspace/workbench/` 建立侧挂增量账本，**零改动兼容** A1 历史记录，并通过 `provenanceTier`（`historical_migrated` / `external_verified_import` / `workbench_native`）清晰隔离三类证据来源，避免破坏任何历史哈希与测试。

---

## 三、`E6` 与 `E7` 运行记录、原始产物与日志的真实状态说明（重点核查）

在工作台 v2 验收期间，我们针对 `WF-RC-1000` 的两个核心开放问题启动了两次工作台原生异步 Python 实算（`E6` 与 `E7`）。期间云端临时容器在 `2026-11-18T15:47Z` 发生过一次底层回收重启，导致文件系统回滚到了 `13:57:15Z` 的容器快照。**以下是磁盘上的 100% 真实留存状态（绝无伪造）**：

### 1. 分支 `E6`（16 帧批量 FITS 欠采样横评）—— **已完整保存在磁盘**
- **关联 ID**：分支 `branch-wb-mwm6gffc`（短码 `E6`）、执行记录 `exec-wb-mwm6gffc`、异步作业 `job-mwm6gdak-kblb`、实证笔记 `note-1795009744921-5m0`。
- **执行时间与耗时**：`2026-11-18T13:49:02.156Z` 启动，`13:49:04.918Z` 完成，耗时 `2762 ms`。
- **磁盘原始产物**：
  - `workspace/workbench/artifacts/exec-wb-mwm6gffc.json`（`10,505` 字节，SHA-256: `f11e2ea9414f5ecacd4452c54649b3bfb6ba9c936f660be9ff2690f3e977838c`），内含 `S1–S4` 共 16 幅 FITS 在 `DAOStarFinder(fwhm=1.5px, threshold=4.5σ)` 与 `SEP(minarea=4)` 下逐帧检出数、交叉匹配数、匹配率与未匹配余项。
  - **实测核心指标**：16 帧相对 `SEP` 均匹配率从 Stage 3（`DAO fwhm=3.0px`）的 **`65.4%`** 提升至 **`88.2%`**（最低 `67.9%`，其中 `S3 0.60°` 从 `42.9%` 跃升至 `77.8%`），16 帧累计未匹配余项 `30`。
  - **日志留存说明**：独立文件 `workspace/workbench/logs/job-mwm6gdak-kblb.log` 未包含在容器快照中，但该作业的**完整 21 行逐帧无缓冲 stdout 日志**已完整保存在 `workspace/workbench/jobs.json` 第 1 条记录的 `logs` 数组中。

### 2. 分支 `E7`（S4 多起点与解锁 Quasi-RC 圆锥系数诊断重优化）—— **严格区分三个独立事实**

请新 Agent 在引用或续做 `E7` 时，务必严格区分以下三个客观事实，绝不混淆：

- **事实 1（当时计算确实已完成）**：
  - `2026-11-18T13:57:13.577Z` 由 UI 点击提议启动 `job-mwm6qwh5-b2n2`（`runnerMode: "wf_rc_s4_reopt_probe"`, `strategy: "unlock_conics_multi_seed"`, `maxNfev: 25`, `numRaysOpt: 4`, `evalNumRays: 12`）。
  - `2026-11-18T13:58:57.882Z` 子进程在原容器内真实完成实算（总耗时 `104,305 ms`），当时日志输出的实测数值为：
    - 种子 1 `[解锁K1/K2+S2起点]`：初始 `cost=1675012.475` → 收敛 `cost=969.009`（`nfev=302`, `dt=49.36s`）；
    - 种子 2 `[解锁K1/K2+S3准RC起点]`：初始 `cost=1644576.116` → 收敛 `cost=1053.505`（`nfev=278`, `dt=45.57s`）；
    - 最优候选全视场多色 RMS：`0.00°=7.826 μm`, `0.60°=8.090 μm`, `max RMS` 从原 `S4` 的 `9.704 μm` 降至 **`9.199 μm`**（改善 `5.2%`），`550nm Strehl(0°/0.60°)=0.21179 / 0.61792`，`MTF@33.3=0.636`，畸变 `0.018%`。
- **事实 2（原始完成产物已因容器快照回滚丢失，当前磁盘未伪造补写）**：
  - 云端临时容器后台快照截取于 `2026-11-18T13:57:15Z`（作业刚开始运行 1.4 秒），在 `15:47Z` 容器空闲重置回滚到该快照后，`13:58:57Z` 落盘的 `E7` 分支条目与结果 JSON 文件（原指纹前缀 `ad863c92f34b58a1...`）已从磁盘永久丢失。
  - **遵循科研诚信原则**：交付包**没有**根据历史日志或总结数字伪造一份 E7 完成产物，仅如实保留磁盘上真实存留的剩余依据：
    1. `workspace/workbench/notes.jsonl` 第 5 行（`id: "note-1795010134927-sxmw"`）：完整保留触发 `E7` 的 AI `[提议]` 笔记与全部 `proposedAction` 参数；
    2. `workspace/workbench/jobs.json` 第 2 项（`id: "job-mwm6qwh5-b2n2"`）：完整保留启动时间、输入参数与前 4 行真实启动日志，并由 `reconcileOrphanedAsyncJobs` 如实标记为因快照回滚中断（`status: "failed"` + `[recovery]` 日志）。
- **事实 3（后续可在新持久化环境中一键重跑复现）**：
  - 触发 `E7` 的执行代码（`python/workbench_p2_runner.py` 中的 `run_wf_rc_s4_reopt_probe`）与完整参数（`notes.jsonl` 第 5 行）均已 100% 保全。
  - 在 WSL2/Linux 持久化环境启动服务后，打开 `http://localhost:3000` → `研究工作台` 右侧 `认识论研究记录账本` → 找到 `[提议] S4 (FS + Schott F2) 未收敛成因诊断与有限预算重优化实测提议` → 点击 **`载入提议并启动实算`**，即可在约 90–105 秒内重新生成并永久落盘带全新 SHA-256 的原生分支与产物。

---

## 四、`DELIVERY_MANIFEST.json` 自校验边界与交付包导出方式

### 1. 自校验边界说明
- `DELIVERY_MANIFEST.json` 记录了交付范围内全部 **199 个项目文件**的相对路径、精确分类、字节大小与 64 位 SHA-256。
- **不包含在 `files[]` 内的对象**：
  - 排除目录：`node_modules/`、`dist/`、`dist-delivery/`、`.git/`、`.playwright-cli/`、`.aistudio/`、`.venv/`、`__pycache__/`；
  - 排除文件：`DELIVERY_MANIFEST.json`、`DELIVERY_MANIFEST.sha256`、`.env`、`.env.local`、`*.zip`、`*.zip.sha256`、`*.pyc`、`*.pyo`。
- **清单自身完整性验证**：由于 SHA-256 无法自包含，运行 `node scripts/verify_delivery_integrity.mjs --generate-manifest` 时会同步生成同级标准校验文件 **`DELIVERY_MANIFEST.sha256`**。执行 `node scripts/verify_delivery_integrity.mjs` 会依次执行 4 重验证：
  1. `DELIVERY_MANIFEST.sha256` 与 `DELIVERY_MANIFEST.json` 实际 SHA-256 一致；
  2. 清单内 199 个文件全部存在且**字节数与 SHA-256 双重匹配**；
  3. 双向完整性扫描：确认磁盘交付范围内**无遗漏、无未登记的多余文件**（后续开展新实验时可传 `--allow-extra` 仅校验原始基线）；
  4. Stage A1 不可变历史账本 `workspace/runs.jsonl` 字节级等于 `698ff3e99c846a050abb559620c3602f4e8af65bcd3e4688739b031e9e35b42d`。

### 2. 导出与移交渠道（ZIP + GitHub 双方案）
- **完整项目 ZIP 交付包**：位于 `dist-delivery/openlab-bench-v2-delivery.zip`（附带独立校验文件 `dist-delivery/openlab-bench-v2-delivery.zip.sha256`），完整保留项目目录结构，内含全部 199 个交付文件 + `DELIVERY_MANIFEST.json` + `DELIVERY_MANIFEST.sha256`（共 201 个文件），不含 `node_modules/`、`./.venv`、`dist/` 及任何密钥。
- **GitHub 交接方式**：详见 `README_LOCAL.md` 第 3 节（`git init -b main` → 核查 `.gitignore` → 推送至私有仓库 → 目标 WSL2 机器 `git clone` 后运行 `node scripts/verify_delivery_integrity.mjs` + `bash scripts/setup_python_env.sh` + `npm ci`）。

---

## 五、B0 v0.2 设计检验与尚未冻结的架构判断

通过 P1 与 P2 `WF-RC-1000` 实践，我们已经证实早期 **B0 v0.2 架构存在 4 个不成立的基础假设**，并在 v2 中完成了第一轮演进，但以下边界**尚未冻结**，新 Agent 在后续开发中应继续演进：

### 1. 已验证的架构判断（不再沿用 B0 v0.2 旧假设）
1. **否定“单跳四动作流水线假设”**：真实科研不是 `OpticalSystemSpec -> solver -> optimizer -> evaluator` 单跳闭环，而是多阶段异构有向无环图（**Artifact DAG**，如 `一阶推导 -> 多分支优化 -> PSF 立方体 -> FITS 合成 -> 星表提取 -> 公差蒙特卡洛 -> 独立数学核验`）。
2. **否定“静态扁平表面表（Surface Table）唯一表示假设”**：在包含主次镜共轭、M2 垫片联动、离轴倾角链的系统中，自由变量是**参数化系统构造器（Parametric Builder）与耦合约束**，而非孤立表面的 `thickness`（Optiland 内置 `tolerancing.set_thickness` 在反射系统上崩溃正是反面教材）。
3. **否定“短时同步无状态执行器假设”**：物理优化与蒙特卡洛天然是数十秒至数分钟级任务，必须依赖带无缓冲日志流、超时预算、断点 checkpoint 与崩溃对账的异步作业机制。
4. **否定“单域固定评价标准假设”**：同一研究课题在不同阶段的评价指标会动态演化（Stage 2 看 RMS/Strehl，Stage 3 看欠采样 FITS 星表完备度与 WCS 残差，Stage 4 看双补偿蒙特卡洛良率）。

### 2. 当前已完成 vs 部分完成 vs 未完成功能清单

| 能力模块 | 当前状态 | 真实代码依据与未冻结边界 |
| :--- | :---: | :--- |
| **Stage A1 不可变账本、CAS 冻结与崩溃恢复** | **已完成** | `server/storage.ts`, `server/a1_migrate.ts`, `server/runner.ts`（26 项专项测试全通） |
| **P1 / P2 (WF-RC-1000 Stages 1–5) 科学实验与 20 帧 FITS 资产** | **已完成** | `experiments/p1_optics/`, `experiments/p2_flagship/` |
| **OpenLab Bench v2 四工作区贯通切片（课题/分支/对比/FITS+WCS/组件/架构地图）** | **已完成** | `src/components/*`, `server/workbench.ts`, `python/workbench_p2_runner.py`（35/35 测试全通） |
| **受控异步 Python 实算台与确定性/LLM AI 协作者** | **已完成** | 支持 4 种 P2 实算模式、流式日志、超时/取消、孤儿任务恢复与一键执行提议 |
| **通用组件 Schema 动态生成实验表单与自由 DAG 连线编排** | **部分完成（未冻结）** | 目前 `ResearchStudio.tsx` 的异步实算台仍针对 `WF-RC-1000` 定制了 4 个模式 Tab，切换到新建课题时复用该面板；**尚未实现从任意组件 `inputs/outputs` Schema 自动生成通用多步 DAG 表单** |
| **P2 Task 2（离轴无遮拦 TMA）端到端设计与自定义矢量一阶求解器** | **已完成前置审计，未执行端到端设计** | `audits/audit_02_tma_and_psf_boundaries.py` 已摸清 `Wavefront(best_fit)` / `FFTPSF(best_fit)` 可用而标量近轴/MTF 报错的边界，待在新环境正式开展设计优化 |
| **P2 Task 3（望远镜耦合光栅光谱仪 2D 光谱 FITS 与波长定标）** | **已完成前置审计，未执行端到端设计** | `audits/audit_04_grating_and_astropy.py` 已跑通 `surface_type="grating"` 多波长衍射角追迹，待开展完整光谱仪建模与谱线提取 |
| **接入外部真实天文台实测 FITS / 干涉仪实测面形数据** | **未开始** | 当前 20 帧 FITS 为 Optiland FFTPSF 高保真卷积仿真帧，尚未导入 SDSS/DECam 等真实天空曝光帧 |

---

## 六、哪些已验证问题不应重新讨论（避免新 Agent 走回头路）

1. **不要再质疑 `Optiland 0.6.3` 是否有 `ImageSimulationEngine`**：
   - 已经实测验证存在于 `optiland.analysis.image_simulation.ImageSimulationEngine`（配置字典键名为 `"wavelengths"`）。它能生成 RGB/多通道图像张量，但不支持物理探测器像元重采样、噪声统计与 TAN WCS FITS 输出，因此天文级 FITS 生成仍需使用 `stage3_fits_astrometry_pipeline.py` 的子像元 PSF 卷积管线。
2. **不要把离轴 TMA 的 `UnsupportedParaxialGeometryError` 当成“Optiland 不支持离轴系统”**：
   - Optiland 的 3D 真实光线追迹（`optic.surfaces.trace`）、`SpotDiagram`、`Wavefront(strategy="centroid"|"best_fit")`、`FFTPSF(strategy="centroid"|"best_fit")`、`MMDFTPSF(num_rays>=32)` 在离轴 TMA 上**完全可用**；只有依赖标量折叠近轴模型的 `paraxial`、`chief_ray`、`HuygensPSF` 和内置 `MTF` 类会报错。
3. **不要在折反/反射系统上直接调 `optiland.tolerancing.MonteCarlo`**：
   - 其内部 `set_thickness` 仅支持沿全局 `+z` 轴单向递增，遇到反射镜折返路径即抛错；折反与离轴公差必须使用 `stage4_tolerancing.py` / `workbench_p2_runner.py` 中的显式表面坐标与曲率扰动建模。
4. **不要修改或格式化 `workspace/runs.jsonl` 及 `workspace/immutable_store/sha256/*`**：
   - 测试套件中的 `a0_audit.test.ts`、`a1_migrate.test.ts` 与 `workbench.test.ts` 均对 `workspace/runs.jsonl` 的 SHA-256（`698ff3e99c846a050abb559620c3602f4e8af65bcd3e4688739b031e9e35b42d`）做字节级断言。

---

## 七、持久化迁移方案（Windows + WSL2 首选，兼顾未来 Linux 服务器）

为了彻底摆脱云端临时预览容器“空闲重置 `/tmp`、无 Git 历史、长耗时计算易被会话截断”的限制，采用以下**最低成本、零架构推翻**的持久化方案：

### 1. 推荐宿主拓扑：Windows 10/11 + WSL2 (Ubuntu 22.04/24.04)
- **存放路径**：将整个项目放入 WSL2 Linux 原生目录（例如 `~/projects/openlab-bench`），**不要放在 `/mnt/c/...`**。
- **开发体验**：在 Windows 端使用 VS Code（安装 `WSL` 扩展）或 Cursor / Claude Code 直接连接 WSL2 目录；在 Windows 浏览器直接访问 `http://localhost:3000`。

### 2. 六大关注点分层落地

| 维度 | Windows + WSL2 本地持久化方案 | 未来迁移至独立 Linux 服务器方案 |
| :--- | :--- | :--- |
| **① Git 源码版本管理** | 在项目根目录执行 `git init -b main`。`.gitignore` 已排除 `node_modules/`、`dist/`、`dist-delivery/`、`*.zip`、`.venv/`、`.env`、`.playwright-cli/`。源码、文档及体积仅 20.1 MB 的 20 幅基准 FITS 瓦片可直接纳入首版 Git Commit（若后续产生 GB 级 FITS 巡天序列，再启用 Git LFS 或外部数据目录）。 | 直接 `git clone` 仓库到服务器，源码与基准实验零差异同步。 |
| **② 持久研究数据存储** | `workspace/` 与 `experiments/` 直接存储在 WSL2 ext4 磁盘上，永不因进程重启丢失。`server/storage.ts` 已支持环境变量 `OPENLAB_WORKSPACE_DIR`，可将工作区指向独立数据盘或定期快照目录。 | 将 `OPENLAB_WORKSPACE_DIR` 指向服务器挂载的持久化数据卷（如 `/data/openlab-workspace`），配合每日 `rsync` / ZFS / Borg 快照。 |
| **③ Python 科学环境** | 运行一次 `bash scripts/setup_python_env.sh`，在项目根目录生成持久化 **`./.venv`**（`Python 3.12` + `optiland 0.6.3` + `astropy` + `photutils` + `sep`）。`server/python_env.ts` **优先自动探测 `./.venv/bin/python`**，无需 `/tmp` 也无需重复安装。 | 同样运行 `bash scripts/setup_python_env.sh` 或使用固定路径并通过 `export OPENLAB_PYTHON_BIN=/opt/openlab-venv/bin/python` 注入。 |
| **④ 长时间计算进程与任务恢复** | `server/workbench.ts` 通过 `spawn(python, ['-u', ...])` 异步运行并将日志实时追加到 `workspace/workbench/logs/<jobId>.log`；长耗时脚本采用逐种子/逐分支 `.partial.json` / `checkpoint_*.json` 落盘；服务重启时 `reconcileOrphanedAsyncJobs` 自动对账孤儿进程。 | 可在服务器使用 `systemd` 或 `pm2` 托管 `node server.ts`（或 `npm run dev`），长耗时 Python 子进程脱离浏览器生命周期独立完成并写回账本。 |
| **⑤ Web 前后端常驻与访问** | 统一使用 `npm ci` 安装依赖，WSL2 内运行 `npm run dev`（开发态）或 `npm run build && npm start`（生产态），监听 `0.0.0.0:3000`，Windows 宿主机浏览器直接打开 `http://localhost:3000`。 | 通过 Nginx / Caddy 反向代理或 Tailscale / SSH 端口转发（`ssh -L 3000:localhost:3000`）安全访问。 |
| **⑥ Agent 访问与持续协同** | 本地 CLI Agent（如 Claude Code、Codex CLI、Cursor Agent）直接在 WSL2 目录启动，首条指令读取 `PROJECT_HANDOFF.md` 与 `DELIVERY_MANIFEST.json`，既可直接运行 Python 实验脚本，也可调用 `http://localhost:3000/api/*` 接口或修改前后端代码。 | Agent 通过 SSH 或在服务器端容器/tmux 会话中直接挂载同一代码与数据目录协同工作。 |

---

## 八、下一步在新环境中最值得做什么（按优先级排序）

当你在持久化环境中跑通 `node scripts/verify_delivery_integrity.mjs`、`npm ci`、`bash scripts/setup_python_env.sh` 与 `npx tsx --test server/*.test.ts src/core/*.test.ts` 后，建议按以下顺序推进：

1. **轻量恢复动作（约 1.5 分钟）**：
   - 在工作台 UI（`http://localhost:3000`）右侧 `认识论研究记录账本` 点击 `[提议] S4 (FS + Schott F2) 未收敛成因诊断与有限预算重优化实测提议` 的**“载入提议并启动实算”**按钮，让 `E7` 在持久化磁盘上完整落盘。
2. **核心科研与架构联合演进（二选一作为切入点）**：
   - **路线 A（推进 P2 Task 2：离轴无遮拦 TMA + 矢量一阶求解器）**：利用 `audit_02` 已探明的边界，在 `Optiland` 标量近轴和内置 MTF 报错的条件下，编写外部矢量近轴/特征光线一阶求解组件 + `Wavefront(best_fit)` / `FFTPSF(best_fit)` 优化闭环，并借此**把工作台 `ResearchStudio.tsx` 的实验表单从“WF-RC-1000 专属 4-Tab”重构为“由组件输入/输出 Schema 动态驱动的多步 DAG 工作流”**。
   - **路线 B（推进 P2 Task 3：望远镜耦合天文光栅光谱仪）**：基于 `audit_04` 已验证的 `surface_type="grating"`，构建 `WF-RC-1000` 焦面馈入的长缝光栅光谱仪，生成 2D 光谱色散 FITS 与波长定标提取组件，检验工作台从“2D 星场成像”跨入“2D 光谱提取与波长解”的跨模态能力。

# OpenLab Bench 产品能力真实审计与整体重构方案（v2 / B0.3）

> **审计范围与方法**：直接检查当前运行态界面（`http://localhost:3000` 四个页面截屏与 DOM 核验）、前端源码（`src/`）、服务端源码（`server/`、`python/optiland_bridge.py`）与工作区账本（`workspace/`、`experiments/p2_flagship/`）。  
> **严格区分五类状态**：① 底层已实现但 UI 未暴露；② UI 已展示但未贯通；③ 已有设计方案但未实现；④ 当前设计根本不支持；⑤ 不应被预先固定为静态功能。

---

## 一、产品能力真实审计清单（代码 + 运行态证据）

### 1. 五类能力分类审计表

| 模块 / 能力 | 分类 | 代码与运行态真实依据 | 对真实科研任务（P1 / P2）的影响 |
| :--- | :---: | :--- | :--- |
| **Stage A1 研究对象与谱系实体** (`ResearchObject`, `Branch`, `ResearchSnapshot`, `ExperimentSnapshot`, `ArchitectureSnapshot`, `RunSupplement`) | **① 底层已实现，UI 未暴露** | `server/storage.ts:2644-2715` 已提供完整读写与迁移数据（`workspace/research_objects.json`, `branches.json`, `snapshots.jsonl`, `architecture_snapshots.jsonl`）；`server.ts:44` 导入 `listResearchObjects` 但仅在 `POST /api/experiments/run` (`server.ts:502`) 读取默认 `roList[0]`。无任何 GET/POST `/api/research-objects`、`/api/branches`、`/adopt` 路由，前端 `src/` 零界面展示。 | 用户无法看到研究目标、验收标准、未决问题、分支与快照演化树，也无法显式采纳某分支或切换课题。 |
| **独立可插拔 Python 科学环境（Optiland 0.6.3 / Astropy / SEP / Photutils）** | **①/② 底层具备但环境探测断连** | `experiments/p2_flagship/` 已验证完整 Optiland `0.6.3` + Astropy `8.0.2` + SEP `1.4.1` + Photutils `3.1.1` 运行于 `/tmp/p2_venv/bin/python`；但 `server/runner.ts:97,412` 硬编码调用系统 `'python3'`（`/usr/bin/python3` 为 `3.11.2` 且未安装 `optiland`），导致运行时界面顶栏横幅与组件库始终报 `Optiland 未安装 / 当前环境不可用`。 | 容器内明明可构建隔离科学虚拟环境，正式工作台却无法发现并调用真实科学工具链。 |
| **2D FITS 解析与观测工作台** (`FitsWorkspace.tsx` & `src/core/fits.ts`) | **② UI 存在但孤立断链** | `src/components/FitsWorkspace.tsx` (316 行) 完整实现了 canvas 拉伸（Linear/Sqrt/Log）、像素探针、星点标注与文件上传，并请求 `/api/fits/sample` 与 `/api/fits/upload-raw`；但 `src/App.tsx` 与 `TopBar.tsx` 从未挂载该组件，且 `server.ts` 根本没有 `/api/fits/*` 路由。`fits-photometry-reader` 在组件库显示“阶段二预留”。 | 工作台无法打开 P2 已产出的 20 个真实 `.fits` 图像文件，更无法与 `Photutils/SEP` 联动。 |
| **FITS 检出上限与 WCS 盲区** (`src/core/fits.ts:178-182`) | **② 底层实现存在硬编码限制** | `detectApertureSources` 硬截断 `selected.length >= 12`、固定孔径 `r = 4`，且不解析 `RA---TAN / DEC--TAN` WCS 头坐标。 | 每 Tile 28 颗模拟星被强制丢弃一半以上，且无法核验 P2 Stage 3 的天测角秒残差。 |
| **双来源 SystemSpec 派生错配** (`ExperimentWorkspace.tsx:551-557`) | **② UI 交互存在逻辑隐患** | 点击“从此结果派生分支”将 `viewedRun.systemAfter` 填入表单，但若随后切换预设（单透镜/双胶合），`handleRunClick` 仍会把旧 `viewedRun.id` 作为 `parentRunId` 提交。 | 导致谱系记录中出现跨拓扑假继承（Stage A1 迁移时已在 `snap-002-before` 暴露过同类问题）。 |
| **架构快照持久对比** (`ArchitectureMapView.tsx:332-350`) | **①/② 底层有持久化文件，前端仅存内存** | `workspace/architecture_snapshots.jsonl` 已落盘，但前端“保存结构快照”仅存入 React `useState` (`baselineSnapshot`)，刷新页面即丢失。 | 无法跨会话对比架构演进前后的差异。 |
| **Stage B / C / D 研究工作循环与分支路由** | **③ 已有设计方案，尚未实现** | `docs/stage-a1-2-delivery.md:4,124-126` 明确标示 Stage B（ResearchObject -> ResearchSnapshot -> Branch -> 显式采纳）及前端工作台重构尚待推进。 | 仅停留在迁移底座与文档契约层面，未变成可操作的科研闭环。 |
| **光学数据契约单构型锁定** (`src/core/types.ts:178-207`) | **④ 当前设计根本不支持** | `OpticalSurface` 只有 `radiusMm / thicknessMm / semiApertureMm / glassAfter`（6 种枚举玻璃），无 `conic`、反射镜/光栅类型、中心遮拦、3D 倾斜偏心；`ExperimentRun` 死锁在 `systemBefore/systemAfter: OpticalSystemSpec` 与单场 `RayTraceResult`。 | P2 `WF-RC-1000`（双曲面主次镜 + 13.28% 遮拦 + 3 片 Wynne 熔石英场镜 + 多视场 Strehl/畸变 + 公差扰动）根本无法用 `OpticalSystemSpec` 表达，更无法进入正式账本。 |
| **单跳同步短超时执行器** (`server/runner.ts:53,711`) | **④ 当前设计根本不支持** | `execFile` 阻塞式同步调用（超时 `10–30 s`），仅支持 4 种内置动作；无异步作业队列、无流式无缓冲日志、无超时预算管理、无断点/部分结果保留、无异构产物 DAG。 | 无法运行分钟级的多目标光学优化、蒙特卡洛公差分析（40 trials ~138 s）或外部分步管线，这正是 P2 必须在 `experiments/p2_flagship/` 绕开主框架的根本原因。 |
| **被动式单模态 AI 评论** (`server/ai.ts:32-56`) | **④ 当前设计定位受限** | AI 仅截取最近 4 条 `ExperimentRun` 的 `eflMm / rmsSpotUm / mtf30` 发送一次性文本请求并追加一条 `thread.jsonl` 记录，看不到 `ResearchObject`、分支对比、FITS 星表、公差分布，也无法发起或预填可运行实验。 | AI 只是“旁白注释器”，不是能读取真实多源证据、指出反例并推动实验迭代的协作者。 |
| **从 UI 新建组件与自由组合多阶段工作流** | **④/⑤ 不应被固定为单一形式** | 当前 `ComponentLibrary.tsx` 仅能对既有 `local_process_*` 组件派生版本，无法在 UI 注册全新组件，也无法将不同类型工具（Optiland 求解器 + 自定义 Python 公差脚本 + Astropy/SEP 提取器）编排为多阶段工作流。同时，科学工作流与研究形式本身**不应被死板固定为唯一的四步流水线**。 | 阻碍自由探索：每当研究从“光学追迹”跨入“图像仿真 → 源提取 → 装调公差”，系统就被迫脱离工作台运行裸脚本。 |

---

## 二、为什么 P1 / P2 此前没有自然出现在工作台中？（根本原因）

1. **P1 被“降格迁移”**：`run-001 / run-002` 与 `obj-optics-100mm-f4` 虽然在 Stage A1 完成了底座建档，但前端仍只渲染 `workspace/runs.jsonl` 中的表面参数，隐藏了 `ResearchObject` 的目标、判据与未决问题。
2. **P2 被核心契约拒之门外**：`WF-RC-1000` 包含解析综合（Stage 1）、4 分支多目标优化（Stage 2）、20 幅 FITS 成像与天测测光闭环（Stage 3）、独立 3D 公差与 M2 垫片双补偿蒙特卡洛（Stage 4）及独立 ABCD 数学交叉核验（Stage 5）。工作台既不能表达折反非球面与公差模型，也不能挂载 FITS/MC 产物或调用 `/tmp/p2_venv` 长耗时脚本，导致 P2 只能完全在 `experiments/p2_flagship/` 离线执行。

---

## 三、OpenLab Bench v2 整体产品架构与核心数据模型

### 1. 保留 / 重构 / 废弃清单（Keep / Refactor / Deprecate）

| 现有资产 | 决策 | 具体处置方案 |
| :--- | :---: | :--- |
| `workspace/runs.jsonl`、`thread.jsonl`、`immutable_store/`、A1 迁移快照与 SHA-256 校验 | **严格保留（只读保护）** | 保持字节级零改动，所有新能力采用 `workspace/workbench/` 侧挂增量账本 + 显式来源分级，避免破坏 A1 不可变性。 |
| `src/core/optics.ts`、`server/mjs_harness.mjs`、`server/a1_migrate.ts` | **保留** | 继续完整支撑 P1 100mm f/4 几何光学预览、CAS 无盘执行与历史回归测试。 |
| `src/core/fits.ts` + `src/components/FitsWorkspace.tsx` | **重构并接入主流程** | 修复 `12` 颗截断限制，加入 IAU `RA---TAN / DEC--TAN` WCS 投影换算，接入 `/api/fits/*` 后端路由并升级为实时支持 `WF-RC-1000` 20 幅真实 FITS 与实时 Python `Photutils/SEP` 重提取的交互检查台。 |
| `src/core/architectureMap.ts` + `ArchitectureMapView.tsx` | **重构升级** | 摆脱 17 个硬编码路径：动态扫描 `src/`、`server/`、`python/`、`experiments/`，并将 `ResearchStudy`、分支、执行记录、FITS/JSON 产物与 Python 虚拟环境宿主机纳入实时图谱；快照持久化到盘面，支持结构标注编辑。 |
| `server/runner.ts` Python 探测与执行边界 | **重构增强** | 优先探测 `/tmp/p2_venv/bin/python` 等隔离科学虚拟环境；保留快速同步通道的同时，在 `server/workbench.ts` 引入受控 `AsyncJob` 异步作业器（超时预算、无缓冲实时日志、可取消、落盘溯源）。 |
| 四标签单透镜工作流 (`App.tsx` + `ExperimentWorkspace.tsx` 硬编码布局) | **重构为研究驱动工作台** | 重组为 4 个贴合真实科研活动的空间：**研究工作台**、**产物与对比**、**组件与工作流**、**架构地图**。 |

### 2. 核心领域模型（面向通用科研工程演化）

- **来源分级（Epistemic Provenance Tier）**——杜绝把外部批处理或静态图误标为工作台原生运行：
  - `historical_migrated`：由 Stage A1 迁移自 P1 历史账本（如 `run-001`, `run-002`）。
  - `external_verified_import`：由独立科研目录 `experiments/p2_flagship/` 真实脚本产出的外部已验证产物，经 SHA-256 索引接入工作台。
  - `workbench_native`：在 OpenLab Bench 工作台内由受控 Runner / Python / Node 子进程直接执行、采集日志并生成产物的原生探索。
- **核心实体**：
  - `ResearchStudy`：统一的研究入口（问题陈述、演化中的目标与多阶段验收准则、未决问题、当前采纳路线、阶段时间线）。支持自由创建开放新课题，不必预设光学结构。
  - `StudyBranch`：研究分支/候选方案（如 `S0_bare_rc`、`S1`–`S4`、或用户派生分支），记录方法路线、参数处方、核心指标、状态（`adopted` / `candidate` / `baseline` / `forked_exploration`）及来源分级。
  - `WorkflowExecution` & `ArtifactRef`：一次执行可产出多类异构产物（光学处方 JSON、多视场 Strehl/MTF、FITS 图像、SEP/Photutils 星表、公差 MC 统计表），每项产物带 64 位 SHA-256 指纹与真实文件路径。
  - `AsyncJobRecord`：受控异步执行作业（超时预算、实时逐行 stdout 日志、进度、取消控制与失败留痕）。
  - `EpistemicNote`：AI 与人共用的结构化研究脉络条目，显式拆分为 **事实 / 判断 / 假设 / 提议**，并支持附带可直接载入执行的 `proposedAction`。

---

## 四、分阶段实施路线图

- **阶段 1（本次垂直切片落地）**：
  - 打通 `WF-RC-1000` 完整研究入口 + Stage 1–5 历程 + `S0–S4` 多分支对比 + 显式采纳 + FITS 二进制/WCS/星表交互检查 + 基于 `/tmp/p2_venv/bin/python` 的真实光学公差扰动与 FITS 重提取异步派生执行 + AI 事实/假设/提议协作 + 动态架构地图与快照持久化；同时 100% 兼容 P1 既有运行与测试。
- **阶段 2（多模态科学工作流扩展）**：
  - 接入 `experiments/p2_flagship/` 规划中的 **Task 2（离轴无遮拦 TMA + 矢量一阶求解器）** 与 **Task 3（光栅光谱仪 2D 光谱提取）**；在工作台内支持用户图形化连线组合多阶段 Artifact DAG，并在沙箱资源配额下支持多分支并行探索。
- **阶段 3（跨工程工具生态与可复现分发）**：
  - 支持外部仪器数据（真实天文观测帧 / 干涉仪面形 Zernike CSV）导入比对、工作流模板导出为独立可复现实验包、以及多 Agent 分工协同（假设生成 / 反面审查 / 独立交叉验证）。

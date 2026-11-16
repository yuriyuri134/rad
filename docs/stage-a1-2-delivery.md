# OpenLab Bench Stage A1.2 交付说明

> **阶段定位**：本文档总结 **Stage A1.2（A1.2.0 不可变源码内容寻址存储与安全执行加固 + A1.2.1 真实历史工作区幂等迁移、崩溃恢复与映射契约固化）** 的实际实现、测试验证、构建检查、完整 SHA-256 指纹清单及尚存缺口与风险。  
> **阶段边界**：当前交付严格收敛在 Stage A1 基础设施与历史数据迁移层面，**尚未进入 Stage B / C / D**（Research Map 交互图谱、Branch 操作路由与前端工作台重构仍待后续阶段推进）。

---

## 一、五项核心加固与工程落地

### 1. CAS 对象篡改与缺失检测、恢复与降级策略（A1.2.0）
- **内容寻址存储（CAS）**：所有 `frozen` 版本在冻结时均将其主入口源码及相对依赖文件按完整 64 位小写 SHA-256 摘要写入 `workspace/immutable_store/sha256/<sha256>`。
- **读取与诊断分层（`server/storage.ts`）**：
  - `inspectCasBlob(expectedHash, workspaceDir)`：无异常抛出地返回 CAS 状态（`valid` / `missing` / `corrupted` / `unpinned`），用于在组件档案与工作台诊断中如实暴露 `casIntegrityStatus` 与 `casTamperDetected`，避免清单接口崩溃。
  - `readCasBlob(expectedHash, workspaceDir)`：严格校验实际字节 SHA-256 与预期 `immutableBlobHash` 是否一致；若 CAS 对象字节被篡改则立即抛出错误，**缺失返回 `null`，篡改直接拒绝**。
- **执行侧校验策略（`server/runner.ts` `resolveAndAssertApproved`）**：
  - 对于已固定 `immutableBlobHash` 的 `frozen` 版本，执行前**优先校验 CAS Blob**。即使磁盘工作区副本仍然完好，一旦 CAS 对象本身被篡改，也**绝不静默掩盖或回退到磁盘**，直接报错阻断执行；
  - 仅当 CAS 对象缺失（`null`）且磁盘工作区文件完整匹配已固定的 `codeHash` 时，才允许回退读取经哈希校验的磁盘副本；若磁盘亦不匹配或缺失，则阻断执行。
- **工作区恢复（`restoreFrozenComponentWorkspaceFile`）**：
  - 从经 `readCasBlob` 验证的 CAS 不可变对象同时恢复主入口文件与全部 `pinnedRelativeDeps` 到 `workspace/components/<id>/<version>/`，保留可编辑 `draft` 目录不受影响；若 CAS 对象已损坏或缺失则拒绝恢复。

### 2. Frozen 组件相对依赖固定与 TOCTOU-Free 内存执行（A1.2.0）
- **构建/冻结期相对依赖发现与固定（`server/storage.ts`）**：
  - `discoverLocalRelativeDependencies` 对组件版本目录内的 ESM 相对导入（`./*`、`../*`）进行广度优先扫描（BFS），计算每个本地相对依赖的 `codeHash` 与 `immutableBlobHash` 并固化为 `ComponentVersionRecord.pinnedRelativeDeps`；
  - **路径逃逸拦截**：任何未在组件 `dossier.dependencies` 中显式声明的 `../` 越界相对路径立即抛出 `组件相对依赖越界`；缺失文件抛出 `组件相对依赖缺失`；
  - **宿主机核心模块白名单**：`resolveAllowedHostModuleImport` 仅放行组件档案 `dependencies` 中显式声明为 `{ kind: 'module', targetId: 'src/core/*' }` 的宿主机模块（例如 `solver-ts-preview@v0.1` 对 `../../../../src/core/optics.ts` 的引用），将其固定在 `verifiedHostModules` 中，不污染组件本地 `pinnedRelativeDeps`。
- **无盘 TOCTOU 内存模块树编译与执行（`server/runner.ts` + `server/mjs_harness.mjs`）**：
  - `resolveAndAssertApproved` 一次性完成主入口、全部 `pinnedRelativeDeps` 及 `verifiedHostModules` 的 SHA-256 校验，并将已校验字节直接传入子进程 `mjs_harness.mjs`；
  - `compileVerifiedModuleTree` 自底向上将组件局部依赖树重写并内联编译为 `data:text/javascript;base64,...` ESM URL（支持 DAG 单例复用与循环依赖检测），执行期**完全不再触碰磁盘上的组件相对依赖文件**，阻断校验后至执行前的 TOCTOU 替换攻击；
  - `resolveDeclaredHostModuleUrl` 在 harness 内对声明的 `src/core/*` 宿主机模块同样校验 SHA-256，并在子进程内阻断一切未声明的 `../` 越界加载。

### 3. 迁移异常回滚与进程崩溃恢复的机制区分（A1.2.1）
| 维度 | 迁移异常回滚（In-Process Exception Rollback） | 进程崩溃恢复（Durable Crash Recovery Journal） |
| :--- | :--- | :--- |
| **触发场景** | `migrateWorkspaceToStageA1` 执行过程中抛出同步 JS / I/O 异常（测试钩子：`simulateCommitFailureAfterFiles`） | 迁移进程在提交窗口遭遇 `SIGKILL` / 断电 / 强制中止，跳过 `catch` 块（测试钩子：`SimulatedProcessCrashError` + `simulateCrashWithoutRollbackAfterFiles`） |
| **持久化凭证** | 内存 `rollbackActions` + 临时备份目录 | `.migration_tmp/<migrationId>/journal.json`（`phase: 'preparing' \| 'committing' \| 'committed'`）+ `.migration_tmp/<migrationId>/rollback/` 原始文件快照 |
| **恢复时机** | 当次调用 `catch` 块内立即同步反向恢复 | 下次服务启动（`server.ts` `startServer()`）或下次调用 `migrateWorkspaceToStageA1` 入口时，先执行 `recoverInterruptedMigrations(workspaceDir)` |
| **状态清理** | 恢复后清理 `.migration_tmp/<migrationId>` 并向上抛出错误 | - `preparing`：仅清理 `.migration_tmp/<migrationId>`（尚未写入正式目录）<br>- `committing`：按 `journal.targets` 反向恢复/删除已写文件，再清理临时目录<br>- `committed`：仅清理残留 `.migration_tmp/<migrationId>` |
| **已验证保障边界** | 通过同步 `atomicWriteFileSync`（临时文件写后 `renameSync`）保证单文件替换原子性 | 未对父目录调用底层 `fs.fsyncSync`，极端硬件断电下的元数据持久性仍依赖操作系统文件系统默认行为（已在风险中如实列明） |

### 4. 历史迁移映射契约固化与 `snap-002-before` 独立根节点处理（A1.2.1）
- 在 `server/a1_migrate.ts` 导出不可变契约常量 `LEGACY_MIGRATION_MAPPING_SPEC`（`contractId: "openlab-stage-a1-legacy-migration-v1"`），并在迁移产出中确定性地写入 `workspace/migration_a1_manifest.json`（不含易变时间戳，确保重复运行字节级幂等）。
- **关键固化规则**：
  1. **`snap-002-before` 独立根节点**：尽管旧记录 `run-002.parentRunId === "run-001"`，但 `run-001` 为 **2 表面 N-BK7 单透镜**，而 `run-002.systemBefore` 切换为 **3 表面 N-BK7 / N-SF11 双胶合预设**，二者不存在可验证的参数继承谱系；契约固化 `snap-002-before` 的 `rootKind: "independent_root_node"`、`parentSnapshotId: null`，同时保留 `legacyParentRunId: "run-001"` 作为历史线索。
  2. **分支基线保守原则**：`branch-main-singlet` 的 `base/head` 均指向 `snap-001`（`adoptedRunIds: ["run-001"]`）；`branch-b-doublet` 的 `base/head` 均停留在 `snap-002-before`（`adoptedRunIds: []`，`unadoptedRunIds: ["run-002"]`），`snap-002-after`（来自 `run-002.systemAfter`）仅作为未采用候选存在，不自动推进分支 `headSnapshotId`。
  3. **历史哈希漂移与缺失诚实保留**：
     - `eval-rms-spot@v0.1`：冻结至 CAS，保留 `sourceAvailability: "historical_hash_drifted"`，并记录 `run-001` 中声明的历史哈希 `a3b03826e7ce6dccbaac59ab5eb8f46b479bbd41b3ce7a3817f66939ce062b55` 与当前磁盘哈希 `0b2d535914f6e07f262e4421f48c91e0fbb78d912360c5b20e7bf9ef66cb2f8b` 的差异；
     - `eval-rms-spot@v0.2`：保留为 `lifecycle: "draft"`、`sourceAvailability: "missing_on_disk"`、`immutableBlobHash: null`，严禁伪造或补造源码。
  4. **追加账本不重复展示**：`run_supplements.jsonl` 映射原始 5 条补充记录（区分 `initial_run_evaluation`、`post_hoc_reevaluation` 与 `standalone_analysis`），`hydrateRunsWithSupplements` 去重合并，原 `runs.jsonl` 保持只读零改动。

---

## 二、测试与构建验证记录

| 检查项 | 执行命令 / 工具 | 结果 | 关键指标 / 输出 |
| :--- | :--- | :--- | :--- |
| **全量单元测试** | `node --test server/a0_audit.test.ts server/a1_models.test.ts server/a1_2_0_cas.test.ts server/a1_migrate.test.ts server/runner.test.ts src/core/*.test.ts` | **通过 (24 / 24)** | `tests 24`, `pass 24`, `fail 0`, `duration_ms 3536.698805` |
| **前端与服务端构建** | `compile_applet` (`vite build`) | **通过** | `Build succeeded - the applet is compiled` |
| **TypeScript 类型检查** | `lint_applet` (`tsc --noEmit`) | **通过** | `Linting completed successfully ($ tsc --noEmit)` |
| **真实工作区迁移与幂等性** | `migrateWorkspaceToStageA1('workspace')` 连续执行两次 | **通过** | `res1.status = "migrated"`、`res2.success = true`、两次全局状态哈希 **100% 一致**；`.migration_tmp` 无残留 |
| **架构地图自检** | `buildArchitectureMap` 扫描迁移后 `workspace/` | **通过** | `51` 节点、`108` 条边；0 个篡改/损坏告警；仅 2 条预期 `info`（`opt-coordinate-refine` 未在历史 run 调用、`solver-optiland-python` 当前容器无 Python/Optiland） |

> 注：以上单元测试均在隔离临时目录运行，并在测试结束后清理临时工作区，未对真实 `workspace/` 产生测试污染。

---

## 三、真实工作区完整 SHA-256 指纹清单（64 位 Hex）

### 1. Stage A1 新增 / 迁移正式数据文件（`workspace/`）
| 相对路径 | 字节数 | 完整 SHA-256 指纹 |
| :--- | ---: | :--- |
| `research_objects.json` | 3,113 | `6b56d0166fac4319ff80744e27c95a361429cd399789a56d8cae430c45a896d1` |
| `snapshots.jsonl` | 12,016 | `8df69af732b1e5f4401b6e01fd8f97d43fd55fc0e16b220f9066d930cbbefa09` |
| `branches.json` | 2,180 | `9831d66b4006d4d298d7efa98f3818e179f4f2d9b38790a925c1c2528eefae63` |
| `architecture_snapshots.jsonl` | 1,939 | `853e8d2a5e8a4d55e2c9b32ee8c26e294bed7195f2a0a9e34961f04b5f028f2b` |
| `experiment_snapshots.jsonl` | 1,878 | `5391f3d8c326985d7009abda8b9989f23a76247d5d132be40f16e5935fe5fbfd` |
| `run_supplements.jsonl` | 7,618 | `d12a6f1d58fe3776a019f315f3f5632f3d62c1f1d85d3cd01d664f629e14701e` |
| `migration_a1_manifest.json` | 3,967 | `66a8f70d38490220c33d5fcacddbb06c3559cf7641245ec8ccd8bfb2bdfad0ba` |

### 2. CAS 不可变源码对象（`workspace/immutable_store/sha256/`）
迁移共计冻结 `5` 个已引用组件版本，写入 `5` 个 CAS Blob（所有 Blob 名称均与实际内容 SHA-256 完全匹配）：

| CAS 对象（完整 SHA-256 文件名 / 摘要） | 字节数 | 对应组件版本 |
| :--- | ---: | :--- |
| `0b2d535914f6e07f262e4421f48c91e0fbb78d912360c5b20e7bf9ef66cb2f8b` | 3,062 | `eval-rms-spot@v0.1/impl.mjs` |
| `5222c23021279fa26be7f223e670ebaeac96d5cd36f20abfa86a460a575f233a` | 4,078 | `opt-nelder-mead@v0.1/impl.mjs` |
| `7a774ada741ad3514df3245805a0562f37c2b7a4274b0e3698f258f54ab9de52` | 1,030 | `solver-ts-preview@v0.1/impl.mjs`（含声明宿主机模块依赖 `src/core/optics.ts`） |
| `cd2ebd44bea79fbfe686a44281294f6a36212c4fbc7c095fce3c8f92ccb18383` | 2,485 | `analysis-aberration-summary@v0.1/impl.mjs` |
| `d6da83ab37f142a720ab210574dec9f9607e08c5f8642557c4b46b73c0bbbc00` | 3,679 | `eval-mtf-chromatic@v0.1/impl.mjs` |

### 3. 历史只读与原有组件源码文件（与 `pre-stage-a-2026-11-16T21-11-22-683Z` 备份 100% 字节级一致）
共核对 `11 / 11` 个非 dossier 原有工作区文件（零改动）：

| 相对路径 | 字节数 | 完整 SHA-256 指纹 | 与 Pre-Stage-A 备份一致 |
| :--- | ---: | :--- | :---: |
| `runs.jsonl` | 115,246 | `698ff3e99c846a050abb559620c3602f4e8af65bcd3e4688739b031e9e35b42d` | 是 |
| `thread.jsonl` | 3,277 | `cc80ac9f02d4eededf18970bbf475d8efefce019e945ff31c082e09e60e6439a` | 是 |
| `components/analysis-aberration-summary/v0.1/impl.mjs` | 2,485 | `cd2ebd44bea79fbfe686a44281294f6a36212c4fbc7c095fce3c8f92ccb18383` | 是 |
| `components/arch-map-engine/v0.1/impl.mjs` | 1,057 | `c88b0eb8f22225eb579c8e74e3a08439015a38ada10b03cee12c74f8de4906d8` | 是 |
| `components/eval-mtf-chromatic/v0.1/impl.mjs` | 3,679 | `d6da83ab37f142a720ab210574dec9f9607e08c5f8642557c4b46b73c0bbbc00` | 是 |
| `components/eval-rms-spot/v0.1/impl.mjs` | 3,062 | `0b2d535914f6e07f262e4421f48c91e0fbb78d912360c5b20e7bf9ef66cb2f8b` | 是 |
| `components/fits-photometry-reader/v0.1/readme.txt` | 168 | `c3f2aa7773644dba11929048641c3b1bc758edb202c3ee10d93c5a22fc81eb97` | 是 |
| `components/opt-coordinate-refine/v0.1/impl.mjs` | 3,178 | `cbc88d33eed5ab847051b4bb5c8a5c7a1418b77640f11939f537aea6fce2eca4` | 是 |
| `components/opt-nelder-mead/v0.1/impl.mjs` | 4,078 | `5222c23021279fa26be7f223e670ebaeac96d5cd36f20abfa86a460a575f233a` | 是 |
| `components/solver-optiland-python/v0.1/impl.py` | 496 | `15a4ce1a973048d9446cfbe68637db61e6ea60c6dd29a63e5f6385e7a38b749a` | 是 |
| `components/solver-ts-preview/v0.1/impl.mjs` | 1,030 | `7a774ada741ad3514df3245805a0562f37c2b7a4274b0e3698f258f54ab9de52` | 是 |

---

## 四、尚存缺口、风险与不确定性

1. **宿主机依赖缺口（Python / Optiland 缺失）**：当前运行容器检测结果为 `Python=none, Optiland=none`，因此 `solver-optiland-python` 无法在本机真实执行专业光学求解，只能返回真实环境不可用报告；跨环境验证仍需在具备 Python >= 3.11 + `optiland` 的机器上补做。
2. **历史遗留源码与哈希漂移不可逆**：
   - `eval-rms-spot@v0.1` 在 `run-001` 时记录的哈希（`a3b03826e7ce6dccbaac59ab5eb8f46b479bbd41b3ce7a3817f66939ce062b55`）与现存磁盘源码（`0b2d5359...`）不一致，原始旧版源码已无法追溯找回，当前 CAS 冻结的是现存磁盘版本并已标注 `historical_hash_drifted`；
   - `eval-rms-spot@v0.2` 的历史源码缺失（`missing_on_disk`、`immutableBlobHash: null`），无法凭空恢复，仅支持从现有可读取版本 Fork 新建 `draft`。
3. **文件系统崩溃持久性边界**：`atomicWriteFileSync` 与 `journal.json` 使用同分区临时文件 + `renameSync`，可防御进程级 `SIGKILL` 或异常中断；但尚未对父目录显式执行 `fs.fsyncSync` 刷盘屏障，在宿主机内核断电丢失未落盘元数据缓存的极端场景下仍存在文件系统依赖边界。
4. **运行隔离边界说明**：`mjs_harness.mjs` 通过 `execFile` 独立子进程 + 内存 `data:` URL 编译 + 哈希校验避免 TOCTOU 与隐式 `../` 模块加载，但 `execFile` 仍属于进程级隔离而非操作系统级沙箱（未引入 seccomp / 容器网络文件系统隔离，组件如主动调用宿主机 `fs`/`child_process` 仍受 Node 进程权限限制）。
5. **后续阶段待建范围（Stage B / C / D）**：
   - 尚无 Research Map / Branch / ResearchObject / Snapshot 对应的 Express API 路由与前端交互视图；
   - `ComponentLab` 与 `ArchitectureMap` 前端展示尚待接入 `casIntegrityStatus`、`casTamperDetected` 与 `pinnedRelativeDeps` 诊断详情；
   - Domain Adapter 多学科抽象（如天文测光真实组件落地）尚未进入实际构建。

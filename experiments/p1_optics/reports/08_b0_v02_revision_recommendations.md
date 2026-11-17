# B0 v0.2 融合修订建议（基于 P1 实证）

以下建议全部源自 P1 真实运行 `Optiland 0.6.3` 与独立物理审查的一手证据，不凭空扩张架构。

---

## 一、必须修改（阻塞真实科研可靠性与后续 B1 落地）

1. **统一“运行器可配置解释器 + 优化器健康诊断字段”**：
   - 支持通过配置/环境变量指定 Python 解释器路径（而非硬编码 `'python3'`），让工作台能直接接通隔离的 Python 3.11+ 环境；
   - 优化型组件的输出契约必须包含 `nfev`、`initialLoss`、`finalLoss`、`parameterDelta`，并禁止把 `success=True && nfev<=1 && delta==0` 误判为优化完成。
2. **修复并固化光学求解契约中的物理基准字段**：
   - `OpticalSystemSpec` 与求解结果必须显式携带 `focusRule`（如 `on_axis_d_paraxial` vs `locked_fixed_bfl`）、`fixedBflMm`、玻璃目录来源（如 `schott`）及每面 `semiApertureMm`；
   - 求解输出支持多视场 × 多波长结构化矩阵、各视场主光线与畸变、渐晕/遮拦计数（基于光强 `i <= 0` 与 `NaN` 联合判定），以及明确标注 `domain`（几何 vs 衍射）。
3. **收敛唯一事实来源与不可变哈希边界**：
   - `ExecutionRecord` 仅把启动上下文纳入不可变哈希；所有事后归属、采纳、重评均作为独立边/补充记录追加，不改写原记录；
   - 明确“更新基线类 `Adoption`”必须同步指向有效 `ResearchSnapshot`，避免与 `Branch.headSnapshotId` 出现双真相。
4. **明确探索期轻量执行通道 vs 强契约门禁分层**：
   - 允许探索期脚本以 `experimental` 宽松端口（JSON/文件路径）直接跑通并留痕，仅在进入正式基准对比或组件发布复用时强制要求完整 `ComponentPort` 契约。

---

## 二、值得修改（显著提升科研可用性与跨领域复用性）

1. **打平执行模型为单层 DAG，精简 `ArtifactEnvelope`**：
   - 在 `ExecutionRecord` 顶层使用 `parentExecutionIds` 与 `relationType`（如 `diagnostic_retry`、`material_branch`、`focus_sensitivity`）串联谱系，取消内部嵌套 `steps[]` DAG；
   - 将 `units` 和 `coordinateFrame` 从 `ArtifactEnvelope` 顶层移入载荷元数据，避免非物理产物（脚本、评价结论）强行填伪字段，并补充 `storageMode` 与 `availabilityStatus`。
2. **在 `ComponentPort` 增加 `modelFidelity / capabilityTags`**：
   - 明确区分 `ts_preview`（有限球面预览）、`optiland_geometric`（几何追迹/几何 MTF）与未来的 `wave_optics_psf`，防止端口语法兼容但物理模型失配。
3. **升级 `python/optiland_bridge.py` 对齐 Optiland 0.6.3 实测 API**：
   - 修复 `SpotDiagram.rms_spot_radius()`、`GeometricMTF(wavelength=...)`、`rms_spot_size(surface_number, Hx, Hy, ...)`、关闭强制 `image_solve()` 的固定像面分支，并规避 `edge_thickness` 返回 shape `(1,)` 数组的 NumPy 2.x 兼容陷阱。

---

## 三、暂时不需要修改（避免过度设计，保持克制）

1. **不需要为 `ResearchObject` 增加独立多版本树**：
   - P1 实证表明，阶段性目标、判据与选中系统的冻结完全可以由 `ResearchSnapshot` 承担，不必再加一层版本对象。
2. **不需要为 `ArchitectureMap` 增加额外元模型层级**：
   - 维持现有有限一步自指描述即可。
3. **暂不需要合并 JS 黑盒优化器与 Python 原生 `LeastSquares`**：
   - 两者工作机制与约束表达能力差异很大（JS 走无梯度评价回调，Python 走进程内残差向量），强行统一接口在当前只会制造低效胶水层，按原计划留待 B2/后续按需评估即可。

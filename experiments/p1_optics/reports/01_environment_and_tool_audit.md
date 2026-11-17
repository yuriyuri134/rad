# 环境与工具审计报告（P1 第一步实测记录）

## 1. 宿主与隔离 Python 环境审计
- **容器默认 Python**：`/usr/bin/python3` 为 `Python 3.10.12`，无 `pip`，无 `numpy`、`scipy`、`optiland`，不满足 `pyproject.toml`（`requires-python >= 3.11`, `optiland >= 0.5.8`）。
- **独立隔离虚拟环境（未改动项目默认环境）**：
  - 使用独立安装于 `/tmp/p1_uv` 的 `uv 0.13.8` 在 `/tmp/p1_venv` 建立 `CPython 3.12.16` 环境；
  - 实装版本：`optiland==0.6.3`、`numpy==2.5.5`、`scipy==1.18.1`、`numba==0.68.1`、`matplotlib==3.11.2`。

## 2. 既有组件与 `python/optiland_bridge.py` 实测缺陷
直接用 `/tmp/p1_venv/bin/python` 运行既有 `python/optiland_bridge.py --check` 当场报错崩溃（`TypeError: SpotDiagram.rms_spot_radius() got an unexpected keyword argument 'field_index'`）。经对照 `optiland==0.6.3` 源码，确认以下真实问题：
1. `SpotDiagram.rms_spot_radius()` 无参数，返回 `[field][wavelength]` 二维列表。
2. `GeometricMTF.__init__` 接受单数 `wavelength=` 而非 `wavelengths=`，且内部仅支持单波长。
3. `--optimize` 中 `rms_spot_size` 传入了不存在的 `field_number=0`，真实签名为 `(optic, surface_number, Hx, Hy, num_rays, wavelength, ...)`。
4. `build_optiland_system()` 无条件调用 `updater.image_solve()`，违背固定像面评价原则；硬编码 `is_stop = idx == 1`，忽略 `semiApertureMm`，仅导出 `field_index=0`。
5. `Material("F2")` 跨库匹配默认解析到 `hikari` 而非 `schott`，必须显式传 `catalog="schott"`；`Material.n(wl)` 返回 shape `(1,)` 数组，在 `numpy 2.5.5` 下必须 `.item()` 标量化。
6. `Optiland 0.6.3` 中 `RadialAperture` 切光信号为 `rays.i <= 0` 而非 `NaN`，且 `Optic.add_surface` 等旧方法已标记为 v0.7.0 废弃。
7. `LeastSquares._compute_residuals_vector()` 在 `edge_thickness` 违反 `min_val` 返回 shape `(1,)` 数组时抛出 `inhomogeneous shape` 异常并被 `except` 吞掉，导致 `scipy` 返回 `nfev=1, success=True` 假成功。

## 3. JS 优化器 vs Python 原生优化器实测对比
- **JS 优化器**（`opt-coordinate-refine` / `opt-nelder-mead`）：无梯度黑盒搜索，每次迭代通过子进程重起 Python Bridge，冷启动开销高且无边界/边缘厚度解析约束支持，当前 `server/runner.ts` 硬编码 `'python3'` 会落回 Python 3.10。
- **Python 原生优化器**（`OptimizationProblem` + `LeastSquares`）：同进程调用 SciPy `lm`/`trf`，支持 `f2`、`rms_spot_size`、`LchC_sum`、`edge_thickness` 等约束，但必须人工平衡量纲权重并严防操作数返回非标量导致的“静默假成功”。

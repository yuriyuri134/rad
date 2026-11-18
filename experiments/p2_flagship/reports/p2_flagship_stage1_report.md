# P2 旗舰科研工程实践（第一阶段）：宽视场天文成像系统 `WF-RC-1000` 全链路验证与 OpenLab Bench 架构适配性审计报告

- **工作目录（隔离区）**：`experiments/p2_flagship/`
- **正式仓库保护**：`src/`、`server/`、`python/optiland_bridge.py`、`workspace/`（含 `workspace/runs.jsonl`）、`package.json` **零修改**（注：当前工作区未包含 `.git` 目录，已通过只读检查核实上述目录及 `workspace/runs.jsonl` 保持原样）。
- **工具链实测版本**（`experiments/p2_flagship/audits/audit01_package_inventory.json`）：
  `optiland==0.6.3`、`numpy==2.5.5`、`scipy==1.18.1`、`astropy==8.0.2`、`sep==1.4.1`、`photutils==3.1.1`（运行于隔离虚拟环境 `/tmp/p2_venv`，由 `experiments/p2_flagship/scripts/ensure_env.sh` 幂等保障）。
- **认识论标注规范**：本报告严格区分 **【事实】**（已由磁盘脚本、实测运行、日志与 JSON/FITS 产物直接验证）、**【判断】**（基于已验证事实形成的工程与物理结论）、**【假设】**（尚未经独立实验闭环验证的可能性）、**【提议】**（下一步可执行方案）。

---

## 一、Optiland 0.6.3 真实能力边界核实（Audits 01–05）

本轮对 Optiland `0.6.3` 进行模块化、无缓冲独立实测，推翻了此前“0.6.3 不存在图像模拟”的误判，并精确定位了离轴系统与公差模块失效的底层机理。

### 1. 模块盘点与 `ImageSimulationEngine` 核实（`audit01`, `audit05`）
- **【事实】** `optiland.analysis.image_simulation` 模块在 `optiland==0.6.3` 中真实存在，导出 `ImageSimulationEngine`、`DistortionWarper`、`PSFBasisGenerator`、`SpatiallyVariableSimulator`（直接导入 `optiland.image_simulation` 或 `optiland.simulation` 会报 `ModuleNotFoundError`）。
- **【事实】** `ImageSimulationEngine` 在 `RC_Plus_2Lens_Corrector`（默认策略 `4.561 s`；`CentroidReferencePoint` 策略 `2.384 s`）和 `OffAxis_TMA`（`psf_strategy="best_fit"` + `CentroidReferencePoint`，`1.397 s`）上均成功运行，输出 `[1, 3, 128, 128]` 张量（`audit05_image_simulation.json`）。其配置键名为 `"wavelengths"` 而非 `"wavelength"`。
- **【事实】** 在 Stage 3 中对 `S3_3Lens_Wynne_FS_QuasiRC` 实测 `ImageSimulationEngine`（`2.47 s`，输出 `[1, 3, 96, 96]`），其内部 `FFTPSF` 采样间距为 `2.424 um/px`，而物理 CCD 像元为 `15.0 um/px`，且模块不生成天球 TAN WCS 头文件或光子/读出噪声统计（`stage3_fits_astrometry.json`）。

### 2. 离轴 TMA 与共轴折反系统能力边界（`audit02`, `audit02b`）
- **【事实】** 在测试用 `OffAxis_TMA`（三面离轴反射镜 `rx=8°, -10°, 6°; dy=80, -40`）上：
  - **可执行**：真实光线追迹 `optic.surfaces.trace`（`0.3991 s`，271 条光线）；`SpotDiagram`（`0.0534 s`）；`Wavefront(strategy="centroid"|"best_fit")`（`0.0469 s` / `0.0470 s`）；`FFTPSF(strategy="centroid"|"best_fit")`（`0.0224 s` / `0.0182 s`）；`MMDFTPSF(num_rays>=32)`（`audit02b`，`shape=[64,64]`）；`ImageSimulationEngine`（`best_fit`）。
  - **报错 `UnsupportedParaxialGeometryError`**：`paraxial.f2/FNO`、`Wavefront/FFTPSF(strategy="chief_ray")`、`HuygensPSF`、以及全部 MTF 类（`GeometricMTF`、`FFTMTF`、`HuygensMTF`）。Optiland 明确报错指出原因：`[OBLIQUE_POWERED_MIRROR]` 与 `[NONCOLLINEAR_VERTEX_CHAIN]` 超出了标量折叠近轴域（scalar folded paraxial domain），需一般矢量近轴模型（general vector paraxial model）。
- **【事实】** 在 `Coaxial_Biased_TMA`（同轴偏置光阑/视场 TMA）与 `RC_Plus_2Lens_Corrector` 上：近轴 `f2/FNO`、`Wavefront` 全策略、`FFTPSF`、`HuygensPSF`、`GeometricMTF`/`FFTMTF`/`HuygensMTF` 均全部成功（`audit02_tma_and_psf_boundaries.json`）。
- **【事实】** `0.6.3` API 漂移：`Distortion` 接收 `wavelengths=[...]` 与 `method="nonparaxial"`（不再支持 `wavelength=` 或 `reference_point=`）；`EncircledEnergy` 不接受 `num_rings=` 且对象无 `.ee` 属性（`audit02b_deep_checks.json`）。

### 3. 公差分析与光谱/天测生态核实（`audit03`, `audit04`）
- **【事实】** Optiland `0.6.3` 内置 `optiland.tolerancing` 在反射/折反系统与离轴系统上均失效（`audit03_tolerancing_boundaries.json`）：
  - `MonteCarlo` 在 `RC_Corrector` 与 `OffAxis_TMA` 上均抛出 `UnsupportedParaxialGeometryError: set_thickness mutates surface positions along global z only...`（遇到折叠反射路径即拒绝修改厚度）。
  - `SensitivityAnalysis` 在 `RC_Corrector` 上传入 `DistributionSampler` 报 `ValueError: Only range samplers are supported.`，在 `OffAxis_TMA` 上同样触发 `set_thickness` 全局 `+z` 限制报错。
- **【事实】** `surface_type="grating"`（`plane_grating` / `standard_grating`）成功完成光栅色散追迹（`period=1.667 um`, `order=1`, `0.45/0.55/0.65 um` 衍射角 `-46.93° / -51.07° / -55.45°`，耗时 `2.395 s`）。
- **【事实】** `Astropy 8.0.2` FITS + TAN WCS + `Photutils 3.1.1 DAOStarFinder` + `SEP 1.4.1` 链路跑通（`0.187 s`，`audit04` 合成测试场质心残差 `0.008–0.052 px`）。

- **【判断】** Optiland `0.6.3` 并不是“不能做离轴 TMA 或图像模拟”，而是**物理引擎与高层分析封装之间存在断层**：真实 3D 光线追迹与基于质心/最佳拟合参考球面的波前、`FFTPSF`/`MMDFTPSF`、`ImageSimulationEngine` 已完整可用；但依赖标量近轴模型或全局 `+z` 厚度假设的模块（`chief_ray`、MTF、`HuygensPSF`、内置 `tolerancing`）会在折叠反射/离轴曲面处阻塞。通过外部坐标变换、矢量特征求解器及自主 Monte Carlo 驱动，可以绕过内置封装限制并获得可信物理结果。

---

## 二、旗舰任务选型理由与三阶段科研路线图

- **【事实】** P1 阶段验证了基础 100 mm 双胶合透镜，处于 Optiland 官方教程入门难度附近。本阶段采用“单期深耕 + 能力已核实的演进路线图”：
  1. **Task 1（本阶段已完成端到端闭环）：`WF-RC-1000` 宽视场 Ritchey-Chrétien 天文成像系统**
     - 口径 `D = 1000 mm`、目标焦距 `EFL = 6000 mm`（`f/6.0`）、波段 `0.45–0.80 um`（`0.45, 0.55, 0.65, 0.80 um`）、视场 `±0.60°`（直径 `1.20°`，像面半径 `~63 mm`）、探测器 `15 um` 像元（`0.5157"/px`）。
     - **选型理由（【判断】）**：该问题既具备真实天文仪器工程复杂度（中心遮拦衍射、主次镜双曲面构型、近焦面多片折射场镜、畸变与天球 WCS 耦合、装调公差补偿耦合），又避开了缺乏可复算初始公开处方的陷阱，且允许完整使用 Optiland 全套光学评价（波前、FFT/Huygens PSF、MTF、几何畸变）并与独立理论（Seidel、ABCD 矩阵、Astropy/SEP）交叉验证。
  2. **Task 2（已完成前置能力审计，待确认后启动）：深紫外-近红外无遮拦高对比度离轴 TMA（`180–900 nm`）**
     - 检验架构如何在 `Optiland` 标量近轴/MTF/公差全面报错时，自动切换为外部矢量一阶求解器 + `Wavefront(best_fit)`/`FFTPSF`/`MMDFTPSF` 自定义评价闭环。
  3. **Task 3（已完成核心光栅追迹审计，待确认后启动）：望远镜耦合天文光栅光谱仪（`R ~ 2000–3000`, `400–700 nm`）**
     - 从成像系统跨入色散光谱仪器，生成 2D 光谱 FITS 与氩/氖定标弧灯谱线提取波长解。

---

## 三、`WF-RC-1000` 全链路实验结果（Stages 1–5）

### Stage 1：解析 RC 基线与像差诊断（`runs/S0_bare_rc.json`）

- **【事实】** 由三阶消像差 RC 解析方程推导的 `S0_bare_rc` 处方：
  - `D = 1000.0 mm`，`EFL = 6000.0 mm`（`F/6.0`），主镜 `F1 = 2.2`（`R1 = -4400.0 mm`, `K1 = -1.12838839`），主次镜间距 `d_M1_M2 = 1489.02439 mm`，次镜 `R2 = -2245.186136 mm`, `K2 = -6.22036543`，主镜后工作距 `450.0 mm`（M2 到焦面 `1939.02439 mm`）。
  - 由近轴边光线计算得中心遮拦最小半径 `182.179 mm`（线遮拦比 `36.44%`，面积遮拦比 `13.28%`）。
- **【事实】** Optiland 无遮拦 Seidel 检验验证：`SI = -0.0`（纯数值约 `2.1e-9`）、`SII = -0.0`（球差与彗差精确消除），`SIII = -0.012385`（像散主导）、`SIV = -0.011961`（Petzval 场曲）、`SV = 0.001274`（畸变）。
- **【事实】** `S0_bare_rc` 在轴上接近衍射极限，但在宽视场下因像散与场曲急剧恶化：
  - 多色 RMS 光斑半径：`0.00°: 1.213 um (0.0417")`，`0.25°: 28.845 um (0.9916")`，`0.42°: 83.147 um (2.8584")`，`0.60°: 170.740 um (5.8696")`（超过 `15 um` 像元 11 倍以上）。
  - 550 nm `FFTPSF` Strehl：`0.00°: 0.98774` -> `0.42°: 0.00337` -> `0.60°: 0.00290`（`HuygensPSF`：`0.60335 -> 0.00724 -> 0.00731`）。
  - 550 nm `FFTMTF @ 33.33 lp/mm`（Nyquist 频率）：`0.00°: 0.7791` -> `0.60°: 0.0061 (T) / 0.0022 (S)`。
  - 最大畸变仅 `0.01217%`。

### Stage 2：四分支场镜改正器多目标对比优化（`runs/S1_to_S4_correctors_v2.json`）

为了在 `450 mm` 后截距空间内校正 `±0.60°` 视场的像散、场曲与次级色差，并严格约束像元尺度下的畸变、边厚与 `EFL ~ 6000 mm`，本阶段独立设计并优化了 4 条结构分支（均采用无缓冲逐分支运行与独立 JSON 检查点）：

| 分支 ID | 结构与材料路线 | 优化成本 / EFL (mm) | 多色 RMS 光斑 (um) `[0°, 0.25°, 0.42°, 0.60°]` | 550 nm `FFTPSF` Strehl `[0°, 0.25°, 0.42°, 0.60°]` | `FFTMTF @ 33.33 lp/mm` 范围 | 最大畸变 (%) | 最小边厚 / BFL (mm) |
|---|---|---|---|---|---|---|---|
| **`S0_bare_rc`** | 裸双镜 RC（无折射场镜） | 基线 / `6000.000` | `1.213 / 28.845 / 83.147 / 170.740` | `0.988 / — / 0.003 / 0.003` | `0.0022–0.7791` | `0.01217` | `— / 450.00` (behind M1) |
| **`S1_2Lens_FS_RC`** | 2片全 Fused Silica，锁定 RC 圆锥系数 | `161.218` / `6012.697` | `3.433 / 2.979 / 4.713 / 3.853` (`0.102–0.162"`) | `0.699 / 0.714 / 0.454 / 0.709` | `0.5907–0.7728` | `0.89679` | `16.89 / 57.789` |
| **`S2_3Lens_Wynne_FS_RC`** | 3片全 Fused Silica Wynne，锁定 RC 圆锥系数 | `60.641` / `6007.695` | `2.476 / 2.582 / 3.221 / 3.068` (`0.085–0.111"`) | `0.865 / 0.777 / 0.787 / 0.856` | `0.7389–0.7578` | `0.40707` | `16.83 / 55.000` |
| **`S3_3Lens_Wynne_FS_QuasiRC`** (**胜出**) | 3片全 Fused Silica Wynne + **解锁主次镜圆锥系数** (`K1=-1.14865, K2=-6.46154`) | **`11.064` / `6001.598`** | **`0.944 / 0.922 / 1.048 / 1.063`** (`0.032–0.037"`) | **`0.982 / 0.945 / 0.854 / 0.908`** | **`0.7731–0.7813`** | **`0.34303`** | **`17.81 / 55.000`** |
| **`S4_3Lens_Wynne_FS_F2_RC`** | 3片混合玻璃 (`FS + F2 + FS`)，锁定 RC 圆锥系数 | `597.635` / `5987.006` | `9.254 / 5.659 / 7.899 / 9.704` (`0.195–0.334"`) | `0.076 / 0.346 / 0.246 / 0.275` | `0.2377–0.7105` | `0.35667` | `15.49 / 55.001` |

- **【事实】** 针对 `S3_3Lens_Wynne_FS_QuasiRC` 的 `HuygensPSF` 交叉验证（550 nm）：`0.00°: 0.59827`、`0.42°: 0.64150`、`0.60°: 0.62378`。需注意：`Optiland` 中 `FFTPSF.strehl_ratio()` 以含遮拦透过光瞳作归一化（`0.854–0.982`），而 `HuygensPSF.strehl_ratio()` 以无遮拦理想 Airy 盘作归一化（含 13.28% 面积遮拦系统的理论极限约 `~0.75` 量级），二者基准定义不同，不可直接混比。
- **【判断】** 4 条分支清晰揭示了物理自由度与像质/畸变之间的权衡边界：
  1. 两片式改正镜（`S1`）受限于自由度不足，虽能压低 RMS 至 `~3–4.7 um`，但在 `0.42°` 中视场出现 Strehl 凹谷（`0.454`）且边缘畸变高达 `0.897%`（角偏 `>19"`）。
  2. 全熔石英三片式 Wynne 结构（`S2`）凭借对称正-负-正光焦度分布自然实现宽波段消色差，但锁定标准 RC 的 `(K1, K2)` 使主次镜与改正镜之间残留高阶球差/彗差耦合。
  3. 解锁 `K1/K2` 成为 Quasi-RC（`S3`）后，改正镜与主次镜协同平衡残余球差、高阶彗差与像散，全视场 RMS 降至 `~1.0 um`（低于 1/14 像元）、全视场 `MTF@33.33` 稳定在 `0.773–0.781`，同时畸变降至 `0.343%`、所有透镜边厚 `>= 17.81 mm`、总后截距 `455.41 mm` 满足结构与制造可行性。
  4. 引入高色散火石玻璃 `F2`（`S4`）在有限评估预算下破坏了全石英对称 Wynne 的色差/球差平衡（`cost=597.635`），导致轴上 `Strehl` 跌至 `0.076`（同时需客观记录：`S4` 因单次耗时较长仅执行了 1 个种子、85 轮相关预算下 447 次函数评估，收敛深度浅于 `S1–S3` 的双种子优化）。

### Stage 3：端到端天文图像仿真、FITS WCS 与双管线星表还原（`runs/stage3_fits_astrometry.json`）

对 `S0–S4` 五套系统各生成 4 个偏置视场（`0.00°, 0.25°, 0.42°, 0.60°`）共 20 幅 `512×512` 标准 FITS 图像（采用 `Optiland FFTPSF` 多色核按视场方位旋转、结合实测光线追迹畸变偏移、叠加泊松光子噪声与 CCD 读出噪声，写入 IAU `RA---TAN / DEC--TAN` WCS）。

- **【事实】** `SEP 1.4.1` 提取结果对比（每视场 28 颗模拟星，SNR 覆盖亮星至暗端）：
  - **`S0_bare_rc`**：`0.00°` 完备率 `100.0%`（畸变后定位 RMS `0.0237"`，测光恢复 `0.9863`），但 `0.42°` 完备率骤降至 `50.0%`（定位 RMS `2.4855"`，孔径测光恢复跌至 `0.3388`），`0.60°` 仅检出 `1/28`（`3.6%`，FWHM 展宽至 `3.503"`，测光恢复 `0.0721`）。
  - **`S1_2Lens_FS_RC`**：`0.00°–0.42°` 完备率 `100.0%`，`0.60°` 为 `89.3%`；原始 TAN WCS 天测误差在 `0.60°` 达 **`19.2729"`**（对应 `721.22 um` 径向畸变）；扣除光学畸变多项式后残差降至 `0.0211"–0.0437"`，测光恢复 `0.9781–0.9831`。
  - **`S2_3Lens_Wynne_FS_RC`**：完备率 `92.9%–100.0%`，`0.60°` 原始 WCS 误差 `8.6847"`（`330.20 um`），畸变校正后 `0.0221"–0.0339"`，测光恢复 `0.9772–0.9851`。
  - **`S3_3Lens_Wynne_FS_QuasiRC`（胜出）**：`0.00°, 0.25°, 0.42°` 完备率均为 **`100.0%`**，`0.60°` 为 **`96.4%`**（27/28）；`0.60°` 原始 WCS 误差 `7.3838"`（`275.45 um`），畸变校正后全视场天测残差稳定在 **`0.0259"–0.0370"`**（约 `0.05–0.07 px`）；观测测得图像 FWHM 为 `1.387"–1.510"`（受 `15 um = 0.5157"/px` 像元盒状采样限制）；`r=4 px` 孔径测光通量恢复 **`0.9779–0.9866`**（弥散 `2.98%–4.31%`）。
  - **`S4_3Lens_Wynne_FS_F2_RC`**：`SEP` 完备率 `92.9%–100.0%`，畸变后定位 RMS `0.0237"–0.0401"`，但中值 FWHM 在轴上即扩至 `1.541"`。
- **【事实】** 发现显著的“光学采样—探测算法耦合现象”：在固定参数 `DAOStarFinder(fwhm=3.0 px, threshold=4.5*std)` 下，`Photutils` 在锐利的 `S3` 上完备率仅 `42.9%–67.9%`，而在光斑略弥散的 `S4` 上反而达到 `75.0%–100.0%`。对此在既有 `S3` `0.60°` FITS 上执行的只读敏感性核查证明：`DAOStarFinder` 在 `fwhm=3.0 / 2.2 / 1.8 / 1.5 px` 下的检出数分别为 `13 / 13 / 14 / 23` 颗。
- **【判断】** `S3` 在 `0.5157"/px` 探测器上处于轻度欠采样状态（光学 RMS 仅 `0.037"`），单星能量高度集中于 1–2 个像元，导致设定为 `fwhm=3.0 px` 的匹配高斯核因尖锐度（sharpness）门限漏检暗星，而基于局部连通域阈值分割的 `SEP` 与小 FWHM 参数才能保持高完备率。这直接证明：**成像质量的下游验证不能只看光学 RMS，必须纳入探测器采样率与天文提取算法匹配性。**

### Stage 4：制造/装调公差与双补偿策略对比（`runs/stage4_tolerancing.json`）

因 Optiland 内置 `tolerancing` 在反射折反系统上触发全局 `+z` 限制报错，本阶段编写独立 3D 坐标与非顺序增量扰动器对 `S3` 执行单因素灵敏度（OAT）与 40 次蒙特卡洛（MC）模拟。

- **【事实】** OAT 灵敏度与补偿对比：
  - 标称态：`max_rms = 1.079 um`，中心/边缘 `550 nm Strehl = 0.9967 / 0.9819`。
  - **`M1_R1 +1.5 mm`** 成为最敏感公差项：未补偿平均 RMS 恶化至 `353.687 um`；若**仅调整后焦距 BFL**（`-5.4754 mm`），虽可将 `max_rms` 拉回 `4.461 um`，但**边缘 Strehl 从 `0.9819` 跌至 `0.6160`**；若采用 **M2 轴向垫片微调（`-0.6591 mm`）+ BFL 精调（`-0.0026 mm`）**，则 `max_rms` 恢复至 **`1.221 um`**，**边缘 Strehl 回升至 `0.9855`**。
  - 次镜失调（`M2_tilt ±20"`、`M2_decenter ±0.05 mm`）使 `max_rms` 增至 `2.241 um` / `2.198 um`，且无法靠轴向 BFL 消除，构成非轴向装调主要误差源。
- **【事实】** 40 次全参数联合蒙特卡洛（`±1.5mm R1`, `±1.0mm R2`, `±0.05mm M1-M2`, `±20" M2 tilt`, `±0.05mm M2 dec`, `±0.10mm corr axial/dec`, `±60" corr tilt`, `±0.1% lens R`, `±0.05mm tc/gap`）：
  - **策略 A（仅 BFL `±12 mm` 调焦）**：`max_rms <= 7.5 um` 良率 `100.0%`（`p50=3.781, p80=4.693, p95=5.289 um`），但 `strehl_edge p50 = 0.8130`、`p20 = 0.6972`。
  - **策略 B（M2 垫片 `±0.8 mm` + BFL `±3 mm` 双补偿）**：`max_rms <= 7.5 um` 良率 `100.0%`，`max_rms` 分位数大幅收紧至 **`p50=2.070, p80=2.528, p95=3.086 um`**，`strehl_center p50=0.9645 (p20=0.9231)`，**`strehl_edge p50=0.9150 (p20=0.8428)`**。
- **【判断】** 在 RC+近焦场镜系统中，主镜曲率偏差（`R1`）改变主镜焦面位置，若只移动末端相机（BFL），会迫使光线在场镜内改变通光高度与共轭位置从而引入高阶像散与场曲；通过调整 M1–M2 镜距锁定改正镜入射共轭位置，才是保证宽视场均匀衍射极限良率的关键工程动作。

### Stage 5：独立数学与数据格式交叉核验（`runs/stage5_independent_verification.json`）

- **【事实】** 独立纯 NumPy `2×2 ABCD` 近轴传输矩阵（不调用 Optiland）与 Optiland `paraxial.f2()` 比对：
  - `S0`：`6000.000001 mm`（精确一致；M2 至焦面距离 `1939.024391` vs `1939.02439 mm`）。
  - `S1`：`6012.6933` vs `6012.697 mm`（差 `0.0037 mm`）；`S2`：`6007.6936` vs `6007.695 mm`（差 `0.0014 mm`）；`S3`：`6001.5951` vs `6001.598 mm`（差 `0.0029 mm`）；`S4`：`5987.0183` vs `5987.006 mm`（差 `0.0123 mm`）。同时验证 `S3` 最佳多色焦面相对近轴焦面有 `-0.0503 mm` 的最佳离焦补偿。
- **【事实】** 全部 20 个 FITS 文件头与像素数据审计通过：尺寸 `[512, 512]`，标准 `RA---TAN / DEC--TAN` 投影，像元比例 `0.5146–0.5168"/px`，全像素有限值（`finite_all=true`），动态范围 `~61.4–17692.0 ADU`。

---

## 四、用实践检验 OpenLab Bench 架构：三层问题解耦审计

通过强迫不迁就既有架构来完成 `WF-RC-1000` 全链路实验，对照只读审计的 `src/core/types.ts`、`server/runner.ts`、`python/optiland_bridge.py`、`src/core/fits.ts` 与 `workspace/components/*`，我们明确区分以下三类本质不同的限制：

### 1. Optiland `0.6.3` 外部物理软件本身的能力边界（非 OpenLab 设计问题）
- **【事实】** `paraxial`、`chief_ray`、MTF、`HuygensPSF` 与 `tolerancing.set_thickness` 建立在“沿全局 `+z` 轴串联的标量折叠近轴光路”假设上，导致离轴 TMA 与折反系统局部功能报 `UnsupportedParaxialGeometryError`；`ImageSimulationEngine` 缺少探测器物理像元重采样与 FITS WCS 输出。

### 2. OpenLab Bench 当前工程实现缺口（可通过局部代码扩展修复）
- **【事实】** `server/runner.ts:96-98` 硬编码调用系统 `'python3'`（容器默认 Python 3.10.12 未装 Optiland，无法发现独立虚拟环境），且同步阻塞 `execFile` 默认超时仅 `15000–30000 ms`（`runner.ts:94, 711`），无法容纳本实验中单分支 `75–202 s` 的多轮优化或蒙特卡洛仿真。
- **【事实】** `src/core/types.ts:178-195` 的 `GlassName` 仅允许 6 个枚举值、`OpticalSurface` 缺少 `conic`、`surfaceType(mirror/grating)`、光阑遮拦（`RadialAperture`）及三维倾斜/偏心（`tilt/decenter`）。
- **【事实】** `python/optiland_bridge.py:62-162` 强制调用 `image_solve()`、默认首面为光阑、写死 `GeometricMTF` 且仅支持轴上/全视场单点 RMS 汇总，丢失多视场 PSF、畸变场、波前与遮拦采样信息。
- **【事实】** `src/core/fits.ts:178-182` 将源检出硬性截断为最多 `12` 颗（`selected.length >= 12`）、固定孔径 `r = 4`，且 `fits-photometry-reader/dossier.json:9` 明确标示“暂不支持多扩展 HDU 与 WCS 天球投影”。

### 3. OpenLab Bench 基础架构假设本身的不适配（无法通过简单新增插件解决）
- **【事实与判断】** OpenLab Bench B0 v0.2 的核心数据契约（`src/core/types.ts` 中的 `ExperimentRun`、`EffectiveExecutionConfig`、`ResearchSnapshot`）与编排器（`server/runner.ts`）隐含了四个在复杂科研工程中**不成立的基础假设**：
  1. **单跳固定四动作流水线假设**：`ExperimentRun` 假定一次科研实验等价于 `OpticalSystemSpec -> (solver/optimizer -> RayTraceResult) -> evaluator -> EvaluationVerdict`。而真实 `WF-RC-1000` 是多阶段异构有向无环图（**Artifact DAG**）：`解析初始综合 -> 多分支参数优化 -> 视场 PSF 立方体 + 畸变曲线 -> FITS 天图 Mosaic -> Astropy/SEP 源提取 -> 天测/测光反演闭环 -> 装调公差蒙特卡洛`。当前系统没有跨步骤中间产物（PSF cube、FITS、Catalog、MC sample table）的统一引用与传递机制。
  2. **静态扁平表面表（Surface Table）作为唯一系统表达假设**：在含主次镜共轭、垫片联动、离轴倾角链的复杂系统中，自由变量不是某个孤立表面的 `thickness`（如 `S3` 公差补偿必须联立调整 `M1–M2` 间距与 `BFL`），而是**参数化光学构造器（Parametric Builder / Generator）与耦合约束关系**。静态 JSON 表无法表达程序化约束，也会重蹈 Optiland `set_thickness` 的覆辙。
  3. **短时同步无状态执行器假设**：科研仿真天然包含分钟级计算、随机采样、中间收敛态与崩溃恢复（本轮 Stage 2/3 若无独立脚本拆分、无缓冲日志与 `.partial.json` 断点保存，极易因单分支超时丢失全部工作）。当前 `runner.ts` 缺乏异步任务队列、流式日志、计算预算控制与断点恢复机制。
  4. **单域同构对象绑定假设**：`ResearchSnapshot` 将系统规格死锁在 `systemSpec: OpticalSystemSpec`（`types.ts:365`），且多分支探索仅面向同一评价政策下调参。而在 `WF-RC-1000` 实践中，**评价指标本身也在演化**（Stage 1/2 用光学 RMS/Strehl/畸变，Stage 3 变成 `SEP` 完备率、WCS 残差与 `DAOStarFinder` 采样匹配度，Stage 4 变成带双补偿的边缘 Strehl 良率）。这要求研究对象与分支系统能够动态绑定不同领域的模型与多阶段评价门控，而不是被锁定在单光学结构体内。

---

## 五、未完成事项与环境限制（事实边界声明）

- **【事实】** 当前隔离实验未在真实天文望远镜实测天空观测帧（如 SDSS/DECam 原始图像）或光学干涉仪实测面形数据上验证，Stage 3/4 仍属于高保真数值仿真与蒙特卡洛检验。
- **【事实】** `S4_3Lens_Wynne_FS_F2_RC` 分支在 Stage 2 中因单次迭代计算耗时高，仅执行了 1 个种子（447 次评估、`max_nfev` 预算受限），其 `cost=597.635` 说明该分支未在同等计算预算下充分搜索。
- **【事实】** Task 2（离轴 TMA 全链路优化与外部矢量一阶求解）与 Task 3（望远镜+光栅光谱仪 2D 光谱提取）已完成 `Optiland` 核心能力审计，但尚未执行端到端设计与 FITS 还原实验。
- **【事实】** 以上全套实验脚本运行于 `/tmp/p2_venv`（`/tmp` 在容器重建后可能清空，需通过 `experiments/p2_flagship/scripts/ensure_env.sh` 自动重建）。

---

## 六、下一步行动提议（供决策确认）

- **【提议 1】将 `WF-RC-1000` 与架构审计结论正式沉淀为可运行资产与 B0.3 架构重构方案（需确认后动正式代码）**：
  1. 在不破坏历史不可变账本（`workspace/runs.jsonl` 与 CAS 冻结记录）的前提下，将 `ExperimentRun` 从单一 `OpticalSystemSpec -> RayTraceResult` 演进为支持 **多阶段异构 Artifact DAG + 异步断点执行器 + 参数化系统生成器** 的工作台内核（OpenLab Bench B0.3）。
  2. 为 `server/runner.ts` 增加可控虚拟环境探测、异步作业状态/无缓冲日志流与独立计算超时预算。
- **【提议 2】继续按科研实践路线图推进 Task 2（离轴无遮拦 TMA）或 Task 3（天文光栅光谱仪）**：
  - 若优先检验**“当核心专业软件缺关键分析器时，OpenLab Bench 如何组织外部替代算法并切换架构”**，建议先执行 **Task 2（离轴 TMA + 自研矢量近轴一阶求解器 + `MMDFTPSF/FFTPSF` + 自定义 3D 公差补偿）**；
  - 若优先检验**“跨光学模态与跨天文数据产品形态（从星场成像跨入二维光谱提取与定标）”**，建议先执行 **Task 3（RC/折反望远镜馈入式光栅光谱仪）**。
- **【提议 3】完善 `S4` 分支的公平预算复算（可选轻量补充）**：若需严格排除 `S4` 计算预算不均对 `FS+F2+FS` 路线评判的影响，可单独对 `S4` 追加多起始点长预算优化并复核其最佳色散平衡潜力。

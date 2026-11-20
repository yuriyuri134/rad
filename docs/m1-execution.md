# M1 科研执行

## 运行边界

开发服务绑定 `127.0.0.1`。浏览器调用只接受本机同源请求。组件以服务账户权限运行，信任边界包括本机用户、项目源码、组件目录和 Python 环境。审批确认特定版本的源码 SHA-256，Python 本地模块通过组件档案中的 `module` 依赖 `local:相对路径.py` 声明并在审批时固定。执行器核对后把入口和已固定依赖写到临时目录。请审阅入口及其声明的依赖，尤其是能读写其他文件、导入依赖或调用子进程的代码。

## 科研更正

- Stage 4 的原始报告给出两组 40 次模拟。在最大 RMS ≤ 7.5 μm 条件下，两者通过率均为 100%。仅 BFL 的 P50/P95 为 3.781/5.289 μm，M2 垫片加 BFL 的 P50/P95 为 2.070/3.086 μm。源文件为 `experiments/p2_flagship/runs/stage4_tolerancing.json`，SHA-256 为 `955cd06883ba40a57e8001c086013746eaf73e1e2abe0246a092ab2a62318b0c`。
- E6 的 88.2% 衡量 DAO 和 SEP 的代理匹配。历史 Stage 3 的 65.4% 以模拟注入真值为分母。E6 的 DAO 独有检出留待逐星评估。更正适用于工作台展示，原始 E6 数据仍可复核。
- Stage 3 模拟将同一天球位置与通量投影到每份处方的像面。探测器只累加边界内的 PSF 像素。超出探测器的模型能量按比例损失。评价有效星要求模型质心位于探测器内，且保留至少 90% 的归一化有限光斑能量。评价报告应同时给出有效视场保持率和有效星的检出率。

## 交付基线

Git 基线 `90a034d` 缺少旧交付清单登记的 `studies.json` 和 `arch_annotations.json`，已有 `jobs.json` 的哈希也与旧清单不等。保留该清单作为旧交付证据。工作台在独立数据目录初始化缺失的运行时资料。可比较 Git 原始 blob、A1 冻结账本及历史科研产物的 SHA-256。

## 文件执行协议

组件版本的 artifactContract 声明 openlab-files/v1、命名输入输出、媒体类型、Schema ID，可选 JSON Schema、参数约束和 Python 包版本。批准后，可由研究工作台或 /api/research/executions 执行。CLI 从 stdin 读取 inputs、parameters、outputDir 和 manifestPath。inputs 的每个端口包含产物 ID、哈希、媒体类型、Schema ID 和一个本次运行的本地副本路径。组件写入 outputDir，再向 manifestPath 保存一个形如 {"outputs":{"report":"report.json"}} 的小型清单。stdout 和 stderr 用于日志。

一次执行的全部输出只有在发布完成记录后才可见。产物、源码和声明依赖按内容哈希归档。已结束的记录保留自己的端口、参数和运行环境快照。输入必须通过媒体类型、Schema ID、适用的 JSON Schema 和哈希校验。传入上次运行的配方及需复跑的步骤，可复用已有上游和互不依赖的执行。中断时以已发布的执行记录为依据恢复。

同一个数据目录由一个工作台服务进程负责。科研执行归档位于 workspace/workbench/research，可通过 OPENLAB_WORKSPACE_DIR 移到持久化数据目录。

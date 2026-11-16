# OpenLab Bench — 本地完整运行指南（Python 3.11+ & Optiland）

本工作台将**文件级组件目录 (`workspace/components/`)**、**不可变实验账本 (`workspace/runs.jsonl`)** 与 **Web 查看/比较界面** 分离设计：

- **Google AI Studio 云端预览容器**：仅含 Node.js v22 与 Python 3.10.12（无 `pip` / `optiland`）。在此环境中选择 Optiland 求解器会明确提示环境限制，不会伪造物理计算；可使用内置有限预览求解器 (`solver-ts-preview`) 验证组件修改、重评与架构地图链路。
- **Rad 本地电脑（完整科研求解环境）**：支持 Python 3.11–3.14 安装 `optiland`，使工作台直接调用真实的 `Optiland` 光线追迹、点列图、几何 MTF 与阻尼最小二乘优化。

## 1. 本地安装步骤

```bash
# 1. 创建 Python 3.11+ 虚拟环境并安装 Optiland
python3.11 -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install --upgrade pip
pip install -e ".[dev]"

# 2. 验证 Python + Optiland 桥接自检
python python/optiland_bridge.py --probe
python python/optiland_bridge.py --check
python -m unittest python/test_optiland_bridge.py

# 3. 安装 Node 前端与服务依赖并启动
npm install
npm run build
npm start
```

打开浏览器访问 `http://localhost:3000`。工作台会自动检测到已就绪的本地 Optiland 版本，并在「运行环境」指示条中显示真实版本号。

## 2. 直接用 VS Code / Git 修改组件

所有组件均以独立文件夹存放在 `workspace/components/<组件ID>/`：
- 修改某个组件的实现源码后，系统会通过完整的 64 位 SHA-256 哈希自动检测到磁盘改动；
- 改动后的代码必须先经过你（或 Rad）在界面/CLI 中审查哈希并授权，才能被工作台执行；
- 可点击「运行组件自检」验证输入输出契约与边界，再决定是否用于实验。

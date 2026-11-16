# ScienceFlow 融合版：同事试用指南

代码入口为 SD fork 的 `feat/scienceflow-run-reader` 分支，功能基线为 `9da4af83`。目前可以从 SD 会话启动真实 SF 实验，读取评测结果与候选产物，再以新计划和上一轮候选继续实验。

建议先测试 circle-packing 的“计划 → 实验 → 评测 → 回读 → 修改计划 → 再实验”。这条链路已有真实模型运行证据；不保证成绩随轮次提高。本文初始化示例经过离线检查，尚未在全新机器上完整部署复验。

## 1. 选择试用方式

- **已有维护者部署**：访问部署地址，使用维护者准备的项目、会话和模型，从第 5 节开始。访问令牌不是多租户隔离机制，不建议直接向公网开放。
- **自行部署**：按第 2～4 节准备独立实例。推荐 Linux / WSL；SF 会在部署机器上直接执行生成的 Python / Shell 代码，请使用专门的测试账号或机器。

这是显式启用的实验性本机执行模式，尚未接通正式 Runner 沙箱网关。无需先将 SF 部署成远程 Runner。

## 2. 拉取 SD 与配套 SF

准备 Git、Node.js 22.19+、pnpm 11.1.2、uv 0.9+、Python 3.12。SD 本地栈的其他前提见[贡献指南](../../CONTRIBUTING.md)；Linux 普通 Runner 还需要 Bubblewrap。SF 支持 Python 3.11～3.13，本配方使用 3.12。

```bash
git clone --branch feat/scienceflow-run-reader --single-branch \
  https://github.com/moShangLouTou/sciencediscovery.git
cd sciencediscovery
export SD_DIR="$(pwd)"
export SF_DIR="$(dirname "$SD_DIR")/scienceflow-sd-pilot"
git clone https://github.com/science-learner/ScienceFlow.git "$SF_DIR"
git -C "$SF_DIR" checkout 0ef229de1ae126ea04387ce74ae94ffacc437df6
export PATCH_DIR="$SD_DIR/scienceflow/patches/0ef229de1ae126ea04387ce74ae94ffacc437df6"
node "$PATCH_DIR/verify.mjs" "$SF_DIR"
for patch in "$PATCH_DIR"/000*.patch; do
  git -C "$SF_DIR" apply --index "$patch" || break
done
test "$(git -C "$SF_DIR" write-tree)" = f1f1567e17946e7d3d1c5fefe66ef811e24b7078
```

最后的 `test` 必须成功，失败时停止部署。四个 SF 补丁已随 SD 提交，不需要访问维护者本地 SF 仓库，也不用等待另建 SF fork。这里保留 base HEAD 与暂存区补丁，内容树对应 `e1347021`，HEAD 本身不会变成该提交。此目录专用于试用，勿切换分支或重复应用补丁。详见[补丁说明](../../scienceflow/patches/0ef229de1ae126ea04387ce74ae94ffacc437df6/README.md)。

```bash
(cd "$SF_DIR" && uv sync --frozen --no-dev --python 3.12)
cd "$SD_DIR"
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
```

circle-packing 不需要 SF 的 `full` / GPU 扩展。无需单独启动 SF TUI 或为其配置模型，后面由 SD 传递当前会话的有效模型配置。

## 3. 一次性启用科研配置

以下命令在同一终端执行；重开终端需要恢复环境变量。所有路径使用绝对路径，测试数据与日常 SD 数据分开。

```bash
export PILOT_DIR="$SD_DIR/.tmp/sf-colleague"
export SCIENCE_DISCOVERY_DATA_DIR="$PILOT_DIR/data"
export SCIENCE_AGENT_SCIENCEFLOW_LOCAL_RESEARCH_CONFIG_PATH="$PILOT_DIR/research.json"
mkdir -p "$PILOT_DIR/assets" "$PILOT_DIR/runs" "$PILOT_DIR/private"
chmod 700 "$PILOT_DIR/private"
cat > "$PILOT_DIR/task-template.md" <<'EOF'
Solve circle-packing: place 26 non-overlapping circles inside the unit square,
maximizing the sum of radii. Read {{plan_file}} and {{incumbent_file}} first.
Research intent: {{research_intent}}
Use the supplied task interpreter and Python standard library. Do not install
packages. Implement the solver yourself; no supporting solver is preloaded.
Preserve the incumbent JSON schema. Write artifacts/best_solution.json and finish
that tool call promptly, so the engine can capture and evaluate the artifact.
Then use evaluator feedback to improve the candidate in separate bounded calls.
Leave time to save candidates and return before the deadline. Report actual
attempts and scores; do not invent feedback or gains.
EOF
python3 - <<'PY'
import json, os
from pathlib import Path
p = Path(os.environ['PILOT_DIR'])
sf = Path(os.environ['SF_DIR'])
sd = Path(os.environ['SD_DIR'])
config = {
    'schemaVersion': 1, 'enabled': True,
    'research': {
        'profileId': 'colleague-circle-packing',
        'engineCheckout': str(sf),
        'pythonExecutable': str(sf / '.venv/bin/python'),
        'readerScriptPath': str(sd / 'services/scienceflow-reader/snapshot.py'),
        'task': 'circle-packing', 'seedDir': str(p / 'assets'),
        'inputMode': 'dynamic',
        'dynamicInputs': {'plan': 'experiment_plan.md', 'incumbent': 'start_solution.json'},
        'workRoot': str(p / 'runs'), 'privateRoot': str(p / 'private'),
        'taskDescriptionPath': str(p / 'task-template.md'),
        'refusePackageInstall': True,
    },
    'defaults': {
        'researchBudgetSec': 840, 'reportBudgetSec': 60, 'totalAllowanceSec': 900,
        'maxSteps': 40, 'stageCaptureMax': 6, 'bashTimeoutSec': 60,
        'codeMaxTokens': 8192, 'feedbackMaxTokens': 4096, 'httpTimeoutSec': 60,
        'observeMaxWaitMs': 120000,
    },
}
Path(os.environ['SCIENCE_AGENT_SCIENCEFLOW_LOCAL_RESEARCH_CONFIG_PATH']).write_text(
    json.dumps(config, indent=2) + '\n')
PY
```

起始配置为一轮 14 分钟研究加 1 分钟报告，可按需要调整；它是执行截止时间，不是复跑授权限制。配置在 API 启动时读取，修改后需重启测试实例。

`assets` 故意为空，避免依赖此前未提交的试验目录。计划和候选从会话产物按版本传入，启动时冻结。此配方让模型从头编写标准库求解器，效果和耗时可能与维护者使用已有求解器资产的历史实验不同。

### 创建测试会话及初始候选

首次实验需要当前会话的正式候选产物版本，普通附件不能代替。以下离线脚本仅用于一次性初始化：**测试 API 尚未启动、数据目录为空时执行**，不要对运行中的实例直接操作存储。

```bash
cat > "$PILOT_DIR/bootstrap.mts" <<'TS'
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CasStore } from '../../packages/cas/src/index.js';
import { SessionStore } from '../../services/api/src/store.js';

const dataDir = process.env.SCIENCE_DISCOVERY_DATA_DIR;
const sfDir = process.env.SF_DIR;
if (!dataDir || !sfDir) throw new Error('Set SCIENCE_DISCOVERY_DATA_DIR and SF_DIR');
let entries: string[] = [];
try { entries = await readdir(dataDir); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
if (entries.length) throw new Error('Use an empty test data directory; do not modify a live store');
const store = new SessionStore(dataDir);
try {
  await store.load();
  const project = await store.createProject('SF colleague pilot');
  const session = await store.createSession(project.id, 'Circle-packing pilot',
    {}, {}, { allowUnconfiguredModel: true });
  const bytes = await readFile(join(sfDir,
    'tasks/opt_solver/circle-packing/validation/valid_solution.json'));
  const result = await store.createArtifactVersion({
    sessionId: session.id, logicalName: 'scienceflow/initial-solution.json',
    kind: 'json', mediaType: 'application/json', origin: 'server_generated',
    title: 'Initial validation fixture (not a model result)',
    content: await new CasStore(store.dataDir).put(bytes),
  });
  console.log(JSON.stringify({ projectId: project.id, sessionId: session.id,
    initialVersionId: result.version.id, sha256: result.version.content.hash }, null, 2));
} finally { store.close(); }
TS
cd "$SD_DIR"
node --import tsx "$PILOT_DIR/bootstrap.mts"
```

保存输出的项目、会话和版本 ID。初始候选来自 SF 合法性验证样例，26 个半径为 0.01 的圆，半径和为 0.26；它只用于启动链路，**不是模型科研结果，也不是有竞争力的基线**。评估科研能力时应进一步换用强基线，保留原始文件和版本。

## 4. 启动 SD、配置模型

在上述环境变量仍生效的终端运行：

```bash
cd "$SD_DIR"
scripts/jiuwenswarm.sh setup
./scripts/start-stack.sh --mode local
```

脚本会准备、构建本地栈，首次不要加 `--no-build`。这是 SD 默认 JiuwenSwarm 执行器的启动方式，无需另开 SF 进程。访问 `http://127.0.0.1:4310`，按本地栈提示登录。访问令牌位于测试数据目录的 `secrets/auth-token`；另有显式配置时以部署配置为准。访问令牌和模型 API key 是不同凭据，均不要写入报告。

远程部署建议保留回环监听，通过 `ssh -N -L 4310:127.0.0.1:4310 user@host` 转发后访问本机地址。

在 SD 设置中配置获准使用的模型和网关，在 `Circle-packing pilot` 会话选择它。主 Agent 与 SF 都需要可用的模型配置；当前 SF 桥接支持 OpenAI Chat Completions 风格的 `openai` / `qwen` 配置。此前真实运行使用 Qwen3.8-Flash，其他模型的协议、工具调用和效果需另行验证。

**SF 已复用 SD 当前会话的有效模型设置**，包括模型、凭据解析与代理设置，不需要维护第二份 SF `models.json`。每轮私有配置由服务生成，位于 `private` 下，不能作为输入或分享材料。不要复用维护者的私有文件、旧会话 UUID 或 `.tmp/r/round*` 路径。

## 5. 在会话里触发 SF

进入初始化创建的会话，发送：

> 请使用 ScienceFlow 做 circle-packing 实验。先读取当前会话的 initial-solution.json，制定并发布实验计划，再启动真实实验。目标是提高 26 个圆在单位正方形中的半径和。请实际求解、评测，回读候选、分数与反馈，说明有哪些有效尝试；没有提升也如实报告。

正常过程如下：

1. Agent 用 `list_artifacts` / `read_artifact` 获取候选版本，调用 `publish_research_plan` 发布计划。
2. Agent 调用 `start_research`，传入意图、`plan_version_id`、`incumbent_version_id`。用户不用填写宿主路径、Shell 命令或密钥。
3. 若当前会话要求许可，按产品提示批准本次科研操作。权限资源为 `scienceflow:local-research`；部署开关与会话权限是两件事，无需全局放开所有工具。
4. Agent 用 `get_research` 查询进度、终态。成功捕获的评测候选及结果说明自动成为会话产物，可以查看、下载。需要提前结束时可让 Agent 调用 `stop_research`，或使用科研状态中的停止操作。

如果只写计划或声称“已完成”，却没有 operation / SF run 标识、真实候选和评测记录，不算成功触发。可明确补充：“请实际调用 `publish_research_plan` 和 `start_research`，不要只给建议；随后用 `get_research` 回读。”

有有效评测候选后，再发送：

> 请读取上一轮结果说明、候选和实际评测反馈，分析瓶颈，发布有针对性的修订计划。以刚交付的有效候选版本为 incumbent 再运行一轮 SF。比较两轮分数、有效性和实际尝试，区分新实验与重复启动，不把较差结果描述成提升。

继续实验必须使用**当前会话**的实际候选版本。不要在新会话沿用旧版本 ID，也不要把初始样例重新当成上一轮结果。若本轮未交付候选，先查明失败事实，再明确选择已有有效候选重试。

## 6. 怎样判断融合效果

| 检查项 | 应保留的证据 |
| --- | --- |
| 计划进入实验 | 计划版本、意图、operation / SF run 标识 |
| 真实执行与评测 | 捕获候选、评测有效性、分数和尝试记录，不能只看模型自述 |
| 科研收益 | 相同任务及评测器下，初始候选与各轮最佳有效候选的半径和 |
| 反馈迭代 | 第二份计划具体修改点、上一轮候选作为新输入、第二次真实运行 |
| 可复核性 | 下载的 JSON、SHA-256、结果说明、SD/SF 内容版本与模型名称 |

建议比较“同一模型一次实验”与“读反馈后的第二次实验”，记录预算、耗时、有效尝试数及失败原因。超越 0.26 的弱种子不能证明打榜能力，还需强基线、重复实验及相同资源预算比较。

## 7. 当前边界与排查

| 现象或边界 | 说明与操作 |
| --- | --- |
| 找不到科研工具 | 检查环境变量是否传入 API、enabled 是否为 true、变更后是否重启；普通 Runner 提示不代表 SF 本机路径状态 |
| 启动被拒绝 | 检查会话操作许可、模型协议、计划/候选版本是否属于当前会话且有效；保留原始错误，不绕过检查 |
| 模型调用失败 | 核对 SD 会话实际选择的模型及网关可用性；协议不兼容、仅 reasoning 而无回答/工具调用可能导致失败 |
| 聊天先返回 | 科研运行有独立生命周期，用 get_research 查询；不要因一次等待结束就重复启动 |
| 磁盘有 JSON 却没有评测产物 | 文件存在不等于成功捕获。长工具调用被截止时间杀死可能留下文件却没有自动 stage；先保存产物并结束一次工具调用，再继续优化 |
| 停止或超时 | 不保证产物、报告完整，研究与报告状态可能不同；只将实际已捕获、已评测候选纳入比较 |
| 执行隔离 | SF 本机模式尚非正式 Runner 网关，没有该网关的沙箱隔离；私有目录权限不等于生成代码的完整安全隔离 |
| 支持范围 | 已验证集中于 circle-packing、Linux/WSL、本机执行；不能宣称任意科研任务、GPU、远程 Runner、原生 Windows 已验证 |
| 任务与资产 | 部署者固定任务包、解释器、评测器和资产，会话传计划及候选；尚非聊天上传任意任务即可通用打榜的平台 |
| UI 与成绩 | 状态、停止、结果链接和继续入口辅助操作，不保证逐轮提升，也不等于无人值守长期搜索已成熟 |

反馈请附：SD HEAD、SF 补丁内容树、OS/Python/Node 版本、模型名称、operation/run 标识、计划与候选版本、实际错误或评测记录。分享前去掉令牌、密钥、网关敏感信息和私有配置，大型运行目录无需提交 Git。

实现与历史证据见[英文试运行记录](../en/scienceflow-research-pilot.md)及[受控执行设计](../en/design/scienceflow-controlled-execution.md)。历史轮次临时目录不是新部署前置依赖。

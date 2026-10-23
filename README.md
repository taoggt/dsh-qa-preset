# dsh-qa-preset — 仅问答模式（Agent 预设）

给 DeepSeek Harness 增加一个**可选 Agent 预设**，和「标准模式 / 创造模式（Creator）/ PTC / 极简」并列：在新建会话时选择「仅问答模式」，该会话的智能体就只能读取、搜索和分析文件（以及查网页、加载技能、向用户提问），不具备写文件、改代码、运行命令、安装依赖、派生子代理等任何会改变系统或代码状态的能力。

## 使用

1. 打开 DSH NEXT，点「新会话」。
2. 在会话标题/输入框上方的 Agent 预设选择器里选择 **仅问答模式**（也可在「设置 → Agent 预设」里查看）。
3. 正常提问即可：它会读取/搜索文件后回答、解释或给建议。
4. 需要真正执行修改时，新建一个使用其它模式（如「标准模式」）的会话——一个会话会保持它开始时的预设。

预设按会话固定：`agentPresets.select` 只在会话首轮之前生效，已有会话保留其启动时的组合，所以本模式没有「中途切换」按钮，这是 DSH 预设机制本身的行为。

## 这个预设声明了什么

位于 [`cordis.patch.yml`](cordis.patch.yml) 的 `preset-qa` 行（`id: qa`，显示名「仅问答模式」）：

| 组成                                                                      | 作用                                                 |
| ----------------------------------------------------------------------- | -------------------------------------------------- |
| `dsh-persona`                                                           | 注入只读问答策略：只能读、不能写/执行；不得声称执行过变更；建议用户新建其它模式的会话来执行修改   |
| `dsh-tool-fs`（`read: true, readImage: true, write: false, edit: false`） | 只注册 `read` / `read_image`，**不注册** `write` / `edit` |
| `dsh-tool-fs-search`                                                    | `glob` / `grep` 文件检索                               |
| `dsh-tool-web`                                                          | `web_search` / `web_fetch` 只读网络检索                  |
| `dsh-skill-filesystem` + `dsh-tool-skill`                               | 加载技能说明                                             |
| `dsh-tool-ask-user`                                                     | 向用户提问                                              |
| compaction 组                                                            | 长会话自动压缩 / `/compact`，与其它预设一致                       |

**没有**声明：`tool-bash`、`tool-pwsh`、`tool-jobs`、`tool-schedule`、`tool-goal`、`tool-todo`、`tool-present`、`tool-subagent*`、`tool-workflow`、`tool-plugin-manager`、`plan-mode` 等任何执行/写入类插件。因此「执行类操作」不是靠提示词约束，而是**能力根本不存在**：模型侧工具清单里只有只读工具。

## 运行时强制层（宿主全局工具）

预设组合只能控制它自己挂载的插件。**宿主全局层**注册的工具（56 个 `cua_driver_native__*` 计算机操作工具、Team 协作工具 `spawn_teammate`/`send_message`/`team_task_*`、`working_directory`、`load_workspace_dependencies` 等）会被每个会话继承，预设声明本身无法移除。实测首版就是如此：qa 预设会话的模型请求仍有 75 个工具。

因此本 bundle 还声明了一个宿主级插件 [`enforce.js`](enforce.js)（`include:qa-preset-enforce`）：

- 它读取会话的持久 `agentPreset` 投影（选择预设时写入会话日志），**只对 effective preset id 为 `qa` 的会话**生效，其它预设会话完全不注册任何东西；
- 对 qa 会话通过 `agent.ctx` 注册：一个 `tools.restrict({ deny })`（按 agent 可见视图计算，把所有非白名单工具从模型请求中移除）+ 一个单调 `tools.guard`（任何漏网执行都被中文原因拒绝，覆盖 agent 自身作用域工具与 PTC 子分发）；
- 最终 qa 会话的模型侧工具清单为 **17 个**：8 个只读工具（`read`、`read_image`、`glob`、`grep`、`web_search`、`web_fetch`、`skill`、`ask_user_question`）+ 9 个 Agent-Teams 工具（`spawn_teammate`、`send_message`、`interrupt_agent`、`team_task_*`、`wait_agent`、`list_agents`）。后者由 Agent-Teams 服务注册在 **agent 自身作用域**，`tools.restrict` 按设计无法移除；它们无法执行——`guard` 会以中文原因拒绝（已实机触发验证）。56 个 `cua_driver_native__*`、`working_directory`、`load_workspace_dependencies` 则被隐藏。

同样因为它是宿主级行，不能放进预设的 `plugins` 列表里（否则监听不到宿主域 agent）。

## 安装

```text
plugin_manager action=install_bundle target={Path}\dsh-qa-preset
```

安装即注册预设行（`preset-qa`，`@deepseek-ai/dsh-agent-preset` 会在安装时急切激活）。验证：`plugin_manager list_plugins` 中 `include:preset-qa` 的 `fiberPhase` 为 `active`；新会话预设选择器出现「仅问答模式」；选中后该会话的 `request/header.tools` 只包含 `read, read_image, glob, grep, web_search, web_fetch, skill, ask_user_question`。

## 限制

- 预设是会话级的，不能在会话中途切换；修改需新会话。
- 只读边界由「预设只挂载只读插件」+「宿主级 enforce 插件对该预设会话做 restrict/guard」两层保证；其它预设会话不受影响。
- 仍有 9 个 Agent-Teams 工具会出现在 qa 会话的工具清单里（agent 自身作用域注册、restrict 无法隐藏），但执行会被 guard 拒绝；这是 DSH 作用域机制的限制，不是提示词约束。
- 会话的「当前模式」标签取决于客户端；选择预设后新建/继续的会话会显示「仅问答模式」。
- 技能内容可能包含「执行某命令」的指导，但本预设没有对应工具，模型无法执行。

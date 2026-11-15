# Paseo Web 设置与 LitePaseo 对比

研究日期：2026-11-15。仅研究，未实施功能。

## 对比基线与限制

- LitePaseo：0.5.7，`faf1d9facd9df7efec9a47bf4c6b7b137779dc43`；client/protocol 均为 0.15.3。
- 原版：官方仓库 main 快照 `b55955541e4e77d5881ec3de5141d4f1571c0c73`，app 标记 0.16.0-beta.2。**这是源码快照，不代表用户正在使用的原版版本，也不代表 stable。**
- 以源码入口及平台条件为准，并核对当前官方文档；未登录实际原版浏览器逐项操作。动态插件贡献和主机 capabilities 会影响实际可见项。
- 下文“缺少”指 LitePaseo 没有对应用户设置入口，不意味着 daemon 不支持。成本是初步相对判断，未做实现估时。

## 结论

最适合先讨论的是阅读和发送偏好：字号、内容宽度、聊天折叠、发送快捷键、默认发送行为。它们直接作用于已有界面，不需要扩展为完整 IDE。

第二组是每台主机的 agent 配置。现有 SDK 已有 getDaemonConfig/patchDaemonConfig，支持 agentProfiles、appendSystemPrompt、idleRuntimeCleanup、resumeOnStartup、resumePrompt 等字段。主要工作是增加 LitePaseo 服务端路由、能力检查、表单和结果反馈，并非重新实现 daemon。

## 逐类对比

| 原版设置 | LitePaseo 当前行为 | 缺口及实现范围 | 建议 |
|---|---|---|---|
| General：界面语言 | 界面英文 | 需要完整国际化，不只是加选择器 | 独立讨论 |
| General：Enter / Ctrl或Cmd+Enter 发送 | 桌面 Enter 发送、Shift+Enter 换行；触屏 Enter 换行；支持 modifier+Enter | 增加浏览器偏好，保留输入法 composition 处理 | 优先 |
| General：默认 Interrupt / Steer / Queue | 已有三种操作；切换会话时根据能力重置为 Steer 或 Queue | 缺少持久默认值；仍须按 provider 能力降级 | 优先 |
| Appearance：主题 | System/Light/Dark + 四套配色已有 | 原版主题体系与 lite 配色不必一一对应 | 保留现状 |
| Appearance：界面字体、代码字体 | 固定 CSS 字体栈 | 前端偏好及字体输入回退 | 可选 |
| Appearance：界面/正文/代码字号 | 固定样式 | CSS 变量、范围限制、手机布局验证 | 优先 |
| Appearance：内容宽度 | 固定布局；侧栏宽度另有调节 | 正文宽度偏好，与侧栏宽度区分 | 优先 |
| Appearance：语法高亮主题 | 已有高亮，没有主题选择器 | 适配现有 highlight.js/Markdown 渲染，按需加载 | 次优先 |
| Chat：自动展开 reasoning | 可以手动展开，无全局默认 | 前端偏好；保持长内容按需渲染 | 优先 |
| Chat：完整显示/折叠工具调用/折叠轮次 | 已有工具摘要及局部展开，无三档统一模式 | 前两档较小，按轮次折叠需与虚拟列表、定位联动 | 分阶段 |
| Chat：聊天大纲开关 | 已有 ChatOutline，无设置开关 | 增加显示偏好 | 优先 |
| Sidebar：入口显隐、顺序、侧栏视图选择 | 有 Projects/Recent、项目折叠/置顶、主机过滤等 | 不等同于导航入口自定义；只为现有入口增加显隐/排序 | 次优先 |
| Terminal：scrollback 行数 | xterm 固定 5000 行、14px | 可直接增加偏好；限制上限避免内存增长 | 次优先 |
| Editor：Vim 键位 | 文件查看器，不是同等编辑器 | 依赖完整编辑能力 | 暂缓 |
| Files：文件类型与打开面板关联 | 文件查看路径固定 | 依赖多面板/插件打开系统 | 暂缓 |
| Shortcuts：快捷键设置 | 少量固定快捷键 | 需键位注册、冲突处理；发送快捷键可先单独做 | 后续 |
| Diagnostics / About | 主机连接诊断、CLI 版本/状态已有 | 可补 UI/服务端/daemon 版本汇总、复制诊断 | 次优先 |
| Host → Agents：Agent profiles | 新建会话可选择并记住 provider/model/thinking/mode；无命名 profiles | 已有 SDK 字段；补主机级增删改及新建会话选择器 | 优先候选 |
| Host → Agents：追加系统提示词 | 无主机级编辑入口 | SDK appendSystemPrompt；注明作用范围及生效时机 | 优先候选 |
| Host → Agents：Paseo tools / browser tools | 无主机级开关 | SDK mcp/browserTools；浏览器工具仍取决于宿主环境 | 按需要 |
| Host → Agents：空闲进程释放 | 无开关 | SDK idleRuntimeCleanup；主机能力检查 | 优先候选 |
| Host → Agents：重启恢复及恢复提示词 | 无入口 | SDK resumeOnStartup/resumePrompt | 次优先 |
| Host → Agents：Skills 管理 | 无对应设置页 | 专用 skills API 和选择流程；不能当简单布尔值 | 后续 |
| Host → Providers：添加/配置/诊断 | 可以列出并使用 provider，无完整管理表单 | daemon 配置及诊断接入，凭据脱敏和表单验证 | 次优先 |
| Host → Metadata：生成 provider/model 配置 | 项目级 branch/commit/PR instructions 已有 | 项目提示词不等于主机生成引擎设置；SDK metadataGeneration | 按需要 |
| Host → Workspaces：合并后自动归档 | 无全局开关 | SDK autoArchiveAfterMerge；明确影响 host 所有客户端 | 按需要 |
| Host → Terminal profiles / terminal agent hooks | 已有终端，无 profile 编辑器 | SDK terminalProfiles/enableTerminalAgentHooks；终端创建流程也要接入 | 后续 |
| Host → Voice | lite 自有集中转录服务：URL/key/model/languages/vocabulary | 原版 daemon 语音/本地模型/语音对话体系不同；不是同一份配置 | 保留 lite 架构，按需求扩展 |
| Host → 连接、配对、状态、重启/更新等 | 有添加/删除主机及连接状态，非完整 daemon 管理台 | 分离只读状态与操作；生命周期能力随部署类型不同 | 状态优先，操作后续 |

补充原版入口：

| 项目 | LitePaseo 对比与取舍 |
|---|---|
| General：重新运行 setup | 原版引导重置操作，不是常用偏好；lite 使用自己的登录/Hosts 流程 |
| Host 外观：颜色、badge 展示 | 无对应 host 外观定制；低成本候选，优先级取决于多主机辨识需求 |
| Host Plugins：gallery、安装及插件设置 | lite 能展示部分插件 timeline 行，但没有插件管理台；管理与渲染扩展需分别评估 |
| Host Usage | lite 已有 UsagePanel；原版用量页主要是信息展示，不应整个算成缺少设置 |
| Diagnostics 音频播放测试 | 原版诊断操作；lite 当前以转录输入为主，非优先缺口 |

## 已有功能，不应重复造设置

- [Settings.vue](../src/web/Settings.vue)：外观、Web Push 开关、需关注/回合完成分类、测试通知、集中语音输入、PWA 安装、TOTP、登录设备撤销。
- [ProjectSettings.vue](../src/web/ProjectSettings.vue) 与 [project-config-form.ts](../src/web/project-config-form.ts)：worktree setup/teardown、脚本名称/命令/service/port、三个 metadata instructions；保留未在表单展示的配置字段。
- [NewSession.vue](../src/web/NewSession.vue) 与 [AgentControls.vue](../src/web/AgentControls.vue)：新会话及已有 agent 的模型、思考、模式等；不能把“没有 profiles”误写成“不能调模型”。
- [App.vue](../src/web/App.vue)：发送行为、侧栏模式/宽度、主机过滤等散布在具体操作位置。

## 设置应该存在哪里

1. 字号、内容宽度、展开默认、快捷键等先按浏览器保存，适应手机和桌面不同偏好。是否跨设备同步另行决定。
2. Agent profiles、全局系统提示词、provider 等按 Paseo host 保存，经 LitePaseo 服务端调用 SDK；页面明确正在修改哪台主机，避免误认为只是当前会话。
3. 转录服务继续由 LitePaseo 服务端保存；通知偏好按设备订阅保存。不能合并为一份模糊的“全局设置”。
4. SDK 有字段不等于所有连接主机都有能力。原版协议对 profiles、idle cleanup、recovery 等都有兼容条件；新增 UI 要根据 host capabilities 显示，保存后重新读取确认。

## 供决策的候选包

- **A 阅读体验**：正文/代码字号、内容宽度、reasoning 默认展开、工具调用显示模式、大纲开关。收益直接，主要前端工作；折叠轮次单独评估。
- **B 输入体验**：发送快捷键 + 默认 Queue/Steer/Interrupt。已有发送能力，仅补偏好及一致性。
- **C 常用 agent 配置**：profiles + 主机追加系统提示词 + idle cleanup。已有协议基础，需要前后端及主机能力兼容。
- **D 维护可见性**：版本、主机完整状态、provider 诊断。以只读信息优先。
- **E 完整管理台**：providers 编辑、skills、语音模型、终端 profiles、daemon 更新等。按实际痛点选择，不宜作为 A/B 的前置条件。

建议先从 A/B 中挑选，再决定 C 是否确有日常需求；本次不代替用户决定实施范围。

## 证据与追溯

原版入口及平台条件：[settings-screen.tsx](https://github.com/getpaseo/paseo/blob/b55955541e4e77d5881ec3de5141d4f1571c0c73/packages/app/src/screens/settings-screen.tsx)。各类设置源码位于同目录 settings 下：appearance/appearance-section.tsx、general/sending-section.tsx、chat/chat-section.tsx、sidebar/sidebar-nav-section.tsx、terminal/terminal-section.tsx、editor-section.tsx、files-section.tsx、keyboard-shortcuts-section.tsx、host-page.tsx、providers-section.tsx、metadata-generation-page.tsx。

原版 Browser、Integrations、Notifications、Permissions 顶层页是 desktop 条件入口，不计作 Web 必须补齐的设置；lite 的 Web Push 已独立实现。

官方文档：[Agent profiles](https://paseo.sh/docs/agent-profiles.md)、[Configuration](https://paseo.sh/docs/configuration.md)。文档为滚动版本，源码快照为具体基线。

本地协议依据：node_modules/@getpaseo/protocol/dist/messages.js 的 MutableDaemonConfigSchema/MutableDaemonConfigPatchSchema；SDK 依据：node_modules/@getpaseo/client/dist/daemon-client.d.ts 的 getDaemonConfig/patchDaemonConfig。Lite 接入现状见 [server/app.ts](../src/server/app.ts)、[TerminalPanel.vue](../src/web/TerminalPanel.vue)、[theme.ts](../src/web/theme.ts)、[TimelineRowView.vue](../src/web/TimelineRowView.vue)。

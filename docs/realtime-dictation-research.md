# 实时语音输入可行性

核查日期：2026-11-12。仅查阅官方文档和本地源码，未调用付费 API 或测试实际延迟。

**可以实现边讲边显示文字。** OpenAI 推荐实时音频使用 `gpt-live-transcribe`；完整录音使用 `gpt-transcribe`。文件转写的流式输出不等于实时接收麦克风音频。[转写概览](https://developers.openai.com/api/docs/guides/transcription)

实时方案通过 WebSocket 连到 `wss://api.openai.com/v1/realtime?intent=transcription`，持续发送音频，收到 `conversation.item.input_audio_transcription.delta` 即更新草稿；停止时提交音频，收到 `completed` 后定稿。`gpt-transcribe` 则在提交一段音频后才开始转写。`gpt-live-transcribe` 可设置 `delay: "low"`，但没有固定毫秒延迟保证；该模型不支持服务端 VAD，需手动停止或客户端判断停顿。[实时转写指南](https://developers.openai.com/api/docs/guides/realtime-transcription)

当前 [DictationButton.vue](../src/web/DictationButton.vue) 缓存整段 16 kHz PCM，停止后上传；[dictation.ts](../src/server/dictation.ts) 包装 WAV 调用文件转写接口。因此接入需要增加实时连接和草稿更新逻辑，按官方示例采用 24 kHz PCM；不能只改模型名。建议由后端转发音频与转写事件，保留现有文件转写作为兼容路径。此为基于源码的实现建议。

模型标价为每分钟 $0.017，约每小时 $1.02。[模型说明](https://developers.openai.com/api/docs/models/gpt-live-transcribe) 中文及中英混说的准确率、首字延迟和当前账号可用性仍需实测，不能据文档承诺与 Claude Desktop 完全相同的体验。

## 后文能否修正已显示文字

官方指南明确提到后续增量可能修正先前的临时文字，界面需要处理这种修订；提高 `delay` 也能让模型在输出前获取更多上下文。[实时转写指南](https://developers.openai.com/api/docs/guides/realtime-transcription#production-checklist)

但当前公开的 `delta` 事件只描述文本增量，没有替换位置、删除长度等修订字段，示例也只追加文字。因此不能据此承诺与 Claude Desktop 一样的实时回改行为，更不能承诺后面的句子会自动重写已经完成的旧段落。确定可实施的是：保留每个 `item_id` 的临时草稿，收到 `completed.transcript` 时以该段完整结果替换草稿；提交前的具体修订协议和效果仍需实测核实。[事件定义](https://developers.openai.com/api/reference/resources/realtime/server-events#conversation.item.input_audio_transcription.delta)

## ChatGPT 自带听写使用什么模型

已查阅的官方资料未公开当前听写的具体模型名。[听写 FAQ](https://help.openai.com/en/articles/12168547-voice-dictation-faq) 仅说明录音会发送给模型转成可编辑文字；[2026-06-26 更新说明](https://help.openai.com/en/articles/6825453-chatgpt-release-notes) 称更换了新的语音转文字模型，但没有给出 API 型号。不能根据 ChatGPT Voice 的对话模型推断听写模型，也不能保证公开 API 复现其速度和准确率。

## 当前等待时间来自哪里

本地配置只读检查显示使用 `gpt-transcribe`，语言提示为 `zh,en`，无关键词，经第三方网关连接。现有流程是停止录音后上传整段 PCM，后端读完整个请求、包装 WAV、调用上游并等待完整响应，前端再读取完整 JSON 后显示文字。没有启用 `stream=true`；一分钟 16 kHz、16-bit、单声道 PCM 约为 1.92 MB，需要经过浏览器到服务器及服务器到上游两段上传。[前端源码](../src/web/DictationButton.vue)、[路由](../src/server/app.ts)、[上游请求](../src/server/dictation.ts)

110/120 秒超时是等待上限，不是固定延迟；提示字段遭遇特定 400 错误时才重试，尚无证据表明发生了重试。当前没有分阶段耗时记录，因此不能量化网关、上传和模型各自的耗时。后续可先测量各阶段；文件转写流式返回能提前显示停止后的结果，录音过程中显示则需要实时转写连接。[两种转写工作流](https://developers.openai.com/api/docs/guides/transcription)

## 边录边上传，减少停止后的等待

**即使保留 `gpt-transcribe`，也可以边录边把音频传到 OpenAI。** 使用 Realtime WebSocket 转写会话，录音时连续 `append`，停止时才 `commit`。对这个模型，上传本身不启动转写，提交才启动；这样能把大部分上传工作移到录音期间，但停止后仍须等待整段识别，不能承诺立即完成。[已提交音频转写](https://developers.openai.com/api/docs/guides/realtime-transcription#transcribe-a-committed-turn)

进一步可在客户端检测自然停顿并 `commit`，然后继续向同一会话 `append`：提交会创建音频条目并清空缓冲区，不会结束会话。于是前段识别可以与后段录音重叠。停止时提交最后未完成的一段，等待各段最终结果。过短切段可能损失上下文，这是需要实测的质量权衡；应避免把每个网络小包都当作一个语音段。[append / commit 定义](https://developers.openai.com/api/reference/resources/realtime/client-events#input_audio_buffer.append)

各段结果应根据 `item_id` 和提交事件的 `previous_item_id` 排序，不能按完成事件到达顺序拼接。[提交事件](https://developers.openai.com/api/reference/resources/realtime/server-events#input_audio_buffer.committed) 官方说明 `gpt-transcribe` 会利用此前已转写的段落作为上下文，但没有承诺并发段落的上下文时序，也没有承诺后来的话会重写已完成的旧段落。[上下文说明](https://developers.openai.com/api/docs/guides/realtime-transcription#transcribe-a-committed-turn)

| 方案 | 录音期间发生什么 | 停止后还需等待什么 |
| --- | --- | --- |
| 当前整段文件上传 | 仅本地录音 | 整段上传、整段转写 |
| `gpt-transcribe` 边录边上传、停止提交 | 上传音频 | 剩余传输和整段转写 |
| `gpt-transcribe` 自然停顿分段提交 | 上传、已提交段落转写 | 最后一段及尚未完成的段落 |
| `gpt-live-transcribe` | 上传并产生实时文字 | 尾部音频及最终定稿 |

实现建议：先验证当前网关是否支持 Realtime WebSocket 和 `gpt-transcribe` 转写会话，再以同一模型做边录边上传、停止提交的耗时对比；需要继续降低尾部等待时，加入自然停顿分段提交。只兼容 `/audio/transcriptions` 的网关不一定支持这条路径，当前尚未验证。

项目接入可采用浏览器 → LitePaseo 后端 → 上游的 WebSocket 链路，密钥留在后端，音频转为 24 kHz PCM；例如以约 200 ms 小包作为首轮实验参数，并非官方最优值。现有 worker 没有服务端 WebSocket upgrade 路径，前端文字插入也是一次性的，需要一起调整。验证应记录连接完成、停止录音、最后音频发出、首个文字增量和最终完成时间，区分上传尾部、上游转写和界面展示耗时。分段方案不能预设与整段识别准确率完全相同。

文件接口的 `stream=true` 是流式返回文字。官方对持续到达的麦克风音频明确指向 Realtime；`fs.createReadStream` 上传已有文件的示例不能证明边录边写 HTTP 请求会提前识别。没有找到把现有文件接口改成 HTTP chunked body 即可获得同等能力的官方保证。[文件转写指南](https://developers.openai.com/api/docs/guides/speech-to-text)

## 已实现与实测（2026-11-12）

现已实现浏览器 → LitePaseo 的持续音频上传，以及两条上游路径：优先建立 Realtime 转写连接；不支持时，在自然停顿处将音频段交给现有文件接口。当前网关的实际 Realtime 握手返回 HTTP 405，因此本机使用分段文件路径，并非向该网关持续发送 Realtime 音频。仍保留 `gpt-transcribe` 和原有中英语言提示。停顿检测使用 PCM 能量，约 700 ms 静音触发分段，连续说话最长 30 秒切一段；识别质量还需用真实中文语音验证。

通过真实网关对同一段 14.64 秒合成英文语音进行一次比较：整段提交后的 API 耗时 1381 ms；按真实录音速度分包发送的新流程在约 4.9 秒时已有首句文字，停止发送后约 295 ms 获得完整结果，两次转写文本一致。这是单次合成样本，不含真实浏览器到后端的网络延迟，也不代表中文准确率或稳定延迟保证。

另外，只读检查发现本机 Paseo 原版配置使用 `openai` 提供商的 `gpt-4o-transcribe`，与 LitePaseo 的 `gpt-transcribe` 不同；原版已安装的 OpenAI STT 实现会缓存音频并在 commit 后调用文件转写接口，因此不能把其速度直接归因于使用了 OpenAI Realtime。新实现的完成日志只记录音频时长、首字耗时和停止后的等待时间，不记录音频、转写内容或密钥。

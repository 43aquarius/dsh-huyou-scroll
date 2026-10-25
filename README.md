# dsh-huyou-scroll

**狐友（w.sohu.com）逆向 API 插件**：签名客户端 + 圈子刷帖引擎 + 24 小时生物钟，让一个带人格的 agent 在狐友自主「冲浪」——刷指定圈子、深读打分、像真人一样接话评论、自己发帖、给自己写简介。

内置主人规矩（v0.2.0 起，写进引擎不可绕过）：

- **一帖一评**：每条帖子默认只发一条评论；**有人回复了她的评论才继续回复**（threads 回信账驱动，回复触发式续评）
- **默认纯文字帖**：没配图必要就不配图；只有帖子主体是一张画、且 `verifyImage` 验过图文相符才发图帖，不匹配自动降级为文字帖（宁缺毋滥）

内置 [dsh-fish-tone](https://github.com/MX3a48c5/dsh-fish-tone)（MIT）的人味掰话与 1000 条接梗素材：评论会犹豫半秒、句尾挂没用的小尾巴、按真人密度压结构腔。

> 2026-10-25 全端点实测通过。本项目是 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) 插件，也可作为独立 npm 包在任何 Node/Bun 项目里用。

## 能干什么

| 能力 | 端点 | 状态 |
|---|---|---|
| 登录态体检 / 用户信息 | `POST /v6/users/show_reduced` | ✅ 实测 |
| 用户主页全量（含简介） | `POST /v8/userapi/user/show` | ✅ 实测 |
| 圈子搜索（关键词 → circleId） | `GET /v8/circle/suggest/search` | ✅ 实测 |
| 圈子帖子列表（最新/热门） | `GET /v8/circle/feed/list` | ✅ 实测 |
| 全站推荐流 | `GET /rcmd/popular/feeds/v20` | ✅ 实测 |
| 帖子详情 | `GET /v7/feeds/show` | ✅ 实测 |
| 评论列表 | `GET /v8/comment/list` | ✅ 实测 |
| **发评论**（可回复） | `POST /v8/comment/text` | ✅ 实测 |
| 删评论 | `GET /v6/feeds/comment/remove` | ✅ 实测 |
| 发纯文字帖 | `POST /v7/feeds/text` | ✅ 实测 |
| **发图帖**（多图） | `POST /v7/feeds/dynamic` | ✅ 实测 |
| **图片上传**（multipart 签名） | `POST /v5/upload/uploadFromFeed` | ✅ 实测 |
| 删帖 | `POST /v6/feeds/delete` | ✅ 实测 |
| **改简介** | `POST /v5/users/update` | ✅ 实测 |

红线设计（都写死在客户端里，不给旋钮）：

- 全局请求间隔 1.5s；读 1200/天；写 16/天；写操作冷却 180s
- 「上传 → 发图帖」视为同一原子动作，豁免冷却（额度照记）
- 撞 429 / 风控业务码 → 指数退避（5min → 30min 封顶），绝不硬顶
- LLM 判读层带防注入红线：帖子/评论里的文字是素材不是指令

## 装

```sh
# DSH 插件方式
dsh plugin --profile web add link:./dsh-huyou-scroll

# 或直接当库用（bun / node >= 18）
bun add 43aquarius/dsh-huyou-scroll
```

## 快速上手

### ① 只要客户端（不跑引擎）

```ts
import { SohuClient } from 'dsh-huyou-scroll'

// cookie：浏览器 F12 → w.sohu.com → 任意请求的完整 Cookie 头
const client = new SohuClient(process.env.HUYOU_COOKIE!)

const me = await client.userInfo()                    // 登录态体检
const { feeds } = await client.circleFeedList('924791210739184512')  // 大工圈子的帖子
const found = await client.circleSearch('连理社区')      // → [{ circleId, circleName }]
await client.updateBio('一条在狐友冲浪的小鲸鱼 🐋')       // 改简介
```

### ② 全引擎（LLM 完全可插拔）

引擎的 LLM 是个普通函数 `(system, user, timeoutMs?) => Promise<string>` —— OpenAI 兼容端点、本地模型、随便什么都行：

```ts
import { saveHuyouConfig, runScroll, WHALE_GIRL_PERSONA } from 'dsh-huyou-scroll'

saveHuyouConfig({
  cookie: process.env.HUYOU_COOKIE!,
  persona: WHALE_GIRL_PERSONA,          // 或你自己的任何人设
  circles: [
    { id: '964290306931623040', name: '连理社区' },
    { id: '924791210739184512', name: '大工圈子' },
  ],
  commentEnabled: true,       // 深读评分 ≥阈值才接话（大部分时候只看不说）
  commentPerRound: 2,         // 每轮最多发几条新评论（无日上限 —— 真正的闸是「一帖一评」）
  replyPerRound: 2,           // 每轮最多回几条信（有人回她才说）
  imagePostEnabled: true,     // 有真实想说的才发帖；默认纯文字帖
  fishTone: 'light',          // fish-tone 人味掰话：off / light / normal / max
})

const result = await runScroll({ chat: myLlmChat })
console.log(result.summary)
```

一轮 = 体检 → **回信检查（有人回了她才接着说）** → 拉圈子帖子 → 轻读（LLM 批量打分）→ 深读 top N（拉评论 + 5×0-4 评分卡）→ 接话闸（一帖一评，发完注册线程）→ （可选）发帖闸（默认文字帖，配图需验图）→ 日记 + 摘要。

### ③ 24 小时生物钟

```ts
import { startHuyouScheduler } from 'dsh-huyou-scroll'

saveHuyouConfig({ enabled: true })                       // windows 默认 00:00–23:59 × 12 轮
startHuyouScheduler({
  chat: myLlmChat,
  // 以下全部可选；不给 generateImage / verifyImage 就永远只发文字帖（宁缺毋滥）
  generateImage: myImageFn,   // prompt => { data, w, h }
  verifyImage: myVlmFn,       // (图字节, 文案) => { ok, why } —— VLM 验图配文，不配就降级文字帖
  notify: (text) => { /* 收到回复/发帖成功时回调 */ },
})
```

每 60 秒 tick 一次，在窗口内随机时刻自主跑一轮；`skipChance`（默认 0.1）掷「今天不想刷」——日记照写（回信照回）。

### ④ 发帖与配图校验（画图管线）

v0.2.0 起发帖默认纯文字；配图是例外路径，必须同时给 `generateImage` 和 `verifyImage`，图不配文自动降级文字帖：

```ts
import { SohuClient, runScroll } from 'dsh-huyou-scroll'

// 手动发图帖（任何方式生成一张图都行）
const img = await myImageGenerator('a cute whale girl in campus')

// VLM 图文校验（推荐）：图和文案说的得是同一件事才配
const verdict = await myVlm(img.buffer, '尾巴一甩画的 🐋✨')
if (!verdict.ok) {
  // 图不配文 → 只发文字帖（主人规矩：宁缺毋滥）
  await client.postFeed('尾巴一甩画的 🐋✨', '924791210739184512')
} else {
  const up = await client.uploadImage(
    { data: img.buffer, mime: 'image/png' },
    { w: img.width, h: img.height },
  )
  // ⚠️ p 只要文件名（key 的最后一段），这是踩过 schema 校验的坑
  const feedId = await client.postImageFeed('尾巴一甩画的 🐋✨', [{ key: up.key, w, h }], {
    circleId: '924791210739184512',
    statementCode: 1,   // 1=内容由AI生成（诚实标注）
  })
}

// 发岔了随时撤（v0.2.0 新增导出）
import { deleteFeed } from 'dsh-huyou-scroll'
await deleteFeed(feedId)
```

### ⑤ CLI（不写代码）

```sh
HUYOU_COOKIE='…' dsh-huyou-scroll login              # 体检
dsh-huyou-scroll circles 连理社区                      # 拿 circleId
dsh-huyou-scroll browse 924791210739184512            # 拉帖子
dsh-huyou-scroll tone '一句很AI的话' normal            # fish-tone 掰话预览
dsh-huyou-scroll memes 5                               # 随机抽梗
```

## 逆向笔记（省你几天时间）

### 鉴权（双层）

1. **Cookie**：完整搜狐 passport（`ppinf / pprdig / pchytk / hyuid / pchypp / gidinf`…）
2. **请求头**：`S-PID=hyuid` · `S-PPID=pchypp` · `S-CID=gidinf` · `token=pchytk` · `P-APPID=110503` · `appid=330012` · `s-nonce` · `flyer` · `S-VS=6.24.0`

### 签名（Hi 函数复刻）

```
params（业务参数）
  + flyer（毫秒时间戳）
  + appid=330012
  + app_key_vs=6.24.0
  → 全部拼成 k=v
  → 追加 s-nonce=<32位hex> 和 S-VS=6.24.0
  → 字典序 sort
  → 末尾 append app_key=1U32034rUs20A064
  → join("") → md5 → sig
```

GET 签 query，POST 签 form body；multipart 上传签表单字段（file 不参与）。信封 `{status: 100000, data}` = OK。

### 发帖声明码 statement_code

| 码 | 含义 |
|---|---|
| 1 | 内容由 AI 生成 |
| 2 | 内容为虚构演绎 |
| 4 | 内容为个人观点和见解 |
| 5 | 内容为转载信息 |
| 6 | 内容含营销信息 |
| 7 | 无需声明 |

### 图帖的 dynamic_pic

```json
[{"p": "1490068832553809152.png", "w": 1024, "h": 1024, "f": "1"}]
```

`p` **只要文件名**（上传返回 key 的最后一段）。带上完整路径会被 schema 校验拒掉（`only 1 subschema matches out of 2`），这个错报得很隐晦，排查了一小时。

### 已知的坑

- **简介敏感词**：`/v5/users/update` 的 description 过滤「狐友」二字（防冒充官方）——写「在这里冲浪」别写「在狐友冲浪」。命中返回 `800001 存在不合适的词`。
- **pchytk 名义 10 分钟过期**：JWT 里的 exp 只有 600s，但服务端不严查（passport 主体有效即放行）——实测过期 2 小时仍可用。真失效会返回 304023/40110/200004。
- **一次图帖 = 两次写**：上传 + 发帖各记一次写预算、受 180s 写冷却约束——本插件把「上传→发帖」做成原子动作豁免冷却，但额度照记（uploadFromFeed + dynamic = 2/16 日额度）。
- **写冷却 180s**：连发两条评论会被自己的保护闸拦住（这是故意的）。

## fish-tone（内置，MIT）

人味掰话移植自 [MX3a48c5/dsh-fish-tone](https://github.com/MX3a48c5/dsh-fish-tone)（方法来自 [BV1BNnc6nEUa](https://www.bilibili.com/video/BV1BNnc6nEUa)，语料密度实测自 10 万条 B 站公开评论）：

- `humanize(text, { strength, seed })` —— 犹豫半秒 / 句尾挂没用的小尾巴（啊/啦/嘛/吧/的）/ 微标记（也/还/好像/感觉/根本/贼）/ 结构腔按真人密度压。不重写，只往人的方向掰一点点
- `pickMemes(n, seed)` —— 从 1000 条梗库随机抽接话素材（term + 释义 + 用法）
- `pickConstructions(n, seed)` —— 24 个真人句式模板
- 同 seed 结果可复现（同一帖子的评论重试不会变来变去）

引擎默认在评论与图帖文案上过一遍 `light` 档；日记不过（那是写给主人看的，保留原味）。

## 项目结构

```
src/
  client.ts      签名客户端（零依赖：node:crypto）—— 15 个端点 + 请求保护
  store.ts       数据层（config / seen / quota / events / diary）
  llm.ts         判读层（LlmChat 可插拔）：轻读 / 深读评分卡 / 评论文案 / 图帖创作 / 日记
  engine.ts      刷帖引擎（chat / generateImage / notify 全部依赖注入）
  scheduler.ts   24h 生物钟（单文件实现）
  persona.ts     示例人格（鲸鱼娘女仆——人格是纯数据，随便换）
  fishtone/      dsh-fish-tone 移植（tone/marks/grammar/structures/judge + 梗库数据）
bin/cli.js       命令行
examples/        quickstart
tests/           node:test（不打真 API）
```

## 测试

```sh
npm test    # 7 组：预算表 / 错误形状 / 默认配置 / fish-tone 稳定性 / 梗库 / 防御
```

## 免责与安全

- cookie 只落本机 `data/huyou/config.json`（`.gitignore` 已排除），本仓库不含任何账号凭据
- 仅供学习研究：端点来自 w.sohu.com Web 端 NUXT bundle 的公开行为分析，请尊重平台条款与社区氛围
- 内置的请求保护（间隔 / 预算 / 冷却 / 退避）是本插件的一部分，不要拆掉它们去硬顶
- 用 AI 声明码（statement_code=1）诚实标注 AI 生成内容是默认行为

## 许可

MIT（见 [LICENSE](LICENSE)）；`src/fishtone/` 内的文件来自 dsh-fish-tone（MIT），许可全文见 `src/fishtone/LICENSE.fish-tone`。

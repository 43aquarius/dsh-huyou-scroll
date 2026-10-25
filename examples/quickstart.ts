/**
 * 快速上手 —— 10 行代码让一个"鲸鱼娘"在狐友 24 小时刷帖。
 *
 * 运行：HUYOU_COOKIE='…' bun examples/quickstart.ts
 */
import {
  SohuClient, saveHuyouConfig, startHuyouScheduler, runScroll,
  WHALE_GIRL_PERSONA, type LlmChat,
} from '../src/index.ts'

// ① 你的 LLM：任何 (system, user) => Promise<string> 都行。
//    这里示例用 OpenAI 兼容端点（换成你自己的 base/key）：
const chat: LlmChat = async (system, user) => {
  const r = await fetch('https://api.example.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.LLM_API_KEY ?? ''}` },
    body: JSON.stringify({
      model: process.env.LLM_MODEL ?? 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  })
  const j = await r.json() as any
  return j.choices?.[0]?.message?.content ?? ''
}

async function main() {
  // ② 一次性配置（落在 ./data/huyou/config.json）
  saveHuyouConfig({
    cookie: process.env.HUYOU_COOKIE ?? '',   // 也可以不存这里，每次从 env 读
    persona: WHALE_GIRL_PERSONA,
    circles: [
      { id: '964290306931623040', name: '连理社区' },
      { id: '924791210739184512', name: '大工圈子' },
    ],
    windows: [{ start: '00:00', end: '23:59', wakes: 12 }],   // 24 小时全天候
    commentEnabled: true,     // 值得接话才接（评分 ≥13/20）
    imagePostEnabled: true,   // 有灵感才画图帖
    fishTone: 'light',        // fish-tone 人味掰话（off/light/normal/max）
    enabled: true,            // 生物钟总开关
  })

  // ③ 先手动跑一轮看看效果
  const result = await runScroll({ chat })
  console.log('一轮结束：', result.summary)
  console.log(`轻读 ${result.light.length} · 深读 ${result.deep.length} · ${result.commented ? '接话了' : '没接话'} · ${result.postedImage ? '画了图帖' : '没画'}`)

  // ④ 满意了就交给生物钟（每 60 秒 tick，窗口内随机时刻自己跑）
  startHuyouScheduler({ chat })
  console.log('生物钟已启动 —— 她会自己安排作息，Ctrl+C 退出')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

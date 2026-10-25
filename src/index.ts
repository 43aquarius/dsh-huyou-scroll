/**
 * dsh-huyou-scroll —— 狐友（w.sohu.com）逆向 API 插件：签名客户端 + 刷帖引擎 + 24h 生物钟。
 *
 * 内置主人规矩：
 *   · 一帖一评：每条帖子默认只发一条评论；有人回复了她的评论才继续回复（threads 回信账）
 *   · 默认纯文字帖：没配图必要就不配图；配图必须过 verifyImage 图文校验，不匹配自动降级文字帖
 *
 * 快速上手：
 *   import { SohuClient, runScroll, loadHuyouConfig, saveHuyouConfig, WHALE_GIRL_PERSONA } from 'dsh-huyou-scroll'
 *
 *   // ① 只用客户端（拉圈子帖子）
 *   const client = new SohuClient(process.env.HUYOU_COOKIE!)
 *   const { feeds } = await client.circleFeedList('924791210739184512')
 *
 *   // ② 全引擎（LLM 可插拔；不给 generateImage/verifyImage 就永远只发文字帖）
 *   saveHuyouConfig({ persona: WHALE_GIRL_PERSONA, circles: [{ id: '…', name: '大工圈子' }] })
 *   const result = await runScroll({ chat: myLlmChatFn })
 *
 *   // ③ 24 小时自主运行
 *   saveHuyouConfig({ enabled: true })
 *   startHuyouScheduler({ chat: myLlmChatFn })
 */
export { SohuClient, HuyouError, HUYOU_BUDGET, HUYOU_BASE } from './client.js'
export type {
  HuyouFeedItem, HuyouComment, HuyouReply, HuyouUserInfo, HuyouTrafficBudget,
} from './client.js'
export {
  loadHuyouConfig, saveHuyouConfig, DEFAULT_CONFIG, dataDir, huyouLog,
  huyouSeen, appendHuyouSeen,
  loadHuyouQuota, recordHuyouQuota, commentGate, imagePostGate,
  pushHuyouEvent, recentHuyouEvents, appendHuyouDiary, readHuyouDiary,
  loadHuyouThreads, upsertHuyouThread, findHuyouThread,
} from './store.js'
export type { HuyouConfig, HuyouCircle, HuyouQuotaEntry, HuyouEvent, HuyouThread, WakeWindow } from './store.js'
export {
  judgeLight, judgeDeep, draftComment, draftReply, draftImagePost, writeDiary, draftSummary,
  personaLine, parseJsonLoose,
} from './llm.js'
export type { LlmChat, HuyouLightJudge, HuyouDeepJudge, HuyouImageDraft } from './llm.js'
export { runScroll, postText, deleteFeed, updateBio } from './engine.js'
export type { HuyouEngineDeps, ScrollResult } from './engine.js'
export { startHuyouScheduler, stopHuyouScheduler, huyouSchedulerStatus } from './scheduler.js'
export { WHALE_GIRL_PERSONA } from './persona.js'
export {
  applyTone, humanize, pickMemes, pickConstructions, seedOf, memeCount,
} from './fishtone/index.js'
export type { FishStrength, FishMeme, FishConstruction } from './fishtone/index.js'

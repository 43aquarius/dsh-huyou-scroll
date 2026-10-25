/**
 * dsh-huyou —— 狐友（w.sohu.com）逆向 API 插件：签名客户端 + 刷帖引擎 + 24h 生物钟。
 *
 * 快速上手：
 *   import { SohuClient, runScroll, loadHuyouConfig, saveHuyouConfig, WHALE_GIRL_PERSONA } from 'dsh-huyou'
 *
 *   // ① 只用客户端（拉圈子帖子）
 *   const client = new SohuClient(process.env.HUYOU_COOKIE!)
 *   const { feeds } = await client.circleFeedList('924791210739184512')
 *
 *   // ② 全引擎（LLM 可插拔）
 *   saveHuyouConfig({ persona: WHALE_GIRL_PERSONA, circles: [{ id: '…', name: '大工圈子' }] })
 *   const result = await runScroll({ chat: myLlmChatFn })
 *
 *   // ③ 24 小时自主运行
 *   saveHuyouConfig({ enabled: true })
 *   startHuyouScheduler({ chat: myLlmChatFn })
 */
export { SohuClient, HuyouError, HUYOU_BUDGET, HUYOU_BASE } from './client.js'
export type {
  HuyouFeedItem, HuyouComment, HuyouUserInfo, HuyouTrafficBudget,
} from './client.js'
export {
  loadHuyouConfig, saveHuyouConfig, DEFAULT_CONFIG, dataDir, huyouLog,
  huyouSeen, appendHuyouSeen,
  loadHuyouQuota, recordHuyouQuota, commentGate, imagePostGate,
  pushHuyouEvent, recentHuyouEvents, appendHuyouDiary, readHuyouDiary,
} from './store.js'
export type { HuyouConfig, HuyouCircle, HuyouQuotaEntry, HuyouEvent, WakeWindow } from './store.js'
export {
  judgeLight, judgeDeep, draftComment, draftImagePost, writeDiary, draftSummary,
  personaLine, parseJsonLoose,
} from './llm.js'
export type { LlmChat, HuyouLightJudge, HuyouDeepJudge, HuyouImageDraft } from './llm.js'
export { runScroll, postText, updateBio } from './engine.js'
export type { HuyouEngineDeps, ScrollResult } from './engine.js'
export { startHuyouScheduler, stopHuyouScheduler, huyouSchedulerStatus } from './scheduler.js'
export { WHALE_GIRL_PERSONA } from './persona.js'
export {
  applyTone, humanize, pickMemes, pickConstructions, seedOf, memeCount,
} from './fishtone/index.js'
export type { FishStrength, FishMeme, FishConstruction } from './fishtone/index.js'

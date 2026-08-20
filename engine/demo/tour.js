/**
 * tour.js —— 導覽腳本模式（設計＝「假對話餵前端」）：台詞加長（嘴型跟句長走，
 * 短句動不明顯）＋側欄功能各錄一段（電話／外觀／設定）＋分段輸出。
 *
 * 職責：app.js 的「精簡替身」——同一套模組（sprite／adv／chat renderFrame／
 * phone／settings／素材皮），但：
 *   - 零 WS（ChatClient 不 import）：對話來自各段腳本，不連任何 backend。
 *   - 零 TTS：口型＝打字機 pakupaku；電話段的「他說話」用本地 sample 音檔
 *     （assets/sample/ring.mp3——git 內公開素材）驅動嘴型，零語音成本零隱私。
 *   - 台詞＝產品展示文案（通用乙女向情境），不含任何真實私人對話內容。
 *
 * 分段（?seg= 參數；預設 chat）：
 *   chat         主對話（打字動嘴／Thinking 鈕／眼睛鈕）
 *   phone        電話（撥出→通話條→台詞進 Chat Log＋句尾 play→掛斷→重播動嘴）
 *   appearance   外觀（面板一覽→主畫面五套主題輪播）
 *   settings     設定（開面板→語音朗讀開關→嘴型拉桿）
 *   cg           CG 場景（聊天進場→ADV 讓位→依情節切換→退場 crossfade；
 *                資料＝engine/api 靜態示範相冊）
 *   cg-manage    CG 相冊管理態（扳手進管理→捲頁看清單與上傳列→切手機組→返回相冊）
 *   mobile-chat  手機聊天（半身立繪短輪對話＋Chat Log 收合）
 *   mobile-cg    手機角色主動演出（CG 由角色端驅動亮起）
 *   expressions  表情與臉紅（角色回覆夾 [expr:smile]／[blush]，介面自己上妝；ADV 收起＝
 *                立繪欣賞模式、家具在場——8/18 定案：完整立繪比對話框重要）
 *   room         房間自主權（角色一句「把留聲機搬出來」＋ [furniture:…:on] 暗號 →
 *                家具現身、立繪讓位；ADV 收起）
 *   thinking     對話框與 Thinking 鈕（ADV 在、短對話、點開沒說出口的再切回）
 *   （試妝間 lab 段不在本檔：record_demo.py 直接開 demo/expression-lab.html 逐鈕點）
 *
 * 表情／臉紅／家具的鷹架（demo 限定）：同 app.js 一份控制器（ExpressionController／
 * BlushController／FurnitureManager），暗號由 chat.js stripMarkers 剝抽；房間暗號在產品裡
 * 是後端讀了再推 room_state 回來，這裡由腳本 step.room 當後端替身直接套用（同 cg 段
 * applyState 打樁哲學）。家具管理員的 localStorage 寫入被關掉（錄影不留記憶污染）。
 *
 * 電話段的鷹架（demo 限定、不碰產品碼）：fetch 的 /api/call/* 打樁、_startMic
 * 跳過真麥克風——導覽頁沒有後端也沒有收音，這是「演一通電話」的舞台裝置。
 *
 * 完成信號：段落跑完 document.title = "TOUR-DONE"（tools/record_demo.py 輪詢）。
 * 手動看：serve.py 起本機 → http://127.0.0.1:PORT/demo/tour.html?seg=phone。
 */
import { SpritePlayer } from "../js/sprite.js";
import { MouthDriver } from "../js/audio-mouth.js";
import { renderFrame, renderSceneLine, CallLogRenderer } from "../js/chat.js";
import { CgPresenter, buildCgPanel } from "../js/cg.js";
import { AdvPresenter } from "../js/adv.js";
import { PhoneController } from "../js/phone.js";
import { SettingsPanel } from "../js/settings.js";
import { initThemes } from "../js/theme.js";
import { createAdvVisibility } from "../js/adv-visibility.js";
import { ExpressionController } from "../js/expression.js";
import { BlushController } from "../js/blush.js";
import { FurnitureManager } from "../js/furniture.js";
import { stripMarkers } from "../js/chat.js";
import { initI18n, applyConfigLocale, getLocale, t, tEl, tAttr, pickLabel } from "../js/i18n.js";
import zhLines from "./tour-lines.zh-Hant.js";
import enLines from "./tour-lines.en.js";

// ── 語系層：台詞另檔（tour-lines.*.js，經 L() 查表）＋共用 UI 字典
// （../js/locales/*.js，經 t()／tEl()／tAttr()，同 app.js 用法）。各 SCRIPT
// 常數因此必須是函式而非模組頂層陣列——模組頂層求值早於 main() 呼叫
// initI18n() 判定語系，這時候 L() 還拿不到正確語系。
const LINES = { "zh-Hant": zhLines, en: enLines };
const L = () => LINES[getLocale()] || LINES["zh-Hant"];

// ── 與 app.js 同款的 config 載入＋UI 素材皮注入（demo 允許輕複製，不動主程式）──
const HARD_DEFAULTS = {
  characterName: "Sample",
  assetsPath: "assets/sample/",
  layout: { desktopSpriteWidth: "42%" },
};

async function loadConfig() {
  try {
    const res = await fetch("config.json");
    if (res.ok) return await res.json();
  } catch (e) { /* fallback below */ }
  try {
    const res = await fetch("config.example.json");
    if (res.ok) return await res.json();
  } catch (e) { /* fallback below */ }
  return HARD_DEFAULTS;
}

const UI_SKIN_VARS = {
  "--ui-bg-room": "bg-room.webp",
  "--ui-chatlog-frame": "chatlog-frame.svg",
  "--ui-brand-ornament": "deco-compass.webp",
  "--ui-settings-frame": "settings-frame.webp",
  "--ui-btn-call": "btn-call.webp",
  "--ui-btn-hangup": "btn-hangup.webp",
  "--ui-btn-menu": "btn-menu.webp",
};
function applyUiSkin(config) {
  const ui = config && config.ui;
  if (!ui || typeof ui.path !== "string" || !ui.path) return;
  const base = ui.path.replace(/["\\]/g, "");
  const root = document.documentElement;
  for (const [cssVar, file] of Object.entries(UI_SKIN_VARS)) {
    const abs = new URL(base + file, document.baseURI).href;
    root.style.setProperty(cssVar, 'url("' + abs + '")');
  }
  document.body.classList.add("has-ui-skin");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function clickVisible(selector) {
  // 桌機／手機各有一套入口鈕（side-btn vs dock-btn），點「當前可見」那顆。
  for (const el of document.querySelectorAll(selector)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) {
      el.click();
      return true;
    }
  }
  return false;
}

// ── 主對話段腳本（台詞刻意拉長——嘴型跟句長走，長句才好看）─────────
const chatScript = () => [
  { type: "wait", ms: 2600 }, // 開場：立繪 idle（眨眼＋呼吸）＋介面全景
  { type: "sent", text: L().chat.sent1 },
  { type: "thinking", ms: 2200 },
  {
    type: "reply",
    text: L().chat.reply1,
    thoughts: L().chat.reply1Thoughts,
  },
  { type: "wait", ms: 1600 },
  { type: "thoughts-open", ms: 3800 }, // Thinking 鈕：點開看他沒說出口的
  { type: "sent", text: L().chat.sent2 },
  { type: "thinking", ms: 1900 },
  {
    type: "reply",
    text: L().chat.reply2,
  },
  { type: "wait", ms: 1300 },
  { type: "sent", text: L().chat.sent3 },
  { type: "thinking", ms: 2000 },
  {
    type: "reply",
    text: L().chat.reply3,
  },
  { type: "wait", ms: 1400 },
  { type: "eye", ms: 3800 }, // 眼睛鈕：收起對話框＝立繪欣賞模式
  { type: "sent", text: L().chat.sent4 },
  { type: "thinking", ms: 1700 },
  {
    type: "reply",
    text: L().chat.reply4,
  },
  { type: "wait", ms: 1800 },
];

// ── 共用舞台（各段都要的：config／皮／立繪／ADV）────────────────────────────
async function bootStage() {
  const config = await loadConfig();
  // config.locale（自架者釘死；"auto"／缺鍵略過）補第三順位；URL／localStorage
  // 已有明確語系時這支是 no-op（見 i18n.js applyConfigLocale／explicitSource）。
  applyConfigLocale(config);
  applyUiSkin(config);
  const displayName =
    (config.displayName && String(config.displayName)) || config.characterName || "Sample";
  const nameEl = document.getElementById("char-name");
  if (nameEl) nameEl.textContent = displayName;

  // 左上品牌位：demo 固定顯示 "AI Model"（與 app.js 沙盒暗號同字樣）——觀眾
  // 一眼看懂這是「跟 AI model 聊天」的介面；產品名交給頁題與 README，不佔畫面。
  // （正式版該位＝模型名→brandTitle fallback，見 app.js showModelOnBrand。）
  const brandTitleEl = document.getElementById("brand-title");
  if (brandTitleEl) brandTitleEl.textContent = "AI Model";

  // 主題素材（房間背景／徽章／Chat Log 框）：所有段共用——首項主題帶 assets
  // 即自動注入（走真產品碼 initThemes，同 app.js 開機路徑）。
  const themeMgr = initThemes(config);

  const ctx = { characterName: config.characterName, assetsBase: config.assetsPath };
  const msgsEl = document.getElementById("msgs");

  // 立繪：造型清單（chat／phone／settings 恆用首套造型；
  // appearance 段展示「換外觀的行為」，會切到第二套再切回）。
  const appearances = Array.isArray(config.appearances) && config.appearances.length
    ? config.appearances.filter((a) => a && a.id && a.assetsPath)
    : [{ id: "default", label: t("appearance.defaultOutfit"), assetsPath: config.assetsPath }];
  const sprite = new SpritePlayer(document.getElementById("stage"), {
    assetsPath: appearances[0].assetsPath,
  });
  try {
    await sprite.load();
    sprite.startIdle();
  } catch (e) {
    console.warn("[tour] sprite degraded:", e);
  }

  const adv = new AdvPresenter({
    container: document.getElementById("adv-root"),
    characterName: displayName,
    // 導覽零 TTS＝打字機吐字一律 pakupaku 動嘴。
    onTypingChange: (typing) => {
      if (typing) sprite.startTalking();
      else sprite.stopTalking();
    },
  });

  // 表情／臉紅（同 app.js：幀同步鉤子＋從 manifest 自報素材；無鍵造型＝整族靜默）
  const stageEl = document.getElementById("stage");
  const blush = new BlushController(stageEl);
  const expr = new ExpressionController(stageEl);
  expr.bind(sprite);
  expr.syncFrom(sprite.manifest, appearances[0].assetsPath);
  blush.syncFrom(sprite.manifest, appearances[0].assetsPath);

  // 家具（config.furniture 驅動；同 app.js 掛在 #stage-bg 之後）。demo 舞台不寫
  // localStorage：關掉 _save、狀態從空白開始＝一律走 defaultOn（錄影可重現、也不會
  // 動到同源正式頁的放置記錄）。
  const furniture = new FurnitureManager(document.getElementById("stage-bg"), config.furniture);
  furniture._save = () => {};
  furniture._state = {};
  furniture._render();

  return { config, ctx, msgsEl, sprite, adv, appearances, displayName, themeMgr, blush, expr, furniture };
}

// ── 共用：一句角色回覆（暗號同產品路徑：Chat Log 泡泡與 ADV 都只上剝乾淨的字，
//    [blush]／[expr:] 由 final reply 觸發臉紅／表情；step.room＝後端替身推回的
//    room_state 片段，直接套家具）─────────────────────────────────────────
async function presentReply(stage, step) {
  const { ctx, msgsEl, adv, blush, expr, furniture } = stage;
  const parsed = stripMarkers(step.text);
  renderFrame({ role: "assistant", text: step.text }, msgsEl, ctx); // renderFrame 自己剝
  adv.present(parsed.text, { thoughts: step.thoughts });
  if (parsed.blushLevel) blush.show(parsed.blushLevel);
  if (parsed.exprId) expr.show(parsed.exprId); else expr.release();
  if (step.room && step.room.furniture && furniture) {
    for (const [id, on] of Object.entries(step.room.furniture)) furniture.setOn(id, on);
  }
  const hold = typeof step.holdMs === "number" ? step.holdMs : 3000;
  await sleep(parsed.text.length * 30 + hold);
}

// ── 共用：眼睛鍵→視窗鈕＝收起 ADV（立繪欣賞模式，產品同一顆狀態），不自動復原──
async function advHideStay() {
  const eyeBtn = document.querySelector(".js-eye-menu");
  const eyeSub = document.querySelector(".eye-sub");
  const setOpen = (open) => {
    if (!eyeSub || !eyeBtn) return;
    eyeSub.hidden = !open;
    eyeBtn.setAttribute("aria-expanded", String(open));
    eyeBtn.classList.toggle("is-open", open);
  };
  setOpen(true);
  await sleep(700);
  document.body.classList.add("hide-adv");
  await sleep(250);
  setOpen(false);
  await sleep(600);
}

// ── 段落：expressions（表情與臉紅——角色自己在回覆裡夾暗號）────────────────
// 台詞原則同 chat 段：情話走精神層面、產品真實能力入情話（留聲機在場就順口提）。
const expressionsScript = () => [
  { type: "wait", ms: 1600 },
  { type: "adv-hide" }, // 收起對話框：完整立繪＋家具入鏡（8/18）
  { type: "wait", ms: 1400 },
  { type: "sent", text: L().expressions.sent1 },
  { type: "thinking", ms: 1800 },
  { type: "reply", text: L().expressions.reply1, holdMs: 2600 },
  { type: "wait", ms: 800 },
  { type: "sent", text: L().expressions.sent2 },
  { type: "thinking", ms: 1600 },
  { type: "reply", text: L().expressions.reply2, holdMs: 2600 },
  { type: "wait", ms: 800 },
  { type: "sent", text: L().expressions.sent3 },
  { type: "thinking", ms: 1700 },
  { type: "reply", text: L().expressions.reply3, holdMs: 3400 },
  { type: "wait", ms: 1600 },
];

async function segExpressions(stage) {
  await runScript(stage, expressionsScript());
}

// ── 段落：room（房間自主權——角色說要搬留聲機，房間就變）───────────────────
const roomScript = () => [
  { type: "furniture", set: { gramophone: false } }, // 開場先收起：等他親手搬出來
  { type: "wait", ms: 1500 },
  { type: "adv-hide" },
  { type: "wait", ms: 1400 },
  { type: "sent", text: L().room.sent1 },
  { type: "thinking", ms: 1800 },
  { type: "reply", text: L().room.reply1, room: { furniture: { gramophone: true } }, holdMs: 3200 },
  { type: "wait", ms: 900 },
  { type: "sent", text: L().room.sent2 },
  { type: "thinking", ms: 1600 },
  { type: "reply", text: L().room.reply2, holdMs: 3000 },
  { type: "wait", ms: 1600 },
];

async function segRoom(stage) {
  await runScript(stage, roomScript());
}

// ── 段落：thinking（對話框在、Thinking 鈕一開一關）─────────────────────────
const thinkingScript = () => [
  { type: "wait", ms: 1800 },
  { type: "sent", text: L().thinking.sent1 },
  { type: "thinking", ms: 1800 },
  {
    type: "reply",
    text: L().thinking.reply1,
    thoughts: L().thinking.reply1Thoughts,
    holdMs: 2200,
  },
  { type: "wait", ms: 900 },
  { type: "thoughts-open", ms: 3800 },
  { type: "sent", text: L().thinking.sent2 },
  { type: "thinking", ms: 1500 },
  { type: "reply", text: L().thinking.reply2, holdMs: 2400 },
  { type: "wait", ms: 1400 },
];

async function segThinking(stage) {
  await runScript(stage, thinkingScript());
}

// ── 共用腳本執行器（新段用；chat 段的 segChat 保持原樣不動）────────────────
async function runScript(stage, script) {
  const { ctx, msgsEl, adv, furniture } = stage;
  for (const step of script) {
    if (step.type === "wait") {
      await sleep(step.ms);
    } else if (step.type === "sent") {
      renderFrame({ role: "sent", text: step.text }, msgsEl, ctx);
      await sleep(1100);
    } else if (step.type === "thinking") {
      adv.thinking("");
      await sleep(step.ms);
    } else if (step.type === "reply") {
      await presentReply(stage, step);
    } else if (step.type === "thoughts-open") {
      clickVisible(".adv-thinking-btn");
      await sleep(step.ms);
      clickVisible(".adv-thinking-btn");
      await sleep(500);
    } else if (step.type === "adv-hide") {
      await advHideStay();
    } else if (step.type === "furniture") {
      if (furniture) for (const [id, on] of Object.entries(step.set)) furniture.setOn(id, on);
    }
  }
}

// ── 段落：chat ───────────────────────────────────────────────────────────────
async function segChat(stage) {
  const { ctx, msgsEl, adv } = stage;
  for (const step of chatScript()) {
    if (step.type === "wait") {
      await sleep(step.ms);
    } else if (step.type === "sent") {
      renderFrame({ role: "sent", text: step.text }, msgsEl, ctx);
      await sleep(1100);
    } else if (step.type === "thinking") {
      adv.thinking("");
      await sleep(step.ms);
    } else if (step.type === "reply") {
      renderFrame({ role: "assistant", text: step.text }, msgsEl, ctx);
      adv.present(step.text, { thoughts: step.thoughts });
      // 等打字機吐完（30ms/字）＋讀字緩衝 3s，再進下一步
      await sleep(step.text.length * 30 + 3000);
    } else if (step.type === "thoughts-open") {
      clickVisible(".adv-thinking-btn");
      await sleep(step.ms);
      clickVisible(".adv-thinking-btn"); // 切回正文
      await sleep(500);
    } else if (step.type === "eye") {
      await eyeHide(step.ms); // 模組層 demo 鷹架（function declaration hoisting）
    }
  }
}

// ── 段落：phone（內容進 Chat Log＋句尾 play）────────────────
// demo 鷹架：/api/call/* 打樁＋跳過真麥克風；「他的聲音」用公開 sample 音檔驅動
// 嘴型（影片本身無聲，觀眾看到的是：接通→字進聊天→講完句尾有 play→掛斷→重播動嘴）。
const DEMO_VOICE = "assets/sample/ring.mp3";

function stubCallApi() {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    const json = (obj) =>
      Promise.resolve(new Response(JSON.stringify(obj), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    if (url.startsWith("/api/call/start")) return json({ call_id: "demo" });
    if (url.startsWith("/api/call/end")) return json({ ok: true });
    if (url.startsWith("/api/call/log")) {
      return json({ calls: [], usage: {}, config: { silence_sec: 3 } });
    }
    return realFetch(input, init);
  };
}

async function segPhone(stage) {
  const { config, ctx, msgsEl, sprite, adv } = stage;
  stubCallApi();
  const driver = new MouthDriver(sprite, {});
  // 重播動嘴（app.js replayHooks 的 demo 迷你版）：play 鍵開播＝立繪動嘴。
  const phoneCtx = {
    ...ctx,
    replayHooks: {
      before: () => !phone.isActive(),
      attach: (el) => { try { driver.attach(el); } catch (e) { /* demo 環境缺 WebAudio 時純播聲 */ } },
      detach: () => { try { driver.detach(); } catch (e) { /* no-op */ } },
    },
  };
  const callLog = new CallLogRenderer(msgsEl, phoneCtx);
  // 通話台詞的 ADV 同步 buffer（app.js callAdvBuf 同語意：逐句累積、final 收輪）。
  let callAdvBuf = "";
  let callAdvTurnDone = false;
  // 通話狀態→左側欄鈕雙態＋計時 pill（app.js onCallState 接線的 demo 迷你版）。
  const callPill = document.getElementById("call-pill");
  const fmt = (s) => `${s < 600 ? "0" : ""}${Math.floor(s / 60)}:${s % 60 < 10 ? "0" : ""}${s % 60}`;
  const phone = new PhoneController({
    driver,
    chatClient: { send: () => true },
    container: document.getElementById("phone-root"),
    config,
    onStatusNote: (text) => renderFrame({ role: "system", text }, msgsEl, phoneCtx),
    onCallContent: (ev) => {
      if (!ev) return;
      if (ev.type === "character") {
        callLog.characterSentence(ev.text, ev.audio, ev.final);
        // 「兩邊要對上」（app.js 同款接線）：他在通話裡說的話，ADV 對話框
        // 同步顯示——逐句累積、instant 呈現（不跑打字機、不觸發打字口型，
        // 通話嘴型由 MouthDriver 管）。demo 台詞無 [markers]，省 stripMarkers。
        if (typeof ev.text === "string" && ev.text) {
          callAdvBuf = callAdvTurnDone ? ev.text : (callAdvBuf ? callAdvBuf + "\n" + ev.text : ev.text);
          callAdvTurnDone = false;
          adv.present(callAdvBuf, { instant: true });
        }
        if (ev.final) callAdvTurnDone = true;
      } else if (ev.type === "user") callLog.userLine(ev.text);
      else if (ev.type === "thinking") renderFrame({ role: "status", text: "⋯⋯" }, msgsEl, phoneCtx);
      else callLog.sysLine(typeof ev.text === "string" ? ev.text : "");
    },
    onCallState: ({ phase, seconds }) => {
      const active = phase !== "idle";
      document.body.classList.toggle("in-call", active);
      if (callPill) {
        callPill.hidden = !active;
        callPill.textContent = phase === "dialing" ? t("call.dialing") : fmt(seconds);
      }
    },
  });
  // demo 舞台裝置：導覽頁無收音——跳過 getUserMedia 直接進「接通」。
  phone._startMic = function () { this._connected(); };

  await sleep(1600);
  renderFrame({ role: "system", text: L().phone.connected }, msgsEl, phoneCtx);
  phone.dialOut(); // 左側欄鈕原地變掛話筒＋pill 開始計時
  await sleep(2600);

  const askedLine = L().phone.user1;
  callLog.userLine(askedLine);
  phone.noteTypedUtterance(askedLine);
  await sleep(1800);

  phone.handleFrame({ role: "call", seq: 0, text: L().phone.reply1, audio: DEMO_VOICE, final: false });
  await sleep(2600);
  phone.handleFrame({
    role: "call", seq: 1,
    text: L().phone.reply2,
    audio: DEMO_VOICE, final: false,
  });
  await sleep(4200);
  phone.handleFrame({
    role: "call", seq: 2,
    text: L().phone.reply3,
    audio: DEMO_VOICE, final: true,
  });
  await sleep(3600);

  phone.hangUp(); // 掛斷＝左側欄鈕復位、pill 收起
  adv.present("", { instant: true }); // 通話字幕清場（app.js 掛斷清殘留同語意）
  await sleep(1400);
  renderFrame({ role: "system", text: L().phone.ended }, msgsEl, phoneCtx);
  await sleep(1200);

  clickVisible(".msg-play-btn"); // 泡泡外 play：重播他的話＝立繪動嘴
  await sleep(4200);
  clickVisible(".msg-play-btn.playing"); // 再點＝停
  await sleep(1200);
}

// ── 段落：appearance（「角色造型」＋「介面主題」兩區——
// 開面板一覽（造型＋主題兩區）→關面板→主畫面五套主題輪播→回預設；面板 DOM
// 比照 app.js 輕複製、主題注入走真產品碼 initThemes）──────────────────────────
async function segAppearance(stage) {
  const { config, ctx, msgsEl, sprite, adv, appearances, themeMgr, furniture } = stage;
  // 主題段只看房間：示範家具先收起（8/19 回饋：五套主題輪播不要帶留聲機；room 段自己會演它現身）。
  if (furniture && Array.isArray(config.furniture)) {
    for (const item of config.furniture) furniture.setOn(item.id, false);
  }
  const root = document.getElementById("appearance-root");
  const panel = document.createElement("div");
  panel.className = "settings-panel appearance-panel";
  panel.hidden = true;
  const sheet = document.createElement("div");
  sheet.className = "appearance-sheet";
  const heading = document.createElement("h2");
  heading.className = "settings-heading";
  tEl(heading, "appearance.title");
  const sectionLabel = (text) => {
    const el = document.createElement("p");
    el.className = "appearance-section-label";
    el.textContent = text;
    return el;
  };

  const list = document.createElement("div");
  list.className = "appearance-list";
  const cards = [];
  let current = appearances[0];
  const markActive = () => {
    cards.forEach(({ card, ap }) => {
      const on = ap.id === current.id;
      card.classList.toggle("is-active", on);
      const tag = card.querySelector(".appearance-card-tag");
      // 用中才掛 tEl；不使用中要清乾淨連 dataset.i18n 一併刪，否則語系切換
      // 重譯時會把已清空的卡片重新寫回「使用中」字樣（同 app.js markActive）。
      if (on) tEl(tag, "appearance.inUse");
      else { tag.textContent = ""; delete tag.dataset.i18n; }
    });
  };
  appearances.forEach((ap) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "appearance-card";
    const cardName = document.createElement("span");
    cardName.className = "appearance-card-name";
    cardName.textContent = pickLabel(ap.label) || ap.id;
    const cardTag = document.createElement("span");
    cardTag.className = "appearance-card-tag";
    card.appendChild(cardName);
    card.appendChild(cardTag);
    card.addEventListener("click", async () => {
      if (ap.id === current.id) return;
      try {
        await sprite.switchTo(ap.assetsPath);
        sprite.startIdle();
        current = ap;
      } catch (e) {
        console.warn("[tour] switch failed:", e);
      }
      markActive();
    });
    cards.push({ card, ap });
    list.appendChild(card);
  });
  markActive();
  sheet.appendChild(heading);
  sheet.appendChild(sectionLabel(t("appearance.tabOutfits")));
  sheet.appendChild(list);

  // 介面主題區（app.js 輕複製：swatch 三色點＋active 標記）
  const themeCards = [];
  if (themeMgr.list.length > 1) {
    const thList = document.createElement("div");
    thList.className = "appearance-list";
    const thMarkActive = () => {
      themeCards.forEach(({ card, theme }) => {
        const on = theme.id === themeMgr.current;
        card.classList.toggle("is-active", on);
        const tag = card.querySelector(".appearance-card-tag");
        if (on) tEl(tag, "appearance.inUse");
        else { tag.textContent = ""; delete tag.dataset.i18n; }
      });
    };
    themeMgr.list.forEach((theme) => {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "appearance-card";
      const cardName = document.createElement("span");
      cardName.className = "appearance-card-name";
      cardName.textContent = pickLabel(theme.label);
      const swatch = document.createElement("span");
      swatch.className = "theme-swatch";
      const vars = theme.vars || {};
      [vars.line || "rgba(190,218,255,.88)", vars.btnBg || "#2b3f6b", vars.accent || "rgba(232,242,255,.96)"].forEach((color) => {
        const dot = document.createElement("span");
        dot.className = "theme-swatch-dot";
        dot.style.background = color;
        swatch.appendChild(dot);
      });
      const cardTag = document.createElement("span");
      cardTag.className = "appearance-card-tag";
      const right = document.createElement("span");
      right.className = "theme-swatch";
      right.appendChild(swatch);
      right.appendChild(cardTag);
      card.appendChild(cardName);
      card.appendChild(right);
      card.addEventListener("click", () => {
        if (theme.id === themeMgr.current) return;
        themeMgr.apply(theme.id);
        thMarkActive();
      });
      themeCards.push({ card, theme });
      thList.appendChild(card);
    });
    thMarkActive();
    sheet.appendChild(sectionLabel(t("appearance.tabThemes")));
    sheet.appendChild(thList);
  }

  panel.appendChild(sheet);
  root.appendChild(panel);

  await sleep(1800);
  // 引子：把「換氣氛」的選擇權交給使用者
  const introLine = L().appearance.intro;
  renderFrame({ role: "assistant", text: introLine }, msgsEl, ctx);
  adv.present(introLine);
  await sleep(introLine.length * 30 + 2000);

  panel.hidden = false; // 開外觀面板：造型區＋主題五卡一覽
  await sleep(3500);
  panel.hidden = true;  // 關面板回主畫面
  await sleep(1000);

  // 主畫面輪播五套主題（開場已是預設 crystal-swan，從第二套起、末尾回預設）
  for (const i of [1, 2, 3, 4, 0]) {
    const theme = themeMgr.list[i];
    if (!theme) continue;
    themeMgr.apply(theme.id);
    await sleep(3200);
  }

  const outroLine = L().appearance.outro;
  renderFrame({ role: "assistant", text: outroLine }, msgsEl, ctx);
  adv.present(outroLine);
  await sleep(outroLine.length * 30 + 2600);
}

// ── 段落：settings（開設定→語音朗讀開關→顯示立繪開關→嘴型速度拉桿；拉桿
// 有真實作用的開合拍速自助調整）───────────────────────
async function segSettings(stage) {
  const { sprite } = stage;
  const driver = new MouthDriver(sprite, {});
  const settingsPanel = new SettingsPanel({
    container: document.getElementById("settings-root"),
    driver,
    // 顯示立繪開關的 demo 接線（app.js 同語意：body.no-sprite 切換）
    onSpriteVisibleChange: (visible) => {
      document.body.classList.toggle("no-sprite", !visible);
    },
    // 嘴型速度拉桿的 demo 接線（app.js applyMouthSpeed 同款雙餵）
    onMouthSpeedChange: (ms) => {
      driver.setFlapMs(ms);
      sprite.setTalkInterval(ms);
    },
    modelOptions: null, // demo 無後端——模型區整區不出現（settings.js 既有語意）
    modelEndpoint: null,
    getCurrentModel: () => null,
    onModelChange: () => {},
  });

  await sleep(1500);
  settingsPanel.toggle(); // 開設定
  await sleep(2000);
  const toggles = document.querySelectorAll(".settings-toggle");
  if (toggles[0]) toggles[0].click(); // 語音朗讀開關（第一列）
  await sleep(1600);
  if (toggles[0]) toggles[0].click(); // 撥回
  await sleep(1400);
  if (toggles[1]) toggles[1].click(); // 顯示立繪：關（立繪淡出）
  await sleep(2200);
  if (toggles[1]) toggles[1].click(); // 開（立繪回來）
  await sleep(1600);
  // 嘴型速度拉桿：搭配打字口型讓「調速」看得見——先開講、拖快、拖慢
  const slider = document.querySelector(".settings-speed-slider");
  if (slider) {
    sprite.startTalking(); // 舞台裝置：讓嘴動著給拉桿當對照
    const setVal = (v) => {
      slider.value = String(v);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    };
    await sleep(900);
    setVal(Number(slider.max));  // 拖到最快
    await sleep(1900);
    setVal(Number(slider.min));  // 拖到最慢
    await sleep(1900);
    setVal(135);                 // 回預設（105ms 的鏡射值）
    sprite.stopTalking();
    await sleep(700);
  }
  settingsPanel.toggle(); // 關設定
  await sleep(1200);
}

// 眼睛演出（demo 鷹架）：tour 頁不載 app.js，眼睛家族的 click 接線不存在——
// 照 demo「打樁不搬主程式」哲學（同 stubCallApi／_startMic 先例），直接操作
// 與產品同一套 DOM 狀態（.eye-sub hidden／body.hide-adv，視覺效果＝layout.css
// 同一份），不寫 localStorage（錄影環境不留記憶污染）。
async function eyeHide(holdMs) {
  const eyeBtn = document.querySelector(".js-eye-menu");
  const eyeSub = document.querySelector(".eye-sub");
  const setOpen = (open) => {
    if (!eyeSub || !eyeBtn) return;
    eyeSub.hidden = !open;
    eyeBtn.setAttribute("aria-expanded", String(open));
    eyeBtn.classList.toggle("is-open", open);
  };
  setOpen(true); // 展開子鈕組（觀眾看到入口）
  await sleep(250);
  document.body.classList.add("hide-adv"); // 收起對話框＝立繪欣賞模式
  setOpen(false); // 收框即收子鈕組——欣賞畫面零 UI 雜物
  await sleep(holdMs);
  document.body.classList.remove("hide-adv"); // 復原（幕後快速，不再展開子鈕）
  await sleep(500);
}

// ── 段落：cg（CG 場景演出）─────────────────────────────────────────────────
// applyState 直接餵前端＝後端 cg_state frame 的替身（同 phone 段打樁哲學）：
// 開場景（opening 卡自動選）→ 依情節切換兩次（演「AI 下指令換景」）→ 退場
// crossfade 回房間。CG 演出中 ADV 對話框讓位（壓在 CG 上會遮人物），
// 台詞一律走 Chat Log 泡泡壓圖＝安全區實際效果一目了然；「cg-active
// 藏 ADV」規則已入殼（adv-visibility.js），本段改走與產品同款的狀態機——這裡
// 的手動 add/remove 鷹架退役。
async function segCg({ msgsEl, ctx, adv }) {
  const cg = new CgPresenter({
    endpointBase: "../api/v4/cg",
    listEl: msgsEl,
    renderLine: (name) => renderSceneLine(msgsEl, ctx, name),
  });
  const ok = await cg.init();
  if (!ok) {
    renderFrame({ role: "system", text: L().cg.noAlbum }, msgsEl, ctx);
    return;
  }
  // CG 開／關門的 ADV 讓位，同產品碼 adv-visibility.js 三層狀態機（見 app.js
  // cg_state 接線）；demo 舞台不落 localStorage，base 用 in-memory 變數即可
  // （重播／整頁重整每次乾淨），也省了 aria-label 維護（本頁眼睛鈕無 click
  // 接線，見上方 eyeHide 註解）。
  let advBase = true;
  const advVis = createAdvVisibility({
    getBase: () => advBase,
    setBase: (v) => { advBase = v; },
    onRender: (v) => document.body.classList.toggle("hide-adv", !v),
  });
  await sleep(1800);
  renderFrame({ role: "sent", text: L().cg.user1 }, msgsEl, ctx);
  await sleep(1400);
  adv.thinking("");
  await sleep(1600);
  const line1 = L().cg.line1;
  renderFrame({ role: "assistant", text: line1 }, msgsEl, ctx);
  adv.present(line1); // 進 CG 前最後一句還在 ADV 講（打字動嘴收尾）
  await sleep(line1.length * 30 + 2200);

  cg.applyState({ intimate: true, scene: null }); // 開場景：opening 卡自動選
  advVis.setIntimate(true); // CG 開始＝對話框自動讓位（見檔頭註解）
  await sleep(4500); // 全景賞圖（ADV 已退場、Chat Log 壓圖）

  renderFrame({ role: "assistant", text: L().cg.line2 }, msgsEl, ctx);
  await sleep(3400);
  cg.applyState({ intimate: true, scene: "5.png" }); // 情節推進：換景一
  await sleep(4600);

  renderFrame({ role: "assistant", text: L().cg.line3 }, msgsEl, ctx);
  await sleep(3800);
  cg.applyState({ intimate: true, scene: "9.png" }); // 情節推進：換景二
  await sleep(4600);

  renderFrame({ role: "assistant", text: L().cg.line4 }, msgsEl, ctx);
  await sleep(4000);
  cg.applyState({ intimate: false }); // 退場 crossfade 回房間
  advVis.setIntimate(false); // 回房間＝對話框回歸
  await sleep(2600);
  // 結尾重新亮開場景並停住——讓觀看者慢慢端詳構圖與 Chat Log 壓圖效果
  // （錄影版掐在退場 crossfade 結束；重新整理＝從頭重演）。
  cg.applyState({ intimate: true, scene: null });
  advVis.setIntimate(true); // 停景同規則：CG 態＝對話框讓位
  renderFrame({ role: "system", text: L().cg.ended }, msgsEl, ctx);
}

// ── 段落：cg-manage（CG 相冊的管理態：進相冊 → 扳手進管理 → 首屏見分組 TAB／
//    上傳列／前幾張卡 → 往下捲看清單其餘卡片（上下移／改名／描述／開場候選旗）
//    到清單尾 → 捲回頂 → 切手機組 → 返回相冊）────────────────────────────────
// 8/18 需求：「進到 CG 後，去管理 CG 的地方下拉展示一下，讓觀眾知道可以在這裡管理 CG」。
// 只展示不操作：mock 是靜態檔，POST 不會成功；畫面上不按儲存／刪除／上傳。
// DOM 順序提醒（cg.js renderManage()）：TAB 住 .cg-pinned 固定槽（捲動區外
// 常駐），捲動容器 .cg-stage 內依序疊上傳列 → 卡片清單——上傳列在「頂」不
// 在「底」，下拉捲到底看到的是清單最後幾張卡，節奏照這個真實順序走。
async function smoothScroll(el, to, ms) {
  const from = el.scrollTop;
  const t0 = performance.now();
  await new Promise((done) => {
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / ms);
      const e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; // easeInOutQuad
      el.scrollTop = from + (to - from) * e;
      if (p < 1) requestAnimationFrame(tick); else done();
    };
    requestAnimationFrame(tick);
  });
}

/** 輪詢等 fn() 為真（每 50ms 一次，逾時就放棄不拋錯）——enterManage() 是 async
 * fetch，「點扳手」到「清單真的進 DOM」中間有一段不確定的等待，靠固定 sleep
 * 賭時間會賭輸；這裡等的是事實（`.cg-manage-list` 是否已存在），不是猜時間。 */
async function waitFor(fn, ms) {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(50);
  }
  return !!fn();
}

async function segCgManage({ msgsEl, ctx }) {
  const cg = new CgPresenter({
    endpointBase: "../api/v4/cg",
    listEl: msgsEl,
    renderLine: (name) => renderSceneLine(msgsEl, ctx, name),
  });
  const ok = await cg.init();
  if (!ok) {
    renderFrame({ role: "system", text: L().cg.noAlbum }, msgsEl, ctx);
    return;
  }
  const panel = buildCgPanel(document.getElementById("cg-root"), cg, {
    send: () => false,                 // 示範不送 /cg（點卡也不會入景）
    endpointBase: "../api/v4/cg",      // 有值＝扳手／管理態可用（同 index 接線）
  });
  await sleep(1600);                   // 開場：房間＋立繪 idle
  panel.open();                        // 進相冊（視圖態：卡片＋開場景標記）
  await sleep(2600);
  const stage = panel.el.querySelector(".cg-stage"); // 捲動容器（sheet 是 flex 直欄不捲）
  const wrench = panel.el.querySelector(".cg-manage-btn");
  if (wrench) wrench.click(); else await panel.enterManage();
  await waitFor(() => panel.el.querySelector(".cg-manage-list"), 3000); // 等清單真的渲染完再開始計時
  await sleep(2000);                   // 管理態首屏：分組 TAB＋上傳列＋前幾張卡（check png 落點）
  if (stage) {
    await smoothScroll(stage, stage.scrollHeight - stage.clientHeight, 4200); // 下拉展示：從上傳列一路捲到清單尾
    await sleep(1200);                 // 停在清單尾（最後幾張卡）
    await smoothScroll(stage, 0, 1400);
    await sleep(1000);                 // 回到頂：TAB 常駐、上傳列再入鏡
  }
  const tabs = panel.el.querySelectorAll(".cg-manage-tab");
  if (tabs[1]) { tabs[1].click(); await sleep(2200); }   // 手機組（直式構圖那組）
  if (tabs[0]) { tabs[0].click(); await sleep(1200); }
  const back = panel.el.querySelector(".cg-back-btn");
  if (back && !back.hidden) back.click(); else await panel.exitManage();
  await sleep(1800);                   // 回相冊視圖收尾（畫面停在相冊）
}

// ── 段落：mobile-chat（手機專屬：半身立繪短輪對話＋Chat Log 收合）──────────
// 手機腳本短輪快節奏（螢幕小、觀眾看的是 UI 適配與收合互動）。
// 手機 CSS 藏 #adv-root（layout.css 手機段）——adv.present／thinking 在本段的
// 作用是驅動立繪口型與節奏，字幕呈現走 Chat Log 泡泡。
const mobileChatScript = () => [
  { type: "wait", ms: 2000 },
  { type: "sent", text: L().mobileChat.sent1 },
  { type: "thinking", ms: 1600 },
  { type: "reply", text: L().mobileChat.reply1 },
  { type: "sent", text: L().mobileChat.sent2 },
  { type: "thinking", ms: 1400 },
  { type: "reply", text: L().mobileChat.reply2 },
  { type: "chatlog-toggle", ms: 4000 }, // 收合＝全身立繪欣賞，hold 後展開
  { type: "sent", text: L().mobileChat.sent3 },
  { type: "thinking", ms: 1200 },
  { type: "reply", text: L().mobileChat.reply3 },
  { type: "wait", ms: 1500 },
];

async function segMobileChat(stage) {
  const { ctx, msgsEl, adv } = stage;
  for (const step of mobileChatScript()) {
    if (step.type === "wait") {
      await sleep(step.ms);
    } else if (step.type === "sent") {
      renderFrame({ role: "sent", text: step.text }, msgsEl, ctx);
      await sleep(1100);
    } else if (step.type === "thinking") {
      adv.thinking("");
      await sleep(step.ms);
    } else if (step.type === "reply") {
      renderFrame({ role: "assistant", text: step.text }, msgsEl, ctx);
      adv.present(step.text);
      await sleep(step.text.length * 30 + 2600);
    } else if (step.type === "chatlog-toggle") {
      // demo 鷹架：tour 頁不載 app.js、.js-toggle-chatlog 無 click 接線——直接
      // 切與產品同一個 body class（hide-chatlog，layout.css 手機段同一份規則）。
      document.body.classList.add("hide-chatlog"); // 收合＝全身立繪欣賞
      await sleep(step.ms);
      document.body.classList.remove("hide-chatlog"); // 展開復原
      await sleep(600);
    }
  }
}

// ── 段落：mobile-cg（手機專屬：角色主動演出——cg_state 由角色端驅動）────────
// 手機組單張（opening 卡），演「主動亮起」；劇情走睡前情境。停景收尾。
// 手機無 ADV（CSS 藏）且 CG 態立繪讓位＝adv 呼叫無視覺意義，本段不用 adv；
// 亮圖瞬間 Chat Log 短暫收合＝構圖完整亮相（別遮臉）。
async function segMobileCg({ msgsEl, ctx }) {
  const cg = new CgPresenter({
    endpointBase: "../api/v4/cg",
    listEl: msgsEl,
    renderLine: (name) => renderSceneLine(msgsEl, ctx, name),
  });
  const ok = await cg.init();
  if (!ok) {
    renderFrame({ role: "system", text: L().cg.noAlbum }, msgsEl, ctx);
    return;
  }
  await sleep(2000);
  renderFrame({ role: "sent", text: L().mobileCg.user1 }, msgsEl, ctx);
  await sleep(2200);
  renderFrame({ role: "assistant", text: L().mobileCg.line1 }, msgsEl, ctx);
  await sleep(3000);

  cg.applyState({ intimate: true, scene: null }); // 手機組 opening 卡自動亮起
  document.body.classList.add("hide-chatlog"); // 亮圖瞬間收合＝全螢幕亮相
  await sleep(4000);
  document.body.classList.remove("hide-chatlog"); // 展開＝台詞回歸壓圖
  await sleep(600);

  renderFrame({ role: "assistant", text: L().mobileCg.line2 }, msgsEl, ctx);
  await sleep(4500);
  // 停景收尾（不退場）——TOUR-DONE 由 main() 統一設
}

const SEGMENTS = {
  chat: segChat,
  phone: segPhone,
  appearance: segAppearance,
  settings: segSettings,
  cg: segCg,
  "cg-manage": segCgManage,
  "mobile-chat": segMobileChat,
  "mobile-cg": segMobileCg,
  expressions: segExpressions,
  room: segRoom,
  thinking: segThinking,
};

async function main() {
  // 語系判定先於任何 DOM／腳本文字求值（同 app.js 開機順序，見檔頭 L() 註解）。
  initI18n();
  const stage = await bootStage();
  const seg = new URLSearchParams(location.search).get("seg") || "chat";
  const run = SEGMENTS[seg] || SEGMENTS.chat;
  await run(stage);
  document.title = "TOUR-DONE"; // record_demo.py 的收工信號
}

main();

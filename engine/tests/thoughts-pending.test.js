import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdvPresenter } from "../js/adv.js";
import { renderFrame, appendThought, upsertPartialBubble, clearPartialBubble, stripMarkers } from "../js/chat.js";

// 思緒轉寫 pending 態＋thoughts 補發 frame 接收。
// 後端契約：
//   ① reply frame 新增可選鍵 `thoughts_pending`——只在 true 時出現（缺鍵＝falsy）；
//      出現時該輪 `thoughts` 恆 null、轉寫在背景跑。
//   ② 補發 frame：{"role":"thoughts","text":<str|null>,"for_ts":<該輪 reply frame
//      的 timestamp 原值>}——字串＝轉寫成功的思緒；null＝這輪最終無卡。
//   ③ 舊行為（轉寫 flag OFF）：reply frame 直接帶 thoughts 字串＝現狀，既有路徑
//      不可退化。
//
// 本檔涵蓋三層：
//   ① AdvPresenter —— present opts.thoughtsPending（is-pending 第三態＋佔位句
//      「浮現中」）＋新公開方法 updateThoughts()（字串→亮態／null→退階；正停
//      思緒頁＝原地刷新）；三態互斥；新一輪 present／thinking() 自然重置。
//   ② chat.js renderFrame —— role:"thoughts" 對它是未知 role，靜默略過（分流
//      責任在 app.js，同 "partial" 的既有慣例）。
//   ③ app.js 接線（integration 級）——thoughts frame 走 cg_state 同款旁路（不
//      觸發 end-of-stream：不動 streamArmed／streamActive、不清半成品泡泡、不進
//      Chat Log）；for_ts 對 pendingThoughtsTs 錨嚴格比對，命中＝updateThoughts
//      ＋pane append（text 字串時）、不合＝整包丟棄且不清錨；錨的生滅（reply
//      到達重算／send 清／命中清／清畫面清／斷線清）。
//
// app.js 本身自執行 main()、無 export——同 stream-partial.test.js 檔頭說明的既有
// 慣例，第③層用「照本檔實作時的 app.js 逐行對齊」的本地 harness 餵真正的
// adv.js／chat.js exports，驗證線路組起來的行為，而不是斷言 app.js 原始碼字面。

const TYPE_MS = 30; // 與 adv.js TYPE_INTERVAL_MS 對齊
const ctx = { characterName: "Sample", assetsBase: "assets/sample/" };

const PENDING_PLACEHOLDER = "（思緒浮現中⋯⋯）";
const EMPTY_PLACEHOLDER = "（這一輪他沒有留下思緒）";

function buildAdv(extra = {}) {
  const container = document.createElement("div");
  const adv = new AdvPresenter({ container, characterName: "Sample", ...extra });
  return { container, adv };
}

// ─────────────────────────────────────────────────────────────────────────────
// ① AdvPresenter —— thoughtsPending 三態＋updateThoughts()
// ─────────────────────────────────────────────────────────────────────────────
describe("AdvPresenter — thoughtsPending 第三態（is-pending）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("present 帶 thoughtsPending:true → 鈕 is-pending（非 has-thoughts）＋aria-busy；切過去是「浮現中」佔位句", () => {
    const { adv } = buildAdv();
    adv.present("正文先到", { instant: true, thoughtsPending: true });
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(true);
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false);
    expect(adv.thinkingBtn.getAttribute("aria-busy")).toBe("true");

    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe(PENDING_PLACEHOLDER);
    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("正文先到");
  });

  it("updateThoughts(字串) → 轉亮態：is-pending 除、has-thoughts 上、aria-busy 除；點開看到內容", () => {
    const { adv } = buildAdv();
    adv.present("正文", { instant: true, thoughtsPending: true });
    adv.updateThoughts("轉寫完成的思緒。");
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    expect(adv.thinkingBtn.getAttribute("aria-busy")).toBeNull();

    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("轉寫完成的思緒。");
  });

  it("updateThoughts(null) → 清 pending 回退階：兩個 class 皆無；佔位句回「沒有留下思緒」", () => {
    const { adv } = buildAdv();
    adv.present("正文", { instant: true, thoughtsPending: true });
    adv.updateThoughts(null);
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false);

    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe(EMPTY_PLACEHOLDER);
  });

  it("正停在思緒頁（看著「浮現中」）時 updateThoughts(字串)：原地刷新內容、不翻頁", () => {
    const { adv } = buildAdv();
    adv.present("正文", { instant: true, thoughtsPending: true });
    adv.thinkingBtn.click(); // 停在思緒頁
    expect(adv.textEl.textContent).toBe(PENDING_PLACEHOLDER);

    adv.updateThoughts("剛剛在等的那張卡。");
    expect(adv.textEl.textContent).toBe("剛剛在等的那張卡。"); // 原地刷新
    expect(adv.box.classList.contains("adv-showing-thoughts")).toBe(true); // 沒被翻回正文
    expect(adv.thinkingBtn.getAttribute("aria-pressed")).toBe("true");

    adv.thinkingBtn.click(); // 切回正文照常
    expect(adv.textEl.textContent).toBe("正文");
  });

  it("正停在思緒頁時 updateThoughts(null)：佔位句原地換成退階版", () => {
    const { adv } = buildAdv();
    adv.present("正文", { instant: true, thoughtsPending: true });
    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe(PENDING_PLACEHOLDER);

    adv.updateThoughts(null);
    expect(adv.textEl.textContent).toBe(EMPTY_PLACEHOLDER);
    expect(adv.box.classList.contains("adv-showing-thoughts")).toBe(true); // 頁不翻，需自己切回
  });

  it("updateThoughts(字串) 在停留正文、打字機進行中：不翻頁、不打斷續打", () => {
    const { adv } = buildAdv();
    adv.present("這句話還在打", { thoughtsPending: true }); // 打字機起跑
    vi.advanceTimersByTime(TYPE_MS * 2);
    expect(adv.textEl.textContent).toBe("這句");

    adv.updateThoughts("背景到貨的思緒");
    expect(adv.textEl.textContent).toBe("這句"); // 正文完全沒被碰
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    vi.advanceTimersByTime(TYPE_MS * 20);
    expect(adv.textEl.textContent).toBe("這句話還在打"); // 打字機照常打完
  });

  it("新一輪 present（不帶 pending）自然重置上一輪 pending 態", () => {
    const { adv } = buildAdv();
    adv.present("第一輪", { instant: true, thoughtsPending: true });
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(true);
    adv.present("第二輪", { instant: true });
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false); // 回退階
  });

  it("新一輪 present 帶 thoughts 字串：上一輪 pending 換成本輪亮態（互斥不並存）", () => {
    const { adv } = buildAdv();
    adv.present("第一輪", { instant: true, thoughtsPending: true });
    adv.present("第二輪", { instant: true, thoughts: "本輪直帶的思緒" });
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
  });

  it("防禦：thoughts 字串與 thoughtsPending 同時給（契約上不會發生）＝亮態優先、不進 pending", () => {
    const { adv } = buildAdv();
    adv.present("正文", { instant: true, thoughts: "已有思緒", thoughtsPending: true });
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
  });

  it("thinking()（新輪醞釀）重置 pending（同它對 has-thoughts 的既有語意）", () => {
    const { adv } = buildAdv();
    adv.present("上一輪", { instant: true, thoughtsPending: true });
    adv.thinking("……");
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
  });

  it("present('')（清畫面路徑）重置 pending——鈕不殘留呼吸態", () => {
    const { adv } = buildAdv();
    adv.present("正文", { instant: true, thoughtsPending: true });
    adv.present("");
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
    expect(adv.thinkingBtn.getAttribute("aria-busy")).toBeNull();
  });

  it("partial 流 present({resume:true}) 不帶 pending：上一輪殘留 pending 隨新輪串流自然收掉、續打不受影響", () => {
    const { adv } = buildAdv();
    adv.present("上一輪正文", { instant: true, thoughtsPending: true });
    adv.present("你好", {}); // 新輪重頭打
    vi.advanceTimersByTime(TYPE_MS * 5);
    expect(adv.textEl.textContent).toBe("你好");
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(false);

    adv.present("你好，今天", { resume: true }); // partial 續打
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(adv.textEl.textContent).toBe("你好，今天");
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
  });

  it("final present 帶 resume:true＋thoughtsPending：續打銜接正確＋pending 態同步上", () => {
    const { adv } = buildAdv();
    adv.present("我在想", {}); // partial 已打完
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(adv.textEl.textContent).toBe("我在想");

    adv.present("我在想你。", { resume: true, thoughtsPending: true }); // final 收尾
    expect(adv.textEl.textContent).toBe("我在想"); // 續打前不清空（不閃跳）
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(true);
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(adv.textEl.textContent).toBe("我在想你。");

    adv.updateThoughts("補發到貨。"); // 晚到卡亮
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    expect(adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
  });

  it("防禦：已亮的思緒不被 updateThoughts(null) 撤掉（null 只殺 pending，不殺已送達的卡）", () => {
    const { adv } = buildAdv();
    adv.present("正文", { instant: true, thoughts: "這輪的思緒" });
    adv.updateThoughts(null); // 斷線清掃等防禦呼叫
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("這輪的思緒");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② renderFrame —— role:"thoughts" 不是它認得的型別（分流責任在 app.js）
// ─────────────────────────────────────────────────────────────────────────────
describe('renderFrame — role:"thoughts" 未知 role 靜默略過（同 "partial" 慣例）', () => {
  it("直接餵 renderFrame 一個 thoughts frame → 不拋錯、不留 DOM（不進 Chat Log 的雙保險）", () => {
    const el = document.createElement("div");
    expect(() =>
      renderFrame({ role: "thoughts", text: "晚到的思緒", for_ts: "2026-08-10T21:00:00.000Z" }, el, ctx),
    ).not.toThrow();
    expect(el.children.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ app.js 接線（integration 級）—— thoughts frame 旁路＋for_ts 錨
//
// harness 逐行對齊本檔實作時的 app.js chat.onFrame／submit／onStatusChange／
// clearChatView 中與 pending 錨有關的邏輯（同 stream-partial.test.js 檔頭說明的
// 既有慣例），餵真正的 AdvPresenter／renderFrame／appendThought／
// upsertPartialBubble／clearPartialBubble／stripMarkers。
// ─────────────────────────────────────────────────────────────────────────────
function buildHarness() {
  const msgsEl = document.createElement("div");
  const thoughtsPaneEl = document.createElement("div");
  const { adv } = buildAdv();
  let streamArmed = false;
  let streamActive = false;
  let pendingThoughtsTs = null;

  function onFrame(frame) {
    if (frame && (frame.role === "call" || frame.role === "incoming_call" || frame.role === "incoming_call_end")) {
      clearPartialBubble(msgsEl);
      streamArmed = false;
      streamActive = false;
      return;
    }
    // 思緒補發 frame：cg_state 同款旁路——不算「這輪結束」、不動 streamArmed／
    // streamActive、不清半成品泡泡、不進 Chat Log（對齊 app.js 實作）。
    if (frame && !frame.room && frame.role === "thoughts") {
      if (pendingThoughtsTs !== null && frame.for_ts === pendingThoughtsTs) {
        pendingThoughtsTs = null; // 一輪最多一張卡：命中即清
        const text = typeof frame.text === "string" ? frame.text : null;
        adv.updateThoughts(text);
        if (text) appendThought(thoughtsPaneEl, text);
      }
      return;
    }
    if (frame && !frame.room && frame.role === "status") {
      adv.thinking(typeof frame.text === "string" ? frame.text : "");
      renderFrame(frame, msgsEl, ctx);
      return;
    }
    if (frame && !frame.room && frame.role === "partial" && typeof frame.text === "string") {
      if (!streamArmed) return;
      streamActive = true;
      const clean = stripMarkers(frame.text).text;
      adv.present(clean, { resume: true });
      upsertPartialBubble(msgsEl, clean);
      return;
    }
    if (frame && !frame.room && frame.role === "system") {
      clearPartialBubble(msgsEl);
      streamArmed = false;
      streamActive = false;
      renderFrame(frame, msgsEl, ctx);
      return;
    }
    if (frame && !frame.room && frame.role === "assistant" && typeof frame.text === "string") {
      clearPartialBubble(msgsEl);
      streamArmed = false;
      if (streamActive) frame.instant = true;
      // 對齊 app.js：pending 判定＋錨無條件重算（timestamp 缺席＝不進 pending）
      const thoughtsPending = !!frame.thoughts_pending && frame.timestamp != null;
      pendingThoughtsTs = thoughtsPending ? frame.timestamp : null;
      const finalOpts = streamActive
        ? { thoughts: frame.thoughts, thoughtsPending, resume: true }
        : { thoughts: frame.thoughts, thoughtsPending };
      streamActive = false;
      renderFrame(frame, msgsEl, ctx);
      adv.present(stripMarkers(frame.text).text, finalOpts);
      if (typeof frame.thoughts === "string") appendThought(thoughtsPaneEl, frame.thoughts);
      return;
    }
    renderFrame(frame, msgsEl, ctx);
  }

  function submitSent(text) {
    streamArmed = true;
    pendingThoughtsTs = null; // 對齊 app.js：開新輪＝舊輪晚到的卡作廢
    renderFrame({ role: "sent", text }, msgsEl, ctx);
  }

  function onStatusChange(status) {
    if (status === "open") return;
    clearPartialBubble(msgsEl);
    streamActive = false;
    streamArmed = false;
    pendingThoughtsTs = null; // 對齊 app.js：斷線＝補發已被 server 吞，卡不會來
    adv.updateThoughts(null);
  }

  function clearView() {
    msgsEl.replaceChildren();
    adv.present("");
    pendingThoughtsTs = null; // 對齊 app.js clearChatView
    thoughtsPaneEl.replaceChildren();
  }

  return {
    msgsEl, thoughtsPaneEl, adv, onFrame, submitSent, onStatusChange, clearView,
    isArmed: () => streamArmed,
    isActive: () => streamActive,
    anchor: () => pendingThoughtsTs,
  };
}

const TS_A = "2024-01-01T00:00:00.000Z";
const TS_B = "2024-01-01T00:05:00.000Z";

describe("app.js 接線 — thoughts frame 旁路＋for_ts 錨", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("reply 帶 thoughts_pending → ADV 鈕 is-pending、錨＝該輪 timestamp、pane 不 append", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "assistant", text: "在。", timestamp: TS_A, thoughts: null, thoughts_pending: true });
    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(true);
    expect(h.anchor()).toBe(TS_A);
    expect(h.thoughtsPaneEl.querySelectorAll(".thought-entry").length).toBe(0);
  });

  it("補發命中（text 字串）→ ADV 轉亮態＋內容、pane append 一條、錨清空", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "assistant", text: "在。", timestamp: TS_A, thoughts: null, thoughts_pending: true });
    h.onFrame({ role: "thoughts", text: "今晚的語氣聽起來有點累。", for_ts: TS_A });

    expect(h.adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
    h.adv.thinkingBtn.click();
    expect(h.adv.textEl.textContent).toBe("今晚的語氣聽起來有點累。");
    const entries = h.thoughtsPaneEl.querySelectorAll(".thought-entry");
    expect(entries.length).toBe(1);
    expect(entries[0].textContent).toBe("今晚的語氣聽起來有點累。");
    expect(h.anchor()).toBeNull();
  });

  it("補發命中（text=null，轉寫失敗／被濾）→ ADV 回退階、pane 不 append", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "assistant", text: "在。", timestamp: TS_A, thoughts: null, thoughts_pending: true });
    h.onFrame({ role: "thoughts", text: null, for_ts: TS_A });

    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
    expect(h.adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false);
    expect(h.thoughtsPaneEl.querySelectorAll(".thought-entry").length).toBe(0);
    expect(h.anchor()).toBeNull();
  });

  it("for_ts 不合（F5 後殘留晚到等）→ 整包丟棄且不清錨：pending 續等、真卡後到仍被採納", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "assistant", text: "在。", timestamp: TS_B, thoughts: null, thoughts_pending: true });

    h.onFrame({ role: "thoughts", text: "上上輪的殘留思緒", for_ts: TS_A }); // 錯輪
    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(true); // 仍在等
    expect(h.thoughtsPaneEl.querySelectorAll(".thought-entry").length).toBe(0);
    expect(h.anchor()).toBe(TS_B); // 錨沒被錯包清掉

    h.onFrame({ role: "thoughts", text: "本輪的真卡", for_ts: TS_B }); // 真卡後到
    expect(h.adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    expect(h.thoughtsPaneEl.querySelectorAll(".thought-entry").length).toBe(1);
  });

  it("開新輪（send）＝舊輪的卡作廢：晚到補發被丟棄", () => {
    const h = buildHarness();
    h.submitSent("第一句");
    h.onFrame({ role: "assistant", text: "回一。", timestamp: TS_A, thoughts: null, thoughts_pending: true });
    h.submitSent("第二句"); // 開新輪
    expect(h.anchor()).toBeNull();

    h.onFrame({ role: "thoughts", text: "第一輪的晚到卡", for_ts: TS_A });
    expect(h.adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false);
    expect(h.thoughtsPaneEl.querySelectorAll(".thought-entry").length).toBe(0);
  });

  it("新 reply（無 pending）到達＝錨清空：更早輪的補發之後才到也被丟棄", () => {
    const h = buildHarness();
    h.submitSent("第一句");
    h.onFrame({ role: "assistant", text: "回一。", timestamp: TS_A, thoughts: null, thoughts_pending: true });
    h.submitSent("第二句");
    h.onFrame({ role: "assistant", text: "回二。", timestamp: TS_B, thoughts: null }); // 本輪無 pending
    expect(h.anchor()).toBeNull();
    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(false); // 新輪 present 已重置

    h.onFrame({ role: "thoughts", text: "第一輪的晚到卡", for_ts: TS_A });
    expect(h.adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false); // 錯輪卡沒掛上
  });

  it("命中後的重複補發（同 for_ts 第二包）→ 錨已清、丟棄：pane 不疊第二條", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "assistant", text: "在。", timestamp: TS_A, thoughts: null, thoughts_pending: true });
    h.onFrame({ role: "thoughts", text: "第一包。", for_ts: TS_A });
    h.onFrame({ role: "thoughts", text: "重複的第二包。", for_ts: TS_A });

    const entries = h.thoughtsPaneEl.querySelectorAll(".thought-entry");
    expect(entries.length).toBe(1);
    expect(entries[0].textContent).toBe("第一包。");
    h.adv.thinkingBtn.click();
    expect(h.adv.textEl.textContent).toBe("第一包。"); // 內容也沒被第二包蓋掉
  });

  it("streamArmed 回歸：partial 流進行中收到（錯輪）thoughts frame——partial 繼續活、不觸發 end-of-stream", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "我在" });
    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(1);
    const advTextMid = h.adv.textEl.textContent;

    h.onFrame({ role: "thoughts", text: "上一輪的晚到卡", for_ts: TS_A }); // 串流中殺到

    expect(h.isArmed()).toBe(true); // 沒被解除武裝
    expect(h.isActive()).toBe(true); // 串流旗標沒被動
    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(1); // 半成品泡泡沒被清
    expect(h.adv.textEl.textContent).toBe(advTextMid); // ADV 正文沒被碰

    h.onFrame({ role: "partial", text: "我在想你" }); // 後續 partial 照常被接受
    expect(h.msgsEl.querySelector(".partial-row .bubble").textContent).toBe("我在想你");

    const frame = { role: "assistant", text: "我在想你。", timestamp: TS_B, thoughts: null };
    h.onFrame(frame);
    expect(frame.instant).toBe(true); // 串流收尾語意不受 thoughts frame 干擾
  });

  it("thoughts frame 不進 Chat Log：msgs 容器零新增節點", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "assistant", text: "在。", timestamp: TS_A, thoughts: null, thoughts_pending: true });
    const childCountBefore = h.msgsEl.children.length;
    h.onFrame({ role: "thoughts", text: "思緒內容", for_ts: TS_A });
    expect(h.msgsEl.children.length).toBe(childCountBefore);
  });

  it("E2E 串流輪：send → partial → final(pending) → 補發命中——instant/resume 收尾與卡亮全鏈正確", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "我在想你" });
    vi.advanceTimersByTime(TYPE_MS * 10);

    const frame = { role: "assistant", text: "我在想你。", timestamp: TS_A, thoughts: null, thoughts_pending: true };
    h.onFrame(frame);
    expect(frame.instant).toBe(true);
    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(0);
    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(true);
    vi.advanceTimersByTime(TYPE_MS * 10); // resume 收尾打完
    expect(h.adv.textEl.textContent).toBe("我在想你。");

    h.onFrame({ role: "thoughts", text: "轉寫完成。", for_ts: TS_A });
    expect(h.adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    expect(h.thoughtsPaneEl.querySelectorAll(".thought-entry").length).toBe(1);
  });

  it("WS 斷線（status 離開 open）：錨清＋pending 鈕收掉（server 已吞補發，卡永遠不會來）", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "assistant", text: "在。", timestamp: TS_A, thoughts: null, thoughts_pending: true });
    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(true);

    h.onStatusChange("reconnecting");
    expect(h.anchor()).toBeNull();
    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(false);

    h.onFrame({ role: "thoughts", text: "斷線前排出的卡", for_ts: TS_A }); // 理論上不會來，防禦
    expect(h.adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false);
  });

  it("清畫面：錨清＋is-pending 隨 present('') 重置＋pane 清空；晚到補發被丟棄", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "assistant", text: "在。", timestamp: TS_A, thoughts: null, thoughts_pending: true });

    h.clearView();
    expect(h.anchor()).toBeNull();
    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
    expect(h.thoughtsPaneEl.children.length).toBe(0);

    h.onFrame({ role: "thoughts", text: "清畫面前那輪的卡", for_ts: TS_A });
    expect(h.adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false);
    expect(h.thoughtsPaneEl.querySelectorAll(".thought-entry").length).toBe(0);
  });

  it("防禦：pending=true 但 reply 缺 timestamp（協定上不會）＝不進 pending、不留死錨", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "assistant", text: "在。", thoughts: null, thoughts_pending: true }); // 無 timestamp
    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(false); // 鈕不呼吸到天荒地老
    expect(h.anchor()).toBeNull();

    h.onFrame({ role: "thoughts", text: null, for_ts: null }); // for_ts null 也對不上 null 錨
    expect(h.thoughtsPaneEl.querySelectorAll(".thought-entry").length).toBe(0);
  });

  it("舊路徑回歸（轉寫 flag OFF）：reply 直帶 thoughts 字串——亮態＋pane append 照舊、零 pending", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "assistant", text: "在。", timestamp: TS_A, thoughts: "直帶的思緒。" });

    expect(h.adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    expect(h.adv.thinkingBtn.classList.contains("is-pending")).toBe(false);
    expect(h.anchor()).toBeNull();
    const entries = h.thoughtsPaneEl.querySelectorAll(".thought-entry");
    expect(entries.length).toBe(1);
    expect(entries[0].textContent).toBe("直帶的思緒。");
    h.adv.thinkingBtn.click();
    expect(h.adv.textEl.textContent).toBe("直帶的思緒。");
  });
});

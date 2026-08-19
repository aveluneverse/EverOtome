import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MouthDriver, FLAP_MS, SCORE_TICK_MS } from "../js/audio-mouth.js";

// 樂譜制雙模式（語音播放期間嘴一直開合看起來不自然）：
//   score 模式＝envelope.js 的 0/1/2 譜 → currentTime 查表（停頓閉嘴的本體）
//   flap 模式＝無譜保底的有機拍嘴（拍距抖動＋60/40 開口＋15% 換氣拍）
// 測試用真 jsdom <audio>（完整 EventTarget＋paused 預設 true）＋fake timers。
// flap 的節拍斷言一律 mock Math.random()=0.5 取確定值：
//   拍距＝round(基準 × (0.8+0.5×0.5))＝round(基準×1.05)（105→110、120→126、60→63）
//   開口抽樣 0.5<0.6 → 永遠 1；換氣抽樣 0.5≥0.15 → 永不觸發

function makeDriver(opts) {
  const calls = [];
  const d = new MouthDriver({ setMouth: (l) => calls.push(l) }, opts);
  return { d, calls };
}

function playingEl() {
  // jsdom 的 paused 是唯讀 getter——defineProperty 蓋掉模擬「已在播」的元件。
  const el = document.createElement("audio");
  Object.defineProperty(el, "paused", { configurable: true, value: false });
  return el;
}

/** currentTime 可寫化（score 查表測試手動推播放位置）。 */
function timedEl({ playing = true } = {}) {
  const el = document.createElement("audio");
  if (playing) Object.defineProperty(el, "paused", { configurable: true, value: false });
  Object.defineProperty(el, "currentTime", { configurable: true, writable: true, value: 0 });
  return el;
}

function env(levels, frameMs = 50) {
  return { frameMs, levels: Uint8Array.from(levels) };
}

describe("建構參數位（low/high 保留讓呼叫端零改動——閾值自適應收在 envelope.js）", () => {
  it("預設值與自訂值都照收", () => {
    const d1 = new MouthDriver({ setMouth() {} });
    expect(d1.low).toBe(0.02);
    expect(d1.high).toBe(0.08);
    const d2 = new MouthDriver({ setMouth() {} }, { low: 0.1, high: 0.5 });
    expect(d2.low).toBe(0.1);
    expect(d2.high).toBe(0.5);
  });
});

describe("setFlapMs（嘴型速度自助拉桿——flap 模式基準拍速）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("clamp 60-180；無效輸入不動；拍在跑中換速＝重排下一拍即時生效", () => {
    const { d, calls } = makeDriver();
    d.setFlapMs(10);
    expect(d._flapMs).toBe(60);
    d.setFlapMs(999);
    expect(d._flapMs).toBe(180);
    d.setFlapMs("junk");
    expect(d._flapMs).toBe(180);
    d.setFlapMs(120);

    const el = document.createElement("audio");
    d.attach(el);
    calls.length = 0;
    el.dispatchEvent(new Event("play"));   // 開講（基準 120 → 實拍 126）
    expect(calls.length).toBe(1);          // 開（零延遲首拍）
    vi.advanceTimersByTime(126);
    expect(calls.length).toBe(2);          // 一拍合
    d.setFlapMs(60);                       // 講到一半換速：只換節奏、不重開場（換速≠重新開講）
    expect(calls.length).toBe(2);
    vi.advanceTimersByTime(63);            // 新基準 60 → 實拍 63 已生效
    expect(calls.length).toBe(3);
    vi.advanceTimersByTime(126);           // 舊 126 拍已死：126ms 內走 63×2＝兩拍
    expect(calls.length).toBe(5);
  });
});

describe("口型仲裁鉤子（「回訊息沒聲音嘴也要動」——app.js 接線層的耳目）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function hookedDriver() {
    const start = vi.fn();
    const stop = vi.fn();
    const d = new MouthDriver({ setMouth() {} }, { onFlapStart: start, onFlapStop: stop });
    return { d, start, stop };
  }

  it("onFlapStart 只在真的開講那一刻觸發一次；持續播放的第二個開始事件短路不重複", () => {
    const { d, start, stop } = hookedDriver();
    const el = document.createElement("audio");
    d.attach(el);                             // paused → 對齊收嘴，不算開講
    expect(start).not.toHaveBeenCalled();
    el.dispatchEvent(new Event("play"));
    expect(start).toHaveBeenCalledTimes(1);
    el.dispatchEvent(new Event("playing"));   // 同一場講話的第二個開始事件
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
  });

  it("onFlapStop 只在「本來在講」收嘴時觸發；本來就沒講的 stop 事件不觸發、不重複", () => {
    const { d, stop } = hookedDriver();
    const el = document.createElement("audio");
    d.attach(el);
    el.dispatchEvent(new Event("pause"));     // 沒開講過 → 不觸發
    expect(stop).not.toHaveBeenCalled();
    el.dispatchEvent(new Event("play"));
    el.dispatchEvent(new Event("ended"));
    expect(stop).toHaveBeenCalledTimes(1);
    el.dispatchEvent(new Event("emptied"));   // 已收過 → 不重複
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("setFlapMs 換速不觸發任何仲裁鉤子（換速≠重新開講）", () => {
    const { d, start, stop } = hookedDriver();
    const el = document.createElement("audio");
    d.attach(el);
    el.dispatchEvent(new Event("play"));
    start.mockClear();
    d.setFlapMs(60);
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(d.isFlapping()).toBe(true);        // 節拍活著、只是換了速度
  });

  it("isFlapping() 反映語音驅動生死（app.js 打字開場「語音在講就不搶嘴」的判準）", () => {
    const { d } = makeDriver();
    const el = document.createElement("audio");
    d.attach(el);
    expect(d.isFlapping()).toBe(false);
    el.dispatchEvent(new Event("play"));
    expect(d.isFlapping()).toBe(true);
    el.dispatchEvent(new Event("ended"));
    expect(d.isFlapping()).toBe(false);
  });

  it("鉤子炸掉不拖累驅動本體（開合節拍照走、收嘴照收）", () => {
    const calls = [];
    const d = new MouthDriver({ setMouth: (l) => calls.push(l) }, {
      onFlapStart: () => { throw new Error("boom"); },
      onFlapStop: () => { throw new Error("boom"); },
    });
    const el = document.createElement("audio");
    d.attach(el);
    el.dispatchEvent(new Event("play"));
    expect(d.isFlapping()).toBe(true);        // start 鉤子炸了，節拍照開
    vi.advanceTimersByTime(230);              // 110×2 兩拍收齊
    expect(calls.length).toBeGreaterThanOrEqual(3);
    el.dispatchEvent(new Event("ended"));
    expect(d.isFlapping()).toBe(false);       // stop 鉤子炸了，收嘴照收
    expect(calls[calls.length - 1]).toBe(0);
  });
});

describe("flap 模式：play=開講、pause/ended/emptied=收嘴（mock random=0.5 取確定節拍）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("play 事件→立即開口＋抖動節拍交替開合（基準 105 → 實拍 110）", () => {
    const { d, calls } = makeDriver();
    const el = document.createElement("audio");
    d.attach(el);            // paused=true → 對齊為閉嘴（一筆 0）
    calls.length = 0;
    el.dispatchEvent(new Event("play"));
    expect(calls.length).toBe(1);            // 開講零延遲：不等第一個 timeout
    expect(calls[0]).toBe(1);                // mock 0.5 → 開口抽 1（微張）
    vi.advanceTimersByTime(110);
    expect(calls[1]).toBe(0);                // 下一拍：合
    vi.advanceTimersByTime(110);
    expect(calls[2]).toBe(1);                // 再下一拍：開
    vi.advanceTimersByTime(110 * 4);
    expect(calls.length).toBe(7);            // 節拍持續在走（每 110ms 一筆）
  });

  it.each(["pause", "ended", "emptied"])("%s 事件→立停＋閉嘴，節拍不再走", (type) => {
    const { d, calls } = makeDriver();
    const el = document.createElement("audio");
    d.attach(el);
    el.dispatchEvent(new Event("play"));
    vi.advanceTimersByTime(220);
    calls.length = 0;
    el.dispatchEvent(new Event(type));
    expect(calls[calls.length - 1]).toBe(0); // 收嘴
    const n = calls.length;
    vi.advanceTimersByTime(110 * 5);
    expect(calls.length).toBe(n);            // timer 已清——不再有任何拍
  });

  it("attach 當下元件已在播（先 play 才掛上來的時序）→ 不等事件立即開講", () => {
    const { d, calls } = makeDriver();
    d.attach(playingEl());
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(1);
    vi.advanceTimersByTime(110);
    expect(calls[1]).toBe(0);
  });

  it("開拍口型永遠只有 1/2、合拍永遠 0（打字 pakupaku 同款視覺語彙；0.5 永不換氣）", () => {
    const { d, calls } = makeDriver();
    d.attach(playingEl());
    vi.advanceTimersByTime(110 * 20);
    const opens = calls.filter((_, i) => i % 2 === 0);
    const closes = calls.filter((_, i) => i % 2 === 1);
    expect(opens.every((l) => l === 1 || l === 2)).toBe(true);
    expect(closes.every((l) => l === 0)).toBe(true);
  });

  it("換氣拍：閉→開抽中 <0.15 → 該拍維持閉嘴（多喘一拍），下一拍照常開", () => {
    // random 消耗序：開講 _openFlap(開口)＋排拍(jitter)；閉拍只吃 jitter；
    // 閉→開拍吃 換氣＋開口＋jitter。佇列走完固定回 0.5。
    const seq = [
      0.5, 0.5, // 開講首拍：開口 1、jitter 110
      0.5,      // 拍 1（合）：jitter 110
      0.1, 0.5, // 拍 2（該開）：換氣抽中（0.1<0.15）→ 維持閉；jitter 110
      0.5, 0.5, // 拍 3（該開）：換氣未中 → 開口 1；jitter 110
    ];
    let i = 0;
    vi.spyOn(Math, "random").mockImplementation(() => (i < seq.length ? seq[i++] : 0.5));
    const { d, calls } = makeDriver();
    d.attach(playingEl());               // [1]（開講）
    vi.advanceTimersByTime(110);         // [1,0]（合）
    vi.advanceTimersByTime(110);         // 換氣拍：不送新嘴型
    expect(calls).toEqual([1, 0]);
    vi.advanceTimersByTime(110);         // [1,0,1]（喘完照常開）
    expect(calls).toEqual([1, 0, 1]);
  });
});

describe("score 模式：嘴型譜 currentTime 查表（停頓閉嘴的本體）", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("有譜開講＝查表驅嘴：有聲段依譜、停頓段 0、超出譜長 0；level 不變不重送", () => {
    const { d, calls } = makeDriver();
    const el = timedEl({ playing: false });
    d.attach(el);
    d.setEnvelope(env([2, 2, 0, 0, 1])); // 50ms/幀：0-100ms=2、100-200ms=停頓、200-250ms=1
    calls.length = 0;
    el.dispatchEvent(new Event("play"));
    expect(calls).toEqual([2]);              // 開講零延遲：立即對齊譜面
    vi.advanceTimersByTime(SCORE_TICK_MS);   // currentTime 未動 → level 不變不重送
    expect(calls).toEqual([2]);
    el.currentTime = 0.12;                   // 進停頓段（idx 2）
    vi.advanceTimersByTime(SCORE_TICK_MS);
    expect(calls).toEqual([2, 0]);           // 停頓＝閉嘴（樂譜制的核心行為）
    el.currentTime = 0.21;                   // idx 4
    vi.advanceTimersByTime(SCORE_TICK_MS);
    expect(calls).toEqual([2, 0, 1]);
    el.currentTime = 0.9;                    // 超出譜長（尾端捨去帶）
    vi.advanceTimersByTime(SCORE_TICK_MS);
    expect(calls).toEqual([2, 0, 1, 0]);
    expect(d.debugState().mode).toBe("score-drive");
  });

  it("譜遲到熱切換：先 flap 開講、promise resolve 後無縫轉 score（不重觸發仲裁鉤子）", async () => {
    const start = vi.fn();
    const calls = [];
    const d = new MouthDriver({ setMouth: (l) => calls.push(l) }, { onFlapStart: start });
    const el = timedEl();
    let resolveEnv;
    d.attach(el);                            // 已在播 → flap 開講（譜還沒到）
    expect(calls[0]).toBe(1);
    expect(d.debugState().mode).toBe("event-flap");
    expect(start).toHaveBeenCalledTimes(1);
    d.setEnvelope(new Promise((r) => { resolveEnv = r; }));
    resolveEnv(env([2, 2, 2]));
    await vi.advanceTimersByTimeAsync(0);    // flush microtask
    expect(d.debugState().mode).toBe("score-drive");
    expect(calls[calls.length - 1]).toBe(2); // 切換當下即對齊譜面
    expect(start).toHaveBeenCalledTimes(1);  // 同一句話繼續講：仲裁不重觸發
    vi.advanceTimersByTime(110 * 3);         // flap 節拍已死：不再有 1/0 交替
    expect(calls.filter((l) => l === 1).length).toBe(1);
  });

  it("譜算失敗（resolve null）＝繼續 flap，永不拖累播放", async () => {
    const { d, calls } = makeDriver();
    const el = timedEl();
    d.attach(el);
    d.setEnvelope(Promise.resolve(null));
    await vi.advanceTimersByTimeAsync(0);
    expect(d.debugState().mode).toBe("event-flap");
    vi.advanceTimersByTime(110);
    expect(calls.length).toBeGreaterThanOrEqual(2); // flap 照常在走
  });

  it("stale 譜不套用：新譜已就位後，舊 promise 遲到 resolve 被世代 token 擋下", async () => {
    const { d } = makeDriver();
    const el = timedEl();
    let resolveOld;
    d.attach(el);
    d.setEnvelope(new Promise((r) => { resolveOld = r; }));  // 句 A 的譜（慢）
    d.setEnvelope(env([2, 2]));                              // 句 B 的譜（先到位）
    resolveOld(env([1, 1, 1, 1, 1, 1]));                     // 句 A 遲到
    await vi.advanceTimersByTimeAsync(0);
    expect(d.debugState().envFrames).toBe(2);                // 仍是句 B 的譜
  });

  it("setEnvelope(null) 明示清譜：score 跑中退回 flap（同一句繼續講）", () => {
    const { d } = makeDriver();
    const el = timedEl();
    d.attach(el);
    d.setEnvelope(env([2, 2, 2]));
    expect(d.debugState().mode).toBe("score-drive");
    d.setEnvelope(null);
    expect(d.debugState().mode).toBe("event-flap");
    expect(d.isFlapping()).toBe(true);       // 還在講話（換驅動不是收嘴）
  });

  it("score 模式收嘴事件照樣立停＋閉嘴＋觸發 onFlapStop", () => {
    const stop = vi.fn();
    const calls = [];
    const d = new MouthDriver({ setMouth: (l) => calls.push(l) }, { onFlapStop: stop });
    const el = timedEl({ playing: false });
    d.attach(el);
    d.setEnvelope(env([2, 2, 2]));
    el.dispatchEvent(new Event("play"));
    expect(d.debugState().mode).toBe("score-drive");
    el.dispatchEvent(new Event("ended"));
    expect(calls[calls.length - 1]).toBe(0);
    expect(d.isFlapping()).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
    const n = calls.length;
    vi.advanceTimersByTime(SCORE_TICK_MS * 5);
    expect(calls.length).toBe(n);            // score timer 已清
  });

  it("換元素＝舊譜作廢（新線開講走 flap，直到新句的譜送進來）", () => {
    const { d } = makeDriver();
    const elA = timedEl({ playing: false });
    const elB = timedEl({ playing: false });
    d.attach(elA);
    d.setEnvelope(env([2, 2, 2]));
    elA.dispatchEvent(new Event("play"));
    expect(d.debugState().mode).toBe("score-drive");
    d.attach(elB);                           // 換線：舊譜不跟過去
    elB.dispatchEvent(new Event("play"));
    expect(d.debugState().mode).toBe("event-flap");
    expect(d.debugState().envFrames).toBe(0);
  });

  it("detach 後遲到的譜 promise 作廢（世代 token）", async () => {
    const { d } = makeDriver();
    const el = timedEl();
    let resolveEnv;
    d.attach(el);
    d.setEnvelope(new Promise((r) => { resolveEnv = r; }));
    d.detach();
    resolveEnv(env([2, 2]));
    await vi.advanceTimersByTimeAsync(0);
    expect(d.debugState().envFrames).toBe(0);
    expect(d.isFlapping()).toBe(false);
  });
});

describe("attach 生命週期：同元素短路／換元素換線／detach 收乾淨", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("同元素重複 attach＝短路（節拍不重建；電話每句每輪重 attach 正是這情境）", () => {
    const { d } = makeDriver();
    const el = playingEl();
    d.attach(el);
    const firstTimer = d._timer;
    expect(firstTimer).not.toBe(null);
    d.attach(el);                            // 同元素再掛：timer 原封不動
    expect(d._timer).toBe(firstTimer);
  });

  it("同元素重複 attach 仍對齊當下狀態：元件已停→嘴收合", () => {
    const { d, calls } = makeDriver();
    const el = document.createElement("audio");
    d.attach(el);
    el.dispatchEvent(new Event("play"));
    expect(d._timer).not.toBe(null);
    // 模擬「播完了但 driver 沒收到事件」的殘態——重 attach 的 _sync 要能自我修正
    calls.length = 0;
    d.attach(el);                            // paused 仍是 true（沒真的播）→ 收
    expect(d._timer).toBe(null);
    expect(calls[calls.length - 1]).toBe(0);
  });

  it("換元素＝舊元素解綁（舊 el 的事件從此驅不動嘴）、新元素接手", () => {
    const { d, calls } = makeDriver();
    const elA = document.createElement("audio");
    const elB = document.createElement("audio");
    d.attach(elA);
    d.attach(elB);
    calls.length = 0;
    elA.dispatchEvent(new Event("play"));    // 舊線已斷
    expect(calls.length).toBe(0);
    elB.dispatchEvent(new Event("play"));    // 新線活著
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(1);
  });

  it("detach()：停拍＋閉嘴＋解綁（之後舊元素 play 無效）", () => {
    const { d, calls } = makeDriver();
    const el = document.createElement("audio");
    d.attach(el);
    el.dispatchEvent(new Event("play"));
    d.detach();
    expect(d._timer).toBe(null);
    expect(d._el).toBe(null);
    expect(calls[calls.length - 1]).toBe(0);
    calls.length = 0;
    el.dispatchEvent(new Event("play"));
    expect(calls.length).toBe(0);
    vi.advanceTimersByTime(110 * 3);
    expect(calls.length).toBe(0);
  });

  it("attach(null/undefined) 安全 no-op", () => {
    const { d } = makeDriver();
    expect(() => d.attach(null)).not.toThrow();
    expect(() => d.attach(undefined)).not.toThrow();
    expect(d._el).toBe(null);
  });
});

describe("零 WebAudio（架構替換的核心保證——樂譜制不破例）", () => {
  it("attach＋播放＋setEnvelope 全程不建 AudioContext（離線解碼在 envelope.js，不在本檔）", () => {
    const ctxSpy = vi.fn();
    window.AudioContext = ctxSpy;
    try {
      const { d } = makeDriver();
      const el = playingEl();
      d.attach(el);
      d.setEnvelope({ frameMs: 50, levels: Uint8Array.from([2, 2]) });
      expect(ctxSpy).not.toHaveBeenCalled();
    } finally {
      delete window.AudioContext;
    }
  });

  it("unlock() 保留接口：await 不炸、也不建 AudioContext", async () => {
    const ctxSpy = vi.fn();
    window.AudioContext = ctxSpy;
    try {
      const { d } = makeDriver();
      await d.unlock();
      expect(ctxSpy).not.toHaveBeenCalled();
    } finally {
      delete window.AudioContext;
    }
  });
});

describe("debugState()（mouthdebug 浮層的 ground truth 出口）", () => {
  it("未掛載：attached=false、el 欄位全 null、mode=event-flap、envFrames=0", () => {
    const { d } = makeDriver();
    const st = d.debugState();
    expect(st.mode).toBe("event-flap");
    expect(st.attached).toBe(false);
    expect(st.flapping).toBe(false);
    expect(st.envFrames).toBe(0);
    expect(st.elPaused).toBe(null);
    expect(st.srcKind).toBe("none");
    expect(st.lastEvent).toBe(null);
  });

  it("掛載＋播放：欄位反映元件真實狀態＋最近事件", () => {
    vi.useFakeTimers();
    try {
      const { d } = makeDriver();
      const el = document.createElement("audio");
      d.attach(el);
      el.dispatchEvent(new Event("play"));
      const st = d.debugState();
      expect(st.attached).toBe(true);
      expect(st.flapping).toBe(true);
      expect(st.elPaused).toBe(true);       // jsdom 的 audio 不會真的播——如實回報
      expect(st.lastEvent).toBe("play");
      expect(typeof st.lastEventAgoMs).toBe("number");
    } finally {
      vi.useRealTimers();
    }
  });
});

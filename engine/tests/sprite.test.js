import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SpritePlayer } from "../js/sprite.js";

const MANIFEST = {
  size: [512, 768],
  moods: { neutral: { A: "A.webp", B: "B.webp", C: "C.webp", D: "D.webp", E: "E.webp", F: "F.webp" } },
};

// 九幀 manifest：眼三態 open/half/closed（A-I）。eyeStates:3 是 sprite.js 判斷 2 態/3 態
// 查表＋眨眼序列的唯一依據（manifest 自己宣告，不是猜 G 這把鑰匙在不在，也不是 opts）。
const MANIFEST_9 = {
  size: [1024, 1536],
  eyeStates: 3,
  moods: {
    neutral: {
      A: "A.webp", B: "B.webp", C: "C.webp",
      D: "D.webp", E: "E.webp", F: "F.webp",
      G: "G.webp", H: "H.webp", I: "I.webp",
    },
  },
};

let decodeSpy;

beforeEach(() => {
  decodeSpy = vi.fn(() => Promise.resolve());
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => MANIFEST }));
  // jsdom 無真 Image 載入：mock 立即 onload／decode（decode 是 sprite.js 實際預載路徑，
  // onload 留著只為相容沒有 decode() 的退化分支測試，見下方「decode() 預載路徑」）
  global.Image = class {
    set src(_) { setTimeout(() => this.onload && this.onload(), 0); }
    decode() { return decodeSpy(); }
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makePlayer() {
  const el = document.createElement("div");
  return new SpritePlayer(el, { assetsPath: "assets/sample/" });
}

/** 同 makePlayer()，但 fetch 撈到的是九鍵（eyeStates:3）manifest。 */
function makePlayer9() {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => MANIFEST_9 }));
  const el = document.createElement("div");
  return new SpritePlayer(el, { assetsPath: "assets/sample/" });
}

describe("startTalking/stopTalking — 打字說話口型", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("startTalking：口型開合交替（0↔1/2）、幀跟著換；stopTalking 嘴歸 0", async () => {
    const p = makePlayer();
    const loadP = p.load();
    await vi.runAllTimersAsync(); // mock Image onload 的 setTimeout
    await loadP;

    p.startTalking();
    const seen = new Set();
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(130);
      seen.add(p._mouth);
    }
    expect(seen.has(0)).toBe(true); // 有閉
    expect(seen.has(1) || seen.has(2)).toBe(true); // 有張

    p.stopTalking();
    expect(p._mouth).toBe(0);
    const frameAfterStop = p._shownFrame; // 疊圖制：亮著的幀檔名＝畫面真相
    vi.advanceTimersByTime(130 * 5); // 停了就不再動
    expect(p._mouth).toBe(0);
    expect(p._shownFrame).toBe(frameAfterStop);
  });

  it("重入安全：連續 startTalking 只跑一條循環；stopTalking 沒在講也安全", async () => {
    const p = makePlayer();
    const loadP = p.load();
    await vi.runAllTimersAsync();
    await loadP;

    p.startTalking();
    const t1 = p._talkTimer;
    p.startTalking(); // 重入 no-op
    expect(p._talkTimer).toBe(t1);
    p.stopTalking();
    expect(p._talkTimer).toBe(null);
    expect(() => p.stopTalking()).not.toThrow(); // 沒在講：安全、嘴仍歸位
    expect(p._mouth).toBe(0);
  });

  it("degraded（預載失敗）：startTalking no-op、不排 timer", async () => {
    decodeSpy.mockImplementation(() => Promise.reject(new Error("no img")));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = makePlayer();
    const loadP = p.load();
    await vi.runAllTimersAsync();
    await loadP;
    expect(p._degraded).toBe(true);

    p.startTalking();
    expect(p._talkTimer).toBe(null);
    warn.mockRestore();
  });
});

describe("frame lookup", () => {
  it("眼開嘴閉=A、眼開嘴半=B、眼閉嘴開=F", async () => {
    const p = makePlayer();
    await p.load();
    expect(p._frameFor("open", 0)).toBe("A.webp");
    expect(p._frameFor("open", 1)).toBe("B.webp");
    expect(p._frameFor("closed", 2)).toBe("F.webp");
  });
});

describe("mouth + blink 疊加（眼嘴獨立軸）", () => {
  it("setMouth 只動嘴，眨眼只動眼，互不覆蓋", async () => {
    const p = makePlayer();
    await p.load();
    p.setMouth(2);
    expect(p._currentFrame()).toBe("C.webp");
    p._eye = "closed";                 // 模擬眨眼相位
    expect(p._currentFrame()).toBe("F.webp");
    p.setMouth(0);
    expect(p._currentFrame()).toBe("D.webp");
  });
});

describe("setMood 回退", () => {
  it("未知 mood 靜默回退 neutral", async () => {
    const p = makePlayer();
    await p.load();
    p.setMood("doting");               // 首版 manifest 沒有
    expect(p._mood).toBe("neutral");
  });
});

describe("blink 測試鉤", () => {
  it("_blinkNow 閉眼後在 holdMs 內回開", async () => {
    vi.useFakeTimers();
    const p = makePlayer();
    await p.load();
    p._blinkNow();
    expect(p._eye).toBe("closed");
    vi.advanceTimersByTime(200);
    expect(p._eye).toBe("open");
    vi.useRealTimers();
  });
});

describe("decode() 預載路徑", () => {
  it("load() 對 6 張圖都呼叫 decode()", async () => {
    const p = makePlayer();
    await p.load();
    expect(decodeSpy).toHaveBeenCalledTimes(6);
  });

  it("環境沒有 decode() 時退化成不等待，仍正常載入（沒呼叫到 decode）", async () => {
    global.Image = class { set src(_) { setTimeout(() => this.onload && this.onload(), 0); } }; // 故意沒有 decode()
    const p = makePlayer();
    await p.load();
    expect(p._frameFor("open", 0)).toBe("A.webp");
    expect(decodeSpy).not.toHaveBeenCalled();
  });
});

describe("圖片載入失敗→降級靜態 A 圖", () => {
  function makeFailingImage(failFile) {
    return class {
      set src(url) { this._url = url; }
      decode() {
        return this._url.includes(failFile)
          ? Promise.reject(new Error("decode failed"))
          : Promise.resolve();
      }
    };
  }

  it("預載某張失敗：load() 不 throw、_degraded=true、畫面顯示 A、console.warn 被呼叫", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.Image = makeFailingImage("C.webp");
    const p = makePlayer();
    await expect(p.load()).resolves.toBeUndefined();
    expect(p._degraded).toBe(true);
    expect(p._currentFrame()).toBe("A.webp");
    expect(warnSpy).toHaveBeenCalled();
  });

  it("降級後 setMouth／_blinkNow／startIdle 皆靜默 no-op，畫面維持 A", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    global.Image = makeFailingImage("C.webp");
    const p = makePlayer();
    await p.load();
    expect(p._degraded).toBe(true);

    p.setMouth(2);
    expect(p._mouth).toBe(0);
    expect(p._currentFrame()).toBe("A.webp");

    p._blinkNow();
    expect(p._eye).toBe("open");
    expect(p._currentFrame()).toBe("A.webp");

    p.startIdle();
    expect(p._blinkTimer).toBe(null);
  });
});

describe("9 幀查表（眼三態 open/half/closed，manifest.eyeStates===3）", () => {
  it("open/half/closed 三態 × 嘴 0/1/2 各自查到 A-I 對應字母", async () => {
    const p = makePlayer9();
    await p.load();
    expect(p._eyeStates).toBe(3);
    expect(p._frameFor("open", 0)).toBe("A.webp");
    expect(p._frameFor("open", 1)).toBe("B.webp");
    expect(p._frameFor("open", 2)).toBe("C.webp");
    expect(p._frameFor("half", 0)).toBe("D.webp");
    expect(p._frameFor("half", 1)).toBe("E.webp");
    expect(p._frameFor("half", 2)).toBe("F.webp");
    expect(p._frameFor("closed", 0)).toBe("G.webp");
    expect(p._frameFor("closed", 1)).toBe("H.webp");
    expect(p._frameFor("closed", 2)).toBe("I.webp");
  });

  it("setMouth 在 half 眼態下同樣正確疊加（眼嘴獨立軸，half 不是特例）", async () => {
    const p = makePlayer9();
    await p.load();
    p._eye = "half";                 // 模擬眨眼相位走到 half
    p.setMouth(2);
    expect(p._currentFrame()).toBe("F.webp");
    p.setMouth(0);
    expect(p._currentFrame()).toBe("D.webp");
  });

  it("load() 對 9 張圖都呼叫 decode()", async () => {
    const p = makePlayer9();
    await p.load();
    expect(decodeSpy).toHaveBeenCalledTimes(9);
  });
});

describe("柔滑眨眼序列（3 眼態：open→half→closed→half→open）", () => {
  it("依序經過 half→closed→half 才回 open", async () => {
    vi.useFakeTimers();
    const p = makePlayer9();
    await p.load();
    expect(p._eye).toBe("open");
    p._blinkNow();
    expect(p._eye).toBe("half");                 // 立即進入第一段 half
    vi.advanceTimersByTime(p.blinkHalfMs);
    expect(p._eye).toBe("closed");
    vi.advanceTimersByTime(p.blinkHoldMs);        // closed 停留沿用既有 blinkHoldMs
    expect(p._eye).toBe("half");                  // 回程第二段 half
    vi.advanceTimersByTime(p.blinkHalfMs);
    expect(p._eye).toBe("open");
    vi.useRealTimers();
  });

  it("眨眼節奏（「更快」調整＋「間隔再鬆」回調）：half 40-50ms、短於 closed 停留、間隔 1.8-4.2s", async () => {
    const p = makePlayer9();
    await p.load();
    // 原 60-80ms 手感區間被「速度要更快」的回饋取代；
    // 間隔由「太頻繁、再鬆一點」回調至 1.8-4.2s。
    expect(p.blinkHalfMs).toBeGreaterThanOrEqual(40);
    expect(p.blinkHalfMs).toBeLessThanOrEqual(50);
    expect(p.blinkHalfMs).toBeLessThan(p.blinkHoldMs);
    expect(p.blinkMinMs).toBe(1800);
    expect(p.blinkMaxMs).toBe(4200);
  });

  it("同一個 _blinkNow 連續呼叫兩次不疊出兩條平行序列（防禦性清舊序列）", async () => {
    vi.useFakeTimers();
    const p = makePlayer9();
    await p.load();
    p._blinkNow();
    p._blinkNow();                                // 立刻重觸發，模擬異常重入
    expect(p._eye).toBe("half");
    const renderSpy = vi.spyOn(p, "_render");
    vi.advanceTimersByTime(p.blinkHalfMs);
    expect(p._eye).toBe("closed");
    expect(renderSpy).toHaveBeenCalledTimes(1);    // 只有一條序列在跑，不是兩條疊加
    vi.advanceTimersByTime(p.blinkHoldMs);
    expect(p._eye).toBe("half");
    expect(renderSpy).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(p.blinkHalfMs);
    expect(p._eye).toBe("open");
    expect(renderSpy).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("setBlinkInterval（自助拉桿）：基準 → 區間 ×0.6/×1.4；clamp 1500-6000；無效輸入 no-op", async () => {
    const p = makePlayer9();
    await p.load();
    p.setBlinkInterval(2000);
    expect(p.blinkMinMs).toBe(1200);
    expect(p.blinkMaxMs).toBe(2800);
    p.setBlinkInterval(100);                       // clamp 到 1500
    expect(p.blinkMinMs).toBe(900);
    expect(p.blinkMaxMs).toBe(2100);
    p.setBlinkInterval(99999);                     // clamp 到 6000
    expect(p.blinkMinMs).toBe(3600);
    expect(p.blinkMaxMs).toBe(8400);
    p.setBlinkInterval("not-a-number");            // no-op
    expect(p.blinkMinMs).toBe(3600);
    expect(p.blinkMaxMs).toBe(8400);
  });

  it("setBlinkInterval：idle 迴圈在跑＝取消排定中的下一眨、立刻用新頻率重排（即時生效）", async () => {
    vi.useFakeTimers();
    const p = makePlayer9();
    await p.load();
    p.startIdle();
    expect(p._blinkTimer).not.toBeNull();
    const oldTimer = p._blinkTimer;
    p.setBlinkInterval(1500);                      // 最勤：區間 900-2100ms
    expect(p._blinkTimer).not.toBeNull();
    expect(p._blinkTimer).not.toBe(oldTimer);      // pending timer 真的重排了
    const blinkSpy = vi.spyOn(p, "_blinkNow");
    vi.advanceTimersByTime(2100);                  // 新區間上界內必觸發
    expect(blinkSpy).toHaveBeenCalled();
    p.stopIdle();
    vi.useRealTimers();
  });

  it("setBlinkInterval：idle 沒在跑（static／未啟動）＝只記參數不起 timer", async () => {
    const p = makePlayer9();
    await p.load();
    expect(p._blinkTimer).toBeNull();
    p.setBlinkInterval(2000);
    expect(p._blinkTimer).toBeNull();              // 不憑空啟動 idle
    expect(p.blinkMinMs).toBe(1200);
  });
});

describe("stopIdle 中途取消乾淨（無殘留 timer——3 態序列）", () => {
  it("序列進行到 closed 那一刻呼叫 stopIdle：立即歸位 open，且無殘留 timer 之後偷跑", async () => {
    vi.useFakeTimers();
    const p = makePlayer9();
    await p.load();
    p._blinkNow();
    vi.advanceTimersByTime(p.blinkHalfMs);
    expect(p._eye).toBe("closed");               // 序列正進行到 closed 段（後面還有 closed→half、half→open 兩顆待觸發的 timer）
    p.stopIdle();
    expect(p._eye).toBe("open");                  // 立即歸位，不留在 closed
    const renderSpy = vi.spyOn(p, "_render");
    vi.advanceTimersByTime(100000);               // 大幅快轉：殘留 timer 若還活著必在此觸發
    expect(renderSpy).not.toHaveBeenCalled();      // 沒有任何殘留 timer 偷跑
    vi.useRealTimers();
  });
});

describe("6 張向下相容（manifest 無 eyeStates 鍵＝維持 2 態舊行為）", () => {
  it("_eyeStates 落 2、_frameTable 無 half 鍵", async () => {
    const p = makePlayer();                       // 檔頭既有 6 鍵 MANIFEST，無 eyeStates
    await p.load();
    expect(p._eyeStates).toBe(2);
    expect(p._frameTable.half).toBeUndefined();
    expect(p._frameFor("closed", 0)).toBe("D.webp");
    expect(p._frameFor("closed", 1)).toBe("E.webp");
    expect(p._frameFor("closed", 2)).toBe("F.webp");
  });

  it("眨眼直接 open→closed→open，不經過 half", async () => {
    vi.useFakeTimers();
    const p = makePlayer();
    await p.load();
    p._blinkNow();
    expect(p._eye).toBe("closed");                // 直接閉，不是 half
    vi.advanceTimersByTime(p.blinkHoldMs);
    expect(p._eye).toBe("open");
    vi.useRealTimers();
  });

  it("stopIdle 中途取消同樣乾淨（既有 stale-timer 缺口在這次改動一併補上）", async () => {
    vi.useFakeTimers();
    const p = makePlayer();
    await p.load();
    p._blinkNow();
    expect(p._eye).toBe("closed");
    p.stopIdle();
    expect(p._eye).toBe("open");
    const renderSpy = vi.spyOn(p, "_render");
    vi.advanceTimersByTime(10000);                // 舊版遺留的 reopen timer 若還活著必在此觸發
    expect(renderSpy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// static 造型（單張立繪／臉被面罩遮住的角色：不眨眼、嘴巴也不用動）
// manifest 自報 static:true（同 eyeStates 的「manifest 宣告、非引擎猜測」哲學）
// ─────────────────────────────────────────────────────────────────────────────
const MANIFEST_STATIC = { static: true, image: "sprite.webp", size: [1024, 1536] };

function makePlayerStatic() {
  global.fetch = vi.fn(async () => ({ ok: true, json: async () => MANIFEST_STATIC }));
  const el = document.createElement("div");
  return new SpritePlayer(el, { assetsPath: "assets/mech/" });
}

describe("static 造型（單張立繪範例）", () => {
  it("manifest.static=true → 單張圖上屏（src=assetsPath+image）、_static 旗標立起", async () => {
    const p = makePlayerStatic();
    await p.load();
    expect(p._static).toBe(true);
    const img = p.container.querySelector("img.sprite-frame");
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toBe("assets/mech/sprite.webp");
  });

  it("static 下 setMouth／startTalking／startIdle／_blinkNow 全靜默 no-op：無 timer、幀不變", async () => {
    vi.useFakeTimers();
    try {
      const p = makePlayerStatic();
      await p.load();
      const img = p.container.querySelector("img.sprite-frame");
      const src0 = img.getAttribute("src");

      p.setMouth(2);
      p.startTalking();
      p.startIdle();
      p._blinkNow();
      vi.advanceTimersByTime(10000);

      expect(img.getAttribute("src")).toBe(src0);
      expect(p._blinkTimer).toBeNull();
      expect(p._talkTimer).toBeNull();
      expect(p._blinkSeqTimers.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("switchTo：動態（9 幀）→ static 換裝（timer 全收、單圖上屏）→ 再 switchTo 回動態（眨眼恢復可用）", async () => {
    // 先載 9 幀動態
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => MANIFEST_9 }));
    const el = document.createElement("div");
    const p = new SpritePlayer(el, { assetsPath: "assets/sample/" });
    await p.load();
    p.startIdle();
    expect(p._blinkTimer).not.toBeNull();

    // 換 static（fetch 換 manifest）
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => MANIFEST_STATIC }));
    await p.switchTo("assets/mech/");
    expect(p._static).toBe(true);
    expect(p._blinkTimer).toBeNull();
    const imgs = el.querySelectorAll("img.sprite-frame");
    expect(imgs.length).toBe(1); // 舊 img 已清、不疊第二張
    expect(imgs[0].getAttribute("src")).toBe("assets/mech/sprite.webp");

    // 換回動態
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => MANIFEST_9 }));
    await p.switchTo("assets/sample/");
    expect(p._static).toBe(false);
    p.startIdle();
    expect(p._blinkTimer).not.toBeNull();
    p.stopIdle();
  });
});

// 畫布比例自報（1300 寬外觀被寫死的 1024/1536 框壓扁的修法）——
// manifest.size → container CSS 變數；寬於 1024 基準另給中心對齊位移（負百分比、
// 以自身寬度為基＝免 resize 重算）；無 size（static 造型等）＝清變數走 fallback。
describe("畫布比例 CSS 變數（manifest.size 自報）", () => {
  it("1024×1536 → --sprite-aspect 設定、位移 0%", async () => {
    const p = makePlayer9();
    await p.load();
    expect(p.container.style.getPropertyValue("--sprite-aspect")).toBe("1024 / 1536");
    expect(p.container.style.getPropertyValue("--sprite-canvas-shift")).toBe("0.000%");
  });

  it("1300×1536（寬版畫布）→ aspect 跟著走、位移＝-(276/2600)·100%≈-10.615%", async () => {
    const wide = { ...MANIFEST_9, size: [1300, 1536] };
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => wide }));
    const el = document.createElement("div");
    const p = new SpritePlayer(el, { assetsPath: "assets/sample/" });
    await p.load();
    expect(el.style.getPropertyValue("--sprite-aspect")).toBe("1300 / 1536");
    expect(el.style.getPropertyValue("--sprite-canvas-shift")).toBe("-10.615%");
  });

  it("manifest 無 size（static 造型）→ 變數清空＝CSS fallback 1024/1536 接手", async () => {
    const wide = { ...MANIFEST_9, size: [1300, 1536] };
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => wide }));
    const el = document.createElement("div");
    const p = new SpritePlayer(el, { assetsPath: "assets/sample/" });
    await p.load();
    expect(el.style.getPropertyValue("--sprite-aspect")).toBe("1300 / 1536");
    // 換到無 size 的 static manifest（switchTo 全流程）：變數必須清、不殘留寬版比例
    global.fetch = vi.fn(async () => ({
      ok: true, json: async () => ({ static: true, image: "X.webp" }),
    }));
    await p.switchTo("assets/other/");
    expect(el.style.getPropertyValue("--sprite-aspect")).toBe("");
    expect(el.style.getPropertyValue("--sprite-canvas-shift")).toBe("");
  });
});

// 底部透明帶補償（手機貼底）：manifest.bottomGap → CSS 變數。
describe("bottomGap CSS 變數（manifest 自報底部透明帶）", () => {
  it("有 bottomGap → --sprite-bottom-push 設定為百分比；無鍵 → 變數清空", async () => {
    const withGap = { ...MANIFEST_9, bottomGap: 0.1113 };
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => withGap }));
    const el = document.createElement("div");
    const p = new SpritePlayer(el, { assetsPath: "assets/sample/" });
    await p.load();
    expect(el.style.getPropertyValue("--sprite-bottom-push")).toBe("11.13%");
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => MANIFEST_9 }));
    await p.switchTo("assets/other/");
    expect(el.style.getPropertyValue("--sprite-bottom-push")).toBe("");
  });
});

describe("onFrame 鉤子：眼／嘴狀態改變才通知、去重、鉤子炸不擋渲染", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("load 後首次 _render 通知 (open,0)；setMouth 改變才再通知；同狀態不重複", async () => {
    const p = makePlayer9();
    const spy = vi.fn();
    p.onFrame = spy;
    const loadP = p.load();
    await vi.runAllTimersAsync();
    await loadP;
    expect(spy).toHaveBeenCalledWith("open", 0);
    const n0 = spy.mock.calls.length;
    p.setMouth(2);
    expect(spy).toHaveBeenLastCalledWith("open", 2);
    p.setMouth(2);
    expect(spy.mock.calls.length).toBe(n0 + 1);
  });

  it("眨眼序列逐段通知 half/closed/half/open（嘴軸不變）", async () => {
    const p = makePlayer9();
    const spy = vi.fn();
    p.onFrame = spy;
    const loadP = p.load();
    await vi.runAllTimersAsync();
    await loadP;
    spy.mockClear();
    p._blinkNow();
    expect(spy).toHaveBeenLastCalledWith("half", 0);
    vi.advanceTimersByTime(45);
    expect(spy).toHaveBeenLastCalledWith("closed", 0);
    vi.advanceTimersByTime(90);
    expect(spy).toHaveBeenLastCalledWith("half", 0);
    vi.advanceTimersByTime(45);
    expect(spy).toHaveBeenLastCalledWith("open", 0);
    expect(spy.mock.calls.length).toBe(4);
  });

  it("鉤子丟例外＝console.warn、幀照翻；switchTo 後重新通知 (open,0)", async () => {
    const p = makePlayer9();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    p.onFrame = () => { throw new Error("boom"); };
    const loadP = p.load();
    await vi.runAllTimersAsync();
    await loadP;
    expect(() => p.setMouth(1)).not.toThrow();
    expect(warn).toHaveBeenCalled();
    const spy = vi.fn();
    p.onFrame = spy;
    const sw = p.switchTo("assets/other/");
    await vi.runAllTimersAsync();
    await sw;
    expect(spy).toHaveBeenCalledWith("open", 0);
  });
});

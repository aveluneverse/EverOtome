import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getTtsEnabled,
  setTtsEnabled,
  getSpriteVisible,
  setSpriteVisible,
  applySpriteVisible,
  getMouthFlapMs,
  setMouthFlapMs,
  MOUTH_FLAP_MIN,
  MOUTH_FLAP_MAX,
  getBlinkBaseMs,
  setBlinkBaseMs,
  BLINK_BASE_MIN,
  BLINK_BASE_MAX,
  SettingsPanel,
} from "../js/settings.js";
import { setLocale, getLocale, STORAGE_KEY, t } from "../js/i18n.js";
import { VERSION } from "../js/version.js";
import { FEEDBACK_URL } from "../js/feedback.js";

// 每個測試前清乾淨 localStorage＋body class，避免測試互相汙染狀態（settings.js 的
// 讀寫全部經過同一組 localStorage key，順序不同的測試檔／測試案例都共用同一個
// jsdom window，不清會讓「預設值」測試撞到前一個測試留下的殘值）。
beforeEach(() => {
  localStorage.clear();
  document.body.className = "";
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeContainer() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

describe("TTS 開關 —— localStorage v4.ttsEnabled，預設 off", () => {
  it("未設定過 → 預設 false（app.js 的 TtsSpeaker.getEnabled 直接引用這支函式）", () => {
    expect(getTtsEnabled()).toBe(false);
  });

  it("setTtsEnabled(true) → getTtsEnabled() 回 true，且 localStorage 寫入 \"1\"", () => {
    setTtsEnabled(true);
    expect(getTtsEnabled()).toBe(true);
    expect(localStorage.getItem("v4.ttsEnabled")).toBe("1");
  });

  it("setTtsEnabled(false) → localStorage 寫入 \"0\"，getTtsEnabled() 回 false", () => {
    setTtsEnabled(true);
    setTtsEnabled(false);
    expect(getTtsEnabled()).toBe(false);
    expect(localStorage.getItem("v4.ttsEnabled")).toBe("0");
  });

  it("getTtsEnabled 可直接當 TtsSpeaker 建構子的 getEnabled 使用（零參數、回布林值）", () => {
    setTtsEnabled(true);
    const getEnabled = getTtsEnabled; // app.js 實際寫法：{ getEnabled: getTtsEnabled }
    expect(typeof getEnabled()).toBe("boolean");
    expect(getEnabled()).toBe(true);
  });

  it("localStorage.getItem 拋錯（無痕模式等封鎖環境）→ 安全回預設值，不炸", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });
    expect(getTtsEnabled()).toBe(false);
  });

  it("localStorage.setItem 拋錯 → 靜默放棄，不拋出例外打斷呼叫端", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked");
    });
    expect(() => setTtsEnabled(true)).not.toThrow();
  });
});

describe("立繪顯示開關 —— localStorage v4.spriteVisible，預設顯示", () => {
  it("未設定過 → 預設 true", () => {
    expect(getSpriteVisible()).toBe(true);
  });

  it("setSpriteVisible 讀寫回合正確", () => {
    setSpriteVisible(false);
    expect(getSpriteVisible()).toBe(false);
    setSpriteVisible(true);
    expect(getSpriteVisible()).toBe(true);
  });

  it("applySpriteVisible(false) → 寫入 localStorage 且 body 加上 no-sprite class", () => {
    applySpriteVisible(false);
    expect(getSpriteVisible()).toBe(false);
    expect(document.body.classList.contains("no-sprite")).toBe(true);
  });

  it("applySpriteVisible(true) → body 移除 no-sprite class", () => {
    applySpriteVisible(false);
    applySpriteVisible(true);
    expect(getSpriteVisible()).toBe(true);
    expect(document.body.classList.contains("no-sprite")).toBe(false);
  });
});

// 嘴型敏感度（getMouthLow/High）已隨拉桿退役——相關測試一併移除。

describe("SettingsPanel —— DOM 建構＋開關", () => {
  it("建構時面板預設隱藏，DOM 掛進傳入的 container", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({ container });
    const panelEl = container.querySelector(".settings-panel");
    expect(panelEl).not.toBeNull();
    expect(panelEl.hidden).toBe(true);
    void panel;
  });

  it("開關殼是 <label>：點 track/thumb（真實滑鼠落點）轉發給 checkbox（真機實測修法）", () => {
    // 教訓：程式化 input.click() 驗不到真實落點——真滑鼠點到的是
    // 疊在透明 checkbox 上的裝飾 span。label 包裹＝原生 activation 轉發，這裡
    // 直接點 thumb 斷言 checkbox 真的翻。
    const container = makeContainer();
    void new SettingsPanel({ container });
    const toggle = container.querySelector(".settings-toggle");
    expect(toggle.tagName).toBe("LABEL");
    const input = toggle.querySelector("input");
    const thumb = toggle.querySelector(".settings-toggle-thumb");
    expect(input.checked).toBe(false); // 語音朗讀預設關
    thumb.click(); // 點裝飾層＝真實操作
    expect(input.checked).toBe(true);
    thumb.click();
    expect(input.checked).toBe(false);
  });

  it("open()/close()/toggle() 正確切換 hidden 狀態", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({ container });
    const panelEl = container.querySelector(".settings-panel");
    panel.open();
    expect(panelEl.hidden).toBe(false);
    panel.close();
    expect(panelEl.hidden).toBe(true);
    panel.toggle();
    expect(panelEl.hidden).toBe(false);
    panel.toggle();
    expect(panelEl.hidden).toBe(true);
  });

  it("點暗幕（panel 本身）→ 面板隱藏（叉叉退役後唯一關法）", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({ container });
    panel.open();
    // .click() 的 target 就是 panel 自己＝暗幕命中（點 sheet 內元素 target 不是
    // panel、不會誤關——由下一個測試的反向斷言蓋）。
    container.querySelector(".settings-panel").click();
    expect(container.querySelector(".settings-panel").hidden).toBe(true);
  });

  it("點 sheet 內容不誤關面板", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({ container });
    panel.open();
    container.querySelector(".settings-sheet").click();
    expect(container.querySelector(".settings-panel").hidden).toBe(false);
  });

  it("即時套用：面板內沒有送出／叉叉 button（點暗幕即關；語言下拉的 trigger／選項是選擇控件，不算送出或叉叉）", () => {
    const container = makeContainer();
    new SettingsPanel({ container });
    const buttons = [...container.querySelectorAll(".settings-panel button")];
    // 5＝語言下拉（trigger 1＋選項 3，auto／zh-Hant／en）＋常駐的「檢查更新」1 顆
    // ——全是功能控制項，沒有任何「送出／關閉」類按鈕（本測試真正要擋的對象）。
    expect(buttons.length).toBe(5);
    expect(buttons.every((b) => b.type === "button")).toBe(true);
    expect(container.querySelector("form")).toBeNull();
  });
});

describe("SettingsPanel —— TTS 開關 checkbox（即時套用）", () => {
  it("初始 checked 狀態反映當下 getTtsEnabled()", () => {
    setTtsEnabled(true);
    const container = makeContainer();
    new SettingsPanel({ container });
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    // 第一顆 checkbox＝語音朗讀（TTS），第二顆＝顯示立繪（見 settings.js 建構順序）。
    expect(checkboxes[0].checked).toBe(true);
  });

  it("勾選／取消勾選立即寫入 localStorage，不需要任何送出動作", () => {
    const container = makeContainer();
    new SettingsPanel({ container });
    const ttsCheckbox = container.querySelectorAll('input[type="checkbox"]')[0];
    expect(getTtsEnabled()).toBe(false);
    ttsCheckbox.checked = true;
    ttsCheckbox.dispatchEvent(new Event("change"));
    expect(getTtsEnabled()).toBe(true);
    ttsCheckbox.checked = false;
    ttsCheckbox.dispatchEvent(new Event("change"));
    expect(getTtsEnabled()).toBe(false);
  });
});

describe("SettingsPanel —— 立繪顯示開關 checkbox（同步 topbar 收起鈕的同一份狀態）", () => {
  it("初始 checked 反映 getSpriteVisible()", () => {
    setSpriteVisible(false);
    const container = makeContainer();
    new SettingsPanel({ container });
    const spriteCheckbox = container.querySelectorAll('input[type="checkbox"]')[1];
    expect(spriteCheckbox.checked).toBe(false);
  });

  it("切換 → 呼叫 applySpriteVisible（body class 同步）並觸發 onSpriteVisibleChange 回呼", () => {
    const container = makeContainer();
    const onSpriteVisibleChange = vi.fn();
    new SettingsPanel({ container, onSpriteVisibleChange });
    const spriteCheckbox = container.querySelectorAll('input[type="checkbox"]')[1];

    spriteCheckbox.checked = false;
    spriteCheckbox.dispatchEvent(new Event("change"));

    expect(getSpriteVisible()).toBe(false);
    expect(document.body.classList.contains("no-sprite")).toBe(true);
    expect(onSpriteVisibleChange).toHaveBeenCalledWith(false);
  });

  it("省略 onSpriteVisibleChange 回呼不會炸（防禦：呼叫端沒傳也要能正常運作）", () => {
    const container = makeContainer();
    new SettingsPanel({ container });
    const spriteCheckbox = container.querySelectorAll('input[type="checkbox"]')[1];
    expect(() => {
      spriteCheckbox.checked = false;
      spriteCheckbox.dispatchEvent(new Event("change"));
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review 抓到的真實回歸：舊版每個控制項只在建構當下讀一次 checked/value，之後
//完全不會再讀。立繪顯示開關有「兩個獨立入口」（topbar 收起他鈕呼叫的
// applySpriteVisible、這顆 checkbox 自己）能改同一份狀態——先按 topbar 鈕、
// 再第一次打開面板，checkbox 會停在建構當下的舊值，跟畫面實際狀態矛盾。
// 下面直接重現這個情境：建構 panel（此時面板還沒 open，checkbox 只是建好、
// 沒顯示）→ 用「topbar 鈕實際呼叫的同一支函式」從外部改狀態 → 呼叫 open()／
// toggle() → 斷言 checkbox 現在反映的是外部改完之後的真值，不是建構當下值。
// ─────────────────────────────────────────────────────────────────────────────
describe("SettingsPanel —— 開啟前重新整理（修正：舊值不會卡住不跟著外部狀態變化）", () => {
  it("建構後由外部路徑（topbar 鈕會呼叫的同一支 applySpriteVisible）收起立繪，開啟面板 → checkbox 顯示未勾選", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({ container }); // getSpriteVisible() 預設 true → 建構當下 checked=true
    applySpriteVisible(false); // 外部路徑：跟 topbar「收起他」鈕實際呼叫的函式完全相同
    panel.open();
    const spriteCheckbox = container.querySelectorAll('input[type="checkbox"]')[1];
    expect(spriteCheckbox.checked).toBe(false);
  });

  it("反方向：建構時立繪已收起，外部路徑改回顯示，開啟面板 → checkbox 顯示已勾選", () => {
    setSpriteVisible(false);
    const container = makeContainer();
    const panel = new SettingsPanel({ container }); // 建構當下 checked=false
    applySpriteVisible(true); // 外部路徑改回顯示
    panel.open();
    const spriteCheckbox = container.querySelectorAll('input[type="checkbox"]')[1];
    expect(spriteCheckbox.checked).toBe(true);
  });

  it("toggle() 從隱藏切到顯示的那一次，跟 open() 走同一條重新整理防線", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({ container });
    applySpriteVisible(false);
    panel.toggle(); // hidden → visible
    const spriteCheckbox = container.querySelectorAll('input[type="checkbox"]')[1];
    expect(spriteCheckbox.checked).toBe(false);
  });

  it("TTS 開關同一條防線：外部直接呼叫 setTtsEnabled（模擬任何未來會寫這個 key 的呼叫端），開啟面板時 checkbox 跟上真值", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({ container }); // getTtsEnabled() 預設 false → 建構當下 checked=false
    setTtsEnabled(true);
    panel.open();
    const ttsCheckbox = container.querySelectorAll('input[type="checkbox"]')[0];
    expect(ttsCheckbox.checked).toBe(true);
  });

  it("面板內恰兩顆 range＝眨眼在上、嘴型在下（RMS 舊拉桿仍退役）", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({ container });
    panel.open();
    const ranges = container.querySelectorAll('input[type="range"]');
    expect(ranges.length).toBe(2);
    expect(ranges[0].classList.contains("settings-blink-slider")).toBe(true);
    expect(ranges[1].classList.contains("settings-speed-slider")).toBe(true);
  });
});

describe("眨眼頻率 —— localStorage v4.blinkBaseMs（自助拉桿，位於嘴型上方）", () => {
  it("未設定過 → 預設 3000（＝現役 1800-4200 區間中心）；set 後讀回、越界 clamp", () => {
    expect(getBlinkBaseMs()).toBe(3000);
    setBlinkBaseMs(2000);
    expect(getBlinkBaseMs()).toBe(2000);
    setBlinkBaseMs(100);
    expect(getBlinkBaseMs()).toBe(BLINK_BASE_MIN);
    setBlinkBaseMs(99999);
    expect(getBlinkBaseMs()).toBe(BLINK_BASE_MAX);
    setBlinkBaseMs("not-a-number"); // 無效輸入不寫入
    expect(getBlinkBaseMs()).toBe(BLINK_BASE_MAX);
  });

  it("拉桿方向＝左慢右快（滑桿值是間隔的鏡射）；拖動→寫 localStorage＋回呼基準值", () => {
    const container = makeContainer();
    const seen = [];
    const panel = new SettingsPanel({ container, onBlinkSpeedChange: (ms) => seen.push(ms) });
    panel.open();
    const slider = container.querySelector(".settings-blink-slider");
    // 預設 3000 → 滑桿值＝1500+6000−3000＝4500
    expect(slider.value).toBe("4500");
    // 拖到最右（6000）＝眨最勤＝基準間隔 1500
    slider.value = "6000";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(seen).toEqual([1500]);
    expect(getBlinkBaseMs()).toBe(1500);
    // 開面板 refresh 套回鏡射值
    panel.close();
    panel.open();
    expect(slider.value).toBe("6000");
  });
});

describe("嘴型速度 —— localStorage v4.mouthFlapMs（自助拉桿）", () => {
  it("未設定過 → 預設 105；set 後讀回、越界 clamp 到 60-180", () => {
    expect(getMouthFlapMs()).toBe(105);
    setMouthFlapMs(130);
    expect(getMouthFlapMs()).toBe(130);
    setMouthFlapMs(10);
    expect(getMouthFlapMs()).toBe(MOUTH_FLAP_MIN);
    setMouthFlapMs(999);
    expect(getMouthFlapMs()).toBe(MOUTH_FLAP_MAX);
    setMouthFlapMs("not-a-number"); // 無效輸入不寫入
    expect(getMouthFlapMs()).toBe(MOUTH_FLAP_MAX);
  });

  it("拉桿方向＝左慢右快（滑桿值是拍速的鏡射）；拖動→寫 localStorage＋回呼拍速", () => {
    const container = makeContainer();
    const seen = [];
    const panel = new SettingsPanel({ container, onMouthSpeedChange: (ms) => seen.push(ms) });
    panel.open();
    const slider = container.querySelector(".settings-speed-slider");
    // 預設 105 → 滑桿值＝60+180−105＝135
    expect(slider.value).toBe("135");
    // 拖到最右（180）＝最快＝拍速 60
    slider.value = "180";
    slider.dispatchEvent(new Event("input", { bubbles: true }));
    expect(seen).toEqual([60]);
    expect(getMouthFlapMs()).toBe(60);
    // 開面板 refresh 套回鏡射值
    panel.close();
    panel.open();
    expect(slider.value).toBe("180");
  });
});

describe("SettingsPanel —— TTS 說明句已退役（額度行保留）", () => {
  it("面板內不再有「每句話都會出聲」說明句；額度行元素仍在（hidden 待 _refresh）", () => {
    const container = makeContainer();
    new SettingsPanel({ container, ttsUsageEndpoint: "/api/v4/tts-usage" });
    const notes = [...container.querySelectorAll(".settings-note")];
    expect(notes.some((n) => n.textContent.includes("每句話都會出聲"))).toBe(false);
    expect(container.querySelector(".settings-tts-usage")).not.toBeNull();
  });
});

describe("SettingsPanel — 模型切換區（config.models 驅動）", () => {
  const MODELS = [
    { id: "opus", label: "Opus 5" },
    { id: "fable", label: "Fable 5" },
  ];

  it("沒傳 modelOptions → 整區不出現（公開樹 fallback；既有面板零影響）", () => {
    const container = makeContainer();
    new SettingsPanel({ container });
    expect(container.querySelector(".settings-model-group")).toBeNull();
  });

  it("傳 modelOptions → radio 群組出現、_refresh 依 getCurrentModel 勾選", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({
      container,
      modelOptions: MODELS,
      modelEndpoint: "/api/v4/model",
      getCurrentModel: () => "fable",
    });
    panel.open();
    const inputs = [...container.querySelectorAll('.settings-model-option input')];
    expect(inputs.length).toBe(2);
    expect(inputs.find((i) => i.value === "fable").checked).toBe(true);
    expect(inputs.find((i) => i.value === "opus").checked).toBe(false);
  });

  it("切換成功：POST 端點 body {'model': id}、onModelChange 收到 id、note 回預設句", async () => {
    const container = makeContainer();
    const onModelChange = vi.fn();
    global.fetch = vi.fn(async () => ({ ok: true }));
    const panel = new SettingsPanel({
      container,
      modelOptions: MODELS,
      modelEndpoint: "/api/v4/model",
      getCurrentModel: () => "opus",
      onModelChange,
    });
    panel.open();
    await panel._switchModel("fable");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("/api/v4/model");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ model: "fable" });
    expect(onModelChange).toHaveBeenCalledWith("fable");
    expect(container.querySelector(".settings-model-note").textContent).toContain("換一顆腦");
  });

  it("端點未就緒（404）：radio 還原成當前值、note 誠實報「尚未支援」、不呼叫 onModelChange", async () => {
    const container = makeContainer();
    const onModelChange = vi.fn();
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    const panel = new SettingsPanel({
      container,
      modelOptions: MODELS,
      modelEndpoint: "/api/v4/model",
      getCurrentModel: () => "opus",
      onModelChange,
    });
    panel.open();
    await panel._switchModel("fable");
    expect(onModelChange).not.toHaveBeenCalled();
    const inputs = [...container.querySelectorAll('.settings-model-option input')];
    expect(inputs.find((i) => i.value === "opus").checked).toBe(true);
    expect(inputs.find((i) => i.value === "fable").checked).toBe(false);
    expect(container.querySelector(".settings-model-note").textContent).toContain("尚未支援");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 沙盒測試模式開關——
// sandboxAvailable 是建構當下就解出的靜態旗標（同 modelOptions 既有慣例：
// config 缺鍵／後端 flag 未開時 app.js 傳 false，整列不出現，開源殼零成本）；
// getSandboxOn 是即時 getter（同 getCurrentModel）；onSandboxChange 是 app.js
// 包好的非同步流程（POST＋狀態套用＋status 行，見 sandbox.test.js），失敗會
// reject——本檔只驗 checkbox 視覺本身：confirm 開關、取消／失敗撥回。
// ─────────────────────────────────────────────────────────────────────────────
function flushPromises() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SettingsPanel — 沙盒測試模式開關（sandboxAvailable 驅動列存在與否）", () => {
  it("沒傳 sandboxAvailable（或傳 false）→ 整列不出現，且不影響既有 TTS/立繪 checkbox 索引", () => {
    const container = makeContainer();
    new SettingsPanel({ container });
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(2); // 只有 TTS／立繪，沒有第三顆
    expect(checkboxes[0].checked).toBe(false); // TTS 預設關（既有行為零影響）
  });

  it("sandboxAvailable: true → 出現「沙盒模式」列，checkbox 初始 checked 反映 getSandboxOn()", () => {
    const container = makeContainer();
    new SettingsPanel({ container, sandboxAvailable: true, getSandboxOn: () => true });
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(3);
    expect(checkboxes[0].checked).toBe(true); // 沙盒列放最頂——第一顆
  });

  it("放模型切換區「上方」：語言列之後緊接沙盒列（label 文字「沙盒模式」）＋下方 note 一行", () => {
    const container = makeContainer();
    new SettingsPanel({
      container,
      sandboxAvailable: true,
      getSandboxOn: () => false,
      modelOptions: [{ id: "opus", label: "Opus 5" }],
    });
    const body = container.querySelector(".settings-panel-body");
    // index 0＝語言列（永遠最前，見 i18n 任務 3 的 [data-setting="lang"]）；
    // 沙盒列緊接在它之後。
    const firstRow = body.children[1];
    expect(firstRow.classList.contains("settings-row")).toBe(true);
    expect(firstRow.querySelector("label").textContent).toBe("沙盒模式");
    // 命名改沙盒的語意補償：緊接列下的小字說明（settings-note 既有樣式）
    expect(firstRow.nextElementSibling.classList.contains("settings-note")).toBe(true);
    expect(firstRow.nextElementSibling.textContent).toBe("在沙盒裡的對話不會留下任何痕跡。");
  });

  it("setSandboxChecked：跨裝置廣播同步 toggle 勾選態；沙盒列不存在＝安靜 no-op", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({ container, sandboxAvailable: true, getSandboxOn: () => true });
    const input = container.querySelector('input[type="checkbox"]');
    expect(input.checked).toBe(true);
    panel.setSandboxChecked(false);
    expect(input.checked).toBe(false);
    panel.setSandboxChecked(true);
    expect(input.checked).toBe(true);
    const bare = new SettingsPanel({ container: makeContainer() }); // 無沙盒列
    expect(() => bare.setSandboxChecked(true)).not.toThrow();
  });

  it("開關殼是 <label>（同「顯示立繪」列的既有 markup，真實點擊落點相容）", () => {
    const container = makeContainer();
    new SettingsPanel({ container, sandboxAvailable: true, getSandboxOn: () => false });
    const toggle = container.querySelector(".settings-row .settings-toggle");
    expect(toggle.tagName).toBe("LABEL");
    expect(toggle.querySelector(".settings-toggle-thumb")).not.toBeNull();
  });

  // 確認窗改自刻 confirmDialog（系統窗醜＋露網域）——以下四測
  // 從 window.confirm mock 改成跟真彈窗 DOM 互動（.confirm-veil／.confirm-ok／
  // .confirm-cancel＝真元件真路徑，元件本身的鍵盤／暗幕／單例另測 confirm.test.js）。
  it("開啟（ON）不彈確認窗：直接呼叫 onSandboxChange(true)", () => {
    const container = makeContainer();
    const onSandboxChange = vi.fn().mockResolvedValue(undefined);
    new SettingsPanel({ container, sandboxAvailable: true, getSandboxOn: () => false, onSandboxChange });
    const input = container.querySelector('input[type="checkbox"]');
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    expect(document.querySelector(".confirm-veil")).toBeNull();
    expect(onSandboxChange).toHaveBeenCalledWith(true);
  });

  it("關閉（OFF）彈自刻確認窗；取消 → 不呼叫 onSandboxChange、checkbox 撥回勾選", async () => {
    const container = makeContainer();
    const onSandboxChange = vi.fn();
    new SettingsPanel({ container, sandboxAvailable: true, getSandboxOn: () => true, onSandboxChange });
    const input = container.querySelector('input[type="checkbox"]');
    expect(input.checked).toBe(true);
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    const veil = document.querySelector(".confirm-veil");
    expect(veil).not.toBeNull(); // 自刻彈窗真的開了
    expect(veil.querySelector(".confirm-msg").textContent).toBe("關閉沙盒模式：若有沙盒對話將被銷毀，確定？");
    veil.querySelector(".confirm-cancel").click();
    await flushPromises();
    expect(document.querySelector(".confirm-veil")).toBeNull(); // 關窗零殘留
    expect(onSandboxChange).not.toHaveBeenCalled();
    expect(input.checked).toBe(true); // 取消＝撥回開著
  });

  it("關閉確認後：呼叫 onSandboxChange(false)；成功則維持未勾選（不假裝切換成功之外，也不多此一舉撥回）", async () => {
    const container = makeContainer();
    const onSandboxChange = vi.fn().mockResolvedValue(undefined);
    new SettingsPanel({ container, sandboxAvailable: true, getSandboxOn: () => true, onSandboxChange });
    const input = container.querySelector('input[type="checkbox"]');
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    document.querySelector(".confirm-veil .confirm-ok").click();
    await flushPromises();
    expect(onSandboxChange).toHaveBeenCalledWith(false);
    expect(input.checked).toBe(false);
  });

  it("關閉確認後 onSandboxChange 失敗（POST 失敗等）→ checkbox 撥回切之前的狀態，不假裝切換成功", async () => {
    const container = makeContainer();
    const onSandboxChange = vi.fn().mockRejectedValue(new Error("network"));
    new SettingsPanel({ container, sandboxAvailable: true, getSandboxOn: () => true, onSandboxChange });
    const input = container.querySelector('input[type="checkbox"]');
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    document.querySelector(".confirm-veil .confirm-ok").click();
    await flushPromises();
    expect(input.checked).toBe(true); // 失敗＝撥回原狀
  });

  it("開啟時 onSandboxChange 失敗（POST 失敗等）→ checkbox 撥回未勾選", async () => {
    const container = makeContainer();
    const onSandboxChange = vi.fn().mockRejectedValue(new Error("network"));
    new SettingsPanel({ container, sandboxAvailable: true, getSandboxOn: () => false, onSandboxChange });
    const input = container.querySelector('input[type="checkbox"]');
    input.checked = true;
    input.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(input.checked).toBe(false);
  });

  it("_refresh／open()：重新讀 getSandboxOn() 套回 checkbox（同既有立繪開關防線，見上方「開啟前重新整理」區塊）", () => {
    const container = makeContainer();
    let on = false;
    const panel = new SettingsPanel({ container, sandboxAvailable: true, getSandboxOn: () => on });
    on = true; // 外部狀態改變（模擬其他入口造成的變化，如 MENU 忘記暫存流程）
    panel.open();
    const input = container.querySelector('input[type="checkbox"]');
    expect(input.checked).toBe(true);
  });

  it("省略 onSandboxChange 不會炸（防禦：呼叫端沒傳也要能正常運作）", () => {
    const container = makeContainer();
    new SettingsPanel({ container, sandboxAvailable: true, getSandboxOn: () => false });
    const input = container.querySelector('input[type="checkbox"]');
    expect(() => {
      input.checked = true;
      input.dispatchEvent(new Event("change"));
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Thinking 開關（第三列）：三件組整套照 sandbox 慣例——thoughtsToggleAvailable
// 靜態旗標驅動列存在與否；getThoughtsVisible 即時 getter；
// onThoughtsVisibleChange 是 app.js 包好的非同步切換（POST＋body class），失敗
// reject＝checkbox 撥回。與沙盒的差異：無 confirm 窗（切換無銷毀語意，隨時可逆）。
// ─────────────────────────────────────────────────────────────────────────────
describe("SettingsPanel — Thinking 開關（thoughtsToggleAvailable 驅動列存在與否）", () => {
  it("沒傳 thoughtsToggleAvailable（或 false）→ 整列不出現（開源殼零成本），既有 checkbox 數不變", () => {
    const container = makeContainer();
    new SettingsPanel({ container });
    expect(container.querySelectorAll('input[type="checkbox"]').length).toBe(2); // TTS／立繪
  });

  it("available: true → 出現「顯示思考鏈」列＋note 一行，初始 checked 反映 getThoughtsVisible()", () => {
    const container = makeContainer();
    new SettingsPanel({
      container,
      thoughtsToggleAvailable: true,
      getThoughtsVisible: () => true,
    });
    const checkboxes = container.querySelectorAll('input[type="checkbox"]');
    expect(checkboxes.length).toBe(3);
    expect(checkboxes[0].checked).toBe(true); // 無沙盒列時思考鏈列是第一顆
    const rows = container.querySelectorAll(".settings-row");
    const labels = Array.from(rows).map((r) => {
      const l = r.querySelector("label");
      return l ? l.textContent : "";
    });
    expect(labels).toContain("顯示思考鏈");
  });

  it("第三列順位：沙盒 → 模型之後、語音朗讀之前（DOM 相對順序驗證）", () => {
    const container = makeContainer();
    new SettingsPanel({
      container,
      sandboxAvailable: true,
      getSandboxOn: () => false,
      modelOptions: [{ id: "opus", label: "Opus 5" }],
      thoughtsToggleAvailable: true,
      getThoughtsVisible: () => true,
    });
    const body = container.querySelector(".settings-panel-body");
    const kids = Array.from(body.children);
    const textOfRow = (el) => {
      const l = el.querySelector && el.querySelector("label");
      return l ? l.textContent : "";
    };
    const idxSandbox = kids.findIndex((el) => textOfRow(el) === "沙盒模式");
    const idxModel = kids.findIndex((el) => textOfRow(el) === "模型");
    const idxThoughts = kids.findIndex((el) => textOfRow(el) === "顯示思考鏈");
    const idxTts = kids.findIndex((el) => textOfRow(el) === "語音朗讀");
    expect(idxSandbox).toBeGreaterThanOrEqual(0);
    expect(idxModel).toBeGreaterThan(idxSandbox);
    expect(idxThoughts).toBeGreaterThan(idxModel); // 第三：模型之後
    expect(idxTts).toBeGreaterThan(idxThoughts); // 語音朗讀退第四
    // note 一行緊接列下（settings-note 既有樣式）
    const thoughtsRow = kids[idxThoughts];
    expect(thoughtsRow.nextElementSibling.classList.contains("settings-note")).toBe(true);
    expect(thoughtsRow.nextElementSibling.textContent).toBe(
      "角色回覆前的思緒卡。關閉後不再轉寫思緒、省一點額度——角色照樣先想後說。",
    );
  });

  it("切換（開→關）不彈 confirm 窗、直接呼叫 onThoughtsVisibleChange(false)；成功維持未勾選", async () => {
    const container = makeContainer();
    const onThoughtsVisibleChange = vi.fn().mockResolvedValue(undefined);
    new SettingsPanel({
      container,
      thoughtsToggleAvailable: true,
      getThoughtsVisible: () => true,
      onThoughtsVisibleChange,
    });
    const input = container.querySelector('input[type="checkbox"]');
    expect(input.checked).toBe(true);
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    expect(document.querySelector(".confirm-veil")).toBeNull(); // 無確認窗
    await flushPromises();
    expect(onThoughtsVisibleChange).toHaveBeenCalledWith(false);
    expect(input.checked).toBe(false);
  });

  it("onThoughtsVisibleChange 失敗（POST 失敗等）→ checkbox 撥回切之前的狀態（誠實原則同沙盒）", async () => {
    const container = makeContainer();
    const onThoughtsVisibleChange = vi.fn().mockRejectedValue(new Error("network"));
    new SettingsPanel({
      container,
      thoughtsToggleAvailable: true,
      getThoughtsVisible: () => true,
      onThoughtsVisibleChange,
    });
    const input = container.querySelector('input[type="checkbox"]');
    input.checked = false;
    input.dispatchEvent(new Event("change"));
    await flushPromises();
    expect(input.checked).toBe(true); // 失敗＝撥回開著
  });

  it("setThoughtsVisibleChecked：跨裝置廣播同步勾選態；列不存在＝安靜 no-op", () => {
    const container = makeContainer();
    const panel = new SettingsPanel({
      container,
      thoughtsToggleAvailable: true,
      getThoughtsVisible: () => true,
    });
    const input = container.querySelector('input[type="checkbox"]');
    panel.setThoughtsVisibleChecked(false);
    expect(input.checked).toBe(false);
    panel.setThoughtsVisibleChecked(true);
    expect(input.checked).toBe(true);
    const bare = new SettingsPanel({ container: makeContainer() });
    expect(() => bare.setThoughtsVisibleChecked(false)).not.toThrow();
  });

  it("_refresh／open()：重新讀 getThoughtsVisible() 套回 checkbox（跨裝置改動後開面板看到真值）", () => {
    const container = makeContainer();
    let visible = true;
    const panel = new SettingsPanel({
      container,
      thoughtsToggleAvailable: true,
      getThoughtsVisible: () => visible,
    });
    visible = false; // 模擬另一台裝置切掉後的狀態
    panel.open();
    const input = container.querySelector('input[type="checkbox"]');
    expect(input.checked).toBe(false);
  });

  it("省略 onThoughtsVisibleChange 不會炸（防禦：呼叫端沒傳也要能正常運作）", () => {
    const container = makeContainer();
    new SettingsPanel({
      container,
      thoughtsToggleAvailable: true,
      getThoughtsVisible: () => true,
    });
    const input = container.querySelector('input[type="checkbox"]');
    expect(() => {
      input.checked = false;
      input.dispatchEvent(new Event("change"));
    }).not.toThrow();
  });
});

describe("SettingsPanel — 手機模型自刻下拉（原生 select 系統清單太醜，改 cmd-pop 設計語言）", () => {
  const MODELS = [
    { id: "opus46", label: "Opus 4.6" },
    { id: "opus", label: "Opus 5" },
    { id: "fable", label: "Fable 5" },
  ];

  function makeDdPanel(extra = {}) {
    const container = makeContainer();
    const panel = new SettingsPanel({
      container,
      modelOptions: MODELS,
      modelEndpoint: "/api/v4/model",
      getCurrentModel: () => "opus46",
      ...extra,
    });
    panel.open();
    return { container, panel };
  }

  it("渲染：trigger＋清單三項＋原生 select 已退役（永不再出現）", () => {
    const { container } = makeDdPanel();
    expect(container.querySelector("select")).toBeNull();
    expect(container.querySelector(".settings-model-dd-trigger")).not.toBeNull();
    const items = [...container.querySelectorAll(".settings-model-dd-item")];
    expect(items.length).toBe(3);
    expect(items.map((i) => i.textContent)).toEqual(["Opus 4.6", "Opus 5", "Fable 5"]);
  });

  it("開面板＝trigger 顯示當前模型 label、清單收著、當前項掛 is-current", () => {
    const { container } = makeDdPanel();
    expect(container.querySelector(".settings-model-dd-label").textContent).toBe("Opus 4.6");
    expect(container.querySelector(".settings-model-dd-list").hidden).toBe(true);
    const current = container.querySelector(".settings-model-dd-item.is-current");
    expect(current.dataset.modelId).toBe("opus46");
    expect(current.getAttribute("aria-selected")).toBe("true");
  });

  it("點 trigger＝開清單（aria-expanded＋is-open）；再點＝收", () => {
    const { container } = makeDdPanel();
    const trigger = container.querySelector(".settings-model-dd-trigger");
    const list = container.querySelector(".settings-model-dd-list");
    trigger.click();
    expect(list.hidden).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.classList.contains("is-open")).toBe(true);
    trigger.click();
    expect(list.hidden).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("點項＝收清單＋走 _switchModel；成功後 trigger 文字與 is-current 同步新模型、radio 也跟", async () => {
    global.fetch = vi.fn(async () => ({ ok: true }));
    const { container, panel } = makeDdPanel();
    container.querySelector(".settings-model-dd-trigger").click();
    const fableItem = [...container.querySelectorAll(".settings-model-dd-item")]
      .find((i) => i.dataset.modelId === "fable");
    fableItem.click();
    expect(container.querySelector(".settings-model-dd-list").hidden).toBe(true);
    await vi.waitFor(() => {
      expect(container.querySelector(".settings-model-dd-label").textContent).toBe("Fable 5");
    });
    expect(fableItem.classList.contains("is-current")).toBe(true);
    const radios = [...container.querySelectorAll(".settings-model-option input")];
    expect(radios.find((r) => r.value === "fable").checked).toBe(true);
  });

  it("切換失敗（404）＝revert：trigger 文字與 is-current 回當前模型", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    const { container, panel } = makeDdPanel();
    await panel._switchModel("fable");
    expect(container.querySelector(".settings-model-dd-label").textContent).toBe("Opus 4.6");
    const current = container.querySelector(".settings-model-dd-item.is-current");
    expect(current.dataset.modelId).toBe("opus46");
  });

  it("點 dropdown 以外＝收清單（document 層 listener）", () => {
    const { container } = makeDdPanel();
    container.querySelector(".settings-model-dd-trigger").click();
    const list = container.querySelector(".settings-model-dd-list");
    expect(list.hidden).toBe(false);
    document.body.click();
    expect(list.hidden).toBe(true);
  });
});

describe("language row", () => {
  it("renders first, lists auto/zh-Hant/en, and switching updates locale + panel texts live", () => {
    localStorage.clear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const panel = new SettingsPanel({ container });
    panel.open();
    const row = container.querySelector('[data-setting="lang"]');
    expect(row).toBeTruthy();
    expect(row.parentElement.firstElementChild).toBe(row);
    const values = Array.from(row.querySelectorAll("[data-value]")).map((el) => el.dataset.value);
    expect(values).toEqual(["auto", "zh-Hant", "en"]);
    row.querySelector('[data-value="en"]').click();
    expect(getLocale()).toBe("en");
    expect(localStorage.getItem(STORAGE_KEY)).toBe("en");
    expect(container.querySelector('[data-i18n="settings.title"]').textContent).toBe("Settings");
    expect(row.querySelector('[data-i18n="settings.lang"]').textContent).toBe("Language");
    row.querySelector('[data-value="auto"]').click();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    setLocale("zh-Hant", { persist: false });
    expect(container.querySelector('[data-i18n="settings.title"]').textContent).toBe("設定");
  });

  // Final review Minor 8：trigger 是 <button> 不是表單控制項，<label> 的
  // `for` 天生接不上——沒有 aria-labelledby 的話讀屏只念得到現值（如
  // 「English」），漏掉這欄在選什麼。label 給 id、trigger 用
  // aria-labelledby 兜「label 文字＋trigger 現值」兩顆節點成一句。
  it("label 與 trigger 有 aria-labelledby 關聯，讀屏念得出「Language」＋現值", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const panel = new SettingsPanel({ container });
    panel.open();
    const row = container.querySelector('[data-setting="lang"]');
    const labelEl = row.querySelector("label");
    const trigger = row.querySelector(".settings-dd-trigger");
    expect(labelEl.id).toBeTruthy();
    expect(trigger.id).toBeTruthy();
    expect(trigger.getAttribute("aria-labelledby")).toBe(`${labelEl.id} ${trigger.id}`);
  });

  // 回歸：i18n.js 的 commit() 在「目標值解回的語系＝目前已
  // 生效的語系」時會提早 return、不觸發 emit()——onLocaleChange 訂閱那條線完全
  // 不會跑。jsdom 的 navigator 語言是 en-US：從 zh-Hant 基準點 en（真的變更，
  // commit 會 emit）之後再點 auto，auto 解回的還是 en（跟目前已生效的 en 相
  // 同）——這時 commit() no-op，只有 click handler 直接呼叫的 sync() 能讓 row
  // 顯示跟上「使用者剛剛選了 auto」這件事，不能只靠訂閱通知。
  it("click 後即使 commit() 沒 emit（目標值解回目前已生效的語系）row 顯示也要立刻跟上，不能只靠 onLocaleChange 訂閱", () => {
    localStorage.clear();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const panel = new SettingsPanel({ container });
    panel.open();
    const row = container.querySelector('[data-setting="lang"]');
    const trigger = row.querySelector(".settings-dd-trigger");

    row.querySelector('[data-value="en"]').click();
    expect(getLocale()).toBe("en"); // 真的變更＝commit() 有 emit，先確認正常路徑沒壞
    expect(trigger.textContent.trim()).toBe("English");

    row.querySelector('[data-value="auto"]').click();
    // storage 確實被清了（setLocale("auto") 一定做這件事，跟 commit() 有沒有
    // no-op 無關）；但目前生效的語系仍是 en（jsdom navigator＝en-US，auto 解
    // 回的還是 en）——commit() 在這裡是 no-op、不會 emit。
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(getLocale()).toBe("en");

    const autoItem = row.querySelector('[data-value="auto"]');
    const enItem = row.querySelector('[data-value="en"]');
    expect(autoItem.getAttribute("aria-selected")).toBe("true");
    expect(autoItem.classList.contains("is-current")).toBe(true);
    expect(enItem.getAttribute("aria-selected")).toBe("false");
    expect(enItem.classList.contains("is-current")).toBe(false);
    // t() 用目前語系（此刻仍是 en，見上）算出 auto 選項此刻該顯示的字——
    // 不hardcode 字面值，locale 解到哪個都成立。
    expect(trigger.textContent.trim()).toBe(t("settings.langAuto"));
  });
});

describe("版本顯示與檢查更新（純本地顯示；只在主動點擊時查 GitHub）", () => {
  function buildPanel() {
    const container = makeContainer();
    const panel = new SettingsPanel({ container });
    panel.open();
    return panel;
  }

  it("設定頁常駐顯示目前版本（version.js 單一真相；零網路請求）", async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    buildPanel();
    const ver = document.querySelector(".settings-version");
    expect(ver).not.toBe(null);
    expect(ver.textContent).toBe("EverOtome v" + VERSION);
    expect(document.querySelector(".settings-check-update")).not.toBe(null);
    expect(fetchSpy).not.toHaveBeenCalled(); // 開面板不打任何請求——查詢只能由點擊觸發
  });

  it("點「檢查更新」查到新版：顯示新版本號＋「查看更新內容」連結（href 走回應的 GitHub 頁）", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ([{ tag_name: "v9.9.9-beta", html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta" }]),
    }));
    buildPanel();
    document.querySelector(".settings-check-update").click();
    await new Promise((r) => setTimeout(r, 0));
    const line = document.querySelector(".settings-update-result");
    expect(line.textContent).toContain("v9.9.9-beta");
    const a = line.querySelector("a");
    expect(a).not.toBe(null);
    expect(a.getAttribute("href")).toBe("https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta");
    expect(a.getAttribute("rel")).toBe("noopener");
    expect(a.classList.contains("feedback-link")).toBe(false); // 非回饋連結，不套用回饋連結配色
    expect(global.fetch).toHaveBeenCalledTimes(1); // 只查一次、只在點擊時
  });

  it("點「檢查更新」已是最新（tag 帶 v 前綴、剝掉後等於本地版本）：顯示已最新、無連結", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ([{ tag_name: "v" + VERSION, html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v" + VERSION }]),
    }));
    buildPanel();
    document.querySelector(".settings-check-update").click();
    await new Promise((r) => setTimeout(r, 0));
    const line = document.querySelector(".settings-update-result");
    expect(line.textContent).toBe(t("settings.updateLatest"));
    expect(line.querySelector("a")).toBe(null);
  });

  it("查詢失敗（斷網）：簡短提示＋回報問題連結（Mira 2026-08-27 規則：每一條錯誤路徑都要有）、按鈕復原可再按、不影響其他設定", async () => {
    global.fetch = vi.fn(async () => { throw new TypeError("network down"); });
    buildPanel();
    const btn = document.querySelector(".settings-check-update");
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    const line = document.querySelector(".settings-update-result");
    expect(line.textContent).toContain(t("settings.updateFailed"));
    const a = line.querySelector("a");
    expect(a).not.toBe(null);
    expect(a.textContent).toBe(t("feedback.report"));
    expect(a.getAttribute("href")).toBe(FEEDBACK_URL);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener");
    expect(a.classList.contains("feedback-link")).toBe(true); // Mira 2026-08-27：三處回饋連結共用同一顆 class
    expect(btn.disabled).toBe(false); // 失敗後復原、可再試
  });

  it("回應的 html_url 非 github.com 網域：連結退回官方 releases 頁（href 白名單）", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ([{ tag_name: "v9.9.9-beta", html_url: "https://evil.example/x" }]),
    }));
    buildPanel();
    document.querySelector(".settings-check-update").click();
    await new Promise((r) => setTimeout(r, 0));
    const a = document.querySelector(".settings-update-result a");
    expect(a.getAttribute("href")).toBe("https://github.com/aveluneverse/EverOtome/releases");
  });

  it("查到結果後切換語系：結果行文字立刻跟著新語系重新渲染，不必重新查一次 API", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ([{ tag_name: "v" + VERSION, html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v" + VERSION }]),
    }));
    buildPanel();
    document.querySelector(".settings-check-update").click();
    await new Promise((r) => setTimeout(r, 0));
    const line = document.querySelector(".settings-update-result");
    expect(line.textContent).toBe(t("settings.updateLatest")); // 先確認查詢當下（zh-Hant）是對的
    setLocale("en", { persist: false });
    expect(line.textContent).toBe(t("settings.updateLatest")); // 換語系後立刻跟上，不必再點一次「檢查更新」
    expect(global.fetch).toHaveBeenCalledTimes(1); // 語系切換沒有再打一次 API
    setLocale("zh-Hant", { persist: false }); // 還原語系，不影響後面的測試
  });
});

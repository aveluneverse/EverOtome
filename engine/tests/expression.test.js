import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ExpressionController } from "../js/expression.js";

// __dirname 走 fileURLToPath（跟 sandbox.test.js 同一套）——jsdom 環境下
// `new URL("../x", import.meta.url)` 直接餵 fs.readFileSync 會炸「must be of
// scheme file」（import.meta.url 在這個測試環境不是純 file: URL），這個寫法
// 是全專案唯一已驗證能跑的路徑，不要換回去。
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 表情貼片控制器：manifest expressions 鍵宣告制；跟 SpritePlayer.onFrame
// 同步挑態（給幾態用幾態）；flash 2.5s 自退／sustain 90s 保底；release 淡回；換裝歸零。
const MANIFEST = {
  size: [1024, 1536],
  expressions: {
    laugh: { label: "笑", mode: "sustain", eyes: { any: "expr/laugh_eye_any.webp" }, mouth: {} },
    worried: {
      label: "擔心", mode: "sustain",
      eyes: { open: "expr/w_eye_open.webp", half: "expr/w_eye_half.webp", closed: "expr/w_eye_closed.webp" },
      mouth: { "0": "expr/w_mouth_0.webp", "1": "expr/w_mouth_1.webp", "2": "expr/w_mouth_2.webp" },
    },
    surprised: { label: "驚訝", mode: "flash", eyes: { any: "expr/s_eye_any.webp" }, mouth: { any: "expr/s_mouth_any.webp" } },
    twostate: {
      label: "二態", mode: "sustain",
      eyes: { open: "expr/t_open.webp", closed: "expr/t_closed.webp" },
      mouth: { "0": "expr/t_m0.webp", "2": "expr/t_m2.webp" },
    },
  },
};

beforeEach(() => {
  document.body.innerHTML = '<div id="stage"></div>';
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

function mk(opts) { return new ExpressionController(document.getElementById("stage"), opts); }
function shown() {
  return [...document.querySelectorAll(".sprite-expr img")]
    .filter((i) => i.style.opacity === "1").map((i) => i.getAttribute("src"));
}
function fakePlayer() { return { onFrame: null }; }

describe("ExpressionController — 掛層與宣告", () => {
  it("建構即掛 .sprite-expr（aria-hidden）；未 syncFrom 前 show()＝false 不炸", () => {
    const c = mk();
    const layer = document.querySelector("#stage .sprite-expr");
    expect(layer).not.toBeNull();
    expect(layer.getAttribute("aria-hidden")).toBe("true");
    expect(c.show("laugh")).toBe(false);
    expect(c.active).toBeNull();
  });

  it("syncFrom：每 zone 每 state 一顆 <img>（assetsPath+檔名、opacity 0）；無 expressions 鍵＝零 img、has()=false", () => {
    const c = mk();
    c.syncFrom(MANIFEST, "a/");
    const imgs = [...document.querySelectorAll(".sprite-expr img")];
    expect(imgs.length).toBe(1 + 6 + 2 + 4);
    expect(imgs.every((i) => i.style.opacity === "0")).toBe(true);
    expect(imgs.some((i) => i.getAttribute("src") === "a/expr/laugh_eye_any.webp")).toBe(true);
    expect(c.has("laugh")).toBe(true);
    c.syncFrom({ size: [1024, 1536] }, "b/");
    expect(document.querySelectorAll(".sprite-expr img").length).toBe(0);
    expect(c.has("laugh")).toBe(false);
    expect(c.show("laugh")).toBe(false);
  });

  it("static 單張造型：有 expressions 鍵也視同未宣告＝零 img、has()=false、show()=false", () => {
    const c = mk();
    c.syncFrom(MANIFEST, "a/");
    expect(document.querySelectorAll(".sprite-expr img").length).toBeGreaterThan(0);
    c.syncFrom({ static: true, image: "portrait.webp", expressions: MANIFEST.expressions }, "b/");
    expect(document.querySelectorAll(".sprite-expr img").length).toBe(0);
    expect(c.has("laugh")).toBe(false);
    expect(c.show("laugh")).toBe(false);
    expect(c.active).toBeNull();
  });

  it("syncFrom 換造型＝正在亮的表情瞬間歸零＋img 重建為新 assetsPath", () => {
    const c = mk();
    c.syncFrom(MANIFEST, "a/");
    c.show("laugh");
    expect(shown()).toEqual(["a/expr/laugh_eye_any.webp"]);
    c.syncFrom(MANIFEST, "b/");
    expect(shown()).toEqual([]);
    expect(c.active).toBeNull();
    expect(document.querySelector(".sprite-expr img").getAttribute("src").startsWith("b/")).toBe(true);
  });
});

describe("ExpressionController — 挑態（給幾態用幾態）", () => {
  it("laugh 只有 eyes.any：任何眼態都亮它、嘴區不貼", () => {
    const c = mk(); const p = fakePlayer(); c.bind(p);
    c.syncFrom(MANIFEST, "a/");
    p.onFrame("closed", 2);
    expect(c.show("laugh")).toBe(true);
    expect(shown()).toEqual(["a/expr/laugh_eye_any.webp"]);
    p.onFrame("half", 1);
    expect(shown()).toEqual(["a/expr/laugh_eye_any.webp"]);
  });

  it("worried 三態眼×三態嘴：跟著 onFrame 換態", () => {
    const c = mk(); const p = fakePlayer(); c.bind(p);
    c.syncFrom(MANIFEST, "a/");
    p.onFrame("open", 0);
    c.show("worried");
    expect(shown().sort()).toEqual(["a/expr/w_eye_open.webp", "a/expr/w_mouth_0.webp"]);
    p.onFrame("closed", 2);
    expect(shown().sort()).toEqual(["a/expr/w_eye_closed.webp", "a/expr/w_mouth_2.webp"]);
    p.onFrame("half", 1);
    expect(shown().sort()).toEqual(["a/expr/w_eye_half.webp", "a/expr/w_mouth_1.webp"]);
  });

  it("二態退化：half→open（硬切眨眼）、嘴 1→2", () => {
    const c = mk(); const p = fakePlayer(); c.bind(p);
    c.syncFrom(MANIFEST, "a/");
    p.onFrame("half", 1);
    c.show("twostate");
    expect(shown().sort()).toEqual(["a/expr/t_m2.webp", "a/expr/t_open.webp"]);
    p.onFrame("closed", 0);
    expect(shown().sort()).toEqual(["a/expr/t_closed.webp", "a/expr/t_m0.webp"]);
  });

  it("換態瞬切（transitionDuration 0s）、進場 0.35s、退場 0.6s、instant 0s", () => {
    const c = mk(); const p = fakePlayer(); c.bind(p);
    c.syncFrom(MANIFEST, "a/");
    p.onFrame("open", 0);
    c.show("worried");
    const byFile = (f) => [...document.querySelectorAll(".sprite-expr img")].find((i) => i.getAttribute("src") === "a/" + f);
    expect(byFile("expr/w_eye_open.webp").style.transitionDuration).toBe("0.35s");
    p.onFrame("closed", 0);
    expect(byFile("expr/w_eye_open.webp").style.transitionDuration).toBe("0s");
    expect(byFile("expr/w_eye_closed.webp").style.transitionDuration).toBe("0s");
    c.clear(false);
    expect(byFile("expr/w_eye_closed.webp").style.transitionDuration).toBe("0.6s");
    expect(shown()).toEqual([]);
    c.show("worried");
    c.clear(true);
    expect(byFile("expr/w_eye_closed.webp").style.transitionDuration).toBe("0s");
  });
});

describe("ExpressionController — 一瞬／持續／釋放", () => {
  it("flash：2.5s 後自退（2499ms 仍亮）", () => {
    const c = mk();
    c.syncFrom(MANIFEST, "a/");
    c.show("surprised");
    expect(shown().length).toBe(2);
    vi.advanceTimersByTime(2499);
    expect(shown().length).toBe(2);
    vi.advanceTimersByTime(1);
    expect(shown()).toEqual([]);
    expect(c.active).toBeNull();
  });

  it("sustain：90s 保底自退；重入同 id 重置計時", () => {
    const c = mk();
    c.syncFrom(MANIFEST, "a/");
    c.show("laugh");
    vi.advanceTimersByTime(50_000);
    c.show("laugh");
    vi.advanceTimersByTime(45_000);   // t=95s：若沒重置早就退了
    expect(shown()).toEqual(["a/expr/laugh_eye_any.webp"]);
    vi.advanceTimersByTime(45_000);   // t=140s
    expect(shown()).toEqual([]);
  });

  it("release：有 active 就淡回；沒 active 不炸；換另一個 id＝直接換臉", () => {
    const c = mk();
    c.syncFrom(MANIFEST, "a/");
    expect(() => c.release()).not.toThrow();
    c.show("laugh");
    c.release();
    expect(shown()).toEqual([]);
    c.show("laugh");
    c.show("surprised");
    expect(c.active).toBe("surprised");
    expect(shown().sort()).toEqual(["a/expr/s_eye_any.webp", "a/expr/s_mouth_any.webp"]);
  });

  it("opts 可調：flashHoldMs／sustainCapMs", () => {
    const c = mk({ flashHoldMs: 100, sustainCapMs: 300 });
    c.syncFrom(MANIFEST, "a/");
    c.show("surprised"); vi.advanceTimersByTime(100); expect(shown()).toEqual([]);
    c.show("laugh"); vi.advanceTimersByTime(300); expect(shown()).toEqual([]);
  });
});

// static 底色區＋自帶紅暈：常駐貼片畫在眼嘴之下，blush:"builtin" 期間壓住 .sprite-blush。
const MANIFEST_BUILTIN = {
  size: [1024, 1536],
  expressions: {
    laugh: { label: "笑", mode: "sustain", eyes: { any: "expr/laugh_eye_any.webp" }, mouth: {} },
    reachout: {
      label: "靠近", mode: "sustain", blush: "builtin",
      static: "expr/reachout_static.webp",
      eyes: { open: "expr/r_eye_open.webp", half: "expr/r_eye_half.webp", closed: "expr/r_eye_closed.webp" },
      mouth: { "0": "expr/r_mouth_0.webp", "1": "expr/r_mouth_1.webp", "2": "expr/r_mouth_2.webp" },
    },
  },
};

describe("ExpressionController — static 底色區＋自帶紅暈（blush:builtin）", () => {
  it("static 貼片 active 期間恆亮，且 DOM 順序在眼／嘴貼片之前（畫在下面）", () => {
    const c = mk(); const p = fakePlayer(); c.bind(p);
    c.syncFrom(MANIFEST_BUILTIN, "a/");
    p.onFrame("open", 0);
    c.show("reachout");
    expect(shown().sort()).toEqual(["a/expr/r_eye_open.webp", "a/expr/r_mouth_0.webp", "a/expr/reachout_static.webp"]);
    p.onFrame("closed", 2);
    expect(shown().sort()).toEqual(["a/expr/r_eye_closed.webp", "a/expr/r_mouth_2.webp", "a/expr/reachout_static.webp"]);
    const srcs = [...document.querySelectorAll(".sprite-expr img")].map((i) => i.getAttribute("src"));
    const iStatic = srcs.indexOf("a/expr/reachout_static.webp");
    const iEye = srcs.indexOf("a/expr/r_eye_open.webp");
    const iMouth = srcs.indexOf("a/expr/r_mouth_0.webp");
    expect(iStatic).toBeGreaterThan(-1);
    expect(iStatic).toBeLessThan(iEye);
    expect(iEye).toBeLessThan(iMouth);
  });

  it("static 進場淡入 0.35s、換態時 static 不重設 transition、退場 0.6s 一起淡", () => {
    const c = mk(); const p = fakePlayer(); c.bind(p);
    c.syncFrom(MANIFEST_BUILTIN, "a/");
    p.onFrame("open", 0);
    c.show("reachout");
    const st = [...document.querySelectorAll(".sprite-expr img")].find((i) => i.getAttribute("src") === "a/expr/reachout_static.webp");
    expect(st.style.transitionDuration).toBe("0.35s");
    p.onFrame("half", 1);
    expect(st.style.opacity).toBe("1");
    expect(st.style.transitionDuration).toBe("0.35s"); // 沒被換態動到
    c.clear(false);
    expect(st.style.transitionDuration).toBe("0.6s");
    expect(st.style.opacity).toBe("0");
  });

  it("blush:'builtin'：show 加容器 class expr-blush-builtin；release／clear／syncFrom 移除；非 builtin 表情不加", () => {
    const c = mk();
    c.syncFrom(MANIFEST_BUILTIN, "a/");
    const stage = document.getElementById("stage");
    c.show("laugh");
    expect(stage.classList.contains("expr-blush-builtin")).toBe(false);
    c.show("reachout");
    expect(stage.classList.contains("expr-blush-builtin")).toBe(true);
    c.release();
    expect(stage.classList.contains("expr-blush-builtin")).toBe(false);
    c.show("reachout");
    c.show("laugh");                       // 直接換成非 builtin 表情＝class 要拿掉
    expect(stage.classList.contains("expr-blush-builtin")).toBe(false);
    c.show("reachout");
    c.syncFrom({ size: [1024, 1536] }, "b/");   // 換裝
    expect(stage.classList.contains("expr-blush-builtin")).toBe(false);
    c.syncFrom(MANIFEST_BUILTIN, "a/");
    c.show("reachout");
    vi.advanceTimersByTime(90_000);        // 保底自退
    expect(stage.classList.contains("expr-blush-builtin")).toBe(false);
  });

  it("既有 laugh 語意不變：無 static／無 blush 鍵＝只亮 eyes.any、無 class", () => {
    const c = mk(); const p = fakePlayer(); c.bind(p);
    c.syncFrom(MANIFEST_BUILTIN, "a/");
    p.onFrame("half", 2);
    c.show("laugh");
    expect(shown()).toEqual(["a/expr/laugh_eye_any.webp"]);
    expect(document.getElementById("stage").classList.contains("expr-blush-builtin")).toBe(false);
  });
});

describe("CSS 契約：expr-blush-builtin（釘死 JS↔CSS class 名稱不漂移）", () => {
  it("sprite.css 對 .expr-blush-builtin .sprite-blush 仍是 opacity:0 !important", () => {
    const css = fs.readFileSync(path.join(__dirname, "../css/sprite.css"), "utf-8");
    expect(css).toContain(".expr-blush-builtin .sprite-blush");
    expect(css).toContain("opacity: 0 !important");
  });
});

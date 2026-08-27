// engine/tests/report-icon.test.js：回報問題手機版 icon 鈕（.report-icon-btn）。
// 直接讀 engine/index.html 原始檔，確保實際上線的 markup（不是測試自己搭的假
// fixture）真的長這樣、真的貼在 .brand-lockup 後面、真的只用一顆 SVG（零
// emoji）。JS 端行為（init 時 href 從 FEEDBACK_URL 覆寫、aria-label 跟著語系
// 換）另外在 version-chip.test.js 用局部容器測，這裡只管靜態原始檔本身。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FEEDBACK_URL } from "../js/feedback.js";

// __dirname 走 fileURLToPath（跟 file-protocol-note.test.js／sandbox.test.js
// 同一套；jsdom 環境下 `new URL("../x", import.meta.url)` 會被蓋掉，直接餵
// fs.readFileSync 會炸「must be of scheme file」）。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function extractReportIconBtn(source) {
  const m = source.match(/<a class="report-icon-btn feedback-link"[\s\S]*?<\/a>/);
  return m ? m[0] : null;
}

const snippet = extractReportIconBtn(html);

describe("report-icon-btn markup (engine/index.html)", () => {
  it("the anchor exists exactly once", () => {
    expect(snippet).not.toBe(null);
    expect((html.match(/class="report-icon-btn feedback-link"/g) || []).length).toBe(1);
  });

  it("sits after #ver-chip and before #char-name, inside <header id=\"brand\">", () => {
    const verChipAt = html.indexOf('id="ver-chip"');
    const charNameAt = html.indexOf('id="char-name"');
    const headerOpen = html.indexOf('<header id="brand">');
    const headerClose = html.indexOf("</header>", headerOpen);
    const anchorAt = html.indexOf(snippet);
    expect(verChipAt).toBeGreaterThan(-1);
    expect(charNameAt).toBeGreaterThan(-1);
    expect(headerOpen).toBeGreaterThan(-1);
    expect(anchorAt).toBeGreaterThan(verChipAt);
    expect(anchorAt).toBeLessThan(charNameAt);
    expect(anchorAt).toBeGreaterThan(headerOpen);
    expect(anchorAt).toBeLessThan(headerClose);
  });

  it("carries the exact href (matching FEEDBACK_URL), target, rel, aria-label and i18n hook", () => {
    expect(snippet).toContain(`href="${FEEDBACK_URL}"`);
    expect(snippet).toContain('target="_blank"');
    expect(snippet).toContain('rel="noopener"');
    expect(snippet).toContain('aria-label="回報問題"');
    expect(snippet).toContain('data-i18n-attr="aria-label:feedback.report"');
    expect(snippet).toContain('class="report-icon-btn feedback-link"');
  });

  it("wraps exactly one decorative svg icon (no emoji, matches the other header icon buttons' style)", () => {
    const svgMatches = snippet.match(/<svg[\s\S]*?<\/svg>/g) || [];
    expect(svgMatches.length).toBe(1);
    expect(svgMatches[0]).toContain('aria-hidden="true"');
    expect(svgMatches[0]).toContain('viewBox="0 0 24 24"');
    expect(svgMatches[0]).toContain('stroke="currentColor"');
    // 零 emoji（零其它視覺替代方案），純 SVG。
    expect(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(snippet)).toBe(false);
  });
});

describe("engine/css/layout.css: .report-icon-btn is desktop-hidden, mobile-visible; version-line text link/sep are mobile-hidden", () => {
  const cssPath = path.join(__dirname, "..", "css", "layout.css");
  const css = fs.readFileSync(cssPath, "utf8");

  it("desktop default hides the icon (shown only inside the mobile media query)", () => {
    expect(css).toMatch(/\.report-icon-btn\s*\{\s*display:\s*none;\s*\}/);
  });

  it("the mobile media query (899.98px, the one that also positions .chatlog-full-btn) shows the icon and hides the text link + its separator", () => {
    const mobileStart = css.indexOf("@media (max-width: 899.98px)");
    expect(mobileStart).toBeGreaterThan(-1);
    const fullBtnAt = css.indexOf(".chatlog-full-btn {", mobileStart);
    expect(fullBtnAt).toBeGreaterThan(mobileStart);
    const iconRuleAt = css.indexOf(".report-icon-btn {", fullBtnAt);
    expect(iconRuleAt).toBeGreaterThan(fullBtnAt);
    const iconBlock = css.slice(iconRuleAt, iconRuleAt + 700);
    expect(iconBlock).toMatch(/pointer-events:\s*auto/);
    expect(iconBlock).toMatch(/text-decoration:\s*none/);
    const hideAt = css.indexOf(".ver-chip-sep-report", iconRuleAt);
    expect(hideAt).toBeGreaterThan(iconRuleAt);
    const hideBlock = css.slice(hideAt, hideAt + 120);
    expect(hideBlock).toMatch(/\.ver-chip-report\s*\{\s*display:\s*none;\s*\}/);
  });

  it("mobile vertical-rhythm tokens exist on :root inside the mobile media query and feed the four rows", () => {
    const mobileStart = css.indexOf("@media (max-width: 899.98px)");
    const mobileBlock = css.slice(mobileStart, mobileStart + 1200);
    expect(mobileBlock).toMatch(/--m-head-h:\s*2\.2rem/);
    expect(mobileBlock).toMatch(/--m-status-top:\s*2\.6rem/);
    expect(mobileBlock).toMatch(/--m-msgs-top:\s*1\.7rem/);
    expect(mobileBlock).toMatch(/--m-full-pad:\s*3\.6rem/);
    expect(css).toMatch(/\.chatlog-head\s*\{[^}]*height:\s*var\(--m-head-h\)/);
    expect(css).toMatch(/top:\s*var\(--m-head-h\);/);
    expect(css).toMatch(/#chat-status\s*\{\s*top:\s*var\(--m-status-top\)/);
    expect(css).toMatch(/#msgs\s*\{\s*margin-top:\s*var\(--m-msgs-top\)/);
    expect(css).toMatch(/padding-top:\s*calc\(var\(--m-full-pad\)\s*\+\s*env\(safe-area-inset-top\)\)/);
    // 沒有殘留寫死值（確認四個屬性是真的換成 token，不是多加一份）。
    expect(css).not.toMatch(/\.chatlog-head\s*\{[^}]*height:\s*1\.9rem/);
    expect(css).not.toMatch(/#chat-status\s*\{\s*top:\s*2\.1rem/);
    expect(css).not.toMatch(/#msgs\s*\{\s*margin-top:\s*1\.3rem/);
    expect(css).not.toMatch(/padding-top:\s*calc\(2\.6rem\s*\+\s*env\(safe-area-inset-top\)\)/);
  });
});

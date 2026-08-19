// engine/tests/setup-i18n.js — jsdom 的 navigator.language 是 en-US；既有測試斷言繁中字串，
// 每個測試前把語系釘回 zh-Hant（不寫 localStorage）。i18n.test.js 自己切語系照樣被重設。
import { beforeEach } from "vitest";
import { setLocale } from "../js/i18n.js";
beforeEach(() => { setLocale("zh-Hant", { persist: false }); });

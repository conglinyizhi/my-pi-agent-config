import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Regression tests for notify-send module.
 *
 * Bug: the Linux fallback used `zenity --info`, which opens a modal dialog
 * instead of a desktop notification. Windows fallback used `msg *`, which also
 * creates a dialog. The module should only use native notification APIs.
 */
describe("notify-send module", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./notify-send.ts", import.meta.url)),
    "utf-8",
  );

  it("does not use zenity as a Linux notification fallback", () => {
    assert.strictEqual(
      source.includes("zenity"),
      false,
      "zenity opens dialogs and must not be used for desktop notifications",
    );
  });

  it("does not use msg as a Windows notification fallback", () => {
    assert.strictEqual(
      source.includes("msg *"),
      false,
      "msg * opens dialogs and must not be used for desktop notifications",
    );
  });

  it("supports sound on Linux", () => {
    const linuxBlock = source.match(/async function sendLinuxNotification[\s\S]*?\n\}/)?.[0] ?? "";
    assert(
      linuxBlock.includes("playLinuxSound"),
      "Linux notification should call a sound helper when requested",
    );
    assert(
      source.includes("canberra-gtk-play") || source.includes("paplay") || source.includes("ffplay"),
      "Linux sound helper should use canberra-gtk-play, paplay, or ffplay",
    );
  });

  it("supports sound on Windows", () => {
    const windowsBlock = source.match(/async function sendWindowsNotification[\s\S]*?\n\}/)?.[0] ?? "";
    assert(
      windowsBlock.includes("<audio"),
      "Windows toast should include an audio element for notification sound",
    );
  });

  it("supports sound on macOS", () => {
    const macBlock = source.match(/async function sendMacNotification[\s\S]*?\n\}/)?.[0] ?? "";
    assert(
      macBlock.includes('sound name'),
      "macOS notification should use sound name when requested",
    );
  });

  it("supports custom sound files", () => {
    assert(
      source.includes("soundFile?: string"),
      "NotifyOptions should accept a custom sound file path",
    );
    assert(
      source.includes("playWindowsSound") && source.includes("playMacSound") && source.includes("playLinuxSound"),
      "All platforms should have a custom sound file playback helper",
    );
  });
});

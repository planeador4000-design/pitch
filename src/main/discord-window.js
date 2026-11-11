'use strict';

// Discord's own app draws its voice/video calls; there is no public way to render that
// call inside another application's window. What Pitch *can* do is behave like a real
// integration: detect that Discord is running, and bring its window to the front (or
// launch it) with one click, so jumping into your call never means hunting the taskbar.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => resolve({ ok: !err, stdout: stdout || '' }));
  });
}

async function focusWindows() {
  // PowerShell: find Discord's main window and bring it to the foreground.
  const script = `
    $p = Get-Process -Name Discord -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) {
      Add-Type -Name W -Namespace Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int n);'
      [Win.W]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
      [Win.W]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
      Write-Output 'ok'
    }
  `;
  const res = await run('powershell', ['-NoProfile', '-Command', script]);
  return res.ok && res.stdout.includes('ok');
}

async function focusMac() {
  const res = await run('osascript', ['-e', 'tell application "Discord" to activate']);
  return res.ok;
}

async function focusLinux() {
  // Most distros ship at least one of these; try in order and give up quietly otherwise.
  for (const [cmd, args] of [
    ['wmctrl', ['-a', 'Discord']],
    ['xdotool', ['search', '--name', 'Discord', 'windowactivate']],
  ]) {
    const res = await run(cmd, args);
    if (res.ok) return true;
  }
  return false;
}

function isRunningWindows() {
  return run('tasklist', []).then((r) => /Discord\.exe/i.test(r.stdout));
}
function isRunningMac() {
  return run('pgrep', ['-x', 'Discord']).then((r) => r.ok);
}
function isRunningLinux() {
  return run('pgrep', ['-f', 'discord']).then((r) => r.ok);
}

function findMacApp() {
  const candidates = ['/Applications/Discord.app', path.join(require('node:os').homedir(), 'Applications/Discord.app')];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// Returns { running, focused } after trying to bring Discord to the front (or launch it
// if it wasn't running at all).
async function openDiscord(platform = process.platform) {
  if (platform === 'win32') {
    const running = await isRunningWindows();
    if (!running) {
      // Discord's own updater shim; present on every default Windows install.
      const shim = path.join(process.env.LOCALAPPDATA || '', 'Discord', 'Update.exe');
      if (fs.existsSync(shim)) execFile(shim, ['--processStart', 'Discord.exe']);
      else return { running: false, focused: false, reason: 'not-installed' };
      return { running: true, focused: true, launched: true };
    }
    return { running: true, focused: await focusWindows() };
  }

  if (platform === 'darwin') {
    const running = await isRunningMac();
    if (!running) {
      const app = findMacApp();
      if (!app) return { running: false, focused: false, reason: 'not-installed' };
      await run('open', ['-a', app]);
      return { running: true, focused: true, launched: true };
    }
    return { running: true, focused: await focusMac() };
  }

  // linux
  const running = await isRunningLinux();
  if (!running) {
    const res = await run('sh', ['-c', 'command -v discord || command -v discord-canary || command -v discord-ptb']);
    if (!res.ok || !res.stdout.trim()) return { running: false, focused: false, reason: 'not-installed' };
    execFile(res.stdout.trim(), []);
    return { running: true, focused: true, launched: true };
  }
  return { running: true, focused: await focusLinux() };
}

module.exports = { openDiscord };

'use strict';

// Picks the right file out of a GitHub release for the current OS + CPU.
//
// Release assets are matched by name, so the recommended convention is:
//   MyGame-windows.zip   MyGame-macos.zip   MyGame-linux.zip
// (optionally with -x64 / -arm64). A game can also override the matching per
// platform with a regular expression in the catalog ("assets": { "windows": "..." }).

const PLATFORM_LABEL = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

const OS_TOKENS = {
  win: 'win32',
  win32: 'win32',
  win64: 'win32',
  windows: 'win32',
  mac: 'darwin',
  macos: 'darwin',
  macosx: 'darwin',
  osx: 'darwin',
  darwin: 'darwin',
  linux: 'linux',
};

const ARCH_TOKENS = {
  x64: 'x64',
  amd64: 'x64',
  x8664: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
  armv8: 'arm64',
  ia32: 'ia32',
  x86: 'ia32',
  i386: 'ia32',
  i686: 'ia32',
  universal: 'universal',
};

// Higher is better; only used to break ties between files for the same platform.
const KIND_BONUS = {
  win32: { zip: 3, exe: 1 },
  darwin: { zip: 3, tar: 1 },
  linux: { appimage: 4, zip: 3, tar: 2 },
};

function kindOf(name) {
  const n = String(name).toLowerCase();
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar';
  if (n.endsWith('.appimage')) return 'appimage';
  if (n.endsWith('.exe')) return 'exe';
  return null;
}

function tokenize(name) {
  return String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // MyGameMac -> My Game Mac
    .toLowerCase()
    .replace(/x86[_-]64/g, 'x64')
    .replace(/64[- ]?bit/g, 'x64')
    .replace(/32[- ]?bit/g, 'ia32')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function describeAsset(name) {
  const tokens = tokenize(name);
  let os = null;
  let arch = null;
  // The platform is usually a suffix ("Win the Game-linux.zip"), so the last match wins.
  for (const t of tokens) {
    if (OS_TOKENS[t]) os = OS_TOKENS[t];
    if (ARCH_TOKENS[t]) arch = ARCH_TOKENS[t];
  }
  return { kind: kindOf(name), os, arch };
}

function pickAsset(assets, { platform = process.platform, arch = process.arch, patterns } = {}) {
  const list = (assets || []).filter((a) => a && typeof a.name === 'string');

  const custom = patterns && patterns[platform];
  if (custom) {
    let re = null;
    try {
      re = new RegExp(custom, 'i');
    } catch {
      re = null; // Invalid regex: fall back to automatic matching.
    }
    if (re) return list.find((a) => kindOf(a.name) && re.test(a.name)) || null;
  }

  let best = null;
  let bestScore = -Infinity;
  for (const asset of list) {
    const info = describeAsset(asset.name);
    if (!info.kind) continue;
    if (info.kind === 'exe' && /(setup|install)/i.test(asset.name)) continue;

    const os = info.os || (info.kind === 'appimage' ? 'linux' : info.kind === 'exe' ? 'win32' : null);
    let score = 0;
    if (os) {
      if (os !== platform) continue;
      score += 100;
    } else {
      score += 10; // No platform in the name: usable as a last resort.
    }

    if (info.arch) {
      if (info.arch === arch) score += 30;
      else if (info.arch === 'universal' && platform === 'darwin') score += 25;
      else if (arch === 'arm64' && info.arch === 'x64' && (platform === 'darwin' || platform === 'win32')) score += 5; // Emulation
      else continue;
    } else {
      score += 10;
    }

    score += (KIND_BONUS[platform] && KIND_BONUS[platform][info.kind]) || 0;
    if (score > bestScore) {
      best = asset;
      bestScore = score;
    }
  }
  return best;
}

function platformLabel(platform, arch) {
  const os = PLATFORM_LABEL[platform] || platform;
  return arch ? `${os} (${arch})` : os;
}

module.exports = { pickAsset, describeAsset, kindOf, platformLabel, PLATFORM_LABEL };

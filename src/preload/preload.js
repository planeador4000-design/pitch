'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Every call resolves to { ok: true, value } or { ok: false, error }.
const call = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('pitch', {
  getState: call('pitch:getState'),
  refresh: call('pitch:refresh'),
  install: call('pitch:install'),
  cancel: call('pitch:cancel'),
  play: call('pitch:play'),
  uninstall: call('pitch:uninstall'),
  openFolder: call('pitch:openFolder'),
  openExternal: call('pitch:openExternal'),
  saveSettings: call('pitch:saveSettings'),
  adminLoad: call('pitch:adminLoad'),
  adminSave: call('pitch:adminSave'),
  adminLookup: call('pitch:adminLookup'),
  createShortcut: call('pitch:createShortcut'),
  getLaunchAtLogin: call('pitch:getLaunchAtLogin'),
  setLaunchAtLogin: call('pitch:setLaunchAtLogin'),
  updateStatus: call('pitch:updateStatus'),
  updateCheck: call('pitch:updateCheck'),
  updateInstall: call('pitch:updateInstall'),
  discordStatus: call('pitch:discordStatus'),
  discordLink: call('pitch:discordLink'),
  discordUnlink: call('pitch:discordUnlink'),
  discordFriends: call('pitch:discordFriends'),
  discordOpen: call('pitch:discordOpen'),
  discordPanelToggle: call('pitch:discordPanelToggle'),
  discordPanelCall: call('pitch:discordPanelCall'),
  discordPanelLogout: call('pitch:discordPanelLogout'),
  discordPanelSuspend: call('pitch:discordPanelSuspend'),
  reportGamepads: call('pitch:gamepads'),
  modsGameState: call('pitch:modsGameState'),
  modsInstall: call('pitch:modsInstall'),
  modsRemove: call('pitch:modsRemove'),
  modsSetProfileMods: call('pitch:modsSetProfileMods'),
  modsCreateProfile: call('pitch:modsCreateProfile'),
  modsDeleteProfile: call('pitch:modsDeleteProfile'),
  modsSetActiveProfile: call('pitch:modsSetActiveProfile'),
  modsApprove: call('pitch:modsApprove'),
  modsOpenFolder: call('pitch:modsOpenFolder'),
  onDiscordPanel: (callback) => subscribe('pitch:discordPanel', callback),
  onState: (callback) => subscribe('pitch:state', callback),
  onNotice: (callback) => subscribe('pitch:notice', callback),
  onUpdate: (callback) => subscribe('pitch:update', callback),
  onDiscord: (callback) => subscribe('pitch:discord', callback),
});

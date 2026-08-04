'use strict';
/**
 * 安全桥接层
 * 渲染进程完全没有 Node 能力，只能调用这里白名单里的方法。
 */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = [
  'app:info',

  'settings:get', 'settings:patch', 'settings:setApiKey',
  'settings:testAi', 'settings:listModels', 'settings:reset',

  'fs:roots', 'fs:list', 'fs:profile', 'fs:reveal', 'fs:open',
  'fs:pickFolder', 'fs:clearCache', 'fs:cacheStats',

  'index:summary', 'index:scan', 'index:cancel', 'index:search', 'index:clear',

  'lib:tags', 'lib:createTag', 'lib:updateTag', 'lib:deleteTag',
  'lib:categories', 'lib:upsertCategory', 'lib:deleteCategory',
  'lib:views', 'lib:addTag', 'lib:addTagId', 'lib:removeTag', 'lib:restoreAi',
  'lib:setNote', 'lib:setSummary', 'lib:clearAnnotation',
  'lib:searchByTags', 'lib:searchText', 'lib:stats',
  'lib:export', 'lib:import', 'lib:listAnnotated',

  'ai:preview', 'ai:analyzeOne', 'ai:batch', 'ai:cancel', 'ai:status',
  'ai:audit', 'ai:clearAudit',

  'relink:verify', 'relink:apply',
];

const EVENTS = ['index:progress', 'tag:progress', 'app:toast'];

const api = {};
for (const ch of INVOKE) {
  const key = ch.replace(/[:-](\w)/g, (_, c) => c.toUpperCase());
  api[key] = (...args) => ipcRenderer.invoke(ch, ...args);
}

api.on = (channel, listener) => {
  if (!EVENTS.includes(channel)) throw new Error('未授权的事件通道: ' + channel);
  const wrapped = (_e, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

api.platform = process.platform;

contextBridge.exposeInMainWorld('api', api);

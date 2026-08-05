/* 设置页 */
(function () {
  'use strict';

  const Settings = {};
  const PRESETS = [
    { name: 'OpenAI 官方', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { name: 'DeepSeek 深度求索', url: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { name: '通义千问（阿里云）', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
    { name: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { name: '月之暗面 Kimi', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { name: '本地 Ollama', url: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  ];

  Settings.render = function () {
    const wrap = U.$('#settingsWrap');
    const s = S.settings;
    wrap.replaceChildren();

    wrap.appendChild(U.el('h2', { text: '设置' }));
    wrap.appendChild(U.el('div', { class: 'sub', text: '所有配置和标签数据都只保存在这台电脑上。' }));

    wrap.appendChild(aiGroup(s));
    wrap.appendChild(privacyGroup(s));
    wrap.appendChild(scanGroup(s));
    wrap.appendChild(uiGroup(s));
    wrap.appendChild(aboutGroup());
  };

  /* ---------- 通用行 ---------- */
  function frow(label, hint, ctrl) {
    return U.el('div', { class: 'frow' }, [
      U.el('label', {}, [U.el('span', { text: label }), hint ? U.el('small', { text: hint }) : null].filter(Boolean)),
      U.el('div', { class: 'fctrl' }, [].concat(ctrl)),
    ]);
  }
  function group(title, icon, children) {
    return U.el('div', { class: 'sgroup' }, [
      U.el('h3', {}, [U.icon(icon), U.el('span', { text: title })]),
      U.el('div', { class: 'sbody' }, children.filter(Boolean)),
    ]);
  }
  function toggle(checked, onChange) {
    const input = U.el('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    return U.el('label', { class: 'switch' }, [input, U.el('span')]);
  }
  async function patch(partial) {
    const v = await U.safeCall('settingsPatch', partial);
    if (v) S.settings = v;
    return v;
  }

  /* ---------- AI 配置 ---------- */
  function aiGroup(s) {
    const ai = s.ai;

    const urlI = U.el('input', { class: 'input', value: ai.baseUrl, placeholder: 'https://api.openai.com/v1' });
    urlI.addEventListener('change', () => patch({ ai: { baseUrl: urlI.value.trim() } }));

    const preset = U.el('select', { class: 'input sm' }, [
      U.el('option', { value: '', text: '选择服务商…' }),
      ...PRESETS.map((p) => U.el('option', { value: p.url, text: p.name })),
    ]);
    preset.addEventListener('change', async () => {
      const p = PRESETS.find((x) => x.url === preset.value);
      if (!p) return;
      urlI.value = p.url;
      modelI.value = p.model;
      await patch({ ai: { baseUrl: p.url, model: p.model } });
      U.toast(`已切换到 ${p.name}，别忘了填写对应的 API Key`, 'ok', 4000);
    });

    const keyI = U.el('input', { class: 'input', type: 'password', placeholder: ai.hasApiKey ? ai.apiKeyMask : '粘贴你的 API Key' });
    const keyBtn = U.el('button', { class: 'btn sm primary', text: '保存密钥', onclick: async () => {
      const v = await U.safeCall('settingsSetApiKey', keyI.value.trim());
      if (v) { S.settings = v; keyI.value = ''; keyI.placeholder = v.ai.apiKeyMask || '粘贴你的 API Key'; U.toast('密钥已加密保存', 'ok'); }
    } });
    const keyClr = U.el('button', { class: 'btn sm', text: '清除', onclick: async () => {
      const v = await U.safeCall('settingsSetApiKey', '');
      if (v) { S.settings = v; keyI.value = ''; keyI.placeholder = '粘贴你的 API Key'; U.toast('已清除', 'ok'); }
    } });

    const modelI = U.el('input', { class: 'input', value: ai.model, placeholder: 'gpt-4o-mini' });
    modelI.addEventListener('change', () => patch({ ai: { model: modelI.value.trim() } }));
    const modelBtn = U.el('button', { class: 'btn sm', text: '拉取可用模型', onclick: async () => {
      const list = await U.safeCall('settingsListModels');
      if (!list || !list.length) return;
      const sel = U.el('select', { class: 'input', size: 12, style: { width: '100%' } },
        list.map((m) => U.el('option', { value: m, text: m, selected: m === modelI.value })));
      U.modal({ title: `可用模型（${list.length}）`, body: sel, buttons: [
        { text: '取消', onClick: (c) => c() },
        { text: '使用选中模型', kind: 'primary', onClick: async (c) => {
          modelI.value = sel.value; await patch({ ai: { model: sel.value } }); c(); U.toast('已切换模型：' + sel.value, 'ok');
        } },
      ] });
    } });

    const testBtn = U.el('button', { class: 'btn sm', text: '测试连接', onclick: async () => {
      testBtn.disabled = true; testBtn.textContent = '连接中…';
      try {
        const r = await U.call('settingsTestAi');
        U.toast(`连接成功！模型 ${r.model} 回复：${r.reply}`, 'ok', 5000);
      } catch (e) {
        U.toast('连接失败：' + e.message, 'err', 8000);
      } finally { testBtn.disabled = false; testBtn.textContent = '测试连接'; }
    } });

    const encNotice = ai.encryptionAvailable
      ? U.el('div', { class: 'notice ok' }, [U.icon('shield'), U.el('div', {
          html: 'API Key 会用操作系统的加密能力（Windows DPAPI / macOS 钥匙串）加密后保存，配置文件里看不到明文。' })])
      : U.el('div', { class: 'notice warn' }, [U.icon('warn'), U.el('div', {
          html: '当前系统不支持安全存储，API Key 将以明文保存在本地配置文件中，请注意电脑本身的安全。' })]);

    return group('AI 服务配置', 'sparkle', [
      U.el('div', { class: 'notice info' }, [U.icon('sparkle'), U.el('div', {
        html: '不填 API Key 也能用：程序会用<b>内置的离线规则</b>根据文件类型推断用途，只是没有 AI 那么准。任何兼容 OpenAI 接口的服务都能接（包括本地 Ollama）。' })]),
      encNotice,
      frow('启用 AI', '关闭后一律使用离线规则', toggle(ai.enabled, (v) => patch({ ai: { enabled: v } }))),
      frow('服务商预设', '选一个自动填好接口地址', preset),
      frow('接口地址', '需要以 /v1 之类的版本路径结尾', urlI),
      frow('API Key', ai.hasApiKey ? '当前已保存：' + ai.apiKeyMask : '尚未设置', [keyI, keyBtn, ai.hasApiKey ? keyClr : null].filter(Boolean)),
      frow('模型', '推荐用便宜的小模型，够用且省钱', [modelI, modelBtn]),
      frow('连接测试', '发一条极短的消息验证配置是否正确', testBtn),
      frow('生成标签数量', '每个项目生成几个标签', numInput(ai.tagCount, 3, 8, (v) => patch({ ai: { tagCount: v } }))),
      frow('并发数', '批量打标签时同时请求几个（太大容易被限流）', numInput(ai.concurrency, 1, 8, (v) => patch({ ai: { concurrency: v } }))),
      frow('超时时间（秒）', '', numInput(Math.round(ai.timeoutMs / 1000), 5, 300, (v) => patch({ ai: { timeoutMs: v * 1000 } }))),
      frow('递归分析深度', '递归 AI 打标签时最多往下走几层（防失控）', numInput(ai.recursiveMaxDepth ?? 3, 1, 10, (v) => patch({ ai: { recursiveMaxDepth: v } }))),
      frow('递归时分析文件', '关闭后递归只分析文件夹，速度更快', toggle(ai.analyzeFiles !== false, (v) => patch({ ai: { analyzeFiles: v } }))),
    ]);
  }

  function numInput(val, min, max, onChange) {
    const i = U.el('input', { class: 'input sm', type: 'number', value: val, min, max, style: { width: '90px' } });
    i.addEventListener('change', () => {
      let v = Math.max(min, Math.min(max, Number(i.value) || min));
      i.value = v;
      onChange(v);
    });
    return i;
  }

  /* ---------- 隐私 ---------- */
  function privacyGroup(s) {
    const ai = s.ai;
    return group('隐私与数据', 'shield', [
      U.el('div', { class: 'notice ok' }, [U.icon('shield'), U.el('div', { html:
        '<b>本工具从不读取文件内容。</b>AI 分析只依据：文件夹名称、子文件夹名称、扩展名统计、文件数量与大小、（可选的）文件名。<br>' +
        '每次分析前你都可以点详情面板里的「将发送什么？」，逐字查看即将发出的内容。' })]),
      frow('发送文件名', '关闭后 AI 只能看到扩展名统计，判断会变模糊，但更私密', toggle(ai.sendFileNames, (v) => patch({ ai: { sendFileNames: v } }))),
      frow('发送完整路径', '默认关闭。开启后 AI 能看到盘符和上级目录（可能包含你的用户名）', toggle(ai.sendFullPath, (v) => patch({ ai: { sendFullPath: v } }))),
      frow('读取文件内容', '本程序不提供该能力，任何情况下都不会打开文件读取正文', [
        U.el('span', { class: 'conf', text: '永久关闭', style: { color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 15%, transparent)' } }),
      ]),
      frow('采样文件名上限', '每个文件夹最多发送多少个文件名', numInput(ai.maxSampleFiles, 0, 200, (v) => patch({ ai: { maxSampleFiles: v } }))),
      frow('记录调用日志', '把每次 AI 请求的时间、模型、数据量记在本地，方便事后审计', [
        toggle(s.privacy.auditLog, (v) => patch({ privacy: { auditLog: v } })),
        U.el('button', { class: 'btn sm', text: '查看日志', onclick: showAudit }),
      ]),
      frow('标签数据', '导出成 JSON 备份，或从备份恢复', [
        U.el('button', { class: 'btn sm', text: '导出备份', onclick: async () => {
          const r = await U.safeCall('libExport');
          if (r && !r.canceled) U.toast('已导出到 ' + r.path, 'ok', 5000);
        } }),
        U.el('button', { class: 'btn sm', text: '导入合并', onclick: async () => {
          const r = await U.safeCall('libImport', 'merge');
          if (r && !r.canceled) { await S.refreshTags(); Tags.renderCloud(); U.toast(`已导入，现有 ${r.stats.annotated} 条标注`, 'ok'); }
        } }),
      ]),
      frow('数据存放位置', '标签、备注、索引都在这里', [
        U.el('code', { style: { fontSize: '11px', wordBreak: 'break-all', color: 'var(--text-dim)' }, text: S.appInfo?.dataDir || '' }),
        U.el('button', { class: 'btn sm', text: '打开目录', onclick: () => U.safeCall('fsOpen', S.appInfo.dataDir) }),
      ]),
    ]);
  }

  async function showAudit() {
    const list = await U.safeCall('aiAudit', 200);
    const body = U.el('div');
    if (!list || !list.length) {
      body.appendChild(U.el('div', { class: 'empty', html: '<b>还没有调用记录</b>' }));
    } else {
      const tbl = U.el('table', { class: 'tbl' }, [
        U.el('thead', {}, [U.el('tr', {}, ['时间', '文件夹', '方式', '模型', '发送字符', '耗时'].map((t) => U.el('th', { text: t })))]),
        U.el('tbody', {}, list.map((r) => U.el('tr', {}, [
          U.el('td', { text: new Date(r.at).toLocaleString('zh-CN') }),
          U.el('td', { text: r.folder || '' }),
          U.el('td', { text: r.mode === 'local' ? '离线规则' : (r.mode === 'remote' ? '云端 AI' : '失败') }),
          U.el('td', { text: r.model || '' }),
          U.el('td', { text: r.payloadChars != null ? String(r.payloadChars) : '0' }),
          U.el('td', { text: r.ms ? r.ms + 'ms' : '' }),
        ]))),
      ]);
      body.appendChild(tbl);
    }
    U.modal({ title: 'AI 调用日志', icon: 'shield', wide: true, body, buttons: [
      { text: '清空日志', kind: 'danger', onClick: async (c) => { await U.safeCall('aiClearAudit'); c(); U.toast('已清空', 'ok'); } },
      { text: '关闭', kind: 'primary', onClick: (c) => c() },
    ] });
  }

  /* ---------- 扫描 ---------- */
  function scanGroup(s) {
    const sc = s.scan;

    const rootsBox = U.el('div', { class: 'chiplist' });
    const renderRoots = () => {
      rootsBox.replaceChildren();
      (S.settings.scan.roots || []).forEach((r) => {
        rootsBox.appendChild(U.el('span', { class: 'c' }, [
          U.el('b', { text: r }),
          U.el('span', { class: 'x', text: '×', onclick: async () => {
            const next = S.settings.scan.roots.filter((x) => x !== r);
            await patch({ scan: { roots: next } });
            renderRoots(); App.loadPlaces();
          } }),
        ]));
      });
      rootsBox.appendChild(U.el('button', { class: 'btn sm ghost', text: '+ 添加文件夹', onclick: async () => {
        const picked = await U.safeCall('fsPickFolder', { multi: true });
        if (!picked || !picked.length) return;
        const next = [...new Set([...(S.settings.scan.roots || []), ...picked])];
        await patch({ scan: { roots: next } });
        renderRoots(); App.loadPlaces();
      } }));
    };
    renderRoots();

    const exBox = U.el('div', { class: 'chiplist' });
    const renderEx = () => {
      exBox.replaceChildren();
      (S.settings.scan.excludeNames || []).forEach((n) => {
        exBox.appendChild(U.el('span', { class: 'c' }, [
          U.el('b', { text: n }),
          U.el('span', { class: 'x', text: '×', onclick: async () => {
            await patch({ scan: { excludeNames: S.settings.scan.excludeNames.filter((x) => x !== n) } });
            renderEx();
          } }),
        ]));
      });
      exBox.appendChild(U.el('button', { class: 'btn sm ghost', text: '+ 添加', onclick: async () => {
        const n = await U.prompt('排除目录', '输入要跳过的文件夹名称，例如 node_modules');
        if (!n) return;
        await patch({ scan: { excludeNames: [...new Set([...S.settings.scan.excludeNames, n])] } });
        renderEx();
      } }));
    };
    renderEx();

    const idx = S.indexSummary || {};
    const idxInfo = U.el('div', { class: 'kv', html:
      `已索引 <b>${(idx.total || 0).toLocaleString()}</b> 个条目（文件夹 <b>${(idx.dirs || 0).toLocaleString()}</b>）` +
      (idx.updatedAt ? `　最近扫描：<b>${U.dateFull(idx.updatedAt)}</b>` : '　尚未扫描') +
      (idx.stats && idx.stats.reusedDirs != null
        ? `<br>上次扫描：读取 <b>${idx.stats.readDirs}</b> 个目录，增量复用 <b style="color:var(--ok)">${idx.stats.reusedDirs}</b> 个，耗时 <b>${((idx.stats.elapsed || 0) / 1000).toFixed(1)}s</b>`
        : '') });

    return group('扫描范围与索引', 'refresh', [
      U.el('div', { class: 'notice info' }, [U.icon('refresh'), U.el('div', { html:
        '浏览文件夹是<b>随点随读</b>的，不需要提前扫描。建立索引是为了「全局搜索」和「文件夹移动后自动找回标签」。<br>' +
        '扫描是<b>增量</b>的：没变过的目录会直接复用上次结果，第二次扫描通常快很多。' })]),
      frow('扫描范围', '不设置就等于不建索引；建议只加你常用的几个盘或目录', rootsBox),
      frow('排除目录', '这些名字的文件夹会被跳过，能大幅提速', exBox),
      frow('最大深度', '从每个扫描根往下最多走多少层', numInput(sc.maxDepth, 1, 20, (v) => patch({ scan: { maxDepth: v } }))),
      frow('单目录条目上限', '超大目录只取前 N 项，防止卡死', numInput(sc.maxEntriesPerDir, 500, 50000, (v) => patch({ scan: { maxEntriesPerDir: v } }))),
      frow('索引条目上限', '达到上限就停止，保护内存', numInput(sc.maxIndexEntries, 10000, 2000000, (v) => patch({ scan: { maxIndexEntries: v } }))),
      frow('索引状态', '', [idxInfo]),
      frow('操作', '', [
        U.el('button', { class: 'btn sm primary', text: '立即扫描', onclick: () => App.startScan() }),
        U.el('button', { class: 'btn sm', text: '停止', onclick: () => U.safeCall('indexCancel') }),
        U.el('button', { class: 'btn sm danger', text: '清空索引', onclick: async () => {
          if (!(await U.confirm('清空索引', '只会删除搜索索引，<b>不会</b>影响你的标签和备注。'))) return;
          const sum = await U.safeCall('indexClear');
          if (sum) { S.indexSummary = sum; App.updateIndexPill(); Settings.render(); }
        } }),
      ]),
    ]);
  }

  /* ---------- 界面 ---------- */
  function uiGroup(s) {
    const langSel = U.el('select', { class: 'input sm' }, [
      U.el('option', { value: 'zh-CN', text: '简体中文', selected: s.ui.language === 'zh-CN' }),
      U.el('option', { value: 'en', text: 'English', selected: s.ui.language === 'en' }),
    ]);
    langSel.addEventListener('change', async () => {
      await patch({ ui: { language: langSel.value } });
      I18N.set(langSel.value);
      U.toast(langSel.value === 'en' ? 'Language switched' : '已切换为简体中文', 'ok', 2000);
    });

    const themeSel = U.el('select', { class: 'input sm' }, [
      U.el('option', { value: 'dark', text: '深色', selected: s.ui.theme === 'dark' }),
      U.el('option', { value: 'light', text: '浅色', selected: s.ui.theme === 'light' }),
    ]);
    themeSel.addEventListener('change', async () => {
      document.body.dataset.theme = themeSel.value;
      await patch({ ui: { theme: themeSel.value } });
    });

    return group('界面', 'gear', [
      frow('语言 / Language', '', langSel),
      frow('主题', '', themeSel),
      frow('默认显示隐藏项', '以点号开头的文件夹', toggle(s.ui.showHiddenFiles, async (v) => {
        await patch({ ui: { showHiddenFiles: v } });
        U.$('#showHidden').checked = v; S.showHidden = v;
        Explorer.resetCache(); Explorer.render();
      })),
      frow('恢复默认设置', '不会删除你的标签和备注', U.el('button', { class: 'btn sm danger', text: '恢复默认', onclick: async () => {
        if (!(await U.confirm('恢复默认设置', '将重置 AI 配置、扫描范围和界面偏好。<b>标签与备注不受影响。</b>', true))) return;
        const v = await U.safeCall('settingsReset');
        if (v) { S.settings = v; App.applySettings(); Settings.render(); U.toast('已恢复默认', 'ok'); }
      } })),
    ]);
  }

  /* ---------- 关于 ---------- */
  function aboutGroup() {
    const i = S.appInfo || {};
    return group('关于', 'folder', [
      U.el('div', { class: 'kv', html:
        `<b>文件夹管家 FolderSense</b> v${i.version || '—'}<br>` +
        `运行环境：Electron ${i.electron || '—'} / Node ${i.node || '—'} / ${i.platform || '—'}<br>` +
        `一个帮助不熟悉英文的用户看懂自己电脑里文件夹的小工具。所有数据留在本地。` }),
    ]);
  }

  window.SettingsView = Settings;
})();

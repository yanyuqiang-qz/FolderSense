/* AI 文件管家：用大白话问“我的文件在哪”，根据已记录的说明/标签帮你找 */
(function () {
  'use strict';

  const Butler = {};
  let log, suggest, input, sendBtn;
  let messages = [];      // {role:'user'|'assistant', content:string}
  let busy = false;
  let greeted = false;

  const SUGGESTIONS = [
    '我的合同/协议文件放在哪？',
    '上次旅游的照片在哪个文件夹？',
    '和工作有关的文档都在哪里？',
    '我下载的安装包/软件在哪？',
    '哪些文件夹里存的是视频？',
  ];

  Butler.init = function () {
    log = U.$('#butlerLog');
    suggest = U.$('#butlerSuggest');
    input = U.$('#butlerInput');
    sendBtn = U.$('#btnButlerSend');
    if (!log) return;

    autoGrow();
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
    });
    sendBtn.addEventListener('click', send);

    if (!greeted) {
      greeted = true;
      renderSuggest();
      greet();
    }
  };

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }

  async function greet() {
    const st = await U.safeCall('libStats');
    const n = (st && st.annotated) || 0;
    if (n === 0) {
      addAssistant('你好，我是你的文件管家 👋\n\n现在我还不知道你电脑里的任何文件——因为你还没给它们做过说明。\n\n先做这一步：去左边「浏览文件夹」，选中你常找不到的那个文件夹，点「AI 生成标签」（或「递归分析子项」），让我记住里面每个文件是干嘛的。之后你就能直接问我“某某文件放在哪”了。', []);
    } else {
      addAssistant(`你好，我是你的文件管家 👋 我已经记录了 <b>${n}</b> 个文件/文件夹的说明。\n\n你可以直接问我，比如：\n• 我的合同放在哪？\n• 上次旅游的照片在哪个文件夹？\n• 和工作有关的文档都在哪里？\n\n下面也有几个示例问题可以点。`, []);
    }
  }

  function renderSuggest() {
    if (!suggest) return;
    if (messages.length) { suggest.hidden = true; return; }
    suggest.hidden = false;
    suggest.replaceChildren();
    for (const s of SUGGESTIONS) {
      suggest.appendChild(U.el('button', {
        class: 'chip',
        text: s,
        onclick: () => { input.value = s; input.focus(); autoGrow(); },
      }));
    }
  }

  function addUser(text) {
    addBubble('user', text, null);
  }

  function addAssistant(text, matches) {
    addBubble('assistant', text, matches);
  }

  function addBubble(role, text, matches) {
    const bubble = U.el('div', { class: 'msg ' + role });
    const inner = U.el('div', { class: 'bubble' });
    inner.appendChild(U.el('div', { class: 'bubble-text', html: formatText(text) }));
    if (matches && matches.length) {
      const cards = U.el('div', { class: 'match-list' });
      for (const m of matches) cards.appendChild(matchCard(m));
      inner.appendChild(cards);
    }
    bubble.appendChild(inner);
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  // 把 \n 变成换行，把 [路径] 之类的简单高亮留给纯文本
  function formatText(text) {
    return U.esc(text || '').replace(/\n/g, '<br>');
  }

  function matchCard(m) {
    const tagsWrap = (m.tags && m.tags.length)
      ? U.el('div', { class: 'm-tags' }, m.tags.slice(0, 6).map((t) => U.el('span', { class: 'm-tag', text: t })))
      : null;
    return U.el('div', { class: 'match-card' }, [
      U.el('div', { class: 'm-icon' }, [U.icon('folder')]),
      U.el('div', { class: 'm-main' }, [
        U.el('div', { class: 'm-name', text: m.name }),
        U.el('div', { class: 'm-path', text: m.path }),
        m.summary ? U.el('div', { class: 'm-sum', text: m.summary }) : null,
        tagsWrap,
      ].filter(Boolean)),
      U.el('div', { class: 'm-actions' }, [
        U.el('button', { class: 'mini', title: '打开', onclick: () => U.safeCall('fsOpen', m.path) }, [U.icon('external')]),
        U.el('button', { class: 'mini', title: '在文件管理器中定位', onclick: () => U.safeCall('fsReveal', m.path) }, [U.icon('folder-open')]),
        U.el('button', { class: 'mini', title: '在浏览中查看', onclick: () => openInExplorer(m.path) }, [U.icon('search')]),
      ]),
    ]);
  }

  function openInExplorer(path) {
    (async () => {
      App.switchView('browse');
      try {
        await U.call('fsList', path);   // 是文件夹
        Explorer.openDir(path);
      } catch {
        const parent = U.dirname(path);
        await Explorer.openDir(parent).catch(() => {});
        U.safeCall('fsReveal', path);
      }
    })();
  }

  async function send() {
    if (busy) return;
    const text = input.value.trim();
    if (!text) return;
    addUser(text);
    messages.push({ role: 'user', content: text });
    input.value = '';
    autoGrow();
    renderSuggest();
    busy = true;
    const t = U.toast('文件管家思考中…', '', 60000);
    try {
      const r = await U.call('aiChat', messages.slice());
      messages.push({ role: 'assistant', content: r.answer });
      addAssistant(r.answer, r.matches || []);
    } catch (e) {
      U.toast('出错了：' + e.message, 'err');
    } finally {
      t.remove();
      busy = false;
    }
  }

  /** 从详情面板一键提问：带入当前选中的文件/文件夹 */
  Butler.askAbout = function (path) {
    App.switchView('butler');
    const v = S.ann.get(path);
    const name = (v && v.name) || U.basename(path);
    input.value = `请说说「${name}」这个文件/文件夹主要是干嘛的，里面大概有什么？`;
    input.focus();
    autoGrow();
  };

  window.Butler = Butler;
})();

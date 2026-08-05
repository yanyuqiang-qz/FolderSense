/* 首次引导向导：3 步让新用户快速上手 */
(function () {
  'use strict';

  const STEPS = [
    {
      title: '欢迎使用文件夹管家',
      subtitle: '只需 3 步，让你看懂电脑里的每一个文件夹',
      icon: 'folder',
      actionLabel: '选择一个文件夹',
      body: '先选一个你想了解的文件夹，比如「桌面」「文档」或者你工作的目录。程序会列出里面的所有文件和子文件夹。',
    },
    {
      title: '让 AI 看看里面有什么',
      subtitle: '自动生成用途说明和标签',
      icon: 'sparkle',
      actionLabel: '生成 AI 说明（可跳过）',
      body: '点击后，AI 会根据文件夹的结构（名称、文件类型、数量）自动判断这个文件夹是做什么的，并打上中文标签。不会读取任何文件内容。',
    },
    {
      title: '以后想找文件，就来问 AI 管家',
      subtitle: '用大白话问"我的合同放在哪"',
      icon: 'chat',
      actionLabel: '去 AI 文件管家试试',
      body: '给文件夹打过标签后，你可以直接用口语化的方式问 AI："我的旅游照片在哪？""上次的工作文档放哪了？"AI 会根据之前的说明帮你找到。',
    },
  ];

  let currentStep = 0;
  let overlay = null;
  let onFinished = null;

  function build() {
    overlay = U.el('div', { id: 'onboarding-overlay', class: 'ob-overlay' });
    renderStep();
    return overlay;
  }

  function renderStep() {
    const s = STEPS[currentStep];
    const isLast = currentStep === STEPS.length - 1;
    const progress = U.el('div', { class: 'ob-progress' });
    for (let i = 0; i < STEPS.length; i++) {
      progress.appendChild(U.el('div', { class: 'ob-dot' + (i === currentStep ? ' active' : '') + (i < currentStep ? ' done' : '') }));
    }

    overlay.replaceChildren(
      U.el('div', { class: 'ob-backdrop', onclick: skip }),
      U.el('div', { class: 'ob-card' }, [
        progress,
        U.el('div', { class: 'ob-icon' }, [U.icon(s.icon)]),
        U.el('h2', { class: 'ob-title', text: s.title }),
        U.el('p', { class: 'ob-sub', text: s.subtitle }),
        U.el('div', { class: 'ob-body', text: s.body }),
        U.el('div', { class: 'ob-actions' }, [
          U.el('button', { class: 'btn ghost sm', text: '跳过', onclick: skip }),
          currentStep > 0
            ? U.el('button', { class: 'btn sm', text: '上一步', onclick: prev })
            : null,
          isLast
            ? U.el('button', { class: 'btn primary', text: s.actionLabel, onclick: finish })
            : U.el('button', { class: 'btn primary', text: s.actionLabel, onclick: next }),
        ].filter(Boolean)),
      ]),
    );

    // 高亮对应 UI 区域
    highlightTarget(currentStep);
  }

  function highlightTarget(step) {
    // 移除旧高亮
    document.querySelectorAll('.ob-hl').forEach((el) => el.classList.remove('ob-hl'));
    let target = null;
    if (step === 0) target = U.$('#placesList'); // 侧栏位置列表
    if (step === 1) target = U.$('#detailPanel'); // 详情面板
    if (step === 2) target = U.$('.nav-item[data-view="butler"]'); // AI 管家按钮
    if (target) {
      target.classList.add('ob-hl');
      target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  async function next() {
    const s = STEPS[currentStep];
    // Step 0: 打开文件夹选择器
    if (currentStep === 0) {
      const picked = await U.safeCall('fsPickFolder');
      if (!picked) return; // 用户没选，停留在当前步
      Explorer.openDir(picked);
    }
    // Step 1: 触发 AI 分析
    if (currentStep === 1) {
      if (S.cwd) {
        Detail.analyze(S.cwd, true);
      }
    }

    if (currentStep < STEPS.length - 1) {
      currentStep++;
      renderStep();
    }
  }

  function prev() {
    if (currentStep > 0) {
      currentStep--;
      renderStep();
    }
  }

  async function finish() {
    document.querySelectorAll('.ob-hl').forEach((el) => el.classList.remove('ob-hl'));
    if (overlay) { overlay.remove(); overlay = null; }
    await U.safeCall('settingsPatch', { ui: { firstRunDone: true } });
    // 跳转到 AI 管家
    App.switchView('butler');
    Butler.focusInput();
    if (onFinished) onFinished();
  }

  async function skip() {
    document.querySelectorAll('.ob-hl').forEach((el) => el.classList.remove('ob-hl'));
    if (overlay) { overlay.remove(); overlay = null; }
    await U.safeCall('settingsPatch', { ui: { firstRunDone: true } });
    if (onFinished) onFinished();
  }

  const Onboarding = {
    /** 检查是否需要显示引导，需要则显示并返回 true */
    checkAndShow() {
      if (S.settings?.ui?.firstRunDone) return false;
      const ob = build();
      document.body.appendChild(ob);
      return true;
    },
    /** 手动重新触发引导 */
    show(cb) {
      currentStep = 0;
      onFinished = cb || null;
      if (overlay) overlay.remove();
      const ob = build();
      document.body.appendChild(ob);
    },
    /** 重置引导状态（设置页调用） */
    async reset() {
      await U.safeCall('settingsPatch', { ui: { firstRunDone: false } });
    },
  };

  window.Onboarding = Onboarding;
})();

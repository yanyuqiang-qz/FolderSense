/* 通用工具函数（挂在 window.U 下，避免污染全局） */
(function () {
  'use strict';

  const U = {};

  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  U.el = function (tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    }
    return node;
  };

  U.icon = function (name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'ic ' + (cls || ''));
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  };

  U.esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  U.size = function (n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = n / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + u[i];
  };

  U.date = function (ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = Date.now();
    const diff = now - ms;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 86400000 * 7) return Math.floor(diff / 86400000) + ' 天前';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  U.dateFull = function (ms) {
    if (!ms) return '—';
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  U.debounce = function (fn, ms) {
    let t;
    return function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), ms);
    };
  };

  U.basename = function (p) {
    if (!p) return '';
    const parts = String(p).split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] || p;
  };

  U.dirname = function (p) {
    const s = String(p);
    const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
    if (i <= 0) return s;
    // Windows 盘符根
    if (/^[A-Za-z]:$/.test(s.slice(0, i))) return s.slice(0, i) + '\\';
    return s.slice(0, i) || '/';
  };

  U.splitPath = function (p) {
    const s = String(p);
    const sep = s.includes('\\') ? '\\' : '/';
    const parts = s.split(/[\\/]/).filter(Boolean);
    const out = [];
    let acc = '';
    if (sep === '/') acc = '';
    parts.forEach((seg, i) => {
      if (sep === '\\') acc = i === 0 ? seg + '\\' : acc.replace(/\\$/, '') + '\\' + seg;
      else acc = acc + '/' + seg;
      out.push({ name: seg, path: acc });
    });
    if (sep === '/' && out.length === 0) out.push({ name: '/', path: '/' });
    return out;
  };

  /* ---------- Toast ---------- */
  U.toast = function (msg, type, ms) {
    const root = document.getElementById('toast-root');
    const t = U.el('div', { class: 'toast ' + (type || ''), text: msg });
    root.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateX(16px)';
      setTimeout(() => t.remove(), 260);
    }, ms || (type === 'err' ? 6000 : 3000));
    return t;
  };

  /* ---------- 模态框 ---------- */
  U.modal = function (opts) {
    const mask = U.el('div', { class: 'mask' });
    const modal = U.el('div', { class: 'modal' + (opts.wide ? ' wide' : '') });
    const head = U.el('div', { class: 'modal-head' }, [
      opts.icon ? U.icon(opts.icon) : null,
      U.el('b', { text: opts.title || '' }),
      U.el('button', { class: 'mini', onclick: close }, [U.icon('close')]),
    ]);
    const body = U.el('div', { class: 'modal-body' });
    if (typeof opts.body === 'string') body.innerHTML = opts.body;
    else if (opts.body) body.appendChild(opts.body);

    const foot = U.el('div', { class: 'modal-foot' });
    (opts.buttons || [{ text: '关闭', onClick: close }]).forEach((b) => {
      foot.appendChild(U.el('button', {
        class: 'btn ' + (b.kind || ''),
        text: b.text,
        onclick: () => b.onClick && b.onClick(close, body),
      }));
    });

    modal.append(head, body, foot);
    mask.appendChild(modal);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask && opts.dismissable !== false) close(); });
    document.getElementById('modal-root').appendChild(mask);
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    function close() {
      document.removeEventListener('keydown', onKey);
      mask.remove();
    }
    return { close, body, modal };
  };

  U.confirm = function (title, message, danger) {
    return new Promise((resolve) => {
      U.modal({
        title,
        body: U.el('div', { style: { lineHeight: '1.8', fontSize: '13.5px' }, html: message }),
        buttons: [
          { text: '取消', onClick: (close) => { close(); resolve(false); } },
          { text: '确定', kind: danger ? 'danger' : 'primary', onClick: (close) => { close(); resolve(true); } },
        ],
      });
    });
  };

  U.prompt = function (title, label, value) {
    return new Promise((resolve) => {
      const input = U.el('input', { class: 'input', value: value || '', style: { width: '100%' } });
      const box = U.el('div', {}, [
        U.el('div', { text: label, style: { marginBottom: '8px', color: 'var(--text-dim)', fontSize: '12.5px' } }),
        input,
      ]);
      const m = U.modal({
        title,
        body: box,
        buttons: [
          { text: '取消', onClick: (c) => { c(); resolve(null); } },
          { text: '确定', kind: 'primary', onClick: (c) => { c(); resolve(input.value.trim()); } },
        ],
      });
      setTimeout(() => input.focus(), 30);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { m.close(); resolve(input.value.trim()); }
      });
    });
  };

  /* ---------- IPC 包装：自动展开 {ok,data} 并弹错误 ---------- */
  U.call = async function (method, ...args) {
    const fn = window.api[method];
    if (!fn) throw new Error('未知接口: ' + method);
    const res = await fn(...args);
    if (!res || res.ok !== true) {
      const msg = (res && res.error) || '调用失败';
      throw new Error(msg);
    }
    return res.data;
  };

  U.safeCall = async function (method, ...args) {
    try {
      return await U.call(method, ...args);
    } catch (e) {
      U.toast(e.message, 'err');
      return null;
    }
  };

  /* ---------- 复制到剪贴板（带降级方案） ---------- */
  U.copy = function (text) {
    const done = () => U.toast('已复制', 'ok', 1500);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(fallback);
    } else fallback();
    function fallback() {
      const ta = U.el('textarea', { style: { position: 'fixed', opacity: '0' } });
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch { U.toast('复制失败', 'err'); }
      ta.remove();
    }
  };

  /* ---------- 颜色 ---------- */
  U.tagStyle = function (color) {
    return {
      background: `color-mix(in srgb, ${color} 20%, transparent)`,
      color: color,
      borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
    };
  };

  U.confColor = function (c) {
    if (c == null) return 'var(--text-faint)';
    if (c >= 0.75) return 'var(--ok)';
    if (c >= 0.5) return 'var(--warn)';
    return 'var(--err)';
  };

  U.CAT_ZH = {
    image: '图片', video: '视频', audio: '音频', document: '文档', sheet: '表格',
    slide: '演示', code: '代码', archive: '压缩包', executable: '程序', font: '字体',
    design: '设计稿', model3d: '三维', data: '数据', other: '其它', folder: '文件夹',
  };

  U.CAT_COLOR = {
    image: '#4a9eff', video: '#b463c4', audio: '#3fa9a0', document: '#5aab5a',
    sheet: '#2e9e4a', slide: '#e0894f', code: '#d9b34a', archive: '#8d7b6b',
    executable: '#e05561', font: '#7a6ad9', design: '#c4638f', model3d: '#6d7f8c',
    data: '#4a90d9', other: '#6d7f8c', folder: '#e0a24f',
  };

  U.catIcon = function (cat) {
    return cat === 'folder' ? 'folder' : 'file';
  };

  window.U = U;
})();

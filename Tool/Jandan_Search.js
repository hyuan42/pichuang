// ==UserScript==
// @name         煎蛋树洞搜索工具
// @namespace    https://jandan.net/
// @version      3.0
// @description  优化发布者匹配、安全渲染、结果去重、可中断翻页、参数持久化
// @author       Assistant
// @match        https://jandan.net/treehole*
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// ==/UserScript==

(function () {
    'use strict';

    // ===== 1. 配置持久化 =====
    const KEY = { author: 'th_author', start: 'th_start', end: 'th_end', pos: 'th_pos' };
    const loadCfg = () => ({
        author: GM_getValue(KEY.author, ''),
        start: GM_getValue(KEY.start, ''),
        end: GM_getValue(KEY.end, ''),
        pos: GM_getValue(KEY.pos, null),
    });
    const saveCfg = (k, v) => GM_setValue(k, v);

    // ===== 2. 样式 =====
    GM_addStyle(`
        #treehole-search-panel { position: fixed; top: 20px; right: 20px; width: 400px; background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 2147483000; font-family: Arial, sans-serif; max-height: 85vh; display: flex; flex-direction: column; }
        #treehole-search-panel.collapsed { height: auto; width: 200px; }
        #treehole-search-panel.hidden { display: none; }
        #treehole-search-header { background: #4a76a8; color: white; padding: 12px; border-top-left-radius: 8px; border-top-right-radius: 8px; cursor: move; font-weight: bold; display: flex; justify-content: space-between; align-items: center; user-select: none; }
        .treehole-search-header-btn { background: none; border: none; color: white; font-size: 18px; cursor: pointer; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 3px; }
        .treehole-search-header-btn:hover { background: rgba(255,255,255,0.2); }
        #treehole-search-content { padding: 15px; overflow-y: auto; flex-grow: 1; }
        #treehole-search-panel.collapsed #treehole-search-content { display: none; }
        .search-input-group { margin-bottom: 15px; flex: 1; }
        .search-input-group label { display: block; margin-bottom: 5px; font-weight: bold; color: #333; }
        .search-input-group input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
        .search-button { width: 100%; padding: 10px; margin: 5px 0; border: none; border-radius: 4px; color: white; font-weight: bold; cursor: pointer; }
        .search-button:disabled { opacity: 0.5; cursor: not-allowed; }
        #treehole-search-start { background: #4CAF50; }
        #treehole-search-stop { background: #f44336; }
        #treehole-search-progress { height: 6px; background: #eee; border-radius: 3px; overflow: hidden; margin-top: 8px; }
        #treehole-search-progress-bar { height: 100%; background: #4CAF50; width: 0%; transition: width 0.3s; }
        #treehole-search-results { margin-top: 15px; border-top: 1px solid #eee; padding-top: 15px; max-height: 300px; overflow-y: auto; }
        .result-item { background: #f9f9f9; border-left: 3px solid #4a76a8; padding: 10px; margin-bottom: 10px; border-radius: 0 4px 4px 0; }
        .result-author { font-weight: bold; color: #4a76a8; font-size: 13px; }
        .result-content { color: #333; line-height: 1.5; margin: 5px 0; font-size: 14px; background: white; padding: 8px; border: 1px solid #eee; border-radius: 4px; white-space: pre-wrap; }
        .result-meta { font-size: 12px; color: #888; display: flex; justify-content: space-between; }
        .result-meta a { color: #4a76a8; text-decoration: none; }
        .result-meta a:hover { text-decoration: underline; }
        .highlight { background-color: #fff3cd; padding: 10px; border-radius: 4px; text-align: center; font-weight: bold; color: #856404; }
        .result-count { text-align: center; padding: 5px; background: #f0f7ff; border-radius: 4px; margin-bottom: 10px; font-weight: bold; }
    `);

    // ===== 3. UI 构建 =====
    const cfg = loadCfg();
    const panel = document.createElement('div');
    panel.id = 'treehole-search-panel';
    panel.className = 'collapsed';
    panel.innerHTML = `
        <div id="treehole-search-header">
            <span>发布者搜索工具 v3.0</span>
            <div>
                <button id="treehole-search-toggle" class="treehole-search-header-btn" title="展开/收起">+</button>
                <button id="treehole-search-close" class="treehole-search-header-btn" title="关闭">×</button>
            </div>
        </div>
        <div id="treehole-search-content">
            <div class="search-input-group"><label>发布者ID</label><input type="text" id="th-author" placeholder="输入完整ID或关键字"></div>
            <div style="display:flex; gap:10px;">
                <div class="search-input-group"><label>起始页</label><input type="number" id="th-start" placeholder="1474"></div>
                <div class="search-input-group"><label>结束页</label><input type="number" id="th-end" placeholder="1470"></div>
            </div>
            <button id="treehole-search-start" class="search-button">开始全自动搜索</button>
            <button id="treehole-search-stop" class="search-button" disabled>中止</button>
            <div id="treehole-search-status" style="margin-top:10px; text-align:center; font-size:12px; color:#666;">等待指令...</div>
            <div id="treehole-search-progress"><div id="treehole-search-progress-bar"></div></div>
            <div id="treehole-search-results"></div>
        </div>
    `;
    document.body.appendChild(panel);

    // 恢复位置
    if (cfg.pos && typeof cfg.pos.left === 'number') {
        panel.style.left = cfg.pos.left + 'px';
        panel.style.top = cfg.pos.top + 'px';
        panel.style.right = 'auto';
    }

    // ===== 4. DOM 缓存 =====
    const $ = id => document.getElementById(id);
    const els = {
        panel,
        toggle: $('treehole-search-toggle'),
        close: $('treehole-search-close'),
        author: $('th-author'),
        start: $('th-start'),
        end: $('th-end'),
        btnStart: $('treehole-search-start'),
        btnStop: $('treehole-search-stop'),
        status: $('treehole-search-status'),
        progressBar: $('treehole-search-progress-bar'),
        results: $('treehole-search-results'),
        header: $('treehole-search-header'),
    };

    // 恢复输入（作者ID 仍走持久化）
    els.author.value = cfg.author;
    els.author.addEventListener('change', () => saveCfg(KEY.author, els.author.value));
    els.start.addEventListener('change', () => saveCfg(KEY.start, els.start.value));
    els.end.addEventListener('change', () => saveCfg(KEY.end, els.end.value));

    // 自动从分页器读取当前页，默认填充：起始页 = 当前页，结束页 = 当前页 - 100
    // 分页器 HTML: <div class="page-nav ..."><ul><li><button class="active">1650</button></li>...</ul></div>
    const autofillPageRange = () => {
        const tryRead = () => {
            const nav = document.querySelector('.page-nav');
            if (!nav) return null;
            // 优先：active 按钮文本就是当前页
            const active = nav.querySelector('button.active, .active');
            if (active) {
                const m = active.textContent.match(/\d+/);
                if (m) return parseInt(m[0], 10);
            }
            // 兜底：第一个 li 里第一个数字
            const firstLi = nav.querySelector('li');
            if (!firstLi) return null;
            const m = firstLi.textContent.match(/\d+/);
            if (!m) return null;
            return parseInt(m[0], 10);
        };

        const apply = (page) => {
            const start = page;
            const end = Math.max(1, page - 100);
            els.start.value = start;
            els.end.value = end;
            saveCfg(KEY.start, String(start));
            saveCfg(KEY.end, String(end));
        };

        // 必须读到 > 0 的有效页号才算数（防止初渲染读到占位 0）
        const valid = (v) => typeof v === 'number' && v > 0;

        const now = tryRead();
        if (valid(now)) {
            apply(now);
            return;
        }
        // 否则用 MutationObserver 等待真实分页器渲染
        const obs = new MutationObserver(() => {
            const v = tryRead();
            if (valid(v)) {
                apply(v);
                obs.disconnect();
            }
        });
        obs.observe(document.body, { childList: true, subtree: true, characterData: true });
        // 兜底超时：15 秒后停止观察，落回持久化值
        setTimeout(() => {
            obs.disconnect();
            if (!els.start.value) els.start.value = cfg.start;
            if (!els.end.value) els.end.value = cfg.end;
        }, 15000);
    };
    autofillPageRange();

    // ===== 5. 搜索状态 =====
    const state = {
        searching: false,
        totalResults: 0,
        currentPage: 0,
        seenIds: new Set(),
        abortHandlers: [],
    };

    const setStatus = (text) => { els.status.textContent = text; };
    const setProgress = (pct) => { els.progressBar.style.width = pct + '%'; };

    // 可中断 sleep
    const sleep = (ms) => new Promise(resolve => {
        if (!state.searching) return resolve();
        const timer = setTimeout(() => {
            const idx = state.abortHandlers.indexOf(handler);
            if (idx > -1) state.abortHandlers.splice(idx, 1);
            resolve();
        }, ms);
        const handler = () => { clearTimeout(timer); resolve(); };
        state.abortHandlers.push(handler);
    });

    const triggerAbort = () => {
        state.searching = false;
        const handlers = state.abortHandlers.splice(0);
        handlers.forEach(h => h());
    };

    // ===== 6. 等待页面切换完成 =====
    // 记录当前首条评论 ID，等到它变化（或 loading 完成）才认为新页面到位
    const waitForPageChange = (prevFirstId, timeout = 8000) => new Promise(resolve => {
        const start = Date.now();
        const poll = () => {
            if (!state.searching) return resolve(false);
            if (Date.now() - start > timeout) return resolve(false);

            const loading = document.querySelector('.loading-tip');
            const firstRow = document.querySelector('.comment-row');
            const firstId = firstRow?.querySelector('.comment-num')?.textContent?.trim() || null;

            // 新页就绪：没有 loading + 有内容 + 首条 ID 变了（首次搜索时 prevFirstId 为 null，则只要有内容即可）
            const ready = !loading && firstRow && (prevFirstId === null || firstId !== prevFirstId);
            if (ready) return resolve(true);
            setTimeout(poll, 200);
        };
        poll();
    });

    // ===== 7. 翻页 =====
    const triggerPageChange = (page) => {
        // 优先点击分页按钮
        const buttons = document.querySelectorAll('.page-nav button, .page-nav a');
        for (const btn of buttons) {
            if (btn.textContent.trim() === String(page)) {
                btn.click();
                return true;
            }
        }
        // 兜底：改 hash（触发站点的路由监听）
        window.location.hash = `page=${page}`;
        return false;
    };

    // ===== 8. 安全渲染单条结果 =====
    const renderResult = ({ author, content, page, commentId }) => {
        const item = document.createElement('div');
        item.className = 'result-item';

        const a = document.createElement('div');
        a.className = 'result-author';
        a.textContent = `@ ${author}`;

        const c = document.createElement('div');
        c.className = 'result-content';
        c.textContent = content;

        const meta = document.createElement('div');
        meta.className = 'result-meta';
        const pageSpan = document.createElement('span');
        pageSpan.textContent = `页面: ${page}`;
        const idLink = document.createElement('a');
        idLink.href = `#comment-${commentId}`;
        idLink.textContent = `ID: ${commentId}`;
        idLink.target = '_blank';
        meta.appendChild(pageSpan);
        meta.appendChild(idLink);

        item.appendChild(a);
        item.appendChild(c);
        item.appendChild(meta);
        // 倒序：新结果插到顶部
        els.results.insertBefore(item, els.results.firstChild);
    };

    // ===== 9. 单页搜索 =====
    const searchCurrentPage = (targetAuthor) => {
        const rows = document.querySelectorAll('.comment-row');
        let matches = 0;
        rows.forEach(row => {
            const authorEl = row.querySelector('[class^="author-"]');
            if (!authorEl) return;
            const authorText = authorEl.textContent.trim();
            if (!authorText.includes(targetAuthor)) return;

            const idEl = row.querySelector('.comment-num');
            const commentId = idEl?.textContent?.trim() || '';
            if (commentId && state.seenIds.has(commentId)) return; // 去重
            if (commentId) state.seenIds.add(commentId);

            const contentEl = row.querySelector('.comment-content');
            if (!contentEl) return;

            renderResult({
                author: authorText,
                content: contentEl.textContent.trim(),
                page: state.currentPage,
                commentId: commentId || 'N/A',
            });
            state.totalResults++;
            matches++;
        });
        return matches;
    };

    // ===== 10. 主循环 =====
    const startTask = async () => {
        const author = els.author.value.trim();
        let start = parseInt(els.start.value, 10);
        let end = parseInt(els.end.value, 10);

        if (!author || Number.isNaN(start) || Number.isNaN(end)) {
            alert('请填写正确的搜索参数！');
            return;
        }
        // 持久化
        saveCfg(KEY.author, author);
        saveCfg(KEY.start, els.start.value);
        saveCfg(KEY.end, els.end.value);

        // 自动判断方向
        const step = start >= end ? -1 : 1;
        const total = Math.abs(end - start) + 1;

        state.searching = true;
        state.totalResults = 0;
        state.seenIds.clear();
        els.author.disabled = true;
        els.start.disabled = true;
        els.end.disabled = true;
        els.btnStart.disabled = true;
        els.btnStop.disabled = false;
        els.results.innerHTML = '';
        setProgress(0);

        let prevFirstId = null;
        let processed = 0;
        for (let p = start; step < 0 ? p >= end : p <= end; p += step) {
            if (!state.searching) break;
            state.currentPage = p;
            setStatus(`正在搜索: 第 ${p} 页 (已找到 ${state.totalResults} 条)`);

            triggerPageChange(p);
            const ok = await waitForPageChange(prevFirstId);
            if (!state.searching) break;

            if (ok) {
                searchCurrentPage(author);
                const firstRow = document.querySelector('.comment-row');
                prevFirstId = firstRow?.querySelector('.comment-num')?.textContent?.trim() || null;
            } else {
                setStatus(`第 ${p} 页加载超时，跳过`);
            }

            processed++;
            setProgress(Math.round((processed / total) * 100));
            await sleep(1000); // 翻页间隔
        }

        state.searching = false;
        state.abortHandlers.length = 0;
        setStatus('搜索结束');
        const endMsg = document.createElement('div');
        endMsg.className = 'highlight';
        endMsg.textContent = `搜索完成！共找到 ${state.totalResults} 条结果`;
        els.results.insertBefore(endMsg, els.results.firstChild);

        els.author.disabled = false;
        els.start.disabled = false;
        els.end.disabled = false;
        els.btnStart.disabled = false;
        els.btnStop.disabled = true;
    };

    // ===== 11. 事件绑定 =====
    els.toggle.addEventListener('click', () => {
        panel.classList.toggle('collapsed');
        els.toggle.textContent = panel.classList.contains('collapsed') ? '+' : '-';
    });
    els.close.addEventListener('click', () => panel.classList.add('hidden'));
    els.btnStart.addEventListener('click', startTask);
    els.btnStop.addEventListener('click', triggerAbort);

    // 油猴菜单：重新呼出
    if (typeof GM_registerMenuCommand === 'function') {
        GM_registerMenuCommand('打开树洞搜索面板', () => panel.classList.remove('hidden'));
    }

    // ===== 12. 拖动（局部监听器，不污染全局） =====
    let dragState = null;
    const onMouseMove = (e) => {
        if (!dragState) return;
        const left = e.clientX - dragState.shiftX;
        const top = e.clientY - dragState.shiftY;
        panel.style.left = left + 'px';
        panel.style.top = top + 'px';
        panel.style.right = 'auto';
    };
    const onMouseUp = () => {
        if (!dragState) return;
        const rect = panel.getBoundingClientRect();
        saveCfg(KEY.pos, { left: rect.left, top: rect.top });
        dragState = null;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    };
    els.header.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        const rect = panel.getBoundingClientRect();
        dragState = { shiftX: e.clientX - rect.left, shiftY: e.clientY - rect.top };
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        e.preventDefault();
    });
})();

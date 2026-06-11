// ==UserScript==
// @name         煎蛋树洞搜索工具 (增强优化版)
// @namespace    https://jandan.net/
// @version      2.0
// @description  优化发布者匹配逻辑，支持AJAX动态翻页检测
// @author       Assistant
// @match        https://jandan.net/treehole*
// @grant        GM_addStyle
// ==/UserScript==

(function () {
    'use strict';

    // 1. 添加自定义样式 (保留原版UI风格，优化交互)
    GM_addStyle(`
        #treehole-search-panel { position: fixed; top: 20px; right: 20px; width: 400px; background: #fff; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); z-index: 9999; font-family: Arial, sans-serif; max-height: 85vh; display: flex; flex-direction: column; }
        #treehole-search-panel.collapsed { height: auto; width: 200px; }
        #treehole-search-header { background: #4a76a8; color: white; padding: 12px; border-top-left-radius: 8px; border-top-right-radius: 8px; cursor: move; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
        .treehole-search-header-btn { background: none; border: none; color: white; font-size: 18px; cursor: pointer; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; border-radius: 3px; }
        #treehole-search-content { padding: 15px; overflow-y: auto; flex-grow: 1; }
        #treehole-search-panel.collapsed #treehole-search-content { display: none; }
        .search-input-group { margin-bottom: 15px; }
        .search-input-group label { display: block; margin-bottom: 5px; font-weight: bold; color: #333; }
        .search-input-group input { width: 100%; padding: 8px; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
        .search-button { width: 100%; padding: 10px; margin: 5px 0; border: none; border-radius: 4px; color: white; font-weight: bold; cursor: pointer; }
        #treehole-search-start { background: #4CAF50; }
        #treehole-search-stop { background: #f44336; }
        #treehole-search-results { margin-top: 15px; border-top: 1px solid #eee; padding-top: 15px; max-height: 300px; overflow-y: auto; }
        .result-item { background: #f9f9f9; border-left: 3px solid #4a76a8; padding: 10px; margin-bottom: 10px; border-radius: 0 4px 4px 0; }
        .result-author { font-weight: bold; color: #4a76a8; font-size: 13px; }
        .result-content { color: #333; line-height: 1.5; margin: 5px 0; font-size: 14px; background: white; padding: 8px; border: 1px solid #eee; border-radius: 4px; white-space: pre-wrap; }
        .result-page { font-size: 12px; color: #888; }
        .highlight { background-color: #fff3cd; padding: 10px; border-radius: 4px; text-align: center; font-weight: bold; color: #856404; }
        .result-count { text-align: center; padding: 5px; background: #f0f7ff; border-radius: 4px; margin-bottom: 10px; font-weight: bold; }
    `);

    // 2. 构建UI面板
    const searchPanel = document.createElement('div');
    searchPanel.id = 'treehole-search-panel';
    searchPanel.className = 'collapsed';
    searchPanel.innerHTML = `
        <div id="treehole-search-header">
            <span>发布者搜索工具 v2.0</span>
            <div id="treehole-search-header-buttons">
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
            <div id="treehole-search-results"></div>
        </div>
    `;
    document.body.appendChild(searchPanel);

    // 3. 核心变量
    let isSearching = false;
    let totalResults = 0;
    let currentTargetPage = 0;

    // 4. 辅助函数：等待加载完成
    const waitForContent = () => {
        return new Promise((resolve) => {
            let retry = 0;
            const check = setInterval(() => {
                const loading = document.querySelector('.loading-tip');
                const rows = document.querySelectorAll('.comment-row');
                // 如果没有loading提示且已有内容，或者重试过久
                if ((!loading && rows.length > 0) || retry > 20) {
                    clearInterval(check);
                    resolve();
                }
                retry++;
            }, 300);
        });
    };

    // 5. 辅助函数：跳转页面
    const triggerPageChange = (page) => {
        // 先改Hash
        window.location.hash = `page=${page}`;
        // 再找按钮点击
        const buttons = document.querySelectorAll('.page-nav button');
        for (let btn of buttons) {
            if (btn.textContent.trim() === String(page)) {
                btn.click();
                return true;
            }
        }
        return false;
    };

    // 6. 执行单页搜索
    const searchCurrentPage = async (targetAuthor) => {
        await waitForContent();
        const rows = document.querySelectorAll('.comment-row');
        let matches = 0;

        rows.forEach(row => {
            // 优化点：使用模糊匹配或精确匹配，且覆盖所有 author-xxx 类名
            const authorEl = row.querySelector('[class^="author-"]');
            if (authorEl && authorEl.textContent.trim().includes(targetAuthor)) {
                const contentEl = row.querySelector('.comment-content');
                if (contentEl) {
                    const resultItem = document.createElement('div');
                    resultItem.className = 'result-item';
                    resultItem.innerHTML = `
                        <div class="result-author">@ ${authorEl.textContent.trim()}</div>
                        <div class="result-content">${contentEl.innerText.trim()}</div>
                        <div class="result-page">页面: ${currentTargetPage} | ID: ${row.querySelector('.comment-num')?.innerText || 'N/A'}</div>
                    `;
                    document.getElementById('treehole-search-results').appendChild(resultItem);
                    totalResults++;
                    matches++;
                }
            }
        });
        return matches;
    };

    // 7. 搜索循环主逻辑
    const startTask = async () => {
        const author = document.getElementById('th-author').value.trim();
        const start = parseInt(document.getElementById('th-start').value);
        const end = parseInt(document.getElementById('th-end').value);

        if (!author || isNaN(start) || isNaN(end)) {
            alert('请填写正确的搜索参数！');
            return;
        }

        isSearching = true;
        totalResults = 0;
        document.getElementById('th-author').disabled = true;
        document.getElementById('treehole-search-start').disabled = true;
        document.getElementById('treehole-search-stop').disabled = false;
        document.getElementById('treehole-search-results').innerHTML = '';

        for (let p = start; p >= end; p--) {
            if (!isSearching) break;
            currentTargetPage = p;
            document.getElementById('treehole-search-status').innerText = `正在搜索: 第 ${p} 页 (已找到 ${totalResults} 条)`;

            triggerPageChange(p);
            await new Promise(r => setTimeout(r, 1000)); // 给网络请求一点反应时间
            await searchCurrentPage(author);
            await new Promise(r => setTimeout(r, 1200)); // 翻页间隔，避免被反爬
        }

        isSearching = false;
        document.getElementById('treehole-search-status').innerText = `搜索结束！`;
        const endMsg = document.createElement('div');
        endMsg.className = 'highlight';
        endMsg.innerText = `搜索完成！共找到 ${totalResults} 条结果`;
        document.getElementById('treehole-search-results').prepend(endMsg);
        document.getElementById('treehole-search-start').disabled = false;
        document.getElementById('th-author').disabled = false;
    };

    // 8. 绑定事件
    document.getElementById('treehole-search-toggle').onclick = () => {
        const p = document.getElementById('treehole-search-panel');
        p.classList.toggle('collapsed');
        document.getElementById('treehole-search-toggle').textContent = p.classList.contains('collapsed') ? '+' : '-';
    };
    document.getElementById('treehole-search-close').onclick = () => document.getElementById('treehole-search-panel').remove();
    document.getElementById('treehole-search-start').onclick = startTask;
    document.getElementById('treehole-search-stop').onclick = () => { isSearching = false; };

    // 拖动逻辑支持
    const header = document.getElementById('treehole-search-header');
    header.onmousedown = (e) => {
        if (e.target.tagName === 'BUTTON') return;
        let shiftX = e.clientX - searchPanel.getBoundingClientRect().left;
        let shiftY = e.clientY - searchPanel.getBoundingClientRect().top;
        document.onmousemove = (e) => {
            searchPanel.style.left = e.clientX - shiftX + 'px';
            searchPanel.style.top = e.clientY - shiftY + 'px';
        };
        document.onmouseup = () => { document.onmousemove = null; };
    };
})();

---
cssclasses:
  - cards
  - table-max
  - cards-cols-4
  - cards-cover
  - cards-align-bottom
  - cards-2-3
  - book-shelf
---

```dataviewjs
// 注入卡片内部样式（书名加大、行距+2px；分栏标题分割线与配色）
dv.container.createEl('style', { text: `
.book-shelf .book-title { font-size: calc(1em + 4px); font-weight: 900; line-height: 1.6; }
.book-shelf .book-title a { font-size: inherit; font-weight: inherit; }
.book-shelf .book-info { line-height: calc(1.5em + 2px); }

.book-shelf .shelf-section {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 1.5em;
    margin-bottom: 0.8em;
    padding: 0.55em 1em;
    border: none;
    border-left: 4px solid currentColor;
    border-radius: 6px;
    font-weight: 700;
    letter-spacing: 0.02em;
}
.book-shelf .shelf-section .shelf-count {
    font-weight: 500;
    font-size: 0.85em;
    color: var(--text-muted);
    margin-left: 0;
}
.book-shelf .shelf-plan {
    color: #4f7dc1;
    background: #d8e6fb;
}
.book-shelf .shelf-reading {
    color: #c98a1a;
    background: #fbecd0;
}
.book-shelf .shelf-finished {
    color: #4d9a6a;
    background: #d8f1dd;
}

.book-shelf .shelf-year {
    margin-top: 1em;
    padding-top: 0.4em;
    border-top: 1px dashed var(--background-modifier-border);
    border-bottom: none;
    color: var(--text-normal);
}

.book-shelf .score-filter {
    margin: 0.4em 0 1em;
    padding: 0.7em 0.9em 0.5em;
    background: var(--background-secondary);
    border-radius: 8px;
}
.book-shelf .score-filter-label {
    font-size: 0.9em;
    margin-bottom: 0.6em;
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.8em;
}
.book-shelf .score-filter-label .score-lo-text,
.book-shelf .score-filter-label .score-hi-text {
    display: inline-block;
    min-width: 2em;
    text-align: center;
    padding: 1px 8px;
    margin: 0 4px;
    border-radius: 4px;
    background: #4d9a6a;
    color: #fff;
    font-weight: 600;
}
.book-shelf .score-filter-label .score-left {
    display: flex;
    align-items: center;
}
.book-shelf .score-filter-label .score-status-checks {
    display: flex;
    gap: 0.6em;
    font-size: 0.95em;
}
.book-shelf .score-filter-label .score-status-checks label {
    display: flex;
    align-items: center;
    gap: 0.3em;
    cursor: pointer;
    color: var(--text-normal);
}
.book-shelf .score-filter-label .score-status-checks input[type="checkbox"] {
    cursor: pointer;
}
.book-shelf .score-reset {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    margin-left: 6px;
    border-radius: 4px;
    cursor: pointer;
    color: var(--text-muted);
    background: transparent;
    border: none;
    padding: 0;
}
.book-shelf .score-reset:hover {
    color: var(--text-normal);
    background: var(--background-modifier-hover);
}
.book-shelf .score-reset svg {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.book-shelf .score-filter-track {
    position: relative;
    height: 28px;
}
.book-shelf .score-filter-track::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    top: 50%;
    height: 4px;
    transform: translateY(-50%);
    background: var(--background-modifier-border);
    border-radius: 2px;
}
.book-shelf .score-filter-range {
    position: absolute;
    top: 50%;
    height: 4px;
    transform: translateY(-50%);
    background: #4d9a6a;
    border-radius: 2px;
    pointer-events: none;
}
.book-shelf .score-input {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: 28px;
    margin: 0;
    background: transparent;
    pointer-events: none;
    -webkit-appearance: none;
    appearance: none;
}
.book-shelf .score-input::-webkit-slider-runnable-track {
    background: transparent;
    border: none;
}
.book-shelf .score-input::-moz-range-track {
    background: transparent;
    border: none;
}
.book-shelf .score-input::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    pointer-events: auto;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #4d9a6a;
    border: 2px solid var(--background-primary);
    cursor: pointer;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
    margin-top: 0;
}
.book-shelf .score-input::-moz-range-thumb {
    pointer-events: auto;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #4d9a6a;
    border: 2px solid var(--background-primary);
    cursor: pointer;
    box-shadow: 0 1px 3px rgba(0,0,0,0.2);
}
` });

// 渲染分栏标题
const sectionHeader = (text, count, modifier) => {
    const h = dv.container.createEl('h2', { cls: `shelf-section ${modifier}` });
    h.appendText(text);
    h.createEl('span', { text: String(count), cls: 'shelf-count' });
};

// 凡是带有「书名」frontmatter 的笔记都视为图书，不再依赖路径
const pages = dv.pages().where(p => p.书名 != null);

const groups = { '阅读计划': [], '阅读中': [], '已读完': [] };

const promises = pages.values.map(async page => {
    const fm = page.file.frontmatter || {};
    const status = (fm['状态'] == null ? '' : String(fm['状态'])).trim();

    // 从正文中提取首张图片作为封面，支持 ![](url) 与 ![[file]]
    let coverUrl = '';
    try {
        const content = await dv.io.load(page.file.path);
        if (content) {
            const m1 = content.match(/!\[[^\]]*\]\(\s*([^)\s]+)\s*\)/);
            const m2 = content.match(/!\[\[([^\]]+)\]\]/);
            if (m1) {
                coverUrl = m1[1];
            } else if (m2) {
                const linkPath = m2[1].split('|')[0].split('#')[0];
                const tf = app.metadataCache.getFirstLinkpathDest(linkPath, page.file.path);
                if (tf) coverUrl = app.vault.adapter.getResourcePath(tf.path);
            }
        }
    } catch (e) {}

    const cover = coverUrl
        ? `<img src="${coverUrl}" referrerpolicy="no-referrer" style="width:100%;height:auto;display:block;object-fit:cover;">`
        : '';

    const book = {
        status,
        cover,
        link: page.file.link,
        author: fm['作者'] ?? '-',
        doubanScore: fm['豆瓣评分'] ?? '-',
        doubanStar: fm['豆瓣评星'] ?? '-',
        finishDate: fm['完读时间'] ?? '',
        readingTime: fm['阅读用时'] ?? '-',
        personalScore: fm['个人评分'] ?? '-',
        isAbandoned: ['弃读', '弃书'].includes(status)
    };

    if (['准备读', '阅读计划', '想读'].includes(status)) {
        groups['阅读计划'].push(book);
    } else if (['阅读中', '在读'].includes(status)) {
        groups['阅读中'].push(book);
    } else if (['已读完', '读过', '读完', '弃读', '弃书'].includes(status)) {
        groups['已读完'].push(book);
    }
});

await Promise.all(promises);

// 把 dataview Link 转为可渲染的 Obsidian 内链 HTML
const linkHtml = (link) => {
    const href = link.path;
    const text = link.display ?? link.fileName();
    return `<a class="internal-link" href="${href}" data-href="${href}">${text}</a>`;
};

// 【阅读计划】【阅读中】渲染：封面、书名、作者、豆瓣评分、豆瓣评星
const renderInProgress = (books) => books.map(b => {
    const info = `<div class="book-info">`
        + `<div class="book-title">${linkHtml(b.link)}</div>`
        + `作者：${b.author}<br>`
        + `豆瓣评分：${b.doubanScore}<br>`
        + `豆瓣评星：${b.doubanStar}`
        + `</div>`;
    return [b.cover, info];
});

// 【已读完】渲染：封面、书名、作者、阅读用时、完读时间、个人评分
const renderFinished = (books) => books.map(b => {
    const finishLabel = b.isAbandoned ? '弃读' : '读完';
    const info = `<div class="book-info">`
        + `<div class="book-title">${linkHtml(b.link)}</div>`
        + `作者：${b.author}<br>`
        + `用时：${b.readingTime}，${finishLabel}<br>`
        + `时间：${b.finishDate || '-'}<br>`
        + `个人评分：${b.personalScore}`
        + `</div>`;
    return [b.cover, info];
});

// 阅读计划
if (groups['阅读计划'].length > 0) {
    sectionHeader('📚 阅读计划', groups['阅读计划'].length, 'shelf-plan');
    dv.table(['封面', '信息'], renderInProgress(groups['阅读计划']));
}

// 阅读中
if (groups['阅读中'].length > 0) {
    sectionHeader('📖 阅读中', groups['阅读中'].length, 'shelf-reading');
    dv.table(['封面', '信息'], renderInProgress(groups['阅读中']));
}

// 已读完：按年分组
if (groups['已读完'].length > 0) {
    sectionHeader('✅ 读过', groups['已读完'].length, 'shelf-finished');

    // 计算评分区间（兼容 0~10 分制）
    const allScores = groups['已读完']
        .map(b => parseFloat(b.personalScore))
        .filter(n => !isNaN(n));
    const hasScore = allScores.length > 0;
    const SCORE_MIN = 0;
    const SCORE_MAX = 10;
    const STEP = 0.5;

    // 滑块容器
    const filterEl = dv.container.createEl('div', { cls: 'score-filter' });
    const labelEl = filterEl.createEl('div', { cls: 'score-filter-label' });
    const labelLeft = labelEl.createEl('span', { cls: 'score-left' });
    labelLeft.appendText('个人评分：');
    const loText = labelLeft.createEl('span', { cls: 'score-lo-text', text: String(SCORE_MIN) });
    labelLeft.appendText(' ~ ');
    const hiText = labelLeft.createEl('span', { cls: 'score-hi-text', text: String(SCORE_MAX) });

    // 重置按钮
    const resetBtn = labelLeft.createEl('button', {
        cls: 'score-reset',
        attr: { 'aria-label': '重置筛选', title: '重置筛选' }
    });
    resetBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';

    // 状态复选（读完 / 弃读），默认都不勾选
    const checksWrap = labelEl.createEl('span', { cls: 'score-status-checks' });
    const mkCheck = (text) => {
        const lbl = checksWrap.createEl('label');
        const cb = lbl.createEl('input');
        cb.type = 'checkbox';
        cb.checked = false;
        lbl.appendText(text);
        return cb;
    };
    const finishedCheck = mkCheck('读完');
    const abandonedCheck = mkCheck('弃读');

    const trackEl = filterEl.createEl('div', { cls: 'score-filter-track' });
    const rangeEl = trackEl.createEl('div', { cls: 'score-filter-range' });
    const loInput = trackEl.createEl('input', { cls: 'score-input score-input-lo' });
    const hiInput = trackEl.createEl('input', { cls: 'score-input score-input-hi' });
    [loInput, hiInput].forEach(el => {
        el.type = 'range';
        el.min = String(SCORE_MIN);
        el.max = String(SCORE_MAX);
        el.step = String(STEP);
    });
    loInput.value = String(SCORE_MIN);
    hiInput.value = String(SCORE_MAX);

    // 已读完表格容器（滑动时只重渲染这一块）
    const listEl = dv.container.createEl('div', { cls: 'shelf-finished-list' });

    const renderList = (lo, hi) => {
        listEl.empty();

        // 同时勾选或同时不勾选都视为不筛选状态
        const fin = finishedCheck.checked;
        const ab = abandonedCheck.checked;
        const noStatusFilter = (fin === ab);

        const filtered = groups['已读完'].filter(b => {
            if (!noStatusFilter) {
                if (b.isAbandoned && !ab) return false;
                if (!b.isAbandoned && !fin) return false;
            }

            const n = parseFloat(b.personalScore);
            if (isNaN(n)) return lo === SCORE_MIN;
            return n >= lo && n <= hi;
        });

        if (filtered.length === 0) {
            listEl.createEl('div', {
                text: '无符合条件的书籍',
                attr: { style: 'color: var(--text-muted); padding: 0.6em 0;' }
            });
            return;
        }

        const yearGroups = {};
        const UNKNOWN = '__unknown__';
        filtered.forEach(book => {
            const d = book.finishDate ? new Date(book.finishDate) : null;
            const valid = d && !isNaN(d.getTime());
            const yKey = valid ? d.getFullYear() : UNKNOWN;
            if (!yearGroups[yKey]) yearGroups[yKey] = [];
            yearGroups[yKey].push(book);
        });

        const yearKeys = Object.keys(yearGroups).sort((a, b) => {
            if (a === UNKNOWN) return 1;
            if (b === UNKNOWN) return -1;
            return Number(b) - Number(a);
        });

        // 借用 dv 的渲染：把内部 container 临时换成 listEl
        const originalContainer = dv.container;
        dv.container = listEl;
        try {
            yearKeys.forEach(yKey => {
                const books = yearGroups[yKey];
                const yearLabel = yKey === UNKNOWN ? '未知年份' : `${yKey}年`;
                const yh = listEl.createEl('h3', { cls: 'shelf-year' });
                yh.appendText(yearLabel);
                yh.createEl('span', { text: `(${books.length})`, cls: 'shelf-count' });
                books.sort((a, b) => new Date(b.finishDate || 0) - new Date(a.finishDate || 0));
                dv.table(['封面', '信息'], renderFinished(books));
            });
        } finally {
            dv.container = originalContainer;
        }
    };

    const updateRangeBar = (lo, hi) => {
        const span = SCORE_MAX - SCORE_MIN;
        const left = ((lo - SCORE_MIN) / span) * 100;
        const right = ((hi - SCORE_MIN) / span) * 100;
        rangeEl.style.left = left + '%';
        rangeEl.style.width = (right - left) + '%';
    };

    const onChange = () => {
        let lo = parseFloat(loInput.value);
        let hi = parseFloat(hiInput.value);
        if (lo > hi) { [lo, hi] = [hi, lo]; }
        loText.textContent = String(lo);
        hiText.textContent = String(hi);
        updateRangeBar(lo, hi);
        renderList(lo, hi);
    };

    loInput.addEventListener('input', onChange);
    hiInput.addEventListener('input', onChange);
    finishedCheck.addEventListener('change', onChange);
    abandonedCheck.addEventListener('change', onChange);

    resetBtn.addEventListener('click', () => {
        loInput.value = String(SCORE_MIN);
        hiInput.value = String(SCORE_MAX);
        finishedCheck.checked = false;
        abandonedCheck.checked = false;
        onChange();
    });

    updateRangeBar(SCORE_MIN, SCORE_MAX);
    renderList(SCORE_MIN, SCORE_MAX);
}
```

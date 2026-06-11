---
cssclasses:
  - cards
  - table-max
  - cards-cols-4
  - cards-cover
  - cards-align-bottom
  - cards-2-3
  - movie-shelf
---

```dataviewjs
// 注入卡片内部样式（电影名加大、行距+2px；分栏标题分割线与配色）
dv.container.createEl('style', { text: `
.movie-shelf .movie-title { font-size: calc(1em + 4px); font-weight: 900; line-height: 1.6; }
.movie-shelf .movie-title a { font-size: inherit; font-weight: inherit; }
.movie-shelf .movie-info { line-height: calc(1.5em + 2px); }

.movie-shelf .shelf-section {
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
.movie-shelf .shelf-section .shelf-count {
    font-weight: 500;
    font-size: 0.85em;
    color: var(--text-muted);
    margin-left: 0;
}
.movie-shelf .shelf-finished {
    color: #4d9a6a;
    background: #d8f1dd;
}

.movie-shelf .shelf-year {
    margin-top: 1em;
    padding-top: 0.4em;
    border-top: 1px dashed var(--background-modifier-border);
    border-bottom: none;
    color: var(--text-normal);
}

.movie-shelf .score-filter {
    margin: 0.4em 0 1em;
    padding: 0.7em 0.9em 0.5em;
    background: var(--background-secondary);
    border-radius: 8px;
}
.movie-shelf .score-filter-label {
    font-size: 0.9em;
    margin-bottom: 0.6em;
    color: var(--text-muted);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.8em;
}
.movie-shelf .score-filter-label .score-lo-text,
.movie-shelf .score-filter-label .score-hi-text {
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
.movie-shelf .score-filter-label .score-left {
    display: flex;
    align-items: center;
}
.movie-shelf .score-reset {
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
.movie-shelf .score-reset:hover {
    color: var(--text-normal);
    background: var(--background-modifier-hover);
}
.movie-shelf .score-reset svg {
    width: 14px;
    height: 14px;
    stroke: currentColor;
    fill: none;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
}
.movie-shelf .score-filter-track {
    position: relative;
    height: 28px;
}
.movie-shelf .score-filter-track::before {
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
.movie-shelf .score-filter-range {
    position: absolute;
    top: 50%;
    height: 4px;
    transform: translateY(-50%);
    background: #4d9a6a;
    border-radius: 2px;
    pointer-events: none;
}
.movie-shelf .score-input {
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
.movie-shelf .score-input::-webkit-slider-runnable-track {
    background: transparent;
    border: none;
}
.movie-shelf .score-input::-moz-range-track {
    background: transparent;
    border: none;
}
.movie-shelf .score-input::-webkit-slider-thumb {
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
.movie-shelf .score-input::-moz-range-thumb {
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

// 在下方引号内填入电影笔记所在的嵌套目录，例如 "影视/电影"
const pages = dv.pages('"📚读书观影/movie"').where(p => p.电影名称 != null);

const movies = [];

const promises = pages.values.map(async page => {
    const fm = page.file.frontmatter || {};

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

    movies.push({
        cover,
        link: page.file.link,
        director: fm['导演'] ?? '-',
        type: fm['类型'] ?? '-',
        releaseDate: fm['上映日期'] ?? '-',
        myRating: fm['我的评分'] ?? '-',
        markDate: fm['标记日期'] ?? ''
    });
});

await Promise.all(promises);

// 把 dataview Link 转为可渲染的 Obsidian 内链 HTML
const linkHtml = (link) => {
    const href = link.path;
    const text = link.display ?? link.fileName();
    return `<a class="internal-link" href="${href}" data-href="${href}">${text}</a>`;
};

// 【看过】渲染：封面、电影名称、导演、类型、上映时间、我的评分、标记日期
const renderMovies = (list) => list.map(m => {
    const info = `<div class="movie-info">`
        + `<div class="movie-title">${linkHtml(m.link)}</div>`
        + `导演：${m.director}<br>`
        + `类型：${m.type}<br>`
        + `上映时间：${m.releaseDate}<br>`
        + `我的评分：${m.myRating}<br>`
        + `标记日期：${m.markDate || '-'}`
        + `</div>`;
    return [m.cover, info];
});

// 看过：按年分组
if (movies.length > 0) {
    sectionHeader('🎬 看过', movies.length, 'shelf-finished');

    // 计算评分区间（兼容 0~10 分制）
    const SCORE_MIN = 0;
    const SCORE_MAX = 10;
    const STEP = 0.5;

    // 滑块容器
    const filterEl = dv.container.createEl('div', { cls: 'score-filter' });
    const labelEl = filterEl.createEl('div', { cls: 'score-filter-label' });
    const labelLeft = labelEl.createEl('span', { cls: 'score-left' });
    labelLeft.appendText('我的评分：');
    const loText = labelLeft.createEl('span', { cls: 'score-lo-text', text: String(SCORE_MIN) });
    labelLeft.appendText(' ~ ');
    const hiText = labelLeft.createEl('span', { cls: 'score-hi-text', text: String(SCORE_MAX) });

    // 重置按钮
    const resetBtn = labelLeft.createEl('button', {
        cls: 'score-reset',
        attr: { 'aria-label': '重置筛选', title: '重置筛选' }
    });
    resetBtn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>';

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

    // 看过表格容器（滑动时只重渲染这一块）
    const listEl = dv.container.createEl('div', { cls: 'shelf-finished-list' });

    const renderList = (lo, hi) => {
        listEl.empty();

        const filtered = movies.filter(m => {
            const n = parseFloat(m.myRating);
            if (isNaN(n)) return lo === SCORE_MIN;
            return n >= lo && n <= hi;
        });

        if (filtered.length === 0) {
            listEl.createEl('div', {
                text: '无符合条件的电影',
                attr: { style: 'color: var(--text-muted); padding: 0.6em 0;' }
            });
            return;
        }

        const yearGroups = {};
        const UNKNOWN = '__unknown__';
        filtered.forEach(movie => {
            const d = movie.markDate ? new Date(movie.markDate) : null;
            const valid = d && !isNaN(d.getTime());
            const yKey = valid ? d.getFullYear() : UNKNOWN;
            if (!yearGroups[yKey]) yearGroups[yKey] = [];
            yearGroups[yKey].push(movie);
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
                const list = yearGroups[yKey];
                const yearLabel = yKey === UNKNOWN ? '未知年份' : `${yKey}年`;
                const yh = listEl.createEl('h3', { cls: 'shelf-year' });
                yh.appendText(yearLabel);
                yh.createEl('span', { text: `(${list.length})`, cls: 'shelf-count' });
                list.sort((a, b) => new Date(b.markDate || 0) - new Date(a.markDate || 0));
                dv.table(['封面', '信息'], renderMovies(list));
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

    resetBtn.addEventListener('click', () => {
        loInput.value = String(SCORE_MIN);
        hiInput.value = String(SCORE_MAX);
        onChange();
    });

    updateRangeBar(SCORE_MIN, SCORE_MAX);
    renderList(SCORE_MIN, SCORE_MAX);
}
```

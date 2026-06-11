// ==UserScript==
// @name         小说页面伪装
// @namespace    https://github.com/NiaoBlush/novel-disguise
// @version      2.12.0-mini
// @description  适配起点/番茄/微信读书, 仅保留Excel伪装模式. 基于NiaoBlush的novel-disguise脚本(MIT)精简改造.
// @author       NiaoBlush (modified)
// @license      MIT
// @run-at       document-end
// @icon64       https://s21.ax1x.com/2024/08/06/pkxPf0S.png
// @match        https://www.qidian.com/chapter/*
// @match        https://fanqienovel.com/reader/*
// @match        https://weread.qq.com/web/reader/*
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @require      https://cdn.jsdelivr.net/gh/hyuan42/novel-disguise@2a17e23/novel-disguise-jquery.js
// @require      https://cdn.jsdelivr.net/gh/hyuan42/novel-disguise@2a17e23/novel-disguise-resource.js
// ==/UserScript==

(function () {
    'use strict';
    printLog("novel-disguise(mini) 开始初始化");

    typeof jQuery !== "undefined" ? printLog("jQuery 版本: " + jQuery.fn.jquery) : printLog("error", "jQuery 未载入！");
    const $ = jQuery.noConflict(true);

    typeof NovelDisguiseResource !== "undefined" ? printLog("资源已载入") : printLog("error", "资源未载入");

    const screenInfo = getScreenInfo();
    // 在 overridePageTitle() 把 document.title 改成 "工作簿1" 之前先把原始 <title> 存起来,
    // 后续用于在 excel 表格顶端构造标题行. 使用 let 以便 SPA 切换章节时由 watchTitleChanges() 更新.
    let originalDocTitle = (document.title || '').trim();
    printLog('原始 <title>:', originalDocTitle);
    let disguised_header_img = null;
    let disguised_footer_img = null;
    let disguised_icon_img = null;
    let headerHeight = null;
    let footerHeight = null;
    let readerHeight = null;

    const link_text_color = "rgba(0,0,0,.7)";
    const link_bg_color = "#f6f6f6";
    const link_front_color = "rgba(0,0,0,.7)";

    const DICT = {
        MODE: {
            EXCEL: 'mode_excel',
            ORIGINAL: 'mode_original'
        },
        THEME: {
            OFFICE: 'theme_office',
            WPS: 'theme_wps'
        },
        RESOURCE_RESOLUTION: {
            AUTO: 'auto',
            FORCE_1K: '1k',
            FORCE_2K: '2k',
            FORCE_4K: '4k'
        }
    };

    const KEY_CONFIG = "KEY_CONFIG_MINI";

    // 微信读书文字缓存. 流程:
    //   phase 1 (原生页 + 白色遮罩) 用 MutationObserver 抓 .wr_absolute[class*="ccn-"]
    //     的 (x, y, char) -> writeWereadCache(sessionStorage) -> location.reload()
    //   phase 2 (伪装页) readWereadCache -> 立刻删除 -> 命中则直接渲染, 否则回到 phase 1
    // 用 sessionStorage 单次跨 reload 传递: 每次 reload 都强制重新抓取, 不依赖 URL 匹配,
    // 彻底消除 SPA 切章节命中旧缓存的问题. 关闭标签页时 sessionStorage 自动清空.
    const WEREAD_CACHE_KEY = "WEREAD_TEXTS_PAYLOAD";

    function readWereadCache() {
        try {
            const raw = sessionStorage.getItem(WEREAD_CACHE_KEY);
            // 一次性消费: 读出后立刻删除, 下次 reload 必须重新抓取
            sessionStorage.removeItem(WEREAD_CACHE_KEY);
            if (!raw) return null;
            const data = JSON.parse(raw);
            if (!data || !data.chars || data.chars.length === 0) return null;
            return data;
        } catch (e) {
            return null;
        }
    }

    function writeWereadCache(data) {
        try {
            sessionStorage.setItem(WEREAD_CACHE_KEY, JSON.stringify(data));
        } catch (e) {
            printLog('warn', '写文字缓存失败: ' + e.message);
        }
    }

    function printLog(...args) {
        let level = 'info';
        if (typeof args[0] === 'string' && ['info', 'warn', 'error'].includes(args[0])) {
            level = args.shift();
        }
        let levelStyle = '';
        switch (level) {
            case 'info':
                levelStyle = 'color:#00BFFF;font-weight:bold;';
                break;
            case 'warn':
                levelStyle = 'color:#FFA500;font-weight:bold;';
                break;
            case 'error':
                levelStyle = 'color:#FF4500;font-weight:bold;';
                break;
            default:
                levelStyle = 'color:#000;';
        }
        const prefix = `%c🎭novel-disguise%c [${level.toUpperCase()}]`;
        console.log(
            prefix,
            'background:#222;color:#FFD700;font-weight:bold;padding:2px 4px;border-radius:4px;',
            'background:none;' + levelStyle,
            ...args
        );
    }

    function readConfig() {
        const defaultConfig = {
            mode: DICT.MODE.EXCEL,
            lastVisibleMode: DICT.MODE.EXCEL,
            theme: DICT.THEME.OFFICE,
            hideImage: true,
            resourceResolution: DICT.RESOURCE_RESOLUTION.AUTO,

            emptyCols: 20,
            enableExcelRandomPopulate: true,
            maxExcelRandomPopulateCol: 9,

            // 正文列 (B列) 宽度, px. 用户可在设置面板里通过滑块调整 (起点/番茄生效, 微信读书由 canvas 缩放控制)
            bodyContentWidth: 700,

            // 微信读书 canvas 缩放比例 (1 = 原始大小, 0.7 = 缩到 70%, 数字越小字越小)
            wereadCanvasScale: 0.8
        };
        const stored = GM_getValue(KEY_CONFIG, {});
        const config = Object.assign({}, defaultConfig, stored);
        // 强制使用Excel模式 (除非用户按E切到原始)
        if (config.mode !== DICT.MODE.ORIGINAL) {
            config.mode = DICT.MODE.EXCEL;
            config.lastVisibleMode = DICT.MODE.EXCEL;
        }
        printLog("config loaded", config);
        return config;
    }

    const config = readConfig();

    function writeConfig() {
        GM_setValue(KEY_CONFIG, config);
    }

    function applyMode(mode) {
        printLog(`准备切换到模式[${mode}]...`);
        config.mode = mode;
        writeConfig();
        location.reload();
    }

    function settings() {
        const $settings = $(`
            <form class="nd-settings-form">
                <div class="nd-settings-form-group">
                    <label for="settings-mode">主题: </label>
                    <select id="settings-theme" name="settings-theme">
                        <option value="${DICT.THEME.OFFICE}">Office</option>
                        <option value="${DICT.THEME.WPS}">Wps</option>
                    </select>
                </div>
                <div class="nd-settings-form-group">
                    <label>隐藏图片: </label>
                    <label style="width: 30%;"><input type="radio" name="settings-hide-image" value="true">是</label>
                    <label style="width: 30%;"><input type="radio" name="settings-hide-image" value="false">否</label>
                </div>
                <div class="nd-settings-form-group">
                    <label>资源分辨率: </label>
                    <label><input type="radio" name="settings-res-resolution" value="${DICT.RESOURCE_RESOLUTION.AUTO}">自动</label>
                    <label style="margin-left: 4px;"><input type="radio" name="settings-res-resolution" value="${DICT.RESOURCE_RESOLUTION.FORCE_1K}">1K</label>
                    <label style="margin-left: 4px;"><input type="radio" name="settings-res-resolution" value="${DICT.RESOURCE_RESOLUTION.FORCE_2K}">2K</label>
                    <label style="margin-left: 4px;"><input type="radio" name="settings-res-resolution" value="${DICT.RESOURCE_RESOLUTION.FORCE_4K}">4K</label>
                </div>
                <div class="nd-settings-form-group">
                    <label>正文宽度: </label>
                    <input type="range" name="settings-body-width" min="300" max="1200" step="10" style="width:160px;vertical-align:middle;">
                    <span class="settings-body-width-display" style="margin-left:8px;font-size:12px;color:#666;">700px</span>
                </div>
                <div class="nd-settings-form-group" style="margin-top: 20px;">
                    <div class="nd-settings-btn-wrapper">
                        <button type="submit">保存设置</button>
                    </div>
                </div>
            </form>
        `);

        $settings.find("select[name=settings-theme]").val(config.theme);
        $settings.find(`input[name=settings-hide-image][value='${String(config.hideImage)}']`).prop('checked', true);
        $settings.find(`input[name=settings-res-resolution][value='${config.resourceResolution}']`).prop('checked', true);
        $settings.find('input[name=settings-body-width]').val(config.bodyContentWidth);
        $settings.find('.settings-body-width-display').text(config.bodyContentWidth + 'px');

        // 滑块拖动时实时预览 (改 CSS 变量, 不写存储)
        $settings.find('input[name=settings-body-width]').on('input', function () {
            const v = parseInt(this.value);
            $settings.find('.settings-body-width-display').text(v + 'px');
            document.documentElement.style.setProperty('--body-content-width', v + 'px');
        });

        const $modal = showModal($settings, {title: "设置"});

        $settings.on('submit', function (event) {
            event.preventDefault();
            const formDataObj = new FormData(this);
            config.theme = formDataObj.get('settings-theme');
            config.hideImage = formDataObj.get('settings-hide-image') === 'true';
            config.resourceResolution = formDataObj.get('settings-res-resolution');
            config.bodyContentWidth = parseInt(formDataObj.get('settings-body-width')) || 700;
            writeConfig();

            popMsg("设置已保存");
            $modal.remove();
        });
    }

    function setResource() {
        function getActualHeight(originalHeight) {
            return originalHeight / screenInfo.devicePixelRatio;
        }

        printLog('screenInfo', screenInfo);

        function getHeaderResource(currentMode, currentTheme, physicalWidth) {
            const wThreshold2k = 2560;
            const wThreshold4k = 3840;

            let size;
            if (config.resourceResolution === DICT.RESOURCE_RESOLUTION.AUTO) {
                if (physicalWidth >= wThreshold4k) {
                    size = "4k";
                } else if (physicalWidth >= wThreshold2k) {
                    size = "2k";
                } else {
                    size = "1k";
                }
            } else {
                size = config.resourceResolution;
            }

            return NovelDisguiseResource.getDisguisedImage({
                app: config.mode,
                theme: config.theme,
                size: size,
                scheme: "light",
                part: "header"
            });
        }

        const src = getHeaderResource(config.mode, config.theme, screenInfo.physicalWidth);
        disguised_header_img = src.url || src.base64;
        headerHeight = getActualHeight(screenInfo.physicalWidth * src.height / src.width);

        const disguised_footer_resource = NovelDisguiseResource.getDisguisedImage({
            app: config.mode,
            theme: DICT.THEME.OFFICE,
            size: "1k",
            scheme: "light",
            part: "footer"
        });
        disguised_footer_img = disguised_footer_resource.base64;
        footerHeight = disguised_footer_resource.height;

        disguised_icon_img = NovelDisguiseResource.getDisguisedImage({
            app: config.mode,
            theme: DICT.THEME.OFFICE,
            size: "1k",
            scheme: "light",
            part: "icon"
        }).base64;

        readerHeight = window.innerHeight - headerHeight - footerHeight;
    }

    function hideImages({selector, replaceParent = false, indicatorText = '点击显示图片'}) {
        if (!config.hideImage) return;
        $(selector).each(function () {
            const imgSrc = $(this).attr('src');
            const span = $('<span class="disguised-img-indicator"></span>')
                .attr('data-src', imgSrc)
                .text(indicatorText);
            if (replaceParent) {
                $(this).parent().replaceWith(span);
            } else {
                $(this).replaceWith(span);
            }
        });
    }

    function registerImageIndicators() {
        $(".disguised-img-indicator").on('click', function () {
            const src = $(this).attr('data-src');
            const $newImg = $('<img>').attr('src', src);
            const $modal = showModal($newImg);
            $modal.find("img").css({"max-width": "80vw", "max-height": "80vh"});
            $newImg.on('click', function () {
                $modal.remove();
            });
        });
    }

    function common() {
        setResource();

        GM_addStyle(`
        .img-fill-in {
            background-repeat: no-repeat;
            background-size: 100% 100%;
        }

        html {
            overflow-y: hidden;
            color-scheme: normal !important;
        }

        #disguised-page {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
        }

        #disguised-header {
            width: 100%;
            aspect-ratio: ${screenInfo.screenWidth / headerHeight};
            background-image: url(${disguised_header_img});
        }

        #disguised-title {
            position: fixed;
            top: 5px;
            left: 0;
            width: 100%;
            z-index: 9999;
            text-align: center;
            color: ${config.theme === DICT.THEME.OFFICE ? '#edffff' : '#232323'};
            font-size: 12px;
            line-height: 22px;
            user-select: none;
        }

        #disguised-footer {
            height: ${footerHeight}px;
            line-height: ${footerHeight}px;
            width: 100%;
            background-image: url(${disguised_footer_img});
            font-size: 13px;
            color: #262626;
            box-sizing: border-box;
            position: relative;
        }

        #footer-content {
            position: absolute;
            left: 0;
            bottom: 0;
            height: ${footerHeight}px;
            line-height: ${footerHeight}px;
            width: 100%;
            flex-direction: row;
            flex-wrap: nowrap;
            align-content: center;
            justify-content: flex-start;
            align-items: center;
            box-sizing: border-box;
            padding-left: 20px;
        }

        #footer-content > * {
            height: 100%;
            line-height: 100%;
            margin-right: 10px;
            font-size: 13px;
        }

        #disguised-body {
            flex: 1;
            padding-left: 0;
            padding-right: 0;
            background-repeat: repeat-y;
            background-size: 100% auto;
            overflow-y: hidden;
            width: 100%;
            box-sizing: border-box;
        }

        #disguised-content {
            background-color: #FFF;
            border-left-color: #c6c6c6;
            border-right-color: #c6c6c6;
            border-left-width: 1px;
            border-right-width: 1px;
            min-height: 100%;
            width: 100%;
            box-sizing: border-box;
            height: 100%;
            overflow-x: hidden;
            overflow-y: scroll;
        }

        #disguised-content > * {
            width: 100%;
            margin: unset;
            box-sizing: border-box;
        }

        #disguised-content p {
            color: black;
        }

        #disguised-content div {
            background-color: #FFF !important;
        }

        .disguised-link, .disguised-img-indicator {
            color: ${link_text_color};
            text-decoration: underline;
            cursor: pointer;
            margin-right: 5px;
        }

        .disguised-modal-wrapper {
            position: fixed;
            z-index: 99999;
            top: 50%;
            left: 50%;
            max-height: 100%;
            max-width: 100%;
            transform: translate(-50%, -50%);
            border: 1px solid #707070;
            background-color: #F0F0F0;
        }

        .disguised-modal-header {
            background-color: #FFF;
            min-width: 200px;
            height: 32px;
            display: flex;
        }

        .disguised-modal-title {
            flex: 1;
            user-select: none;
            padding-left: 10px;
            color: black;
            display: flex;
            align-items: center;
        }

        .disguised-modal-header-close {
            position: relative;
            background-color: transparent;
            border: none;
            cursor: pointer;
            padding: 0;
            width: 36px;
            height: 32px;
            font-size: 1em;
        }
        .disguised-modal-header-close:hover { background-color: #E81023; }
        .disguised-modal-header-close::before,
        .disguised-modal-header-close::after {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 15px;
            height: 1px;
            background-color: black;
            transform-origin: center;
        }
        .disguised-modal-header-close:hover::before,
        .disguised-modal-header-close:hover::after { background-color: #FFF; }
        .disguised-modal-header-close::before { transform: translate(-50%, -50%) rotate(45deg); }
        .disguised-modal-header-close::after { transform: translate(-50%, -50%) rotate(-45deg); }

        .disguised-modal-body {
            padding: 10px;
            background-color: #F0F0F0;
            min-height: 32px;
            max-height: calc(100vh - 32px);
            font-size: 1em;
            line-height: normal;
            overflow-y: auto;
        }

        .disguised-modal-wrapper * { margin: unset; }

        .nd-settings-form {
            font-family: 'Microsoft YaHei', sans-serif;
            width: 300px;
            box-shadow: none;
        }
        .nd-settings-form-group:not(:last-child) { margin-bottom: 15px; }
        .nd-settings-form-group label {
            display: inline-block;
            font-size: 13px;
            color: #000;
            margin-bottom: 5px;
        }
        .nd-settings-form-group select,
        .nd-settings-form-group input[type="radio"] {
            font-size: 13px;
            padding: 2px;
            border: 1px solid #c0c0c0;
            background-color: white;
            width: auto;
        }
        .nd-settings-form-group input[type="radio"] {
            width: auto;
            margin-right: 5px;
        }
        .nd-settings-form-group button {
            font-size: 13px;
            padding: 5px 10px;
            margin-right: 5px;
            border: 1px solid #c0c0c0;
            border-radius: 2px;
            background-color: #e0e0e0;
            cursor: pointer;
        }
        .nd-settings-form-group button[type="submit"] { background-color: #dcdcdc; }
        .nd-settings-form-group button:hover { background-color: #c0c0c0; }
        .nd-settings-form-group button:active { background-color: #a0a0a0; }
        .nd-settings-form-group button:focus { outline: 1px solid #606060; }
        .nd-settings-form-group select { margin-right: 5px; width: 180px; }
        .nd-settings-form-group select:focus-visible { outline: none; }
        .nd-settings-form-group label:first-child { width: 100px; }
        .nd-settings-form p { margin-bottom: 10px; }
        .nd-settings-btn-wrapper { display: flex; justify-content: flex-end; }

        .nd_msg{display:none;position:fixed;top:10px;left:50%;transform:translateX(-50%);color:#fff;text-align:center;z-index:99996;padding:10px 30px;font-size:16px;border-radius:10px;background-size:25px;background-repeat:no-repeat;background-position:15px}
        .nd_msg a{color:#fff;text-decoration: underline;}
        .nd_msg-ok{background:#4bcc4b}
        .nd_msg-err{background:#c33}
        .nd_msg-warn{background:#FF9900}
        `);

        // 图标
        const link = $('<link rel="icon" type="image/x-icon">').attr('href', disguised_icon_img);
        $('link[rel*="icon"]').remove();
        $('head').append(link);

        $('body').children().hide();

        $(`<div id='disguised-page'>
                <div id='disguised-title'></div>
                <div id='disguised-header' class='img-fill-in'></div>
                <div id='disguised-body'>
                    <div id='disguised-content'></div>
                </div>
                <div id='disguised-footer' class='img-fill-in'>
                    <div id="footer-content">
                        <span>简体中文（中国大陆）</span><span>辅助功能：一切就绪</span>
                    </div>
                </div>
           </div>`).appendTo("body");

        overridePageTitle();

        GM_addStyle(`
        #footer-content {
            height: 45%;
            line-height: 45%;
        }

        table { margin: 0; }
        .excel-table,
        .excel-table th,
        .excel-table td,
        .excel-table thead,
        .excel-table tbody { border-spacing: 0; }
        .excel-table { border-collapse: collapse; }

        .excel-table > thead {
            background-color: ${config.theme === DICT.THEME.OFFICE ? '#E6E6E6' : '#EEEEEE'};
        }

        .excel-table > thead > tr > th {
            font-weight: normal;
            font-size: 14px;
            color: black !important;
            background-color: ${config.theme === DICT.THEME.OFFICE ? '#E6E6E6' : '#EEEEEE'};
            position: sticky;
            top: 0;
            outline: 1px solid;
            outline-color: #A0A0A0;
            text-align: center;
            font-family: "SimSun", sans-serif;
            padding: 0;
            line-height: normal;
            z-index: 9999;
        }

        .excel-table th { min-width: 71px; }
        .excel-table th:nth-child(1) { width: auto; min-width: 20px; }
        /* 正文列 (A) 宽度由 CSS 变量控制, 用户可在设置里通过滑块调整.
           不能用 nth-child(2) 选 tbody 单元格 -- 微信读书的 canvas 用 rowspan 跨多行,
           后续行的 nth-child(2) 会错位匹配到右侧假数据格. 改用 class 精确标记. */
        .excel-table th:nth-child(2),
        .excel-table tbody > tr > td.disguised-content-cell {
            width: var(--body-content-width, 700px);
            white-space: normal;
        }

        .excel-table > tbody > tr > td:nth-child(1) {
            text-align: center;
            background-color: #E6E6E6;
            padding-left: 5px;
            padding-right: 5px;
            user-select: none;
        }
        .excel-table tbody td:not(:nth-child(1)):not(:nth-child(2)) {
            white-space: nowrap;
            text-align: center;
        }
        .excel-table > tbody > tr > td {
            border: 1px solid #DDDDDD;
            padding: 3px 10px;
            line-height: normal;
        }
        .excel-table > tbody > tr > td,
        .excel-table tbody td p {
            font-size: 12px;
            font-weight: normal;
            color: black !important;
            font-family: "Microsoft YaHei", "SimSun", sans-serif;
        }
        .excel-table > tbody > tr:first-child > td { border-top: none; }
        .excel-table tbody td > div {
            margin: 0;
            padding: 0;
            text-align: unset;
        }
        `);

        // 构建表格
        const $table = $('<table class="excel-table"></table>');
        const extraThead = (function () {
            let output = '';
            for (let i = 1; i <= config.emptyCols; i++) {
                const char = String.fromCharCode(64 + i);
                output += `<th>${char}</th>`;
            }
            return output;
        })();
        const $thead = $(`<thead><tr><th></th>${extraThead}</tr></thead>`);
        const $tbody = $('<tbody></tbody>');
        $table.append($thead);
        $table.append($tbody);
        $("#disguised-content").append($table);

        // 应用 B 列宽度 CSS 变量 (用户可在设置中通过滑块调整)
        document.documentElement.style.setProperty('--body-content-width', config.bodyContentWidth + 'px');

        padExcelBlankLines();
        insertTitleRow();
        watchTitleChanges();
    }

    function overridePageTitle() {
        document.title = "工作簿1";
    }

    // 顶端标题行 (合并单元格), 内容取自原始 <title>
    GM_addStyle(`
        .excel-table > tbody > tr.disguised-title-row > td.disguised-title-cell {
            text-align: left !important;
            font-size: 15px !important;
            font-weight: bold !important;
            color: #1f4e79 !important;
            background-color: #FAFAFA !important;
            padding: 10px 14px !important;
            border-bottom: 2px solid #5e9c4a !important;
            letter-spacing: 0.3px;
            line-height: 1.4;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .excel-table > tbody > tr.disguised-title-row > td:first-child {
            background-color: #E6E6E6;
        }
    `);

    function insertTitleRow() {
        const $tbody = $(".excel-table > tbody");
        if (!$tbody.length) return;
        $tbody.find('.disguised-title-row').remove();
        const title = originalDocTitle || '工作簿1';
        const $tr = $('<tr class="disguised-title-row"></tr>');
        $tr.append($('<td></td>'));   // 空序号格, 保留灰色背景
        // colspan 跨越正文列 + 所有右侧数据列 (header A..T 共 20 个 + 行尾 1 个 = 21)
        $tr.append($('<td class="disguised-title-cell" colspan="21"></td>').text(title));
        $tbody.prepend($tr);
    }

    // 监听 <title> 元素变化, 用于 SPA 站点 (起点/微信读书) 切换章节时同步 excel 标题行.
    // 必须排除 overridePageTitle() 设的 "工作簿1", 否则会把覆盖值反向写回标题行.
    let _titleObserverAttached = false;
    function watchTitleChanges() {
        if (_titleObserverAttached) return;
        const titleEl = document.querySelector('title');
        if (!titleEl) return;
        _titleObserverAttached = true;
        const observer = new MutationObserver(function () {
            const newTitle = (document.title || '').trim();
            if (!newTitle || newTitle === '工作簿1' || newTitle === originalDocTitle) return;
            originalDocTitle = newTitle;
            $(".excel-table > tbody > tr.disguised-title-row > td.disguised-title-cell").text(newTitle);
            printLog('检测到 <title> 变更, 已同步到表格标题行:', newTitle);
        });
        observer.observe(titleEl, { childList: true, subtree: true, characterData: true });
        printLog('已挂载 <title> 变更监听');
    }

    function clearExcelContent() {
        $(".excel-table tbody").empty();
        resetBigChartState();
        insertTitleRow();
    }

    function getExcelLastIndex() {
        const $cell = $(".excel-table > tbody > tr:last-child > td:first-child");
        const indexCellText = $.trim($cell.text());
        return indexCellText ? parseInt(indexCellText) : 0;
    }

    function padExcelBlankLines(max = 50) {
        const lastIndex = getExcelLastIndex();
        const emptyLines = [];
        for (let i = lastIndex + 1; i <= max; i++) {
            emptyLines.push("​");
        }
        setExcelLines(emptyLines, true);
    }

    function setExcelLines(lines, append = false, rowHandler) {
        let lastIndex;
        if (append) {
            lastIndex = getExcelLastIndex();
        } else {
            clearExcelContent();
            lastIndex = 0;
        }
        const $tbody = $(".excel-table > tbody");
        lines.forEach(function (line, index) {
            if (typeof line === 'string') {
                line = line.replace(/&nbsp;/g, '').trim();
            }
            if (line === '') return;
            if (line instanceof $ && line.length === 0) return;

            const $td2 = $('<td class="disguised-content-cell"></td>');
            if (typeof rowHandler === 'function') {
                line = rowHandler(line, index, $td2);
            }

            const $tr = $('<tr></tr>');
            const $td1 = $('<td></td>').text(++lastIndex);
            $td2.html(line);
            $tr.append($td1);
            $tr.append($td2);
            appendEmptyColsForRow($tr);
            $tbody.append($tr);
        });
    }

    function setExcelContent($contentEl, type = 'br', clone = false, rowHandler) {
        if (type === 'br') {
            const lines = $contentEl.html().split('<br>');
            setExcelLines(lines);
        } else if (type === 'p') {
            let pList;
            if (clone) {
                pList = $contentEl.children('p').clone().toArray();
            } else {
                pList = $contentEl.children('p').toArray();
            }
            pList = pList.filter(function (p) {
                return $(p).text().trim() !== '';
            });
            setExcelLines(pList);
        }
    }

    function addEmptyExcelLines(num = 1) {
        setExcelLines(new Array(num).fill("​"), true);
    }

    function addExcelStyle(styleText) {
        GM_addStyle(styleText);
    }

    function setDisguisedTitle(titleStr) {
        $('#disguised-title').text(titleStr);
    }

    function setDisguisedFooter(detail) {
        const $footerEl = $('#footer-content');
        $footerEl.text("");
        if (typeof detail === "string") {
            $footerEl.text(detail);
        } else {
            detail.appendTo($footerEl);
        }
    }

    function getScreenInfo() {
        const screenWidth = window.screen.width;
        const screenHeight = window.screen.height;
        const devicePixelRatio = window.devicePixelRatio || 1;
        const physicalWidth = screenWidth * devicePixelRatio;
        return {screenWidth, screenHeight, devicePixelRatio, physicalWidth};
    }

    // 假数据样式集合, 每次刷新页面随机选一种, 增加伪装真实性
    const DATA_STYLES = ['app_download', 'conversion_funnel', 'channel_share', 'kpi_dashboard'];
    const currentDataStyle = DATA_STYLES[Math.floor(Math.random() * DATA_STYLES.length)];
    printLog('当前假数据样式:', currentDataStyle);

    function generateRandomContent(colIndex = 0) {
        function getRandomInt(a, b) {
            return Math.floor(Math.random() * (b - a + 1)) + a;
        }
        function getRandomItem(list) {
            return list[Math.floor(Math.random() * list.length)];
        }
        function generateRandomLetters(n, isUpperCase) {
            const letters = isUpperCase ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' : 'abcdefghijklmnopqrstuvwxyz';
            let result = '';
            for (let i = 0; i < n; i++) result += letters.charAt(Math.floor(Math.random() * letters.length));
            return result;
        }
        function getRandomPaddedInt(n) {
            const max = Math.pow(10, n) - 1;
            const min = Math.pow(10, n - 1);
            return (Math.floor(Math.random() * (max - min + 1)) + min).toString().padStart(n, '0');
        }
        function getRandomChineseName() {
            const surnames = ["赵","钱","孙","李","周","刘","王","陈","杨","黄","吴","郑"];
            const chars = ["伟","秀","敏","静","丽","强","磊","军","洋","杰","婷","浩","欣","佳","琪","思","鑫","博","宇","轩","涵","宁","瑶","晨","泽","瑞"];
            const surname = getRandomItem(surnames);
            const len = Math.random() < 0.5 ? 1 : 2;
            let given = "";
            for (let i = 0; i < len; i++) given += getRandomItem(chars);
            return surname + given;
        }
        function getRandomDate() {
            const year = getRandomInt(2023, 2026);
            const month = String(getRandomInt(1, 12)).padStart(2, '0');
            const day = String(getRandomInt(1, 28)).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
        function getThousands(min, max) {
            return getRandomInt(min, max).toLocaleString('en-US');
        }
        function getAppName() {
            return getRandomItem(['番茄阅读','起点小说','番茄畅听','微信读书','QQ阅读','喜马拉雅','晋江文学','刺猬猫','百度阅读','飞卢小说','纵横中文','咪咕阅读','掌阅','书旗小说','七猫小说']);
        }
        function getStoreName() {
            return getRandomItem(['App Store','华为应用市场','小米应用商店','OPPO','VIVO','应用宝','百度手机助手','Google Play','360手机助手','豌豆荚']);
        }
        function getChannelName() {
            return getRandomItem(['抖音','快手','微信朋友圈','小红书','B站','百度SEM','OPPO广告','VIVO广告','今日头条','UC','微博','知乎','腾讯广告','巨量引擎','磁力金牛']);
        }
        function getPlatform() {
            const list = [['iOS','#D9E1F2'],['Android','#E2EFDA'],['HarmonyOS','#FCE4D6']];
            const [t, bg] = getRandomItem(list);
            return fillCell(t, bg);
        }
        function getRating() {
            const score = (Math.random()*1.5+3.5).toFixed(1);
            const inner = `<span style="color:#e08e45 !important;">★</span> ${score}`;
            if (parseFloat(score) >= 4.7) return fillCell(inner, '#FFEB9C');
            return maybeFill(inner, 0.2);
        }
        function getStatusBadge() {
            const list = [
                ['正常',    '#C6EFCE', '#1f6e1f'],
                ['运行中',  '#BDD7EE', '#1F4E79'],
                ['推广中',  '#BDD7EE', '#1F4E79'],
                ['待发布',  '#FFEB9C', '#7F6000'],
                ['审核中',  '#E4D5F1', '#5E3A87'],
                ['已暂停',  '#FFC7CE', '#9C0006']
            ];
            const [t, bg, fg] = getRandomItem(list);
            return fillCell(`<span style="color:${fg} !important;font-weight:bold;">● ${t}</span>`, bg);
        }
        function getTrend() {
            const up = Math.random() > 0.4;
            const v = (Math.random()*30+0.5).toFixed(1);
            return up
                ? fillCell(`<span style="color:#1f6e1f !important;font-weight:bold;">▲ ${v}%</span>`, '#C6EFCE')
                : fillCell(`<span style="color:#9C0006 !important;font-weight:bold;">▼ ${v}%</span>`, '#FFC7CE');
        }
        function getGrade() {
            const list = [
                ['S',  '#FFD966'], ['S+', '#FFC000'],
                ['A',  '#C6E0B4'], ['A+', '#A9D08E'], ['A-', '#C6E0B4'],
                ['B',  '#D9E1F2'], ['B+', '#BDD7EE'],
                ['C',  '#F4CCCC']
            ];
            const [t, bg] = getRandomItem(list);
            return fillCell(`<b>${t}</b>`, bg);
        }
        function getMoneyWan() {
            return `¥${(Math.random()*999+10).toFixed(2)}万`;
        }

        // 整格背景填充 (用 -3px -10px 反向 margin 抵消 td padding, 覆盖整个单元格)
        function fillCell(content, color) {
            return `<div style="background-color:${color} !important;margin:-3px -10px;padding:3px 10px;">${content}</div>`;
        }

        // 概率性浅色填充, 模拟 Excel 条件格式的零散高亮
        const LIGHT_PALETTE = ['#FFF2CC','#D9E1F2','#E2EFDA','#FCE4D6','#F4CCCC','#EDEDED','#EAD1DC'];
        function maybeFill(content, prob = 0.22, palette) {
            if (Math.random() > prob) return content;
            const pool = palette || LIGHT_PALETTE;
            return fillCell(content, pool[Math.floor(Math.random()*pool.length)]);
        }

        // 数据条 (Excel 的 in-cell bar)
        function getProgressBar(min = 5, max = 100) {
            const value = getRandomInt(min, max);
            const barColor = value > 70 ? '#4a90d9' : value > 30 ? '#7fb069' : '#e08e45';
            return `<div style="position:relative;background-color:#f0f0f0 !important;margin:-3px -10px;padding:0;height:18px;line-height:18px;">
                <div style="background-color:${barColor} !important;height:100%;width:${value}%;opacity:0.7;"></div>
                <div style="position:absolute;top:0;left:0;width:100%;text-align:center;font-size:11px;color:#000 !important;background-color:transparent !important;">${value}%</div>
            </div>`;
        }

        // 迷你柱状图 sparkline
        function getMiniBars() {
            const color = getRandomItem(['#4a90d9','#5e9c4a','#c47a30','#7a5dbf']);
            let bars = '';
            for (let i = 0; i < 7; i++) {
                const h = getRandomInt(3, 14);
                bars += `<rect x="${i*6+1}" y="${14-h}" width="4" height="${h}" fill="${color}" opacity="0.85"/>`;
            }
            return `<svg width="44" height="14" style="vertical-align:middle;">${bars}</svg>`;
        }

        // 迷你折线图
        function getSparkline() {
            const pts = [];
            let y = getRandomInt(4, 11);
            for (let i = 0; i < 8; i++) {
                pts.push(`${i*6+1},${y}`);
                y = Math.max(2, Math.min(12, y + getRandomInt(-3, 3)));
            }
            const color = getRandomItem(['#4a90d9','#5e9c4a','#c47a30']);
            return `<svg width="44" height="14" style="vertical-align:middle;">
                <polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5"/>
            </svg>`;
        }

        // 迷你饼图
        function getMiniPie() {
            const pct = getRandomInt(15, 85);
            const palettes = [['#4a90d9','#dde7f0'],['#5e9c4a','#dfeada'],['#c47a30','#f0e1cf'],['#7a5dbf','#e4ddef']];
            const [fg, bg] = getRandomItem(palettes);
            const r = 7, cx = 8, cy = 8;
            const angle = (pct / 100) * 360;
            const rad = (angle - 90) * Math.PI / 180;
            const endX = (cx + r * Math.cos(rad)).toFixed(2);
            const endY = (cy + r * Math.sin(rad)).toFixed(2);
            const largeArc = angle > 180 ? 1 : 0;
            return `<svg width="16" height="16" style="vertical-align:middle;">
                <circle cx="${cx}" cy="${cy}" r="${r}" fill="${bg}"/>
                <path d="M ${cx} ${cy} L ${cx} ${cy-r} A ${r} ${r} 0 ${largeArc} 1 ${endX} ${endY} Z" fill="${fg}"/>
            </svg>`;
        }

        // 迷你环形图 + 百分比文本
        function getMiniDonut() {
            const pct = getRandomInt(30, 95);
            const color = getRandomItem(['#4a90d9','#5e9c4a','#c47a30','#b8485f']);
            const C = 2 * Math.PI * 6;
            const dash = ((pct/100) * C).toFixed(2);
            const rest = (C - dash).toFixed(2);
            return `<svg width="16" height="16" style="vertical-align:middle;" viewBox="0 0 18 18">
                <circle cx="9" cy="9" r="6" fill="none" stroke="#e6e6e6" stroke-width="2.5"/>
                <circle cx="9" cy="9" r="6" fill="none" stroke="${color}" stroke-width="2.5"
                    stroke-dasharray="${dash} ${rest}" transform="rotate(-90 9 9)"/>
            </svg><span style="font-size:10px;margin-left:3px;">${pct}%</span>`;
        }

        // 4 种样式, 每列对应一个生成函数
        const styles = {
            // 应用下载分析
            app_download: [
                () => maybeFill(`APP-${generateRandomLetters(3, true)}-${getRandomPaddedInt(5)}`, 0.15, ['#EDEDED']),
                () => maybeFill(getAppName(), 0.2),
                () => maybeFill(getStoreName(), 0.2),
                () => getPlatform(),
                () => {
                    const n = getRandomInt(1000, 999999);
                    const text = n.toLocaleString('en-US');
                    return n > 500000 ? fillCell(text, '#FFEB9C') : maybeFill(text, 0.18);
                },
                () => getMiniBars(),
                () => getRating(),
                () => getStatusBadge(),
                () => maybeFill(getRandomDate(), 0.12, ['#EDEDED'])
            ],
            // 转化率漏斗 (曝光 → 下载 → 注册 → 付费)
            conversion_funnel: [
                () => maybeFill(`PROM-${generateRandomLetters(2, true)}-${getRandomPaddedInt(4)}`, 0.15, ['#EDEDED']),
                () => maybeFill(getChannelName(), 0.25),
                () => maybeFill(getThousands(10000, 9999999), 0.18),
                () => maybeFill(getThousands(500, 99999), 0.18),
                () => getProgressBar(15, 75),
                () => getProgressBar(8, 50),
                () => getProgressBar(1, 22),
                () => getSparkline(),
                () => {
                    const v = (Math.random()*5+0.5).toFixed(2);
                    return parseFloat(v) >= 3 ? fillCell(v, '#C6EFCE') : parseFloat(v) < 1 ? fillCell(v, '#FFC7CE') : v;
                }
            ],
            // 渠道占比 (饼图为主)
            channel_share: [
                () => maybeFill(getChannelName(), 0.25),
                () => maybeFill(getThousands(1000, 999999), 0.2),
                () => getMiniPie(),
                () => {
                    const p = (Math.random()*33+2).toFixed(1) + '%';
                    return parseFloat(p) >= 25 ? fillCell(p, '#FFEB9C') : maybeFill(p, 0.15);
                },
                () => getTrend(),
                () => getProgressBar(40, 95),
                () => maybeFill(`¥${(Math.random()*100+5).toFixed(2)}`, 0.18),
                () => getGrade(),
                () => getStatusBadge()
            ],
            // KPI 看板 (混合: 柱图 + 环形图)
            kpi_dashboard: [
                () => maybeFill(`PD-${getRandomPaddedInt(4)}`, 0.15, ['#EDEDED']),
                () => maybeFill(getRandomChineseName(), 0.22),
                () => maybeFill(getThousands(5000, 999999), 0.2),
                () => getMiniBars(),
                () => getMiniDonut(),
                () => getProgressBar(40, 100),
                () => getTrend(),
                () => maybeFill(getMoneyWan(), 0.22, ['#FFF2CC','#FFEB9C']),
                () => getStatusBadge()
            ]
        };

        const cols = styles[currentDataStyle];
        const fn = cols[colIndex % cols.length];
        return fn();
    }

    // ============ 大图表 (跨行跨列) ============
    GM_addStyle(`
        .excel-table .big-chart-cell {
            background-color: #FAFAFA !important;
            border: 1px solid #C0C0C0 !important;
            vertical-align: middle !important;
            text-align: center !important;
            padding: 6px 4px !important;
            white-space: normal !important;
        }
        .excel-table .big-chart-cell > * { background-color: transparent !important; }
        .excel-table .big-chart-cell .big-chart-title {
            font-size: 14px;
            color: #444 !important;
            margin-bottom: 8px;
            font-weight: bold;
            letter-spacing: 0.5px;
        }
        .excel-table .big-chart-cell .big-chart-caption {
            font-size: 11px;
            color: #777 !important;
            margin-top: 6px;
            line-height: 1.6;
        }
    `);

    let _chartRowIdx = 0;
    let _chartNextAt = 2;
    let _chartActive = null;

    function resetBigChartState() {
        _chartRowIdx = 0;
        _chartNextAt = 2;
        _chartActive = null;
    }

    function buildBigChartHtml() {
        const rint = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
        const pick = (list) => list[Math.floor(Math.random() * list.length)];

        // 柱状图: 7 天下载量 (600x160)
        function bigBars() {
            const color = pick(['#4a90d9','#5e9c4a','#c47a30','#7a5dbf']);
            const days = ['一','二','三','四','五','六','日'];
            const baseY = 130, chartH = 110, barW = 50, gap = 30, leftPad = 50;
            let bars = '', vals = '', labels = '', grid = '';
            for (let g = 0; g < 4; g++) {
                const y = baseY - (g * chartH / 3);
                grid += `<line x1="${leftPad-5}" y1="${y}" x2="595" y2="${y}" stroke="#eee" stroke-width="1"/>`;
                grid += `<text x="${leftPad-10}" y="${y+4}" text-anchor="end" font-size="10" fill="#aaa">${Math.round((g/3)*100)}</text>`;
            }
            for (let i = 0; i < 7; i++) {
                const v = rint(25, 95);
                const h = (v / 100) * chartH;
                const x = leftPad + i * (barW + gap);
                const y = baseY - h;
                bars += `<rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="${color}" opacity="0.88" rx="2"/>`;
                vals += `<text x="${x + barW/2}" y="${y - 5}" text-anchor="middle" font-size="11" fill="#555" font-weight="bold">${v}</text>`;
                labels += `<text x="${x + barW/2}" y="148" text-anchor="middle" font-size="11" fill="#888">周${days[i]}</text>`;
            }
            const growth = (Math.random()*15+2).toFixed(1);
            return `<div class="big-chart-title">近7日下载量趋势 (万次)</div>
                <svg width="600" height="160" viewBox="0 0 600 160" style="max-width:100%;">
                    ${grid}${bars}${vals}${labels}
                </svg>
                <div class="big-chart-caption">周环比 <span style="color:#1f6e1f;">▲ ${growth}%</span>  ·  日均下载 ${rint(35, 85)} 万次  ·  累计 ${rint(280, 680)} 万次</div>`;
        }

        // 折线图: 14日转化率趋势 (600x160)
        function bigLine() {
            const color = pick(['#4a90d9','#5e9c4a','#c47a30']);
            const N = 14;
            const baseY = 130, chartH = 110, leftPad = 50, rightPad = 30;
            const chartW = 600 - leftPad - rightPad;
            const xStep = chartW / (N - 1);
            const ys = [];
            let y = rint(40, 70);
            for (let i = 0; i < N; i++) {
                ys.push(y);
                y = Math.max(20, Math.min(105, y + rint(-12, 14)));
            }
            const scaleY = (val) => baseY - (val / 110) * chartH;
            const pts = ys.map((yy, i) => `${leftPad + i * xStep},${scaleY(yy).toFixed(1)}`).join(' ');
            const areaPts = `${leftPad},${baseY} ${pts} ${leftPad + (N-1) * xStep},${baseY}`;
            let dots = '', xLabels = '', grid = '';
            for (let g = 0; g < 4; g++) {
                const yy = baseY - (g * chartH / 3);
                grid += `<line x1="${leftPad-5}" y1="${yy}" x2="${600-rightPad}" y2="${yy}" stroke="#eee" stroke-width="1"/>`;
                grid += `<text x="${leftPad-10}" y="${yy+4}" text-anchor="end" font-size="10" fill="#aaa">${Math.round((g/3)*110)}%</text>`;
            }
            ys.forEach((yy, i) => {
                const x = leftPad + i * xStep;
                dots += `<circle cx="${x}" cy="${scaleY(yy).toFixed(1)}" r="3" fill="#fff" stroke="${color}" stroke-width="2"/>`;
                if (i % 2 === 0) xLabels += `<text x="${x}" y="148" text-anchor="middle" font-size="10" fill="#888">D${String(i+1).padStart(2,'0')}</text>`;
            });
            const avg = (ys.reduce((s, x) => s + x, 0) / ys.length).toFixed(1);
            const peak = Math.max(...ys);
            return `<div class="big-chart-title">14日转化率趋势</div>
                <svg width="600" height="160" viewBox="0 0 600 160" style="max-width:100%;">
                    ${grid}
                    <polygon points="${areaPts}" fill="${color}" opacity="0.18"/>
                    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5"/>
                    ${dots}${xLabels}
                </svg>
                <div class="big-chart-caption">均值 ${avg}%  ·  峰值 ${peak}%  ·  趋势 <span style="color:#1f6e1f;">▲ 稳步上升</span>  ·  样本量 ${rint(8000, 99000).toLocaleString('en-US')}</div>`;
        }

        // 饼图: 渠道占比 (180px 饼 + 侧边图例)
        function bigPie() {
            const cx = 90, cy = 90, r = 75;
            const segs = [
                { pct: rint(28, 38), color: '#4a90d9', label: pick(['抖音','腾讯广告','巨量引擎']) },
                { pct: rint(20, 26), color: '#5e9c4a', label: pick(['快手','OPPO','应用宝']) },
                { pct: rint(14, 20), color: '#c47a30', label: pick(['微信','百度SEM','华为']) },
                { pct: rint(8, 14),  color: '#7a5dbf', label: pick(['小红书','B站','UC']) }
            ];
            const total = segs.reduce((s, x) => s + x.pct, 0);
            if (total < 100) segs.push({ pct: 100 - total, color: '#bbb', label: '其他' });

            let startAngle = 0, paths = '';
            segs.forEach(s => {
                const angle = (s.pct / 100) * 360;
                const endAngle = startAngle + angle;
                const sr = (startAngle - 90) * Math.PI / 180;
                const er = (endAngle - 90) * Math.PI / 180;
                const x1 = cx + r * Math.cos(sr), y1 = cy + r * Math.sin(sr);
                const x2 = cx + r * Math.cos(er), y2 = cy + r * Math.sin(er);
                const largeArc = angle > 180 ? 1 : 0;
                paths += `<path d="M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${s.color}" stroke="#fff" stroke-width="1.5"/>`;
                startAngle = endAngle;
            });

            const legendRows = segs.map(s => `
                <div style="display:flex;align-items:center;font-size:12px;margin:5px 0;background-color:transparent !important;">
                    <span style="display:inline-block;width:12px;height:12px;background:${s.color} !important;margin-right:8px;border-radius:2px;"></span>
                    <span style="min-width:72px;color:#555 !important;">${s.label}</span>
                    <span style="font-weight:bold;color:#222 !important;min-width:42px;text-align:right;">${s.pct}%</span>
                    <span style="margin-left:10px;color:#999 !important;font-size:10px;">${rint(80, 990).toLocaleString('en-US')}</span>
                </div>`).join('');

            return `<div class="big-chart-title">渠道占比分析 (本周)</div>
                <div style="display:inline-flex;align-items:center;justify-content:center;gap:40px;background-color:transparent !important;">
                    <svg width="180" height="180" viewBox="0 0 180 180">${paths}</svg>
                    <div style="text-align:left;background-color:transparent !important;">${legendRows}</div>
                </div>`;
        }

        // 环形图: 健康度评分 (160px + 侧边指标)
        function bigDonut() {
            const pct = rint(58, 94);
            const color = pct >= 80 ? '#1f6e1f' : pct >= 65 ? '#4a90d9' : '#c47a30';
            const r = 60;
            const C = 2 * Math.PI * r;
            const dash = ((pct/100) * C).toFixed(2);
            const rest = (C - dash).toFixed(2);
            const rating = pct >= 85 ? '优秀' : pct >= 70 ? '良好' : pct >= 60 ? '正常' : '需关注';

            const metrics = [
                { label: '日活 (DAU)', value: rint(8000, 99999).toLocaleString('en-US'), trend: (Math.random()*15+0.5).toFixed(1) },
                { label: '留存率',     value: rint(45, 88) + '%',                          trend: (Math.random()*5+0.2).toFixed(1) },
                { label: 'ARPU',       value: '¥' + (Math.random()*50+5).toFixed(2),       trend: (Math.random()*10+0.5).toFixed(1) },
                { label: '次日留存',   value: rint(30, 70) + '%',                          trend: (Math.random()*8+0.2).toFixed(1) }
            ];
            const metricRows = metrics.map(m => `
                <div style="display:flex;align-items:center;font-size:12px;margin:4px 0;background-color:transparent !important;">
                    <span style="color:#777 !important;min-width:70px;">${m.label}</span>
                    <span style="font-weight:bold;color:#222 !important;min-width:90px;">${m.value}</span>
                    <span style="color:#1f6e1f !important;font-size:11px;">▲ ${m.trend}%</span>
                </div>`).join('');

            return `<div class="big-chart-title">综合健康度评分</div>
                <div style="display:inline-flex;align-items:center;justify-content:center;gap:40px;background-color:transparent !important;">
                    <svg width="160" height="160" viewBox="0 0 160 160">
                        <circle cx="80" cy="80" r="${r}" fill="none" stroke="#ececec" stroke-width="14"/>
                        <circle cx="80" cy="80" r="${r}" fill="none" stroke="${color}" stroke-width="14"
                            stroke-dasharray="${dash} ${rest}" transform="rotate(-90 80 80)" stroke-linecap="round"/>
                        <text x="80" y="86" text-anchor="middle" font-size="36" font-weight="bold" fill="${color}">${pct}</text>
                        <text x="80" y="105" text-anchor="middle" font-size="11" fill="#888">/ 100 分</text>
                    </svg>
                    <div style="text-align:left;background-color:transparent !important;">
                        <div style="font-size:14px;color:${color} !important;font-weight:bold;margin-bottom:8px;background-color:transparent !important;">综合评级: ${rating}</div>
                        ${metricRows}
                    </div>
                </div>`;
        }

        const chartByStyle = {
            app_download:      { html: bigBars(),  colspan: 10, rowspan: 10 },
            conversion_funnel: { html: bigLine(),  colspan: 10, rowspan: 10 },
            channel_share:     { html: bigPie(),   colspan: 10, rowspan: 10 },
            kpi_dashboard:     { html: bigDonut(), colspan: 10, rowspan: 10 }
        };
        return chartByStyle[currentDataStyle] || chartByStyle.app_download;
    }

    function appendEmptyColsForRow($tr) {
        _chartRowIdx++;

        // 当前有跨行图表占位 → 跳过被占用的列
        if (_chartActive) {
            const skip = _chartActive.skip;
            for (let i = 0; i < config.emptyCols; i++) {
                if (skip.includes(i)) continue;
                let tdContent = "";
                if (config.enableExcelRandomPopulate && i < config.maxExcelRandomPopulateCol) {
                    tdContent = generateRandomContent(i);
                }
                $tr.append($(`<td>${tdContent}</td>`));
            }
            _chartActive.rowsLeft--;
            if (_chartActive.rowsLeft <= 0) {
                _chartActive = null;
                _chartNextAt = _chartRowIdx + 2;  // 1 行间隔后再插下一个
            }
            return;
        }

        // 该插入新图表 (统一从 K 列起, 占 10x10)
        if (_chartRowIdx >= _chartNextAt) {
            const chart = buildBigChartHtml();
            // K 列 = loop i=9 (B=0, C=1, ..., K=9)
            const startCol = 9;
            const skip = [startCol];
            for (let c = startCol + 1; c < startCol + chart.colspan; c++) skip.push(c);

            _chartActive = { skip, rowsLeft: chart.rowspan - 1 };

            for (let i = 0; i < config.emptyCols; i++) {
                if (i === startCol) {
                    $tr.append($(`<td class="big-chart-cell" colspan="${chart.colspan}" rowspan="${chart.rowspan}">${chart.html}</td>`));
                    continue;
                }
                if (skip.includes(i)) continue;
                let tdContent = "";
                if (config.enableExcelRandomPopulate && i < config.maxExcelRandomPopulateCol) {
                    tdContent = generateRandomContent(i);
                }
                $tr.append($(`<td>${tdContent}</td>`));
            }

            if (_chartActive.rowsLeft <= 0) {
                _chartActive = null;
                _chartNextAt = _chartRowIdx + 2;
            }
            return;
        }

        // 普通行
        for (let i = 0; i < config.emptyCols; i++) {
            let tdContent = "";
            if (config.enableExcelRandomPopulate && i < config.maxExcelRandomPopulateCol) {
                tdContent = generateRandomContent(i);
            }
            $tr.append($(`<td>${tdContent}</td>`));
        }
    }

    function showModal(content, modalConfig = {}) {
        const $modal = $(`
        <div class="disguised-modal-wrapper">
            <div class="disguised-modal-header">
                <div class="disguised-modal-title">${modalConfig.title || ""}</div>
            </div>
            <div class="disguised-modal-body"></div>
        </div>
        `);

        const $headerClose = $(`<div class="disguised-modal-header-close"></div>`);
        $headerClose.on("click", function () {
            $modal.remove();
        });
        $modal.find(".disguised-modal-header").append($headerClose);

        if (modalConfig.width && typeof modalConfig.width === "number") {
            $modal.css("width", `${modalConfig.width}px`);
        }

        if (typeof content === "string") {
            $modal.find(".disguised-modal-body").text(content);
        } else {
            content.appendTo($modal.find(".disguised-modal-body"));
        }

        $("#disguised-page").append($modal);
        return $modal;
    }

    function popMsg(msg, type = 'ok') {
        $('.nd_msg').length > 0 && $('.nd_msg').remove();
        let $msg = $(`<div class="nd_msg nd_msg-${type}">${msg}</div>`);
        $('body').append($msg);
        $msg.slideDown(200);
        setTimeout(() => { $msg.fadeOut(500); }, type == 'ok' ? 2000 : 5000);
        setTimeout(() => { $msg.remove(); }, type == 'ok' ? 2500 : 5500);
    }

    ///////////////////////////// 站点开始

    /**
     * 起点
     */
    function qidian() {
        GM_addStyle(`
        #right-container {
            position: unset;
            height: 100%;
        }
        .chapter-end-qrcode { display: none; }
        .review-icon { background: var(--surface-gray-100) !important; }
        .review-count { color: var(--surface-gray-200) !important; }
        .tooltip-wrapper { display: none; }
        #side-sheet div, #side-sheet section { background-color: #FFF; }
        .chapter-date { background: unset !important; }
        button {
            background-color: ${link_bg_color} !important;
            color: ${link_text_color} !important;
        }
        button > span { color: ${link_text_color} !important; }

        .excel-table tbody td, .excel-table tbody td p { font-family: unset; }
        .excel-table tbody td p { margin-top: 0 !important; }
        `);

        const $mainContent = $("main.content");
        const contentId = $mainContent.attr('id');
        const dataType = $mainContent.attr('data-type');
        const $tbody = $(".excel-table tbody");

        const scriptContent = $('#vite-plugin-ssr_pageContext').html();
        if (scriptContent && scriptContent.includes('"freeStatus":0')) {
            // 免费
            setExcelContent($("main.content"), 'p', true);
            setTimeout(function () {
                setExcelContent($("main.content"), 'p');
                setExcelLines([$(".nav-btn-group")], true);
                setInfo();
            }, 2000);
        } else {
            if (!$('main.content').hasClass('lock-mask')) {
                // 收费
                const targetNode = document.querySelector('main.content');
                const observerConfig = {childList: true};
                const callback = function (mutationsList, observer) {
                    for (let mutation of mutationsList) {
                        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                            $tbody.attr("id", contentId);
                            $tbody.attr("data-type", dataType);
                            $tbody.addClass("content");
                            setExcelContent($("main.content"), 'p', true);
                            setTimeout(function () {
                                setExcelContent($("main.content"), 'p');
                                setExcelLines([$(".nav-btn-group")], true);
                            }, 2000);
                            setInfo();
                            observer.disconnect();
                            break;
                        }
                    }
                };
                const observer = new MutationObserver(callback);
                observer.observe(targetNode, observerConfig);
            } else {
                // 未解锁
                setExcelLines($(".chapter-wrapper section:not(#r-recommends) > div:not(.download)").toArray());
            }
        }
        setInfo();

        addExcelStyle(`
            #disguised-page #disguised-body table.excel-table tbody:not(thead) tr .nav-btn-group a {
                font-family: "Microsoft YaHei", "SimSun", sans-serif !important;
            }
            #disguised-page #disguised-body table.excel-table tbody td:not(:nth-child(1)):not(:nth-child(2)) {
                font-family: "Microsoft YaHei", "SimSun", sans-serif !important;
            }
            .nav-btn { padding: 0; }
            .excel-table button {
                padding: 0;
                font-size: unset;
                line-height: unset;
                height: 20px;
            }
        `);

        function setInfo() {
            const titleEl = $('.chapter-wrapper h1.title');
            setDisguisedTitle(titleEl.children().remove().end().text());
            titleEl.hide();

            const infoEl = titleEl.next();
            setDisguisedFooter(infoEl.children());
            infoEl.hide();

            const downloadEl = $('#r-authorSay :contains("下载App")');
            downloadEl.hide();
        }

        setTimeout(function () {
            const admireBtnEl = $('._admireBtn_131ir_200');
            admireBtnEl.hide();
            $('body').attr('data-theme', 'beige');
        }, 2000);
    }

    /**
     * 番茄
     */
    function fanqie() {
        GM_addStyle(`
        .muye-reader-nav { display: none !important; }
        .byte-btn {
            background: ${link_bg_color} !important;
            color: ${link_front_color} !important;
        }
        .reader-toolbar { display: none; }
        .muye-reader-box { padding-top: 50px; }
        .excel-table tbody td, .excel-table tbody td p { font-family: unset; }
        p { margin: 0; }
        `);

        const titleEl = $('h1.muye-reader-title');
        setDisguisedTitle(titleEl.text());
        titleEl.remove();

        const infoEl = $('.muye-reader-subtitle');
        setDisguisedFooter(infoEl.children());
        infoEl.hide();

        const $readerBox = $('.muye-reader-box');
        if ($readerBox.length) {
            const styleAttr = $readerBox.attr('style') || '';
            addExcelStyle(`
            .excel-table tbody td p {
                ${styleAttr}
            }
            `);
        }

        setExcelLines($(".muye-reader-content>div>p").toArray());
        setExcelLines([$(".muye-reader-btns")], true);
        addExcelStyle(`
            .muye-reader-btns button {
                height: 20px !important;
                line-height: 20px !important;
            }
        `);
        $(".muye-reader-btns button").on("click", function () {
            setTimeout(function () { location.reload(); }, 200);
        });

        $(".arco-tooltip").remove();
    }

    /**
     * 微信读书
     * 正文是 canvas 像素无法提取文字, 整体策略: 把 canvas 容器 detach 后塞进 B 列单元格,
     * 用 rowspan 让它跨越 N 行, 序号与右侧假数据列正常排布.
     *
     * 文字层 (用于 Ctrl+F 搜索 + boss 模式可隐藏): 由 phase 1 wereadHarvestPhase()
     * 在原生页面提前抓 .wr_absolute[class*="ccn-"] 缓存. 这里 phase 2 用 cache.chars
     * 在 canvas rowspan 之后追加文字行.
     */
    function weread(cache) {
        // 微信读书用 window.innerHeight 当渲染范围上限, span/canvas 只在 y < innerHeight
        // 内生成. 必须设大到能覆盖整章 (实测一章可达 y=8000+, 这里给到 50000 余量足够).
        // 注意: 不能改 window 本身, 只能用 defineProperty 覆盖 getter.
        try {
            Object.defineProperty(window, 'innerHeight', {
                configurable: true,
                get: function () { return 50000; }
            });
            printLog('已覆盖 window.innerHeight=50000 以强制 canvas 完整渲染');
        } catch (e) {
            printLog('warn', '覆盖 window.innerHeight 失败: ' + e.message);
        }

        GM_addStyle(`
        /* 关键: 让原 #app 留在 DOM 中可渲染, 但移出视口
           否则 display:none 会导致 Vue 探测 rootHeight=0 而不绘制 canvas */
        body > #app {
            display: block !important;
            position: absolute !important;
            top: 0 !important;
            left: -100000px !important;
            width: 1200px !important;
            height: 20000px !important;
            visibility: visible !important;
            /* 不能加 pointer-events:none, 否则伪装页 nav 按钮 click 转发到原生按钮也会被吞 */
        }
        /* 伪装层始终在最上面 */
        #disguised-page { z-index: 100000; }

        .readerTopBar, .readerControls, .readerNotePanel,
        .readerCatalog, .reader-font-control-panel-wrapper,
        .wr_dialog, .arco-tooltip, .wr_tooltip_item { display: none !important; }
        /* 注意: .readerFooter 不能 display:none, 否则里面的"下一章"按钮 click handler
           会因为父级不可见而被 Vue 内部短路, 哪怕 .click() 也不触发路由跳转.
           #app 已经被推到 -100000px 视觉上看不见, 所以不会泄露阅读内容. */

        .excel-table tbody td, .excel-table tbody td p { font-family: unset; }
        /* 微信读书 canvas 单元格无视全局 B 列宽度, 始终贴合 canvas. 用 wereadCanvasScale 调整 */
        .excel-table .weread-canvas-cell {
            width: auto !important;
            padding: 0 !important;
            vertical-align: top;
            background-color: #FFF !important;
        }
        .excel-table .weread-canvas-cell .wr_canvasContainer {
            position: relative !important;
            margin: 0 auto;
            pointer-events: none;
        }
        .excel-table .weread-canvas-cell .wr_canvasContainer canvas {
            pointer-events: none;
        }
        .excel-table .weread-nav-cell {
            text-align: center;
            padding: 8px !important;
        }
        .excel-table .weread-nav-cell button {
            background-color: ${link_bg_color} !important;
            color: ${link_text_color} !important;
            border: 1px solid #c0c0c0;
            padding: 2px 12px;
            margin: 0 5px;
            font-size: 12px;
            cursor: pointer;
            height: 22px;
            line-height: 18px;
        }
        `);

        // 把 common() 加在 #app 上的 inline display:none 移除
        $('#app').css('display', '');

        function waitForCanvas(maxWaitMs, onReady, onTimeout) {
            const startedAt = Date.now();
            let attempts = 0;
            let lastCoverage = -1;
            let stableCount = 0;
            const timer = setInterval(function () {
                attempts++;
                const $container = $('.wr_canvasContainer');
                const $canvases = $container.find('canvas');
                const styleAttr = $container.attr('style') || '';
                const heightMatch = styleAttr.match(/height:\s*([\d.]+)px/i);
                const totalHeight = heightMatch ? parseInt(heightMatch[1]) : 0;

                // 计算所有 canvas 实际覆盖到的最大 y 位置, 判断 weread 是否画完
                let canvasCoverage = 0;
                $canvases.each(function () {
                    const cTop = parseFloat(this.style.top) || 0;
                    const cHeight = parseFloat(this.style.height) || 0;
                    canvasCoverage = Math.max(canvasCoverage, cTop + cHeight);
                });

                if (attempts === 1 || attempts % 10 === 0) {
                    printLog(`waitForCanvas: container=${$container.length}, canvases=${$canvases.length}, height=${totalHeight}, coverage=${canvasCoverage}, style="${styleAttr.slice(0, 80)}"`);
                }

                const basicReady = $container.length > 0 && $canvases.length > 0 && totalHeight > 100;
                // canvas 覆盖到容器高度的 95% 以上 = 渲染完成
                const fullyPainted = basicReady && canvasCoverage >= totalHeight * 0.95;
                // 或者连续 3 次轮询 (600ms) 覆盖范围都不再增长, 认为 weread 已经画到极限
                if (basicReady && canvasCoverage === lastCoverage) {
                    stableCount++;
                } else {
                    stableCount = 0;
                }
                lastCoverage = canvasCoverage;

                if (fullyPainted || (basicReady && stableCount >= 3 && attempts >= 5)) {
                    clearInterval(timer);
                    printLog(`canvas 就绪, 容器高 ${totalHeight}px, 已绘制覆盖 ${canvasCoverage}px, 共 ${$canvases.length} 张`);
                    onReady($container, totalHeight, canvasCoverage);
                } else if (Date.now() - startedAt > maxWaitMs) {
                    clearInterval(timer);
                    printLog("error", `等待 canvas 渲染超时, 最后状态: container=${$container.length}, canvases=${$canvases.length}, height=${totalHeight}, coverage=${canvasCoverage}`);
                    if (typeof onTimeout === 'function') onTimeout();
                }
            }, 200);
        }

        function buildNavRow($tbody, rowIndex) {
            const $navRow = $('<tr></tr>');
            $navRow.append($('<td></td>').text(rowIndex));
            const $navCell = $(`<td class="weread-nav-cell"></td>`);
            $navCell.text('请通过键盘方向键 → 跳转下一章节');
            $navRow.append($navCell);
            appendEmptyColsForRow($navRow);
            $tbody.append($navRow);
        }

        // 提前给个占位标题, 真正的章节名等 Vue 渲染完再读取
        setDisguisedTitle("工作簿1");
        setDisguisedFooter("");

        function refreshTitleFromDOM() {
            const chapterTitle = $('.readerTopBar_title_chapter').text().trim();
            const bookTitle = $('.readerTopBar_title_link').text().trim();
            if (chapterTitle) setDisguisedTitle(chapterTitle);
            if (bookTitle) setDisguisedFooter(`《${bookTitle}》`);
            printLog(`刷新标题: 章节="${chapterTitle}", 书名="${bookTitle}"`);
        }

        // 把 phase 1 抓到的字符列表 (按 y, x 聚类成行) 追加到 canvas rowspan 之后.
        // 这样 Ctrl+F 可以搜到完整正文, 同时不影响 canvas 显示的真实视觉.
        // 老板键 R 隐藏 .disguised-content-cell 也会一起隐藏文字行.
        function appendCachedText(chars) {
            if (!chars || chars.length === 0) {
                printLog('warn', '没有缓存文字可追加 (phase 1 没抓到, 或缓存为空)');
                return;
            }
            const sorted = chars.slice().sort(function (a, b) {
                if (Math.abs(a.y - b.y) < 5) return a.x - b.x;
                return a.y - b.y;
            });
            const lines = [];
            let cur = [sorted[0]];
            for (let i = 1; i < sorted.length; i++) {
                if (Math.abs(sorted[i].y - cur[0].y) < 5) {
                    cur.push(sorted[i]);
                } else {
                    lines.push(cur.map(function (c) { return c.text; }).join(''));
                    cur = [sorted[i]];
                }
            }
            if (cur.length) lines.push(cur.map(function (c) { return c.text; }).join(''));
            setExcelLines(lines, true);
            printLog(`已追加 ${lines.length} 行缓存文字到 excel`);
        }

        waitForCanvas(15000, function ($container, canvasTotalHeight, canvasPaintedHeight) {
            // canvas 就绪 = Vue 渲染完成, 此时读标题最稳
            refreshTitleFromDOM();
            const rowHeight = 22;
            const scale = config.wereadCanvasScale || 1;
            // 用实际绘制覆盖高度而非容器声明高度 — 后者会留下大段空白下不去看见文字.
            // 实际绘制不到时回退到容器高度避免裁剪.
            const effectiveCanvasHeight = canvasPaintedHeight > 100 ? canvasPaintedHeight : canvasTotalHeight;
            const scaledCanvasHeight = Math.ceil(effectiveCanvasHeight * scale);
            const canvasRowSpan = Math.max(5, Math.ceil(scaledCanvasHeight / rowHeight));

            const $tbody = $(".excel-table > tbody");
            $tbody.empty();
            resetBigChartState();
            insertTitleRow();

            // 读取容器原始宽度 (微信读书固定 798), 准备缩放
            const origStyleAttr = $container.attr('style') || '';
            const widthMatch = origStyleAttr.match(/width:\s*([\d.]+)px/i);
            const origWidth = widthMatch ? parseInt(widthMatch[1]) : 798;
            const scaledWidth = Math.ceil(origWidth * scale);

            const $detachedContainer = $container.detach();

            // 用 wrapper 提供新的布局盒子, 内部 canvas 容器靠 transform 缩放
            const $scaleWrapper = $('<div class="weread-canvas-scale-wrapper"></div>').css({
                width: scaledWidth + 'px',
                height: scaledCanvasHeight + 'px',
                overflow: 'hidden',
                position: 'relative'
            });
            $detachedContainer.css({
                transform: `scale(${scale})`,
                'transform-origin': 'top left',
                position: 'absolute',
                top: '0',
                left: '0'
            });
            $scaleWrapper.append($detachedContainer);

            const $firstRow = $('<tr></tr>');
            $firstRow.append($('<td></td>').text(1));
            const $canvasCell = $('<td class="weread-canvas-cell disguised-content-cell"></td>').attr('rowspan', canvasRowSpan);
            $scaleWrapper.appendTo($canvasCell);
            $firstRow.append($canvasCell);
            appendEmptyColsForRow($firstRow);
            $tbody.append($firstRow);

            for (let r = 2; r <= canvasRowSpan; r++) {
                const $tr = $('<tr></tr>');
                $tr.append($('<td></td>').text(r));
                appendEmptyColsForRow($tr);
                $tbody.append($tr);
            }

            // 用缓存的字符在 canvas 下方追加文字行 (供 Ctrl+F 搜索), 然后再画 nav 行
            try {
                appendCachedText(cache && cache.chars);
            } catch (e) {
                printLog('warn', '追加缓存文字失败 (不影响 canvas 部分): ' + e.message);
            }
            buildNavRow($tbody, getExcelLastIndex() + 1);

            // 章节切换检测: 多路触发, 任意一路命中就 reload, phase 1 重新抓取.
            // 1) 键盘左右方向键 = weread 内置上一章/下一章快捷键
            // 2) URL 变化 (popstate / hashchange / pushState polling)
            // 3) DOM 出现新的 wr_canvasContainer (兜底, 比如点 nav 按钮触发的)
            let reloadScheduled = false;
            function scheduleReload(reason) {
                if (reloadScheduled) return;
                reloadScheduled = true;
                printLog(`检测到章节切换 (${reason}), 刷新页面重新抓取文字`);
                setTimeout(function () { location.reload(); }, 200);
            }

            const onArrowKey = function (event) {
                if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
                    const tag = (event.target && event.target.tagName) || '';
                    if (tag === 'INPUT' || tag === 'TEXTAREA' || (event.target && event.target.isContentEditable)) return;
                    scheduleReload('方向键 ' + event.key);
                }
            };
            document.addEventListener('keydown', onArrowKey, true);

            const initialHref = location.href;
            window.addEventListener('popstate', function () {
                if (location.href !== initialHref) scheduleReload('popstate');
            });
            window.addEventListener('hashchange', function () {
                if (location.href !== initialHref) scheduleReload('hashchange');
            });
            // pushState/replaceState 不触发任何事件, 只能轮询比较 href
            const hrefPoll = setInterval(function () {
                if (reloadScheduled) { clearInterval(hrefPoll); return; }
                if (location.href !== initialHref) scheduleReload('href poll');
            }, 500);

            const reRenderObserver = new MutationObserver(function () {
                const $newContainer = $('.app_content .wr_canvasContainer').not($canvasCell.find('.wr_canvasContainer'));
                if ($newContainer.length) {
                    const styleAttr = $newContainer.attr('style') || '';
                    const heightMatch = styleAttr.match(/height:\s*([\d.]+)px/i);
                    const newHeight = heightMatch ? parseInt(heightMatch[1]) : 0;
                    if (newHeight > 100) {
                        scheduleReload('新 canvasContainer');
                    }
                }
            });
            reRenderObserver.observe(document.body, {childList: true, subtree: true});
        }, function () {
            const $tbody = $(".excel-table > tbody");
            $tbody.empty();
            resetBigChartState();
            insertTitleRow();
            const $errRow = $('<tr></tr>');
            $errRow.append($('<td></td>').text(1));
            $errRow.append($('<td style="color:#c33;padding:10px !important;">canvas 加载超时, 请刷新页面重试. 如多次失败, 检查 F12 控制台日志.</td>'));
            for (let i = 0; i < config.emptyCols; i++) {
                $errRow.append($('<td></td>'));
            }
            $tbody.append($errRow);
            buildNavRow($tbody, 2);
        });
    }

    /**
     * 微信读书 phase 1: 在原生页面累积抓取 .wr_absolute[class*="ccn-"] span 的字符,
     * 不调用 common() (否则伪装层会把 #app 推离视口, weread 探测高度异常会停止渲染),
     * 仅用全屏白色遮罩覆盖原生页面避免暴露阅读内容.
     *
     * 这些 span 是 weread 渲染流水线里的 transient char: 摆好位置 → canvas 画 → span 销毁.
     * 必须在销毁前用 MutationObserver 持续累积; 等 canvas 一旦画完去查 DOM 就是 0 个.
     *
     * 抓完后 sessionStorage 写一次性 payload + location.reload() 进入 phase 2.
     */
    function wereadHarvestPhase() {
        printLog('phase 1: 在原生页面抓取 ccn-* 文字, 完成后 reload 进入伪装模式');

        // (x, y, char) 累积去重. key = "x_y_char" 避免重复采集同一个 span.
        // 提前到函数最顶端创建 + 挂 observer, 哪怕一行 mask DOM op 也不能比它先,
        // 否则 weread 第一批同步 append+remove span 流就漏抓了.
        const charMap = new Map();

        function captureSpan(span) {
            const tf = (span.style && span.style.transform) || '';
            const m = tf.match(/translate\(\s*(-?[\d.]+)px[,\s]+(-?[\d.]+)px/);
            if (!m) return;
            const x = parseFloat(m[1]);
            const y = parseFloat(m[2]);
            const text = (span.textContent || '');
            if (!text) return;
            const key = x.toFixed(1) + '_' + y.toFixed(1) + '_' + text;
            if (!charMap.has(key)) charMap.set(key, { x: x, y: y, text: text });
        }

        // 处理一个 mutation 涉及到的节点:
        //  - element: 自身或子树命中 ccn-* 就抓 (覆盖 addedNodes 路径)
        //  - text node: 走 parentElement 找 span (覆盖 characterData 路径,
        //    weread 可能复用 span 改写 textContent)
        function processNode(node) {
            if (!node) return;
            if (node.nodeType === 3) {
                node = node.parentElement;
                if (!node) return;
            }
            if (node.nodeType !== 1) return;
            if (node.matches && node.matches('.wr_absolute[class*="ccn-"]')) {
                captureSpan(node);
            }
            if (node.querySelectorAll) {
                const nested = node.querySelectorAll('.wr_absolute[class*="ccn-"]');
                for (let i = 0; i < nested.length; i++) captureSpan(nested[i]);
            }
        }

        // 兜底: 扫一次当前 DOM (节点池复用、首次进入时已存在的 span 等)
        function harvestOnce() {
            const spans = document.querySelectorAll('.wr_absolute[class*="ccn-"]');
            for (let i = 0; i < spans.length; i++) captureSpan(spans[i]);
        }

        // 从 MutationRecord 直接读 addedNodes — 这是关键: 哪怕 span 已被同步移除,
        // record 仍引用着原 DOM 对象, transform/textContent 完整可读.
        // 同时观察 attribute/characterData 变化, 兜底 weread 复用同一 span 改写内容的情况.
        const mo = new MutationObserver(function (mutations) {
            for (let i = 0; i < mutations.length; i++) {
                const mut = mutations[i];
                if (mut.type === 'childList' && mut.addedNodes) {
                    for (let j = 0; j < mut.addedNodes.length; j++) {
                        processNode(mut.addedNodes[j]);
                    }
                } else if (mut.target) {
                    processNode(mut.target);
                }
            }
        });
        mo.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class'],
            characterData: true,
            characterDataOldValue: false
        });
        harvestOnce();

        // 撑大 innerHeight 到 50000 (weread 只在 y < innerHeight 内生成 span,
        // 实测一章 y 可达 8000+; 给 50000 余量足够), 强制一次画完整章
        try {
            Object.defineProperty(window, 'innerHeight', {
                configurable: true,
                get: function () { return 50000; }
            });
            printLog('phase 1: 已覆盖 window.innerHeight=50000');
        } catch (e) {
            printLog('warn', 'phase 1: 覆盖 innerHeight 失败 ' + e.message);
        }

        // 全屏白色遮罩 + "文档打开中" 文字, 盖住原生页面避免泄露
        const $mask = $(`
            <div id="nd-harvest-mask" style="
                position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
                background: #FFF; z-index: 999999;
                display: flex; align-items: center; justify-content: center;
                font-family: 'Microsoft YaHei', sans-serif; color: #444; font-size: 16px;
                user-select: none;
            ">
                <div style="text-align: center;">
                    <div style="font-size: 48px; margin-bottom: 16px;">📄</div>
                    <div id="nd-harvest-status" style="font-weight: bold;">文档打开中</div>
                    <div id="nd-harvest-detail" style="font-size: 12px; color: #999; margin-top: 8px;"></div>
                </div>
            </div>
        `);
        $mask.appendTo('body');
        const $detail = $mask.find('#nd-harvest-detail');

        document.title = '工作簿1';

        let lastSize = 0;
        let stableCount = 0;
        let pollAttempts = 0;
        let noSpanCount = 0;             // 连续抓不到 ccn-* span 的次数
        const maxAttempts = 150;          // 150 * 200ms = 30s 上限 (scroll sweep 需要时间)
        const stableThreshold = 8;        // 连续 8 次 (1.6s) 不增长 = 稳定
        // 早退条件: sweep 走完后还连续 5 次 (1s) 完全抓不到任何 ccn-* span,
        // 说明 weread 这一章用纯 canvas 渲染, 不需要文字层, 直接进入伪装模式.
        const noSpanThreshold = 5;

        // weread 用 IntersectionObserver 按 passage-wrapper 分批渲染 span (即使 innerHeight=50000
        // 也只覆盖 window.innerHeight, viewport clientHeight 没被骗到), 必须扫一遍滚动才能触发全章渲染.
        // sweep: 每 200ms 滚 800px, 直到底部. 期间 mo + interval 同步累积字符.
        let sweepDone = false;
        let sweepY = 0;
        function performScrollSweep() {
            // weread 滚的是 .readerContent / window 还是某个内部容器, 实测 window 滚就能触发
            const docH = Math.max(
                document.documentElement.scrollHeight,
                document.body.scrollHeight
            );
            sweepY += 800;
            window.scrollTo(0, sweepY);
            // 也对常见容器 dispatch (兜底)
            const $reader = $('.readerContent, #routerView, #app');
            $reader.each(function () { this.scrollTop = sweepY; });
            if (sweepY >= docH + 1000) {
                sweepDone = true;
                window.scrollTo(0, 0);
                printLog(`phase 1: scroll sweep 完成, docH=${docH}px`);
            }
        }
        const sweepTimer = setInterval(function () {
            if (!sweepDone) performScrollSweep();
        }, 200);

        const timer = setInterval(function () {
            pollAttempts++;
            harvestOnce();
            const size = charMap.size;
            $detail.text(`已采集 ${size} 字 · 第 ${pollAttempts}/${maxAttempts} 次`);

            if (size === lastSize && size > 0) {
                stableCount++;
            } else {
                stableCount = 0;
            }
            lastSize = size;

            // 当前 DOM 里完全没有 ccn-* span 时计数, 累积到阈值就早退
            // (注意是看实时 DOM, 不是 charMap.size — 防止"曾经抓到过几个又消失"误判)
            const liveCount = document.querySelectorAll('.wr_absolute[class*="ccn-"]').length;
            if (liveCount === 0) noSpanCount++; else noSpanCount = 0;

            if (pollAttempts === 1 || pollAttempts % 5 === 0) {
                printLog(`harvest: 已抓 ${size} 字, stable=${stableCount}, live=${liveCount}, attempt=${pollAttempts}`);
            }

            // 早退: sweep 走完 + 连续多次完全没有 ccn-* span + charMap 为空
            //   → weread 这一章纯 canvas 没文字层, 不浪费时间继续轮询
            const earlyExit = sweepDone && size === 0 && noSpanCount >= noSpanThreshold;
            // 在认定稳定前先确保 scroll sweep 已经走完, 否则会在 sweep 中途的某个停顿期误判稳定
            const stable = size > 0 && stableCount >= stableThreshold && sweepDone;
            const timeout = pollAttempts >= maxAttempts;
            if (!stable && !timeout && !earlyExit) return;

            clearInterval(timer);
            clearInterval(sweepTimer);
            mo.disconnect();

            const chapterTitle = ($('.readerTopBar_title_chapter').text() || '').trim();
            const bookTitle = ($('.readerTopBar_title_link').text() || '').trim();
            const chars = Array.from(charMap.values());

            if (chars.length === 0) {
                if (earlyExit) {
                    printLog(`phase 1 早退: 该章节没有 ccn-* span (纯 canvas 无文字层), 直接进入伪装模式`);
                } else {
                    printLog('error', `harvest 失败: 抓到 0 字 (timeout=${timeout}). 直接进入伪装模式 (无文字层)`);
                }
                $mask.remove();
                common();
                weread(null);
                return;
            }

            printLog(`harvest 完成: ${chars.length} 字 (stable=${stable}, timeout=${timeout}), 写缓存并 reload`);
            writeWereadCache({
                chars: chars,
                chapterTitle: chapterTitle,
                bookTitle: bookTitle
            });
            $detail.text(`采集完成 ${chars.length} 字, 即将打开文档…`);
            setTimeout(function () { location.reload(); }, 200);
        }, 200);
    }

    ///////////////////////////// 站点结束

    // E 键切换原始界面
    document.addEventListener('keydown', function (event) {
        if (event.key === 'e' && !event.ctrlKey && !event.altKey && !event.metaKey) {
            if (config.mode === DICT.MODE.ORIGINAL) {
                applyMode(config.lastVisibleMode);
            } else {
                applyMode(DICT.MODE.ORIGINAL);
            }
        }
    });

    // 老板键 R: 切换正文列 (A列) 的可见性, 起点/番茄/微信读书通用
    // 通过 body 上的 class 控制, 动态新增的行也会自动生效.
    // 用 .disguised-content-cell 而不是 nth-child(2) -- 微信读书 canvas 的 rowspan 会让
    // 后续行的 nth-child(2) 错位指向右侧 B 列假数据格.
    GM_addStyle(`
        body.boss-mode .excel-table > tbody > tr > td.disguised-content-cell,
        body.boss-mode .excel-table > tbody > tr > td.disguised-content-cell * {
            visibility: hidden !important;
        }
    `);
    document.addEventListener('keydown', function (event) {
        if (event.key !== 'r' || event.ctrlKey || event.altKey || event.metaKey) return;
        const tag = (event.target && event.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (event.target && event.target.isContentEditable)) return;
        const hidden = document.body.classList.toggle('boss-mode');
        printLog(`老板键 R: 正文列 ${hidden ? '已隐藏' : '已显示'}`);
    });

    // 原始模式: 仅提示按 E 开启
    if (config.mode === DICT.MODE.ORIGINAL) {
        GM_addStyle(`
        .nd-switch-indicator {
            position: fixed;
            top: 10px;
            right: 10px;
            display: flex;
            flex-direction: row;
            align-items: center;
            height: auto;
            padding: 2rem;
            border-radius: 1rem;
            background: rgba(255, 255, 255, 0.6);
            -webkit-backdrop-filter: blur(10px);
            backdrop-filter: blur(10px);
            color: black;
            font-size: 14px;
        }

        .nd-switch-key {
            border: solid 1px black;
            border-radius: 8px;
            width: 1.5rem;
            height: 1.5rem;
            display: flex;
            justify-content: center;
            align-items: center;
            margin: 0 5px;
        }
        `);
        const $indicator = $(`<div class="nd-switch-indicator">按<div class="nd-switch-key">E</div>键开启伪装</div>`);
        $indicator.appendTo(document.body);
        GM_registerMenuCommand("设置", settings);
        return;
    }

    // main: 仅适配起点和番茄
    const currentHost = window.location.host;
    printLog('currentHost', currentHost);

    switch (currentHost) {
        case 'www.qidian.com':
            common();
            qidian();
            break;
        case 'fanqienovel.com':
            common();
            fanqie();
            break;
        case 'weread.qq.com': {
            // 两阶段流程:
            //   miss -> phase 1: 不调 common(), 在原生页面遮罩 + 抓 ccn-* span -> 写缓存 -> reload
            //   hit  -> phase 2: common() + weread(cache), canvas 显示 + 缓存文字行追加
            const wereadCache = readWereadCache();
            if (wereadCache && wereadCache.chars && wereadCache.chars.length > 0) {
                printLog(`命中文字缓存 (${wereadCache.chars.length} 字), 直接进入伪装模式`);
                common();
                weread(wereadCache);
            } else {
                printLog('未命中文字缓存, 进入 phase 1: 在原生页面抓取文字');
                wereadHarvestPhase();
            }
            break;
        }
        default:
            printLog("error", "当前站点未适配 (本精简版仅支持起点/番茄/微信读书)");
    }

    GM_registerMenuCommand("设置", settings);

    printLog("novel-disguise(mini) 载入完成");
})();

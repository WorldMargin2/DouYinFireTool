// ==UserScript==
// @name         抖音火花助手
// @namespace    http://tampermonkey.net/
// @version      1.0.1
// @description  自动抓取聊天列表到暂存，支持将对象添加为续火花目标、每对象模板、$date/$targetName/$sinceDate()、简单条件语句。参考 fire.js 的选择器与发送逻辑。
// @author       WorldMargin
// @match        https://creator.douyin.com/creator-micro/data/following/chat
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @grant        GM_addStyle
// @homepage   				https://github.com/WordlMargin/DouyinFireTool
// @source     				https://github.com/WordlMargin/DouyinFireTool/抖音火花助手.js
// ==/UserScript==

(function() {
    'use strict';

    const DEFAULT_TEMPLATE='res= \`自动续火花-$date\n$targetName\`';

    // 创建命名空间
    window.DyFireScript = window.DyFireScript || {};
    // 预处理变量函数，用于替换编辑器中的变量
    function preprocessVariables(code, targetName) {
        let processedCode = code;
        
        // 替换$targetName为实际目标名称
        processedCode = processedCode.replace(/\$targetName/g, `${targetName}`);
        
        // 替换$date为当前日期
        processedCode = processedCode.replace(/\$date/g, `${new Date().toLocaleDateString()}`);
        
        // 处理$sinceDate函数，将其转换为实际的天数
        processedCode = processedCode.replace(/\$sinceDate\(\s*["\']([^"\']+)["\']\s*\)/g, (_, dateStr) => {
            const days = daysSince(dateStr);
            return days;
        });
        
        return processedCode;
    }
    
    // 计算天数差
    function daysSince(dateStr) {
        try {
            const d = new Date(dateStr);
            if (isNaN(d)) return 0;
            const now = new Date();
            const diff = now - d;
            return Math.floor(diff / (1000 * 60 * 60 * 24));
        } catch (e) {
            return 0;
        }
    }


    // 存储键
    const KEY_PERSIST = 'dy_fire_persistent_targets_v1';
    const KEY_MACROS = 'dy_fire_macros_v1';

    const SELECTORS = {
        userName: '.item-header-name-vL_79m',
        chatInput: '.chat-input-dccKiL',
        sendBtn: '.chat-btn',
    };

    // 内存数据
    let staged = []; // 暂存数组 of {name}
    let persistent = {}; // { name: { template: string, macros: [], lastSendDate: string } }
    let activeEdit = null; // 当前编辑对象名
    let selectedSet = new Set(); // 选中用于批量发送的名字
    let macros = {}; // { name: { code: string, enabled: boolean, description: string } }

    const KEY_SETTINGS = 'dy_fire_settings_v1';
    let settings = {
        schedulerTime: '', // 'HH:MM'
        sendIntervalSec: 3,
        autoEnabled: false,
        sendMode: 'scheduled', // 'scheduled' or 'automatic'
        theme: 'dark'
    };
    let schedulerTimer = null;
    let lastScheduledRun = '';

    function loadPersistent() {
        const raw = GM_getValue(KEY_PERSIST, '{}');
        try {
            persistent = typeof raw === 'string' ? JSON.parse(raw) : raw;

            // Ensure all templates have the macros array and lastSendDate for backward compatibility
            for (const [name, templateData] of Object.entries(persistent)) {
                if (!templateData.macros) {
                    templateData.macros = [];
                }
                if (!templateData.lastSendDate) {
                    templateData.lastSendDate = '';
                }
            }
        } catch (e) {
            persistent = {};
        }
    }



    // 注入样式表（一次）
    function injectStyles() {
        if (document.getElementById('dy-fire-styles')) return;
        let css = `
            .dy-panel { position: fixed; z-index: 9999; font-family: Microsoft YaHei; }
            .dy-panel .dy-root { width: 540px; background: linear-gradient(180deg,#1c1c22, #141418); color: #fff; border-radius:12px; padding:14px; box-shadow: 0 20px 50px rgba(0,0,0,0.6); position:relative }
            .dy-panel.dy-theme-light .dy-root { background: linear-gradient(180deg,#ffffff,#f3f4f6); color:#111 }
            .dy-panel .dy-header{ display:flex; justify-content:space-between; align-items:center; margin-bottom:8px }
            .dy-panel .dy-header strong{ font-size:16px }
            .dy-panel .dy-controls{ display:flex; gap:8px; align-items:center }
            .dy-panel .dy-body{ display:flex; gap:10px; flex-wrap:wrap }
            .dy-panel .dy-column{ flex:1; background:rgba(255,255,255,0.03); padding:8px; border-radius:6px; max-height:300px; overflow:visible; min-width:220px; max-width:calc(50% - 10px) }
            /* 面板自适应窗口，防止整体溢出 */
            .dy-panel .dy-root{ max-width: calc(100vw - 40px); max-height: calc(100vh - 40px); box-sizing: border-box; overflow:auto }
            @media (max-width: 640px) {
                .dy-panel .dy-body{ flex-direction:column }
                .dy-panel .dy-column{ max-width:100% }
                .dy-panel .dy-controls{ flex-wrap:wrap }
            }
            .dy-panel .dy-title{ font-size:12px; color:#bbb; margin-bottom:6px }
            .dy-panel .dy-select-all{ margin-bottom:6px }
            .dy-panel .dy-btn{ background: linear-gradient(90deg,#ff6b8b,#ff2c54); border:none; color:#fff; padding:6px 8px; height:30px; line-height:18px; border-radius:8px; cursor:pointer; font-size:13px; box-shadow:0 6px 18px rgba(255,44,84,0.12); }
            .dy-panel .dy-btn-light{ background: linear-gradient(90deg,#4b5563,#374151);
                color:#fff }
            .dy-panel .dy-btn-add{ background: linear-gradient(90deg,#2dd4bf,#06b6d4); }
            .dy-panel .dy-btn-send{ background: linear-gradient(90deg,#10b981,#059669); }
            .dy-panel .dy-btn-remove{ background: linear-gradient(90deg,#f97316,#ef4444); }
            .dy-panel .dy-btn-macro{ background: linear-gradient(90deg,#8b5cf6,#7c3aed); }
            .dy-panel input, .dy-panel textarea{ background:#0f1114; border:1px solid rgba(255,255,255,0.06); color:#e6eef8; padding:6px 8px; border-radius:6px; font-size:13px }
            .dy-panel .dy-list{ padding:6px; margin:0; list-style:none; max-height:40vh; overflow:auto; border-top:1px solid rgba(255,255,255,0.04); }
            /* 底部设置横向占满（避免全局竖向滚动） */
            .dy-panel .dy-settings-bottom{ width:100%; display:flex; gap:10px; flex-wrap:wrap; align-items:flex-start; justify-content:flex-start; padding:6px 6px; border-top:1px solid rgba(255,255,255,0.03); box-sizing:border-box }
            .dy-panel .dy-settings-bottom .dy-settings-row{ display:flex; gap:8px; align-items:center; flex:0 0 auto; height:30px }
            .dy-panel .dy-settings-bottom label{ font-size:12px; min-width:80px }
            .dy-panel .dy-settings-bottom input[type=time], .dy-panel .dy-settings-bottom input[type=number]{ height:26px; padding:2px 6px; font-size:13px }
            .dy-panel .dy-settings-bottom .dy-btn{ padding:4px 8px; height:28px; font-size:13px }
            .dy-panel .dy-settings-bottom .dy-status{ font-size:12px; color:inherit }
            @media (max-width:640px){ .dy-panel .dy-settings-bottom{ flex-direction:column; align-items:stretch } .dy-panel .dy-settings-bottom .dy-settings-row{ width:100%; justify-content:space-between } }
            .dy-panel .dy-item{ display:block; padding:8px 6px; border-radius:6px; margin-bottom:8px; background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.02)); border:1px solid rgba(255,255,255,0.03); }
            .dy-panel .dy-item + .dy-item{ margin-top:6px }
            .dy-panel .dy-item .dy-item-top{ display:block; font-size:13px; color:#e6eef8; white-space:normal; overflow:hidden; text-overflow:ellipsis; max-height:3.2em }
            .dy-panel.dy-theme-light .dy-item .dy-item-top{ color:#111 }
            .dy-panel .dy-item-name{ color:inherit }
            .dy-panel.dy-theme-light .dy-item-name{ color:#111 }
            .dy-panel .dy-item .dy-item-actions{ display:flex; gap:6px; margin-top:8px; justify-content:flex-end }
            .dy-panel .dy-item label{ display:inline-flex; align-items:center; gap:8px }
            .dy-panel .dy-resizer{ width:14px;height:14px; position:absolute; right:6px; bottom:6px; cursor:se-resize; border-radius:3px; background:linear-gradient(135deg, rgba(255,255,255,0.06), rgba(0,0,0,0.06)); }
            .dy-panel .dy-template-editor{ margin-top:8px; background:rgba(0,0,0,0.15); padding:8px; border-radius:6px }
            .dy-panel .dy-tpl-desc{ font-size:12px; color:#ddd; margin-bottom:6px }
            /* 宏管理面板样式 */
            .dy-panel .dy-macro-panel { display: none; }
            .dy-panel .dy-macro-panel.active { display: block; }
            .dy-panel .dy-macro-body { display: flex; gap: 10px; }
            .dy-panel .dy-macro-column { flex: 1; background: rgba(255,255,255,0.03); padding: 8px; border-radius: 6px; max-height: 400px; overflow: auto; min-width: 250px; }
            .dy-panel .dy-macro-column.manage-macros { border-right: 2px solid rgba(255,255,255,0.1); }
            .dy-panel .dy-macro-column.apply-macros { border-left: 2px solid rgba(255,255,255,0.1); }
            .dy-panel .dy-macro-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
            .dy-panel .dy-macro-title { font-size: 14px; font-weight: bold; color: #e6eef8; }
            .dy-panel .dy-macro-item { padding: 8px; margin-bottom: 6px; background: rgba(0,0,0,0.2); border-radius: 4px; border: 1px solid rgba(255,255,255,0.1); }
            .dy-panel .dy-macro-item.enabled { border-left: 3px solid #10b981; }
            .dy-panel .dy-macro-item.disabled { border-left: 3px solid #ef4444; opacity: 0.7; }
            .dy-panel .dy-macro-item-name { font-weight: bold; margin-bottom: 4px; }
            .dy-panel .dy-macro-item-desc { font-size: 12px; color: #aaa; margin-bottom: 6px; }
            .dy-panel .dy-macro-item-code { font-family: monospace; font-size: 11px; background: rgba(0,0,0,0.3); padding: 4px; border-radius: 3px; overflow: auto; max-height: 60px; }
            .dy-panel .dy-macro-actions { display: flex; gap: 4px; margin-top: 6px; }
            .dy-panel .dy-macro-toggle { padding: 4px 6px; font-size: 11px; }
            .dy-panel .dy-macro-edit { padding: 4px 6px; font-size: 11px; }
            .dy-panel .dy-macro-delete { padding: 4px 6px; font-size: 11px; }
            .dy-panel .dy-macro-form { margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; }
            .dy-panel .dy-macro-form input, .dy-panel .dy-macro-form textarea { width: 100%; box-sizing: border-box; margin-bottom: 6px; }
            .dy-panel .dy-macro-form textarea { min-height: 80px; }
            .dy-panel .dy-macro-form-buttons { text-align: right; }
            .dy-panel .dy-macro-select { width: 100%; padding: 6px; border-radius: 6px; background: #0f1114; border: 1px solid rgba(255,255,255,0.06); color: #e6eef8; }
            .dy-panel .dy-macro-assign-btn { background: linear-gradient(90deg,#8b5cf6,#7c3aed); width: 100%; margin-top: 4px; }
            .dy-panel .dy-macro-clear-btn { background: linear-gradient(90deg,#f97316,#ef4444); width: 100%; margin-top: 4px; }
            /* 模态模板编辑器 */
            #dy-template-modal { position: fixed; left: 0; top: 0; right: 0; bottom: 0; display: none; z-index: 10000; }
            #dy-template-modal .dy-tpl-overlay { position: absolute; left:0;top:0;right:0;bottom:0; background: rgba(0,0,0,0.45); display:flex; align-items:center; justify-content:center; padding:20px; transition: opacity 200ms ease; }
            #dy-template-modal .dy-tpl-box { width: min(900px, 96%); background: linear-gradient(180deg,#0f1114,#09090a); color:#fff; border-radius:10px; padding:12px; box-shadow:0 14px 50px rgba(0,0,0,0.6); max-height:90vh; overflow:auto; transition: all 0.3s ease; }
            #dy-template-modal .dy-tpl-box.dy-fullscreen { width: 100%; height: 100%; max-width: 100%; max-height: 100%; border-radius: 0; display: flex; flex-direction: column; }
            #dy-template-modal .dy-tpl-box.dy-fullscreen .dy-tpl-box-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
            #dy-template-modal .dy-tpl-box.dy-fullscreen .monaco-container { flex: 1; min-height: 200px; }
            #dy-template-modal .dy-tpl-box.dy-fullscreen .dy-tpl-preview { max-height: 150px; }
            #dy-template-modal .dy-tpl-box.dy-fullscreen .dy-tpl-box-foot { position: sticky; bottom: 0; background: inherit; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); }
            #dy-template-modal .dy-tpl-box-controls { display: flex; gap: 8px; }
            #dy-template-modal .dy-tpl-fullscreen { font-size: 14px; padding: 6px 10px; }
            #dy-template-modal.dy-theme-light .dy-tpl-box { background: #fff; color:#111 }
            #dy-template-modal .dy-tpl-box-header{ display:flex; justify-content:space-between; align-items:center; margin-bottom:8px }
            #dy-template-modal textarea{ width:100%; box-sizing:border-box; min-height:120px; max-height:60vh; resize:vertical; padding:8px; border-radius:6px; font-size:13px; font-family: Consolas, "Courier New", monospace }
            #dy-template-modal .dy-tpl-box-body{ margin-bottom:8px }
            #dy-template-modal .dy-tpl-box-foot{ text-align:right }
            #dy-template-modal .dy-tpl-desc{ font-size:13px; color: #cfd8e3 }
            #dy-template-modal .dy-tpl-syntax{ display:flex; gap:8px; flex-wrap:wrap; margin:8px 0 6px }
            #dy-template-modal .dy-tpl-syntax button{ background: rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.04); color:inherit; padding:6px 8px; border-radius:6px; cursor:pointer; font-size:13px }
            #dy-template-modal.dy-theme-light .dy-tpl-syntax button{ background: rgba(0,0,0,0.03); border:1px solid rgba(0,0,0,0.06) }
            #dy-template-modal .dy-tpl-preview{ margin-top:8px; padding:8px; background: rgba(0,0,0,0.06); border-radius:6px; font-family: Consolas, "Courier New", monospace; font-size:13px; color:#e6eef8; max-height:160px; overflow:auto }
            #dy-template-modal.dy-theme-light .dy-tpl-preview{ background:#f6f7f9; color:#111 }
            /* 设置定时发送等控件响应换行，避免溢出 */
            .dy-panel .dy-settings{ display:flex; flex-direction:column; gap:8px; padding-top:6px }
            .dy-panel .dy-settings-row{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px }
            .dy-panel .dy-settings-row label{ min-width:120px; flex: 0 0 auto }
            .dy-panel .dy-settings-row input[type=time], .dy-panel .dy-settings-row input[type=number]{ flex: 0 0 auto; min-width:60px; max-width:160px }
            .dy-panel .dy-settings-row .dy-status{ flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; }
            .dy-panel .dy-settings-row .dy-btn{ flex:0 0 auto; white-space:nowrap }
            .dy-panel .dy-settings{ max-width:100%; box-sizing:border-box; }
            .dy-panel.dy-theme-light .dy-template-editor{ background: rgba(0,0,0,0.04); }
            .dy-panel.dy-theme-light input, .dy-panel.dy-theme-light textarea{ background: #fff; border:1px solid rgba(0,0,0,0.08); color:#111 }
            .dy-panel.dy-theme-light .dy-btn{ color:#fff }
            /* 最小化时隐藏主体和 resizer，避免黑色矩形 */
            .dy-panel .dy-root.dy-minimized { height: auto; overflow: visible; background: transparent; box-shadow: none; padding:6px 10px }
            .dy-panel .dy-root.dy-minimized .dy-body, .dy-panel .dy-root.dy-minimized .dy-template-editor { display: none }
            .dy-panel .dy-root.dy-minimized .dy-resizer { display: none }
            /* 将列表与其它区域视觉切割 */
            .dy-panel .dy-column{ box-shadow: inset 0 1px 0 rgba(255,255,255,0.02); }
            /* CodeMirror 占位符高亮 */
            .cm-placeholder { background: rgba(255,235,59,0.08); color:#ffd54f; padding:0 2px; border-radius:3px }
            .dy-panel.dy-theme-light .cm-placeholder { background: rgba(16,24,32,0.04); color:#b45309 }
        `;
        // VSCode-like CodeMirror theme (dark/light) — minimal rules to mimic VSCode appearance
        css += `
            /* CodeMirror VSCode dark theme approximation */
            .cm-s-dy-vscode-dark .CodeMirror { background: #1e1e1e; color: #d4d4d4; font-family: Consolas, 'Courier New', monospace }
            .cm-s-dy-vscode-dark .CodeMirror-gutters { background: #252526; border-right: 1px solid #2a2a2a }
            .cm-s-dy-vscode-dark .CodeMirror-linenumber { color: #858585 }
            .cm-s-dy-vscode-dark .CodeMirror-selected { background: rgba(128, 203, 255, 0.12) }
            .cm-s-dy-vscode-dark .cm-placeholder { background: rgba(255,235,59,0.06); color:#ffd54f }
            .cm-s-dy-vscode-dark .cm-keyword { color: #569cd6 }
            .cm-s-dy-vscode-dark .cm-comment { color: #6a9955 }
            .cm-s-dy-vscode-dark .cm-string { color: #ce9178 }
            .n.cm-s-dy-vscode-dark .CodeMirror-cursor { border-left: 1px solid #aeafad }

            /* Light variant */
            .cm-s-dy-vscode-light .CodeMirror { background: #ffffff; color: #333333; font-family: Consolas, 'Courier New', monospace }
            .cm-s-dy-vscode-light .CodeMirror-gutters { background: #f3f3f3; border-right: 1px solid #e1e1e1 }
            .cm-s-dy-vscode-light .CodeMirror-linenumber { color: #888888 }
            .cm-s-dy-vscode-light .CodeMirror-selected { background: rgba(10, 132, 255, 0.08) }
            .cm-s-dy-vscode-light .cm-placeholder { background: rgba(16,24,32,0.04); color:#b45309 }
            .cm-s-dy-vscode-light .cm-keyword { color: #0000ff }
            .cm-s-dy-vscode-light .cm-comment { color: #008000 }
            .cm-s-dy-vscode-light .cm-string { color: #a31515 }
        `;
        const style = document.createElement('style');
        style.id = 'dy-fire-styles';
        style.innerHTML = css;
        document.head.appendChild(style);
    }

    // 允许拖动面板
    function makeDraggable(panel) {
        const root = panel.querySelector('.dy-root');
        if (!root) return;
        const header = root.querySelector('.dy-header');
        if (!header) return;
        let dragging = false, offsetX = 0, offsetY = 0;
        header.style.cursor = 'move';
        header.addEventListener('mousedown', (e) => {
            dragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            document.body.style.userSelect = 'none';
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            let x = e.clientX - offsetX;
            let y = e.clientY - offsetY;
            x = Math.max(0, Math.min(x, window.innerWidth - panel.offsetWidth));
            y = Math.max(0, Math.min(y, window.innerHeight - panel.offsetHeight));
            panel.style.left = x + 'px';
            panel.style.top = y + 'px';
            panel.style.right = 'auto';
            // 实时保存位置（节流）
            savePanelPositionThrottled(panel, x, y);
        });
        document.addEventListener('mouseup', () => { dragging = false; document.body.style.userSelect = ''; });
    }

    // 可调整大小
    function makeResizable(panel) {
        let resizer = panel.querySelector('.dy-resizer');
        if (!resizer) {
            resizer = document.createElement('div');
            resizer.className = 'dy-resizer';
            panel.appendChild(resizer);
        }
        let resizing = false, startW = 0, startH = 0, startX = 0, startY = 0;
        resizer.addEventListener('mousedown', (e) => {
            resizing = true;
            const rect = panel.getBoundingClientRect();
            startW = rect.width; startH = rect.height; startX = e.clientX; startY = e.clientY;
            document.body.style.userSelect = 'none';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!resizing) return;
            const dx = e.clientX - startX; const dy = e.clientY - startY;
            const newW = Math.max(320, Math.min(window.innerWidth - 40, startW + dx));
            const newH = Math.max(160, Math.min(window.innerHeight - 40, startH + dy));
            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
        });
        document.addEventListener('mouseup', () => { resizing = false; document.body.style.userSelect = '';
            // 保存尺寸
            try {
                const rect = panel.getBoundingClientRect();
                settings.panel = settings.panel || {};
                settings.panel.width = Math.round(Math.min(rect.width, window.innerWidth - 40));
                settings.panel.height = Math.round(Math.min(rect.height, window.innerHeight - 40));
                saveSettings();
            } catch (e) {}
        });
    }

    function toggleTheme() {
        // toggle between dark and light; if using vscode alias, preserve it with vscode-light/vscode-dark
        if (settings.theme === 'light' || settings.theme === 'vscode-light') settings.theme = 'dark';
        else if (settings.theme === 'vscode-dark') settings.theme = 'light';
        else settings.theme = settings.theme === 'dark' ? 'light' : 'dark';
        saveSettings();
        const panel = document.getElementById('dy-fire-new-panel');
        if (panel) {
            if (settings.theme === 'light' || settings.theme === 'vscode-light') panel.classList.add('dy-theme-light'); else panel.classList.remove('dy-theme-light');
        }
    }

    // 保存位置节流
    let _savePosTimer = null;
    function savePanelPositionThrottled(panel, left, top) {
        if (_savePosTimer) clearTimeout(_savePosTimer);
        _savePosTimer = setTimeout(() => {
            settings.panel = settings.panel || {};
            settings.panel.left = Math.round(left);
            settings.panel.top = Math.round(top);
            saveSettings();
        }, 300);
    }

    function toggleMinimize(panel) {
        const root = panel.querySelector('.dy-root');
        if (!root) return;
        const minimized = root.classList.toggle('dy-minimized');
        settings.panel = settings.panel || {};
        settings.panel.minimized = minimized;
        saveSettings();
        // 简单实现：隐藏 body 与 template-editor
        const body = root.querySelector('.dy-body');
        const tpl = root.querySelector('.dy-template-editor');
        const settingsEl = root.querySelector('.dy-settings');
        if (minimized) {
            if (body) body.style.display = 'none';
            if (tpl) tpl.style.display = 'none';
            if (settingsEl) settingsEl.style.display = 'none';
            // 关闭模态（如果打开）并隐藏整个面板可确保视觉最小化
            try { closeTemplateModal(); } catch (e) {}
            // 不再隐藏整个面板（避免用户误解为关闭），仅收缩为头部视图
        } else {
            if (body) body.style.display = '';
            if (tpl) tpl.style.display = 'none';
            if (settingsEl) settingsEl.style.display = '';
            // 保持 panel 可见
        }
    }

    // 监听并应用系统主题（如果启用）
    let _mq = null;
    function updateSystemThemeListener() {
        if (settings.followSystemTheme) {
            if (!_mq) _mq = window.matchMedia('(prefers-color-scheme: light)');
            const apply = () => {
                const panel = document.getElementById('dy-fire-new-panel');
                if (!panel) return;
                if (_mq.matches) { panel.classList.add('dy-theme-light'); settings.theme = 'light'; }
                else { panel.classList.remove('dy-theme-light'); settings.theme = 'dark'; }
            };
            _mq.addEventListener ? _mq.addEventListener('change', apply) : _mq.addListener(apply);
            apply();
        } else {
            if (_mq) {
                try { _mq.removeEventListener ? _mq.removeEventListener('change', null) : _mq.removeListener(null); } catch(e){}
                _mq = null;
            }
        }
    }

    function savePersistent() {
        // Ensure all templates have the macros array and lastSendDate before saving
        for (const [name, templateData] of Object.entries(persistent)) {
            if (!templateData.macros) {
                templateData.macros = [];
            }
            if (!templateData.lastSendDate) {
                templateData.lastSendDate = '';
            }
        }
        GM_setValue(KEY_PERSIST, JSON.stringify(persistent));
    }

    function loadMacros() {
        const raw = GM_getValue(KEY_MACROS, '{}');
        try {
            macros = typeof raw === 'string' ? JSON.parse(raw) : raw;

            // Ensure all macros have the enabled property for backward compatibility
            for (const [name, macroData] of Object.entries(macros)) {
                if (typeof macroData.enabled === 'undefined') {
                    macroData.enabled = true; // Default to enabled for backward compatibility
                }
            }
        } catch (e) {
            macros = {};
        }
    }

    function saveMacros() {
        GM_setValue(KEY_MACROS, JSON.stringify(macros));
    }

    function loadSettings() {
        const raw = GM_getValue(KEY_SETTINGS, null);
        if (raw) {
            try { settings = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) {}
        }
    }

    function saveSettings() {
        GM_setValue(KEY_SETTINGS, JSON.stringify(settings));
    }

    // 自动抓取聊天列表到暂存（不加入已为续火花目标的对象）
    function autoFetchChats() {
        const els = document.querySelectorAll(SELECTORS.userName);
        const names = [];
        els.forEach(el => {
            const name = el.textContent && el.textContent.trim();
            if (name) names.push(name);
        });

        let added = 0;
        names.forEach(name => {
            if (persistent[name]) return; // 已为续火花目标则忽略
            if (!staged.includes(name)) {
                staged.push(name);
                added++;
            }
        });

        if (added > 0) {
            renderPanel();
        }
    }

    // 渲染面板
    function renderPanel() {
        const existing = document.getElementById('dy-fire-new-panel');
        if (existing) existing.remove();

        const panel = document.createElement('div');
        panel.id = 'dy-fire-new-panel';
        // 基本位置/尺寸（可能由设置覆盖）
        panel.style.position = 'fixed';
        panel.style.zIndex = '9999';
        panel.style.fontFamily = 'Microsoft YaHei';

        panel.innerHTML = `
            <div class="dy-root">
                <div class="dy-header">
                    <strong>续火目标管理</strong>
                    <div class="dy-controls">
                        <button id="dy-fetch-chats" class="dy-btn dy-btn-light">抓取聊天</button>
                        <button id="dy-batch-send" class="dy-btn dy-btn-light">批量发送选中</button>
                        <button id="dy-macro-manager" class="dy-btn dy-btn-macro">宏管理</button>
                        <button id="dy-theme-toggle" class="dy-btn dy-btn-light">主题</button>
                        <button id="dy-minimize" class="dy-btn dy-btn-light">—</button>
                        <button id="dy-close-panel" class="dy-btn dy-btn-light">×</button>
                    </div>
                </div>
                <div class="dy-body">
                    <div class="dy-column dy-staged">
                        <div class="dy-title">暂存列表</div>
                        <div class="dy-select-all"><label><input type="checkbox" id="dy-select-all"/> 全选/反选</label></div>
                        <ul id="dy-staged-list" class="dy-list"></ul>
                    </div>
                    <div class="dy-column dy-persist">
                        <div class="dy-title">续火花目标</div>
                        <ul id="dy-persist-list" class="dy-list"></ul>
                    </div>
                </div>
                <div class="dy-settings dy-settings-bottom">
                    <div class="dy-settings-row">
                        <label>发送模式:</label>
                        <select id="dy-send-mode" style="width:120px">
                            <option value="scheduled">定时发送</option>
                            <option value="automatic">自动发送</option>
                        </select>
                    </div>
                    <div class="dy-settings-row" id="dy-schedule-time-row">
                        <label>定时发送 (每日 HH:MM):</label>
                        <input id="dy-schedule-time" type="time" />
                        <button id="dy-save-schedule" class="dy-btn">保存并启用</button>
                    </div>
                    <div class="dy-settings-row">
                        <label>每条间隔 (秒):</label>
                        <input id="dy-interval-sec" type="number" min="1" value="3" style="width:60px" />
                        <button id="dy-toggle-scheduler" class="dy-btn">启用定时</button>
                        <span id="dy-scheduler-status" class="dy-status"></span>
                    </div>
                    <div class="dy-settings-row">
                        <label><input id="dy-follow-system" type="checkbox" /> 跟随系统主题</label>
                    </div>
                </div>
                <div id="dy-template-editor" class="dy-template-editor" style="display:none">
                    <div class="dy-tpl-desc">为 <span id="dy-editor-target"></span> 编辑模板（支持 $date $targetName $sinceDate("YYYY-M-D") 和直接JavaScript代码）</div>
                    <textarea id="dy-editor-text"></textarea>
                    <div style="text-align:right;margin-top:6px"><button id="dy-save-template" class="dy-btn">保存模板</button></div>
                </div>
                <div class="dy-resizer" title="拖动调整大小"></div>
            </div>
        `;

        document.body.appendChild(panel);
        // 注入样式并设置 class
        injectStyles();
        panel.classList.add('dy-panel');
        const root = panel.firstElementChild;
        if (root) root.classList.add('dy-root');
        if (settings.theme === 'light') panel.classList.add('dy-theme-light');

        // 恢复保存的位置与大小
        if (settings.panel && typeof settings.panel === 'object') {
            if (settings.panel.left) panel.style.left = settings.panel.left + 'px';
            if (settings.panel.top) panel.style.top = settings.panel.top + 'px';
            if (settings.panel.width) panel.style.width = settings.panel.width + 'px';
            if (settings.panel.height) panel.style.height = settings.panel.height + 'px';
            if (settings.panel.minimized) root.classList.add('dy-minimized');
        } else {
            // 默认位置
            panel.style.right = '20px';
            panel.style.top = '60px';
            panel.style.width = '540px';
        }

        // 应用主题调色（兼容旧内联样式）
        applyTheme(panel);

        // 使面板可拖动与调整大小
        makeDraggable(panel);
        makeResizable(panel);

        // 创建并准备模板模态编辑器（全局仅一份）
        ensureTemplateModalExists();

            // 确保面板在视口内（首次渲染与窗口变化时）
            function ensurePanelInViewport() {
                try {
                    const rect = panel.getBoundingClientRect();
                    let changed = false;
                    let left = rect.left;
                    let top = rect.top;
                    const pad = 12;
                    const maxW = window.innerWidth - pad * 2;
                    const maxH = window.innerHeight - pad * 2;
                    // 限制宽高
                    if (panel.offsetWidth > maxW) { panel.style.width = Math.max(320, maxW) + 'px'; changed = true; }
                    if (panel.offsetHeight > maxH) { panel.style.height = Math.max(160, maxH) + 'px'; changed = true; }
                    // 修正位置
                    if (rect.right > window.innerWidth - pad) { left = Math.max(pad, window.innerWidth - pad - panel.offsetWidth); changed = true; }
                    if (rect.left < pad) { left = pad; changed = true; }
                    if (rect.top < pad) { top = pad; changed = true; }
                    if (rect.bottom > window.innerHeight - pad) { top = Math.max(pad, window.innerHeight - pad - panel.offsetHeight); changed = true; }
                    if (changed) {
                        panel.style.left = left + 'px';
                        panel.style.top = top + 'px';
                        panel.style.right = 'auto';
                    }
                } catch (e) {}
            }

            // 监听窗口变化，自动调整
            const _onWinResize = () => ensurePanelInViewport();
            window.addEventListener('resize', _onWinResize);
            // 在 panel 被移除时清理监听
            panel.addEventListener('remove', () => window.removeEventListener('resize', _onWinResize));

        // 事件绑定
        document.getElementById('dy-fetch-chats').addEventListener('click', () => { autoFetchChats(); });
        document.getElementById('dy-close-panel').addEventListener('click', () => panel.remove());
        const themeToggle = document.getElementById('dy-theme-toggle');
        if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
        const minBtn = document.getElementById('dy-minimize');
        if (minBtn) minBtn.addEventListener('click', () => toggleMinimize(panel));
        const macroManagerBtn = document.getElementById('dy-macro-manager');
        if (macroManagerBtn) macroManagerBtn.addEventListener('click', () => {
            openMacroManagerModal();
        });
        const followCb = document.getElementById('dy-follow-system');
        if (followCb) {
            followCb.checked = !!settings.followSystemTheme;
            followCb.addEventListener('change', (e) => {
                settings.followSystemTheme = !!e.target.checked; saveSettings();
                updateSystemThemeListener();
            });
        }

        // 根据保存的最小化状态应用初始显示（避免仅有 class 而未调整 display 的情况）
        try {
            const bodyEl = root.querySelector('.dy-body');
            const tplEl = root.querySelector('.dy-template-editor');
            const settingsEl = root.querySelector('.dy-settings');
            if (root.classList.contains('dy-minimized')) {
                if (bodyEl) bodyEl.style.display = 'none';
                if (tplEl) tplEl.style.display = 'none';
                if (settingsEl) settingsEl.style.display = 'none';
            } else {
                if (bodyEl) bodyEl.style.display = '';
                if (tplEl) tplEl.style.display = 'none';
                if (settingsEl) settingsEl.style.display = '';
            }
        } catch (e) {}

        renderLists();
    }

    // 为面板注入统一样式（美化）
    function applyTheme(panel) {
        try {
            // 根据面板主题应用不同配色，避免在浅色主题下文字对比不足
            const isLight = panel.classList.contains('dy-theme-light');

            panel.style.width = panel.style.width || '540px';
            panel.style.top = panel.style.top || '40px';
            panel.style.right = panel.style.right || '24px';
            panel.style.padding = panel.style.padding || '0';
            panel.style.borderRadius = panel.style.borderRadius || '14px';
            panel.style.overflow = panel.style.overflow || 'visible';
            panel.style.boxShadow = '0 20px 50px rgba(0,0,0,0.6)';

            const root = panel.firstElementChild;
            if (!root) return;
            root.style.padding = root.style.padding || '14px';
            root.style.borderRadius = root.style.borderRadius || '12px';

            const header = root.querySelector('strong');
            if (header) {
                header.style.fontSize = '16px';
                header.style.letterSpacing = '0.2px';
                header.style.color = isLight ? '#111' : '#fff';
            }

            // 按钮样式（浅色主题使用偏暗底色以保证文字可读）
            const buttons = root.querySelectorAll('button');
            buttons.forEach(btn => {
                if (isLight) {
                    btn.style.background = 'linear-gradient(90deg,#374151,#4b5563)';
                    btn.style.border = '1px solid rgba(0,0,0,0.06)';
                } else {
                    btn.style.background = 'linear-gradient(90deg,#ff6b8b,#ff2c54)';
                    btn.style.border = 'none';
                }
                btn.style.color = '#fff';
                btn.style.padding = '6px 10px';
                btn.style.borderRadius = '8px';
                btn.style.cursor = 'pointer';
                btn.style.fontSize = '12px';
                btn.style.boxShadow = isLight ? 'none' : '0 6px 18px rgba(255,44,84,0.12)';
            });

            // 更醒目的关闭按钮
            const closeBtn = root.querySelector('#dy-close-panel');
            if (closeBtn) {
                closeBtn.style.background = 'transparent';
                closeBtn.style.color = isLight ? '#444' : '#bbb';
                closeBtn.style.fontSize = '16px';
                closeBtn.style.padding = '4px 8px';
                closeBtn.style.boxShadow = 'none';
            }

            // 面板内输入与 textarea
            const inputs = root.querySelectorAll('input, textarea');
            inputs.forEach(i => {
                if (isLight) {
                    i.style.background = '#fff';
                    i.style.border = '1px solid rgba(0,0,0,0.08)';
                    i.style.color = '#111';
                } else {
                    i.style.background = '#0f1114';
                    i.style.border = '1px solid rgba(255,255,255,0.06)';
                    i.style.color = '#e6eef8';
                }
                i.style.padding = '6px 8px';
                i.style.borderRadius = '6px';
            });

            // 列表样式
            const lists = root.querySelectorAll('ul');
            lists.forEach(ul => {
                ul.style.padding = '6px';
                ul.style.margin = '0';
                ul.style.maxHeight = ul.style.maxHeight || '260px';
                ul.style.overflow = 'auto';
            });

            // list items 调整
            const lis = root.querySelectorAll('li');
            lis.forEach(li => {
                li.style.display = 'block';
                li.style.padding = '8px 6px';
                li.style.borderRadius = '6px';
                li.style.marginBottom = '6px';
                li.style.background = isLight ? 'linear-gradient(180deg, rgba(0,0,0,0.02), rgba(0,0,0,0.01))' : 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.02))';
            });

            // checkbox 样式微调
            const cbs = root.querySelectorAll('.dy-select-checkbox');
            cbs.forEach(cb => {
                cb.style.width = '16px';
                cb.style.height = '16px';
            });

            // 文本区域高亮
            const log = root.querySelector('#dy-template-editor');
            if (log) {
                log.style.background = isLight ? 'rgba(0,0,0,0.02)' : 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.02))';
            }
        } catch (e) {
            console.warn('applyTheme error', e);
        }
    }

    // 模态模板编辑器辅助：创建、打开、关闭、键盘保存
    // Monaco Editor 加载器（使用 createElement）
    function loadMonacoEditorOnce() {
        if (window.__dy_monaco_promise) return window.__dy_monaco_promise;
        window.__dy_monaco_promise = new Promise((resolve) => {
            try {
                // 创建并添加 loader.js 脚本
                const loaderScript = document.createElement('script');
                loaderScript.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@latest/min/vs/loader.js';
                loaderScript.onload = function() {
                    // 设置 Monaco Editor 的基础路径
                    require.config({ paths: { 'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@latest/min/vs' } });
                    // 加载 Monaco Editor
                    require(['vs/editor/editor.main'], function() {
                        // 自定义主题
                        monaco.editor.defineTheme('dy-dark', {
                            base: 'vs-dark',
                            inherit: true,
                            rules: [
                                { token: 'comment', foreground: '6a9955' },
                                { token: 'keyword', foreground: '569cd6' },
                                { token: 'string', foreground: 'ce9178' }
                            ],
                            colors: {
                                'editor.background': '#1e1e1e',
                                'editor.foreground': '#d4d4d4'
                            }
                        });
                        
                        monaco.editor.defineTheme('dy-light', {
                            base: 'vs',
                            inherit: true,
                            rules: [
                                { token: 'comment', foreground: '008000' },
                                { token: 'keyword', foreground: '0000ff' },
                                { token: 'string', foreground: 'a31515' }
                            ],
                            colors: {
                                'editor.background': '#ffffff',
                                'editor.foreground': '#333333'
                            }
                        });
                        
                        resolve(monaco);
                    });
                };
                document.head.appendChild(loaderScript);
            } catch (e) {
                console.warn('Monaco Editor 加载失败', e);
                resolve(null);
            }
        });
        return window.__dy_monaco_promise;
    }
    


    // Update modal preview function - global scope
    window.updateModalPreview = function() {
        const preview = document.getElementById('dy-modal-preview');
        if (!preview) return;
        const ta = document.getElementById('dy-modal-editor-text');
        const source = (window.__dy_monaco_editor && window.__dy_monaco_editor.getModel) ? window.__dy_monaco_editor.getModel().getValue() : (ta ? ta.value : '');
        const sampleCtx = { targetName: activeEdit || '目标' };
        try {
            // 尝试渲染模板，检查是否有语法错误
            const out = renderTemplate(source || '', sampleCtx, activeEdit || '目标');
            preview.style.color = '';
            preview.style.background = '';
            preview.textContent = out;
        } catch (e) {
            preview.style.color = '#ff6b6b';
            preview.style.background = 'rgba(255, 107, 107, 0.1)';
            preview.textContent = `模板错误: ${e.message}`;
        }
    };

    function ensureTemplateModalExists() {
        if (document.getElementById('dy-template-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'dy-template-modal';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="dy-tpl-overlay">
                <div class="dy-tpl-box">
                    <div class="dy-tpl-box-header"><strong>编辑模板</strong><div class="dy-tpl-box-controls"><button id="dy-tpl-fullscreen" class="dy-btn dy-btn-light" title="全屏显示">⛶</button><button id="dy-tpl-cancel" class="dy-btn dy-btn-light">取消</button></div></div>
                    <div class="dy-tpl-box-body">
                        <div class="dy-tpl-desc">为 <span id="dy-modal-editor-target"></span> 编辑模板（支持 $date $targetName $sinceDate("YYYY-M-D") 和直接JavaScript代码）</div>
                        <div class="dy-tpl-syntax">
                            <button id="dy-tpl-ins-date" title="插入当前日期">$date</button>
                            <button id="dy-tpl-ins-target" title="插入对方名称">$targetName</button>
                            <button id="dy-tpl-ins-since" title='插入相识天数'>$sinceDate("YYYY-M-D")</button>
                        </div>
                        <!-- Monaco Editor 容器 -->
                        <div id="dy-modal-editor-monaco" class="monaco-container" style="width:100%;min-height:120px;height:300px"></div>
                        <textarea id="dy-modal-editor-text" rows="8" style="display:none"></textarea>
                        <div id="dy-modal-preview" class="dy-tpl-preview" aria-live="polite"></div>
                    </div>
                    <div class="dy-tpl-box-foot"><button id="dy-tpl-save" class="dy-btn dy-btn-send">保存 (Ctrl+S)</button></div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // 事件绑定
        document.getElementById('dy-tpl-cancel').addEventListener('click', closeTemplateModal);
        document.getElementById('dy-tpl-save').addEventListener('click', saveTemplateForActive);
        document.getElementById('dy-tpl-fullscreen').addEventListener('click', toggleFullscreen);

        // 语法插入按钮与实时预览（支持 Monaco Editor）
        const ta = document.getElementById('dy-modal-editor-text');
        const monacoContainer = document.getElementById('dy-modal-editor-monaco');
        const preview = document.getElementById('dy-modal-preview');
        let __dyEditor = null;

        function insertToEditor(text) {
            // 优先使用 Monaco Editor
            if (window.__dy_monaco_editor && window.__dy_monaco_editor.getModel) {
                const model = window.__dy_monaco_editor.getModel();
                const position = window.__dy_monaco_editor.getPosition();
                const range = new monaco.Range(
                    position.lineNumber,
                    position.column,
                    position.lineNumber,
                    position.column
                );
                model.pushEditOperations([], [{
                    range: range,
                    text: text
                }]);
                window.__dy_monaco_editor.focus();

                // 同步到textarea
                if (ta) {
                    ta.value = model.getValue();
                }

                // 更新预览
                updateModalPreview();
                return;
            }

            // 回退到textarea
            try {
                const start = ta.selectionStart || 0;
                const end = ta.selectionEnd || 0;
                const val = ta.value || '';
                ta.value = val.slice(0, start) + text + val.slice(end);
                const pos = start + text.length;
                ta.selectionStart = ta.selectionEnd = pos;
                ta.focus();

                // 更新预览
                updateModalPreview();
            } catch (e) { 
                if (ta) { 
                    ta.value += text; 
                    // 更新预览
                    updateModalPreview(); 
                } 
            }
        }



        // Monaco Editor 将在第一次打开模态框时初始化


        const btnDate = document.getElementById('dy-tpl-ins-date');
        const btnTarget = document.getElementById('dy-tpl-ins-target');
        const btnSince = document.getElementById('dy-tpl-ins-since');
        const btnIf = document.getElementById('dy-tpl-ins-if');
        const btnJs = document.getElementById('dy-tpl-ins-js');
        if (btnDate) btnDate.addEventListener('click', () => insertToEditor('$date'));
        if (btnTarget) btnTarget.addEventListener('click', () => insertToEditor('$targetName'));
        if (btnSince) btnSince.addEventListener('click', () => insertToEditor('$sinceDate("YYYY-M-D")'));

        // 键盘监听（全局但仅在模态开启时生效）
        modal._kbdHandler = function(e) {
            if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
                e.preventDefault();
                saveTemplateForActive();
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeTemplateModal();
            }
        };
    }

    function openTemplateModal(name) {
        activeEdit = name;
        const modal = document.getElementById('dy-template-modal');
        if (!modal) return;
        // 根据面板主题同步模态主题
        if (settings.theme === 'light') modal.classList.add('dy-theme-light'); else modal.classList.remove('dy-theme-light');
        const targetEl = document.getElementById('dy-modal-editor-target');
        const textEl = document.getElementById('dy-modal-editor-text');
        const monacoContainer = document.getElementById('dy-modal-editor-monaco');
        targetEl.textContent = name;
        const initial = (persistent[name] && persistent[name].template) || '';
        
        // 初始化 Monaco Editor（如果尚未初始化）
        if (!window.__dy_monaco_editor) {
            // 先显示 textarea，Monaco Editor 加载后会替换
            textEl.style.display = 'block';
            monacoContainer.style.display = 'none';
            textEl.value = initial;
            
            // 懒加载 Monaco Editor
            loadMonacoEditorOnce().then((monaco) => {
                if (!monaco) return;
                
                // 初始化编辑器
                const chosenTheme = (settings && settings.theme === 'light') ? 'dy-light' : 'dy-dark';
                
                // 使用JavaScript语法高亮
                // 不再需要自定义语言，直接使用JavaScript
                
                monaco.languages.setMonarchTokensProvider('template-language', {
                    tokenizer: {
                        root: [
                            [/\$date/g, 'keyword'],
                            [/\$targetName/g, 'keyword'],
                            [/\$sinceDate\([^)]+\)/g, 'keyword'],
                            [/{%\s*if[^}]*?%}[\s\S]*?{%\s*endif\s*%}/g, 'keyword'],
                        ]
                    }
                });
                
                // 创建编辑器实例
                window.__dy_monaco_editor = monaco.editor.create(monacoContainer, {
                    value: textEl.value,
                    language: 'javascript',
                    theme: chosenTheme,
                    lineNumbers: 'on',
                    wordWrap: 'on',
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    suggestOnTriggerCharacters: true,
                    quickSuggestions: true,
                    parameterHints: { enabled: true },
                });
                
                // 添加自动补全
                monaco.languages.registerCompletionItemProvider('javascript', {
                    provideCompletionItems: function(model, position) {
                        const word = model.getWordUntilPosition(position);
                        const range = {
                            startLineNumber: position.lineNumber,
                            endLineNumber: position.lineNumber,
                            startColumn: word.startColumn,
                            endColumn: word.endColumn
                        };
                        
                        return {
                            suggestions: [
                                {
                                    label: '$date',
                                    kind: monaco.languages.CompletionItemKind.Keyword,
                                    insertText: '$date',
                                    range: range,
                                    documentation: '当前日期'
                                },
                                {
                                    label: '$targetName',
                                    kind: monaco.languages.CompletionItemKind.Keyword,
                                    insertText: '$targetName',
                                    range: range,
                                    documentation: '对象名称'
                                },
                                {
                                    label: '$sinceDate("YYYY-M-D")',
                                    kind: monaco.languages.CompletionItemKind.Keyword,
                                    insertText: '$sinceDate("YYYY-M-D")',
                                    range: range,
                                    documentation: '相识天数'
                                }
                            ]
                        };
                    }
                });
                
                // 将 textarea 隐藏
                textEl.style.display = 'none';
                monacoContainer.style.display = 'block';

                
                // 绑定 change 事件，同时更新textarea和预览
                const changeHandler = () => {
                    // 获取当前编辑器内容
                    const content = window.__dy_monaco_editor.getModel().getValue();

                    // 立即同步内容到textarea
                    if (textEl) {
                        textEl.value = content;
                    }

                    // 立即更新预览
                    updateModalPreview();
                };

                // 移除旧的监听器（如果存在）
                if (window.__dy_monaco_editor._changeDisposable) {
                    window.__dy_monaco_editor._changeDisposable.dispose();
                }

                // 添加新的监听器并保存引用
                window.__dy_monaco_editor._changeDisposable = window.__dy_monaco_editor.onDidChangeModelContent(changeHandler);
                
                // 添加快捷键
                window.__dy_monaco_editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveTemplateForActive());
                window.__dy_monaco_editor.addCommand(monaco.KeyCode.Escape, () => closeTemplateModal());
                
                // 更新预览
                updateModalPreview();
                
                // 聚焦并选中全部文本
                setTimeout(() => {
                    window.__dy_monaco_editor.focus();
                    try {
                        window.__dy_monaco_editor.setSelection(window.__dy_monaco_editor.getModel().getFullModelRange());
                    } catch(e){}
                }, 100);
            });
        } else {
            // Monaco Editor 已初始化，直接设置内容
            if (window.__dy_monaco_editor && window.__dy_monaco_editor.getModel) {
                window.__dy_monaco_editor.getModel().setValue(initial);
                // 同步到textarea
                if (textEl) {
                    textEl.value = initial;

                    // 确保textarea已有input事件监听器
                    if (!textEl._hasMonacoSync) {
                        textEl.addEventListener('input', () => {
                            if (window.__dy_monaco_editor && window.__dy_monaco_editor.getModel) {
                                const editorValue = window.__dy_monaco_editor.getModel().getValue();
                                if (editorValue !== textEl.value) {
                                    window.__dy_monaco_editor.getModel().setValue(textEl.value);
                                }
                            }
                            updateModalPreview();
                        });
                        textEl._hasMonacoSync = true;
                    }
                }

                // 确保编辑器内容变化时更新预览
                const changeHandler = () => {
                    // 获取当前编辑器内容
                    const content = window.__dy_monaco_editor.getModel().getValue();

                    // 立即同步内容到textarea
                    if (textEl) {
                        textEl.value = content;
                    }

                    // 立即更新预览
                    updateModalPreview();
                };

                // 移除旧的监听器（如果存在）
                if (window.__dy_monaco_editor._changeDisposable) {
                    window.__dy_monaco_editor._changeDisposable.dispose();
                }

                // 添加新的监听器并保存引用
                window.__dy_monaco_editor._changeDisposable = window.__dy_monaco_editor.onDidChangeModelContent(changeHandler);

                // 根据主题设置编辑器主题
                const chosenTheme = (settings && settings.theme === 'light') ? 'dy-light' : 'dy-dark';
                monaco.editor.setTheme(chosenTheme);
                textEl.style.display = 'none';
                monacoContainer.style.display = 'block';

                // 更新预览
                updateModalPreview();
            } else {
                textEl.style.display = 'block';
                monacoContainer.style.display = 'none';
                textEl.value = initial;

                // 添加textarea的input事件监听器，确保预览更新
                if (!textEl._hasChangeListener) {
                    textEl.addEventListener('input', updateModalPreview);
                    textEl._hasChangeListener = true;
                }

                // 更新预览
                updateModalPreview();
            }
        }
        
        modal.style.display = 'block';
        // 简单淡入
        const overlay = modal.querySelector('.dy-tpl-overlay');
        if (overlay) overlay.style.opacity = '1';

        // 如果 Monaco Editor 已初始化，更新布局
        setTimeout(() => {
            try {
                if (window.__dy_monaco_editor) {
                    // 更新布局
                    window.__dy_monaco_editor.layout();
                }
            } catch (e) {}
        }, 50);


        window.addEventListener('keydown', modal._kbdHandler);
    }

    function toggleFullscreen() {
        const modal = document.getElementById('dy-template-modal');
        if (!modal) return;
        const box = modal.querySelector('.dy-tpl-box');
        if (!box) return;
        const fullscreenBtn = document.getElementById('dy-tpl-fullscreen');
        const overlay = modal.querySelector('.dy-tpl-overlay');
        
        if (box.classList.contains('dy-fullscreen')) {
            // 退出全屏
            box.classList.remove('dy-fullscreen');
            fullscreenBtn.textContent = '⛶';
            fullscreenBtn.title = '全屏显示';
            // 恢复overlay样式
            if (overlay) {
                overlay.style.alignItems = 'center';
                overlay.style.justifyContent = 'center';
            }
        } else {
            // 进入全屏
            box.classList.add('dy-fullscreen');
            fullscreenBtn.textContent = '⛶';
            fullscreenBtn.title = '退出全屏';
            // 调整overlay样式以适应全屏
            if (overlay) {
                overlay.style.alignItems = 'stretch';
                overlay.style.justifyContent = 'stretch';
                overlay.style.padding = '0';
            }
        }
        
        // 如果Monaco编辑器已加载，重新计算布局
        setTimeout(() => {
            if (window.__dy_monaco_editor) {
                window.__dy_monaco_editor.layout();
            }
        }, 300);
    }

    function closeTemplateModal() {
        const modal = document.getElementById('dy-template-modal');
        if (!modal) return;
        modal.style.display = 'none';
        try { window.removeEventListener('keydown', modal._kbdHandler); } catch (e) {}
        activeEdit = null;
        
        // 退出全屏状态（如果有）
        const box = modal.querySelector('.dy-tpl-box');
        if (box && box.classList.contains('dy-fullscreen')) {
            box.classList.remove('dy-fullscreen');
        }
    }

    // Macro Manager Modal Functions
    function ensureMacroModalExists() {
        if (document.getElementById('dy-macro-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'dy-macro-modal';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="dy-macro-overlay">
                <div class="dy-macro-box">
                    <div class="dy-macro-box-header">
                        <strong>宏管理系统</strong>
                        <div class="dy-macro-box-controls">
                            <button id="dy-macro-cancel" class="dy-btn dy-btn-light">关闭</button>
                        </div>
                    </div>
                    <div class="dy-macro-box-body">
                        <div class="dy-macro-body">
                            <div class="dy-macro-column manage-macros">
                                <div class="dy-title">管理宏</div>
                                <ul id="dy-manage-macros-list" class="dy-list"></ul>
                                <div class="dy-macro-form">
                                    <input type="text" id="dy-macro-name" placeholder="宏名称" />
                                    <input type="text" id="dy-macro-desc" placeholder="宏描述（可选）" />
                                    <div id="dy-macro-editor-container" class="monaco-container" style="width:100%;min-height:120px;height:200px;margin-top:8px"></div>
                                    <textarea id="dy-macro-code" placeholder="宏代码..." style="display:none;width:100%;min-height:120px;margin-top:8px"></textarea>
                                    <div class="dy-macro-form-buttons" style="text-align:right;margin-top:8px">
                                        <button id="dy-save-macro" class="dy-btn">保存宏</button>
                                        <button id="dy-clear-macro-form" class="dy-btn dy-btn-light">清空</button>
                                    </div>
                                </div>
                            </div>
                            <div class="dy-macro-column apply-macros">
                                <div class="dy-title">应用宏</div>
                                <ul id="dy-apply-macros-list" class="dy-list"></ul>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Add CSS for the macro modal
        if (!document.getElementById('dy-macro-styles')) {
            const macroStyles = document.createElement('style');
            macroStyles.id = 'dy-macro-styles';
            macroStyles.innerHTML = `
                /* Enhanced macro management panel styles */
                #dy-macro-modal {
                    position: fixed;
                    left: 0;
                    top: 0;
                    right: 0;
                    bottom: 0;
                    display: none;
                    z-index: 10001;
                }
                #dy-macro-modal .dy-macro-overlay {
                    position: absolute;
                    left:0; top:0; right:0; bottom:0;
                    background: rgba(0,0,0,0.65);
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    padding:20px;
                    transition: opacity 200ms ease;
                }
                #dy-macro-modal .dy-macro-box {
                    width: min(1000px, 96%);
                    background: linear-gradient(160deg, #1e1e2a, #14141c);
                    color:#e6eef8;
                    border-radius:16px;
                    padding:16px;
                    box-shadow:0 20px 60px rgba(0,0,0,0.7);
                    max-height:92vh;
                    overflow:auto;
                    transition: all 0.3s ease;
                    border: 1px solid rgba(255,255,255,0.08);
                }
                #dy-macro-modal .dy-macro-box-header {
                    display:flex;
                    justify-content:space-between;
                    align-items:center;
                    margin-bottom:12px;
                    padding-bottom: 12px;
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                }
                #dy-macro-modal .dy-macro-box-controls {
                    display:flex;
                    gap: 8px;
                }
                #dy-macro-modal.dy-theme-light .dy-macro-box {
                    background: linear-gradient(160deg, #ffffff, #f8fafc);
                    color:#111827;
                    border: 1px solid rgba(0,0,0,0.08);
                }
                #dy-macro-modal .dy-macro-box-body {
                    margin-bottom:8px
                }
                .dy-macro-body {
                    display: flex;
                    gap: 16px;
                    min-height: 500px;
                }
                .dy-macro-column {
                    flex: 1;
                    background: rgba(255,255,255,0.04);
                    padding: 12px;
                    border-radius: 10px;
                    max-height: 550px;
                    overflow: auto;
                    min-width: 300px;
                    border: 1px solid rgba(255,255,255,0.06);
                    box-shadow: 0 4px 6px rgba(0,0,0,0.05);
                    transition: all 0.3s ease;
                }
                .dy-macro-column:hover {
                    box-shadow: 0 6px 12px rgba(0,0,0,0.1);
                    border-color: rgba(255,255,255,0.1);
                }
                .dy-macro-column.manage-macros {
                    border-right: 2px solid rgba(139, 92, 246, 0.2);
                }
                .dy-macro-column.apply-macros {
                    border-left: 2px solid rgba(59, 130, 246, 0.2);
                }
                .dy-macro-header {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    margin-bottom: 8px;
                }
                .dy-macro-title {
                    font-size: 16px;
                    font-weight: 600;
                    color: #c7d2fe;
                    display: flex;
                    align-items: center;
                }
                .dy-macro-title::before {
                    content: "⚡";
                    margin-right: 8px;
                    font-size: 14px;
                }
                .dy-macro-item {
                    padding: 12px;
                    margin-bottom: 10px;
                    background: rgba(0,0,0,0.2);
                    border-radius: 8px;
                    border: 1px solid rgba(255,255,255,0.1);
                    transition: all 0.2s ease;
                    position: relative;
                    overflow: hidden;
                }
                .dy-macro-item::before {
                    content: '';
                    position: absolute;
                    top: 0;
                    left: 0;
                    width: 3px;
                    height: 100%;
                    background: linear-gradient(to bottom, #8b5cf6, #3b82f6);
                }
                .dy-macro-item:hover {
                    background: rgba(255,255,255,0.06);
                    transform: translateY(-2px);
                    box-shadow: 0 4px 12px rgba(0,0,0,0.15);
                }
                .dy-macro-item.enabled {
                    border-left: 4px solid #10b981;
                }
                .dy-macro-item.enabled::before {
                    background: linear-gradient(to bottom, #10b981, #34d399);
                }
                .dy-macro-item.disabled {
                    border-left: 4px solid #ef4444;
                    opacity: 0.7;
                }
                .dy-macro-item.disabled::before {
                    background: linear-gradient(to bottom, #ef4444, #f87171);
                }
                .dy-macro-item-name {
                    font-weight: 600;
                    margin-bottom: 4px;
                    color: #e0e7ff;
                    font-size: 14px;
                }
                .dy-macro-item-desc {
                    font-size: 13px;
                    color: #94a3b8;
                    margin-bottom: 6px;
                }
                .dy-macro-item-code {
                    font-family: 'Fira Code', 'Consolas', monospace;
                    font-size: 12px;
                    background: rgba(0,0,0,0.3);
                    padding: 6px;
                    border-radius: 4px;
                    overflow: auto;
                    max-height: 80px;
                    color: #cbd5e1;
                    border: 1px solid rgba(255,255,255,0.05);
                }
                .dy-macro-item-templates {
                    font-size: 11px;
                    color: #64748b;
                    margin-top: 6px;
                    padding-top: 6px;
                    border-top: 1px solid rgba(255,255,255,0.05);
                }
                .dy-macro-actions {
                    display: flex;
                    gap: 6px;
                    margin-top: 8px;
                    justify-content: flex-end;
                }
                .dy-macro-toggle {
                    padding: 6px 10px;
                    font-size: 12px;
                    border-radius: 6px;
                    min-width: 60px;
                }
                .dy-macro-edit {
                    padding: 6px 10px;
                    font-size: 12px;
                    border-radius: 6px;
                    min-width: 50px;
                }
                .dy-macro-delete {
                    padding: 6px 10px;
                    font-size: 12px;
                    border-radius: 6px;
                    min-width: 50px;
                }
                .dy-macro-form {
                    margin-top: 16px;
                    padding: 12px;
                    background: rgba(0,0,0,0.2);
                    border-radius: 8px;
                    border: 1px solid rgba(255,255,255,0.08);
                }
                .dy-macro-form input,
                .dy-macro-form textarea {
                    width: 100%;
                    box-sizing: border-box;
                    margin-bottom: 8px;
                    padding: 10px;
                    border-radius: 6px;
                    background: rgba(0,0,0,0.3);
                    border: 1px solid rgba(255,255,255,0.1);
                    color: #e6eef8;
                }
                .dy-macro-form textarea {
                    min-height: 120px;
                    font-family: 'Fira Code', 'Consolas', monospace;
                    font-size: 13px;
                }
                .dy-macro-form-buttons {
                    text-align: right;
                    margin-top: 8px;
                }
                .dy-macro-select {
                    width: 100%;
                    padding: 10px;
                    border-radius: 8px;
                    background: rgba(0,0,0,0.3);
                    border: 1px solid rgba(255,255,255,0.1);
                    color: #e6eef8;
                    font-size: 13px;
                    margin-bottom: 8px;
                }
                .dy-macro-assign-btn {
                    background: linear-gradient(90deg,#8b5cf6,#6366f1);
                    width: 100%;
                    margin-top: 4px;
                    padding: 10px;
                    border-radius: 8px;
                    font-weight: 500;
                }
                .dy-macro-clear-btn {
                    background: linear-gradient(90deg,#f97316,#ea580c);
                    width: 100%;
                    margin-top: 6px;
                    padding: 10px;
                    border-radius: 8px;
                    font-weight: 500;
                }
                .dy-macro-assign-btn:hover {
                    background: linear-gradient(90deg,#7c3aed,#4f46e5);
                    transform: translateY(-1px);
                    box-shadow: 0 4px 8px rgba(139, 92, 246, 0.3);
                }
                .dy-macro-clear-btn:hover {
                    background: linear-gradient(90deg,#ea580c,#c2410c);
                    transform: translateY(-1px);
                    box-shadow: 0 4px 8px rgba(249, 115, 22, 0.3);
                }
                .dy-macro-toggle:hover {
                    background: linear-gradient(90deg,#4b5563,#374151);
                    transform: translateY(-1px);
                    box-shadow: 0 2px 6px rgba(0,0,0,0.2);
                }
                .dy-macro-edit:hover {
                    background: linear-gradient(90deg,#22c55e,#16a34a);
                    transform: translateY(-1px);
                    box-shadow: 0 2px 6px rgba(34, 197, 94, 0.3);
                }
                .dy-macro-delete:hover {
                    background: linear-gradient(90deg,#ef4444,#dc2626);
                    transform: translateY(-1px);
                    box-shadow: 0 2px 6px rgba(239, 68, 68, 0.3);
                }
                .dy-macro-form input:focus,
                .dy-macro-form textarea:focus,
                .dy-macro-select:focus {
                    outline: none;
                    border-color: #8b5cf6;
                    box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.3);
                }
                /* Light theme overrides */
                .dy-macro-column.dy-theme-light {
                    background: rgba(0,0,0,0.03);
                    border: 1px solid rgba(0,0,0,0.06);
                }
                .dy-macro-item.dy-theme-light {
                    background: rgba(0,0,0,0.02);
                    border: 1px solid rgba(0,0,0,0.05);
                    color: #111827;
                }
                .dy-macro-item-name.dy-theme-light {
                    color: #111827;
                }
                .dy-macro-item-desc.dy-theme-light {
                    color: #6b7280;
                }
                .dy-macro-item-code.dy-theme-light {
                    background: rgba(0,0,0,0.03);
                    border: 1px solid rgba(0,0,0,0.05);
                    color: #374151;
                }
                .dy-macro-form.dy-theme-light {
                    background: rgba(0,0,0,0.02);
                    border: 1px solid rgba(0,0,0,0.06);
                }
                .dy-macro-form input.dy-theme-light,
                .dy-macro-form textarea.dy-theme-light {
                    background: #ffffff;
                    border: 1px solid rgba(0,0,0,0.1);
                    color: #111827;
                }
                .dy-macro-select.dy-theme-light {
                    background: #ffffff;
                    border: 1px solid rgba(0,0,0,0.1);
                    color: #111827;
                }
                /* Scrollbar styling */
                .dy-macro-column::-webkit-scrollbar {
                    width: 8px;
                }
                .dy-macro-column::-webkit-scrollbar-track {
                    background: rgba(0,0,0,0.1);
                    border-radius: 4px;
                }
                .dy-macro-column::-webkit-scrollbar-thumb {
                    background: rgba(255,255,255,0.2);
                    border-radius: 4px;
                }
                .dy-macro-column::-webkit-scrollbar-thumb:hover {
                    background: rgba(255,255,255,0.3);
                }
            `;
            document.head.appendChild(macroStyles);
        }

        // Event bindings for macro modal
        document.getElementById('dy-macro-cancel').addEventListener('click', closeMacroModal);
        document.getElementById('dy-save-macro').addEventListener('click', saveMacroFromForm);
        document.getElementById('dy-clear-macro-form').addEventListener('click', () => {
            document.getElementById('dy-macro-name').value = '';
            document.getElementById('dy-macro-desc').value = '';
            if (window.__dy_macro_monaco_editor && window.__dy_macro_monaco_editor.getModel) {
                window.__dy_macro_monaco_editor.getModel().setValue('');
            } else {
                document.getElementById('dy-macro-code').value = '';
            }
        });
    }

    function openMacroManagerModal() {
        ensureMacroModalExists();
        const modal = document.getElementById('dy-macro-modal');
        if (!modal) return;

        // Apply theme
        if (settings.theme === 'light') modal.classList.add('dy-theme-light'); else modal.classList.remove('dy-theme-light');

        // Initialize Monaco Editor for macro code if not already done
        const codeTextarea = document.getElementById('dy-macro-code');
        const editorContainer = document.getElementById('dy-macro-editor-container');

        if (!window.__dy_macro_monaco_editor) {
            // Show textarea initially, Monaco will replace it
            codeTextarea.style.display = 'block';
            editorContainer.style.display = 'none';

            // Load Monaco Editor for macro
            loadMonacoEditorOnce().then((monaco) => {
                if (!monaco) return;

                // Initialize editor
                const chosenTheme = (settings && settings.theme === 'light') ? 'dy-light' : 'dy-dark';

                // Create editor instance for macro
                window.__dy_macro_monaco_editor = monaco.editor.create(editorContainer, {
                    value: codeTextarea.value,
                    language: 'javascript',
                    theme: chosenTheme,
                    lineNumbers: 'on',
                    wordWrap: 'on',
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    suggestOnTriggerCharacters: true,
                    quickSuggestions: true,
                    parameterHints: { enabled: true },
                });

                // Add auto-completion for macro-specific keywords
                monaco.languages.registerCompletionItemProvider('javascript', {
                    provideCompletionItems: function(model, position) {
                        const word = model.getWordUntilPosition(position);
                        const range = {
                            startLineNumber: position.lineNumber,
                            endLineNumber: position.lineNumber,
                            startColumn: word.startColumn,
                            endColumn: word.endColumn
                        };

                        return {
                            suggestions: [
                                {
                                    label: '$targetName',
                                    kind: monaco.languages.CompletionItemKind.Variable,
                                    insertText: '$targetName',
                                    range: range,
                                    documentation: '目标名称'
                                },
                                {
                                    label: '$date',
                                    kind: monaco.languages.CompletionItemKind.Variable,
                                    insertText: '$date',
                                    range: range,
                                    documentation: '当前日期'
                                },
                                {
                                    label: '$sinceDate("YYYY-M-D")',
                                    kind: monaco.languages.CompletionItemKind.Function,
                                    insertText: '$sinceDate("YYYY-M-D")',
                                    range: range,
                                    documentation: '相识天数'
                                }
                            ]
                        };
                    }
                });

                // Hide textarea and show editor
                codeTextarea.style.display = 'none';
                editorContainer.style.display = 'block';

                // Sync changes between editor and textarea
                const changeHandler = () => {
                    const content = window.__dy_macro_monaco_editor.getModel().getValue();
                    codeTextarea.value = content;
                };

                // Remove old listener if exists
                if (window.__dy_macro_monaco_editor._changeDisposable) {
                    window.__dy_macro_monaco_editor._changeDisposable.dispose();
                }

                // Add new listener
                window.__dy_macro_monaco_editor._changeDisposable = window.__dy_macro_monaco_editor.onDidChangeModelContent(changeHandler);
            });
        } else {
            // Monaco editor already exists, just update content and theme
            if (window.__dy_macro_monaco_editor && window.__dy_macro_monaco_editor.getModel) {
                // Update theme
                const chosenTheme = (settings && settings.theme === 'light') ? 'dy-light' : 'dy-dark';
                monaco.editor.setTheme(chosenTheme);

                // Show editor and hide textarea
                codeTextarea.style.display = 'none';
                editorContainer.style.display = 'block';
            } else {
                // Fallback to textarea
                codeTextarea.style.display = 'block';
                editorContainer.style.display = 'none';
            }
        }

        // Show the modal
        modal.style.display = 'block';
        const overlay = modal.querySelector('.dy-macro-overlay');
        if (overlay) overlay.style.opacity = '1';

        // Render macro lists
        renderMacroLists();
    }

    function closeMacroModal() {
        const modal = document.getElementById('dy-macro-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }

    function renderLists() {
        const stagedList = document.getElementById('dy-staged-list');
        const persistList = document.getElementById('dy-persist-list');
        if (!stagedList || !persistList) return;

        stagedList.innerHTML = '';
        staged.forEach(name => {
            const li = document.createElement('li');
            li.className = 'dy-item';
            // Check if this name is already in persistent storage (for consistency)
            const targetData = persistent[name];
            const lastSendDate = targetData && targetData.lastSendDate ? `上次发送: ${targetData.lastSendDate}` : '未发送';
            li.innerHTML = `
                <div class="dy-item-top">
                    <label><input class="dy-select-checkbox" type="checkbox" data-name="${escapeAttr(name)}" ${selectedSet.has(name) ? 'checked' : ''} /> <span class="dy-item-name">${escapeHtml(name)}</span></label>
                    <div class="dy-item-date" style="font-size:11px; color:#aaa; margin-top:4px;">${escapeHtml(lastSendDate)}</div>
                </div>
                <div class="dy-item-actions">
                    <button class="dy-btn dy-btn-add dy-btn-persist" data-name="${escapeAttr(name)}">添加目标</button>
                    <button class="dy-btn dy-btn-edit" data-name="${escapeAttr(name)}">模板</button>
                    <button class="dy-btn dy-btn-send" data-name="${escapeAttr(name)}">发送</button>
                </div>
            `;
            stagedList.appendChild(li);
        });

        persistList.innerHTML = '';
        Object.keys(persistent).forEach(name => {
            const targetData = persistent[name];
            const lastSendDate = targetData.lastSendDate ? `上次发送: ${targetData.lastSendDate}` : '未发送';
            const li = document.createElement('li');
            li.className = 'dy-item';
            li.innerHTML = `
                <div class="dy-item-top">
                    <label><input class="dy-select-checkbox" type="checkbox" data-name="${escapeAttr(name)}" ${selectedSet.has(name) ? 'checked' : ''} /> <span class="dy-item-name">${escapeHtml(name)}</span></label>
                    <div class="dy-item-date" style="font-size:11px; color:#aaa; margin-top:4px;">${escapeHtml(lastSendDate)}</div>
                </div>
                <div class="dy-item-actions">
                    <button class="dy-btn dy-btn-remove dy-btn-unpersist" data-name="${escapeAttr(name)}">移除目标</button>
                    <button class="dy-btn dy-btn-edit" data-name="${escapeAttr(name)}">模板</button>
                    <button class="dy-btn dy-btn-send" data-name="${escapeAttr(name)}">发送</button>
                </div>
            `;
            persistList.appendChild(li);
        });

        // 绑定事件
        document.querySelectorAll('.dy-btn-persist').forEach(btn => btn.addEventListener('click', onPersist));
        document.querySelectorAll('.dy-btn-unpersist').forEach(btn => btn.addEventListener('click', onUnpersist));
        document.querySelectorAll('.dy-btn-edit').forEach(btn => btn.addEventListener('click', onEditTemplate));
        document.querySelectorAll('.dy-btn-send').forEach(btn => btn.addEventListener('click', onSendNow));
        // checkbox 事件
        document.querySelectorAll('.dy-select-checkbox').forEach(cb => cb.addEventListener('change', onSelectToggle));
        const selectAll = document.getElementById('dy-select-all');
        if (selectAll) selectAll.onchange = onSelectAll;
        // 批量发送按钮
        const batchBtn = document.getElementById('dy-batch-send');
        if (batchBtn) batchBtn.onclick = batchSendSelected;
        // scheduler controls
        const saveScheduleBtn = document.getElementById('dy-save-schedule');
        if (saveScheduleBtn) saveScheduleBtn.onclick = saveScheduleFromUI;
        const toggleSchedulerBtn = document.getElementById('dy-toggle-scheduler');
        if (toggleSchedulerBtn) toggleSchedulerBtn.onclick = toggleScheduler;
        const intervalInput = document.getElementById('dy-interval-sec');
        if (intervalInput) intervalInput.onchange = () => { settings.sendIntervalSec = Number(intervalInput.value) || 3; saveSettings(); };

        // send mode selector
        const sendModeSelect = document.getElementById('dy-send-mode');
        if (sendModeSelect) {
            sendModeSelect.value = settings.sendMode || 'scheduled';
            sendModeSelect.onchange = () => {
                settings.sendMode = sendModeSelect.value;
                saveSettings();
                updateSchedulerStatus();
                // Show/hide schedule time input based on mode
                const scheduleTimeRow = document.getElementById('dy-schedule-time-row');
                if (scheduleTimeRow) {
                    scheduleTimeRow.style.display = settings.sendMode === 'scheduled' ? 'flex' : 'none';
                }
            };
            // Initialize visibility based on current mode
            const scheduleTimeRow = document.getElementById('dy-schedule-time-row');
            if (scheduleTimeRow) {
                scheduleTimeRow.style.display = settings.sendMode === 'scheduled' ? 'flex' : 'none';
            }
        }

        // 初始化 UI 值
        const timeInput = document.getElementById('dy-schedule-time');
        if (timeInput) timeInput.value = settings.schedulerTime || '';
        if (intervalInput) intervalInput.value = settings.sendIntervalSec || 3;
        updateSchedulerStatus();

        // 宏管理面板事件绑定
        const saveMacroBtn = document.getElementById('dy-save-macro');
        if (saveMacroBtn) saveMacroBtn.addEventListener('click', saveMacroFromForm);

        const clearMacroFormBtn = document.getElementById('dy-clear-macro-form');
        if (clearMacroFormBtn) clearMacroFormBtn.addEventListener('click', () => {
            document.getElementById('dy-macro-name').value = '';
            document.getElementById('dy-macro-desc').value = '';
            document.getElementById('dy-macro-code').value = '';
        });

        // 渲染宏列表
        renderMacroLists();
    }

    function onPersist(e) {
        const name = e.currentTarget.dataset.name;
        if (!name) return;
        if (!persistent[name]) {
            persistent[name] = { template: DEFAULT_TEMPLATE, macros: [], lastSendDate: '' };
        }
        // 从暂存移除
        staged = staged.filter(n => n !== name);
        savePersistent();
        renderLists();
    }

    function onUnpersist(e) {
        const name = e.currentTarget.dataset.name;
        if (!name) return;
        delete persistent[name];
        savePersistent();
        renderLists();
    }

    function onEditTemplate(e) {
        const name = e.currentTarget.dataset.name;
        if (!name) return;
        // 使用模态窗口编辑模板
        openTemplateModal(name);
    }

    function saveTemplateForActive() {
        if (!activeEdit) return;
        let tpl = '';
        if (window.__dy_monaco_editor && window.__dy_monaco_editor.getModel) {
            try { tpl = window.__dy_monaco_editor.getModel().getValue(); } catch (e) { tpl = ''; }
        } else {
            const editorText = document.getElementById('dy-modal-editor-text') || document.getElementById('dy-editor-text');
            tpl = (editorText && editorText.value) ? editorText.value : '';
        }
        if (!persistent[activeEdit]) persistent[activeEdit] = { template: tpl, macros: [], lastSendDate: '' };
        else {
            persistent[activeEdit].template = tpl;
            // Ensure macros array exists
            if (!persistent[activeEdit].macros) persistent[activeEdit].macros = [];
            // Ensure lastSendDate exists
            if (!persistent[activeEdit].lastSendDate) persistent[activeEdit].lastSendDate = '';
        }
        savePersistent();
        renderLists();
        // 关闭模态
        closeTemplateModal();
    }

    function onSendNow(e) {
        const name = e.currentTarget.dataset.name;
        if (!name) return;
        const tpl = (persistent[name] && persistent[name].template) || DEFAULT_TEMPLATE;
        const rendered = renderTemplate(tpl, { targetName: name }, name);
        sendToTarget(name, rendered).then(ok => {
            if (ok) {
                // Update lastSendDate if in automatic mode
                if (settings.sendMode === 'automatic') {
                    persistent[name].lastSendDate = new Date().toDateString();
                    savePersistent();
                }
                notify('发送成功', name + ' 已发送');
                // Refresh the UI to show updated status
                renderLists();
            } else {
                notify('发送失败', '请检查页面或稍后重试');
            }
        });
    }

    function onSelectToggle(e) {
        const name = e.currentTarget.dataset.name;
        if (!name) return;
        if (e.currentTarget.checked) selectedSet.add(name);
        else selectedSet.delete(name);
    }

    function onSelectAll(e) {
        const checked = e.currentTarget.checked;
        document.querySelectorAll('.dy-select-checkbox').forEach(cb => {
            cb.checked = checked;
            const name = cb.dataset.name;
            if (checked) selectedSet.add(name);
            else selectedSet.delete(name);
        });
    }

    async function batchSendSelected() {
        const names = Array.from(selectedSet);
        if (names.length === 0) return notify('未选中', '请先选择要批量发送的对象');
        await batchSend(names);
    }

    async function batchSend(names) {
        const statusEl = document.getElementById('dy-scheduler-status');
        if (statusEl) statusEl.textContent = `发送中: 0/${names.length}`;
        for (let i = 0; i < names.length; i++) {
            const name = names[i];
            const tpl = (persistent[name] && persistent[name].template) || 'return \`自动续火花-$date\n$targetName\`';
            const rendered = renderTemplate(tpl, { targetName: name }, name);
            const ok = await sendToTarget(name, rendered);
            if (ok && settings.sendMode === 'automatic') {
                // Update lastSendDate for automatic mode
                persistent[name].lastSendDate = new Date().toDateString();
                savePersistent();
            }
            if (statusEl) statusEl.textContent = `发送中: ${i+1}/${names.length}`;
            await sleep((settings.sendIntervalSec || 3) * 1000);
        }
        if (statusEl) statusEl.textContent = `上次批量完成: ${new Date().toLocaleTimeString()}`;
        notify('批量发送完成', `共 ${names.length} 条`);
        // Refresh the UI to show updated status
        renderLists();
    }

    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

    // 宏管理相关函数
    function addMacro(name, code, description = '', enabled = true) {
        if (!name || !code) return false;
        macros[name] = {
            code: code,
            enabled: enabled,
            description: description
        };
        saveMacros();
        return true;
    }

    function updateMacro(name, code, description = '', enabled = true) {
        if (!name || !macros[name]) return false;
        macros[name] = {
            code: code,
            enabled: enabled,
            description: description
        };
        saveMacros();
        return true;
    }

    function deleteMacro(name) {
        if (!macros[name]) return false;

        // Remove this macro from all templates that use it
        for (const [templateName, templateData] of Object.entries(persistent)) {
            if (templateData.macros && templateData.macros.includes(name)) {
                templateData.macros = templateData.macros.filter(macroName => macroName !== name);
            }
        }

        delete macros[name];
        saveMacros();
        savePersistent(); // Save the updated templates
        return true;
    }

    function toggleMacro(name) {
        if (!macros[name]) return false;
        macros[name].enabled = !macros[name].enabled;
        saveMacros();
        return true;
    }

    function renderMacroLists() {
        const manageList = document.getElementById('dy-manage-macros-list');
        const applyList = document.getElementById('dy-apply-macros-list');

        if (!manageList || !applyList) return;

        // Clear lists
        manageList.innerHTML = '';
        applyList.innerHTML = '';

        // Populate manage list
        Object.keys(macros).forEach(name => {
            const macro = macros[name];

            // Find which templates use this macro
            const templatesUsingMacro = [];
            for (const [templateName, templateData] of Object.entries(persistent)) {
                if (templateData.macros && templateData.macros.includes(name)) {
                    templatesUsingMacro.push(templateName);
                }
            }

            const li = document.createElement('li');
            li.className = `dy-macro-item ${macro.enabled ? 'enabled' : 'disabled'}`;
            li.innerHTML = `
                <div class="dy-macro-item-name">${escapeHtml(name)}</div>
                <div class="dy-macro-item-desc">${escapeHtml(macro.description || '无描述')}</div>
                <div class="dy-macro-item-code">${escapeHtml(macro.code.substring(0, 100))}${macro.code.length > 100 ? '...' : ''}</div>
                <div class="dy-macro-item-templates" style="font-size:11px;color:#aaa;margin-top:4px">
                    ${templatesUsingMacro.length > 0 ? `被 ${templatesUsingMacro.length} 个模板使用: ${escapeHtml(templatesUsingMacro.slice(0, 3).join(', '))}${templatesUsingMacro.length > 3 ? '...' : ''}` : '未被任何模板使用'}
                </div>
                <div class="dy-macro-actions">
                    <button class="dy-btn dy-macro-toggle" data-name="${escapeAttr(name)}">${macro.enabled ? '禁用' : '启用'}</button>
                    <button class="dy-btn dy-macro-edit" data-name="${escapeAttr(name)}">编辑</button>
                    <button class="dy-btn dy-macro-delete" data-name="${escapeAttr(name)}">删除</button>
                </div>
            `;
            manageList.appendChild(li);
        });

        // Populate apply list - show all templates with macro assignment interface
        Object.keys(persistent).forEach(templateName => {
            const templateData = persistent[templateName];

            const li = document.createElement('li');
            li.className = 'dy-macro-item';
            li.innerHTML = `
                <div class="dy-macro-item-name">${escapeHtml(templateName)}</div>
                <div class="dy-macro-item-desc">当前宏: ${templateData.macros && templateData.macros.length > 0 ? escapeHtml(templateData.macros.join(', ')) : '无'}</div>
                <div class="dy-macro-assign" style="margin-top:8px">
                    <select class="dy-macro-select" data-template="${escapeAttr(templateName)}" style="width:100%;padding:4px;margin-bottom:4px;">
                        <option value="">选择宏...</option>
                        ${Object.entries(macros).map(([name, macro]) =>
                            `<option value="${escapeAttr(name)}" ${templateData.macros && templateData.macros.includes(name) ? 'selected' : ''}>${escapeHtml(name)}</option>`
                        ).join('')}
                    </select>
                    <button class="dy-btn dy-macro-assign-btn" data-template="${escapeAttr(templateName)}">添加宏到模板</button>
                    <button class="dy-btn dy-macro-clear-btn" data-template="${escapeAttr(templateName)}" style="margin-top:4px;">清空模板宏</button>
                </div>
            `;
            applyList.appendChild(li);
        });

        // If no templates exist, show a message
        if (applyList.children.length === 0) {
            const li = document.createElement('li');
            li.className = 'dy-macro-item';
            li.innerHTML = `<div class="dy-macro-item-desc" style="text-align:center;color:#aaa">暂无续火花目标</div>`;
            applyList.appendChild(li);
        }

        // Bind events for manage list
        document.querySelectorAll('.dy-macro-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const name = e.currentTarget.dataset.name;
                toggleMacro(name);
                renderMacroLists(); // Refresh the lists
            });
        });

        document.querySelectorAll('.dy-macro-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const name = e.currentTarget.dataset.name;
                const macro = macros[name];
                if (macro) {
                    document.getElementById('dy-macro-name').value = name;
                    document.getElementById('dy-macro-desc').value = macro.description || '';
                    document.getElementById('dy-macro-code').value = macro.code;

                    // Also update the Monaco editor if it exists
                    if (window.__dy_macro_monaco_editor && window.__dy_macro_monaco_editor.getModel) {
                        window.__dy_macro_monaco_editor.getModel().setValue(macro.code);
                    } else {
                        document.getElementById('dy-macro-code').value = macro.code;
                    }
                }
            });
        });

        document.querySelectorAll('.dy-macro-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const name = e.currentTarget.dataset.name;
                if (confirm(`确定要删除宏 "${name}" 吗？\n注意：此宏可能被某些模板使用，删除后这些模板将无法执行该宏。`)) {
                    deleteMacro(name);
                    renderMacroLists(); // Refresh the lists
                    // Clear form if the deleted macro was being edited
                    if (document.getElementById('dy-macro-name').value === name) {
                        document.getElementById('dy-macro-name').value = '';
                        document.getElementById('dy-macro-desc').value = '';
                        document.getElementById('dy-macro-code').value = '';

                        // Clear Monaco editor if it exists
                        if (window.__dy_macro_monaco_editor && window.__dy_macro_monaco_editor.getModel) {
                            window.__dy_macro_monaco_editor.getModel().setValue('');
                        }
                    }
                }
            });
        });

        // Bind events for macro assignment
        document.querySelectorAll('.dy-macro-assign-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const templateName = e.currentTarget.dataset.template;
                const selectElement = document.querySelector(`.dy-macro-select[data-template="${escapeAttr(templateName)}"]`);
                const macroName = selectElement.value;

                if (!macroName) {
                    notify('错误', '请选择一个宏');
                    return;
                }

                // Add macro to template
                if (!persistent[templateName]) {
                    persistent[templateName] = { template: '', macros: [] };
                }

                if (!persistent[templateName].macros) {
                    persistent[templateName].macros = [];
                }

                // Avoid duplicates
                if (!persistent[templateName].macros.includes(macroName)) {
                    persistent[templateName].macros.push(macroName);
                    savePersistent();
                    renderMacroLists(); // Refresh the lists
                    notify('成功', `宏 "${macroName}" 已添加到模板 "${templateName}"`);
                } else {
                    notify('提示', `宏 "${macroName}" 已存在于模板 "${templateName}" 中`);
                }
            });
        });

        document.querySelectorAll('.dy-macro-clear-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const templateName = e.currentTarget.dataset.template;

                if (confirm(`确定要清空 "${templateName}" 的所有宏吗？`)) {
                    if (persistent[templateName]) {
                        persistent[templateName].macros = [];
                        savePersistent();
                        renderMacroLists(); // Refresh the lists
                        notify('成功', `模板 "${templateName}" 的宏已清空`);
                    }
                }
            });
        });
    }

    function saveMacroFromForm() {
        const nameInput = document.getElementById('dy-macro-name');
        const descInput = document.getElementById('dy-macro-desc');
        const codeInput = document.getElementById('dy-macro-code');

        const name = nameInput.value.trim();
        const desc = descInput.value.trim();

        // Get code from Monaco editor if available, otherwise from textarea
        let code = '';
        if (window.__dy_macro_monaco_editor && window.__dy_macro_monaco_editor.getModel) {
            code = window.__dy_macro_monaco_editor.getModel().getValue();
        } else {
            code = codeInput.value.trim();
        }

        if (!name || !code) {
            notify('错误', '宏名称和代码不能为空');
            return;
        }

        // Check if macro exists to update or add new
        if (macros[name]) {
            updateMacro(name, code, desc, macros[name].enabled);
            notify('成功', `宏 "${name}" 已更新`);
        } else {
            addMacro(name, code, desc);
            notify('成功', `宏 "${name}" 已创建`);
        }

        // Refresh lists and clear form
        renderMacroLists();
        nameInput.value = '';
        descInput.value = '';

        // Clear both textarea and Monaco editor
        codeInput.value = '';
        if (window.__dy_macro_monaco_editor && window.__dy_macro_monaco_editor.getModel) {
            window.__dy_macro_monaco_editor.getModel().setValue('');
        }
    }

    function saveScheduleFromUI() {
        const timeInput = document.getElementById('dy-schedule-time');
        const sendModeSelect = document.getElementById('dy-send-mode');
        if (!timeInput || !sendModeSelect) return;

        settings.schedulerTime = timeInput.value || '';
        settings.sendMode = sendModeSelect.value || 'scheduled';
        settings.autoEnabled = true;
        saveSettings();
        startScheduler();
        updateSchedulerStatus();

        if (settings.sendMode === 'scheduled') {
            notify('已保存定时', `每天 ${settings.schedulerTime} 将批量发送续火花目标`);
        } else if (settings.sendMode === 'automatic') {
            notify('已启用自动发送', `将自动检查并发送给未发送的联系人`);
        }
    }

    function toggleScheduler() {
        settings.autoEnabled = !settings.autoEnabled;
        saveSettings();
        if (settings.autoEnabled) startScheduler(); else stopScheduler();
        updateSchedulerStatus();
    }

    function updateSchedulerStatus() {
        const statusEl = document.getElementById('dy-scheduler-status');
        const toggleBtn = document.getElementById('dy-toggle-scheduler');
        if (!statusEl || !toggleBtn) return;

        if (settings.autoEnabled) {
            if (settings.sendMode === 'scheduled') {
                statusEl.textContent = `定时启用：${settings.schedulerTime || '(无时间)'}，间隔 ${settings.sendIntervalSec}s`;
            } else if (settings.sendMode === 'automatic') {
                statusEl.textContent = `自动发送启用，间隔 ${settings.sendIntervalSec}s`;
            }
        } else {
            statusEl.textContent = '定时未启用';
        }

        toggleBtn.textContent = settings.autoEnabled ? '禁用定时' : '启用定时';
    }

    function startScheduler() {
        if (schedulerTimer) clearInterval(schedulerTimer);
        schedulerTimer = setInterval(schedulerTick, 30 * 1000);
        lastScheduledRun = '';
    }

    function stopScheduler() {
        if (schedulerTimer) clearInterval(schedulerTimer);
        schedulerTimer = null;
    }

    function schedulerTick() {
        if (!settings.autoEnabled) return;

        const now = new Date();
        const currentDate = now.toDateString();
        const hh = String(now.getHours()).padStart(2,'0');
        const mm = String(now.getMinutes()).padStart(2,'0');
        const cur = `${hh}:${mm}`;

        // Check if we're in scheduled mode
        if (settings.sendMode === 'scheduled') {
            if (settings.schedulerTime && cur === settings.schedulerTime && lastScheduledRun !== currentDate) {
                lastScheduledRun = currentDate;
                // 执行批量发送：续火花目标列表
                const names = Object.keys(persistent);
                if (names.length > 0) batchSend(names);
            }
        }
        // Check if we're in automatic mode
        else if (settings.sendMode === 'automatic') {
            // Check each target to see if it needs to be sent to today
            const names = Object.keys(persistent);
            const targetsToSend = [];

            for (const name of names) {
                const targetData = persistent[name];
                // If lastSendDate is not today, add to targets to send
                if (targetData.lastSendDate !== currentDate) {
                    targetsToSend.push(name);
                }
            }

            if (targetsToSend.length > 0) {
                // Update lastSendDate for all targets that will be sent
                for (const name of targetsToSend) {
                    persistent[name].lastSendDate = currentDate;
                }
                savePersistent();

                // Send to all targets that need to be sent
                batchSend(targetsToSend);
            }
        }
    }

    // 支持$开头的占位符
    function renderTemplate(tpl, ctx, targetName = null) {
        // 预处理变量
        let out = preprocessVariables(tpl, ctx.targetName || '');

        try {
            // Execute macros associated with this specific template
            let macroCode = '';
            if (targetName && persistent[targetName] && persistent[targetName].macros) {
                // Get macros associated with this specific template
                const templateMacros = persistent[targetName].macros;
                for (const macroName of templateMacros) {
                    if (macros[macroName] && macros[macroName].code) {
                        // Preprocess variables in macro code as well
                        let processedMacroCode = preprocessVariables(macros[macroName].code, ctx.targetName || '');
                        macroCode += processedMacroCode + ';';
                    }
                }
            } else {
                // Fallback: execute globally enabled macros (for backward compatibility)
                for (const [name, macro] of Object.entries(macros)) {
                    if (macro.enabled && macro.code) {
                        // Preprocess variables in macro code as well
                        let processedMacroCode = preprocessVariables(macro.code, ctx.targetName || '');
                        macroCode += processedMacroCode + ';';
                    }
                }
            }

            // 将预处理后的代码直接视为JavaScript代码执行，先执行模板，再执行宏
            const result = eval(`(function(){let res="";${out};${macroCode};return res;})()`);
            return result;
        } catch (e) {
            return '错误: ' + e.message;
        }
    }

    function prepareExpr(expr, ctx) {
        // 提供 daysSince(name) 与 targetName 变量
        // 将 daysSince("2025-1-2") 替换为 number literal
        const replaced = expr.replace(/daysSince\((['\"])(.*?)\1\)/g, (_, q, d) => {
            return String(daysSince(d));
        }).replace(/targetName/g, JSON.stringify(ctx.targetName || ''));

        return replaced;
    }

    function daysSince(dateStr) {
        try {
            const d = new Date(dateStr);
            if (isNaN(d)) return 0;
            const now = new Date();
            const diff = now - d;
            return Math.floor(diff / (1000 * 60 * 60 * 24));
        } catch (e) { return 0; }
    }


    function findUserElementByName(name) {
        const els = document.querySelectorAll(SELECTORS.userName);
        for (const el of els) {
            if (el.textContent && el.textContent.trim() === name) return el;
        }
        return null;
    }

    function waitForChatInput(timeout = 8000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const tick = () => {
                const input = document.querySelector(SELECTORS.chatInput);
                if (input) return resolve(input);
                if (Date.now() - start > timeout) return reject(new Error('chat input timeout'));
                setTimeout(tick, 200);
            };
            tick();
        });
    }

    async function sendToTarget(name, message) {
        try {
            const el = findUserElementByName(name);
            if (!el) return false;

            // 点击目标
            try { el.click(); } catch (e) { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }

            await waitForPageLoadShort();
            const input = await waitForChatInput();

            // 填入内容
            input.textContent = '';
            input.focus();
            const lines = message.split('\n');
            for (let i = 0; i < lines.length; i++) {
                document.execCommand('insertText', false, lines[i]);
                if (i < lines.length - 1) document.execCommand('insertLineBreak');
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));

            // 点击发送
            const sendBtn = document.querySelector(SELECTORS.sendBtn);
            if (sendBtn) {
                if (!sendBtn.disabled) sendBtn.click();
                else return false;
                return true;
            }
            return false;
        } catch (e) {
            return false;
        }
    }

    function waitForPageLoadShort() {
        return new Promise(resolve => setTimeout(resolve, 600));
    }

    // 辅助：安全显示/转义
    function escapeHtml(s) { return String(s).replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
    function escapeAttr(s) { return String(s).replace(/"/g, '&quot;'); }

    function notify(title, text) {
        if (typeof GM_notification !== 'undefined') {
            try { GM_notification({ title, text, timeout: 3000 }); } catch (e) { console.log(title, text); }
        } else {
            console.log(title, text);
        }
    }

    // 执行JS代码 - 使用函数模板包装
    function executeScript(code) {
        try {
            // 将代码包装在函数中执行，使用模板处理
            const wrappedCode = '(function(){' + code + '})()';
            // 创建函数并执行
            const result = eval(wrappedCode);
            return result;
        } catch (e) {
            console.error('代码执行错误:', e);
            return { error: e.message };
        }
    }

    // 测试宏系统
    function testMacroSystem() {
        // Test that macros are properly integrated
        console.log('Testing macro system...');
        console.log('Current macros:', macros);
        console.log('Current persistent data:', persistent);

        // Test template rendering with macros
        const testTemplate = 'return "Hello " + targetName;';
        const context = { targetName: 'TestUser' };
        const result = renderTemplate(testTemplate, context, 'TestUser');
        console.log('Template result:', result);

    }

    // 测试自动发送功能
    function testAutoSendFeature() {
        console.log('Testing auto send feature...');
        console.log('Current settings:', settings);
        console.log('Current persistent data structure:', persistent);

        // Test that all persistent entries have lastSendDate
        for (const [name, data] of Object.entries(persistent)) {
            if (!data.hasOwnProperty('lastSendDate')) {
                console.error(`Missing lastSendDate for ${name}`);
            } else {
                console.log(`${name} lastSendDate: ${data.lastSendDate}`);
            }
        }

        // Test date comparison logic
        const today = new Date().toDateString();
        console.log('Today is:', today);

        // Test scheduler tick logic
        console.log('Testing scheduler tick with current settings...');
        console.log('Send mode:', settings.sendMode);
        console.log('Auto enabled:', settings.autoEnabled);
    }

    // 启动：加载持久化并创建面板，然后开始定期抓取
    function start() {
        loadPersistent();
        loadMacros();
        loadSettings();


        renderPanel();
        // 初次抓取
        autoFetchChats();
        // 定时抓取以应对DOM变化
        setInterval(autoFetchChats, 5000);
        // 启动 scheduler（若启用）
        if (settings.autoEnabled) startScheduler();

        // Test the macro system
        testMacroSystem();
        // Test the new auto send feature
        testAutoSendFeature();
    }

    // 全局快捷键菜单
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('打开续火目标面板', () => { renderPanel(); });
    }

    // 初始化
    start();

})();

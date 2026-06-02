// ==UserScript==
// @name         抖音火花助手
// @namespace    http://tampermonkey.net/
// @version      1.0.7
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
// @homepage   				https://github.com/WorldMargin2/DouYinSpark
// @source     				https://raw.githubusercontent.com/WorldMargin2/DouYinSpark/refs/heads/main/抖音火花助手.js
// ==/UserScript==

(function() {
    'use strict';

    const DEFAULT_TEMPLATE='res= \`自动续火花-$date\n$targetName\`';

    // 创建命名空间
    window.DouYinSpark = window.DouYinSpark || {};
    
    // 系统预设变量（不可删除，但可查看）
    const SYSTEM_VARS = {
        'date': {
            type: 'variable',
            value: 'new Date().toLocaleDateString()',
            description: '当前日期',
            isSystem: true
        },
        'targetName': {
            type: 'variable',
            value: 'targetName',
            description: '目标名称',
            isSystem: true
        },
        'sinceDate': {
            type: 'function',
            value: 'function(dateStr) { try { const d = new Date(dateStr); if (isNaN(d)) return 0; const now = new Date(); const diff = now - d; return Math.floor(diff / (1000 * 60 * 60 * 24)); } catch (e) { return 0; } }',
            description: '相识天数（需要参数：日期字符串）',
            isSystem: true
        }
    };
    
    // 预处理变量函数，用于替换编辑器中的变量
    function preprocessVariables(code, targetName) {
        let processedCode = code;
        
        // 合并系统变量和自定义变量
        const allVars = { ...SYSTEM_VARS, ...customVars };
        
        // 处理所有变量（包括系统变量和自定义变量）
        Object.entries(allVars).forEach(([varName, varData]) => {
            if (varData.type === 'function') {
                // 函数类型：查找 $varName(...) 并执行函数，直接替换为返回值
                const funcRegex = new RegExp(`\\$${varName}\\(([^)]*)\\)`, 'g');
                processedCode = processedCode.replace(funcRegex, (_, args) => {
                    try {
                        // 构建函数调用并执行：将函数定义包裹在括号中，然后调用
                        // 例如：(function(dateStr) {...})("2019-9-1")
                        const funcCode = `(${varData.value})(${args})`;
                        const result = eval(funcCode);
                        return result;
                    } catch (e) {
                        console.error(`[DouYinSpark] 执行函数 $${varName} 失败:`, e);
                        return '';
                    }
                });
            } else if (varData.type === 'variable') {
                // 变量类型：直接计算值并替换
                // 对于 $date 和 $targetName 等特殊变量，也直接计算值
                if (varName === 'date') {
                    const value = new Date().toLocaleDateString();
                    processedCode = processedCode.replace(new RegExp(`\\$${varName}\\b`, 'g'), value);
                } else if (varName === 'targetName') {
                    processedCode = processedCode.replace(new RegExp(`\\$${varName}\\b`, 'g'), targetName);
                } else {
                    // 自定义变量：计算表达式值
                    try {
                        const value = eval(varData.value);
                        processedCode = processedCode.replace(new RegExp(`\\$${varName}\\b`, 'g'), value);
                    } catch (e) {
                        console.error(`[DouYinSpark] 计算变量 $${varName} 失败:`, e);
                    }
                }
            }
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


    // 存储键 - 新命名空间
    const KEY_PERSIST = 'douyin_spark_persistent_targets_v1';
    const KEY_MACROS = 'douyin_spark_macros_v1';

    // 旧存储键 - 用于数据迁移
    const OLD_KEY_PERSIST = 'dy_fire_persistent_targets_v1';
    const OLD_KEY_MACROS = 'dy_fire_macros_v1';

    //聊天对象列表
    //.ReactVirtualized__Grid__innerScrollContainer  (非动态类名)


    const SELECTORS = {
        chatListContainer: '.ReactVirtualized__Grid__innerScrollContainer',
        userName: '[class*=item-header-name-]',
        chatInput: '[class*=chat-input-]',
        sendBtn: '[class*=chat-btn]',
        chatTabs: 'class*=[sub-tab-]',
        friendTab: '[class*=sub-tab-] span:nth-child(1)',  // 朋友私信
        strangerTab: '[class*=sub-tab-] span:nth-child(2)', // 陌生人私信
        groupTab: '[class*=sub-tab-] span:nth-child(3)',    // 群消息
    };

    // 内存数据
    let staged = []; // 暂存数组 of {name}
    let stagedWithTypes = new Map(); // Map of {name -> chatType} to track where each contact was found
    let persistent = {}; // { name: { template: string, macros: [], lastSendDate: string } }
    let activeEdit = null; // 当前编辑对象名
    let selectedSet = new Set(); // 选中用于批量发送的名字
    let macros = {}; // { name: { code: string, enabled: boolean, description: string } }

    const KEY_SETTINGS = 'douyin_spark_settings_v1';
    const KEY_CHAT_TYPES = 'douyin_spark_chat_types_v1';
    const KEY_CUSTOM_VARS = 'douyin_spark_custom_vars_v1';

    // 旧设置键 - 用于数据迁移
    const OLD_KEY_SETTINGS = 'dy_fire_settings_v1';
    const OLD_KEY_CHAT_TYPES = 'dy_fire_chat_types_v1';

    let settings = {
        schedulerTime: '', // 'HH:MM'
        sendIntervalSec: 3,
        autoEnabled: false,
        sendMode: 'scheduled', // 'scheduled' or 'automatic'
        theme: 'dark'
    };

    // 自定义变量：{ varName: { type: 'function' | 'variable', value: string } }
    let customVars = {};
    let schedulerTimer = null;
    let lastScheduledRun = '';

    function loadPersistent() {
        // 尝试从新键加载数据
        let raw = GM_getValue(KEY_PERSIST, null);
        
        // 如果新键没有数据，尝试从旧键迁移
        if (raw === null || raw === undefined || raw === '{}') {
            const oldRaw = GM_getValue(OLD_KEY_PERSIST, '{}');
            if (oldRaw && oldRaw !== '{}' && oldRaw !== 'null' && oldRaw !== 'undefined') {
                // 检测到旧数据，执行迁移
                try {
                    const oldData = typeof oldRaw === 'string' ? JSON.parse(oldRaw) : oldRaw;
                    if (Object.keys(oldData).length > 0) {
                        raw = oldRaw;
                        // 将旧数据写入新键
                        GM_setValue(KEY_PERSIST, raw);
                        console.log('[DouYinSpark] 数据迁移成功：从 dy_fire_persistent_targets_v1 迁移到 douyin_spark_persistent_targets_v1');
                    }
                } catch (e) {
                    console.error('[DouYinSpark] 数据迁移失败:', e);
                    raw = '{}';
                }
            }
        }
        
        if (raw === null || raw === undefined) {
            raw = '{}';
        }
        
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

    function loadCustomVars() {
        try {
            const raw = GM_getValue(KEY_CUSTOM_VARS, '{}');
            customVars = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
            customVars = {};
        }
    }

    function saveCustomVars() {
        try {
            GM_setValue(KEY_CUSTOM_VARS, JSON.stringify(customVars));
        } catch (e) {
            console.error('[DouYinSpark] 保存自定义变量失败:', e);
        }
    }


    // 注入样式表（一次）
    function injectStyles() {
        if (document.getElementById('dy-fire-styles')) return;
        let css = `
            /* 统一主题变量，便于全局风格调整 */
            :root {
                --dy-bg1: #1c1c22;
                --dy-bg2: #141418;
                --dy-text: #e6eef8;
                --dy-accent1: #ff6b8b;
                --dy-accent2: #ff2c54;
                --dy-accent-alt1: #4b5563;
                --dy-accent-alt2: #374151;
                --dy-success1: #10b981;
                --dy-success2: #059669;
                --dy-macro1: #8b5cf6;
                --dy-macro2: #7c3aed;
                --dy-muted: #bbb;
                --dy-radius: 12px;
                --dy-font: "Microsoft YaHei", Arial, sans-serif;
            }
            .dy-panel.dy-theme-light {
                --dy-bg1: #ffffff;
                --dy-bg2: #f8fafc;
                --dy-text: #0f1724;
                --dy-accent1: #2563eb; /* blue */
                --dy-accent2: #06b6d4; /* teal */
                --dy-accent-alt1: #6b7280; /* gray */
                --dy-accent-alt2: #374151; /* dark gray */
                --dy-muted: #6b7280;
                --dy-macro1: #10b981; /* green */
                --dy-macro2: #06b6d4; /* teal */
            }

            /* 全局按钮/面板基础覆盖，优先使用变量以便后续统一 */
            .dy-panel .dy-root { background: linear-gradient(180deg,var(--dy-bg1), var(--dy-bg2)); color: var(--dy-text); font-family: var(--dy-font); border-radius: var(--dy-radius); }
            .dy-panel .dy-btn { background: var(--dy-accent1); border:none; color:#fff; padding:6px 10px; height:32px; line-height:20px; border-radius:8px; cursor:pointer; font-size:13px; box-shadow:0 6px 18px rgba(255,44,84,0.12); transition: all 0.2s; }
            .dy-panel .dy-btn:hover { transform: translateY(-1px); box-shadow:0 8px 22px rgba(255,44,84,0.18); }
            .dy-panel .dy-btn:active { transform: translateY(0); }
            .dy-panel .dy-btn-send { background: var(--dy-success1); }
            .dy-panel .dy-btn-macro { background: var(--dy-macro1); }

            /* Legacy inline forms removed in favor of popup editors */

            /* update names dialog */
            .dy-update-dialog-overlay { position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px; }
            .dy-update-dialog { background:linear-gradient(180deg,var(--dy-bg1), var(--dy-bg2)); border-radius:12px;padding:20px;max-width:520px;box-shadow:0 8px 32px rgba(0,0,0,0.4); color:var(--dy-text); }
            .dy-update-dialog .dy-user-item { display:flex;align-items:center;padding:10px;margin:6px 0;background:rgba(255,255,255,0.03);border-radius:8px;cursor:pointer;transition:background 0.15s; }
            .dy-update-dialog .dy-user-item:hover { background:rgba(255,255,255,0.06); }
            .dy-update-dialog .dy-user-item img { width:40px;height:40px;border-radius:50%;margin-right:12px;object-fit:cover; }
            .dy-update-dialog .dy-user-item span { font-size:14px;color:var(--dy-text); }
            .dy-update-dialog .dy-update-title { color: var(--dy-text); margin: 0 0 12px 0; font-size:18px; }
            .dy-update-dialog .dy-update-desc { color: rgba(255,255,255,0.7); margin: 0 0 12px 0; font-size:13px; }
            .dy-update-list { max-height: 400px; overflow-y: auto; }
            .dy-update-footer { margin-top:16px; text-align:right; }

            /* small button variants and controls sizing */
            #dy-select-added-targets { margin-left: 10px; padding: 4px 8px; font-size: 11px; }
            #dy-send-mode { width: 120px; }
            #dy-interval-sec { width: 60px; }
            .dy-hidden { display: none; }
            .dy-text-right { text-align: right; margin-top: 6px; }

            /* Monaco container size helpers */
            .monaco-container { width: 100%; min-height: 120px; }
            .monaco-container.h300 { height: 300px; }
            .monaco-container.h200 { height: 200px; margin-top: 8px; }
            .monaco-container.h150 { min-height: 150px; height: 200px; border-radius: 8px; overflow: hidden; }

            /* 全局复用表单控件样式 */
            .dy-input, .dy-select { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.06); background: linear-gradient(180deg, transparent, rgba(255,255,255,0.02)); color: var(--dy-text); box-sizing: border-box; transition: box-shadow 120ms, border-color 120ms, transform 60ms; }
            .dy-input:focus, .dy-select:focus { outline: none; border-color: rgba(0,0,0,0.12); box-shadow: 0 6px 18px rgba(0,0,0,0.16); transform: translateY(-1px); }
            .dy-btn { padding: 8px 12px; border-radius: 8px; cursor: pointer; border: none; font-weight: 600; }
            .dy-btn:hover { transform: translateY(-1px); }
            .dy-btn-primary { background: linear-gradient(90deg,var(--dy-accent1),var(--dy-accent2)); color: #fff; }
            .dy-btn-light { background: transparent; border: 1px solid rgba(255,255,255,0.06); color: var(--dy-text); }
            /* Light theme overrides for inputs/buttons */
            .dy-panel.dy-theme-light .dy-input, .dy-panel.dy-theme-light .dy-select { border-color: rgba(0,0,0,0.08); background: linear-gradient(180deg, transparent, rgba(0,0,0,0.02)); color: var(--dy-text); }
            .dy-panel.dy-theme-light .dy-btn-primary { background: linear-gradient(90deg,var(--dy-accent1),var(--dy-accent2)); color:#fff; }

            /* Reusable scroll list class for vertical scroll and hidden horizontal overflow */
            .dy-scroll-list { max-height: 520px; overflow-y: auto; overflow-x: hidden; box-sizing: border-box; }

            /* Inline macro form buttons removed */
            .dy-var-desc.custom { margin-top:10px; font-size:11px; color:#888; }
            #dy-var-editor-monaco { border-radius:8px; overflow:hidden; }
            textarea.dy-monospace { font-family: monospace; }
            .textarea-full { width:100%; min-height:120px; margin-top:8px; }

            .dy-empty { padding:20px; text-align:center; color:#888; }
            .dy-var-system-label { color:#888; font-size:11px; margin-right:6px; }

            .dy-item-top.flex-between { display:flex; justify-content:space-between; align-items:center; gap: 8px; }
            .dy-item-label { flex:1; min-width:0; display: flex; align-items: center; gap: 6px; }
            .dy-item-avatar { width:24px; height:24px; border-radius:50%; vertical-align:middle; margin-right:6px; object-fit:cover; flex-shrink: 0; }
            .chat-type-label { background: var(--chat-type-bg, rgba(107,114,128,0.8)); color: white; padding:2px 6px; border-radius:4px; font-size:10px; margin-left:5px; display:inline-block; flex-shrink: 0; }
            .dy-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .dy-item-row { display:flex; justify-content:space-between; align-items:center; margin-top:6px; }
            .dy-item-date { font-size:11px; color:#aaa; }
            .dy-btn-menu { background:none; border:none; color:#aaa; cursor:pointer; font-size:16px; padding:2px 6px; }
            .dy-item-menu { display:none; position:absolute; right:0; top:100%; background:var(--dy-bg1); border:1px solid rgba(255,255,255,0.1); border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,0.3); z-index:1000; min-width:120px; margin-top:4px; }
            .dy-menu-item { width:100%; padding:8px 12px; background:none; border:none; color:var(--dy-text); cursor:pointer; text-align:left; }
            .dy-menu-item:hover { background: rgba(255,255,255,0.03); }
            .dy-var-uneditable { color:#888; font-size:10px; }
            .dy-macro-item-templates { font-size:11px; color:#aaa; margin-top:4px; }
            .dy-macro-assign { margin-top:8px; }
            .dy-cancel-update-btn { padding:8px 20px;background:linear-gradient(90deg,var(--dy-accent-alt1),var(--dy-accent-alt2));border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:14px; }

            .dy-panel { position: fixed; z-index: 9999; font-family: Microsoft YaHei; }
            .dy-panel .dy-root { 
                width: 100%;
                height: 100%;
                min-width: 400px;
                min-height: 300px;
                background: linear-gradient(180deg,#1c1c22, #141418); 
                color: #fff; 
                border-radius:12px; 
                padding:14px; 
                box-shadow: 0 20px 50px rgba(0,0,0,0.6); 
                position:relative;
                display: flex;
                flex-direction: column;
                box-sizing: border-box;
                overflow: hidden;
            }
            .dy-panel.dy-theme-light .dy-root { background: linear-gradient(180deg,#ffffff,#f3f4f6); color:#111 }
            .dy-panel .dy-header{ display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink: 0; }
            .dy-panel .dy-header strong{ font-size:16px }
            .dy-panel .dy-controls{ display:flex; gap:8px; align-items:center; flex-wrap: wrap; }
            .dy-panel .dy-body{ 
                display:flex; 
                gap:12px; 
                flex:1; 
                min-height: 0;
                overflow: hidden;
                margin-bottom: 10px;
            }
            .dy-panel .dy-column{ 
                flex:1; 
                background:rgba(255,255,255,0.03); 
                padding:10px; 
                border-radius:8px; 
                min-width: 180px;
                display: flex;
                flex-direction: column;
                overflow: visible;
            }
            .dy-panel .dy-column .dy-list-container {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
                min-height: 0;
                margin: 0 -10px;
                padding: 0 10px;
            }
            .dy-panel .dy-title{ font-size:12px; color:#bbb; margin-bottom:8px; flex-shrink: 0; }
            .dy-panel .dy-select-all{ margin-bottom:8px; flex-shrink: 0; }
            .dy-panel .dy-btn-light{ background: #4b5563; color:#fff }
            .dy-panel .dy-btn-add{ background: #2dd4bf; }
            .dy-panel .dy-btn-remove{ background: #f97316; }
            /* 亮色主题下菜单栏按钮统一使用灰色渐变 */
            .dy-panel.dy-theme-light .dy-btn {
                background: linear-gradient(90deg, rgb(55, 65, 81), rgb(75, 85, 99));
            }
            .dy-panel.dy-theme-light .dy-btn-light {
                background: linear-gradient(90deg, rgb(55, 65, 81), rgb(75, 85, 99));
            }
            .dy-panel input, .dy-panel textarea{ background:#0f1114; border:1px solid rgba(255,255,255,0.06); color:#e6eef8; padding:6px 10px; border-radius:6px; font-size:13px; transition: border-color 0.2s; }
            .dy-panel input:focus, .dy-panel textarea:focus { border-color: rgba(255,107,139,0.5); outline: none; }
            .dy-panel .dy-list{ padding:4px; margin:0; list-style:none; min-height: 0; overflow-y: visible; }
            .dy-panel .dy-item{ 
                display:block; 
                padding:10px 8px; 
                border-radius:8px; 
                margin-bottom:6px; 
                background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(0,0,0,0.02)); 
                border:1px solid rgba(255,255,255,0.03); 
                transition: all 0.2s;
                position: relative;
            }
            .dy-panel .dy-item:hover { background: rgba(255,255,255,0.05); border-color: rgba(255,107,139,0.3); }
            .dy-panel.dy-theme-light .dy-item:hover { background: rgba(0,0,0,0.08); border-color: rgba(0,0,0,0.2); }
            .dy-panel .dy-item + .dy-item{ margin-top:6px }
            .dy-panel .dy-item .dy-item-top{ display:flex; font-size:13px; color:#e6eef8; align-items: center; gap: 8px; }
            .dy-panel.dy-theme-light .dy-item .dy-item-top{ color:#111 }
            .dy-panel .dy-item-name{ 
                color:inherit; 
                font-weight: 500;
                display: block;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                flex: 1;
                min-width: 0;
            }
            .dy-panel .chat-type-label {
                white-space: nowrap;
            }
            .dy-panel.dy-theme-light .dy-item-name{ color:#111 }
            .dy-panel .dy-item .dy-item-actions{ display:flex; gap:6px; margin-top:8px; justify-content:flex-end; flex-wrap: wrap; }
            .dy-panel .dy-item label{ display:inline-flex; align-items:center; gap:8px; cursor: pointer; }
            .dy-panel .dy-resizer{ width:16px;height:16px; position:absolute; right:8px; bottom:8px; cursor:se-resize; border-radius:4px; background:linear-gradient(135deg, rgba(255,255,255,0.08), rgba(0,0,0,0.08)); transition: all 0.2s; }
            .dy-panel .dy-resizer:hover { background:linear-gradient(135deg, rgba(255,107,139,0.3), rgba(255,44,84,0.3)); }
            .dy-panel .dy-template-editor{ margin-top:10px; background:rgba(0,0,0,0.15); padding:10px; border-radius:8px; flex-shrink: 0; }
            .dy-panel .dy-tpl-desc{ font-size:12px; color:#ddd; margin-bottom:8px }
            .dy-panel .dy-settings-bottom{ 
                padding:10px; 
                border-top:1px solid rgba(255,255,255,0.03); 
                flex-shrink: 0;
                gap: 12px;
            }
            .dy-panel .dy-settings-bottom .dy-settings-row{ 
                display:flex; 
                gap:10px; 
                align-items:center; 
                flex-wrap: wrap;
            }
            .dy-panel .dy-settings-bottom label{ font-size:12px; min-width:100px; white-space: nowrap; }
            .dy-panel .dy-settings-bottom input[type=time], .dy-panel .dy-settings-bottom input[type=number]{ height:28px; padding:4px 8px; font-size:13px; }
            .dy-panel .dy-settings-bottom .dy-btn{ padding:6px 10px; height:30px; font-size:13px; }
            .dy-panel .dy-settings-bottom .dy-status{ font-size:12px; color:inherit; white-space: nowrap; }
            .dy-panel .dy-item-checkbox { margin-right: 8px; }
            /* 响应式布局 */
            @media (max-width: 768px) {
                .dy-panel .dy-root { width: calc(100vw - 20px) !important; height: auto !important; min-height: 400px; }
                .dy-panel .dy-body { flex-direction: column; }
                .dy-panel .dy-column { min-height: 200px; }
                .dy-panel .dy-header { flex-direction: column; gap: 8px; align-items: flex-start; }
                .dy-panel .dy-controls { width: 100%; justify-content: flex-start; }
                .dy-panel .dy-settings-bottom .dy-settings-row { flex-direction: column; align-items: flex-start; gap: 6px; }
                .dy-panel .dy-settings-bottom label { min-width: auto; }
            }
            @media (max-width: 480px) {
                .dy-panel .dy-btn { padding: 4px 8px; font-size: 12px; height: 28px; }
                .dy-panel .dy-controls { gap: 4px; }
            }
            /* 宏管理面板样式 */
            .dy-panel .dy-macro-panel { display: none; }
            .dy-panel .dy-macro-panel.active { display: block; }
            .dy-panel .dy-macro-body { 
                display: flex; 
                gap: 12px;
                flex: 1;
                min-height: 0;
                overflow: hidden;
            }
            .dy-panel .dy-macro-column { 
                flex: 1; 
                background: rgba(255,255,255,0.03); 
                padding: 10px; 
                border-radius: 8px; 
                min-width: 200px;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }
            .dy-panel .dy-macro-column .macro-list-container {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
                min-height: 0;
            }
            .dy-panel .dy-macro-column.manage-macros { border-right: 2px solid rgba(255,255,255,0.1); }
            .dy-panel .dy-macro-column.apply-macros { border-left: 2px solid rgba(255,255,255,0.1); }
            .dy-panel .dy-macro-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-shrink: 0; }
            .dy-panel .dy-macro-title { font-size: 14px; font-weight: bold; color: gray; }
            .dy-panel .dy-macro-item { padding: 10px; margin-bottom: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); transition: all 0.2s; }
            .dy-panel .dy-macro-item:hover { background: rgba(0,0,0,0.25); }
            .dy-panel .dy-macro-item.enabled { border-left: 3px solid #10b981; }
            .dy-panel .dy-macro-item.disabled { border-left: 3px solid #ef4444; opacity: 0.7; }
            .dy-panel .dy-macro-item-name { font-weight: bold; margin-bottom: 6px; }
            .dy-panel .dy-macro-item-desc { font-size: 12px; color: #aaa; margin-bottom: 8px; }
            .dy-panel .dy-macro-item-code { font-family: monospace; font-size: 11px; background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; overflow: auto; max-height: 80px; }
            .dy-panel .dy-macro-actions { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
            .dy-panel .dy-macro-toggle { padding: 4px 8px; font-size: 11px; }
            .dy-panel .dy-macro-edit { padding: 4px 8px; font-size: 11px; }
            .dy-panel .dy-macro-delete { padding: 4px 8px; font-size: 11px; }
            /* Inline macro form styles removed */
            .dy-panel .dy-macro-select { width: 100%; padding: 6px; border-radius: 6px; background: #0f1114; border: 1px solid rgba(255,255,255,0.06); color: #e6eef8; }
            /* 变量管理面板样式 */
            .dy-panel .dy-var-panel { display: none; }
            .dy-panel .dy-var-panel.active { display: block; }
            .dy-panel .dy-var-body { 
                display: flex; 
                gap: 12px;
                flex: 1;
                min-height: 0;
                overflow: hidden;
            }
            .dy-panel .dy-var-column { 
                flex: 1; 
                background: rgba(255,255,255,0.03); 
                padding: 10px; 
                border-radius: 8px; 
                min-width: 200px;
                display: flex;
                flex-direction: column;
                overflow: hidden;
            }
            .dy-panel .dy-var-column .var-list-container {
                flex: 1;
                overflow-y: auto;
                overflow-x: hidden;
                min-height: 0;
            }
            .dy-panel .dy-var-column.manage-vars { border-right: 2px solid rgba(255,255,255,0.1); }
            .dy-panel .dy-var-column.var-info { border-left: 2px solid rgba(255,255,255,0.1); }
            .dy-panel .dy-var-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-shrink: 0; }
            .dy-panel .dy-var-title { font-size: 14px; font-weight: bold; color: #e6eef8; }
            .dy-panel .dy-var-item { padding: 10px; margin-bottom: 8px; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid rgba(255,255,255,0.1); transition: all 0.2s; }
            .dy-panel .dy-var-item:hover { background: rgba(0,0,0,0.25); }
            .dy-panel .dy-var-item-name { font-weight: bold; margin-bottom: 6px; color: var(--dy-accent1); }
            .dy-panel .dy-var-item-type { font-size: 11px; color: #aaa; background: rgba(139,92,246,0.2); padding: 2px 6px; border-radius: 4px; display: inline-block; margin-bottom: 6px; }
            .dy-panel .dy-var-item-value { font-size: 11px; color: #e6eef8; background: rgba(0,0,0,0.3); padding: 6px; border-radius: 4px; overflow: auto; max-height: 60px; font-family: monospace; }
            .dy-panel .dy-var-actions { display: flex; gap: 4px; margin-top: 8px; flex-wrap: wrap; }
            .dy-panel .dy-var-edit { padding: 4px 8px; font-size: 11px; background: linear-gradient(90deg,var(--dy-accent2),var(--dy-accent1)); }
            .dy-panel .dy-var-delete { padding: 4px 8px; font-size: 11px; background: linear-gradient(90deg,#f97316,#ef4444); }
            /* Inline var form styles removed */
            .dy-panel .dy-var-desc { font-size: 12px; color: #aaa; margin-bottom: 10px; }
            /* 模态模板编辑器 */
            #dy-template-modal { position: fixed; left: 0; top: 0; right: 0; bottom: 0; display: none; z-index: 10000; }
            #dy-template-modal .dy-tpl-overlay { position: absolute; left:0;top:0;right:0;bottom:0; background: rgba(0,0,0,0.45); display:flex; align-items:center; justify-content:center; padding:20px; transition: opacity 200ms ease; }
            #dy-template-modal .dy-tpl-box { 
                width: min(900px, 96%); 
                height: min(600px, 80vh);
                background: linear-gradient(180deg,#0f1114,#09090a); 
                color:#fff; 
                border-radius:12px; 
                padding:16px; 
                box-shadow:0 14px 50px rgba(0,0,0,0.6); 
                max-height:90vh; 
                overflow:auto; 
                transition: all 0.3s ease;
                display: flex;
                flex-direction: column;
            }
            #dy-template-modal .dy-tpl-box.dy-fullscreen { width: 100%; height: 100%; max-width: 100%; max-height: 100%; border-radius: 0; }
            #dy-template-modal .dy-tpl-box.dy-fullscreen .dy-tpl-box-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
            #dy-template-modal .dy-tpl-box.dy-fullscreen .monaco-container { flex: 1; min-height: 200px; }
            #dy-template-modal .dy-tpl-box.dy-fullscreen .dy-tpl-preview { max-height: 150px; }
            #dy-template-modal .dy-tpl-box.dy-fullscreen .dy-tpl-box-foot { position: sticky; bottom: 0; background: inherit; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.1); }
            #dy-template-modal .dy-tpl-box-controls { display: flex; gap: 8px; flex-wrap: wrap; }
            #dy-template-modal .dy-tpl-fullscreen { font-size: 14px; padding: 6px 10px; }
            #dy-template-modal.dy-theme-light .dy-tpl-box { background: #fff; color:#111 }
            #dy-template-modal .dy-tpl-box-header{ display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap: wrap; gap: 8px; }
            #dy-template-modal textarea{ width:100%; box-sizing:border-box; min-height:120px; max-height:60vh; resize:vertical; padding:10px; border-radius:8px; font-size:13px; font-family: Consolas, "Courier New", monospace; transition: border-color 0.2s; }
            #dy-template-modal textarea:focus { border-color: rgba(255,107,139,0.5); outline: none; }
            #dy-template-modal .dy-tpl-box-body{ margin-bottom:12px; flex: 1; display: flex; flex-direction: column; }
            #dy-template-modal .dy-tpl-box-foot{ text-align:right; padding-top: 12px; border-top: 1px solid rgba(255,255,255,0.05); }
            #dy-template-modal .dy-tpl-desc{ font-size:13px; color: #cfd8e3; margin-bottom: 10px; }
            #dy-template-modal .dy-tpl-preview{ margin-top:12px; padding:10px; background: rgba(0,0,0,0.08); border-radius:8px; font-family: Consolas, "Courier New", monospace; font-size:13px; color:#e6eef8; max-height:200px; overflow:auto; }
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
            .dy-panel .dy-root.dy-minimized { 
                height: auto !important; 
                overflow: visible; 
                background: transparent; 
                box-shadow: none; 
                padding:6px 10px;
                min-height: auto;
            }
            .dy-panel .dy-root.dy-minimized .dy-body, 
            .dy-panel .dy-root.dy-minimized .dy-template-editor,
            .dy-panel .dy-root.dy-minimized .dy-settings-bottom { 
                display: none !important; 
            }
            .dy-panel .dy-root.dy-minimized .dy-resizer { display: none }
            .dy-panel .dy-root.dy-minimized .dy-header { margin-bottom: 0; }
            /* Panel 容器在最小化时也自动调整高度 */
            .dy-panel.dy-minimized { height: auto !important; }
            .dy-panel.dy-minimized > .dy-root { height: auto !important; }
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
            resizer.title = '拖动调整大小';
            panel.appendChild(resizer);
        }
        let resizing = false, startW = 0, startH = 0, startX = 0, startY = 0;
        resizer.addEventListener('mousedown', (e) => {
            resizing = true;
            const rect = panel.getBoundingClientRect();
            startW = rect.width; startH = rect.height; startX = e.clientX; startY = e.clientY;
            document.body.style.userSelect = 'none';
            resizer.style.background = 'linear-gradient(135deg, rgba(255,107,139,0.4), rgba(255,44,84,0.4))';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!resizing) return;
            const dx = e.clientX - startX; const dy = e.clientY - startY;
            const newW = Math.max(400, Math.min(window.innerWidth - 40, startW + dx));
            const newH = Math.max(300, Math.min(window.innerHeight - 40, startH + dy));
            panel.style.width = newW + 'px';
            panel.style.height = newH + 'px';
        });
        document.addEventListener('mouseup', () => { 
            if (resizing) {
                resizing = false; 
                document.body.style.userSelect = '';
                resizer.style.background = '';
                // 保存尺寸
                try {
                    const rect = panel.getBoundingClientRect();
                    settings.panel = settings.panel || {};
                    settings.panel.width = Math.round(Math.min(rect.width, window.innerWidth - 40));
                    settings.panel.height = Math.round(Math.min(rect.height, window.innerHeight - 40));
                    saveSettings();
                } catch (e) {}
            }
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
        // 同时在 panel 上添加类，确保 CSS 生效
        if (minimized) {
            panel.classList.add('dy-minimized');
        } else {
            panel.classList.remove('dy-minimized');
        }
        settings.panel = settings.panel || {};
        settings.panel.minimized = minimized;
        saveSettings();
        // 最小化时只保留 header
        if (minimized) {
            // 关闭模态（如果打开）
            try { closeTemplateModal(); } catch (e) {}
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
        // 尝试从新键加载数据
        let raw = GM_getValue(KEY_MACROS, null);
        
        // 如果新键没有数据，尝试从旧键迁移
        if (raw === null || raw === undefined || raw === '{}') {
            const oldRaw = GM_getValue(OLD_KEY_MACROS, '{}');
            if (oldRaw && oldRaw !== '{}' && oldRaw !== 'null' && oldRaw !== 'undefined') {
                try {
                    const oldData = typeof oldRaw === 'string' ? JSON.parse(oldRaw) : oldRaw;
                    if (Object.keys(oldData).length > 0) {
                        raw = oldRaw;
                        // 将旧数据写入新键
                        GM_setValue(KEY_MACROS, raw);
                        console.log('[DouYinSpark] 数据迁移成功：从 dy_fire_macros_v1 迁移到 douyin_spark_macros_v1');
                    }
                } catch (e) {
                    console.error('[DouYinSpark] 数据迁移失败:', e);
                    raw = '{}';
                }
            }
        }
        
        if (raw === null || raw === undefined) {
            raw = '{}';
        }
        
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
        // 尝试从新键加载数据
        let raw = GM_getValue(KEY_SETTINGS, null);
        
        // 如果新键没有数据，尝试从旧键迁移
        if (raw === null || raw === undefined) {
            const oldRaw = GM_getValue(OLD_KEY_SETTINGS, null);
            if (oldRaw && oldRaw !== 'null' && oldRaw !== 'undefined') {
                try {
                    const oldData = typeof oldRaw === 'string' ? JSON.parse(oldRaw) : oldRaw;
                    if (Object.keys(oldData).length > 0) {
                        raw = oldRaw;
                        // 将旧数据写入新键
                        GM_setValue(KEY_SETTINGS, raw);
                        console.log('[DouYinSpark] 数据迁移成功：从 dy_fire_settings_v1 迁移到 douyin_spark_settings_v1');
                    }
                } catch (e) {
                    console.error('[DouYinSpark] 数据迁移失败:', e);
                }
            }
        }
        
        if (raw) {
            try { settings = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (e) {}
        }
    }

    function saveSettings() {
        GM_setValue(KEY_SETTINGS, JSON.stringify(settings));
    }

    // Save chat types
    function saveChatTypes() {
        const chatTypesObj = Object.fromEntries(stagedWithTypes);
        GM_setValue(KEY_CHAT_TYPES, JSON.stringify(chatTypesObj));
    }

    // Load chat types
    function loadChatTypes() {
        // 尝试从新键加载数据
        let raw = GM_getValue(KEY_CHAT_TYPES, null);
        
        // 如果新键没有数据，尝试从旧键迁移
        if (raw === null || raw === undefined || raw === '{}') {
            const oldRaw = GM_getValue(OLD_KEY_CHAT_TYPES, '{}');
            if (oldRaw && oldRaw !== '{}' && oldRaw !== 'null' && oldRaw !== 'undefined') {
                try {
                    const oldData = typeof oldRaw === 'string' ? JSON.parse(oldRaw) : oldRaw;
                    if (Object.keys(oldData).length > 0) {
                        raw = oldRaw;
                        // 将旧数据写入新键
                        GM_setValue(KEY_CHAT_TYPES, raw);
                        console.log('[DouYinSpark] 数据迁移成功：从 dy_fire_chat_types_v1 迁移到 douyin_spark_chat_types_v1');
                    }
                } catch (e) {
                    console.error('[DouYinSpark] 数据迁移失败:', e);
                    raw = '{}';
                }
            }
        }
        
        if (raw === null || raw === undefined) {
            raw = '{}';
        }
        
        try {
            const chatTypesObj = typeof raw === 'string' ? JSON.parse(raw) : raw;
            stagedWithTypes = new Map(Object.entries(chatTypesObj));
        } catch (e) {
            stagedWithTypes = new Map();
        }
    }

    // 用于跟踪是否已经执行过完整的多标签页抓取
    let hasDoneInitialMultiTabFetch = false;

    // 从聊天列表容器中提取用户信息（名字和头像）
    function extractChatUsersFromContainer() {
        const users = [];
        const container = document.querySelector(SELECTORS.chatListContainer);
        
        if (!container) {
            // 如果找不到容器，则回退到原来的方式
            const els = document.querySelectorAll(SELECTORS.userName);
            els.forEach(el => {
                const name = el.textContent && el.textContent.trim();
                if (name) {
                    users.push({ name: name, avatar: '' });
                }
            });
            return users;
        }
        
        // 直接遍历容器的子元素（每个子元素就是一个聊天项，包含头像和名字）
        const chatItems = container.children;
        for (let i = 0; i < chatItems.length; i++) {
            const item = chatItems[i];
            const imgEl = item.querySelector('img');
            const nameEl = item.querySelector(SELECTORS.userName);
            
            const avatar = imgEl ? imgEl.src : '';
            const name = nameEl ? nameEl.textContent.trim() : '';
            
            if (name) {
                users.push({ name: name, avatar: avatar });
            }
        }
        
        return users;
    }

    // 从当前页面查找并更新聊天对象的名字（通过头像匹配）
    // 弹出选择聊天对象的窗口进行名字更新
    function showUpdateNamesDialog(targetOldName) {
        const container = document.querySelector(SELECTORS.chatListContainer);
        if (!container) {
            alert('未找到聊天列表容器，请确保在聊天页面');
            return;
        }
        
        // 获取当前页面上的所有用户
        const pageUsers = [];
        const chatItems = container.children;
        for (let i = 0; i < chatItems.length; i++) {
            const item = chatItems[i];
            const imgEl = item.querySelector('img');
            const nameEl = item.querySelector(SELECTORS.userName);
            
            if (imgEl && nameEl) {
                const avatar = imgEl.src;
                const name = nameEl.textContent.trim();
                if (avatar && name) {
                    pageUsers.push({ name, avatar });
                }
            }
        }
        
        if (pageUsers.length === 0) {
            alert('当前页面没有聊天对象');
            return;
        }
        
        // 创建弹窗
        const overlay = document.createElement('div');
        overlay.className = 'dy-update-dialog-overlay';

        const dialog = document.createElement('div');
        dialog.className = 'dy-update-dialog';

        dialog.innerHTML = `
            <h3 class="dy-update-title">更新 "${escapeHtml(targetOldName)}" 的名字</h3>
            <p class="dy-update-desc">从列表中选择一个新名字</p>
            <div class="dy-update-list">
                ${pageUsers.map(user => `
                    <div class="dy-user-item" data-name="${escapeAttr(user.name)}" data-avatar="${escapeAttr(user.avatar)}">
                        <img src="${escapeAttr(user.avatar)}" alt="avatar" />
                        <span>${escapeHtml(user.name)}</span>
                    </div>
                `).join('')}
            </div>
            <div class="dy-update-footer">
                <button class="dy-cancel-update-btn">取消</button>
            </div>
        `;
        
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);
        
        // 绑定用户选项点击事件
        dialog.querySelectorAll('.dy-user-item').forEach(item => {
            item.addEventListener('click', () => {
                const selectedName = item.dataset.name;
                const selectedAvatar = item.dataset.avatar;
                
                if (selectedName === targetOldName) {
                    alert('新名字与旧名字相同，无需更新');
                    if (document.body.contains(overlay)) {
                        document.body.removeChild(overlay);
                    }
                    return;
                }
                
                // 将旧名字 targetOldName 替换为新名字 selectedName
                const newStaged = [];
                let updated = false;
                
                staged.forEach(oldName => {
                    if (oldName === targetOldName) {
                        if (!newStaged.includes(selectedName)) {
                            newStaged.push(selectedName);
                        }
                        updated = true;
                    } else {
                        if (!newStaged.includes(oldName)) {
                            newStaged.push(oldName);
                        }
                    }
                });
                
                // 更新 persistent 中的键
                if (persistent[targetOldName]) {
                    persistent[selectedName] = {
                        ...persistent[targetOldName],
                        name: selectedName
                    };
                    delete persistent[targetOldName];
                }
                
                // 更新 stagedWithTypes
                const oldType = stagedWithTypes.get(targetOldName);
                if (oldType) {
                    stagedWithTypes.set(selectedName, oldType);
                    stagedWithTypes.delete(targetOldName);
                }
                
                // 保存更新
                if (persistent[selectedName]) {
                    staged = newStaged;
                    savePersistent();
                    saveChatTypes();
                    alert(`已将 "${targetOldName}" 更新为 "${selectedName}"`);
                } else if (updated) {
                    staged = newStaged;
                    savePersistent();
                    saveChatTypes();
                    alert(`已将 "${targetOldName}" 更新为 "${selectedName}"`);
                } else {
                    alert(`未找到 "${targetOldName}"`);
                }
                
                if (document.body.contains(overlay)) {
                    document.body.removeChild(overlay);
                }
                renderLists();
            });
        });
        
        // 绑定取消按钮事件
        const cancelBtn = dialog.querySelector('.dy-cancel-update-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                if (document.body.contains(overlay)) {
                    document.body.removeChild(overlay);
                }
            });
        }
    }

    // 自动更新名字（不弹窗，直接通过头像匹配更新）
    function updateNamesFromPage() {
        const container = document.querySelector(SELECTORS.chatListContainer);
        if (!container) return;
        
        // 获取当前页面上的所有用户（头像 -> 名字映射）
        const avatarToNameMap = new Map();
        const chatItems = container.children;
        for (let i = 0; i < chatItems.length; i++) {
            const item = chatItems[i];
            const imgEl = item.querySelector('img');
            const nameEl = item.querySelector(SELECTORS.userName);
            
            if (imgEl && nameEl) {
                const avatar = imgEl.src;
                const name = nameEl.textContent.trim();
                if (avatar && name) {
                    avatarToNameMap.set(avatar, name);
                }
            }
        }
        
        // 更新 staged 中的名字
        let updatedCount = 0;
        const newStaged = [];
        staged.forEach(oldName => {
            // 尝试在持久化中查找对应的头像
            const persistentData = persistent[oldName];
            if (persistentData && persistentData.avatar) {
                // 通过头像查找新名字
                const newName = avatarToNameMap.get(persistentData.avatar);
                if (newName && newName !== oldName) {
                    console.log(`更新名字：${oldName} -> ${newName}`);
                    newStaged.push(newName);
                    updatedCount++;
                    // 更新 stagedWithTypes
                    const oldType = stagedWithTypes.get(oldName);
                    if (oldType) {
                        stagedWithTypes.set(newName, oldType);
                        stagedWithTypes.delete(oldName);
                    }
                    // 更新 persistent 中的名字（保留头像）
                    persistent[newName] = {
                        ...persistent[oldName],
                        name: newName
                    };
                    delete persistent[oldName];
                } else {
                    newStaged.push(oldName);
                }
            } else {
                // 没有头像信息，保持原名
                newStaged.push(oldName);
            }
        });
        
        if (updatedCount > 0) {
            staged = newStaged;
            savePersistent();
            console.log(`更新了 ${updatedCount} 个聊天对象的名字`);
        }
    }

    // 自动抓取聊天列表到暂存（不加入已为续火花目标的对象）
    async function autoFetchChats(isPeriodic = false) {
        // 在抓取前先更新名字
        updateNamesFromPage();
        
        // 如果是周期性调用且已经完成过初始多标签页抓取，则只在当前标签页查找
        if (isPeriodic && hasDoneInitialMultiTabFetch) {
            // 只在当前标签页查找用户
            const users = extractChatUsersFromContainer();
            
            let added = 0;
            users.forEach(user => {
                const name = user.name;
                if (persistent[name]) return; // 已为续火花目标则忽略
                if (!staged.includes(name)) {
                    staged.push(name);
                    const currentTabType = determineCurrentTabType();
                    stagedWithTypes.set(name, currentTabType);
                    added++;
                }
            });

            if (added > 0) {
                renderPanel();
                saveChatTypes();
            }
            return;
        }

        // 如果还没有执行过多标签页抓取，或者不是周期性调用，则执行完整流程
        if (!hasDoneInitialMultiTabFetch) {
            hasDoneInitialMultiTabFetch = true;
        }

        try {
            // 首先尝试点击朋友私信标签页
            const friendTab = document.querySelector(SELECTORS.friendTab);
            if (friendTab) {
                friendTab.click();
                await waitForPageLoadShort();

                const users = extractChatUsersFromContainer();
                
                let added = 0;
                users.forEach(user => {
                    const name = user.name;
                    if (persistent[name]) return;
                    if (!staged.includes(name)) {
                        staged.push(name);
                        stagedWithTypes.set(name, 'friend');
                        added++;
                    }
                });

                if (added > 0) {
                    renderPanel();
                    saveChatTypes();
                }

                // 现在也获取陌生人和群聊的消息
                await fetchOtherChatTypes();
            } else {
                // 如果没有标签页，则按原来的方式处理
                const users = extractChatUsersFromContainer();
                
                let added = 0;
                users.forEach(user => {
                    const name = user.name;
                    if (persistent[name]) return;
                    if (!staged.includes(name)) {
                        staged.push(name);
                        stagedWithTypes.set(name, 'friend');
                        added++;
                    }
                });

                if (added > 0) {
                    renderPanel();
                    saveChatTypes();
                }
            }
        } catch (error) {
            console.error('Error in autoFetchChats:', error);
        }
    }

    // 获取其他类型聊天（陌生人、群聊）
    async function fetchOtherChatTypes() {
        try {
            // 获取陌生人消息
            const strangerTab = document.querySelector(SELECTORS.strangerTab);
            if (strangerTab) {
                strangerTab.click();
                await waitForPageLoadShort();

                const users = extractChatUsersFromContainer();
                
                let added = 0;
                users.forEach(user => {
                    const name = user.name;
                    if (persistent[name]) return;
                    if (!staged.includes(name)) {
                        staged.push(name);
                        stagedWithTypes.set(name, 'stranger');
                        added++;
                    }
                });

                if (added > 0) {
                    renderPanel();
                    saveChatTypes();
                }
            }

            // 获取群聊消息
            await fetchGroupChats();
        } catch (error) {
            console.error('Error in fetchOtherChatTypes:', error);
        }
    }

    // 获取群聊消息
    async function fetchGroupChats() {
        try {
            const groupTab = document.querySelector(SELECTORS.groupTab);
            if (groupTab) {
                groupTab.click();
                await waitForPageLoadShort();

                const users = extractChatUsersFromContainer();
                
                let added = 0;
                users.forEach(user => {
                    const name = user.name;
                    if (persistent[name]) return;
                    if (!staged.includes(name)) {
                        staged.push(name);
                        stagedWithTypes.set(name, 'group');
                        added++;
                    }
                });

                if (added > 0) {
                    renderPanel();
                    saveChatTypes();
                }
            }
        } catch (error) {
            console.error('Error in fetchGroupChats:', error);
        } finally {
            // 最后回到朋友私信标签页
            const friendTab = document.querySelector(SELECTORS.friendTab);
            if (friendTab) {
                friendTab.click();
            }
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
                        <button id="dy-var-manager" class="dy-btn dy-btn-macro">变量管理</button>
                        <button id="dy-theme-toggle" class="dy-btn dy-btn-light">主题</button>
                        <button id="dy-minimize" class="dy-btn dy-btn-light">—</button>
                        <button id="dy-close-panel" class="dy-btn dy-btn-light">×</button>
                    </div>
                </div>
                <div class="dy-body">
                    <div class="dy-column dy-staged">
                        <div class="dy-title">暂存列表</div>
                        <div class="dy-select-all">
                            <label><input type="checkbox" id="dy-select-all"/> 全选/反选</label>
                            <button id="dy-select-added-targets" class="dy-btn dy-btn-light">已添加目标全选</button>
                        </div>
                        <div class="dy-list-container">
                            <ul id="dy-staged-list" class="dy-list dy-scroll-list"></ul>
                        </div>
                    </div>
                    <div class="dy-column dy-persist">
                        <div class="dy-title">续火花目标</div>
                        <div class="dy-list-container">
                            <ul id="dy-persist-list" class="dy-list dy-scroll-list"></ul>
                        </div>
                    </div>
                </div>
                <div class="dy-settings dy-settings-bottom">
                    <div class="dy-settings-row">
                        <label>发送模式:</label>
                        <select id="dy-send-mode">
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
                        <input id="dy-interval-sec" type="number" min="1" value="3" />
                        <button id="dy-toggle-scheduler" class="dy-btn">启用定时</button>
                        <span id="dy-scheduler-status" class="dy-status"></span>
                    </div>
                    <div class="dy-settings-row">
                        <label><input id="dy-follow-system" type="checkbox" /> 跟随系统主题</label>
                    </div>
                </div>
                <div id="dy-template-editor" class="dy-template-editor dy-hidden">
                    <div class="dy-tpl-desc">为 <span id="dy-editor-target"></span> 编辑模板（支持 $date $targetName $sinceDate("YYYY-M-D") 和直接JavaScript代码）</div>
                    <textarea id="dy-editor-text"></textarea>
                    <div class="dy-text-right"><button id="dy-save-template" class="dy-btn">保存模板</button></div>
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
            if (settings.panel.minimized) {
                root.classList.add('dy-minimized');
                panel.classList.add('dy-minimized');
            }
        } else {
            // 默认位置
            panel.style.right = '20px';
            panel.style.top = '60px';
            panel.style.width = '680px';
            panel.style.height = '520px';
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
        const varManagerBtn = document.getElementById('dy-var-manager');
        if (varManagerBtn) varManagerBtn.addEventListener('click', () => {
            openVarManagerPanel();
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

    // 注册或刷新全局补全 provider（供所有 Monaco 实例使用）
    function __dy_refreshMonacoCompletions() {
        try {
            if (typeof monaco === 'undefined') return;
            // 清理之前的全局 disposable
            if (window.__dy_monaco_global_completion_disposable) {
                try { window.__dy_monaco_global_completion_disposable.dispose(); } catch (e) {}
                window.__dy_monaco_global_completion_disposable = null;
            }

            // 注册统一的补全 provider，动态读取最新的 customVars/macros
            const disposable = monaco.languages.registerCompletionItemProvider('javascript', {
                provideCompletionItems: function(model, position) {
                    const word = model.getWordUntilPosition(position);
                    const range = {
                        startLineNumber: position.lineNumber,
                        endLineNumber: position.lineNumber,
                        startColumn: word.startColumn,
                        endColumn: word.endColumn
                    };

                    const suggestions = [];

                    // 系统变量
                    try {
                        Object.keys(SYSTEM_VARS || {}).forEach(k => {
                            suggestions.push({ label: `$${k}`, kind: monaco.languages.CompletionItemKind.Variable, insertText: `$${k}`, range });
                        });
                    } catch (e) {}

                    // 自定义变量
                    try {
                        Object.entries(customVars || {}).forEach(([k, v]) => {
                            suggestions.push({ label: `$${k}`, kind: (v && v.type === 'function') ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Variable, insertText: (v && k === 'sinceDate') ? `$sinceDate("YYYY-M-D")` : `$${k}`, range, documentation: (v && v.description) || '' });
                        });
                    } catch (e) {}

                    // 宏名作为函数补全
                    try {
                        Object.keys(macros || {}).forEach(m => {
                            suggestions.push({ label: m, kind: monaco.languages.CompletionItemKind.Function, insertText: `${m}()`, range });
                        });
                    } catch (e) {}

                    return { suggestions };
                }
            });

            window.__dy_monaco_global_completion_disposable = disposable;
            
            // 触发所有 Monaco 编辑器实例刷新补全缓存（不强制弹出建议框）
            setTimeout(() => {
                try {
                    // 触发所有 Monaco 编辑器的补全缓存更新
                    if (monaco.editor) {
                        const editors = monaco.editor.getEditors();
                        if (editors && editors.length > 0) {
                            editors.forEach(editor => {
                                try {
                                    // 触发补全提供器刷新，但不自动弹出建议框
                                    const model = editor.getModel();
                                    if (model) {
                                        // 通过触发一个虚拟的输入事件来刷新补全缓存
                                        monaco.languages.trigger('javascript');
                                    }
                                } catch (e) {}
                            });
                        }
                    }
                } catch (e) {
                    console.warn('[DouYinSpark] 触发 Monaco 补全刷新失败', e);
                }
            }, 100);
        } catch (e) {
            console.error('[DouYinSpark] 刷新 Monaco 补全失败', e);
        }
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
                    <div class="dy-tpl-box-header"><strong>编辑模板</strong><div class="dy-tpl-box-controls"><button id="dy-tpl-var-manager" class="dy-btn dy-btn-macro" title="管理自定义变量">变量管理</button><button id="dy-tpl-fullscreen" class="dy-btn dy-btn-light" title="全屏显示">⛶</button><button id="dy-tpl-cancel" class="dy-btn dy-btn-light">取消</button></div></div>
                    <div class="dy-tpl-box-body">
                        <div class="dy-tpl-desc">为 <span id="dy-modal-editor-target"></span> 编辑模板（支持 $date $targetName $sinceDate("YYYY-M-D") 和直接 JavaScript 代码）</div>
                        <!-- Monaco Editor 容器 -->
                        <div id="dy-modal-editor-monaco" class="monaco-container h300"></div>
                        <textarea id="dy-modal-editor-text" rows="8" class="dy-hidden"></textarea>
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
        document.getElementById('dy-tpl-var-manager').addEventListener('click', () => {
            openVarManagerPanel();
        });

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
                        
                        // 合并系统变量和自定义变量
                        const allVars = { ...SYSTEM_VARS, ...customVars };
                        
                        const suggestions = [];
                        
                        // 添加所有变量补全（包括系统变量）
                        Object.entries(allVars).forEach(([varName, varData]) => {
                            let insertText = `$${varName}`;
                            if (varName === 'sinceDate') {
                                insertText = '$sinceDate("YYYY-M-D")';
                            }
                            suggestions.push({
                                label: `$${varName}`,
                                kind: varData.type === 'function' ? monaco.languages.CompletionItemKind.Function : monaco.languages.CompletionItemKind.Variable,
                                insertText: insertText,
                                range: range,
                                documentation: varData.description || (varData.type === 'function' ? `自定义函数：${varData.value}()` : `自定义变量：${varData.value}`)
                            });
                        });
                        
                        return { suggestions };
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

                // 移除�����的监听器（如果存在）
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
                            <button id="dy-open-macro-popup" class="dy-btn dy-btn-add">新建宏</button>
                            <button id="dy-macro-cancel" class="dy-btn dy-btn-light">关闭</button>
                        </div>
                    </div>
                    <div class="dy-macro-box-body">
                        <div class="dy-macro-body">
                            <div class="dy-macro-column manage-macros">
                                <div class="dy-title">管理宏</div>
                                <ul id="dy-manage-macros-list" class="dy-list dy-scroll-list"></ul>
                                <!-- Inline macro form removed; use popup editor instead -->
                            </div>
                            <div class="dy-macro-column apply-macros">
                                <div class="dy-title">应用宏</div>
                                <ul id="dy-apply-macros-list" class="dy-list dy-scroll-list"></ul>
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
                #dy-macro-modal.dy-theme-light .dy-btn-light {
                    background: linear-gradient(90deg, rgb(55, 65, 81), rgb(75, 85, 99));
                    border: none;
                    color: #fff;
                }
                #dy-macro-modal.dy-theme-light .dy-btn-light:hover {
                    background: linear-gradient(90deg, rgb(75, 85, 99), rgb(107, 114, 128));
                }
                #dy-macro-modal.dy-theme-light .dy-macro-column {
                    background: rgba(0,0,0,0.02);
                    border: 1px solid rgba(0,0,0,0.08);
                    box-shadow: 0 2px 4px rgba(0,0,0,0.04);
                }
                #dy-macro-modal.dy-theme-light .dy-macro-item {
                    background: #ffffff;
                    border: 1px solid rgba(0,0,0,0.12);
                    color: #1f2937;
                }
                #dy-macro-modal.dy-theme-light .dy-macro-item:hover {
                    background: rgba(0,0,0,0.08);
                    border-color: rgba(0,0,0,0.2);
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
                    border-right: 2px solid rgba(139, 92, 246, 0.12);
                }
                .dy-macro-column.apply-macros {
                    border-left: 2px solid rgba(59, 130, 246, 0.12);
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
                    color: var(--dy-accent1);
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
                    background: linear-gradient(to bottom, var(--dy-macro1), var(--dy-macro2));
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
                    color: gray;
                    font-size: 14px;
                }
                .dy-macro-item-name.dy-theme-light {
                    color: #111827;
                    font-weight: 600;
                }
                .dy-macro-item-desc {
                    font-size: 13px;
                    color: var(--dy-muted);
                    margin-bottom: 6px;
                }
                .dy-macro-item-desc.dy-theme-light {
                    color: #4b5563;
                    font-weight: 500;
                }
                .dy-macro-item-code {
                    font-family: 'Fira Code', 'Consolas', monospace;
                    font-size: 12px;
                    background: rgba(0,0,0,0.18);
                    padding: 6px;
                    border-radius: 4px;
                    overflow: auto;
                    max-height: 80px;
                    color: var(--dy-text);
                    border: 1px solid rgba(255,255,255,0.04);
                }
                .dy-macro-item-code.dy-theme-light {
                    background: rgba(0,0,0,0.04);
                    border: 1px solid rgba(0,0,0,0.1);
                    color: #1f2937;
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
                /* Inline macro form styles removed */
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
                    background: gray
                    width: 100%;
                    margin-top: 4px;
                    padding: 10px;
                    border-radius: 8px;
                    font-weight: 500;
                }
                .dy-macro-clear-btn {
                    background: gray;
                    width: 100%;
                    margin-top: 6px;
                    padding: 10px;
                    border-radius: 8px;
                    font-weight: 500;
                }
                .dy-macro-assign-btn:hover {
                    transform: translateY(-1px);
                    box-shadow: 0 4px 8px rgba(0,0,0,0.12);
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
                /* Inline macro form focus styles removed */
                /* Light theme overrides */
                .dy-macro-column.dy-theme-light {
                    background: rgba(0,0,0,0.02);
                    border: 1px solid rgba(0,0,0,0.08);
                }
                .dy-macro-item.dy-theme-light {
                    background: #ffffff;
                    border: 1px solid rgba(0,0,0,0.12);
                    color: #1f2937;
                }
                .dy-macro-item-name.dy-theme-light {
                    color: #111827;
                    font-weight: 600;
                }
                .dy-macro-item-desc.dy-theme-light {
                    color: #4b5563;
                    font-weight: 500;
                }
                .dy-macro-item-code.dy-theme-light {
                    background: rgba(0,0,0,0.04);
                    border: 1px solid rgba(0,0,0,0.1);
                    color: #1f2937;
                }
                /* Inline macro form light theme overrides removed */
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
                /* Ensure macro lists scroll vertically and hide horizontal overflow */
                #dy-manage-macros-list, #dy-apply-macros-list {
                    /* replaced by .dy-scroll-list */
                }
            `;
            document.head.appendChild(macroStyles);
        }

        // Event bindings for macro modal
        document.getElementById('dy-macro-cancel').addEventListener('click', closeMacroModal);
        // Legacy inline macro form removed; use popup editor instead
    }

    function openMacroManagerModal() {
        ensureMacroModalExists();
        const modal = document.getElementById('dy-macro-modal');
        if (!modal) return;

        // Apply theme
        if (settings.theme === 'light') modal.classList.add('dy-theme-light'); else modal.classList.remove('dy-theme-light');

        // Inline macro editor removed; popup editor is used instead

        // Show the modal
        modal.style.display = 'block';
        const overlay = modal.querySelector('.dy-macro-overlay');
        if (overlay) overlay.style.opacity = '1';

        // Bind open popup button
        const openBtn = document.getElementById('dy-open-macro-popup');
        if (openBtn && !openBtn._bound) {
            openBtn.addEventListener('click', () => {
                ensureMacroEditPopupExists();
                openMacroEditPopup();
            });
            openBtn._bound = true;
        }

        // Render macro lists
        renderMacroLists();
    }

    function closeMacroModal() {
        const modal = document.getElementById('dy-macro-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }

    // Variable Manager Functions
    function ensureVarModalExists() {
        if (document.getElementById('dy-var-modal')) return;
        const modal = document.createElement('div');
        modal.id = 'dy-var-modal';
        modal.style.display = 'none';
        modal.innerHTML = `
            <div class="dy-var-overlay">
                <div class="dy-var-box">
                        <div class="dy-var-box-header">
                        <strong>自定义变量管理</strong>
                        <div class="dy-var-box-controls">
                            <button id="dy-open-var-popup" class="dy-btn dy-btn-add">新建变量</button>
                            <button id="dy-var-cancel" class="dy-btn dy-btn-light">关闭</button>
                        </div>
                    </div>
                    <div class="dy-var-box-body">
                        <div class="dy-var-body">
                            <div class="dy-var-column manage-vars">
                                <div class="dy-var-header">
                                    <div class="dy-var-title">变量列表</div>
                                </div>
                                <ul id="dy-manage-vars-list" class="dy-list dy-scroll-list"></ul>
                                <div class="dy-var-desc custom">
                                    <strong>使用说明：</strong><br/>
                                    • 变量类型：函数（Function）或变量（Variable）<br/>
                                    • 函数：直接执行函数代码并返回结果，如 <code>$myFunc(123)</code><br/>
                                    • 变量：计算表达式值，如 <code>$myVar</code><br/>
                                    • 在模板中使用：<code>$varName</code>
                                </div>
                                <!-- Inline variable form removed; use popup editor instead -->
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        // Add CSS for the variable modal
        if (!document.getElementById('dy-var-styles')) {
            const varStyles = document.createElement('style');
            varStyles.id = 'dy-var-styles';
            varStyles.innerHTML = `
                #dy-var-modal {
                    position: fixed;
                    left: 0;
                    top: 0;
                    right: 0;
                    bottom: 0;
                    display: none;
                    z-index: 10002;
                }
                #dy-var-modal .dy-var-overlay {
                    position: absolute;
                    left:0; top:0; right:0; bottom:0;
                    background: rgba(0,0,0,0.65);
                    display:flex;
                    align-items:center;
                    justify-content:center;
                    padding:20px;
                    transition: opacity 200ms ease;
                }
                #dy-var-modal .dy-var-box {
                    width: min(900px, 96%);
                    background: linear-gradient(160deg, var(--dy-bg1), var(--dy-bg2));
                    color: var(--dy-text);
                    border-radius:16px;
                    padding:20px;
                    box-shadow:0 20px 60px rgba(0,0,0,0.55);
                    max-height:92vh;
                    overflow:auto;
                    transition: all 0.3s ease;
                    border: 1px solid rgba(255,255,255,0.06);
                    backdrop-filter: blur(10px);
                }
                #dy-var-modal .dy-var-box-header {
                    display:flex;
                    justify-content:space-between;
                    align-items:center;
                    margin-bottom:16px;
                    padding-bottom: 16px;
                    border-bottom: 1px solid rgba(255,255,255,0.1);
                }
                #dy-var-modal .dy-var-box-header strong {
                    font-size: 18px;
                    font-weight: 600;
                    background: gray;
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }
                #dy-var-modal .dy-var-box-controls {
                    display:flex;
                    gap: 8px;
                }
                #dy-var-modal .dy-var-box-body {
                    overflow-y: auto;
                    max-height: calc(92vh - 100px);
                }
                #dy-var-modal .dy-var-body {
                    display: flex;
                    gap: 20px;
                }
                #dy-var-modal .dy-var-column {
                    flex: 1;
                    min-width: 0;
                }
                #dy-var-modal .dy-var-header {
                    margin-bottom: 12px;
                }
                #dy-var-modal .dy-var-title {
                    font-size: 14px;
                    font-weight: 600;
                    color: var(--dy-accent1);
                    margin-bottom: 8px;
                }
                #dy-var-modal .dy-list {
                    list-style: none;
                    padding: 0;
                    margin: 0 0 16px 0;
                    max-height: 300px;
                    overflow-y: auto;
                }
                /* Ensure manage-vars list scrolls vertically and hides horizontal overflow (now shared via .dy-scroll-list) */
                #dy-manage-vars-list { /* replaced by .dy-scroll-list */ }
                #dy-var-modal .dy-var-item {
                    padding: 14px;
                    margin-bottom: 10px;
                    background: rgba(255,255,255,0.03);
                    border-radius: 10px;
                    border: 1px solid rgba(255,255,255,0.08);
                    transition: all 0.2s;
                }
                #dy-var-modal .dy-var-item:hover {
                    background: rgba(255,255,255,0.05);
                    border-color: var(--dy-accent1);
                    transform: translateX(4px);
                }
                #dy-var-modal .dy-var-item-name {
                    font-weight: 600;
                    color: var(--dy-accent1);
                    margin-bottom: 8px;
                    font-size: 15px;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                #dy-var-modal .dy-var-item-name::before {
                    content: '$';
                    color: var(--dy-accent2);
                    font-weight: bold;
                }
                #dy-var-modal .dy-var-item-type {
                    font-size: 10px;
                    color: var(--dy-accent1);
                    background: rgba(0,0,0,0.06);
                    padding: 3px 8px;
                    border-radius: 6px;
                    display: inline-block;
                    margin-bottom: 8px;
                    font-weight: 500;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                #dy-var-modal .dy-var-item-value {
                    font-size: 11px;
                    color: var(--dy-text);
                    background: rgba(0,0,0,0.18);
                    padding: 10px;
                    border-radius: 6px;
                    overflow: auto;
                    max-height: 100px;
                    font-family: 'JetBrains Mono', 'Fira Code', monospace;
                    white-space: pre-wrap;
                    word-break: break-all;
                    border: 1px solid rgba(255,255,255,0.04);
                }
                #dy-var-modal .dy-var-item-desc {
                    font-size: 10px;
                    color: var(--dy-muted);
                    margin-top: 6px;
                    font-style: italic;
                }
                #dy-var-modal .dy-var-actions {
                    display: flex;
                    gap: 8px;
                    margin-top: 12px;
                    flex-wrap: wrap;
                }
                #dy-var-modal .dy-var-edit,
                #dy-var-modal .dy-var-delete {
                    padding: 6px 14px;
                    font-size: 12px;
                    border: none;
                    border-radius: 8px;
                    cursor: pointer;
                    transition: all 0.2s;
                    font-weight: 500;
                }
                #dy-var-modal .dy-var-edit {
                    background: linear-gradient(135deg,var(--dy-accent2),var(--dy-accent1));
                    color: #fff;
                    box-shadow: 0 2px 8px rgba(0,0,0,0.12);
                }
                #dy-var-modal .dy-var-edit:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 16px rgba(0,0,0,0.16);
                }
                #dy-var-modal .dy-var-delete {
                    background: linear-gradient(135deg,#f97316,#ef4444);
                    color: #fff;
                    box-shadow: 0 2px 8px rgba(249,115,22,0.2);
                }
                #dy-var-modal .dy-var-delete:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 6px 16px rgba(249,115,22,0.4);
                }
                /* Inline var form styles removed */
                #dy-var-modal .dy-form-group {
                    margin-bottom: 14px;
                }
                #dy-var-modal .dy-form-group label {
                    display: block;
                    font-size: 12px;
                    font-weight: 600;
                    color: var(--dy-muted);
                    margin-bottom: 6px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                #dy-var-modal .dy-form-group input,
                #dy-var-modal .dy-form-group select {
                    width: 100%;
                    padding: 10px 14px;
                    border-radius: 8px;
                    border: 1px solid rgba(255,255,255,0.1);
                    background: rgba(0,0,0,0.3);
                    color: #e6eef8;
                    font-size: 13px;
                    transition: all 0.2s;
                    box-sizing: border-box;
                }
                #dy-var-modal .dy-form-group input:focus,
                #dy-var-modal .dy-form-group select:focus {
                    outline: none;
                    border-color: var(--dy-accent1);
                    box-shadow: 0 0 0 3px rgba(0,0,0,0.08);
                }
                #dy-var-modal .dy-form-group input::placeholder {
                    color: #475569;
                }
                #dy-var-modal .monaco-container {
                    border: 1px solid rgba(255,255,255,0.1);
                    border-radius: 8px;
                    overflow: hidden;
                    background: rgba(0,0,0,0.3);
                }
                #dy-var-modal .monaco-container:focus-within {
                    border-color: var(--dy-accent1);
                    box-shadow: 0 0 0 3px rgba(0,0,0,0.08);
                }
                #dy-var-modal .dy-var-desc {
                    background: rgba(0,0,0,0.06);
                    padding: 12px;
                    border-radius: 8px;
                    border-left: 3px solid var(--dy-accent1);
                    margin-bottom: 16px;
                }
                #dy-var-modal .dy-var-desc code {
                    background: rgba(0,0,0,0.18);
                    padding: 2px 6px;
                    border-radius: 4px;
                    font-family: 'JetBrains Mono', 'Fira Code', monospace;
                    font-size: 10px;
                    color: var(--dy-accent1);
                }
                /* Light theme overrides for variable modal */
                #dy-var-modal.dy-theme-light .dy-var-box {
                    background: linear-gradient(160deg, #ffffff, #f8fafc);
                    color: #111827;
                    border: 1px solid rgba(0,0,0,0.08);
                    box-shadow: 0 20px 60px rgba(0,0,0,0.15);
                }
                #dy-var-modal.dy-theme-light .dy-var-box-header {
                    border-bottom: 1px solid rgba(0,0,0,0.1);
                }
                #dy-var-modal.dy-theme-light .dy-var-column {
                    background: rgba(0,0,0,0.02);
                    border: 1px solid rgba(0,0,0,0.06);
                    box-shadow: 0 4px 6px rgba(0,0,0,0.03);
                }
                #dy-var-modal.dy-theme-light .dy-var-item {
                    background: rgba(0,0,0,0.02);
                    border: 1px solid rgba(0,0,0,0.08);
                }
                #dy-var-modal.dy-theme-light .dy-var-item-name {
                    color: #111827;
                    font-weight: 600;
                }
                #dy-var-modal.dy-theme-light .dy-var-item:hover {
                    background: rgba(0,0,0,0.08);
                    border-color: rgba(0,0,0,0.2);
                }
                #dy-var-modal.dy-theme-light .dy-var-item-type {
                    background: rgba(0,0,0,0.08);
                    color: #1f2937;
                    font-weight: 500;
                }
                #dy-var-modal.dy-theme-light .dy-var-item-value {
                    background: rgba(0,0,0,0.08);
                    border: 1px solid rgba(0,0,0,0.1);
                    color: #1f2937;
                }
                #dy-var-modal.dy-theme-light .dy-var-item-desc {
                    color: #4b5563;
                    font-weight: 500;
                }
                #dy-var-modal.dy-theme-light .dy-form-group label {
                    color: #374151;
                }
                #dy-var-modal.dy-theme-light .dy-form-group input,
                #dy-var-modal.dy-theme-light .dy-form-group select {
                    background: #ffffff;
                    border: 1px solid rgba(0,0,0,0.12);
                    color: #111827;
                }
                #dy-var-modal.dy-theme-light .dy-form-group input:focus,
                #dy-var-modal.dy-theme-light .dy-form-group select:focus {
                    border-color: var(--dy-accent1);
                    box-shadow: 0 0 0 3px rgba(0,0,0,0.06);
                }
                #dy-var-modal.dy-theme-light .dy-form-group input::placeholder {
                    color: #9ca3af;
                }
                #dy-var-modal.dy-theme-light .monaco-container {
                    background: #ffffff;
                    border: 1px solid rgba(0,0,0,0.12);
                }
                #dy-var-modal.dy-theme-light .monaco-container:focus-within {
                    border-color: var(--dy-accent1);
                    box-shadow: 0 0 0 3px rgba(0,0,0,0.06);
                }
                #dy-var-modal.dy-theme-light .dy-var-desc {
                    background: rgba(0,0,0,0.03);
                    border-left-color: var(--dy-accent1);
                }
                #dy-var-modal.dy-theme-light .dy-var-desc code {
                    background: rgba(0,0,0,0.08);
                    color: #1f2937;
                    font-weight: 500;
                }
                #dy-var-modal.dy-theme-light .dy-btn-light {
                    background: linear-gradient(90deg, rgb(55, 65, 81), rgb(75, 85, 99));
                    border: none;
                    color: #fff;
                }
                #dy-var-modal.dy-theme-light .dy-btn-light:hover {
                    background: linear-gradient(90deg, rgb(75, 85, 99), rgb(107, 114, 128));
                }
            `;
            document.head.appendChild(varStyles);
        }

        // Event bindings
        document.getElementById('dy-var-cancel').addEventListener('click', closeVarModal);
        // Legacy inline var form removed; popup editor is used instead
        // Render variable list
        renderVarList();
    }

    // Monaco loader state
    let monacoLoading = false;

    function loadMonacoEditor() {
        return new Promise((resolve, reject) => {
            if (typeof monaco !== 'undefined') {
                resolve(monaco);
                return;
            }

            if (monacoLoading) {
                // Wait for loading to complete
                const checkInterval = setInterval(() => {
                    if (typeof monaco !== 'undefined') {
                        clearInterval(checkInterval);
                        resolve(monaco);
                    }
                }, 100);
                setTimeout(() => {
                    clearInterval(checkInterval);
                    reject(new Error('Monaco Editor loading timeout'));
                }, 10000);
                return;
            }

            monacoLoading = true;

            // Load Monaco Editor loader
            const loaderScript = document.createElement('script');
            loaderScript.src = 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js';
            loaderScript.onload = () => {
                // Configure Monaco loader
                if (typeof require !== 'undefined' && require.config) {
                    require.config({
                        paths: {
                            'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs'
                        }
                    });
                    
                    // Load Monaco Editor
                    require(['vs/editor/editor.main'], () => {
                        monacoLoading = false;
                        resolve(monaco);
                    }, reject);
                } else {
                    monacoLoading = false;
                    reject(new Error('Require.js not available'));
                }
            };
            loaderScript.onerror = () => {
                monacoLoading = false;
                reject(new Error('Failed to load Monaco Editor loader'));
            };
            document.head.appendChild(loaderScript);
        });
    }

    // varMonacoEditor and inline var editor removed; use popup Monaco instances instead

    function openVarManagerPanel() {
        ensureVarModalExists();
        const modal = document.getElementById('dy-var-modal');
        if (!modal) return;

        // Apply theme
        if (settings.theme === 'light') modal.classList.add('dy-theme-light'); else modal.classList.remove('dy-theme-light');

        // Show the modal
        modal.style.display = 'block';
        const overlay = modal.querySelector('.dy-var-overlay');
        if (overlay) overlay.style.opacity = '1';

        // Bind open popup button
        const openVarBtn = document.getElementById('dy-open-var-popup');
        if (openVarBtn && !openVarBtn._bound) {
            openVarBtn.addEventListener('click', () => {
                ensureVarEditPopupExists();
                openVarEditPopup();
            });
            openVarBtn._bound = true;
        }

        // Re-initialize Monaco Editor when opening panel
        setTimeout(() => {
            initVarMonacoEditor();
        }, 100);

        // Render variable list
        renderVarList();
    }

    function closeVarModal() {
        const modal = document.getElementById('dy-var-modal');
        if (!modal) return;
        modal.style.display = 'none';
    }

    function renderVarList() {
        const list = document.getElementById('dy-manage-vars-list');
        if (!list) return;

        list.innerHTML = '';

        // 合并系统变量和自定义变量
        const allVars = { ...SYSTEM_VARS, ...customVars };
        
        if (Object.keys(allVars).length === 0) {
            list.innerHTML = '<li class="dy-empty">暂无变量</li>';
            return;
        }

        Object.entries(allVars).forEach(([varName, varData]) => {
            const li = document.createElement('li');
            li.className = 'dy-var-item';
            const typeLabel = varData.type === 'function' ? '函数（Function）' : '变量（Variable）';
            const isSystem = varData.isSystem;
            
            li.innerHTML = `
                <div class="dy-var-item-name">${isSystem ? '<span class="dy-var-system-label">[系统]</span>' : ''}$${escapeHtml(varName)}</div>
                <div class="dy-var-item-type">${escapeHtml(typeLabel)} ${isSystem ? '<span class="dy-var-uneditable">(不可编辑)</span>' : ''}</div>
                ${!isSystem ? `
                <div class="dy-var-actions">
                    <button class="dy-var-edit" data-name="${escapeAttr(varName)}">编辑</button>
                    <button class="dy-var-delete" data-name="${escapeAttr(varName)}">删除</button>
                </div>
                ` : ''}
            `;
            list.appendChild(li);
        });

        // Bind events
        list.querySelectorAll('.dy-var-edit').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const varName = e.currentTarget.dataset.name;
                editVar(varName);
            });
        });

        list.querySelectorAll('.dy-var-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const varName = e.currentTarget.dataset.name;
                deleteVar(varName);
            });
        });
    }

    // Inline variable form save removed; use popup saveVarFromPopup

    function editVar(varName) {
        ensureVarEditPopupExists();
        openVarEditPopup(varName);
    }

    function deleteVar(varName) {
        if (!confirm(`确定要删除变量 $${varName} 吗？`)) return;

        delete customVars[varName];
        saveCustomVars();
        renderVarList();
    }

    // --- Macro Edit Popup ---
    function ensureMacroEditPopupExists() {
        if (document.getElementById('dy-macro-edit-popup')) return;
        const popup = document.createElement('div');
        popup.id = 'dy-macro-edit-popup';
        popup.style.display = 'none';
        popup.innerHTML = `
            <div class="dy-macro-popup-overlay">
                <div class="dy-macro-popup-box">
                    <div class="dy-macro-popup-header">
                        <strong id="dy-macro-popup-title">编辑宏</strong>
                        <div class="dy-macro-popup-controls">
                            <button id="dy-macro-popup-cancel" class="dy-btn dy-btn-light">取消</button>
                        </div>
                    </div>
                    <div class="dy-macro-popup-body">
                        <div class="dy-form-group"><label>名称</label><input id="dy-macro-popup-name" class="dy-input" type="text" /></div>
                            <div class="dy-form-group"><label>描述</label><input id="dy-macro-popup-desc" class="dy-input" type="text" /></div>
                            <div class="dy-form-group"><label>代码</label><div id="dy-macro-popup-editor" class="monaco-container h200" style="height:220px;border-radius:6px;overflow:hidden;"></div></div>
                            <div style="text-align:right;margin-top:8px;"><button id="dy-save-macro-popup" class="dy-btn dy-btn-primary">保存</button></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(popup);

        // popup styles (modernized)
        const s = document.createElement('style');
        s.id = 'dy-macro-edit-popup-styles';
        s.innerHTML = `
            #dy-macro-edit-popup { position: fixed; inset: 0; display: none; z-index: 10005; }
            #dy-macro-edit-popup .dy-macro-popup-overlay { position: absolute; inset: 0; display:flex; align-items:center; justify-content:center; padding:20px; background: rgba(2,6,23,0.45); backdrop-filter: blur(4px); }
            #dy-macro-edit-popup .dy-macro-popup-box { width: min(880px, 96%); max-width: 900px; background: linear-gradient(180deg, var(--dy-bg1, #0f1114), var(--dy-bg2, #09090a)); color: var(--dy-text, #e6eef8); padding: 20px; border-radius: 12px; box-shadow: 0 16px 48px rgba(2,6,23,0.6); border: 1px solid rgba(0,0,0,0.08); }
            #dy-macro-edit-popup .dy-macro-popup-header { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:12px; }
            #dy-macro-edit-popup .dy-macro-popup-header strong { font-size: 16px; }
            #dy-macro-edit-popup .dy-macro-popup-controls button { margin-left:8px; }
            #dy-macro-edit-popup .dy-form-group { margin-bottom: 12px; }
            #dy-macro-edit-popup label { display:block; font-size:12px; color: var(--dy-muted); margin-bottom:6px; }
            #dy-macro-edit-popup input[type="text"] { width:100%; padding:10px 12px; border-radius:8px; border:1px solid rgba(0,0,0,0.06); background: rgba(255,255,255,0.02); color: var(--dy-text); }
            #dy-macro-edit-popup .monaco-container { border-radius:8px; overflow:hidden; border:1px solid rgba(0,0,0,0.06); }
            #dy-macro-edit-popup .dy-macro-popup-body { max-height: 72vh; overflow:auto; padding-right:6px; }
            #dy-macro-edit-popup .dy-btn { padding:8px 12px; border-radius:8px; font-weight:600; }
            #dy-macro-edit-popup .dy-btn.dy-btn-light { background: transparent; border:1px solid rgba(0,0,0,0.06); color: var(--dy-text, #e6eef8); }
            #dy-macro-edit-popup .dy-btn.dy-btn-primary { background: linear-gradient(90deg,var(--dy-accent1, #2563eb),var(--dy-accent2, #06b6d4)); color:#fff; border:none; border-radius:10px; box-shadow: 0 8px 18px rgba(2,6,23,0.18); transition: transform 120ms, box-shadow 120ms; }
            #dy-macro-edit-popup .dy-btn.dy-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(2,6,23,0.22); }
            #dy-macro-edit-popup .dy-btn.dy-btn-primary:active { transform: translateY(0); box-shadow: 0 6px 14px rgba(2,6,23,0.12); }
            #dy-macro-edit-popup .dy-btn { cursor: pointer; }
            #dy-macro-edit-popup .dy-input { width:100%; padding:10px 12px; border-radius:8px; border:1px solid rgba(0,0,0,0.06); background: var(--dy-bg2, rgba(255,255,255,0.02)); color: var(--dy-text, #e6eef8); }
            #dy-macro-edit-popup .dy-select { width:100%; padding:10px 12px; border-radius:8px; border:1px solid rgba(0,0,0,0.06); background: var(--dy-bg2, rgba(255,255,255,0.02)); color: var(--dy-text, #e6eef8); }
            #dy-macro-edit-popup .dy-mono { font-family: 'Fira Code', monospace; font-size:13px; }
            #dy-macro-edit-popup .dy-macro-popup-box.dy-theme-light { background: linear-gradient(180deg, var(--dy-bg1, #ffffff), var(--dy-bg2, #f8fafc)); color: var(--dy-text, #0f1724); border: 1px solid rgba(0,0,0,0.06); }
            #dy-macro-edit-popup .dy-macro-popup-box.dy-theme-light .dy-input, #dy-macro-edit-popup .dy-macro-popup-box.dy-theme-light .dy-select { background: var(--dy-bg2, #f8fafc); color: var(--dy-text, #0f1724); border: 1px solid rgba(0,0,0,0.08); }
            #dy-macro-edit-popup .dy-macro-popup-box.dy-theme-light label { color: #374151; }
            #dy-macro-edit-popup .dy-macro-popup-box.dy-theme-light .dy-btn-light { background: linear-gradient(90deg, rgb(55, 65, 81), rgb(75, 85, 99)); border: none; color: #fff; }
            #dy-macro-edit-popup .dy-macro-popup-box.dy-theme-light .dy-btn-light:hover { background: linear-gradient(90deg, rgb(75, 85, 99), rgb(107, 114, 128)); }
            @media (max-width: 640px) { #dy-macro-edit-popup .dy-macro-popup-box { width: 96%; padding: 14px; } }
        `;
        document.head.appendChild(s);

        document.getElementById('dy-macro-popup-cancel').addEventListener('click', closeMacroEditPopup);
        document.getElementById('dy-save-macro-popup').addEventListener('click', saveMacroFromPopup);
    }

    function openMacroEditPopup(name) {
        ensureMacroEditPopupExists();
        const popup = document.getElementById('dy-macro-edit-popup');
        if (!popup) return;
        document.getElementById('dy-macro-popup-title').textContent = name ? `编辑宏: ${name}` : '新建宏';
        document.getElementById('dy-macro-popup-name').value = name || '';
        document.getElementById('dy-macro-popup-desc').value = (name && macros[name] && macros[name].description) ? macros[name].description : '';
        popup.style.display = 'block';
        // Apply theme class to popup box for light/dark styling
        const vbox = popup.querySelector('.dy-var-popup-box');
        if (vbox) {
            if (settings && settings.theme === 'light') vbox.classList.add('dy-theme-light'); else vbox.classList.remove('dy-theme-light');
        }
        // Apply theme class to popup box for light/dark styling
        const box = popup.querySelector('.dy-macro-popup-box');
        if (box) {
            if (settings && settings.theme === 'light') box.classList.add('dy-theme-light'); else box.classList.remove('dy-theme-light');
        }

        // Initialize Monaco inside popup
        loadMonacoEditorOnce().then((monaco) => {
            const container = document.getElementById('dy-macro-popup-editor');
            if (!container || !monaco) return;
            if (!window.__dy_macro_popup_editor) {
                window.__dy_macro_popup_editor = monaco.editor.create(container, {
                    value: (name && macros[name] && macros[name].code) ? macros[name].code : '',
                    language: 'javascript',
                    theme: (settings && settings.theme === 'light') ? 'dy-light' : 'dy-dark',
                    lineNumbers: 'on',
                    wordWrap: 'on',
                    minimap: { enabled: false },
                    automaticLayout: true,
                });
                // Provide simple completions/snippets for macros
                monaco.languages.registerCompletionItemProvider('javascript', {
                    provideCompletionItems: function(model, position) {
                        const suggestions = [];
                        // basic helpers
                        const push = (s) => suggestions.push(s);
                        push({ label: '$targetName', kind: monaco.languages.CompletionItemKind.Variable, insertText: '$targetName' });
                        push({ label: '$date', kind: monaco.languages.CompletionItemKind.Variable, insertText: '$date' });
                        push({ label: '$sinceDate()', kind: monaco.languages.CompletionItemKind.Function, insertText: '$sinceDate("YYYY-M-D")' });
                        push({ label: 'daysSince()', kind: monaco.languages.CompletionItemKind.Function, insertText: 'daysSince("YYYY-M-D")' });
                        push({ label: 'for-loop', kind: monaco.languages.CompletionItemKind.Snippet, insertText: ['for (let i = 0; i < ${1:count}; i++) {', '\t$0', '}'].join('\n'), insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet });

                        // dynamic: custom variables
                        try {
                            Object.keys(customVars || {}).forEach(v => {
                                push({ label: `$${v}`, kind: monaco.languages.CompletionItemKind.Variable, insertText: `$${v}` });
                            });
                        } catch (e) {}

                        // dynamic: existing macro names
                        try {
                            Object.keys(macros || {}).forEach(m => {
                                push({ label: m, kind: monaco.languages.CompletionItemKind.Function, insertText: `${m}()` });
                            });
                        } catch (e) {}

                        return { suggestions };
                    }
                });
            } else {
                // update content and theme
                window.__dy_macro_popup_editor.setValue((name && macros[name] && macros[name].code) ? macros[name].code : '');
                monaco.editor.setTheme((settings && settings.theme === 'light') ? 'dy-light' : 'dy-dark');
            }
        });
    }

    function closeMacroEditPopup() { const p = document.getElementById('dy-macro-edit-popup'); if (p) p.style.display = 'none'; }

    function saveMacroFromPopup() {
        const nameInput = document.getElementById('dy-macro-popup-name');
        const descInput = document.getElementById('dy-macro-popup-desc');
        const codeInput = document.getElementById('dy-macro-popup-code');
        const name = nameInput.value.trim();
        const desc = descInput.value.trim();
        let code = '';
        if (window.__dy_macro_popup_editor && window.__dy_macro_popup_editor.getModel) {
            code = window.__dy_macro_popup_editor.getModel().getValue();
        } else if (codeInput) {
            code = codeInput.value.trim();
        }
        if (!name || !code) { alert('宏名称和代码不能为空'); return; }
        if (macros[name]) { updateMacro(name, code, desc, macros[name].enabled); notify('成功','宏已更新'); }
        else { addMacro(name, code, desc); notify('成功','宏已创建'); }
        renderMacroLists();
        closeMacroEditPopup();
        try { if (typeof __dy_refreshMonacoCompletions === 'function') __dy_refreshMonacoCompletions(); } catch (e) {}
    }

    // --- Var Edit Popup ---
    function ensureVarEditPopupExists() {
        if (document.getElementById('dy-var-edit-popup')) return;
        const popup = document.createElement('div');
        popup.id = 'dy-var-edit-popup';
        popup.style.display = 'none';
        popup.innerHTML = `
            <div class="dy-var-popup-overlay">
                <div class="dy-var-popup-box">
                    <div class="dy-var-popup-header">
                        <strong id="dy-var-popup-title">编辑变量</strong>
                        <div class="dy-var-popup-controls"><button id="dy-var-popup-cancel" class="dy-btn dy-btn-light">取消</button></div>
                    </div>
                    <div class="dy-var-popup-body">
                        <div class="dy-form-group"><label>变量名</label><input id="dy-var-popup-name" class="dy-input" type="text" /></div>
                        <div class="dy-form-group"><label>类型</label><select id="dy-var-popup-type" class="dy-select"><option value="function">函数</option><option value="variable">变量</option></select></div>
                        <div class="dy-form-group"><label>值/代码</label><div id="dy-var-popup-editor" class="monaco-container h150" style="height:160px;border-radius:6px;overflow:hidden;"></div></div>
                        <div style="text-align:right;margin-top:8px;"><button id="dy-save-var-popup" class="dy-btn dy-btn-primary">保存</button></div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(popup);

        const s = document.createElement('style'); s.id = 'dy-var-edit-popup-styles';
        s.innerHTML = `
            #dy-var-edit-popup { position: fixed; inset: 0; display: none; z-index: 10006; }
            #dy-var-edit-popup .dy-var-popup-overlay { position: absolute; inset: 0; display:flex; align-items:center; justify-content:center; padding:20px; background: rgba(2,6,23,0.45); backdrop-filter: blur(3px); }
            #dy-var-edit-popup .dy-var-popup-box { width: min(720px, 96%); max-width: 760px; background: linear-gradient(180deg, var(--dy-bg1, #0f1114), var(--dy-bg2, #09090a)); color: var(--dy-text, #e6eef8); padding: 18px; border-radius: 12px; box-shadow: 0 12px 36px rgba(2,6,23,0.55); border: 1px solid rgba(0,0,0,0.08); }
            #dy-var-edit-popup .dy-form-group { margin-bottom: 10px; }
            #dy-var-edit-popup label { display:block; font-size:12px; color: var(--dy-muted, #9CA3AF); margin-bottom:6px; }
            #dy-var-edit-popup .dy-input, #dy-var-edit-popup .dy-select { width:100%; padding:8px 10px; border-radius:8px; border:1px solid rgba(0,0,0,0.06); background: var(--dy-bg2, rgba(255,255,255,0.02)); color: var(--dy-text, #e6eef8); }
            #dy-var-edit-popup .monaco-container { border-radius:8px; overflow:hidden; border:1px solid rgba(0,0,0,0.06); }
            #dy-var-edit-popup .dy-btn { padding:8px 12px; border-radius:8px; }
            #dy-var-edit-popup .dy-btn.dy-btn-primary { background: linear-gradient(90deg,var(--dy-accent1, #2563eb),var(--dy-accent2, #06b6d4)); color:#fff; border:none; border-radius:10px; box-shadow: 0 8px 18px rgba(2,6,23,0.18); transition: transform 120ms, box-shadow 120ms; }
            #dy-var-edit-popup .dy-btn.dy-btn-primary:hover { transform: translateY(-2px); box-shadow: 0 12px 30px rgba(2,6,23,0.22); }
            #dy-var-edit-popup .dy-btn.dy-btn-primary:active { transform: translateY(0); box-shadow: 0 6px 14px rgba(2,6,23,0.12); }
            #dy-var-edit-popup .dy-var-popup-box.dy-theme-light { background: linear-gradient(180deg, var(--dy-bg1, #ffffff), var(--dy-bg2, #f8fafc)); color: var(--dy-text, #0f1724); border: 1px solid rgba(0,0,0,0.06); }
            #dy-var-edit-popup .dy-var-popup-box.dy-theme-light .dy-input, #dy-var-edit-popup .dy-var-popup-box.dy-theme-light .dy-select { background: var(--dy-bg2, #f8fafc); color: var(--dy-text, #0f1724); border: 1px solid rgba(0,0,0,0.08); }
            #dy-var-edit-popup .dy-var-popup-box.dy-theme-light label { color: #374151; }
            #dy-var-edit-popup .dy-var-popup-box.dy-theme-light .dy-btn-light { background: linear-gradient(90deg, rgb(55, 65, 81), rgb(75, 85, 99)); border: none; color: #fff; }
            #dy-var-edit-popup .dy-var-popup-box.dy-theme-light .dy-btn-light:hover { background: linear-gradient(90deg, rgb(75, 85, 99), rgb(107, 114, 128)); }
            @media (max-width: 640px) { #dy-var-edit-popup .dy-var-popup-box { width: 96%; padding: 12px; } }
        `;
        document.head.appendChild(s);

        document.getElementById('dy-var-popup-cancel').addEventListener('click', closeVarEditPopup);
        document.getElementById('dy-save-var-popup').addEventListener('click', saveVarFromPopup);
    }

    function openVarEditPopup(varName) {
        ensureVarEditPopupExists();
        const popup = document.getElementById('dy-var-edit-popup');
        if (!popup) return;
        document.getElementById('dy-var-popup-title').textContent = varName ? `编辑变量: ${varName}` : '新建变量';
        document.getElementById('dy-var-popup-name').value = varName || '';
        popup.style.display = 'block';

        // init Monaco for var popup
        loadMonacoEditorOnce().then((monaco) => {
            const container = document.getElementById('dy-var-popup-editor');
            if (!container || !monaco) return;
            if (!window.__dy_var_popup_editor) {
                window.__dy_var_popup_editor = monaco.editor.create(container, {
                    value: (varName && customVars[varName]) ? (customVars[varName].value || '') : '',
                    language: 'javascript',
                    theme: (settings && settings.theme === 'light') ? 'dy-light' : 'dy-dark',
                    lineNumbers: 'off',
                    wordWrap: 'on',
                    minimap: { enabled: false },
                    automaticLayout: true,
                });
                // Provide completions for variable expressions
                monaco.languages.registerCompletionItemProvider('javascript', {
                    provideCompletionItems: function(model, position) {
                        const suggestions = [];
                        const push = s => suggestions.push(s);
                        push({ label: '$targetName', kind: monaco.languages.CompletionItemKind.Variable, insertText: '$targetName' });
                        push({ label: '$date', kind: monaco.languages.CompletionItemKind.Variable, insertText: '$date' });
                        push({ label: '$sinceDate()', kind: monaco.languages.CompletionItemKind.Function, insertText: '$sinceDate("YYYY-M-D")' });
                        push({ label: 'daysSince()', kind: monaco.languages.CompletionItemKind.Function, insertText: 'daysSince("YYYY-M-D")' });
                        try { Object.keys(customVars || {}).forEach(v => push({ label: `$${v}`, kind: monaco.languages.CompletionItemKind.Variable, insertText: `$${v}` })); } catch (e) {}
                        return { suggestions };
                    }
                });
            } else {
                window.__dy_var_popup_editor.setValue((varName && customVars[varName]) ? (customVars[varName].value || '') : '');
                monaco.editor.setTheme((settings && settings.theme === 'light') ? 'dy-light' : 'dy-dark');
            }
        });
    }

    function closeVarEditPopup() { const p = document.getElementById('dy-var-edit-popup'); if (p) p.style.display = 'none'; }

    function saveVarFromPopup() {
        const name = document.getElementById('dy-var-popup-name').value.trim();
        const type = document.getElementById('dy-var-popup-type').value;
        let value = '';
        if (window.__dy_var_popup_editor && window.__dy_var_popup_editor.getModel) {
            value = window.__dy_var_popup_editor.getModel().getValue().trim();
        } else {
            const ta = document.getElementById('dy-var-popup-value');
            value = ta ? ta.value.trim() : '';
        }
        if (!name) { alert('请输入变量名称'); return; }
        if (!value) { alert('请输入变量值或函数代码'); return; }
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) { alert('变量名称只能包含字母、数字和下划线，且必须以字母或下划线开头'); return; }
        customVars[name] = { type, value };
        saveCustomVars();
        renderVarList();
        closeVarEditPopup();
        try { if (typeof __dy_refreshMonacoCompletions === 'function') __dy_refreshMonacoCompletions(); } catch (e) {}
        alert('变量保存成功');
    }


    // 从 DOM 获取用户头像
    function getUserAvatarFromDOM(name) {
        const container = document.querySelector(SELECTORS.chatListContainer);
        if (!container) return '';
        
        const chatItems = container.children;
        for (let i = 0; i < chatItems.length; i++) {
            const item = chatItems[i];
            const nameEl = item.querySelector(SELECTORS.userName);
            const itemName = nameEl ? nameEl.textContent.trim() : '';
            
            if (itemName === name) {
                const imgEl = item.querySelector('img');
                return imgEl ? imgEl.src : '';
            }
        }
        return '';
    }

    function renderLists() {
        const stagedList = document.getElementById('dy-staged-list');
        const persistList = document.getElementById('dy-persist-list');
        if (!stagedList || !persistList) return;

        stagedList.innerHTML = '';
        staged.forEach(name => {
            // Determine chat type and assign color
            const chatType = determineChatType(name);
            const typeLabel = getChatTypeLabel(chatType);
            const typeColor = getChatTypeColor(chatType);
            // Get avatar from DOM
            const avatar = getUserAvatarFromDOM(name);

            const li = document.createElement('li');
            li.className = 'dy-item';
            const targetData = persistent[name];
            const lastSendDate = targetData && targetData.lastSendDate ? `上次发送：${targetData.lastSendDate}` : '未发送';
            const isPersistent = !!persistent[name];
            li.innerHTML = `
                <div class="dy-item-top flex-between">
                    <label class="dy-item-label">
                        <input class="dy-select-checkbox" type="checkbox" data-name="${escapeAttr(name)}" ${selectedSet.has(name) ? 'checked' : ''} />
                        ${avatar ? `<img class="dy-item-avatar" src="${escapeAttr(avatar)}" />` : ''}
                        <span class="dy-item-name">${escapeHtml(name)}</span>
                        <span class="chat-type-label">${typeLabel}</span>
                    </label>
                    <button class="dy-btn dy-btn-send" data-name="${escapeAttr(name)}">发送</button>
                </div>
                <div class="dy-item-row">
                    <div class="dy-item-date">${escapeHtml(lastSendDate)}</div>
                    <button class="dy-btn-menu" data-name="${escapeAttr(name)}" data-action="menu">⋮</button>
                </div>
                <div class="dy-item-menu" id="menu-${escapeAttr(name)}">
                    ${!isPersistent ? `<button class="dy-menu-item dy-btn-persist" data-name="${escapeAttr(name)}">添加目标</button>` : ''}
                    <button class="dy-menu-item dy-btn-edit" data-name="${escapeAttr(name)}">模板</button>
                    <button class="dy-menu-item dy-btn-update" data-name="${escapeAttr(name)}">更新名字</button>
                    ${isPersistent ? `<button class="dy-menu-item dy-btn-unpersist" data-name="${escapeAttr(name)}">移除目标</button>` : ''}
                </div>
            `;
            // set per-item chat type background via CSS variable for easier theming
            try { li.style.setProperty('--chat-type-bg', typeColor); } catch (e) {}
            stagedList.appendChild(li);
        });

        persistList.innerHTML = '';
        Object.keys(persistent).forEach(name => {
            // Determine chat type and assign color for persistent items too
            const chatType = determineChatType(name);
            const typeLabel = getChatTypeLabel(chatType);
            const typeColor = getChatTypeColor(chatType);
            // Get avatar from DOM
            const avatar = getUserAvatarFromDOM(name);

            const targetData = persistent[name];
            const lastSendDate = targetData.lastSendDate ? `上次发送：${targetData.lastSendDate}` : '未发送';
            const li = document.createElement('li');
            li.className = 'dy-item';
            li.innerHTML = `
                <div class="dy-item-top flex-between">
                    <label class="dy-item-label">
                        <input class="dy-select-checkbox" type="checkbox" data-name="${escapeAttr(name)}" ${selectedSet.has(name) ? 'checked' : ''} />
                        ${avatar ? `<img class="dy-item-avatar" src="${escapeAttr(avatar)}" />` : ''}
                        <span class="dy-item-name">${escapeHtml(name)}</span>
                        <span class="chat-type-label">${typeLabel}</span>
                    </label>
                    <button class="dy-btn dy-btn-send" data-name="${escapeAttr(name)}">发送</button>
                </div>
                <div class="dy-item-row">
                    <div class="dy-item-date">${escapeHtml(lastSendDate)}</div>
                    <button class="dy-btn-menu" data-name="${escapeAttr(name)}" data-action="menu">⋮</button>
                </div>
                <div class="dy-item-menu" id="menu-${escapeAttr(name)}">
                    <button class="dy-menu-item dy-btn-edit" data-name="${escapeAttr(name)}">模板</button>
                    <button class="dy-menu-item dy-btn-update" data-name="${escapeAttr(name)}">更新名字</button>
                    <button class="dy-menu-item dy-btn-unpersist" data-name="${escapeAttr(name)}">移除目标</button>
                </div>
            `;
            // set per-item chat type background via CSS variable for easier theming
            try { li.style.setProperty('--chat-type-bg', typeColor); } catch (e) {}
            persistList.appendChild(li);
        });

        // 绑定菜单按钮事件
        document.querySelectorAll('.dy-btn-menu').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const name = btn.dataset.name;
                const menu = document.getElementById(`menu-${name}`);
                if (menu) {
                    // 关闭其他菜单
                    document.querySelectorAll('.dy-item-menu').forEach(m => {
                        if (m !== menu) m.style.display = 'none';
                    });
                    // 切换当前菜单
                    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
                }
            });
        });

        // 点击页面其他地方关闭所有菜单
        document.addEventListener('click', () => {
            document.querySelectorAll('.dy-item-menu').forEach(m => m.style.display = 'none');
        });

        // 绑定事件
        document.querySelectorAll('.dy-btn-persist').forEach(btn => btn.addEventListener('click', onPersist));
        document.querySelectorAll('.dy-btn-unpersist').forEach(btn => btn.addEventListener('click', onUnpersist));
        document.querySelectorAll('.dy-btn-edit').forEach(btn => btn.addEventListener('click', onEditTemplate));
        document.querySelectorAll('.dy-btn-send').forEach(btn => btn.addEventListener('click', onSendNow));
        document.querySelectorAll('.dy-btn-update').forEach(btn => btn.addEventListener('click', (e) => {
            const name = e.currentTarget.dataset.name;
            showUpdateNamesDialog(name);
        }));
        // checkbox 事件
        document.querySelectorAll('.dy-select-checkbox').forEach(cb => cb.addEventListener('change', onSelectToggle));
        const selectAll = document.getElementById('dy-select-all');
        if (selectAll) {
            // Update selectAll handler to include the new functionality
            selectAll.onchange = function(e) {
                const checked = e.target.checked;
                document.querySelectorAll('.dy-select-checkbox').forEach(cb => {
                    cb.checked = checked;
                    const name = cb.dataset.name;
                    if (checked) selectedSet.add(name);
                    else selectedSet.delete(name);
                });
            };
        }

        // Add event for the new "Select all added targets" button
        const selectAddedTargets = document.getElementById('dy-select-added-targets');
        if (selectAddedTargets) {
            selectAddedTargets.onclick = function() {
                // Clear current selection
                selectedSet.clear();

                // Select all checkboxes for items in persistent (added targets)
                document.querySelectorAll('.dy-select-checkbox').forEach(cb => {
                    const name = cb.dataset.name;
                    if (persistent[name]) { // If it's in persistent, it's an added target
                        cb.checked = true;
                        selectedSet.add(name);
                    } else {
                        cb.checked = false;
                    }
                });
            };
        }

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

        // Legacy inline macro form event bindings removed; macros edited via popup

        // 渲染宏列表
        renderMacroLists();
    }

    // Helper function to determine chat type based on context
    function determineChatType(name) {
        // Check if we have stored the chat type for this name
        if (stagedWithTypes.has(name)) {
            return stagedWithTypes.get(name);
        }

        // If not found in staged types, it might be a persistent contact
        // In this case, we could try to determine from other sources if needed
        // For now, return default
        return 'friend'; // Default fallback
    }

    // Helper function to get chat type label
    function getChatTypeLabel(type) {
        switch(type) {
            case 'group': return '群聊';
            case 'stranger': return '陌生人';
            case 'friend':
            default: return '朋友';
        }
    }

    // Helper function to get chat type color
    function getChatTypeColor(type) {
        switch(type) {
            case 'group': return 'var(--dy-accent1)'; // Blue for group (theme)
            case 'stranger': return 'var(--dy-accent-alt1)'; // Gray for stranger (theme)
            case 'friend':
            default: return 'var(--dy-success1)'; // Green for friend (theme)
        }
    }

    // Helper function to determine current active tab type
    function determineCurrentTabType() {
        try {
            // Check which tab is currently active by checking for active class or similar indicators
            const friendTab = document.querySelector(SELECTORS.friendTab);
            const strangerTab = document.querySelector(SELECTORS.strangerTab);
            const groupTab = document.querySelector(SELECTORS.groupTab);

            // This is a simplified detection - in practice, you'd check for active state classes
            // For now, we'll just return 'friend' as default for periodic checks
            // A more sophisticated implementation would check actual active states
            return 'friend';
        } catch (e) {
            return 'friend'; // Default fallback
        }
    }

    function onPersist(e) {
        const name = e.currentTarget.dataset.name;
        if (!name) return;
        if (!persistent[name]) {
            // 获取头像并保存
            const avatar = getUserAvatarFromDOM(name);
            persistent[name] = { 
                template: DEFAULT_TEMPLATE, 
                macros: [], 
                lastSendDate: '',
                avatar: avatar  // 保存头像
            };
        }
        // 从暂存移除
        staged = staged.filter(n => n !== name);
        // 保留类型信息，即使在 persistent 列表中也需要显示类型
        savePersistent();
        saveChatTypes(); // Save the chat types
        renderLists();
    }

    function onUnpersist(e) {
        const name = e.currentTarget.dataset.name;
        if (!name) return;
        delete persistent[name];
        savePersistent();
        saveChatTypes(); // Save the chat types
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
        // 刷新 Monaco 补全以实现实时更新
        try { if (typeof __dy_refreshMonacoCompletions === 'function') __dy_refreshMonacoCompletions(); } catch (e) {}
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
                <div class="dy-macro-item-templates">
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
                <div class="dy-macro-assign">
                    <select class="dy-macro-select" data-template="${escapeAttr(templateName)}">
                        <option value="">选择宏...</option>
                        ${Object.entries(macros).map(([name, macro]) =>
                            `<option value="${escapeAttr(name)}" ${templateData.macros && templateData.macros.includes(name) ? 'selected' : ''}>${escapeHtml(name)}</option>`
                        ).join('')}
                    </select>
                    <button class="dy-btn dy-macro-assign-btn" data-template="${escapeAttr(templateName)}">添加宏到模板</button>
                    <button class="dy-btn dy-macro-clear-btn" data-template="${escapeAttr(templateName)}">清空模板宏</button>
                </div>
            `;
            applyList.appendChild(li);
        });

        // If no templates exist, show a message
        if (applyList.children.length === 0) {
            const li = document.createElement('li');
            li.className = 'dy-macro-item';
            li.innerHTML = `<div class="dy-macro-item-desc dy-empty">暂无续火花目标</div>`;
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
                ensureMacroEditPopupExists();
                openMacroEditPopup(name);
            });
        });

        document.querySelectorAll('.dy-macro-delete').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const name = e.currentTarget.dataset.name;
                if (confirm(`确定要删除宏 "${name}" 吗？\n注意：此宏可能被某些模板使用，删除后这些模板将无法执行该宏。`)) {
                    deleteMacro(name);
                    renderMacroLists(); // Refresh the lists
                    // Legacy inline macro form removed; no inline fields to clear
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

    // Inline macro form save removed; use popup saveMacroFromPopup

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

            // 将预处理后的代码直接视为 JavaScript 代码执行，先执行模板，再执行宏
            // 所有变量已经在 preprocessVariables 中替换为实际值
            const result = eval(`(function(){
                let res="";
                ${out};
                ${macroCode};
                return res;
            })()`);
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
            // 首先尝试在当前标签页查找用户
            let el = findUserElementByName(name);

            // 如果没找到，尝试切换到不同的标签页查找
            if (!el) {
                // 尝试在陌生人标签页查找
                const strangerTab = document.querySelector(SELECTORS.strangerTab);
                if (strangerTab) {
                    strangerTab.click();
                    await waitForPageLoadShort();
                    el = findUserElementByName(name);
                }
            }

            if (!el) {
                // 尝试在群聊标签页查找
                const groupTab = document.querySelector(SELECTORS.groupTab);
                if (groupTab) {
                    groupTab.click();
                    await waitForPageLoadShort();
                    el = findUserElementByName(name);
                }
            }

            if (!el) {
                // 最后回到朋友标签页再找一次
                const friendTab = document.querySelector(SELECTORS.friendTab);
                if (friendTab) {
                    friendTab.click();
                    await waitForPageLoadShort();
                    el = findUserElementByName(name);
                }
            }

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



    // 启动：加载持久化并创建面板，然后开始定期抓取
    function start() {
        loadPersistent();
        loadMacros();
        loadSettings();
        loadChatTypes(); // Load chat type information
        loadCustomVars(); // Load custom variables


        renderPanel();
        // 初次获取
        autoFetchChats(); // Note: Not awaiting here to maintain original startup behavior
        // 定时抓取以应对DOM变化 - 使用防抖版本
        setInterval(async () => {
            await autoFetchChats(true); // Pass true to indicate this is a periodic call
        }, 5000);
        // 启动 scheduler（若启用）
        if (settings.autoEnabled) startScheduler();


    }

    // 全局快捷键菜单
    if (typeof GM_registerMenuCommand !== 'undefined') {
        GM_registerMenuCommand('打开续火目标面板', () => { renderPanel(); });
    }

    // 初始化
    start();

})();

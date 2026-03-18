// ==UserScript==
// @name         学习通六六助手[AI答题][一键启动][最小化运行]
// @namespace    xuexitong-liuliu-helper
// @version      3.3.4
// @description  学习通专属AI助手，支持一键答题、自动解析，安全稳定。修复未答题界面的多面板Bug，修复判断题与选项提取逻辑，提升日志安全性。
// @author       You
// @icon         data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%23d92d27'/%3E%3Cpath d='M18 16h30l-11 10h10L27 48h12L22 32h11L18 16z' fill='%23fff'/%3E%3C/svg%3E
// @match        *://*.chaoxing.com/*
// @match        *://*.xueyinonline.com/*
// @match        *://*.edu.cn/*
// @match        *://*.org.cn/*
// @match        *://mooc1-api.chaoxing.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    if (window.__xxt_openai_helper_loaded__) return;
    window.__xxt_openai_helper_loaded__ = true;

    // --- Utilities ---
    const CFG_KEY = 'xxt_openai_helper_cfg_v31';

    class LRUCache {
        constructor(max = 200) { this.max = max; this.cache = new Map(); }
        get(key) { return this.cache.get(key); }
        has(key) { return this.cache.has(key); }
        set(key, val) {
            if (this.cache.size >= this.max) this.cache.delete(this.cache.keys().next().value);
            this.cache.set(key, val);
        }
    }

    const cacheBySig = new LRUCache(200);
    const inflightBySig = new Map();

    const defaults = {
        enabled: true,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        temperature: 0.2,
        timeoutMs: 45000,
        autoAnalyze: true,
        autoSubmit: false,
        scanIntervalMs: 1200,
        panelPos: null,
        launcherPos: null,
        systemPrompt: [
            'You are a study assistant.',
            'Return ONLY a valid JSON object with keys: answer, explanation, confidence.',
            'For single choice: answer is a single letter like A.',
            'For multiple choice: answer is letters like AC.',
            'For true/false: answer is 对 or 错.',
            'For short/essay: put the full answer text in the answer field.',
            'Keep explanation concise, under 50 words.'
        ].join(' ')
    };

    // --- Config ---
    function gmGet(key, fallback) {
        try { if (typeof GM_getValue === 'function') return GM_getValue(key, fallback); } catch (_) {}
        return fallback;
    }
    function gmSet(key, value) {
        try { if (typeof GM_setValue === 'function') GM_setValue(key, value); } catch (_) {}
    }
    function loadConfig() {
        const raw = gmGet(CFG_KEY, '');
        if (!raw) return { ...defaults };
        try { return { ...defaults, ...JSON.parse(raw) }; } catch (_) { return { ...defaults }; }
    }
    const config = loadConfig();
    function saveConfig(next) {
        Object.assign(config, next);
        gmSet(CFG_KEY, JSON.stringify(config));
    }

    // --- Text helpers ---
    function cleanText(v) {
        return String(v || '').replace(/\u00a0/g, ' ').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    }
    function trimStemPrefix(stem) {
        return cleanText(stem)
            .replace(/^\d+[.、]\s*/, '')
            .replace(/^\(.*?(points|分)\)\s*/i, '')
            .trim();
    }
    function shortText(s, len) {
        const t = cleanText(s);
        return t.length > len ? t.slice(0, len) + '...' : t;
    }
    function normalizeAnswerText(answer) {
        return cleanText(answer).toUpperCase().replace(/\s+/g, '');
    }
    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }
    function normalizePosition(pos, width, height) {
        if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return null;
        const maxLeft = Math.max(0, window.innerWidth - width);
        const maxTop = Math.max(0, window.innerHeight - height);
        return {
            left: clamp(pos.left, 0, maxLeft),
            top: clamp(pos.top, 0, maxTop)
        };
    }

    // --- Question type ---
    function typeFromCode(code) {
        const map = { '0': 'single', '1': 'multi', '2': 'blank', '3': 'judge', '4': 'short' };
        const c = map[String(code)];
        return c ? { code: c, label: c } : { code: 'unknown', label: 'unknown' };
    }
    function normalizeType(typeName, answerTypeCode) {
        const t = cleanText(typeName);
        if (t.includes('单选')) return { code: 'single', label: 'single' };
        if (t.includes('多选')) return { code: 'multi', label: 'multi' };
        if (t.includes('判断')) return { code: 'judge', label: 'judge' };
        if (t.includes('填空')) return { code: 'blank', label: 'blank' };
        if (t.includes('简答') || t.includes('名词解释') || t.includes('论述') ||
            t.includes('问答') || t.includes('计算') || t.includes('分析'))
            return { code: 'short', label: 'short' };
        return typeFromCode(answerTypeCode);
    }

    // --- DOM helpers ---
    function isSelected(node) {
        if (!node) return false;
        if (node.classList.contains('check_answer') ||
            node.classList.contains('check_answer_dx') ||
            node.classList.contains('check')) return true;
        if (node.getAttribute('aria-checked') === 'true') return true;
        if (node.querySelector('.check_answer, .check_answer_dx')) return true;
        if (node.querySelector('input[type="checkbox"]:checked, input[type="radio"]:checked')) return true;
        return false;
    }

    function clickNode(node) {
        if (!node) return;
        if (node.hasAttribute('onclick') || node.classList.contains('answerBg')) {
            node.click();
            return;
        }
        const target = node.querySelector('a, label, input') || node;
        if (target) target.click();
    }

    // --- Question parsing ---
    function getQuestionBlocks() {
        return Array.from(document.querySelectorAll('.questionLi'));
    }

    function parseOptionNode(node) {
        const keyNode = node.querySelector('.num_option, .num_option_dx, span[data], .addCount');
        let key = '';
        if (keyNode) {
            let rawData = keyNode.getAttribute('data') || '';
            if (/^(true|false)$/i.test(rawData)) rawData = ''; 
            key = cleanText(rawData || keyNode.textContent || '')
                .replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase();
        }
        if (!key) {
            const m = (node.getAttribute('aria-label') || '').match(/\b([A-F])\b/i);
            if (m) key = m[1].toUpperCase();
        }
        const textNode = node.querySelector('.answer_p, p, .fl.answer_p') || node;
        let text = cleanText(textNode.textContent || '').replace(/^([A-F])[.、\s:：]+/i, '').trim();
        return { key, text, node };
    }

    function parseQuestion(block) {
        if (!block) return null;
        let qid = block.dataset.liuliuHelperQid;
        if (!qid) {
            const rawQid = cleanText(block.getAttribute('data') || block.id || '');
            qid = rawQid.replace(/^question/i, '') || 'rnd_' + String(Math.random()).slice(2);
            block.dataset.liuliuHelperQid = qid;
        }
        const typeName = block.getAttribute('typename') || '';
        const answerTypeEl = document.getElementById('answertype' + qid) ||
                             block.querySelector('input[id^="answertype"], input[name^="answertype"]');
        let qType = normalizeType(typeName, answerTypeEl ? answerTypeEl.value : '');
        if (qType.code === 'unknown') {
            const hasEditor = !!block.querySelector('.edui-editor, .eidtDiv, textarea');
            const hasOptions = block.querySelectorAll('.stem_answer .answerBg, .answerList li, .judgeoption').length > 0;
            if (hasEditor && !hasOptions) qType = { code: 'short', label: 'short' };
        }
        const stemEl = block.querySelector('h3.mark_name, .mark_name');
        const stem = trimStemPrefix(stemEl ? stemEl.textContent : '');
        const optionNodes = Array.from(block.querySelectorAll(
            '.stem_answer .answerBg, .stem_answer .clearfix.answerBg, .stem_answer .judgeoption, .answerList li'
        ));
        const options = optionNodes.map(parseOptionNode).filter(o => o.text.length > 0);
        return { qid, type: qType.code, typeLabel: qType.label, stem, options, block };
    }

    function isQuestionAnswered(q) {
        if (!q) return false;
        if (q.type === 'short' || q.type === 'blank') {
            const iframe = q.block.querySelector('.edui-editor iframe');
            if (iframe) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    return !!cleanText(doc?.body?.textContent || '');
                } catch (_) { return false; }
            }
            const ta = q.block.querySelector('textarea');
            return ta ? !!cleanText(ta.value) : false;
        }
        return q.options.filter(o => isSelected(o.node)).length > 0;
    }

    function getCurrentBlock() {
        const visible = getQuestionBlocks().filter(el => {
            const r = el.getBoundingClientRect();
            return r.height > 0 && r.bottom > 0 && r.top < window.innerHeight;
        });
        for (const item of visible) {
            const q = parseQuestion(item);
            if (q && !isQuestionAnswered(q)) return item;
        }
        for (const item of getQuestionBlocks()) {
            const q = parseQuestion(item);
            if (q && !isQuestionAnswered(q)) return item;
        }
        return null;
    }

    function scrollToNextUnanswered() {
        for (const item of getQuestionBlocks()) {
            const q = parseQuestion(item);
            if (q && !isQuestionAnswered(q)) {
                item.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return true;
            }
        }
        return false;
    }

    function buildUserPrompt(question) {
        const lines = [`Type: ${question.typeLabel}`, `Question: ${question.stem}`];
        if (question.options.length > 0) {
            lines.push('Options:');
            lines.push(question.options.map(o => `${o.key || '?'}: ${o.text}`).join('\n'));
        }
        return lines.join('\n');
    }
    function buildQuestionSignature(question) {
        return JSON.stringify({
            type: question.type,
            stem: cleanText(question.stem),
            options: question.options.map(o => ({
                key: o.key || '',
                text: cleanText(o.text)
            }))
        });
    }
    function parseModelJson(content) {
        const text = String(content || '').trim();
        if (!text) throw new Error('API 返回内容为空');
        const unwrapped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        try {
            return JSON.parse(unwrapped);
        } catch (_) {}
        const start = unwrapped.indexOf('{');
        const end = unwrapped.lastIndexOf('}');
        if (start >= 0 && end > start) {
            return JSON.parse(unwrapped.slice(start, end + 1));
        }
        throw new Error('模型返回不是有效 JSON');
    }

    // --- Apply Answer ---
    function applyShortAnswer(question, answer) {
        const block = question.block;
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const answerTextarea = block.querySelector('textarea[id^="answer"]');
        const formattedAnswer = answer.replace(/\n/g, '<br/>');
        let filled = false;

        if (answerTextarea && typeof pageWindow.UE !== 'undefined') {
            try {
                const inst = pageWindow.UE.getEditor(answerTextarea.id);
                if (inst?.setContent) {
                    inst.setContent(formattedAnswer);
                    inst.fireEvent?.('contentChange');
                    filled = true;
                }
            } catch (e) { }
        }

        if (!filled && typeof pageWindow.UE !== 'undefined' && pageWindow.UE.instants) {
            try {
                for (const key in pageWindow.UE.instants) {
                    const inst = pageWindow.UE.instants[key];
                    if (!inst?.setContent) continue;
                    const el = typeof inst.container === 'string' ? document.getElementById(inst.container) : inst.container;
                    if (el && block.contains(el)) {
                        inst.setContent(formattedAnswer);
                        inst.fireEvent?.('contentChange');
                        filled = true;
                        break;
                    }
                }
            } catch (e) { }
        }

        if (!filled) {
            const iframe = block.querySelector('.edui-editor iframe');
            if (iframe) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    if (doc?.body) { doc.body.innerHTML = formattedAnswer; filled = true; }
                } catch (_) {}
            }
        }

        if (!filled && answerTextarea) {
            answerTextarea.value = answer;
            filled = true;
        }

        if (filled && answerTextarea) {
            answerTextarea.value = answer;
            answerTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            answerTextarea.dispatchEvent(new Event('change', { bubbles: true }));
            try {
                if (typeof pageWindow.answerContentChange === 'function') pageWindow.answerContentChange();
                if (typeof pageWindow.loadEditorAnswerd === 'function' && question.qid) pageWindow.loadEditorAnswerd(question.qid, 4);
            } catch (_) {}
        }

        if (!filled) throw new Error('简答题自动填入失败，请手动复制答案');
        return answer.length > 20 ? answer.slice(0, 20) + '...' : answer;
    }

    function applySuggestedAnswer(question, answer) {
        if (!answer) throw new Error('答案为空');

        if (question.type === 'short' || question.type === 'blank') {
            return applyShortAnswer(question, answer);
        }

        if (question.type === 'judge') {
            let want = '';
            const ansUpper = answer.toUpperCase();
            // 【Bug修复 1】增加边界控制，防止类似 "The statement is false" 命中 T，被判成“对”
            if (/(对|正确|是)/.test(answer) || /\b(YES|TRUE|T)\b/i.test(answer) || ansUpper === 'A') {
                want = '对';
            } else if (/(错|错误|否)/.test(answer) || /\b(NO|FALSE|F)\b/i.test(answer) || ansUpper === 'B') {
                want = '错';
            }

            if (!want) throw new Error('判断题答案格式无法识别(需要:对/错/A/B)');
            
            let target = null;
            for (const o of question.options) {
                if (want === '对' && /(对|正确|true|right|yes)/i.test(o.text)) { target = o; break; }
                if (want === '错' && /(错|错误|false|wrong|no)/i.test(o.text)) { target = o; break; }
            }
            if (!target && question.options.length >= 2)
                target = want === '对' ? question.options[0] : question.options[1];
            if (!target) throw new Error('未找到判断题选项');
            if (!isSelected(target.node)) clickNode(target.node);
            return want;
        }

        // 【Bug修复 2】单/多选答案字母提取策略：优先提取独立的大写字母组合，退化处理只留 A-F
        let match = answer.match(/\b[A-F]+\b/i);
        let letters = '';
        if (match) {
            letters = match[0].toUpperCase();
        } else {
            // 只保留A-F，避免提取出 THE 等长句里包含的不相干字母
            letters = answer.toUpperCase().replace(/[^A-F]/g, '');
        }

        if (!letters) throw new Error('答案中未找到有效的选项字母');

        if (question.type === 'single') {
            const key = letters[0];
            const opt = question.options.find(o => o.key === key);
            if (!opt) throw new Error(`选项 ${key} 不存在 (可用: ${question.options.map(o => o.key).join(',')})`);
            if (!isSelected(opt.node)) clickNode(opt.node);
            return key;
        }

        if (question.type === 'multi') {
            const wantSet = new Set(letters.split(''));
            for (const k of wantSet) {
                if (!question.options.find(o => o.key === k))
                    throw new Error(`选项 ${k} 不存在`);
            }
            for (const opt of question.options) {
                if (!opt.key) continue;
                const should = wantSet.has(opt.key);
                if (should !== isSelected(opt.node)) clickNode(opt.node);
            }
            return Array.from(wantSet).join('');
        }

        throw new Error('不支持的题型: ' + question.type);
    }

    // --- API Logic ---
    function callOpenAI(question) {
        return new Promise((resolve, reject) => {
            if (!config.apiKey) { reject(new Error('API Key 未配置，请打开设置填写')); return; }

            const body = JSON.stringify({
                model: config.model,
                temperature: Number(config.temperature),
                messages: [
                    { role: 'system', content: config.systemPrompt },
                    { role: 'user', content: buildUserPrompt(question) }
                ]
            });

            const timeoutMs = Math.max(1000, Number(config.timeoutMs) || 45000);
            let settled = false;
            let req = null;
            const finish = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(tid);
                fn(value);
            };
            const tid = setTimeout(() => {
                try { req?.abort?.(); } catch (_) {}
                finish(reject, new Error('请求超时'));
            }, timeoutMs + 1000);

            req = GM_xmlhttpRequest({
                method: 'POST',
                url: config.baseUrl.replace(/\/$/, '') + '/chat/completions',
                timeout: timeoutMs,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + config.apiKey
                },
                data: body,
                onload(resp) {
                    try {
                        if (resp.status < 200 || resp.status >= 300) {
                            const snippet = cleanText(resp.responseText || '').slice(0, 120);
                            finish(reject, new Error(`HTTP ${resp.status}${snippet ? `: ${snippet}` : ''}`));
                            return;
                        }
                        const data = JSON.parse(resp.responseText);
                        if (data.error) {
                            finish(reject, new Error(data.error.message || 'API Error'));
                            return;
                        }
                        const content = data.choices?.[0]?.message?.content || '';
                        finish(resolve, parseModelJson(content));
                    } catch (e) {
                        finish(reject, new Error('解析 API 响应失败: ' + e.message));
                    }
                },
                onerror() { finish(reject, new Error('网络请求失败')); },
                ontimeout() {
                    try { req?.abort?.(); } catch (_) {}
                    finish(reject, new Error('请求超时'));
                }
            });
        });
    }

    async function getOrAsk(question) {
        const signature = buildQuestionSignature(question);
        if (cacheBySig.has(signature)) return cacheBySig.get(signature);
        if (inflightBySig.has(signature)) return inflightBySig.get(signature);

        const promise = callOpenAI(question)
            .then(result => { cacheBySig.set(signature, result); inflightBySig.delete(signature); return result; })
            .catch(err => { inflightBySig.delete(signature); throw err; });

        inflightBySig.set(signature, promise);
        return promise;
    }

    // --- UI helpers ---
    function createInput(placeholder, value, type) {
        const el = document.createElement('input');
        el.type = type || 'text';
        el.placeholder = placeholder;
        el.value = value || '';
        el.style.cssText = 'width:100%;margin-bottom:6px;padding:7px;border:1px solid #cbd5e1;border-radius:10px;background:#f8fafc;color:#0f172a;outline:none;box-sizing:border-box;';
        return el;
    }

    function createButton(html, bg, textColor) {
        const btn = document.createElement('button');
        btn.innerHTML = html;
        btn.style.cssText = `border:1px solid #cbd5e1;border-radius:10px;padding:8px 12px;background:${bg};color:${textColor || '#0f172a'};cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,0.1);font-weight:500;`;
        return btn;
    }

    const ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <circle cx="12" cy="12" r="12" fill="#e96c37"/>
        <text x="12" y="16.5" font-size="10" text-anchor="middle" fill="white" font-family="PingFang SC, Microsoft YaHei, Arial, sans-serif" font-weight="bold">六</text>
    </svg>`;
    const FLOAT_ICON_SVG = `<svg width="22" height="22" viewBox="0 0 22 22" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
        <rect x="1" y="1" width="20" height="20" rx="5" fill="#d92d27"/>
        <path d="M6 5.5h10.5L12.8 9h3.6L9.5 16.5h4.1L7.8 11h3.8L6 5.5z" fill="#ffffff"/>
        <path d="M16.7 4.3 14 7h2.2v7.9h2.1V4.3z" fill="#ffffff" opacity="0.95"/>
    </svg>`;

    // --- Mount UI ---
    function mountUI() {
        if (document.getElementById('liuliu-helper-panel')) return; // 防重复挂载

        const styleEl = document.createElement('style');
        styleEl.textContent = `
            @keyframes helper-pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
            #liuliu-helper-panel * { box-sizing: border-box; }
            #liuliu-helper-panel input[type=text],
            #liuliu-helper-panel input[type=password] { font-size:12px; }
        `;
        document.head.appendChild(styleEl);

        const panel = document.createElement('div');
        panel.id = 'liuliu-helper-panel';
        panel.style.cssText = [
            'position:fixed', 'right:12px', 'top:12px', 'z-index:999999',
            'width:240px', 'background:#ffffff', 'color:#0f172a',
            'border:1px solid #e2e8f0', 'border-radius:20px',
            'box-shadow:0 20px 40px -10px rgba(0,0,0,0.1),0 10px 15px -3px rgba(0,0,0,0.05)',
            'font-size:13px',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
            'display:flex', 'flex-direction:column', 'overflow:hidden',
            'transition:width 0.3s ease'
        ].join(';');

        const launcher = document.createElement('button');
        launcher.id = 'liuliu-helper-launcher';
        launcher.type = 'button';
        launcher.innerHTML = FLOAT_ICON_SVG;
        launcher.title = '打开学习通六六助手';
        launcher.style.cssText = [
            'position:fixed', 'left:2px', 'top:120px', 'z-index:999999',
            'width:24px', 'height:24px', 'padding:0', 'display:none',
            'align-items:center', 'justify-content:center',
            'border:0', 'border-radius:0 8px 8px 0',
            'background:#ffffff', 'box-shadow:0 4px 12px rgba(15,23,42,0.18)',
            'cursor:pointer', 'overflow:hidden'
        ].join(';');

        // --- Header ---
        const header = document.createElement('div');
        header.style.cssText = 'padding:14px 16px;background:#f8fafc;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;flex-shrink:0;';

        const title = document.createElement('div');
        title.innerHTML = `<div style="display:flex;align-items:center;gap:6px;pointer-events:none;">${ICON_SVG} 学习通六六助手</div>`;
        title.style.cssText = 'font-weight:600;color:#0f172a;letter-spacing:0.5px;';

        const headerRight = document.createElement('div');
        headerRight.style.cssText = 'display:flex;gap:12px;align-items:center;';

        const settingsBtn = document.createElement('div');
        settingsBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
        settingsBtn.style.cssText = 'cursor:pointer;opacity:0.7;display:flex;align-items:center;transition:opacity 0.2s;';
        settingsBtn.title = '设置';

        const minimizeBtn = document.createElement('div');
        minimizeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/></svg>`;
        minimizeBtn.style.cssText = 'cursor:pointer;opacity:0.7;display:flex;align-items:center;transition:opacity 0.2s;';
        minimizeBtn.title = '最小化';

        headerRight.appendChild(settingsBtn);
        headerRight.appendChild(minimizeBtn);
        header.appendChild(title);
        header.appendChild(headerRight);

        // --- Main Controls ---
        const mainControls = document.createElement('div');
        mainControls.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:12px;';

        const statusLine = document.createElement('div');
        statusLine.textContent = '等待中...';
        statusLine.style.cssText = 'font-size:12px;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;margin-bottom:4px;';

        const logContainer = document.createElement('div');
        logContainer.style.cssText = 'height:100px;overflow-y:auto;background:#f1f5f9;border-radius:6px;padding:8px;font-size:11px;font-family:Consolas,Monaco,monospace;display:flex;flex-direction:column;gap:4px;';

        const toggleBtn = document.createElement('button');

        function updateToggleBtn() {
            const on = config.autoAnalyze;
            toggleBtn.innerHTML = on
                ? `<div style="display:flex;align-items:center;justify-content:center;gap:6px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 8v8"/><path d="M15 8v8"/></svg> 运行中</div>`
                : `<div style="display:flex;align-items:center;justify-content:center;gap:6px"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg> 已暂停</div>`;
            toggleBtn.style.cssText = `width:100%;padding:12px;border-radius:12px;font-weight:600;cursor:pointer;
                transition:all 0.2s cubic-bezier(0.4,0,0.2,1);
                background:${on ? '#10b981' : '#f1f5f9'};
                color:${on ? '#ffffff' : '#64748b'};
                border:1px solid ${on ? '#059669' : '#cbd5e1'};
                box-shadow:${on ? '0 4px 12px rgba(16,185,129,0.2)' : 'none'};`;
        }
        updateToggleBtn();

        mainControls.appendChild(statusLine);
        mainControls.appendChild(logContainer);
        mainControls.appendChild(toggleBtn);

        // --- Settings Panel ---
        const settingsPanel = document.createElement('div');
        settingsPanel.style.cssText = 'padding:0 16px 16px;display:none;border-top:1px solid #e2e8f0;padding-top:16px;';

        const baseUrlInput = createInput('API 地址 (Base URL)', config.baseUrl);
        const apiKeyInput = createInput('API 密钥', config.apiKey, 'password');
        const modelInput = createInput('模型名称', config.model);

        const autoSubmitRow = document.createElement('label');
        autoSubmitRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:12px;color:#475569;';
        const autoSubmitCheck = document.createElement('input');
        autoSubmitCheck.type = 'checkbox';
        autoSubmitCheck.checked = !!config.autoSubmit;
        const autoSubmitText = document.createElement('span');
        autoSubmitText.textContent = '自动勾选答案 (不提交试卷)';
        autoSubmitRow.append(autoSubmitCheck, autoSubmitText);

        const saveBtn = createButton('保存并应用', '#3b82f6', '#ffffff');
        saveBtn.style.width = '100%';
        saveBtn.style.marginTop = '8px';

        settingsPanel.append(baseUrlInput, apiKeyInput, modelInput, autoSubmitRow, saveBtn);

        // --- State ---
        let autoTimer = null;
        let processingQids = new Set();
        let appliedAnswers = new Map();
        let isSettingsOpen = false;
        let isMinimized = false;
        let isProcessingCurrent = false;

        function savePanelPosition() {
            const rect = panel.getBoundingClientRect();
            saveConfig({ panelPos: { left: rect.left, top: rect.top } });
        }
        function saveLauncherPosition() {
            const rect = launcher.getBoundingClientRect();
            saveConfig({ launcherPos: { left: rect.left, top: rect.top } });
        }
        function applySavedPositions() {
            const panelPos = normalizePosition(config.panelPos, 300, 240);
            if (panelPos) {
                panel.style.left = `${panelPos.left}px`;
                panel.style.top = `${panelPos.top}px`;
                panel.style.right = 'auto';
            }
            const launcherPos = normalizePosition(config.launcherPos, 24, 24);
            if (launcherPos) {
                launcher.style.left = `${launcherPos.left}px`;
                launcher.style.top = `${launcherPos.top}px`;
            }
        }
        function setupDraggable(target, options = {}) {
            const handle = options.handle || target;
            const onSave = options.onSave || (() => {});
            let dragging = false;
            let moved = false;
            let startX = 0;
            let startY = 0;
            let initialLeft = 0;
            let initialTop = 0;
            let raf = null;

            handle.addEventListener('mousedown', (e) => {
                if (options.beforeStart && options.beforeStart(e) === false) return;
                dragging = true;
                moved = false;
                startX = e.clientX;
                startY = e.clientY;
                const rect = target.getBoundingClientRect();
                initialLeft = rect.left;
                initialTop = rect.top;
                target.style.right = 'auto';
                target.style.bottom = 'auto';
                e.preventDefault();
            });

            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true;
                if (raf) cancelAnimationFrame(raf);
                raf = requestAnimationFrame(() => {
                    const width = target.offsetWidth || target.getBoundingClientRect().width;
                    const height = target.offsetHeight || target.getBoundingClientRect().height;
                    const left = clamp(initialLeft + dx, 0, Math.max(0, window.innerWidth - width));
                    const top = clamp(initialTop + dy, 0, Math.max(0, window.innerHeight - height));
                    target.style.left = `${left}px`;
                    target.style.top = `${top}px`;
                });
            });

            document.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                if (raf) {
                    cancelAnimationFrame(raf);
                    raf = null;
                }
                if (moved) {
                    onSave();
                    window.setTimeout(() => { moved = false; }, 0);
                }
            });

            return () => moved;
        }

        function addLog(msg, type = 'info') {
            const row = document.createElement('div');
            const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
            // 【Bug修复 3】使用 textContent 安全渲染信息，防范 HTML 注入（XSS）
            row.innerHTML = `<span style="opacity:0.5;margin-right:4px">[${time}]</span><span class="log-text"></span>`;
            row.querySelector('.log-text').textContent = msg;
            row.style.color = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#475569';
            logContainer.appendChild(row);
            logContainer.scrollTop = logContainer.scrollHeight;
            while (logContainer.children.length > 50) logContainer.removeChild(logContainer.firstChild);
        }

        function updateStatus(text, type = 'normal') {
            statusLine.textContent = text;
            statusLine.style.color = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#475569';
            addLog(text, type);
        }

        function stopAuto() {
            if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
        }
        function nextScanDelay() {
            return Math.max(300, Number(config.scanIntervalMs) || 1500);
        }
        function scheduleNextRun(delay = nextScanDelay()) {
            stopAuto();
            if (!config.autoAnalyze) return;
            autoTimer = setTimeout(runAutoLoop, delay);
        }
        function rememberAppliedAnswer(question, answer) {
            appliedAnswers.set(buildQuestionSignature(question), normalizeAnswerText(answer));
            if (appliedAnswers.size > 200) {
                appliedAnswers.delete(appliedAnswers.keys().next().value);
            }
        }
        function hasAppliedAnswer(question, answer) {
            return appliedAnswers.get(buildQuestionSignature(question)) === normalizeAnswerText(answer);
        }

        function toggleSettings() {
            isSettingsOpen = !isSettingsOpen;
            settingsPanel.style.display = isSettingsOpen ? 'block' : 'none';
            panel.style.width = isSettingsOpen ? '300px' : '240px';
            settingsBtn.style.opacity = isSettingsOpen ? '1' : '0.7';
        }

        function toggleMinimize() {
            isMinimized = !isMinimized;
            if (isMinimized) {
                panel.style.display = 'none';
                launcher.style.display = 'flex';
                savePanelPosition();
                minimizeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>`;
            } else {
                panel.style.display = 'flex';
                launcher.style.display = 'none';
                mainControls.style.display = 'flex';
                settingsPanel.style.display = isSettingsOpen ? 'block' : 'none';
                panel.style.width = isSettingsOpen ? '300px' : '240px';
                minimizeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/></svg>`;
            }
        }

        function syncConfig() {
            saveConfig({
                baseUrl: cleanText(baseUrlInput.value),
                apiKey: apiKeyInput.value.trim(),
                model: cleanText(modelInput.value),
                autoSubmit: !!autoSubmitCheck.checked,
                autoAnalyze: config.autoAnalyze
            });
        }

        const didDragPanel = setupDraggable(panel, {
            handle: header,
            beforeStart(e) {
                if (e.target.closest('[title]')) return false;
                return true;
            },
            onSave: savePanelPosition
        });
        const didDragLauncher = setupDraggable(launcher, {
            onSave: saveLauncherPosition
        });

        // --- Core processing loop ---
        async function processCurrent() {
            const block = getCurrentBlock();
            if (!block) { updateStatus('未检测到未答题目或已做完'); return; }
            const q = parseQuestion(block);
            if (!q || !q.stem) { updateStatus('题目解析失败或内容为空'); return; }
            if (isQuestionAnswered(q)) { updateStatus('当前题目已作答，继续查找下一题'); return; }
            if (processingQids.has(q.qid)) return;

            const signature = buildQuestionSignature(q);

            if (cacheBySig.has(signature)) {
                const cached = cacheBySig.get(signature);
                if (config.autoSubmit && cached?.answer && !hasAppliedAnswer(q, cached.answer)) {
                    try {
                        applySuggestedAnswer(q, cached.answer);
                        rememberAppliedAnswer(q, cached.answer);
                        updateStatus(`已应用缓存答案: ${cached.answer}`, 'success');
                        setTimeout(scrollToNextUnanswered, 800);
                    } catch (_) {}
                }
                return;
            }

            updateStatus(`正在思考: ${shortText(q.stem, 15)}...`);
            addLog(`题型: ${q.typeLabel} | QID: ${q.qid}`);
            processingQids.add(q.qid);

            try {
                const result = await getOrAsk(q);
                if (result.answer) {
                    if (config.autoSubmit) {
                        try {
                            applySuggestedAnswer(q, result.answer);
                            rememberAppliedAnswer(q, result.answer);
                            updateStatus(`已自动作答: ${result.answer}`, 'success');
                            setTimeout(scrollToNextUnanswered, 1000);
                        } catch (err) {
                            updateStatus(`作答失败: ${err.message}`, 'error');
                            if (q.type === 'short' || q.type === 'blank')
                                addLog(`参考答案: ${result.answer}`, 'success');
                        }
                    } else {
                        updateStatus(`建议答案: ${result.answer}`, 'success');
                        if (result.explanation) addLog(`解析: ${shortText(result.explanation, 60)}`, 'info');
                    }
                } else {
                    updateStatus('API 返回答案为空', 'error');
                }
            } catch (e) {
                updateStatus(`错误: ${e.message}`, 'error');
            } finally {
                processingQids.delete(q.qid);
            }
        }

        function startAuto() {
            if (!config.autoAnalyze) return;
            updateStatus('正在运行...', 'success');
            scheduleNextRun(0);
        }
        async function runAutoLoop() {
            autoTimer = null;
            if (!config.autoAnalyze || isProcessingCurrent) {
                if (config.autoAnalyze) scheduleNextRun();
                return;
            }
            isProcessingCurrent = true;
            try {
                await processCurrent();
            } catch (_) {
            } finally {
                isProcessingCurrent = false;
                if (config.autoAnalyze) scheduleNextRun();
            }
        }

        // --- Event listeners ---
        minimizeBtn.addEventListener('click', toggleMinimize);
        launcher.addEventListener('click', () => {
            if (didDragLauncher()) return;
            toggleMinimize();
        });
        settingsBtn.addEventListener('click', toggleSettings);

        toggleBtn.addEventListener('click', () => {
            config.autoAnalyze = !config.autoAnalyze;
            syncConfig();
            updateToggleBtn();
            if (config.autoAnalyze) { startAuto(); updateStatus('服务已启动', 'success'); }
            else { stopAuto(); updateStatus('服务已暂停'); }
        });

        saveBtn.addEventListener('click', () => {
            syncConfig();
            updateStatus('设置已保存 ✓', 'success');
            setTimeout(() => { if (isSettingsOpen) toggleSettings(); }, 600);
            if (config.autoAnalyze) startAuto();
        });

        // --- Assemble & mount ---
        panel.appendChild(header);
        panel.appendChild(mainControls);
        panel.appendChild(settingsPanel);
        document.body.appendChild(panel);
        document.body.appendChild(launcher);
        applySavedPositions();

        if (config.autoAnalyze) startAuto();
        else updateStatus('已暂停，点击按钮启动');
    }

    // --- Bootstrap ---
    let uiMounted = false;

    function bootstrap() {
        if (!config.enabled) return;
        if (window.innerWidth < 100 || window.innerHeight < 100) return;

        // 【核心修复】懒加载模式：一直静默检测，只有真正碰到题目元素才注入面板
        const checkTimer = setInterval(() => {
            if (uiMounted) {
                clearInterval(checkTimer);
                return;
            }
            if (document.querySelector('.questionLi')) {
                mountUI();
                uiMounted = true;
                clearInterval(checkTimer);
            }
        }, 1000);
    }

    if (typeof GM_registerMenuCommand === 'function') {
        // 提供在无题目界面（如首页）强制唤出配置面板的方法
        GM_registerMenuCommand('⚙️ 强制显示设置面板 (仅主网页有效)', () => {
            // 严格限制只在顶层页面执行，防止多框架页面同时弹出一堆面板
            if (window !== window.top) return; 
            if (!uiMounted) {
                mountUI();
                uiMounted = true;
            } else {
                const p = document.getElementById('liuliu-helper-panel');
                if (p) p.style.display = p.style.display === 'none' ? 'flex' : 'none';
            }
        });
    }

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    else
        bootstrap();
})();

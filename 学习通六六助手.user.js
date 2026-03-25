// ==UserScript==
// @name         学习通六六助手
// @namespace    xuexitong-liuliu-helper
// @version      3.3.7
// @description  学习通专属AI助手，支持一键答题、自动解析，安全稳定。修复填空题答案识别与多空回填问题，增强简答题和数组答案兼容性。
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
        get(key) {
            const val = this.cache.get(key);
            if (val === undefined && !this.cache.has(key)) return undefined;
            this.cache.delete(key);
            this.cache.set(key, val);
            return val;
        }
        has(key) { return this.cache.has(key); }
        set(key, val) {
            if (this.cache.size >= this.max) this.cache.delete(this.cache.keys().next().value);
            this.cache.set(key, val);
        }
    }

    const cacheBySig = new LRUCache(200);
    const inflightBySig = new Map();
    const retryStateBySig = new Map();

    const defaults = {
        enabled: true,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-4o-mini',
        temperature: 0.2,
        timeoutMs: 45000,
        autoAnalyze: true,
        autoSubmit: false,
        randomImageFallback: true,
        scanIntervalMs: 1200,
        panelPos: null,
        launcherPos: null,
        systemPrompt: [
            'You are a study assistant.',
            'Return ONLY a valid JSON object with keys: answer, explanation, confidence.',
            'For single choice: answer is a single letter like A.',
            'For multiple choice: answer is letters like AC.',
            'For true/false: answer is 对 or 错.',
            'For matching questions: answer is pairs like 1-A,2-C,3-B.',
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
    function answerToPlainText(answer, joiner = '\n') {
        if (Array.isArray(answer)) {
            return answer
                .map(item => String(item ?? '').trim())
                .join(joiner)
                .trim();
        }
        return String(answer ?? '').trim();
    }
    function trimStemPrefix(stem) {
        return cleanText(stem)
            .replace(/^\d+[.、]\s*/, '')
            .replace(/^\(.*?(points|分)\)\s*/i, '')
            .replace(/^[\[\(（【]?\s*(单选题|多选题|判断题|填空题|简答题)[\]\)）】]?\s*/i, '')
            .trim();
    }
    function shortText(s, len) {
        const t = cleanText(s);
        return t.length > len ? t.slice(0, len) + '...' : t;
    }
    function normalizeAnswerText(answer) {
        return cleanText(answerToPlainText(answer, '|')).toUpperCase().replace(/\s+/g, '');
    }
    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }
    function getUIDocument() {
        try {
            const host = getSharedHostWindow();
            return host.document || document;
        } catch (_) {}
        return document;
    }
    function getUIWindow() {
        try {
            const host = getSharedHostWindow();
            return host.document ? host : window;
        } catch (_) {}
        return window;
    }
    function normalizePosition(pos, width, height, view = window) {
        if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return null;
        const maxLeft = Math.max(0, view.innerWidth - width);
        const maxTop = Math.max(0, view.innerHeight - height);
        return {
            left: clamp(pos.left, 0, maxLeft),
            top: clamp(pos.top, 0, maxTop)
        };
    }
    function getSharedHostWindow() {
        try {
            if (window.top && window.top.location && window.top.location.origin === window.location.origin) {
                return window.top;
            }
        } catch (_) {}
        return window;
    }
    function windowHasLiveQuestionContext(targetWindow) {
        try {
            const doc = targetWindow?.document;
            if (!doc) return false;
            return !!doc.querySelector('.questionLi, .Zy_ulTk, .singleQuesId, #liuliu-helper-panel');
        } catch (_) {
            return false;
        }
    }
    function getActivePanelOwner(host) {
        const owner = host.__xxt_openai_helper_panel_owner__;
        if (!owner) return null;
        if (owner === window) return owner;
        if (!windowHasLiveQuestionContext(owner)) {
            try { delete host.__xxt_openai_helper_panel_owner__; } catch (_) {}
            return null;
        }
        return owner;
    }
    function isCurrentWindowPanelOwner() {
        const host = getSharedHostWindow();
        const owner = getActivePanelOwner(host);
        return !owner || owner === window;
    }
    function claimPanelOwner() {
        const host = getSharedHostWindow();
        const owner = getActivePanelOwner(host);
        if (!owner) host.__xxt_openai_helper_panel_owner__ = window;
        return host.__xxt_openai_helper_panel_owner__ === window;
    }
    function releasePanelOwner() {
        const host = getSharedHostWindow();
        if (host.__xxt_openai_helper_panel_owner__ === window) {
            try { delete host.__xxt_openai_helper_panel_owner__; } catch (_) {}
        }
    }

    // --- Question type ---
    function typeFromCode(code) {
        const map = { '0': 'single', '1': 'multi', '2': 'blank', '3': 'judge', '4': 'short', '11': 'matching' };
        const c = map[String(code)];
        return c ? { code: c, label: c } : { code: 'unknown', label: 'unknown' };
    }
    function normalizeType(typeName, answerTypeCode) {
        const t = cleanText(typeName);
        if (t.includes('单选')) return { code: 'single', label: 'single' };
        if (t.includes('多选')) return { code: 'multi', label: 'multi' };
        if (t.includes('判断')) return { code: 'judge', label: 'judge' };
        if (t.includes('填空')) return { code: 'blank', label: 'blank' };
        if (t.includes('连线')) return { code: 'matching', label: 'matching' };
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
        const raw = Array.from(document.querySelectorAll('.questionLi, .Zy_ulTk, .singleQuesId'))
            .map(node => node.classList.contains('Zy_ulTk') ? (node.parentElement || node) : node);
        return Array.from(new Set(raw));
    }

    function hasQuestionBlocks() {
        return document.querySelector('.questionLi, .Zy_ulTk, .singleQuesId') !== null;
    }
    function collectQuestionWindows(rootWindow) {
        const found = [];
        const visited = new Set();
        const walk = (win) => {
            if (!win || visited.has(win)) return;
            visited.add(win);
            try {
                if (win.document?.querySelector?.('.questionLi, .Zy_ulTk, .singleQuesId')) found.push(win);
            } catch (_) {}
            let frames;
            try { frames = win.frames; } catch (_) { frames = null; }
            if (!frames) return;
            for (let i = 0; i < frames.length; i++) {
                try { walk(frames[i]); } catch (_) {}
            }
        };
        walk(rootWindow);
        return found;
    }

    function parseMatchingQuestion(block) {
        const matchingRoot = block.querySelector('.matching');
        if (!matchingRoot) return null;

        const sourceItems = Array.from(matchingRoot.querySelectorAll('.firstUlList li'))
            .filter(li => !li.classList.contains('groupTitile'))
            .map(li => {
                const index = cleanText(li.querySelector('i')?.textContent || '').replace(/[^\d]/g, '');
                const imageSources = Array.from(li.querySelectorAll('img'))
                    .map(img => cleanText(img.getAttribute('data-original') || img.getAttribute('src') || ''))
                    .filter(Boolean);
                const text = cleanText(li.querySelector('p, a, div')?.textContent || li.textContent || '')
                    .replace(/^\d+[、.\s]*/, '')
                    .trim();
                return { index, text, imageSources };
            })
            .filter(item => item.index && (item.text || item.imageSources.length > 0));

        const targetItems = Array.from(matchingRoot.querySelectorAll('.secondUlList li'))
            .filter(li => !li.classList.contains('groupTitile'))
            .map(li => {
                const key = cleanText(li.querySelector('i')?.textContent || '').replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase();
                const text = cleanText(li.querySelector('p, a, div')?.textContent || li.textContent || '')
                    .replace(/^[A-Z][、.\s:]*/i, '')
                    .trim();
                return { key, text };
            })
            .filter(item => item.key && item.text);

        const answerItems = Array.from(matchingRoot.querySelectorAll('.lineOption')).map(item => {
            const index = cleanText(item.getAttribute('index') || item.querySelector('.matchNum')?.textContent || '').replace(/[^\d]/g, '');
            const select = item.querySelector('select');
            const chosenLabel = item.querySelector('.chosen-single span');
            const options = Array.from(select?.options || [])
                .map(opt => cleanText(opt.value))
                .filter(Boolean);
            return { index, select, chosenLabel, node: item, options };
        }).filter(item => item.index && item.select);

        if (sourceItems.length === 0 || targetItems.length === 0 || answerItems.length === 0) return null;

        return { sourceItems, targetItems, answerItems };
    }

    function findLegacyTitleNode(block) {
        if (!block) return null;
        const local = block.querySelector('.Zy_TItle .fontLabel, .Zy_TItle .newZy_TItle');
        if (local) return local;
        let prev = block.previousElementSibling;
        while (prev) {
            if (prev.matches?.('.Zy_TItle')) {
                return prev.querySelector('.fontLabel, .newZy_TItle') || prev;
            }
            prev = prev.previousElementSibling;
        }
        return null;
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
        const textNode = node.querySelector('.answer_p, p, .fl.answer_p, a.after, .after') || node;
        let text = cleanText(textNode.textContent || '').replace(/^([A-F])[.、\s:：]+/i, '').trim();
        return { key, text, node };
    }

    function parseQuestion(block) {
        if (!block) return null;
        let qid = block.dataset.liuliuHelperQid;
        if (!qid) {
            const rawQid = cleanText(
                block.getAttribute('data') ||
                block.closest('[data]')?.getAttribute('data') ||
                block.id ||
                block.closest('[id]')?.id ||
                ''
            );
            const editorId = block.querySelector('textarea[id], textarea[name]')?.id ||
                             block.querySelector('textarea[id], textarea[name]')?.name || '';
            qid = rawQid.replace(/^question/i, '') ||
                  cleanText(editorId).replace(/^(answerEditor|ueditorInstant)/i, '') ||
                  'rnd_' + String(Math.random()).slice(2);
            block.dataset.liuliuHelperQid = qid;
        }
        const typeName = block.getAttribute('typename') || '';
        const answerTypeEl = document.getElementById('answertype' + qid) ||
                             block.querySelector('input[id^="answertype"], input[name^="answertype"]');
        let qType = normalizeType(typeName, answerTypeEl ? answerTypeEl.value : '');
        if (qType.code === 'unknown') {
            const hasEditor = !!block.querySelector('.edui-editor, .eidtDiv, textarea, .blankItemInp, .Zy_ulTk');
            const hasOptions = block.querySelectorAll('.stem_answer .answerBg, .answerList li, .judgeoption, .Zy_ulTop li, li.before-after, li.before-after-checkbox').length > 0;
            const legacyTitle = cleanText(findLegacyTitleNode(block)?.textContent || '');
            if (legacyTitle.includes('填空')) qType = { code: 'blank', label: 'blank' };
            else if (legacyTitle.includes('连线') || block.querySelector('.matching .lineOption')) qType = { code: 'matching', label: 'matching' };
            else if (hasEditor && !hasOptions) qType = { code: 'short', label: 'short' };
        }
        const stemEl = block.querySelector('h3.mark_name, .mark_name') || findLegacyTitleNode(block);
        const stem = trimStemPrefix(stemEl ? stemEl.textContent : '');
        const stemImages = stemEl ? Array.from(stemEl.querySelectorAll('img')) : [];
        const stemImageCount = stemImages.length;
        const stemImageSources = stemImages
            .map(img => cleanText(img.getAttribute('data-original') || img.getAttribute('src') || ''))
            .filter(Boolean);
        const optionNodes = Array.from(block.querySelectorAll(
            '.stem_answer .answerBg, .stem_answer .clearfix.answerBg, .stem_answer .judgeoption, .answerList li, .Zy_ulTop li, li.before-after, li.before-after-checkbox'
        ));
        const options = optionNodes.map(parseOptionNode).filter(o => o.text.length > 0);
        const matching = qType.code === 'matching' ? parseMatchingQuestion(block) : null;
        return { qid, type: qType.code, typeLabel: qType.label, stem, stemImageCount, stemImageSources, options, matching, block };
    }

    function getBlankAnswerItems(questionOrBlock) {
        const block = questionOrBlock?.block || questionOrBlock;
        if (!block) return [];

        const primaryItems = Array.from(block.querySelectorAll('.blankItemDiv'));
        if (primaryItems.length > 0) return primaryItems;

        const answerItems = Array.from(block.querySelectorAll('.stem_answer > .Answer'));
        if (answerItems.length > 0) return answerItems;

        const qid = questionOrBlock?.qid || block.dataset.liuliuHelperQid || cleanText(block.getAttribute('data') || '').replace(/^question/i, '');
        const sizeInput = (qid && (
            document.querySelector(`input[name="tiankongsize${qid}"]`) ||
            block.querySelector(`input[name="tiankongsize${qid}"]`)
        )) || block.querySelector('input[name^="tiankongsize"]');
        const blankCount = Number(sizeInput?.value || 0);
        if (blankCount > 1) {
            const fallbackItems = Array.from(block.querySelectorAll('.stem_answer .Answer, .stem_answer .divText'));
            if (fallbackItems.length >= blankCount) return fallbackItems.slice(0, blankCount);
        }

        return [];
    }

    function hasEditorContent(container) {
        if (!container) return false;

        const iframe = container.querySelector('.edui-editor iframe');
        if (iframe) {
            try {
                const doc = iframe.contentDocument || iframe.contentWindow.document;
                if (cleanText(doc?.body?.textContent || '')) return true;
            } catch (_) {}
        }

        const textareas = Array.from(container.querySelectorAll('textarea'));
        if (textareas.some(ta => cleanText(ta.value))) return true;

        const inputs = Array.from(container.querySelectorAll('input[type="text"], input[type="search"]'));
        if (inputs.some(input => cleanText(input.value))) return true;

        const legacyMirror = container.querySelector('.InpDIV');
        if (legacyMirror && cleanText(legacyMirror.textContent || '')) return true;

        return false;
    }

    function isQuestionAnswered(q) {
        if (!q) return false;
        if (q.type === 'matching') {
            const items = q.matching?.answerItems || [];
            return items.length > 0 && items.every(item => cleanText(item.select?.value || ''));
        }
        if (q.type === 'short' || q.type === 'blank') {
            const blankItems = getBlankAnswerItems(q);
            if (q.type === 'blank' && blankItems.length > 1) {
                return blankItems.every(item => hasEditorContent(item));
            }
            return hasEditorContent(q.block);
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
        if (question.type === 'matching' && question.matching) {
            lines.push('Group 1:');
            lines.push(question.matching.sourceItems.map(item => {
                const marker = item.text || '[image item]';
                const imageHint = item.imageSources?.length ? ` (image count: ${item.imageSources.length})` : '';
                return `${item.index}: ${marker}${imageHint}`;
            }).join('\n'));
            lines.push('Group 2:');
            lines.push(question.matching.targetItems.map(item => `${item.key}: ${item.text}`).join('\n'));
            lines.push('Answer format: 1-A,2-B,3-C');
            return lines.join('\n');
        }
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
            stemImageCount: Number(question.stemImageCount) || 0,
            stemImageSources: Array.isArray(question.stemImageSources) ? question.stemImageSources : [],
            matching: question.matching ? {
                sourceItems: question.matching.sourceItems.map(item => ({
                    index: item.index,
                    text: cleanText(item.text),
                    imageSources: Array.isArray(item.imageSources) ? item.imageSources : []
                })),
                targetItems: question.matching.targetItems.map(item => ({
                    key: item.key,
                    text: cleanText(item.text)
                }))
            } : null,
            options: question.options.map(o => ({
                key: o.key || '',
                text: cleanText(o.text)
            }))
        });
    }
    function stripControlChars(s) {
        return s.replace(/[\x00-\x1f]/g, ' ').replace(/ {2,}/g, ' ');
    }
    function fixLooseJson(s) {
        // 修复未加引号的值，如 "answer": D → "answer": "D"
        return s.replace(
            /([{,]\s*"(?:answer|explanation|confidence)")\s*:\s*(?!["{\[\dtfn-])(.*?)(?=\s*[,}])/gi,
            function (_, prefix, val) {
                val = val.trim();
                if (!val) return prefix + ': ""';
                return prefix + ': "' + val.replace(/"/g, '\\"') + '"';
            }
        );
    }
    function regexExtract(s) {
        // 最终兜底：用正则从畸形文本中提取 answer 字段
        const answerMatch = s.match(/["']?answer["']?\s*[:=]\s*["']?([^"',}\n]+)/i);
        const explMatch = s.match(/["']?explanation["']?\s*[:=]\s*["']([^"']*)/i);
        const confMatch = s.match(/["']?confidence["']?\s*[:=]\s*([\d.]+)/i);
        if (!answerMatch) return null;
        return {
            answer: answerMatch[1].trim(),
            explanation: explMatch ? explMatch[1].trim() : '',
            confidence: confMatch ? parseFloat(confMatch[1]) : 0
        };
    }
    function parseModelJson(content) {
        const text = String(content || '').trim();
        if (!text) throw new Error('API 返回内容为空');
        const unwrapped = stripControlChars(
            text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
        );
        // 1. 直接尝试解析
        try { return JSON.parse(unwrapped); } catch (_) {}
        // 2. 提取 {} 部分再尝试
        const start = unwrapped.indexOf('{');
        const end = unwrapped.lastIndexOf('}');
        if (start >= 0 && end > start) {
            const jsonSlice = unwrapped.slice(start, end + 1);
            try { return JSON.parse(jsonSlice); } catch (_) {}
            // 3. 修复未加引号的值后再尝试
            try { return JSON.parse(fixLooseJson(jsonSlice)); } catch (_) {}
        }
        // 4. 正则兜底提取
        const extracted = regexExtract(unwrapped);
        if (extracted) return extracted;
        throw new Error('模型返回不是有效 JSON');
    }
    function buildUserMessageContent(question) {
        const textPrompt = buildUserPrompt(question);
        const imageParts = [];

        if (Array.isArray(question.stemImageSources)) {
            question.stemImageSources.forEach((url, index) => {
                if (url) imageParts.push({ label: `Question image ${index + 1}`, url });
            });
        }
        if (question.type === 'matching' && question.matching?.sourceItems) {
            question.matching.sourceItems.forEach(item => {
                (item.imageSources || []).forEach((url, index) => {
                    if (url) imageParts.push({ label: `Group 1 item ${item.index} image ${index + 1}`, url });
                });
            });
        }

        if (imageParts.length === 0) return textPrompt;

        return [
            { type: 'text', text: textPrompt },
            ...imageParts.flatMap(item => ([
                { type: 'text', text: item.label },
                { type: 'image_url', image_url: { url: item.url } }
            ]))
        ];
    }

    function getRetryState(signature) {
        return retryStateBySig.get(signature) || { count: 0, nextAt: 0, lastMessage: '' };
    }

    function clearRetryState(signature) {
        retryStateBySig.delete(signature);
    }

    function recordRetryFailure(signature, error) {
        const prev = getRetryState(signature);
        const nextCount = prev.count + 1;
        const baseDelay = /503|unavailable|upstream provider error|timeout|network/i.test(String(error?.message || ''))
            ? 5000
            : 2000;
        const delay = Math.min(60000, baseDelay * Math.pow(2, Math.min(nextCount - 1, 3)));
        const next = {
            count: nextCount,
            nextAt: Date.now() + delay,
            lastMessage: String(error?.message || '')
        };
        retryStateBySig.set(signature, next);
        return next;
    }

    // --- Apply Answer ---
    function fillEditorContainer(container, answer, question, pageWindow) {
        const plainAnswer = answerToPlainText(answer);
        const answerTextarea = container.querySelector('textarea[id^="answer"], textarea[name^="answer"], textarea');
        const formattedAnswer = plainAnswer.replace(/\n/g, '<br/>');
        let filled = false;

        if (answerTextarea && typeof pageWindow.UE !== 'undefined') {
            try {
                const inst = pageWindow.UE.getEditor(answerTextarea.id);
                if (inst?.setContent) {
                    inst.setContent(formattedAnswer);
                    inst.fireEvent?.('contentChange');
                    filled = true;
                }
            } catch (_) {}
        }

        if (!filled && typeof pageWindow.UE !== 'undefined' && pageWindow.UE.instants) {
            try {
                for (const key in pageWindow.UE.instants) {
                    const inst = pageWindow.UE.instants[key];
                    if (!inst?.setContent) continue;
                    const el = typeof inst.container === 'string' ? document.getElementById(inst.container) : inst.container;
                    if (el && container.contains(el)) {
                        inst.setContent(formattedAnswer);
                        inst.fireEvent?.('contentChange');
                        filled = true;
                        break;
                    }
                }
            } catch (_) {}
        }

        if (!filled) {
            const iframe = container.querySelector('.edui-editor iframe');
            if (iframe) {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    if (doc?.body) {
                        const safeHtml = formattedAnswer
                            .replace(/<br\s*\/?>/gi, '\x00BR\x00')
                            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                            .replace(/\x00BR\x00/g, '<br/>');
                        doc.body.innerHTML = safeHtml;
                        filled = true;
                    }
                } catch (_) {}
            }
        }

        if (!filled && answerTextarea) {
            answerTextarea.value = plainAnswer;
            filled = true;
        }

        if (filled && answerTextarea) {
            answerTextarea.value = plainAnswer;
            answerTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            answerTextarea.dispatchEvent(new Event('change', { bubbles: true }));
            try {
                if (typeof pageWindow.answerContentChange === 'function') pageWindow.answerContentChange();
                if (typeof pageWindow.loadEditorAnswerd === 'function' && question.qid)
                    pageWindow.loadEditorAnswerd(question.qid, question.type === 'blank' ? 2 : 4);
            } catch (_) {}
        }

        return filled;
    }

    function splitBlankAnswers(answer, blankCount) {
        if (Array.isArray(answer)) {
            const values = answer.map(item => String(item ?? '').trim());
            if (blankCount <= 1) return [values.join('\n').trim()];
            if (values.length >= blankCount) return values.slice(0, blankCount);
            throw new Error(`填空题答案数量不足，需要 ${blankCount} 个空`);
        }
        const text = String(answer || '').replace(/<br\s*\/?>/gi, '\n').trim();
        if (blankCount <= 1) return [text];

        const numbered = [];
        const re = /(?:^|[\s\n,;；，])(\d+)\s*[\.\):：、）]?\s*([\s\S]*?)(?=(?:[\s\n,;；，]+\d+\s*[\.\):：、）]?\s*)|$)/g;
        let match;
        while ((match = re.exec(text))) {
            if (match[0].length === 0) { re.lastIndex++; if (re.lastIndex > text.length) break; continue; }
            numbered.push({
                index: Number(match[1]),
                value: cleanText(match[2]).replace(/^[-=]+|[-=]+$/g, '').trim()
            });
        }
        if (numbered.length >= blankCount) {
            const values = numbered
                .sort((a, b) => a.index - b.index)
                .slice(0, blankCount)
                .map(item => item.value);
            if (values.every(Boolean)) return values;
        }

        const lines = text.split(/\r?\n+/).map(v => cleanText(v)).filter(Boolean);
        if (lines.length === blankCount) {
            return lines.map(v => v.replace(/^\d+\s*[\.\):：、）]\s*/, '').trim());
        }

        const numberedLines = lines.map(v => v.replace(/^\d+\s*[\.\):：、）]\s*/, '').trim()).filter(Boolean);
        if (numberedLines.length === blankCount) return numberedLines;

        const parts = text.split(/[;；,，]/).map(v => cleanText(v)).filter(Boolean);
        if (parts.length === blankCount) {
            return parts.map(v => v.replace(/^\d+\s*[\.\):：、）]\s*/, '').trim());
        }

        throw new Error(`填空题答案无法自动拆分，需要 ${blankCount} 个空`);
    }

    function isImageOnlyQuestion(question) {
        if (!question) return false;
        const hasStemImages = Number(question.stemImageCount) > 0;
        const hasMatchingImages = !!question.matching?.sourceItems?.some(item => (item.imageSources || []).length > 0);
        return hasStemImages || hasMatchingImages;
    }

    function randomChoice(list) {
        if (!Array.isArray(list) || list.length === 0) return '';
        return list[Math.floor(Math.random() * list.length)];
    }

    function randomToken(len = 6) {
        const chars = 'abcdefghijklmnopqrstuvwxyz';
        let out = '';
        for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
        return out;
    }

    function buildRandomAnswer(question) {
        if (!question) throw new Error('题目为空，无法生成随机答案');
        if (question.type === 'matching') {
            const sourceItems = question.matching?.sourceItems || [];
            const targetKeys = (question.matching?.targetItems || []).map(item => item.key);
            if (sourceItems.length === 0 || targetKeys.length === 0) throw new Error('连线题缺少可用选项');
            const pool = targetKeys.slice();
            const pairs = sourceItems.map(item => {
                if (pool.length === 0) pool.push(...targetKeys);
                const idx = Math.floor(Math.random() * pool.length);
                const key = pool.splice(idx, 1)[0] || randomChoice(targetKeys);
                return `${item.index}-${key}`;
            });
            return pairs.join(',');
        }
        if (question.type === 'single') {
            const opt = randomChoice(question.options.filter(o => o.key));
            if (!opt?.key) throw new Error('单选题缺少可用选项');
            return opt.key;
        }
        if (question.type === 'multi') {
            const keys = question.options.filter(o => o.key).map(o => o.key);
            if (keys.length === 0) throw new Error('多选题缺少可用选项');
            const count = Math.max(1, Math.min(keys.length, Math.floor(Math.random() * Math.min(3, keys.length)) + 1));
            const shuffled = keys.slice().sort(() => Math.random() - 0.5);
            return shuffled.slice(0, count).join('');
        }
        if (question.type === 'judge') {
            return Math.random() < 0.5 ? '对' : '错';
        }
        if (question.type === 'blank') {
            const blankCount = getBlankAnswerItems(question).length || 1;
            return Array.from({ length: blankCount }, (_, i) => `${i + 1}. ${randomToken(5)}`).join('\n');
        }
        return randomToken(8);
    }

    function applyBlankAnswer(question, answer) {
        const block = question.block;
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const blankItems = getBlankAnswerItems(question);
        if (blankItems.length <= 1) {
            const plainAnswer = answerToPlainText(answer);
            if (!fillEditorContainer(block, plainAnswer, question, pageWindow))
                throw new Error('填空题自动填入失败，请手动复制答案');
            return plainAnswer.length > 20 ? plainAnswer.slice(0, 20) + '...' : plainAnswer;
        }

        const parts = splitBlankAnswers(answer, blankItems.length);
        let filledCount = 0;
        blankItems.forEach((item, index) => {
            if (fillEditorContainer(item, parts[index] || '', question, pageWindow)) filledCount += 1;
        });
        if (filledCount !== blankItems.length)
            throw new Error(`填空题仅填入 ${filledCount}/${blankItems.length} 个空`);
        return parts.join(' | ');
    }

    function applyShortAnswer(question, answer) {
        const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
        const plainAnswer = answerToPlainText(answer);
        if (!fillEditorContainer(question.block, plainAnswer, question, pageWindow))
            throw new Error('简答题自动填入失败，请手动复制答案');
        return plainAnswer.length > 20 ? plainAnswer.slice(0, 20) + '...' : plainAnswer;
    }

    function parseMatchingAnswer(answer, question) {
        const text = cleanText(answer).toUpperCase();
        if (!text) throw new Error('连线题答案为空');

        const pairs = new Map();
        const directPairRe = /(\d+)\s*[-=:：>]\s*([A-Z])/g;
        let match;
        while ((match = directPairRe.exec(text))) {
            pairs.set(match[1], match[2]);
        }

        if (pairs.size === 0) {
            const compact = text.replace(/\s+/g, '');
            const sequentialPairRe = /(\d+)([A-Z])/g;
            while ((match = sequentialPairRe.exec(compact))) {
                pairs.set(match[1], match[2]);
            }
        }

        if (pairs.size === 0) {
            const maybeJson = text.match(/\{[\s\S]*\}/);
            if (maybeJson) {
                try {
                    const obj = JSON.parse(maybeJson[0]);
                    const source = obj.answer && typeof obj.answer === 'object' ? obj.answer : obj;
                    Object.keys(source || {}).forEach(key => {
                        const idx = String(key).replace(/[^\d]/g, '');
                        const value = cleanText(source[key]).replace(/[^A-Za-z]/g, '').slice(0, 1).toUpperCase();
                        if (idx && value) pairs.set(idx, value);
                    });
                } catch (_) {}
            }
        }

        const answerItems = question.matching?.answerItems || [];
        const validIndexes = new Set(answerItems.map(item => item.index));
        const validKeys = new Set((question.matching?.targetItems || []).map(item => item.key));
        const normalized = [];
        for (const [index, key] of pairs.entries()) {
            if (validIndexes.has(index) && validKeys.has(key)) normalized.push([index, key]);
        }
        if (normalized.length === 0) throw new Error('连线题答案格式无法识别(需要: 1-A,2-B)');
        return new Map(normalized);
    }

    function applyMatchingAnswer(question, answer) {
        const pairs = parseMatchingAnswer(answer, question);
        const answerItems = question.matching?.answerItems || [];
        if (answerItems.length === 0) throw new Error('未找到连线题作答控件');

        let filledCount = 0;
        answerItems.forEach(item => {
            const value = pairs.get(item.index);
            if (!value) return;
            if (!item.options.includes(value)) throw new Error(`连线题第 ${item.index} 项不存在选项 ${value}`);
            item.select.value = value;
            item.select.dispatchEvent(new Event('input', { bubbles: true }));
            item.select.dispatchEvent(new Event('change', { bubbles: true }));
            if (item.chosenLabel) item.chosenLabel.textContent = value;
            filledCount += 1;
        });

        if (filledCount !== answerItems.length)
            throw new Error(`连线题仅填入 ${filledCount}/${answerItems.length} 项`);

        const hiddenAnswer = question.block.querySelector(`#answer${question.qid}, input[name="answer${question.qid}"]`);
        if (hiddenAnswer) {
            hiddenAnswer.value = Array.from(pairs.entries()).sort((a, b) => Number(a[0]) - Number(b[0])).map(([index, key]) => `${index}-${key}`).join(',');
            hiddenAnswer.dispatchEvent(new Event('input', { bubbles: true }));
            hiddenAnswer.dispatchEvent(new Event('change', { bubbles: true }));
        }

        return Array.from(pairs.entries()).sort((a, b) => Number(a[0]) - Number(b[0])).map(([index, key]) => `${index}-${key}`).join(',');
    }

    function applySuggestedAnswer(question, answer) {
        if (!answer) throw new Error('答案为空');

        if (question.type === 'matching') {
            return applyMatchingAnswer(question, answer);
        }

        if (question.type === 'blank') {
            return applyBlankAnswer(question, answer);
        }

        if (question.type === 'short') {
            return applyShortAnswer(question, answer);
        }

        const plainAnswer = answerToPlainText(answer);
        if (question.type === 'judge') {
            let want = '';
            const ansUpper = plainAnswer.toUpperCase();
            // 【Bug修复 1】增加边界控制，排除”是否/能否”等复合词干扰，”是””否”仅精确匹配
            const judgeClean = plainAnswer.replace(/是否|能否|可否|与否/g, '').trim();
            if (/(对|正确)/.test(judgeClean) || /^是$/.test(judgeClean) || /\b(YES|TRUE|T)\b/i.test(plainAnswer) || ansUpper === 'A') {
                want = '对';
            } else if (/(错|错误)/.test(judgeClean) || /^否$/.test(judgeClean) || /\b(NO|FALSE|F)\b/i.test(plainAnswer) || ansUpper === 'B') {
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

        // 【Bug修复 2】单/多选答案字母提取策略：提取所有独立的大写字母，合并去重排序
        const allLetterMatches = plainAnswer.match(/\b[A-F]\b/gi);
        let letters = '';
        if (allLetterMatches) {
            letters = [...new Set(allLetterMatches.map(c => c.toUpperCase()))].sort().join('');
        } else {
            // 退化处理：只保留A-F，避免提取出 THE 等长句里包含的不相干字母
            letters = plainAnswer.toUpperCase().replace(/[^A-F]/g, '');
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
                    { role: 'user', content: buildUserMessageContent(question) }
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
        const el = getUIDocument().createElement('input');
        el.type = type || 'text';
        el.placeholder = placeholder;
        el.value = value || '';
        el.style.cssText = 'width:100%;margin-bottom:6px;padding:7px;border:1px solid #cbd5e1;border-radius:10px;background:#f8fafc;color:#0f172a;outline:none;box-sizing:border-box;';
        return el;
    }

    function createButton(html, bg, textColor) {
        const btn = getUIDocument().createElement('button');
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
        if (!hasQuestionBlocks()) return;
        if (!claimPanelOwner()) return;
        const uiDoc = getUIDocument();
        const uiWin = getUIWindow();
        if (uiDoc.getElementById('liuliu-helper-panel')) return; // 防重复挂载

        const styleEl = uiDoc.createElement('style');
        styleEl.textContent = `
            @keyframes helper-pulse { 0%,100% { opacity:1; } 50% { opacity:0.5; } }
            #liuliu-helper-panel * { box-sizing: border-box; }
            #liuliu-helper-panel input[type=text],
            #liuliu-helper-panel input[type=password] { font-size:12px; }
        `;
        uiDoc.head.appendChild(styleEl);

        const panel = uiDoc.createElement('div');
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

        const launcher = uiDoc.createElement('button');
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
        const header = uiDoc.createElement('div');
        header.style.cssText = 'padding:14px 16px;background:#f8fafc;display:flex;justify-content:space-between;align-items:center;cursor:move;user-select:none;flex-shrink:0;';

        const title = uiDoc.createElement('div');
        title.innerHTML = `<div style="display:flex;align-items:center;gap:6px;pointer-events:none;">${ICON_SVG} 学习通六六助手</div>`;
        title.style.cssText = 'font-weight:600;color:#0f172a;letter-spacing:0.5px;';

        const headerRight = uiDoc.createElement('div');
        headerRight.style.cssText = 'display:flex;gap:12px;align-items:center;';

        const settingsBtn = uiDoc.createElement('div');
        settingsBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
        settingsBtn.style.cssText = 'cursor:pointer;opacity:0.7;display:flex;align-items:center;transition:opacity 0.2s;';
        settingsBtn.title = '设置';

        const minimizeBtn = uiDoc.createElement('div');
        minimizeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/></svg>`;
        minimizeBtn.style.cssText = 'cursor:pointer;opacity:0.7;display:flex;align-items:center;transition:opacity 0.2s;';
        minimizeBtn.title = '最小化';

        headerRight.appendChild(settingsBtn);
        headerRight.appendChild(minimizeBtn);
        header.appendChild(title);
        header.appendChild(headerRight);

        // --- Main Controls ---
        const mainControls = uiDoc.createElement('div');
        mainControls.style.cssText = 'padding:16px;display:flex;flex-direction:column;gap:12px;';

        const statusLine = uiDoc.createElement('div');
        statusLine.textContent = '等待中...';
        statusLine.style.cssText = 'font-size:12px;color:#475569;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-weight:600;margin-bottom:4px;';

        const logContainer = uiDoc.createElement('div');
        logContainer.style.cssText = 'height:100px;overflow-y:auto;background:#f1f5f9;border-radius:6px;padding:8px;font-size:11px;font-family:Consolas,Monaco,monospace;display:flex;flex-direction:column;gap:4px;';

        const toggleBtn = uiDoc.createElement('button');

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
        const settingsPanel = uiDoc.createElement('div');
        settingsPanel.style.cssText = 'padding:0 16px 16px;display:none;border-top:1px solid #e2e8f0;padding-top:16px;';

        const baseUrlInput = createInput('API 地址 (Base URL)', config.baseUrl);
        const apiKeyInput = createInput('API 密钥', config.apiKey, 'password');
        const modelInput = createInput('模型名称', config.model);

        const autoSubmitRow = uiDoc.createElement('label');
        autoSubmitRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:12px;color:#475569;';
        const autoSubmitCheck = uiDoc.createElement('input');
        autoSubmitCheck.type = 'checkbox';
        autoSubmitCheck.checked = !!config.autoSubmit;
        const autoSubmitText = uiDoc.createElement('span');
        autoSubmitText.textContent = '自动勾选答案';
        autoSubmitRow.append(autoSubmitCheck, autoSubmitText);

        const randomImageFallbackRow = uiDoc.createElement('label');
        randomImageFallbackRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer;font-size:12px;color:#475569;';
        const randomImageFallbackCheck = uiDoc.createElement('input');
        randomImageFallbackCheck.type = 'checkbox';
        randomImageFallbackCheck.checked = !!config.randomImageFallback;
        const randomImageFallbackText = uiDoc.createElement('span');
        randomImageFallbackText.textContent = '图片题无法识别时随机作答';
        randomImageFallbackRow.append(randomImageFallbackCheck, randomImageFallbackText);

        const saveBtn = createButton('保存并应用', '#3b82f6', '#ffffff');
        saveBtn.style.width = '100%';
        saveBtn.style.marginTop = '8px';

        settingsPanel.append(baseUrlInput, apiKeyInput, modelInput, autoSubmitRow, randomImageFallbackRow, saveBtn);

        // --- State ---
        let autoTimer = null;
        let processingQids = new Set();
        let appliedAnswers = new Map();
        let isSettingsOpen = false;
        let isMinimized = false;
        let isProcessingCurrent = false;
        let lastStatusText = '';
        let lastStatusType = 'normal';
        let lastLoggedText = '';
        let lastLoggedAt = 0;

        function savePanelPosition() {
            const rect = panel.getBoundingClientRect();
            saveConfig({ panelPos: { left: rect.left, top: rect.top } });
        }
        function saveLauncherPosition() {
            const rect = launcher.getBoundingClientRect();
            saveConfig({ launcherPos: { left: rect.left, top: rect.top } });
        }
        function applySavedPositions() {
            const panelPos = normalizePosition(config.panelPos, 300, 240, uiWin);
            if (panelPos) {
                panel.style.left = `${panelPos.left}px`;
                panel.style.top = `${panelPos.top}px`;
                panel.style.right = 'auto';
            }
            const launcherPos = normalizePosition(config.launcherPos, 24, 24, uiWin);
            if (launcherPos) {
                launcher.style.left = `${launcherPos.left}px`;
                launcher.style.top = `${launcherPos.top}px`;
            }
        }
        function setupDraggable(target, options = {}) {
            const ownerDoc = target.ownerDocument || uiDoc;
            const ownerWin = ownerDoc.defaultView || uiWin;
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

            ownerDoc.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) moved = true;
                if (raf) cancelAnimationFrame(raf);
                raf = requestAnimationFrame(() => {
                    const width = target.offsetWidth || target.getBoundingClientRect().width;
                    const height = target.offsetHeight || target.getBoundingClientRect().height;
                    const left = clamp(initialLeft + dx, 0, Math.max(0, ownerWin.innerWidth - width));
                    const top = clamp(initialTop + dy, 0, Math.max(0, ownerWin.innerHeight - height));
                    target.style.left = `${left}px`;
                    target.style.top = `${top}px`;
                });
            });

            ownerDoc.addEventListener('mouseup', () => {
                if (!dragging) return;
                dragging = false;
                if (raf) {
                    cancelAnimationFrame(raf);
                    raf = null;
                }
                if (moved) {
                    onSave();
                    ownerWin.setTimeout(() => { moved = false; }, 0);
                }
            });

            return () => moved;
        }

        function addLog(msg, type = 'info') {
            const now = Date.now();
            if (msg === lastLoggedText && now - lastLoggedAt < 8000) return;
            lastLoggedText = msg;
            lastLoggedAt = now;
            const row = uiDoc.createElement('div');
            const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
            // 【Bug修复 3】使用 textContent 安全渲染信息，防范 HTML 注入（XSS）
            row.innerHTML = `<span style="opacity:0.5;margin-right:4px">[${time}]</span><span class="log-text"></span>`;
            row.querySelector('.log-text').textContent = msg;
            row.style.color = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#475569';
            logContainer.appendChild(row);
            logContainer.scrollTop = logContainer.scrollHeight;
            while (logContainer.children.length > 50) logContainer.removeChild(logContainer.firstChild);
        }

        function updateStatus(text, type = 'normal', options = {}) {
            const skipLog = !!options.skipLog;
            const dedupe = options.dedupe !== false;
            if (dedupe && text === lastStatusText && type === lastStatusType) return;
            lastStatusText = text;
            lastStatusType = type;
            statusLine.textContent = text;
            statusLine.style.color = type === 'error' ? '#ef4444' : type === 'success' ? '#10b981' : '#475569';
            if (!skipLog) addLog(text, type);
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
                randomImageFallback: !!randomImageFallbackCheck.checked,
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
            if (!block) {
                updateStatus('未检测到未答题目或已做完', 'normal', { skipLog: true });
                return;
            }
            const q = parseQuestion(block);
            if (!q) { updateStatus('题目解析失败或内容为空'); return; }
            if (isQuestionAnswered(q)) {
                updateStatus('当前题目已作答，继续查找下一题', 'normal', { skipLog: true });
                return;
            }
            if (processingQids.has(q.qid)) return;

            const signature = buildQuestionSignature(q);
            const retryState = getRetryState(signature);
            if (retryState.nextAt > Date.now()) {
                const waitSec = Math.max(1, Math.ceil((retryState.nextAt - Date.now()) / 1000));
                updateStatus(`接口异常，${waitSec}s 后重试当前题`, 'error', { skipLog: true });
                return;
            }

            if (cacheBySig.has(signature)) {
                const cached = cacheBySig.get(signature);
                if (config.autoSubmit && cached?.answer && !hasAppliedAnswer(q, cached.answer)) {
                    try {
                        applySuggestedAnswer(q, cached.answer);
                        rememberAppliedAnswer(q, cached.answer);
                        updateStatus(`已应用缓存答案: ${cached.answer}`, 'success');
                        setTimeout(scrollToNextUnanswered, 800);
                    } catch (_) {}
                } else if (cached?.answer) {
                    updateStatus(`建议答案: ${cached.answer}`, 'success');
                    if (cached.explanation) addLog(`解析: ${shortText(cached.explanation, 60)}`, 'info');
                }
                return;
            }

            if (config.randomImageFallback && isImageOnlyQuestion(q)) {
                const randomAnswer = buildRandomAnswer(q);
                cacheBySig.set(signature, { answer: randomAnswer, explanation: '图片题缺少可解析文本，已启用随机作答。', confidence: 0 });
                if (config.autoSubmit && !hasAppliedAnswer(q, randomAnswer)) {
                    try {
                        applySuggestedAnswer(q, randomAnswer);
                        rememberAppliedAnswer(q, randomAnswer);
                        updateStatus(`图片题已随机作答: ${randomAnswer}`, 'success');
                        setTimeout(scrollToNextUnanswered, 800);
                    } catch (err) {
                        updateStatus(`图片题随机作答失败: ${err.message}`, 'error');
                    }
                } else {
                    updateStatus(`图片题随机答案: ${randomAnswer}`, 'success');
                }
                return;
            }

            if (!q.stem) {
                updateStatus('题目缺少可解析文本', 'error');
                return;
            }

            updateStatus(`正在思考第 ${q.qid} 题...`, 'normal', { skipLog: true });
            addLog(`题型: ${q.typeLabel} | QID: ${q.qid}`, 'info');
            processingQids.add(q.qid);

            try {
                const result = await getOrAsk(q);
                if (!config.autoAnalyze) return;
                clearRetryState(signature);
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
                if (!config.autoAnalyze) return;
                const nextRetry = recordRetryFailure(signature, e);
                const waitSec = Math.max(1, Math.ceil((nextRetry.nextAt - Date.now()) / 1000));
                updateStatus(`错误: ${e.message}，${waitSec}s 后重试`, 'error');
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
        uiDoc.body.appendChild(panel);
        uiDoc.body.appendChild(launcher);
        applySavedPositions();

        if (config.autoAnalyze) startAuto();
        else updateStatus('已暂停，点击按钮启动');
    }

    // --- Bootstrap ---
    let uiMounted = false;
    let uiObserver = null;
    let ensureTimer = null;
    let crossFrameTimer = null;
    let teacherAjaxHooked = false;
    let reloadTimer = null;

    function hasMountedPanel() {
        return !!getUIDocument().getElementById('liuliu-helper-panel');
    }

    function ensureUI() {
        if (!config.enabled) return;
        if (window.innerWidth < 100 || window.innerHeight < 100) return;

        if (!hasQuestionBlocks()) {
            if (!hasMountedPanel()) uiMounted = false;
            return;
        }

        if (hasMountedPanel()) {
            uiMounted = true;
            return;
        }

        uiMounted = false;
        mountUI();
        if (hasMountedPanel()) uiMounted = true;
    }
    function pokeQuestionWindows() {
        const host = getSharedHostWindow();
        const wins = collectQuestionWindows(host);
        wins.forEach(win => {
            try {
                if (typeof win.__xxt_helper_ensure_ui__ === 'function') {
                    win.__xxt_helper_ensure_ui__();
                }
            } catch (_) {}
        });
    }
    function schedulePokeQuestionWindows() {
        [200, 600, 1200, 2200].forEach(delay => {
            window.setTimeout(() => {
                pokeQuestionWindows();
            }, delay);
        });
    }
    function scheduleFullPageReload(delay = 2000) {
        const host = getSharedHostWindow();
        if (host !== window) return;
        if (reloadTimer) host.clearTimeout(reloadTimer);
        const reloadCheck = () => {
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
                reloadTimer = host.setTimeout(reloadCheck, 2000);
                return;
            }
            try {
                releasePanelOwner();
            } catch (_) {}
            host.location.reload();
        };
        reloadTimer = host.setTimeout(reloadCheck, delay);
    }
    function hookTeacherAjax() {
        const host = getSharedHostWindow();
        if (host !== window || teacherAjaxHooked) return;
        const raw = host.getTeacherAjax;
        if (typeof raw !== 'function' || raw.__xxt_hooked__) return;
        const wrapped = function (...args) {
            const result = raw.apply(this, args);
            schedulePokeQuestionWindows();
            scheduleFullPageReload();
            return result;
        };
        wrapped.__xxt_hooked__ = true;
        try {
            host.getTeacherAjax = wrapped;
            teacherAjaxHooked = true;
        } catch (_) {}
    }

    function bootstrap() {
        window.__xxt_helper_ensure_ui__ = ensureUI;
        ensureUI();
        hookTeacherAjax();

        if (!ensureTimer) {
            ensureTimer = setInterval(() => {
                ensureUI();
                hookTeacherAjax();
            }, 1000);
        }

        if (window === getSharedHostWindow() && !crossFrameTimer) {
            crossFrameTimer = setInterval(() => {
                pokeQuestionWindows();
            }, 1200);
        }

        if (!uiObserver && document.body) {
            let mutDebounce = null;
            uiObserver = new MutationObserver(() => {
                if (mutDebounce) clearTimeout(mutDebounce);
                mutDebounce = setTimeout(ensureUI, 300);
            });
            uiObserver.observe(document.body, { childList: true, subtree: true });
        }
    }

    if (typeof GM_registerMenuCommand === 'function') {
        // 提供在无题目界面（如首页）强制唤出配置面板的方法
        GM_registerMenuCommand('⚙️ 强制显示设置面板 (仅主网页有效)', () => {
            if (!hasQuestionBlocks()) { alert('当前页面未检测到题目，无法显示面板'); return; }
            if (!hasMountedPanel()) uiMounted = false;
            if (!isCurrentWindowPanelOwner() && !claimPanelOwner()) return;
            if (!uiMounted || !hasMountedPanel()) {
                mountUI();
                uiMounted = hasMountedPanel();
            } else {
                const p = getUIDocument().getElementById('liuliu-helper-panel');
                if (p) p.style.display = p.style.display === 'none' ? 'flex' : 'none';
            }
        });
    }

    window.addEventListener('beforeunload', releasePanelOwner);
    window.addEventListener('focus', ensureUI);
    window.addEventListener('pageshow', ensureUI);
    window.addEventListener('hashchange', ensureUI);
    if (window === getSharedHostWindow()) {
        document.addEventListener('click', (e) => {
            const target = e.target?.closest?.('.posCatalog_name, [onclick*="getTeacherAjax"]');
            if (!target) return;
            schedulePokeQuestionWindows();
            scheduleFullPageReload();
        }, true);
    }
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) ensureUI();
    });

    if (document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    else
        bootstrap();
})();

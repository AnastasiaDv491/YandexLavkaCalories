// ==UserScript==
// @name         Лавка — Диагностика v3 (временно)
// @namespace    https://github.com/AnastasiaDv491/YandexLavkaCalories
// @version      0.9.0
// @description  Кнопка «Диагностика»: сканирует ТУТ ЖЕ документ (и shadow DOM) на наличие товаров корзины; работает во всех фреймах и iframe Лавки
// @author       AnastasiaDv491
// @match        *://lavka.yandex.ru/*
// @match        *://yandex.ru/lavka/*
// @include      /^https?:\/\/.*yandex\.(ru|net)\/.*$/
// @grant        GM_info
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Скрипт запускается и в верхнем окне, и внутри каждого iframe (без @noframes),
  // поэтому каждое окно сканирует САМО СЕБЯ — так мы точно увидим, где живёт корзина.
  const isLavkaFrame = /lavka\.yandex\.ru|yandex\.ru\/lavka|yandex\.(net|ru)/.test(location.href);

  // Рекурсивный обход всего дерева (включая shadow DOM): собирает ВСЕ элементы.
  function deepAllElements(root, acc, limit) {
    acc = acc || [];
    limit = limit || 20000;
    try {
      root.querySelectorAll('*').forEach((el) => {
        if (acc.length >= limit) return;
        acc.push(el);
        if (el.shadowRoot) deepAllElements(el.shadowRoot, acc, limit);
      });
    } catch (e) { /* ignore */ }
    return acc;
  }

  function collectAttrs(doc) {
    const attrs = {};
    try {
      doc.querySelectorAll('[data-qa], [data-auto]').forEach((el) => {
        ['data-qa', 'data-auto'].forEach((a) => {
          const v = el.getAttribute(a);
          if (!v) return;
          const key = a + '=' + v;
          if (!attrs[key]) attrs[key] = { count: 0 };
          attrs[key].count++;
        });
      });
    } catch (e) {
      return { error: String(e) };
    }
    return attrs;
  }

  // Рекурсивно обходим shadow DOM в поиске нужных элементов
  function deepQueryAll(root, selector, acc) {
    acc = acc || [];
    try {
      root.querySelectorAll(selector).forEach((el) => acc.push(el));
    } catch (e) { /* ignore */ }
    try {
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, acc);
      });
    } catch (e) { /* ignore */ }
    return acc;
  }

  function collectProductLinks(doc) {
    const links = deepQueryAll(doc, 'a[href*="/product/"]').slice(0, 15);
    return links.map((a) => ({
      href: (a.getAttribute('href') || '').slice(0, 120),
      text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      parentChain: (() => {
        const chain = [];
        let p = a.parentElement;
        for (let i = 0; p && i < 4; i++) {
          chain.push(p.tagName.toLowerCase() + (p.className && typeof p.className === 'string' ? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
          p = p.parentElement;
        }
        return chain.join(' < ');
      })(),
    }));
  }

  // Гипотеза: Лавка использует нестандартные ссылки на товары (не /product/).
  // Список shadow-хостов среди предков элемента (как в userscript v0.7)
  function ancestorsOf(el, all) {
    const res = [];
    let cur = el;
    while (cur) {
      res.push(cur);
      if (cur.parentElement) { cur = cur.parentElement; continue; }
      const root = cur.getRootNode ? cur.getRootNode() : null;
      cur = root && root.host ? root.host : null;
    }
    return res;
  }

  // Собираем все <a> с href, содержащим "lavka" или цифры-id, и все элементы с
  // признаками карточки (изображение + текст с ₽ рядом).
  function collectCardCandidates(doc) {
    const out = [];
    // 0) карточки Лавки по классам + alt картинок (основной путь userscript v0.7):
    //    ЛИСТОВЫЕ карточки, с учетом shadow DOM (deep-список предков вместо querySelectorAll)
    const CARD_RE = /ProductListItem|ProductCard|ProductSnippet/;
    const all = deepAllElements(doc);
    all.forEach((el) => {
      if (out.length >= 30) return;
      const cls = el.className && el.className.toString ? el.className.toString() : '';
      if (!CARD_RE.test(cls)) return;
      const anc = ancestorsOf(el, all);
      let nested = false;
      for (const c of all) {
        if (c === el) continue;
        const ccls = c.className && c.className.toString ? c.className.toString() : '';
        if (!CARD_RE.test(ccls)) continue;
        if (anc.includes(c) && c !== doc.body && c !== doc.documentElement) { nested = true; break; }
      }
      if (nested) return;
      const alts = [];
      deepAllElements(el).forEach((im) => {
        if (im.tagName !== 'IMG') return;
        const a = (im.getAttribute('alt') || '').replace(/\u00ad/g, '').replace(/<notr>/gi, ' ').replace(/\s+/g, ' ').trim();
        if (a && a.length > 3) alts.push(a.slice(0, 70));
      });
      const qtyM = (el.textContent || '').match(/[×x]\s*(\d{1,3})\b|(\d{1,3})\s*шт\b/i);
      out.push({ kind: 'lavka-card', cls: cls.split(' ').slice(0, 3).join('.'), alts, qtyHint: qtyM ? (qtyM[1] || qtyM[2]) : null });
    });
    // 1) любые ссылки, похожие на товарные
    deepAllElements(doc).forEach((el) => {
      if (out.length >= 25) return;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'a' || tag === 'area') {
        const href = el.getAttribute('href') || '';
        if (/\/product|\/item|lavka\.yandex\.net|id=\d+|\/\d{6,}/.test(href)) {
          out.push({ kind: 'link', href: href.slice(0, 140), text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) });
        }
      }
    });
    // 2) элементы, у которых прямой текст похож на название товара (кириллица, без ₽),
    //    а в родителе есть картинка и цена — типичная карточка
    const allText = deepAllElements(doc);
    for (const el of allText) {
      if (out.length >= 30) break;
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt.length < 4 || txt.length > 70) continue;
      if (!/[а-яё]/i.test(txt)) continue;
      if (/₽/.test(txt)) continue;
      // «листовой» текстовый элемент: у него нет дочерних текстовых блоков длиннее его самого
      let hasChildText = false;
      for (const c of el.children) {
        if ((c.textContent || '').trim().length > 3) { hasChildText = true; break; }
      }
      if (hasChildText) continue;
      const parent = el.parentElement ? (el.parentElement.parentElement || el.parentElement) : null;
      if (!parent) continue;
      const pTxt = parent.textContent || '';
      if (!/₽/.test(pTxt)) continue;                 // в блоке есть цена
      if (!parent.querySelector('img')) continue;    // и картинка
      out.push({
        kind: 'card-like',
        text: txt,
        chain: (() => {
          const chain = [];
          let p = el;
          for (let i = 0; p && i < 5; i++) {
            chain.push(p.tagName.toLowerCase() + (typeof p.className === 'string' && p.className.trim() ? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.') : ''));
            p = p.parentElement;
          }
          return chain.join(' < ');
        })(),
      });
    }
    // дедуп по тексту
    const seen = new Set();
    return out.filter((o) => { const k = o.text; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 25);
  }

  function report() {
    // Сканируем ТОЛЬКО собственный документ (включая shadow DOM) — скрипт сам
    // запустится отдельно в каждом iframe, где ему позволено.
    const attrs = collectAttrs(document);
    const result = {
      frameUrl: location.href,
      isLavkaFrame,
      title: document.title.slice(0, 80),
      attrKeys: Object.keys(attrs).length,
      attrs,
      productLinks: collectProductLinks(document),
      cardCandidates: collectCardCandidates(document),
      basketTextHits: (() => {
        // ищем текстовые маркеры корзины, чтобы понять, в этом ли окне она отрендерена
        const t = (document.body && document.body.textContent) || '';
        return ['Корзина', 'Итого', 'Оформить заказ', 'ккал', 'шт'].map((w) => ({ word: w, found: t.includes(w) }));
      })(),
      bodyTextSample: ((document.body && document.body.textContent) || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    };
    console.log('[lavka-kcal-debug3]', JSON.stringify(result, null, 2));

    let box = document.getElementById('lavka-kcal-debug-box');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'lavka-kcal-debug-box';
      Object.assign(box.style, {
        position: 'fixed', bottom: '10px', left: '10px', zIndex: 2147483647,
        maxWidth: '700px', maxHeight: '60vh', overflow: 'auto',
        background: '#111', color: '#0f0', padding: '12px',
        font: '12px monospace', borderRadius: '8px', display: 'none',
      });
      document.body.appendChild(box);
    }
    box.textContent = JSON.stringify(result, null, 2);

    // Кнопка всегда видна в ЛЮБОМ окне/фрейме: по ней видно, где скрипт запустился,
    // а клик показывает диагностику именно этого документа.
    const btn = document.getElementById('lavka-kcal-debug-btn') || document.createElement('button');
    btn.id = 'lavka-kcal-debug-btn';
    btn.textContent = '🔎 Диагностика ккал (' + (isLavkaFrame ? 'лавка' : 'др.фрейм') + ')';
    Object.assign(btn.style, {
      position: 'fixed', top: '10px', right: '10px', zIndex: 2147483647,
      padding: '8px 12px', background: '#111', color: '#0f0', border: '1px solid #0f0',
      borderRadius: '8px', font: '12px monospace', cursor: 'pointer',
    });
    btn.onclick = () => {
      const show = box.style.display === 'none';
      box.style.display = show ? 'block' : 'none';
      if (show) box.textContent = JSON.stringify(report.last || result, null, 2);
    };
    if (!btn.parentElement) document.body.appendChild(btn);
  }
  report.last = null;

  setTimeout(() => { report(); report.last = true; }, 3000);
  setInterval(report, 5000);
})();

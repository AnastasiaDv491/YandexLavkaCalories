// ==UserScript==
// @name         Лавка — Диагностика v3 (временно)
// @namespace    https://github.com/AnastasiaDv491/YandexLavkaCalories
// @version      0.4.0
// @description  Кнопка «Диагностика»: сканирует ТУТ ЖЕ документ (и shadow DOM) на наличие товаров корзины; работает во всех фреймах
// @author       AnastasiaDv491
// @match        https://lavka.yandex.ru/*
// @match        https://yandex.ru/lavka/*
// @match        https://*/*
// @grant        GM_info
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Скрипт запускается и в верхнем окне, и внутри каждого iframe (без @noframes),
  // поэтому каждое окно сканирует САМО СЕБЯ — так мы точно увидим, где живёт корзина.
  const isLavkaFrame = /lavka\.yandex\.ru|yandex\.ru\/lavka|yandex\.(net|ru)/.test(location.href);

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

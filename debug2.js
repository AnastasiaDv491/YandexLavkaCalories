// ==UserScript==
// @name         Лавка — Диагностика v2 (временно)
// @namespace    https://github.com/AnastasiaDv491/YandexLavkaCalories
// @version      0.2.0
// @description  Собирает карту фреймов страницы и все data-qa/data-auto атрибуты, включая iframe
// @author       AnastasiaDv491
// @match        https://lavka.yandex.ru/*
// @match        https://yandex.ru/lavka/*
// @match        https://*/*
// @grant        GM_info
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Работаем ТОЛЬКО на lavka/yandex (верхний фрейм). Вложенные iframe пропускаем:
  // для них этот же скрипт запустится отдельно благодаря @match https://*/* + @noframes?
  // Нет: @noframes отключает запуск в iframe. Поэтому сам заходим во фреймы через contentWindow.
  const onLavka = /lavka\.yandex\.ru|^https:\/\/yandex\.ru\/lavka/.test(location.href);
  if (!onLavka) return;

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

  function report() {
    const frames = [];
    // верхний документ
    frames.push({ url: location.href, sameOrigin: true, attrKeys: Object.keys(collectAttrs(document)).length, attrs: collectAttrs(document) });

    // все iframe на странице
    document.querySelectorAll('iframe').forEach((f, i) => {
      const info = { index: i, src: (f.src || '').slice(0, 150), accessible: false };
      try {
        const d = f.contentDocument;
        if (d && d.documentElement) {
          info.accessible = true;
          info.innerUrl = d.location.href.slice(0, 150);
          const attrs = collectAttrs(d);
          info.attrKeys = Object.keys(attrs).length;
          info.attrs = attrs;
          info.bodyTextSample = (d.body ? d.body.textContent : '').replace(/\s+/g, ' ').slice(0, 300);
        }
      } catch (e) {
        info.error = String(e).slice(0, 120);
      }
      frames.push(info);
    });

    const result = { topUrl: location.href, frameCount: frames.length - 1, frames };
    console.log('[lavka-kcal-debug2]', JSON.stringify(result, null, 2));

    let box = document.getElementById('lavka-kcal-debug-box');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'lavka-kcal-debug-box';
      Object.assign(box.style, {
        position: 'fixed', bottom: '10px', left: '10px', zIndex: 999999,
        maxWidth: '700px', maxHeight: '60vh', overflow: 'auto',
        background: '#111', color: '#0f0', padding: '12px',
        font: '12px monospace', borderRadius: '8px',
      });
      document.body.appendChild(box);
    }
    box.textContent = JSON.stringify(result, null, 2);

    // кнопка копирования в буфер
    const btn = document.createElement('button');
    btn.textContent = 'Скопировать JSON';
    Object.assign(btn.style, { position: 'fixed', bottom: '10px', right: '10px', zIndex: 999999, padding: '8px 12px' });
    btn.onclick = () => navigator.clipboard.writeText(JSON.stringify(result, null, 2)).then(() => { btn.textContent = 'Скопировано!'; });
    document.body.appendChild(btn);
  }

  setTimeout(report, 4000);
  setTimeout(report, 10000);
})();

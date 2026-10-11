// ==UserScript==
// @name         Лавка — Диагностика (временно)
// @namespace    https://github.com/AnastasiaDv491/YandexLavkaCalories
// @version      0.1.0
// @description  Временный скрипт: проверяет, работает ли Tampermonkey на lavka.yandex.ru и какие data-атрибуты у карточек товаров
// @author       AnastasiaDv491
// @match        https://lavka.yandex.ru/*
// @match        https://yandex.ru/lavka/*
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // 1. Функция ли? Если этой надписи нет — Tampermonkey не запускает скрипты
  //    на этом сайте (отключен, не тот профиль браузера или блокировщик мешает).
  console.log('[lavka-kcal-debug] userscript работает на', location.href);

  function report() {
    // 2. Ищем элементы с data-qa / data-auto и собираем уникальные значения
    const attrs = {};
    document.querySelectorAll('[data-qa], [data-auto]').forEach((el) => {
      ['data-qa', 'data-auto'].forEach((a) => {
        const v = el.getAttribute(a);
        if (!v) return;
        const key = a + '=' + v;
        if (!attrs[key]) attrs[key] = { count: 0, sampleClasses: '' };
        attrs[key].count++;
        if (!attrs[key].sampleClasses) attrs[key].sampleClasses = el.className.slice(0, 120);
      });
    });

    // 3. Элементы, в тексте которых есть «Итого» — кандидаты для места виджета
    const summaryCandidates = [];
    document.querySelectorAll('div,section,span').forEach((el) => {
      if (el.children.length < 8 && /\bитого\b/i.test(el.textContent)) {
        summaryCandidates.push({
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 120),
          w: Math.round(el.getBoundingClientRect().width),
        });
      }
    });

    const result = { url: location.href, attrKeys: Object.keys(attrs).length, attrs, summaryCandidates };
    console.log('[lavka-kcal-debug]', JSON.stringify(result, null, 2));

    // 4. Дублируем результат в видимую плашку — console могут скрывать
    let box = document.getElementById('lavka-kcal-debug-box');
    if (!box) {
      box = document.createElement('pre');
      box.id = 'lavka-kcal-debug-box';
      Object.assign(box.style, {
        position: 'fixed', bottom: '10px', left: '10px', zIndex: 999999,
        maxWidth: '600px', maxHeight: '50vh', overflow: 'auto',
        background: '#111', color: '#0f0', padding: '12px',
        font: '12px monospace', borderRadius: '8px',
      });
      document.body.appendChild(box);
    }
    box.textContent = JSON.stringify(result, null, 2);
  }

  // Корзина подгружается асинхронно — ждем и переснимаем
  setTimeout(report, 3000);
  setTimeout(report, 8000);
})();

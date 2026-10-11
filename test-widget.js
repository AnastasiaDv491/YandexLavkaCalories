// Автотест v0.18: виджет в fixed-хосте со shadow DOM, не исчезает при перерисовке SPA
const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM('<!doctype html><html><body><div id="app"><section>Итого 500 ₽</section></div></body></html>', { url: 'https://lavka.yandex.ru/cart', pretendToBeVisual: true });
global.window = dom.window; global.document = dom.window.document; global.location = dom.window.location;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
global.GM_getValue = (k, d) => d; global.GM_setValue = () => {};
global.GM_xmlhttpRequest = () => {};

// извлекаем функции рендера из скрипта и выполняем их в этом окружении
const src = fs.readFileSync('lavka-calories.user.js', 'utf8');
const start = src.indexOf('const HOST_CSS');
const end = src.indexOf('/* ============================================================\n   * ОСНОВНОЙ ЦИКЛ');
if (start < 0 || end < 0) throw new Error('фрагмент не найден');
const fn = new Function('document', src.slice(start, end) + '\nreturn { ensureHost, ensureShadow, renderWidget };');
const { ensureHost, ensureShadow, renderWidget } = fn(dom.window.document);

// 1) хост создаётся в body, fixed, с shadow DOM
renderWidget(320, 1, 2, ['Коктейль ×1: 44 ккал (Лавка)', 'Творог ×1: нет данных']);
let host = document.getElementById('lavka-kcal-host');
assert(host && host.parentElement === document.body, 'хост в body');
assert(host.shadowRoot, 'shadow root есть');
assert(/position:fixed/.test(host.getAttribute('style')), 'fixed позиционирование');
const card = host.__kcalCard;
assert(card.style.display === 'block', 'карточка видима');
assert(/320/.test(card.innerHTML) && /ккал/.test(card.innerHTML), 'итог отрисован');
assert(/по товарам/.test(card.innerHTML), 'детализация есть');

// 2) SPA перерисовка: Лавка удалила свой #app — наш хост живёт отдельно и не удалён
document.getElementById('app').remove();
assert(document.getElementById('lavka-kcal-host') === host, 'хост выжил после перерисовки SPA');

// 3) даже если хост случайно удалили — следующий render воссоздаёт его
host.remove();
renderWidget(100, 1, 1, ['X ×1: 100 ккал (Лавка)']);
const host2 = document.getElementById('lavka-kcal-host');
assert(host2 && host2 !== host && host2.shadowRoot, 'хост воссоздан');

// 4) пустая корзина -> скрытие, но не удаление
renderWidget(null, 0, 0, []);
assert(host2.__kcalCard.style.display === 'none', 'пустой результат скрыт');

console.log('PASS: widget v0.18');
function assert(cond, msg) { if (!cond) { console.error('FAIL:', msg); process.exit(1); } }

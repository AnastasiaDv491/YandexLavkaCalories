// Тест источника №1: парсинг КБЖУ из блока traits-block страницы товара Лавки
// (HTML предоставлен пользователем) + goodId в позициях корзины + новый ключ кэша v3.
const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM(fs.readFileSync('test-cart.html', 'utf-8'), { runScripts: 'outside-only' });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.GM_xmlhttpRequest = undefined;
global.GM_getValue = undefined;
global.GM_setValue = undefined;
global.fetch = () => Promise.reject(new Error('offline test'));
global.navigator = dom.window.navigator;

let src = fs.readFileSync('lavka-calories.user.js', 'utf8');
src = src.replace('setInterval(safeTick, CONFIG.pollIntervalMs);', '');
src = src.replace("setStatus('Лавка-ккал: v0.13 запущен, сканирую страницу…');", '');
src = src.replace('safeTick();', `
  window.__collectCartItems = collectCartItems;
  window.__parseLavkaGoodHtml = parseLavkaGoodHtml;
`);
dom.window.eval(src);

let fail = false;

// 1) goodId должен попадать в позиции корзины (из data-testid="cart_item_<id>")
const items = dom.window.__collectCartItems(dom.window.document);
if (!items.every((i) => i.goodId && /^[0-9a-f]{20,}/i.test(i.goodId))) {
  console.error('FAIL: у позиций корзины нет goodId:', items.map((i) => i.goodId));
  fail = true;
}

// 2) парсинг блока КБЖУ со страницы товара (реальный HTML от пользователя)
const traitsHtml = `<!DOCTYPE html><html><head><title>Коктейль детский Из Лавки банан, 200 мл</title></head><body>
<section class="divider__a2Ds6" data-testid="traits-block"><div class="traits__c5cQa">
<dl class="ingredientsTraits__v_jRL" data-item-id="traits-list" data-testid="traits-list-per100g">
<div class="listItem__LyNNB"><dt class="name__UFT1G">ккал</dt><dd data-testid="trait-value-calories">22</dd></div>
<div class="listItem__LyNNB"><dt class="name__UFT1G">белки</dt><dd data-testid="trait-value-protein">1</dd></div>
<div class="listItem__LyNNB"><dt class="name__UFT1G">жиры</dt><dd data-testid="trait-value-fat">0,2</dd></div>
<div class="listItem__LyNNB"><dt class="name__UFT1G">углеводы</dt><dd data-testid="trait-value-carbohydrate">3,8</dd></div>
</dl></div></section></body></html>`;
const parsed = dom.window.__parseLavkaGoodHtml(traitsHtml);
if (!parsed || parsed.kcalPer100g !== 22 || parsed.source !== 'lavka') {
  console.error('FAIL: блок traits не распарсился:', parsed);
  fail = true;
}
if (!parsed || parsed.weightG !== 200) {
  console.error('FAIL: вес фасовки из title страницы не извлечён:', parsed && parsed.weightG);
  fail = true;
}

// 3) страница без блока КБЖУ -> null (уходим в OFF, а не в ошибку)
const empty = dom.window.__parseLavkaGoodHtml('<!DOCTYPE html><html><body><p>нет данных</p></body></html>');
if (empty !== null) { console.error('FAIL: ожидался null для страницы без traits'); fail = true; }

// 4) ключ кэша обновлён на v3 (старый битый v2 игнорируется)
if (!/const CACHE_KEY = 'lavka_kcal_cache_v3'/.test(src)) {
  console.error('FAIL: CACHE_KEY не v3'); fail = true;
}

if (fail) process.exit(1);
console.log('PASS: goodId в корзинах, КБЖУ из traits-block (22 ккал/100г, 200 г), null-фолбэк, кэш v3');

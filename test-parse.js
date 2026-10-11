const { JSDOM } = require('jsdom');
const fs = require('fs');

// 3 карточки: корзина (2 шт) + промо-блок "предложили купить" (1 шт)
const cardHtml = fs.readFileSync('/tmp/card.html', 'utf8');
const card2 = cardHtml.replace(/Кок­тейль дет­ский/g, 'Поми­до­ры слад­кие').replace(/200 мл/g, '500 г').replace(/value="1"/g, 'value="2"');
const html = `<!DOCTYPE html><html><body>
<main class="MainLayout">
 <div class="Section ProductCard__iYypj"><h2>Состав</h2>${cardHtml}${card2}</div>
 <div class="promo"><h3>Предложили купить</h3>${cardHtml.replace('cart_item_8708','promo_8708')}</div>
</main></body></html>`;

const dom = new JSDOM(html, { runScripts: 'outside-only' });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.GM_xmlhttpRequest = undefined;
global.fetch = () => Promise.reject(new Error('offline test'));
global.navigator = dom.window.navigator;

// подменяем setInterval/tick: просто вызываем функции парсинга из скрипта
let src = fs.readFileSync('lavka-calories.user.js', 'utf8');
src = src.replace('setInterval(tick, CONFIG.pollIntervalMs);', '');
src = src.replace('setStatus(\'Лавка-ккал: скрипт запущен, сканирую страницу…\');', '');
src = src.replace('tick();', 'window.__collectCartItems = collectCartItems;');
dom.window.eval(src);

const items = dom.window.__collectCartItems(dom.window.document);
console.log(JSON.stringify(items.map(i => ({ name: i.name, qty: i.qty, weightG: i.weightG })), null, 2));
if (items.length !== 2) { console.error('FAIL: expected 2 cart items, got ' + items.length); process.exit(1); }
if (items[0].qty !== 1 || items[1].qty !== 2) { console.error('FAIL: qty wrong'); process.exit(1); }
console.log('PASS: 2 товара корзины, промо отброшен, qty из input');

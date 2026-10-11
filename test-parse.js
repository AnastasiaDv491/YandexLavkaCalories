const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM(fs.readFileSync('test-cart.html', 'utf-8'), { runScripts: 'outside-only' });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.GM_xmlhttpRequest = undefined;
global.fetch = () => Promise.reject(new Error('offline test'));
global.navigator = dom.window.navigator;

let src = fs.readFileSync('lavka-calories.user.js', 'utf8');
src = src.replace('setInterval(safeTick, CONFIG.pollIntervalMs);', '');
src = src.replace("setStatus('Лавка-ккал: v0.13 запущен, сканирую страницу…');", '');
src = src.replace('safeTick();', 'window.__collectCartItems = collectCartItems;');
dom.window.eval(src);

const items = dom.window.__collectCartItems(dom.window.document);
console.log(JSON.stringify(items.map(i => ({ name: i.name, qty: i.qty, weightG: i.weightG })), null, 2));
let fail = false;
if (items.length !== 3) { console.error('FAIL: expected 3 cart items, got ' + items.length); fail = true; }
if (!fail && (items[0].qty !== 1 || items[1].qty !== 2 || items[2].qty !== 3)) { console.error('FAIL: qty wrong'); fail = true; }
if (!fail && (items[0].weightG !== 200 || items[1].weightG !== 500 || items[2].weightG !== 150)) { console.error('FAIL: weight wrong'); fail = true; }
if (!fail && items.some(i => /notr/i.test(i.name))) { console.error('FAIL: notr in name'); fail = true; }
if (!fail && !items.some(i => i.name === 'Творог мягкий 1,5% Lactica 150 г')) { console.error('FAIL: soft-hyphenated item missing'); fail = true; }
if (fail) process.exit(1);
console.log('PASS: 3 товара корзины (включая мягкие переносы), промо отброшен, qty из input, вес из text-train');

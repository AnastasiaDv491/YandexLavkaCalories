const { JSDOM } = require('jsdom');
const fs = require('fs');

const dom = new JSDOM(fs.readFileSync('test-cart.html', 'utf-8'), { runScripts: 'outside-only' });
global.window = dom.window; global.document = dom.window.document;
global.localStorage = { getItem: () => null, setItem: () => {} };
global.GM_xmlhttpRequest = undefined;
global.fetch = () => Promise.reject(new Error('offline test'));
global.navigator = dom.window.navigator;

let src = fs.readFileSync('lavka-calories.user.js', 'utf8');
src = src.replace('setInterval(tick, CONFIG.pollIntervalMs);', '');
src = src.replace("setStatus('Лавка-ккал: скрипт запущен, сканирую страницу…');", '');
src = src.replace('tick();', 'window.__collectCartItems = collectCartItems;');
dom.window.eval(src);

const items = dom.window.__collectCartItems(dom.window.document);
console.log(JSON.stringify(items.map(i => ({ name: i.name, qty: i.qty, weightG: i.weightG })), null, 2));
let fail = false;
if (items.length !== 2) { console.error('FAIL: expected 2 cart items, got ' + items.length); fail = true; }
if (!fail && (items[0].qty !== 1 || items[1].qty !== 2)) { console.error('FAIL: qty wrong'); fail = true; }
if (!fail && (items[0].weightG !== 200 || items[1].weightG !== 500)) { console.error('FAIL: weight wrong'); fail = true; }
if (!fail && !/notr/i.test(items[0].name) === false && items[0].name.includes('<notr>')) { console.error('FAIL: notr in name'); fail = true; }
if (fail) process.exit(1);
console.log('PASS: 2 товара корзины, промо отброшен, qty из input, вес из text-train');

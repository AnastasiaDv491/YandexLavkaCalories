const { JSDOM } = require('jsdom');
const fs = require('fs');
const cardHtml = fs.readFileSync('/tmp/card.html', 'utf8');
const card2 = cardHtml.replace(/Кок­тейль дет­ский/g, 'Поми­до­ры слад­кие').replace(/200 мл/g, '500 г').replace(/value="1"/g, 'value="2"');
const html = `<!DOCTYPE html><html><body>
<main class="MainLayout">
 <div class="Section ProductCard__iYypj"><h2>Состав</h2>${cardHtml}${card2}</div>
 <div class="promo"><h3>Предложили купить</h3>${cardHtml.replace('cart_item_8708','promo_8708')}</div>
</main></body></html>`;
const dom = new JSDOM(html, { runScripts: 'outside-only' });
let src = fs.readFileSync('lavka-calories.user.js', 'utf8');
src = src.replace('setInterval(tick, CONFIG.pollIntervalMs);', '');
src = src.replace("setStatus('Лавка-ккал: скрипт запущен, сканирую страницу…');", '');
src = src.replace('tick();', 'window.__dbg = { deepAllElements, isLeafCard, itemNameFromCard, isPlausibleName, findCartSection, ancestorsOf, isInExcludedBlock, CARD_RE };');
dom.window.eval(src);
const d = dom.window.document;
const dbg = dom.window.__dbg;
const all = dbg.deepAllElements(d);
console.log('total elements:', all.length);
const cards = all.filter(el => dbg.isLeafCard(el, all));
console.log('leaf cards:', cards.map(c => c.className.slice(0,40) + ' | name=' + dbg.itemNameFromCard(c).slice(0,40) + ' | excl=' + dbg.isInExcludedBlock(c)));
const cartRoot = dbg.findCartSection(d);
console.log('cartRoot class:', cartRoot === d ? 'DOCUMENT' : (cartRoot.className || cartRoot.tagName));
console.log('ancestors of first ProductListItem include cartRoot?', (() => { const li = all.find(e => /ProductListItem/.test(e.className||'')); return dbg.ancestorsOf(li).includes(cartRoot); })());

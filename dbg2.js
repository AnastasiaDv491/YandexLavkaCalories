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
src = src.replace('tick();', 'window.__dbg = { deepAllElements, ancestorsOf, CARD_RE, itemNameFromCard, isPlausibleName, isInExcludedBlock, itemFromNode, dedupeByNames, findCartSection };');
dom.window.eval(src);
const d = dom.window.document, dbg = dom.window.__dbg;
const all = dbg.deepAllElements(d);
const cards = all.filter(el => {
  const cls = (typeof el.className === 'string') ? el.className : '';
  if (!dbg.CARD_RE.test(cls)) return false;
  for (const a of dbg.ancestorsOf(el)) {
    if (a !== el && a !== d.body && a !== d.documentElement && typeof a.className === 'string' && dbg.CARD_RE.test(a.className)) return false;
  }
  return true;
});
console.log('leaf cards:', cards.length);
let items = [];
for (const card of cards) {
  const excl = dbg.isInExcludedBlock(card);
  const name = dbg.itemNameFromCard(card);
  const plaus = dbg.isPlausibleName(name);
  console.log('card:', card.className.slice(0,30), '| excl=', excl, '| name=', JSON.stringify(name).slice(0,60), '| plaus=', plaus);
  if (!excl && plaus) items.push(dbg.itemFromNode(card, name));
}
items = dbg.dedupeByNames(items);
console.log('items before scope:', items.map(i => ({key:i.key, name:i.name.slice(0,25), qty:i.qty})));
const cartRoot = dbg.findCartSection(d);
const scoped = items.filter(it => it.el === cartRoot || dbg.ancestorsOf(it.el).includes(cartRoot));
console.log('scoped:', scoped.length);

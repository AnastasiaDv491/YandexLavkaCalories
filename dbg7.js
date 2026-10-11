const { JSDOM } = require('jsdom');
const fs = require('fs');
const cardHtml = fs.readFileSync('/tmp/card.html', 'utf8');
const card2 = cardHtml.replace(/Кок­тейль дет­ский/g, 'Поми­до­ры слад­кие').replace(/200 мл/g, '500 г').replace(/value="1"/g, 'value="2"');
const html = `<!DOCTYPE html><html><body><main class="MainLayout"><div class="Section ProductCard__iYypj"><h2>Состав</h2>${cardHtml}${card2}</div></main></body></html>`;
const dom = new JSDOM(html);
let src = fs.readFileSync('lavka-calories.user.js', 'utf8');
src = src.replace('setInterval(tick, CONFIG.pollIntervalMs);', '');
src = src.replace("setStatus('Лавка-ккал: скрипт запущен, сканирую страницу…');", '');
src = src.replace('tick();', 'this.__dbg = { deepAllElements, ancestorsOf, CARD_RE };');
dom.window.eval(src);
const d = dom.window.document, dbg = dom.window.__dbg;
const all = dbg.deepAllElements(d);
const cardEls = all.filter(el => { const c=(typeof el.className==='string')?el.className:''; return dbg.CARD_RE.test(c); });
console.log('CARD_RE matches:', cardEls.length);
for (const el of cardEls) console.log(' -', el.className.slice(0,40));
const leaves = cardEls.filter(el => {
  for (const a of dbg.ancestorsOf(el)) {
    if (a !== el && a !== d.body && a !== d.documentElement && typeof a.className === 'string' && dbg.CARD_RE.test(a.className)) return false;
  }
  return true;
});
console.log('leaves:', leaves.map(l => l.className.slice(0,40)));

const { JSDOM } = require('jsdom');
const fs = require('fs');
const cardHtml = fs.readFileSync('/tmp/card.html', 'utf8');
const card2 = cardHtml.replace(/Кок­тейль дет­ский/g, 'Поми­до­ры слад­кие').replace(/200 мл/g, '500 г').replace(/value="1"/g, 'value="2"');
const html = `<!DOCTYPE html><html><body><main class="MainLayout"><div class="Section ProductCard__iYypj"><h2>Состав</h2>${cardHtml}${card2}</div></main></body></html>`;
const dom = new JSDOM(html);
const d = dom.window.document;
console.log('li count:', d.querySelectorAll('[class*="ProductListItem"]').length);
console.log('card count:', d.querySelectorAll('[class*="ProductCard"], [class*="ProductSnippet"]').length);
// ancestors check for 2nd li
const lis = d.querySelectorAll('[class*="ProductListItem"]');
let cur = lis[1]; const anc = [];
while (cur) { anc.push(cur.className || cur.tagName); if (cur.parentElement) cur = cur.parentElement; else { const r = cur.getRootNode(); cur = r && r.host ? r.host : null; } }
console.log('CARD_RE test on ancestors:', anc.map(a => /ProductListItem|ProductCard|ProductSnippet/.test(a)));

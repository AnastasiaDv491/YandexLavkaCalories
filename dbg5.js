const { JSDOM } = require('jsdom');
const fs = require('fs');
const cardHtml = fs.readFileSync('/tmp/card.html', 'utf8');
const card2 = cardHtml.replace(/Кок­тейль дет­ский/g, 'Поми­до­ры слад­кие').replace(/200 мл/g, '500 г').replace(/value="1"/g, 'value="2"');
const html = `<!DOCTYPE html><html><body><main class="MainLayout"><div class="Section ProductCard__iYypj"><h2>Состав</h2>${cardHtml}${card2}</div></main></body></html>`;
const dom = new JSDOM(html);
const d = dom.window.document;
// manual ancestorsOf like in script
function ancestorsOf(el) { const res=[]; let cur=el; while(cur){res.push(cur); if(cur.parentElement){cur=cur.parentElement;continue;} const root=cur.getRootNode?cur.getRootNode():null; cur=root&&root.host?root.host:null;} return res; }
const lis = [...d.querySelectorAll('[class*="ProductListItem"]')];
for (const li of lis) {
  const anc = ancestorsOf(li);
  const cardAnc = anc.filter(a => a !== li && typeof a.className === 'string' && /ProductListItem|ProductCard|ProductSnippet/.test(a.className));
  console.log('li:', li.getAttribute('data-testid').slice(0,20), '| cardAncestors:', cardAnc.map(a => a.className.slice(0,30)));
}

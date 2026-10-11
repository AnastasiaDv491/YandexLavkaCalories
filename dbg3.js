const { JSDOM } = require('jsdom');
const fs = require('fs');
const cardHtml = fs.readFileSync('/tmp/card.html', 'utf8');
const card2 = cardHtml.replace(/Кок­тейль дет­ский/g, 'Поми­до­ры слад­кие').replace(/200 мл/g, '500 г').replace(/value="1"/g, 'value="2"');
const html = `<!DOCTYPE html><html><body><main class="MainLayout"><div class="Section ProductCard__iYypj"><h2>Состав</h2>${cardHtml}${card2}</div></main></body></html>`;
const dom = new JSDOM(html);
const lis = dom.window.document.querySelectorAll('.ProductListItem__ZUfTI');
console.log('count:', lis.length);
for (const li of lis) console.log('cls:', li.className);

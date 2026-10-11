// ==UserScript==
// @name         Яндекс Лавка — Калории в корзине
// @namespace    https://github.com/AnastasiaDv491/YandexLavkaCalories
// @version      0.1.0 (MVP)
// @description  Показывает примерное количество ккал товаров корзины, считая данные из открытого API Open Food Facts
// @author       AnastasiaDv491
// @match        https://lavka.yandex.ru/*
// @match        https://yandex.ru/lavka/*
// @grant        GM_xmlhttpRequest
// @connect      world.openfoodfacts.org
// @connect      ru.openfoodfacts.org
// @noframes
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
   * НАСТРОЙКИ
   * ============================================================ */

  const CONFIG = {
    //Selectors для парсинга DOM. Лавка меняет классы — при необходимости
    //подправьте под актуальную верстку (см. README → «Как подобрать селекторы»).
    itemSelector: '[data-qa="basket-item"], [data-auto="basketItem"], li[class*="basket"] [class*="item"]',
    nameSelector: '[data-auto="productCardTitle"], [class*="productName"], [class*="ProductCard_title"], h3, h4',
    qtySelector: '[data-auto="quantityControl"], [class*="quantity"], [class*="counter"]',
    priceSelector: '[class*="price" i]',

    pollIntervalMs: 2000,     // как часто пересканировать корзину
    cacheTtlDays: 30,         // срок жизни кэша калорийности
    maxPerItemKcal: 5000,     // защита от абсурдных значений
  };

  const OFF_URLS = [
    'https://world.openfoodfacts.org/cgi/search.pl',
    'https://ru.openfoodfacts.org/cgi/search.pl',
  ];

  /* ============================================================
   * КЭШ (localStorage): штрихкод/название -> kcal на 100 г + вес фасовки
   * ============================================================ */

  const CACHE_KEY = 'lavka_kcal_cache_v1';

  function loadCache() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY)) || {};
    } catch (e) {
      return {};
    }
  }

  function saveCache(cache) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch (e) { /* квота — просто игнорируем */ }
  }

  function cacheGet(key) {
    const entry = loadCache()[key];
    if (!entry) return null;
    if (Date.now() - entry.ts > CONFIG.cacheTtlDays * 86400000) return null;
    return entry.value;
  }

  function cacheSet(key, value) {
    const cache = loadCache();
    cache[key] = { ts: Date.now(), value };
    saveCache(cache);
  }

  /* ============================================================
   * ЗАПРОСЫ К OPEN FOOD FACTS (бесплатный открытый API)
   * Иерархия поиска: штрихкод -> название (поиск)
   * Возвращает: { kcalPer100g, weightG } | null
   * ============================================================ */

  function parseNutriments(n) {
    if (!n) return null;
    const kcal =
      n['energy-kcal_100g'] ??
      (n['energy_100g'] ? Math.round(n['energy_100g'] / 4.184) : null);
    if (!kcal || kcal <= 0 || kcal > CONFIG.maxPerItemKcal) return null;
    return {
      kcalPer100g: kcal,
      weightG: n.quantity_g || null,
    };
  }

  // Извлекаем вес фасовки из строки вида "350 г", "0,5 л", "1 кг"
  function extractWeightGrams(str) {
    if (!str) return null;
    const m = String(str).replace(',', '.').match(/(\d+(?:\.\d+)?)\s*(г|грамм|kg|кг|ml|мл|л)\b/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'kg' || unit === 'кг') return v * 1000;
    if (unit === 'ml') return v;      // для жидкостей ~1 г = 1 мл
    if (unit === 'л' || unit === 'l') return v * 1000;
    return v; // г / грамм
  }

  function offFetch(url) {
    return new Promise((resolve) => {
      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          headers: { 'User-Agent': 'LavkaCaloriesMVP/0.1 (personal userscript)' },
          timeout: 10000,
          onload: (res) => {
            try { resolve(JSON.parse(res.responseText)); } catch (e) { resolve(null); }
          },
          onerror: () => resolve(null),
          ontimeout: () => resolve(null),
        });
      } else {
        // Фолбэк без Tampermonkey (CORS может не пустить)
        fetch(url)
          .then((r) => r.ok ? r.json() : null)
          .catch(() => null)
          .then(resolve);
      }
    });
  }

  async function lookupByBarcode(barcode) {
    for (const base of ['https://world.openfoodfacts.org/api/v2/product',
                        'https://ru.openfoodfacts.org/api/v2/product']) {
      const data = await offFetch(`${base}/${encodeURIComponent(barcode)}.json?fields=product_name,nutriments,quantity`);
      if (data && data.status === 1 && data.product) {
        const parsed = parseNutriments(data.product.nutriments);
        if (parsed) return parsed;
      }
    }
    return null;
  }

  async function lookupByName(name) {
    const q = encodeURIComponent(name);
    for (let i = 0; i < OFF_URLS.length; i++) {
      const url = `${OFF_URLS[i]}?search_terms=${q}&search_simple=1&action=process&json=1` +
                  `&page_size=5&fields=product_name,nutriments,quantity,brands`;
      const data = await offFetch(url);
      const products = data && data.products ? data.products : [];
      // Простое совпадение: берем первый продукт с калорийностью,
      // чье название сильно пересекается с названием товара
      for (const p of products) {
        if (!similar(name, p.product_name)) continue;
        const parsed = parseNutriments(p.nutriments);
        if (parsed) return parsed;
      }
    }
    return null;
  }

  function similar(a, b) {
    if (!a || !b) return false;
    a = a.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    b = b.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const wa = new Set(a.split(' ')), wb = new Set(b.split(' '));
    let inter = 0;
    wa.forEach((w) => { if (w.length > 2 && wb.has(w)) inter++; });
    return inter >= Math.min(2, Math.min(wa.size, wb.size));
  }

  /**
   * Главный поиск калорийности товара.
   * item: { name, barcode, weightG (из верстки), qty }
   * Возвращает: { kcalTotal, source, known } | { known:false }
   */
  async function getKcal(item) {
    const key = item.barcode ? `bc:${item.barcode}` : `nm:${item.name.toLowerCase()}`;
    let cached = cacheGet(key);

    if (cached === undefined) {
      // нет в кэше — идем в API
      let found = (item.barcode && await lookupByBarcode(item.barcode)) ||
                  (await lookupByName(item.name));
      cached = found || 'unknown';
      cacheSet(key, cached);
    }

    if (cached === 'unknown') return { known: false };

    // kcal = kcal/100g * вес_товара * количество
    const weightG = item.weightG || cached.weightG;
    if (!weightG) return { known: false, reason: 'no-weight' };
    const kcal = Math.round((cached.kcalPer100g * weightG * item.qty) / 100);
    return { known: true, kcalTotal: kcal, source: item.barcode ? 'barcode' : 'name' };
  }

  /* ============================================================
   * ПАРСИНГ DOM КОРЗИНЫ
   * ============================================================ */

  function findBarcodeInNode(node) {
    // Штрихкод иногда лежит в data-* атрибутах или в тексте карточки
    const el = node.closest('[data-barcode], [data-sku], [data-product-code]');
    if (el) {
      const v = el.dataset.barcode || el.dataset.sku || el.dataset.productCode;
      if (v && /^\d{8,14}$/.test(v)) return v;
    }
    const m = node.textContent.match(/\b(\d{13})\b/);
    return m ? m[1] : null;
  }

  function parseQuantity(node) {
    const qEl = node.querySelector(CONFIG.qtySelector);
    if (qEl) {
      const m = qEl.textContent.match(/(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    return 1;
  }

  function collectCartItems(root) {
    const nodes = root.querySelectorAll(CONFIG.itemSelector);
    const items = [];
    nodes.forEach((node) => {
      const nameEl = node.querySelector(CONFIG.nameSelector);
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (!name) return;
      items.push({
        el: node,
        name,
        barcode: findBarcodeInNode(node),
        weightG: extractWeightGrams(node.textContent),
        qty: parseQuantity(node),
      });
    });
    return items;
  }

  /* ============================================================
   * UI ВИДЖЕТ (рядом с итогом корзины)
   * ============================================================ */

  function ensureWidget(container) {
    let w = document.getElementById('lavka-kcal-widget');
    if (w) return w;
    w = document.createElement('div');
    w.id = 'lavka-kcal-widget';
    Object.assign(w.style, {
      marginTop: '8px', padding: '8px 12px', borderRadius: '10px',
      background: '#f5f5ff', border: '1px solid #d0d0f0',
      fontFamily: 'inherit', fontSize: '14px', lineHeight: '1.4',
    });
    container.appendChild(w);
    return w;
  }

  function renderWidget(widget, total, knownCount, totalCount, details) {
    if (totalCount === 0) { widget.innerHTML = ''; widget.style.display = 'none'; return; }
    widget.style.display = 'block';
    const label = total != null
      ? `≈ ${total.toLocaleString('ru-RU')} ккал`
      : 'Калории неизвестны';
    const coverage = `известно для ${knownCount} из ${totalCount}`;
    const rows = details.map((d) =>
      `<div style="font-size:12px;color:#555">${d}</div>`).join('');
    widget.innerHTML =
      `<div style="display:flex;justify-content:space-between;align-items:center">` +
        `<strong>${label}</strong><span style="color:#888;font-size:12px">${coverage}</span>` +
      `</div><details style="margin-top:4px"><summary style="cursor:pointer;font-size:12px;color:#666">по товарам</summary>${rows}</details>`;
  }

  /* ============================================================
   * ОСНОВНОЙ ЦИКЛ
   * ============================================================ */

  let lastHtmlHash = '';
  let running = false;

  // Индикатор внизу страницы: сразу видно, работает ли скрипт и что он нашел.
  // Если через ~10 сек индикатора нет — Tampermonkey не запускает скрипт на этом сайте.
  let statusEl = null;
  function setStatus(text) {
    if (!statusEl) {
      statusEl = document.createElement('div');
      statusEl.id = 'lavka-kcal-status';
      Object.assign(statusEl.style, {
        position: 'fixed', bottom: '8px', right: '8px', zIndex: 999998,
        background: '#222', color: '#fafafa', padding: '6px 10px',
        borderRadius: '8px', font: '12px sans-serif', opacity: '0.85',
      });
      document.body.appendChild(statusEl);
    }
    statusEl.textContent = text;
  }

  async function tick() {
    if (running) return;
    running = true;
    try {
      const cartRoot = document; // ищем по всей странице
      const items = collectCartItems(cartRoot);
      if (items.length === 0) {
        setStatus(`Лавка-ккал: товаров не найдено (${CONFIG.itemSelector.slice(0, 40)}…)`);
        return;
      }

      // простой debounce: пересчитываем только если корзина изменилась
      const hash = items.map((i) => i.name + '|' + i.qty).join(';');
      if (hash === lastHtmlHash) return;
      lastHtmlHash = hash;

      const results = await Promise.all(items.map(getKcal));

      let total = 0, knownCount = 0;
      const details = [];
      results.forEach((r, idx) => {
        const it = items[idx];
        if (r.known) {
          knownCount++;
          total += r.kcalTotal;
          details.push(`${it.name} ×${it.qty}: ${r.kcalTotal} ккал (${r.source})`);
        } else {
          details.push(`${it.name} ×${it.qty}: нет данных${r.reason === 'no-weight' ? ' (не найден вес)' : ''}`);
        }
      });

      // Вставляем виджет рядом с блоком итога (ищем элемент со словом «Итого»)
      const summaryEl = [...document.querySelectorAll('div,section')]
        .find((el) => el.children.length < 8 && /итого/i.test(el.textContent) && el.getBoundingClientRect().width < 500);
      const widget = ensureWidget(summaryEl ? summaryEl.parentElement : document.body);
      renderWidget(widget, knownCount > 0 ? total : null, knownCount, items.length, details);
      setStatus(`Лавка-ккал: товаров ${items.length}, ккал посчитано для ${knownCount}${summaryEl ? '' : ' (блок «Итого» не найден — виджет в углу страницы)'}`);
    } finally {
      running = false;
    }
  }

  setInterval(tick, CONFIG.pollIntervalMs);
  setStatus('Лавка-ккал: скрипт запущен, сканирую страницу…');
  tick();
})();

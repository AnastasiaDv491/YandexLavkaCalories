// ==UserScript==
// @name         Яндекс Лавка — Калории в корзине
// @namespace    https://github.com/AnastasiaDv491/YandexLavkaCalories
// @version      0.7.0 (MVP)
// @description  Показывает примерное количество ккал товаров корзины, считая данные из открытого API Open Food Facts
// @author       AnastasiaDv491
// @match        *://lavka.yandex.ru/*
// @match        *://yandex.ru/lavka/*
// @include      /^https?:\/\/.*yandex\.(ru|net)\/.*$/
// @grant        GM_xmlhttpRequest
// @connect      world.openfoodfacts.org
// @connect      ru.openfoodfacts.org
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
    //Селекторы-эвристики используются только если data-атрибуты не нашли товары.
    itemSelector: '[data-qa="basket-item"], [data-auto="basketItem"], [data-qa^="product-card"], [data-auto^="productCard"]',
    fallbackItemSelector: 'a[href*="/product/"]',   // карточка товара = ссылка на страницу товара
    nameSelector: '[data-auto="productCardTitle"], [data-qa="product-name"], [class*="productName"], [class*="ProductCard_title"], h3, h4',
    qtySelector: '[data-auto="quantityControl"], [class*="quantity" i], [class*="counter" i]',
    priceSelector: '[class*="price" i]',

    pollIntervalMs: 1500,     // как часто пересканировать корзину
    cacheTtlDays: 30,         // срок жизни кэша калорийности
    maxPerItemKcal: 5000,     // защита от абсурдных значений

    // «Состав» — заголовок блока с позициями корзины. Товары ищем ВНУТРИ него,
    // чтобы не захватывать блок «Похожие товары / предложили купить».
    cartSectionHeading: /^состав$/i,
    excludeKeywords: ['похожие', 'вместе дешевле', 'часто берут', 'с этим товаром', 'рекомендуем', 'покупали'],
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
    // эвристика: «×2», «2 шт» в тексте карточки (без мягких переносов)
    const m2 = cleanName(node.textContent).match(/[×x]\s*(\d{1,3})\b|(\d{1,3})\s*шт\b/i);
    if (m2) return parseInt(m2[1] || m2[2], 10);
    return 1;
  }

  // Основной путь: карточка = div с классом ProductListItem (позиции корзины)
  // или ProductCard/ProductSnippet (карточки товаров). Названия берем из alt картинок.
  const CARD_SELECTOR = '[class*="ProductListItem"], [class*="ProductCard"], [class*="ProductSnippet"]';

  // Все элементы deep-обхода (включая shadow DOM), чтобы querySelector работал по ним
  function deepAllElements(root, acc) {
    acc = acc || [];
    try {
      root.querySelectorAll('*').forEach((el) => {
        acc.push(el);
        if (el.shadowRoot) deepAllElements(el.shadowRoot, acc);
      });
    } catch (e) { /* ignore */ }
    return acc;
  }

  // Список shadow-хостов среди предков элемента (parentElement не проходит границу shadow root)
  function ancestorsOf(el, all) {
    const res = [];
    let cur = el;
    while (cur) {
      res.push(cur);
      if (cur.parentElement) { cur = cur.parentElement; continue; }
      // дошли до shadow root — прыгаем на его хост
      const root = cur.getRootNode ? cur.getRootNode() : null;
      cur = root && root.host ? root.host : null;
    }
    return res;
  }

  // Карточка — это элемент с подходящим классом, НЕ содержащий другую такую же карточку
  // (иначе ProductListItem внутри Section.ProductCard съел бы все позиции корзины).
  // Проверка «вложенности» идёт по deep-списку всех элементов (shadow DOM included),
  // потому что querySelectorAll не заглядывает внутрь shadow root.
  const CARD_RE = /ProductListItem|ProductCard|ProductSnippet/;
  function isLeafCard(el, all) {
    const cls = (typeof el.className === 'string') ? el.className : '';
    if (!CARD_RE.test(cls)) return false;
    const anc = ancestorsOf(el, all);
    for (const c of all) {
      if (c === el) continue;
      const ccls = (typeof c.className === 'string') ? c.className : '';
      if (!CARD_RE.test(ccls)) continue;
      // c — предок el? тогда el вложен в карточку c и сам листом не является
      if (anc.includes(c) && c !== document.body && c !== document.documentElement) {
        // но только если c НЕ потомок el (защита от циклов — теоретически невозможно)
        return false;
      }
    }
    return true;
  }

  function collectCardItems(root) {
    // Листовые карточки ищем во всём документе: блок «Состав» может быть секцией-обёрткой,
    // а может и не находиться вовсе — фолбэк лучше, чем пустой результат.
    // isLeafCard учитывает shadow DOM (querySelectorAll внутрь shadow root не заглядывает).
    const all = deepAllElements(document);
    const cards = all.filter((el) => isLeafCard(el, all));
    let items = [];
    for (const card of cards) {
      if (isInExcludedBlock(card)) continue;  // «похожие товары» и т.п. — не позиции корзины
      const name = itemNameFromCard(card);
      if (!isPlausibleName(name)) continue;
      items.push(itemFromNode(card, name));
    }
    items = dedupeByElement(items);

    // Скоупинг: если найден блок «Состав», оставляем только карточки из него
    // (исключаем промо «предложили купить»). Сравнение — по нашему deep-списку
    // предков, а не через Node.contains (не работает для shadow-элементов).
    const cartRoot = findCartSection(root);
    if (cartRoot !== root && items.length > 0) {
      const scoped = items.filter((it) => it.el === cartRoot || ancestorsOf(it.el, all).includes(cartRoot));
      if (scoped.length > 0) items = scoped;
    }
    return items;
  }

  // Блок с позициями корзины: в Лавке он озаглавлен «Состав». Ищем заголовок
  // с точным текстом «Состав», поднимаемся до его секции-контейнера и берём
  // ВСЕ карточки из неё. Если ничего не нашлось — фолбэк на весь документ
  // (лучше показать лишние промо-карточки, чем ничего).
  function findCartSection(root) {
    const heads = deepQueryAll(root, 'h1, h2, h3, h4, span, div');
    for (const h of heads) {
      const t = cleanName(h.textContent);
      if (!CONFIG.cartSectionHeading.test(t)) continue;
      // листовый элемент с текстом ровно «Состав»
      let childText = false;
      for (const c of h.children) {
        if ((c.textContent || '').trim().length > 3) { childText = true; break; }
      }
      if (childText) continue;
      // поднимаемся до предка, внутри которого есть карточка товара
      let el = h;
      for (let i = 0; i < 10 && el.parentElement; i++) {
        el = el.parentElement;
        try {
          if (el.querySelector(CARD_SELECTOR)) return el;
        } catch (e) { /* ignore */ }
      }
    }
    return root; // фолбэк: вся страница/фрейм
  }

  // Карточка belongs к промомо-блоку («Похожие товары» и т.п.), если рядом есть такой заголовок
  function isInExcludedBlock(card) {
    let el = card;
    for (let i = 0; i < 6 && el; i++) {
      const prev = el.previousElementSibling;
      const sibs = prev ? [prev] : [];
      for (const s of sibs) {
        const t = cleanName(s.textContent).toLowerCase();
        if (CONFIG.excludeKeywords.some((k) => t.includes(k))) return true;
      }
      el = el.parentElement;
    }
    return false;
  }

  // Эвристика для названий: не «заголовки-меню», а похожи на товар
  const BAD_WORDS = new Set([
    'корзина', 'очистить', 'доставка', 'итого', 'оформить', 'товары', 'состав',
    'купить', 'лавка', 'каталог', 'избранное', 'скидка', 'скидки', 'цена',
    '₽', 'г', 'кг', 'мл', 'шт', 'за', 'шт.', 'вместо', 'обычной', 'бесплатной',
  ]);

  function isPlausibleName(name) {
    if (!name || name.length < 3 || name.length > 120) return false;
    if (/^[^\p{L}]*$/u.test(name)) return false;        // без букв — не название
    if (/^(еще|ёще|пропустить|перейти|показать|вернуться)/i.test(name)) return false;
    if (/\d+\s*₽/.test(name)) return false;             // название с ценой — это блок целиком
    const words = name.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);
    if (words.length === 0) return false;
    const meaningful = words.filter((w) => w.length > 2 && !BAD_WORDS.has(w));
    return meaningful.length >= 1;
  }

  // Картинка товара в Лавке имеет alt, равный названию («Коктейль детский… банан»).
  // Это самый надежный источник чистого названия: без «изображение», цен и прочего мусора.
  function cleanName(s) {
    if (!s) return '';
    return String(s)
      .replace(/<notr>/gi, ' ')
      .replace(/\u00ad/g, '')                       // мягкие переносы (Кок­тейль -> Коктейль)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function itemNameFromCard(card) {
    // 1) alt картинки товара — предпочтительный источник.
    // querySelectorAll не заглядывает в shadow DOM, поэтому идем по deep-списку.
    const all = deepAllElements(card);
    let best = '';
    for (const el of all) {
      if (el.tagName !== 'IMG') continue;
      const a = cleanName(el.getAttribute('alt') || '');
      if (isPlausibleName(a) && a.length > best.length) best = a;
    }
    if (best) return best;
    // 2) эвристика по текстовым элементам карточки (с очисткой от мягких переносов)
    for (const el of all) {
      if (!/^(SPAN|DIV|A|H3|H4)$/.test(el.tagName)) continue;
      const t = cleanName(el.textContent);
      if (!isPlausibleName(t)) continue;
      let childText = false;
      for (const c of el.children) {
        if ((c.textContent || '').trim().length > 3) { childText = true; break; }
      }
      if (!childText) return t;
    }
    return '';
  }

  function itemFromNode(node, name) {
    const text = cleanName(node.textContent);
    return {
      el: node,
      name,
      barcode: findBarcodeInNode(node),
      weightG: extractWeightGrams(text),
      qty: parseQuantity(node),
    };
  }

  function dedupeByElement(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      // если элемент уже есть или вложен в уже взятый — пропускаем
      let dup = false;
      for (const s of seen) {
        if (s === it.el || s.contains(it.el) || it.el.contains(s)) { dup = true; break; }
      }
      if (dup) continue;
      seen.add(it.el);
      out.push(it);
    }
    return out;
  }

  // Глубокий обход: обычный DOM + shadow DOM (Лавка может рендерить корзину в теневом дереве)
  function deepQueryAll(root, selector, acc) {
    acc = acc || [];
    try { root.querySelectorAll(selector).forEach((el) => acc.push(el)); } catch (e) { /* ignore */ }
    try {
      root.querySelectorAll('*').forEach((el) => {
        if (el.shadowRoot) deepQueryAll(el.shadowRoot, selector, acc);
      });
    } catch (e) { /* ignore */ }
    return acc;
  }

  // Третий уровень эвристики: «карточка» = текстовый элемент с названием товара,
  // внутри блока которого есть картинка и цена. Работает без data-атрибутов и ссылок.
  function collectCardLikeItems(root) {
    const items = [];
    const texts = deepQueryAll(root, 'span, div, a, h3, h4');
    for (const el of texts) {
      let txt = cleanName(el.textContent);
      if (!isPlausibleName(txt)) continue;
      // листовость: у элемента нет дочерних элементов со значимым текстом
      let childText = false;
      for (const c of el.children) {
        if ((c.textContent || '').trim().length > 3) { childText = true; break; }
      }
      if (childText) continue;
      // поднимаемся до ближайшего предка, где есть и картинка, и цена — это карточка
      let card = el;
      for (let i = 0; i < 6 && card.parentElement; i++) {
        card = card.parentElement;
        const t = card.textContent || '';
        if (/₽/.test(t) && (card.querySelector('img') || card.querySelector('[class*="image" i], [class*="media" i]'))) break;
        card = null;
      }
      if (!card) continue;
      // если название начинается не с начала текста — чистим префиксы («Коктейль ... банан»)
      items.push(itemFromNode(card, txt));
    }
    return dedupeByElement(items);
  }

  function collectCartItems(root) {
    // 1) основной путь — карточки по стабильным классам Лавки + названия из alt картинок
    let items = collectCardItems(root);

    // 2) data-атрибуты (если Лавка вернет их в будущей верстке)
    if (items.length === 0) {
      root.querySelectorAll(CONFIG.itemSelector).forEach((node) => {
        const nameEl = node.querySelector(CONFIG.nameSelector);
        const name = nameEl ? cleanName(nameEl.textContent) : itemNameFromCard(node);
        if (!isPlausibleName(name)) return;
        items.push(itemFromNode(node, name));
      });
      items = dedupeByElement(items);
    }

    // 3) фолбэк — ссылки на страницы товаров: их родитель-карточка и есть товар
    if (items.length === 0) {
      root.querySelectorAll(CONFIG.fallbackItemSelector).forEach((a) => {
        const card = a.closest('li, article, [class*="card" i], [class*="Card"]') || a.parentElement || a;
        const name = itemNameFromCard(card) || cleanName(a.textContent).split('\n')[0].trim();
        if (!isPlausibleName(name)) return;
        items.push(itemFromNode(card, name));
      });
    }

    // 4) последняя эвристика — блоки «картинка + название + цена»
    if (items.length === 0) {
      items = collectCardLikeItems(root);
    }

    return dedupeByElement(items);
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
      let items;
      try {
        items = collectCartItems(cartRoot);
      } catch (e) {
        setStatus('Лавка-ккал: ошибка сканирования — ' + e.message);
        console.error('[lavka-kcal]', e);
        return;
      }
      if (items.length === 0) {
        setStatus('Лавка-ккал: товаров не найдено. Откройте корзину Лавки и подождите пару секунд.');
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

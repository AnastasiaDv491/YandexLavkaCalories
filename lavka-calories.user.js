// ==UserScript==
// @name         Яндекс Лавка — Калории в корзине
// @namespace    https://github.com/AnastasiaDv491/YandexLavkaCalories
// @version      0.18 (MVP)
// @description  Показывает суммарные ккал товаров корзины: КБЖУ берутся из карточек самой Яндекс Лавки (страницы /good/<id>), при отсутствии — из открытого API Open Food Facts
// @author       AnastasiaDv491
// @match        *://lavka.yandex.ru/*
// @match        *://yandex.ru/lavka/*
// @include      /^https?:\/\/.*yandex\.(ru|net)\/.*$/
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
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

  // v3: КЛЮЧ ИЗМЕНЁН — в v2 мог попасть битый кэш (см. ошибку «reading kcalPer100g»:
  // записи вида {"value":{"kcalPer100g":null}} проходили проверку `if (!entry)` и
  // затем роняли расчёт). Кроме того, сам кэш переехал в GM storage: корзина Лавки
  // может открываться в iframe другого yandex-домена, и localStorage там изолирован.
  const CACHE_KEY = 'lavka_kcal_cache_v3';

  function loadCache() {
    let raw = null;
    try {
      if (typeof GM_getValue === 'function') raw = GM_getValue(CACHE_KEY, null);
    } catch (e) { /* ignore */ }
    if (raw == null) {
      try { raw = localStorage.getItem(CACHE_KEY); } catch (e) { /* ignore */ }
    }
    try {
      const obj = raw ? JSON.parse(raw) : null;
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveCache(cache) {
    const json = JSON.stringify(cache);
    try {
      if (typeof GM_setValue === 'function') GM_setValue(CACHE_KEY, json);
      else localStorage.setItem(CACHE_KEY, json);
    } catch (e) { /* квота — просто игнорируем */ }
  }

  function cacheGet(key) {
    const entry = loadCache()[key];
    if (!entry) return undefined; // не найдено — идем за данными
    if (Date.now() - entry.ts > CONFIG.cacheTtlDays * 86400000) return undefined; // устарело
    const v = entry.value;
    // жёсткая защита от повреждённых записей любого вида
    if (v !== 'unknown' && v !== null && typeof v === 'object' && typeof v.kcalPer100g !== 'number') {
      return undefined; // переспросим данные
    }
    return v; // 'unknown' | null | { kcalPer100g, weightG? }
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
    const m = String(str).replace(/\u00a0/g, ' ').replace(',', '.').match(/(\d+(?:[.,]\d+)?)\s*(кг|kg|грамм|г|мл|ml|литр|л)(?![\p{L}])/iu);
    if (!m) return null;
    const v = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (unit === 'kg' || unit === 'кг') return v * 1000;
    if (unit === 'ml' || unit === 'мл') return v;   // для жидкостей ~1 г = 1 мл
    if (unit === 'л' || unit === 'литр') return v * 1000;
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
   * item: { name, barcode, weightG (из верстки), qty, goodId }
   * Иерархия источников:
   *   1) карточка товара САМОЙ Лавки (страница /good/<id>, блок traits-list-per100g)
   *      — там есть КБЖУ почти для каждого товара; данные парсятся из HTML страницы;
   *   2) открытый API Open Food Facts (штрихкод -> название) — фолбэк.
   * Возвращает: { kcalTotal, source, known } | { known:false }
   */
  async function getKcal(item) {
    const key = item.goodId ? `good:${item.goodId}`
              : item.barcode ? `bc:${item.barcode}`
              : `nm:${item.name.toLowerCase()}`;
    let cached = cacheGet(key);

    if (cached === undefined) {
      // нет в кэше — сначала страница товара Лавки, затем OFF
      let found = null;
      if (item.goodId) {
        try { found = await lookupLavkaGood(item.goodId); } catch (e) { /* ignore */ }
      }
      if (!found && item.barcode) found = await lookupByBarcode(item.barcode);
      if (!found) found = await lookupByName(item.name);
      cached = found || 'unknown';
      cacheSet(key, cached);
    }

    if (cached === 'unknown' || cached === null) return { known: false };
    // защита от поврежденных записей кэша (например, сохраненных до фикса cacheGet)
    if (typeof cached !== 'object' || typeof cached.kcalPer100g !== 'number') {
      cacheSet(key, 'unknown');
      return { known: false, reason: 'bad-cache' };
    }

    // kcal = kcal/100g * вес_товара * количество
    const weightG = item.weightG || cached.weightG;
    if (!weightG) return { known: false, reason: 'no-weight' };
    const kcal = Math.round((cached.kcalPer100g * weightG * item.qty) / 100);
    return { known: true, kcalTotal: kcal, source: cached.source || (item.barcode ? 'barcode' : 'name') };
  }

  /* ============================================================
   * ИСТОЧНИК №1: КБЖУ ИЗ КАРТОЧКИ ТОВАРА ЯНДЕКС ЛАВКИ
   * Реальная верстка блока (дано пользователем):
   *   section[data-testid="traits-block"]
   *     dl[data-testid="traits-list-per100g"]
   *       div.listItem > dt ("ккал") + dd[data-testid="trait-value-calories"] ("22")
   * Запрос идет на https://lavka.yandex.ru/good/<id> с credentials — страница
   * рендерится на сервере и содержит этот блок в HTML.
   * ============================================================ */

  function fetchHtml(url) {
    return new Promise((resolve) => {
      const finish = (txt) => resolve(txt || null);
      if (typeof GM_xmlhttpRequest === 'function') {
        try {
          GM_xmlhttpRequest({
            method: 'GET',
            url,
            timeout: 15000,
            onload: (res) => {
              if (res.status >= 400) return finish(null);
              // Tampermonkey не всегда отдает set-cookie для cross-origin; но запрос
              // с того же origin (lavka.yandex.ru) получает cookies автоматически.
              finish(res.responseText);
            },
            onerror: () => finish(null),
            ontimeout: () => finish(null),
          });
        } catch (e) { finish(null); }
      } else {
        fetch(url, { credentials: 'include' })
          .then((r) => (r.ok ? r.text() : null))
          .catch(() => null)
          .then(finish);
      }
    });
  }

  // Парсит HTML страницы товара и возвращает { kcalPer100g, weightG } | null
  function parseLavkaGoodHtml(html) {
    if (!html) return null;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return extractNutritionFromDoc(doc);
  }

  // Работает и с живым документом, и с распарсенным HTML страницы товара
  function extractNutritionFromDoc(doc) {
    try {
      const list = doc.querySelector('[data-testid="traits-list-per100g"]');
      if (!list) return null;
      const valEl = list.querySelector('[data-testid="trait-value-calories"]');
      let kcal = null;
      if (valEl) kcal = parseFloat((valEl.textContent || '').replace(',', '.').trim());
      if (kcal == null || isNaN(kcal)) {
        // фолбэк: пара dt "ккал" -> dd
        const dts = list.querySelectorAll('dt');
        for (const dt of dts) {
          if (/^(ккал|калории)/i.test((dt.textContent || '').trim())) {
            const dd = dt.nextElementSibling;
            if (dd) kcal = parseFloat((dd.textContent || '').replace(',', '.').trim());
            break;
          }
        }
      }
      if (kcal == null || isNaN(kcal) || kcal <= 0 || kcal > CONFIG.maxPerItemKcal) return null;
      // вес фасовки со страницы товара: ищем в title/description/тексте
      let weightG = null;
      const wText = (doc.title || '') + ' ' + ((doc.querySelector('meta[name="description"]') || {}).content || '');
      weightG = extractWeightGrams(wText);
      return { kcalPer100g: kcal, weightG: weightG, source: 'lavka' };
    } catch (e) {
      return null;
    }
  }

  async function lookupLavkaGood(goodId) {
    const html = await fetchHtml(`https://lavka.yandex.ru/good/${encodeURIComponent(goodId)}`);
    return parseLavkaGoodHtml(html);
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
    // Актуальная верстка Лавки: счетчик позиции — input[data-testid="keyboard-input"]
    try {
      const inp = node.querySelector('input[data-testid="keyboard-input"], [data-testid="button-counter"] input');
      if (inp && /^\d{1,3}$/.test(inp.value.trim())) return parseInt(inp.value.trim(), 10);
    } catch (e) { /* ignore */ }
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
  function ancestorsOf(el) {
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

  // Ключ карточки: id товара из data-testid="cart_item_..." или ссылки /good/<id>
  function cardKey(card) {
    try {
      const tid = card.getAttribute('data-testid') || '';
      const m1 = tid.match(/cart_item_([0-9a-f]+)/i);
      if (m1) return m1[1];
      const a = card.querySelector('a[href*="/good/"]');
      if (a) {
        const m2 = (a.getAttribute('href') || '').match(/\/good\/([0-9a-zA-Z_-]+)/);
        if (m2) return m2[1];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  // Реальная верстка корзины Лавки (проверено на outerHTML позиции):
  //   div.ProductListItem[data-testid="cart_item_<id>"]     — позиция корзины
  //     a[href="/good/<id>"]                                — ссылка на товар
  //       span.linkContent.A11yText                         — ПОЛНОЕ название товара
  //     h4 (aria-hidden)                                    — сокращенное (clamp) название
  //     img[alt]                                            — полное название + мусор «<notr>»
  //     input[data-testid="keyboard-input"]                 — количество
  //     span[data-testid="text-train-value"]                — фасовка («200 мл») и цена
  // Поэтому главный путь — прямой селектор позиций, без эвристик с leaf-карточками.
  const CART_ITEM_SELECTOR = '[data-testid^="cart_item_"], [class*="ProductListItem"]';

  function fullTitleFromCard(card) {
    // 1) заголовок внутри ссылки на товар — точное полное название
    //    (важно брать a11y-span ВНУТРИ a.link, а не первый A11yText в карточке:
    //     первым идёт span с ценой «48 ₽ вместо обычной цены 69 ₽»)
    try {
      const link = card.querySelector('a[href*="/good/"]');
      const s = link ? link.querySelector('[class*="A11yText"], [role="text"]') : null;
      if (s) {
        const t = cleanName(s.textContent);
        if (isPlausibleName(t)) return t;
      }
    } catch (e) { /* ignore */ }
    // 2) alt картинки товара
    try {
      const img = card.querySelector('img');
      if (img) {
        const t = cleanName(img.getAttribute('alt') || '');
        if (isPlausibleName(t)) return t;
      }
    } catch (e) { /* ignore */ }
    // 3) видимый h4/h3 (может быть обрезан «…» — лучше, чем ничего)
    try {
      const h = card.querySelector('h4, h3');
      if (h) {
        const t = cleanName(h.textContent);
        if (isPlausibleName(t)) return t;
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function weightFromCard(card) {
    // Фасовка — отдельный элемент text-train со значением «200 мл» / «150 г».
    // Берем ТОЛЬКО значения text-train, чтобы не схватить цену («48 ₽ вместо…»).
    try {
      const vals = card.querySelectorAll('[data-testid="text-train-value"]');
      for (const v of vals) {
        const g = extractWeightGrams(cleanName(v.textContent));
        if (g) return g;
      }
    } catch (e) { /* ignore */ }
    // фолбэк: весь текст карточки (но там есть цены — extractWeightGrams их игнорирует)
    return extractWeightGrams(cleanName(card.textContent));
  }

  function collectCardItems(root) {
    let items = [];
    // 1) ГЛАВНЫЙ путь: позиции корзины — элементы data-testid="cart_item_<id>".
    // Это точный маркер именно корзинных позиций: промо-карточки («Предложили
    // купить») имеют другие testid (promo_...) или не имеют их вовсе.
    // v0.13: ищем и по document напрямую — deepQueryAll на объекте `document`
    // в некоторых окружениях может вернуть пусто, и тогда корзина «не найдена».
    let nodes = [];
    try { nodes = Array.from(document.querySelectorAll('[data-testid^="cart_item_"]')); } catch (e) { /* ignore */ }
    if (nodes.length === 0) nodes = deepQueryAll(root, '[data-testid^="cart_item_"]');
    if (nodes.length === 0) {
      // 2) фолбэк: все ProductListItem, но затем скоупинг блоком «Состав»,
      // чтобы не захватить промо-лист из той же секции.
      nodes = deepQueryAll(root, '[class*="ProductListItem"]');
    } else if (deepQueryAll(root, '[class*="ProductListItem"]').length > nodes.length) {
      // Диагностика расхождения: если ProductListItem больше, чем cart_item_,
      // значит корзина рендерится без testid (A/B или кэш). Пишем в консоль.
      try { console.warn('[lavka-kcal] cart_item_ найдено:', nodes.length, ', ProductListItem:', deepQueryAll(root, '[class*="ProductListItem"]').length); } catch (e) {}
    }
    for (const card of nodes) {
      if (isInExcludedBlock(card)) continue;  // «похожие товары» и т.п. — не позиции корзины
      const name = fullTitleFromCard(card);
      if (!isPlausibleName(name)) continue;
      const text = cleanName(card.textContent);
      items.push({
        el: card,
        key: cardKey(card),
        goodId: cardKey(card),   // id товара Лавки — главный ключ для КБЖУ со страницы /good/<id>
        name,
        barcode: findBarcodeInNode(card),
        weightG: weightFromCard(card) || extractWeightGrams(text),
        qty: parseQuantity(card),
      });
    }
    items = dedupeByNames(items);

    // Скоупинг: если среди карточек есть не-corzinные (фолбэк по ProductListItem),
    // и найден заголовок блока корзины — оставляем только карточки из него.
    if (items.some((it) => !((it.el.getAttribute && it.el.getAttribute('data-testid')) || '').startsWith('cart_item_'))) {
      const cartRoot = findCartSection(root);
      if (cartRoot !== root && items.length > 0) {
        const anc = new Set(ancestorsOf(cartRoot)); // предки блока + сам блок
        const scoped = items.filter((it) => it.el === cartRoot || ancestorsOf(it.el).some((a) => anc.has(a)));
        if (scoped.length > 0) items = scoped;
      }
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
      // Поднимаемся до предка, внутри которого есть НЕСКОЛЬКО позиций корзины
      // (data-testid="cart_item_" или класс ProductListItem). Важно: НЕ брать
      // первый предок с любой CARD_SELECTOR-карточкой — у Лавки контейнер
      // блока называется Section.ProductCard и содержит также промо («Предложили
      // купить»), а позиции лежат глубже, в отдельном списке.
      let el = h;
      let fallback = null;
      for (let i = 0; i < 12 && el.parentElement; i++) {
        el = el.parentElement;
        try {
          const nItems = el.querySelectorAll('[data-testid^="cart_item_"], [class*="ProductListItem"]').length;
          if (nItems >= 2) return el;
          if (nItems === 1 && !fallback) fallback = el;
          if (!fallback && el.querySelector(CART_ITEM_SELECTOR)) fallback = el;
        } catch (e) { /* ignore */ }
      }
      if (fallback) return fallback;
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
    if (/^(https?|\/\/)/i.test(name)) return false;     // URL — не название
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
      .replace(/<[^>]*>/g, ' ')                     // любой мусор вида «<notr>…» в alt/a11y-тексте
      .replace(/\u00ad/g, '')                       // мягкие переносы (Кок­тейль -> Коктейль)
      .replace(/\u00a0/g, ' ')                      // неразрывные пробелы («48 ₽»)
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
    // 2) актуальная верстка Лавки: видимое название в h4/h3 внутри infoContent
    try {
      const h = card.querySelector('h4, h3');
      if (h) {
        const t = cleanName(h.textContent);
        if (isPlausibleName(t)) return t;
      }
    } catch (e) { /* ignore */ }
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
      key: cardKey(node),
      name,
      barcode: findBarcodeInNode(node),
      weightG: extractWeightGrams(text),
      qty: parseQuantity(node),
    };
  }

  // Дедуп по id товара (data-testid cart_item / ссылка /good/): один и тот же товар
  // может быть обёрнут в несколько карточек-кандидатов. Если id нет — по имени+кол-ву.
  function dedupeByNames(items) {
    const seen = new Set();
    const out = [];
    for (const it of items) {
      const k = it.key ? `id:${it.key}` : `nm:${it.name.toLowerCase()}|${it.qty}`;
      if (seen.has(k)) continue;
      seen.add(k);
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
    return dedupeByNames(items);
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
      items = dedupeByNames(items);
    }

    // 3) фолбэк — ссылки на страницы товаров: их родитель-карточка и есть товар.
    // В актуальной корзине Лавки позиции содержат a[href*="/good/"], а не /product/.
    if (items.length === 0) {
      const seen = new Set();
      for (const sel of ['a[href*="/product/"]', 'a[href*="/good/"]']) {
        deepQueryAll(root, sel).forEach((a) => {
          const card = a.closest('li, article, [class*="card" i], [class*="Card"], [class*="ProductListItem"], [class*="snippet" i]') || a.parentElement || a;
          if (seen.has(card)) return;
          seen.add(card);
          const name = fullTitleFromCard(card) || itemNameFromCard(card) || cleanName(a.textContent).split('\n')[0].trim();
          if (!isPlausibleName(name)) return;
          if (isInExcludedBlock(card)) return;
          items.push({
            el: card,
            key: cardKey(card) || ('fb:' + name),
            goodId: cardKey(card),
            name,
            barcode: findBarcodeInNode(card),
            weightG: weightFromCard(card) || extractWeightGrams(cleanName(card.textContent)),
            qty: parseQuantity(card),
          });
        });
        if (items.length > 0) break; // первый сработавший селектор достаточен
      }
    }

    // 4) последняя эвристика — блоки «картинка + название + цена»
    if (items.length === 0) {
      items = collectCardLikeItems(root);
    }

    return dedupeByNames(items);
  }

  /* ============================================================
   * UI ВИДЖЕТ (рядом с итогом корзины)
   * ============================================================ */

  // v0.17.2: полный сброс наследуемых стилей Лавки + фиксированная ширина.
  // Без этого блок «сжимался»: Лавка задаёт своим контейнерам flex/grid с
  // min-width:0 и clamp-типографикой, из-за чего текст налезал друг на друга.
  // v0.18: виджет живёт в собственном fixed-хосте вне DOM Лавки и изолирован shadow DOM —
// стили/перерисовки SPA больше не могут его «сжать» или удалить.
const HOST_CSS = [
    'position:fixed !important',
    'bottom:40px !important',
    'right:8px !important',
    'width:300px !important',
    'z-index:2147483647 !important',
    'pointer-events:auto !important',
].join(';');

  function ensureHost() {
    let host = document.getElementById('lavka-kcal-host');
    if (!host || !host.isConnected) {
      host && host.remove();
      host = document.createElement('div');
      host.id = 'lavka-kcal-host';
      host.setAttribute('style', HOST_CSS);
      (document.body || document.documentElement).appendChild(host);
    }
    return host;
  }

  function ensureShadow(host) {
    let root = host.__kcalShadow;
    if (!root || !host.shadowRoot) {
      root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = [
        ':host{all:initial;display:block}',
        '*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}',
        '.card{background:#f5f5ff;border:1px solid #d0d0f0;border-radius:12px;padding:10px 14px;color:#222;font-size:14px;line-height:1.45;text-align:left;box-shadow:0 2px 10px rgba(0,0,0,.12)}',
        '.head{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px 8px}',
        '.head strong{font-weight:600;font-size:15px;color:#222}',
        '.head span{color:#888;font-size:12px}',
        'details{margin-top:6px}',
        'summary{cursor:pointer;font-size:12px;color:#666}',
        '.row{font-size:12px;color:#555;line-height:1.4;margin-top:2px;word-break:break-word}',
      ].join('\n');
      root.appendChild(style);
      const card = document.createElement('div');
      card.className = 'card';
      root.appendChild(card);
      host.__kcalShadow = root;
      host.__kcalCard = card;
    }
    return root;
  }

  function renderWidget(total, knownCount, totalCount, details) {
    const host = ensureHost();
    const root = ensureShadow(host);
    const card = host.__kcalCard;
    if (totalCount === 0) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    const label = total != null
      ? `≈ ${total.toLocaleString('ru-RU')} ккал`
      : 'Калории неизвестны';
    const coverage = `известно для ${knownCount} из ${totalCount}`;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const rows = details.map((d) => `<div class="row">${esc(d)}</div>`).join('');
    card.innerHTML =
      `<div class="head"><strong>${label}</strong><span>${coverage}</span></div>` +
      `<details><summary>по товарам</summary><div>${rows}</div></details>`;
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

  // Одноразовая диагностика пустого результата: считает базовые селекторы и пишет
  // вывод в консоль. Ключевая разгадка «зависания»: если cart_item_/ProductListItem = 0,
  // а goodLinks > 0 — корзина лежит во фрейме/окне, куда userscript не дотягивается.
  let diagLogged = false;
  function diagOnce(hasWidget) {
    const nTestId = document.querySelectorAll('[data-testid^="cart_item_"]').length;
    const nListItem = document.querySelectorAll('[class*="ProductListItem"]').length;
    const nGoodLink = document.querySelectorAll('a[href*="/good/"]').length;
    const hasBasketWords = /корзина|итого/i.test(document.body ? document.body.textContent : '');
    const info = { url: location.href, cartItemTestids: nTestId, productListItems: nListItem, goodLinks: nGoodLink, basketWordsOnPage: hasBasketWords };
    if (!diagLogged) {
      diagLogged = true;
      console.warn('[lavka-kcal] товаров не найдено:', info);
    }
    if (hasWidget) return; // результат уже показан — не затираем статус
    setStatus(`Лавка-ккал: товаров не найдено (cart_item: ${nTestId}, ProductListItem: ${nListItem}, ссылок /good/: ${nGoodLink}). Подробности — в консоли (F12).`);
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
        // Диагностика «зависания»: показываем в индикаторе и консоли, что нашли/не нашли
        // базовые селекторы. ВАЖНО (v0.13): если уже есть готовый виджет с результатом,
        // НЕ затираем его статусом «не найдено» — в SPA Лавки корзина монтируется/размонтируется
        // при переходах, и пустой tick сбрасывал бы показанный итог ккал.
        const host = document.getElementById('lavka-kcal-host');
        const hasWidget = !!(host && host.shadowRoot && host.__kcalCard && host.__kcalCard.style.display !== 'none' && host.__kcalCard.innerHTML);
        diagOnce(hasWidget);
        return;
      }

      // простой debounce: пересчитываем только если корзина изменилась
      const hash = items.map((i) => i.name + '|' + i.qty).join(';');
      if (hash === lastHtmlHash) return;
      lastHtmlHash = hash;

      // изоляция ошибок: сбой поиска по одному товару не должен ронять весь расчёт
      const results = await Promise.all(items.map((it) =>
        getKcal(it).catch((e) => {
          console.warn('[lavka-kcal] ошибка поиска для «' + it.name + '»:', e);
          return { known: false, reason: 'error' };
        })
      ));

      // Перерисовываем виджет ТОЛЬКО если корзина всё ещё на экране: страница Лавки
      // — SPA, при переходе в каталог позиции исчезают из DOM. Раньше статус
      // «товаров не найдено» перезаписывал готовый результат за 1.5 сек до того,
      // как успевали вернуться ответы Open Food Facts — казалось, что «всё зависло».
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

      // v0.18: виджет всегда в собственном fixed-хосте (справа внизу) — SPA Лавки
      // больше не может его удалить/сжать при перерисовке корзины.
      renderWidget(knownCount > 0 ? total : null, knownCount, items.length, details);
      setStatus(`Лавка-ккал: v0.18 | товаров ${items.length}, ккал посчитано для ${knownCount}`);
    } finally {
      running = false;
    }
  }

  let tickErrors = 0;
  function safeTick() {
    try {
      const p = tick();
      if (p && typeof p.catch === 'function') {
        p.catch((e) => {
          tickErrors++;
          setStatus('Лавка-ккал: ошибка расчёта #' + tickErrors + ' — ' + (e && e.message ? e.message : e));
          console.error('[lavka-kcal]', e);
        });
      }
    } catch (e) {
      tickErrors++;
      setStatus('Лавка-ккал: ошибка сканера #' + tickErrors + ' — ' + (e && e.message ? e.message : e));
      console.error('[lavka-kcal]', e);
    }
  }

  setInterval(safeTick, CONFIG.pollIntervalMs);
  setStatus('Лавка-ккал: v0.13 запущен, сканирую страницу…');
  safeTick();
})();

// Тест: cacheGet должен возвращать undefined для отсутствующих ключей,
// а getKcal — не падать на поврежденных записях кэша (баг v0.13:
// "Cannot read properties of null (reading 'kcalPer100g')")
const fs = require('fs');
const src = fs.readFileSync('lavka-calories.user.js', 'utf8');

// вырезаем функции из IIFE и исполняем в песочнице с mock localStorage
let store = {};
global.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
global.GM_xmlhttpRequest = undefined;
global.document = { addEventListener() {}, readyState: 'complete' };
global.window = global;
global.MutationObserver = class { observe() {} };
global.setTimeout = setTimeout;

// берем только верхнюю часть скрипта до парсинга DOM (кэш + OFF + getKcal)
const start = src.indexOf('const CACHE_KEY');
const end = src.indexOf('/* ============================================================\n   * ПАРСИНГ DOM');
let chunk = src.slice(src.indexOf('const CONFIG'), end);
    chunk = chunk.replace(/https:\/\/[^']*openfoodfacts[^']*/g, 'http://127.0.0.1:9/none'); // сеть недоступна -> все lookup вернут null
const fn = new Function('', chunk + '\nreturn { cacheGet, cacheSet, getKcal };');


// подставим OFF_URLS если используется
let api;
try { api = fn(); } catch (e) { console.error('LOAD FAIL:', e.message); process.exit(1); }

(async () => {
  let fails = 0;
  const check = (name, cond) => { if (!cond) { fails++; console.log('FAIL:', name); } else console.log('PASS:', name); };

  // 1) отсутствующий ключ -> undefined (не null!)
  check('cacheGet miss -> undefined', api.cacheGet('bc:123') === undefined);

  // 2) сохраненный unknown возвращается как 'unknown'
  api.cacheSet('nm:творог lacticа', 'unknown');
  check('cacheGet unknown -> "unknown"', api.cacheGet('nm:творог lacticа') === 'unknown');

  // 3) нормальный объект сохраняется и читается
  api.cacheSet('nm:коктейль банан', { kcalPer100g: 60, weightG: null });
  const c = api.cacheGet('nm:коктейль банан');
  check('cacheGet hit -> object', c && c.kcalPer100g === 60);

  // 4) getKcal с валидным кэшем считает ккал
  const r = await api.getKcal({ name: 'Коктейль банан', barcode: null, weightG: 200, qty: 2 });
  check('getKcal computes 240 kcal', r.known === true && r.kcalTotal === 240);

  // 5) getKcal на поврежденной записи (null в value) НЕ бросает исключение
  store['lavka-kcal-cache'] = JSON.stringify({ 'nm:битый': { ts: Date.now(), value: null } });
  const r2 = await api.getKcal({ name: 'Битый', barcode: null, weightG: 100, qty: 1 });
  check('getKcal bad-cache -> known:false, no throw', r2.known === false);

  // 6) нет веса -> known:false без исключения
  const r3 = await api.getKcal({ name: 'Что-то новое без веса', barcode: null, weightG: null, qty: 1 });
  check('getKcal no-weight handled', typeof r3 === 'object');

  process.exit(fails ? 1 : 0);
})();

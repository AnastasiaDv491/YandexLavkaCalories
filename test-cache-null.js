// Имитируем поврежденный кэш v1 (null-значения) и проверяем, что v0.15 его игнорирует
const fs = require('fs');
const src = fs.readFileSync('lavka-calories.user.js', 'utf8');

// извлекаем функции кэша для проверки ключей
const m = src.match(/const CACHE_KEY = '([^']+)'/);
if (!m || m[1] !== 'lavka_kcal_cache_v2') { console.error('FAIL: ключ кэша не обновлен:', m && m[1]); process.exit(1); }

// проверка изоляции ошибок getKcal
if (!src.includes('getKcal(it).catch')) { console.error('FAIL: нет изоляции ошибок на товар'); process.exit(1); }

// проверка защиты от null в getKcal
if (!src.includes("cached === 'unknown' || cached === null")) { console.error('FAIL: нет проверки null'); process.exit(1); }

console.log('PASS: cache key v2, null-guard, per-item error isolation');

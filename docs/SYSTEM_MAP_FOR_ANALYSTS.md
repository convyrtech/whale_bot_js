# Whale Bot v3.0 — Полная Системная Карта для Аналитиков
**Дата:** 21 декабря 2025  
**Цель:** Точное описание работы бота для передачи профессиональной аналитической команде

---

## 1. СТАТУС ДОКУМЕНТАЦИИ

### 1.1. Актуальность существующих документов

| Документ | Статус | Критические расхождения |
|:---|:---|:---|
| `docs/1_FUNCTIONAL.md` | ⚠️ Частично устарел | Не описаны Hard Filters, `/status`, BUY/SELL split в статистике |
| `docs/2_TECHNICAL.md` | ⚠️ Частично устарел | Отсутствуют: `getSignalStats()`, `getStrategyStats()`, realistic/conservative ROI режимы, таймаут генерации карточек |
| `docs/3_LOGIC.md` | ⚠️ Частично устарел | Не упомянуты Hard Filters (SELL блокировка, price cap, min value), текстовый fallback |
| `docs/api.md` | ❌ Пустой файл | Требует заполнения спецификациями внешних API |

### 1.2. Что НЕ задокументировано в существующих docs (критические изменения)

**Код реализован, но не описан:**
1. **Hard Filters** в `index.js` (строки 696-700):
   - Блокировка SELL сделок (`side === 'SELL'` → skip)
   - Ограничение максимальной цены (`price > 0.75` → skip)
   - Минимальная сумма сигнала (`tradeValueUsd < 50` → skip для сохранения/рассылки, но пишется в CSV)

2. **Dual ROI Modes** (`ROI_MODE` env var):
   - `realistic` (default): 0.01% US taker fee + минимальный spread/impact
   - `conservative`: 50x stress-test (0.5% base slippage)
   - Функции: `calculateRealisticRoi()`, `calculateConservativeRoi()` в `math_utils.js`

3. **Enhanced Stats** (`/stats`, `/status`):
   - Окно дней через `STATS_WINDOW_DAYS` (default 30)
   - Capped average ROI (±1000%), median ROI
   - BUY/SELL split winrate и counts
   - Pending signals count
   - Режим расчёта (realistic/conservative) отображается в выводе

4. **Card Generation Timeout** (5 секунд):
   - `Promise.race()` с таймаутом в 5000ms
   - При превышении/ошибке → текстовый fallback (`bot.sendMessage`) вместо фото
   - Логи: "🎨 Generating card…", "⏱️ timeout", "🚀 Sending photo…"

5. **Диагностика:**
   - Явные консольные логи на каждом этапе отправки
   - Лог ошибок генерации карточки (`console.error`)

**Документация описывает, но код НЕ реализует:**
- ❌ `api.md` пуст — нет спецификаций API endpoints Polymarket/Goldsky

---

## 2. ПОЛНАЯ АРХИТЕКТУРА СИСТЕМЫ

```
┌─────────────────────────────────────────────────────────────────┐
│                   ВНЕШНИЕ ИСТОЧНИКИ ДАННЫХ                       │
├─────────────────────────────────────────────────────────────────┤
│ 1. Polymarket Data API                                          │
│    https://data-api.polymarket.com/trades?limit=200             │
│    Polling: каждые 2 секунды                                    │
│                                                                 │
│ 2. Goldsky GraphQL API                                          │
│    https://api.goldsky.com/...                                  │
│    Rate limit: 250ms между запросами (~4 req/sec)              │
│    Cache TTL: 60 минут на кошелёк                              │
│                                                                 │
│ 3. Polymarket CLOB API                                          │
│    https://clob.polymarket.com/markets/{conditionId}            │
│    Для валидации condition_id и получения токенов/исходов      │
│                                                                 │
│ 4. Polymarket Events API                                        │
│    https://polymarket.com/api/events/{slug}                     │
│    Для резолва condition_id по slug при отсутствии в трейде    │
└─────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                    ОСНОВНОЙ ЦИКЛ (index.js)                      │
│                   runBotLoop() — каждые 2 сек                   │
├─────────────────────────────────────────────────────────────────┤
│ Шаг 1: Получение сделок                                         │
│   fetch trades (limit=200)                                      │
│                                                                 │
│ Шаг 2: Dedupe в памяти                                          │
│   processedTrades Set (LRU cap 2000)                           │
│   if (processedTrades.has(tradeId)) → continue                 │
│                                                                 │
│ Шаг 3: Валидация адреса кошелька                               │
│   if (!walletAddress || invalid format) → continue             │
│                                                                 │
│ Шаг 4: Логирование в CSV                                        │
│   logTradeToHistory() → data/history/trades_YYYY-MM-DD.csv     │
│   (пишутся ВСЕ сделки, даже <$50)                              │
│                                                                 │
│ Шаг 5: ⛔ HARD FILTERS (NEW!)                                   │
│   if (side === 'SELL') → skip с логом                          │
│   if (price > 0.75) → skip с логом                             │
│   if (tradeValueUsd < 50) → skip с логом                       │
│                                                                 │
│ Шаг 6: Анализ кошелька (whale_logic.js)                        │
│   fetchUserHistory(address, tradeValueUsd)                     │
│   - Если tradeValueUsd < 5 → skip GraphQL, return {pnl:0...}  │
│   - Иначе → GraphQL запрос с кэшем (60 мин)                    │
│   - Расчёт Honest Metrics: median PnL, Wilson CI winrate      │
│                                                                 │
│ Шаг 7: Классификация кита                                      │
│   if (pnl > 5000 && medianPnl > 0 && winrateLB > 40)          │
│      → "🧠 Умный Кит"                                           │
│   else if (pnl > 0) → "🐋 Кит"                                 │
│   else if (pnl < -1000) → "🐹 Хомяк"                           │
│   else → "🐟 Трейдер"                                           │
│                                                                 │
│ Шаг 8: Резолв condition_id и outcome                           │
│   Последовательность попыток:                                   │
│   a) Берём из trade.conditionId/condition_id                   │
│   b) Если нет → fetch events API по slug                       │
│   c) Валидация через clob API /markets/{condId}                │
│   d) Нормализация outcome через tokens[].outcome               │
│   → condIdForSave, outcomeCanonical, tokenIndex                │
│                                                                 │
│ Шаг 9: Сохранение сигнала в БД                                 │
│   if (condIdForSave) → db.saveSignal(...)                      │
│   else → db.logAction('skip_save_signal_no_condition')         │
│                                                                 │
│ Шаг 10: Per-user фильтрация                                    │
│   for (user of activeUsers) {                                  │
│     A) min_bet проверка                                        │
│     B) filter_whale_type ветка:                                │
│        - 'smart_whale': строгие условия (см. Шаг 7)           │
│        - 'all': min_pnl_total + filter_winrate_min_percent    │
│        - else: hamster/whale check + market slug/category     │
│     C) Если прошёл → переход к генерации карточки             │
│   }                                                             │
│                                                                 │
│ Шаг 11: Генерация карточки (ленивая, 1 раз на трейд)          │
│   if (!imageBuffer) {                                          │
│     console.log("🎨 Generating card...")                       │
│     Promise.race([                                             │
│       logic.generateCardImage(viewData),  // Puppeteer         │
│       timeout(5000)                                            │
│     ])                                                          │
│     if (timeout || error) → imageBuffer = null                 │
│   }                                                             │
│                                                                 │
│ Шаг 12: Логирование user_signal_logs                          │
│   if (signalId) → db.logUserSignal(chat_id, signalId, ...)    │
│                                                                 │
│ Шаг 13: Отправка в Telegram                                    │
│   if (TELEGRAM_TOKEN !== placeholder) {                        │
│     if (imageBuffer) {                                         │
│       console.log("🚀 Sending photo...")                       │
│       safeSendPhoto(chat_id, imageBuffer, caption, buttons)    │
│     } else {                                                    │
│       bot.sendMessage(chat_id, caption, buttons)  // fallback  │
│     }                                                           │
│   }                                                             │
│   Обработка ошибок:                                            │
│     - "chat not found" → updateUser(active=0)                  │
│     - 429 rate limit → retry с delay (safeSendPhoto)           │
└─────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              FORWARD TESTING (forward_tester.js)                │
│                  Запуск: каждые 10 минут                        │
├─────────────────────────────────────────────────────────────────┤
│ 1. Выборка OPEN сигналов из БД                                 │
│    SELECT * FROM signals WHERE status='OPEN'                   │
│                                                                 │
│ 2. Backfill condition_id (опционально)                         │
│    if (BACKFILL_CONDITION='1' && !signal.condition_id)         │
│       → пытаемся резолвить через slug                          │
│                                                                 │
│ 3. Проверка статуса рынка                                      │
│    fetch clob API /markets/{conditionId}                       │
│    if (!closed) → continue                                     │
│                                                                 │
│ 4. Определение победителя                                      │
│    findTokenIndex(tokens, signal.outcome)                      │
│    winningIndex = tokens.findIndex(t => t.winner)              │
│    payout = (tokenIndex === winningIndex) ? 1.0 : 0.0          │
│                                                                 │
│ 5. Валидация entry_price                                       │
│    if (!isValidEntry(entry_price)) → status='ERROR', skip ROI  │
│                                                                 │
│ 6. Расчёт ROI через computeRoi()                               │
│    mode = process.env.ROI_MODE || 'realistic'                  │
│    if (mode === 'conservative')                                │
│       → math.calculateConservativeRoi(payout, entry, size)     │
│    else                                                         │
│       → math.calculateRealisticRoi(payout, entry, size)        │
│                                                                 │
│ 7. Обновление signals и user_signal_logs                       │
│    UPDATE signals SET status='CLOSED', result_pnl_percent=ROI  │
│    UPDATE user_signal_logs SET result_pnl_percent=ROI          │
│                                                                 │
│ 8. Уведомления пользователям (опционально)                     │
│    pollClosedNotifications() → отправка WIN/LOSS в Telegram    │
└─────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                   СТАТИСТИКА (database.js)                      │
├─────────────────────────────────────────────────────────────────┤
│ getSignalStats(days)                                            │
│   Источник: user_signal_logs WHERE created_at > NOW()-days     │
│   Метрики:                                                      │
│     - Total closed, wins, winrate                              │
│     - Average ROI (uncapped и capped ±1000%)                   │
│     - Median ROI                                                │
│     - BUY split: count, wins, winrate                          │
│     - SELL split: count, wins, winrate                         │
│     - Pending count (status='OPEN')                            │
│                                                                 │
│ getStrategyStats(days)                                          │
│   GROUP BY strategy, возвращает capped avg ROI per стратегия   │
│                                                                 │
│ getOddsBuckets(days)                                            │
│   GROUP BY entry_price buckets (0-0.3, 0.3-0.5, 0.5-0.7, etc) │
│                                                                 │
│ getCategoryStats(days)                                          │
│   GROUP BY category (politics, sports, crypto, etc)            │
│                                                                 │
│ getLeagueStats(days)                                            │
│   GROUP BY league (NFL, NBA, MLB, etc)                         │
└─────────────────────────────────────────────────────────────────┘
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│                КОМАНДЫ TELEGRAM (index.js)                      │
├─────────────────────────────────────────────────────────────────┤
│ /start       → Регистрация/активация, приветственное сообщение │
│ /menu        → Главное меню с кнопками                         │
│ /settings    → UI настройки фильтров (inline keyboard)         │
│ /stop        → Деактивация (active=0)                          │
│ /stats       → Глобальная статистика (getSignalStats)          │
│ /status      → Состояние системы (pending/closed, ROI_MODE)    │
│ /report      → Детальный отчёт (стратегии, киты, категории)   │
│ /help        → Справка по командам                             │
│ /faq         → FAQ (Honest Math, Paper Trading, Risk)          │
│ /guide       → Гайд по пресетам                                │
│ /feedback    → Форма обратной связи                            │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. БАЗА ДАННЫХ (SQLite)

### 3.1. Таблица `users`

```sql
CREATE TABLE users (
    chat_id INTEGER PRIMARY KEY,
    active INTEGER DEFAULT 1,
    min_bet REAL DEFAULT 100,
    min_trade REAL DEFAULT 50,          -- не используется в текущем коде
    filter_whale_type TEXT DEFAULT 'all',
    filter_market_slug TEXT,
    filter_market_category TEXT DEFAULT 'all',
    filter_side TEXT,                   -- не используется в текущем коде
    filter_winrate_min_percent REAL DEFAULT 0,
    filter_winrate_max_percent REAL DEFAULT 100,
    min_pnl_total REAL DEFAULT 0,
    strategy_name TEXT DEFAULT 'custom',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**Критичные поля:**
- `filter_whale_type`: `'smart_whale'` | `'whale'` | `'hamster'` | `'all'`
- `min_bet`: порог суммы сделки (USD)
- `min_pnl_total`: используется только для type='all'
- `filter_winrate_min_percent` / `max`: диапазон винрейта

### 3.2. Таблица `signals` (глобальные события)

```sql
CREATE TABLE signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_slug TEXT,
    event_slug TEXT,
    condition_id TEXT,
    outcome TEXT,
    side TEXT,
    entry_price REAL,
    size_usd REAL,
    whale_address TEXT,
    token_index INTEGER,               -- NEW: индекс токена для резолва
    status TEXT DEFAULT 'OPEN',        -- 'OPEN' | 'CLOSED' | 'ERROR'
    result_pnl_percent REAL,
    resolved_outcome TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**Статусы:**
- `OPEN`: рынок не закрыт
- `CLOSED`: рынок закрыт, ROI рассчитан
- `ERROR`: невалидный entry_price или другие ошибки

### 3.3. Таблица `user_signal_logs` (персональная история)

```sql
CREATE TABLE user_signal_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    signal_id INTEGER,
    strategy TEXT,
    side TEXT,
    entry_price REAL,
    size_usd REAL,
    category TEXT,
    league TEXT,
    outcome TEXT,
    token_index INTEGER,
    status TEXT DEFAULT 'OPEN',
    result_pnl_percent REAL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(chat_id),
    FOREIGN KEY (signal_id) REFERENCES signals(id)
);
```

**Связь:** 
- `signal_id` → `signals.id` (может быть NULL если condition_id не найден)
- `result_pnl_percent` копируется из `signals` после резолва

### 3.4. Таблица `user_actions` (логи событий)

```sql
CREATE TABLE user_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT,
    details TEXT,           -- JSON строка
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

**Примеры action:**
- `skip_save_signal_no_condition`
- `deactivate_chat_not_found`
- `toggle_whale_type`

### 3.5. Таблица `callback_payloads` (для inline-кнопок)

Хранит данные для callback_query (адреса китов, condition_id для кнопки "Подробнее").

---

## 4. МАТЕМАТИЧЕСКАЯ МОДЕЛЬ (math_utils.js)

### 4.1. Wilson Score Lower Bound
```javascript
wilsonScoreLowerBound(wins, total, z=1.96)
```
**Назначение:** Нижняя граница 95% доверительного интервала для винрейта.  
**Пример:** 5 побед из 5 → не 100%, а ~57% (с учётом малой выборки).

### 4.2. Median PnL
```javascript
calculateMedian(values)
```
**Назначение:** Медиана вместо среднего для исключения влияния выбросов.  
**Почему:** Один большой выигрыш не делает кита "умным".

### 4.3. ROI Modes

#### Realistic Mode (по умолчанию)
```javascript
calculateRealisticRoi(payout, rawEntryPrice, sizeUsd)
  → applyRealisticSlippage()
    - US taker fee: 0.01% (0.0001)
    - Spread crossing: 0.05% (0.0005)
    - Size impact: 0.01% per $1000
    - Cap: 2% total
```
**Основание:** Polymarket fees 0% global, 0.01% US taker (Dec 2025).

#### Conservative Mode (stress-test)
```javascript
calculateConservativeRoi(payout, rawEntryPrice, sizeUsd)
  → applyConservativeSlippage()
    - Base slippage: 0.5%
    - Size penalty: 0.05% per $1000
    - Cap: 10% total
```
**Назначение:** Worst-case сценарий с 50x safety margin.

**Переключение:** `ROI_MODE=conservative` в `.env`

### 4.4. Нормализация значений Polymarket
```javascript
normalizePolymarketValue(value)
```
Конвертирует микро-единицы (напр. `1000000 → 1.0`).

---

## 5. ENVIRONMENT VARIABLES (.env)

| Переменная | Назначение | Default | Значения |
|:---|:---|:---|:---|
| `TELEGRAM_TOKEN` | Telegram Bot API token | `'YOUR_TELEGRAM_TOKEN'` | Строка |
| `ROI_MODE` | Режим расчёта ROI | `'realistic'` | `'realistic'` / `'conservative'` |
| `STATS_WINDOW_DAYS` | Окно дней для `/stats` | `30` | Число |
| `FORWARD_DEBUG` | Verbose логи forward tester | `'0'` | `'0'` / `'1'` |
| `FORWARD_BATCH_LIMIT` | Макс. сигналов за один прогон | нет лимита | Число |
| `BACKFILL_CONDITION` | Автозаполнение condition_id | `'0'` | `'0'` / `'1'` |
| `DEBUG_TRADES` | Дебаг-логи GraphQL skip | `'0'` | `'0'` / `'1'` |

---

## 6. ВНЕШНИЕ API

### 6.1. Polymarket Data API
**Endpoint:** `https://data-api.polymarket.com/trades`  
**Метод:** GET  
**Параметры:**
- `limit`: макс. кол-во (используется 200)
- Polling: каждые 2 секунды

**Пример ответа:**
```json
[
  {
    "transactionHash": "0x...",
    "maker_address": "0x...",
    "proxyWallet": "0x...",
    "price": 0.65,
    "size": 100,
    "side": "BUY",
    "outcome": "Yes",
    "market_slug": "will-trump-win",
    "conditionId": "0x...",
    "timestamp": 1703001234
  }
]
```

### 6.2. Goldsky GraphQL API
**Endpoint:** `https://api.goldsky.com/api/public/project_...`  
**Метод:** POST  
**Rate Limit:** 250ms между запросами (~4 req/sec)  
**Cache TTL:** 60 минут на кошелёк

**Query:**
```graphql
query($address: ID!) {
  user(id: $address) {
    fpmmTrades(first: 1000, orderBy: creationTimestamp, orderDirection: desc) {
      fpmm { title, outcomeTokenMarginalPrice }
      outcomeIndex
      type
      collateralAmountUSD
      outcomeTokensTraded
      creationTimestamp
    }
  }
}
```

### 6.3. Polymarket CLOB API
**Endpoint:** `https://clob.polymarket.com/markets/{conditionId}`  
**Метод:** GET  
**Назначение:** Валидация condition_id, получение токенов/исходов, проверка закрытия рынка

**Пример ответа:**
```json
{
  "condition_id": "0x...",
  "question": "Will...",
  "closed": false,
  "tokens": [
    { "outcome": "Yes", "token_id": "123...", "winner": false },
    { "outcome": "No", "token_id": "456...", "winner": false }
  ]
}
```

### 6.4. Polymarket Events API
**Endpoint:** `https://polymarket.com/api/events/{slug}`  
**Метод:** GET  
**Назначение:** Резолв condition_id по event slug

---

## 7. КРИТИЧНЫЕ БИЗНЕС-ПРАВИЛА

### 7.1. Hard Filters (защита депозита)
**Применяются ДО сохранения в БД и рассылки:**
1. **SELL блокировка:** Все SELL сделки игнорируются (10% винрейт по статистике)
2. **Price Cap:** Цена > 0.75 → skip (фавориты убыточны, -27% ROI)
3. **Min Value:** Сумма < $50 → skip для сигналов (но логируется в CSV)

**Логи:**
```
⛔ Hard Filter: SELL disabled for {tradeId}
⛔ Hard Filter: Price 0.82 > 0.75 for {tradeId}
⛔ Hard Filter: Value $35 < $50 for {tradeId}
```

### 7.2. Классификация китов

| Статус | Условия | Описание |
|:---|:---|:---|
| 🧠 Умный Кит | `pnl > 5000` AND `medianPnl > 0` AND `winrateLowerBound > 40` | Строгая проверка: большой общий PnL, стабильная медиана, статистически значимый винрейт |
| 🐋 Кит | `pnl > 0` | Любая положительная прибыль |
| 🐹 Хомяк | `pnl < -1000` | Значительные убытки |
| 🐟 Трейдер | Иначе | Нейтральный или малый PnL |

### 7.3. Per-User Filter Modes

#### Mode: `smart_whale`
**Жёсткая логика (Honest Math):**
- Обязательны: `pnl > 5000` AND `medianPnl > 0` AND `winrateLowerBound > 40`
- Игнорируются: все пользовательские пороги (min_pnl_total, winrate range)

#### Mode: `all`
**Упрощённая логика:**
- `pnl >= user.min_pnl_total`
- `winrate >= user.filter_winrate_min_percent`
- Не проверяются: median, Wilson CI

#### Mode: `whale` / `hamster` / custom
**Гибкая логика:**
- Проверка знака PnL (+ для whale, - для hamster)
- `filter_market_slug`: substring match на title/slug
- `filter_market_category`: точное совпадение категории
- Winrate range: `filter_winrate_min_percent` / `max_percent`

**Особенность hamster:** Side флипается при логировании (`BUY → SELL`, `SELL → BUY`)

### 7.4. Валидация entry_price (forward testing)
```javascript
isValidEntry(price): price >= 0.01 && price <= 1.0
```
При невалидной цене:
- Сигнал помечается `status='ERROR'`
- ROI не рассчитывается (остаётся NULL)
- Персональные логи получают `result_pnl_percent=0` (защитный сценарий)

---

## 8. TIMING & PERFORMANCE

| Процесс | Интервал | Оптимизации |
|:---|:---|:---|
| Main Loop (runBotLoop) | 2 секунды | Dedupe Set (2000 cap) |
| Forward Tester | 10 минут | Batch limit через env |
| GraphQL Rate Limit | 250ms между запросами | ~4 req/sec |
| Wallet History Cache | 60 минут TTL | In-memory Map |
| Telegram sendPhoto | 50ms min interval | safeSendPhoto() с retry |
| Card Generation Timeout | 5 секунд | Promise.race() → fallback |

**Threshold оптимизации:**
- Сделки < $5 → GraphQL не запрашивается (экономия квот)
- Сделки < $50 → сигнал не сохраняется/не рассылается (но пишется в CSV)

---

## 9. ERROR HANDLING & LOGGING

### 9.1. Категории ошибок

| Тип ошибки | Обработка | Лог |
|:---|:---|:---|
| Invalid wallet address | Skip trade | `console.log("Invalid Wallet: ...")` |
| Hard Filter блокировка | Skip trade | `⛔ Hard Filter: ...` |
| GraphQL timeout/error | Безопасный отказ (pnl=0) | Нет лога (silent) |
| Missing condition_id | Не сохраняется в signals | `db.logAction('skip_save_signal_no_condition')` |
| Card generation timeout | Fallback на текст | `⏱️ Card generation timeout...` |
| Telegram "chat not found" | Деактивация пользователя | `db.logAction('deactivate_chat_not_found')` |
| Telegram 429 rate limit | Retry с delay | `safeSendPhoto()` парсит retry_after |
| Forward tester invalid entry | status='ERROR', ROI=NULL | Нет лога пользователю |

### 9.2. Диагностические логи (NEW!)

```javascript
console.log("🔍 Scanned 200 trades. Checking...");
console.log("🐳 Analyzing wallet: 0x... (Lag: 2.5s)");
console.log("⛔ Hard Filter: SELL disabled for ...");
console.log("Custom Filter Failed: Bet $150 < User Min $500");
console.log("🎨 Generating card for ...");
console.log("⏱️ Card generation timeout, fallback to text...");
console.log("🚀 Sending photo to 123456789");
```

---

## 10. РАСХОЖДЕНИЯ МЕЖДУ КОДОМ И ДОКУМЕНТАЦИЕЙ

### 10.1. Реализовано, но не задокументировано

| Функционал | Файл | Строки | Критичность |
|:---|:---|:---|:---|
| Hard Filters | `index.js` | 696-700 | 🔴 Высокая |
| ROI_MODE (realistic/conservative) | `math_utils.js`, `forward_tester.js` | 51-120, 30-42 | 🔴 Высокая |
| Card generation timeout | `index.js` | 838-853 | 🟡 Средняя |
| Text fallback on image fail | `index.js` | 907-923 | 🟡 Средняя |
| BUY/SELL split stats | `database.js` | 300-323 | 🟡 Средняя |
| `/status` команда | `index.js` | 259-277 | 🟢 Низкая |
| Диагностические логи | `index.js` | 838, 909 | 🟢 Низкая |

### 10.2. Задокументировано, но не реализовано

| Описание | Документ | Статус |
|:---|:---|:---|
| Спецификации API endpoints | `docs/api.md` | ❌ Файл пустой |
| `min_trade` поле | `docs/2_TECHNICAL.md` | ⚠️ Существует в БД, но не используется |
| `filter_side` поле | `docs/2_TECHNICAL.md` | ⚠️ Существует в БД, но не используется |

---

## 11. РЕКОМЕНДАЦИИ ДЛЯ АНАЛИТИЧЕСКОЙ КОМАНДЫ

### 11.1. Приоритетные задачи

1. **A/B тестирование Hard Filters:**
   - Сравнить ROI с/без фильтров на исторических данных (CSV trades)
   - Метрика успеха: прирост median ROI, снижение дисперсии, рост винрейта
   - Инструмент: `forward_tester.js` с разметкой `strategy='hard_filters_on'` vs `'off'`

2. **Валидация ROI режимов:**
   - Проверить realistic vs conservative на sensitivity
   - Определить оптимальный режим для продакшена

3. **Оптимизация фильтров:**
   - Найти оптимальные пороги: price cap, min value, winrate bounds
   - Проверить эффективность BUY-only стратегии

### 11.2. Известные ограничения

1. **Малая выборка SELL сделок:** 10% винрейт может быть результатом малой статистики
2. **Lag между событием и обработкой:** В среднем 2-5 секунд, пики до 10-15 секунд
3. **GraphQL квоты:** Ограничение ~4 req/sec может быть узким местом при росте объёма
4. **Puppeteer stability:** 5-секундный таймаут может не всегда хватать при высокой нагрузке

### 11.3. Метрики для мониторинга

**Технические:**
- Avg lag от timestamp трейда до обработки
- % успешной генерации карточек vs fallback на текст
- GraphQL cache hit rate
- Telegram 429 errors frequency

**Бизнес:**
- Median ROI (primary metric)
- Capped average ROI (secondary)
- Winrate (BUY/SELL split)
- % сигналов blocked by Hard Filters
- % сигналов без condition_id (не сохранённых)

---

## 12. КОНТАКТЫ И ПОДДЕРЖКА

**Разработчик:** Whale Bot Team  
**Версия:** 3.0 (Commercial Grade)  
**Дата релиза:** Декабрь 2025  
**Статус:** Production (с Hard Filters патчем от 20.12.2025)

**Feedback команда:** через `/feedback` в боте или GitHub Issues

---

**Конец документа. Версия: 1.0 от 21.12.2025**

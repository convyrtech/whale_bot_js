# API Спецификация Внешних Сервисов

## 1. Polymarket Data API

### 1.1. Get Recent Trades
**Endpoint:** `https://data-api.polymarket.com/trades`  
**Method:** `GET`  
**Rate Limit:** Не документирован; бот опрашивает каждые 2 секунды  
**Authentication:** Не требуется

**Query Parameters:**
- `limit` (number): Максимальное количество сделок (бот использует 200)

**Response:**
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
    "slug": "will-trump-win",
    "conditionId": "0x...",
    "condition_id": "0x...",
    "timestamp": 1703001234,
    "created_at": "2024-12-20T12:00:00Z",
    "title": "Will Trump win the 2024 election?"
  }
]
```

**Используемые поля:**
- `transactionHash` — ID для дедупликации
- `maker_address`, `proxyWallet` — адрес кошелька кита
- `price` — цена входа (0-1)
- `size` — количество контрактов
- `side` — "BUY" или "SELL"
- `outcome` — исход ("Yes", "No", custom)
- `slug`, `market_slug` — для резолва condition_id
- `conditionId`, `condition_id` — ID рынка
- `timestamp` — Unix timestamp (секунды)

---

## 2. Goldsky GraphQL API

### 2.1. User Trading History
**Endpoint:** `https://api.goldsky.com/api/public/project_...`  
**Method:** `POST`  
**Rate Limit:** Бот использует 250ms между запросами (~4 req/sec)  
**Authentication:** Не требуется

**GraphQL Query:**
```graphql
query($address: ID!) {
  user(id: $address) {
    fpmmTrades(
      first: 1000,
      orderBy: creationTimestamp,
      orderDirection: desc
    ) {
      fpmm {
        title
        outcomeTokenMarginalPrice
      }
      outcomeIndex
      type
      collateralAmountUSD
      outcomeTokensTraded
      creationTimestamp
    }
  }
}
```

**Variables:**
```json
{
  "address": "0x..."
}
```

**Response:**
```json
{
  "data": {
    "user": {
      "fpmmTrades": [
        {
          "fpmm": {
            "title": "Will...",
            "outcomeTokenMarginalPrice": "0.65"
          },
          "outcomeIndex": 1,
          "type": "Buy",
          "collateralAmountUSD": "100.5",
          "outcomeTokensTraded": "155",
          "creationTimestamp": "1703001234"
        }
      ]
    }
  }
}
```

**Кэширование:** 60 минут TTL в памяти  
**Threshold:** Если `tradeValueUsd < 5`, запрос не делается (экономия квот)

---

## 3. Polymarket CLOB API

### 3.1. Get Market Details
**Endpoint:** `https://clob.polymarket.com/markets/{conditionId}`  
**Method:** `GET`  
**Rate Limit:** Не документирован  
**Authentication:** Не требуется

**Response:**
```json
{
  "condition_id": "0x...",
  "question": "Will Trump win?",
  "description": "...",
  "closed": false,
  "accepting_orders": true,
  "tokens": [
    {
      "token_id": "123...",
      "outcome": "Yes",
      "winner": false,
      "price": "0.65"
    },
    {
      "token_id": "456...",
      "outcome": "No",
      "winner": false,
      "price": "0.35"
    }
  ],
  "end_date_iso": "2024-11-05T23:59:59Z"
}
```

**Используемые поля:**
- `closed` — рынок закрыт?
- `tokens` — массив токенов с исходами
- `tokens[].outcome` — название исхода для нормализации
- `tokens[].winner` — победивший токен (для forward testing)

**Применение:**
1. Валидация `condition_id` при сохранении сигнала
2. Нормализация исхода (сопоставление с trade.outcome)
3. Определение победителя при резолве (forward tester)

---

## 4. Polymarket Events API

### 4.1. Get Event by Slug
**Endpoint:** `https://polymarket.com/api/events/{slug}`  
**Method:** `GET`  
**Rate Limit:** Не документирован  
**Authentication:** Не требуется

**Response:**
```json
{
  "slug": "will-trump-win",
  "title": "Will Trump win the 2024 election?",
  "markets": [
    {
      "id": "0x...",
      "conditionId": "0x...",
      "question": "Will Trump win?",
      "tokens": [
        { "outcome": "Yes", "token_id": "..." },
        { "outcome": "No", "token_id": "..." }
      ]
    }
  ]
}
```

**Применение:**
- Резолв `condition_id` когда его нет в trade объекте
- Используется как fallback при backfill в forward_tester

---

## 5. Telegram Bot API

### 5.1. Send Photo
**Используется:** `bot.sendPhoto(chatId, imageBuffer, options)`  
**Wrapper:** `safeSendPhoto()` с rate limiting (50ms min interval) и retry на 429

### 5.2. Send Message
**Используется:** `bot.sendMessage(chatId, text, options)`  
**Fallback:** При таймауте генерации карточки

### 5.3. Error Codes
- `chat not found` → деактивация пользователя (active=0)
- `429 Too Many Requests` → retry с `retry_after` задержкой
- `bot was blocked` → (не обрабатывается сейчас, требует доработки)

---

## 6. Rate Limits & Оптимизации

| API | Ограничение | Реализация в боте |
|:---|:---|:---|
| Polymarket Data | Не документирован | Poll каждые 2 сек |
| Goldsky GraphQL | ~240 req/min (неофициально) | 250ms задержка между запросами |
| CLOB API | Не документирован | По требованию |
| Events API | Не документирован | По требованию |
| Telegram | 30 msg/sec per chat | 50ms min interval |

**Кэширование:**
- Wallet history: 60 мин TTL
- Dedupe trades: LRU Set (2000 cap)

**Thresholds:**
- `tradeValueUsd < 5` → GraphQL skip
- `tradeValueUsd < 50` → signal skip (Hard Filter)

---

## 7. Environment Variables

См. основную документацию `SYSTEM_MAP_FOR_ANALYSTS.md` раздел 5.

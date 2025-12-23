# API Спецификация Внешних Сервисов

## 1. Polymarket Data API (Gamma)

### 1.1. Get Recent Trades
**Endpoint:** `https://data-api.polymarket.com/trades`  
**Method:** `GET`  
**Rate Limit:** Polling (2 sec interval)  

**Используемые поля:**
- `maker_address`: Адрес кита.
- `price`: Цена входа.
- `size`: Размер позиции.
- `condition_id`: ID рынка.
- `outcome`: Исход ("Yes"/"No").

---

## 2. Polymarket CLOB API

### 2.1. Get Market Status
**Endpoint:** `https://clob.polymarket.com/markets/{condition_id}`  
**Method:** `GET`  

**Response:**
```json
{
  "active": true,
  "closed": false,
  "resolved_by": "0x...",
  "tokens": [
    { "outcome": "Yes", "price": 0.65 },
    { "outcome": "No", "price": 0.35 }
  ]
}
```
**Использование:**
- Проверка `closed` / `resolved` для расчета PnL.
- Получение текущей цены для Slippage Check.

---

## 3. Goldsky GraphQL API

### 3.1. User Trading History
**Endpoint:** `https://api.goldsky.com/api/public/project_...`  
**Method:** `POST`  

**Query:** Запрашивает историю `fpmmTrades` для конкретного кошелька.
**Использование:** Расчет PnL и Winrate кита за последние 30 дней.

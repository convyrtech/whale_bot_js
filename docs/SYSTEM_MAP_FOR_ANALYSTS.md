# Whale Bot v3.0 — System Map (Production)
**Дата:** 24 декабря 2025  
**Версия:** 3.0 (Unicorn Portfolio Edition)

---

## 1. ОБЗОР СИСТЕМЫ

Whale Bot v3.0 — это полностью автономная система для алгоритмической торговли на Polymarket. Бот не просто сигнализирует, а ведет виртуальный портфель пользователя, автоматически открывая и закрывая позиции вслед за "умными китами".

### Ключевые метрики (на 24.12.2025):
- **Статус:** Production (Stable).
- **Режим:** Paper Trading ($20 Challenge).
- **Аптайм:** 24/7 (с защитой от сбоев).

---

## 2. АРХИТЕКТУРА ПОТОКОВ ДАННЫХ

```
[Polymarket Data API] 
       │ (Stream Trades)
       ▼
[Index.js: Main Loop] ───► [Filter: Value < $50] ───► [Trash]
       │
       ▼
[Whale Logic] ◄─── [Goldsky GraphQL: History]
       │ (Calculate Score)
       ▼
[Decision Engine]
       │ Score > 80?
       ▼
[Pre-Flight Check] ◄─── [CLOB API: Current Price]
       │ Slippage < 5%?
       ▼
[Portfolio Manager] ───► [DB: Insert Position]
       │
       ▼
[Telegram Bot] ───► [User Notification]
```

---

## 3. ПОДСИСТЕМЫ БЕЗОПАСНОСТИ

1.  **Self-Test Routine:**
    - При запуске проверяет коннект к БД.
    - Делает тестовый запрос к API.
    - Если тест провален -> `process.exit(1)` (перезапуск через PM2/Docker).

2.  **Resolution Checker (Cron):**
    - Раз в 5 минут сканирует таблицу `positions`.
    - Проверяет статус рынков через CLOB API.
    - Если рынок закрыт -> начисляет PnL.

3.  **Database Auto-Migration:**
    - При старте проверяет схему БД.
    - Если не хватает колонок (`notified`, `exit_price`), добавляет их на лету.

---

## 4. ИЗВЕСТНЫЕ ОГРАНИЧЕНИЯ

1.  **Polling Interval:** 2 секунды. Возможна задержка входа по сравнению с WebSocket ботами.
2.  **Market Types:** Поддерживаются только бинарные рынки (Yes/No).
3.  **Liquidity:** Бот не проверяет глубину стакана (только цену).

---

## 5. КОНТАКТЫ И ДОСТУПЫ

- **Исходный код:** Локальный репозиторий.
- **База данных:** `database.sqlite` (локально).
- **Логи:** `logs/app.log` и `utils/csv_logger.js`.

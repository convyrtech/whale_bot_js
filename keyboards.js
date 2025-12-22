// Keyboards and UI Helpers

const mainMenu = {
    inline_keyboard: [
        [
            { text: "▶️ Запустить", callback_data: "cmd_start" },
            { text: "⏸ Остановить", callback_data: "cmd_stop" }
        ],
        [
            { text: "⚙️ Настройки Фильтров", callback_data: "menu_settings" }
        ],
        [
            { text: "💎 Challenge Mode", callback_data: "menu_challenge" }
        ]
    ]
};

const settingsMenu = (user) => {
    const u = Object.assign({
        min_bet: 1000,
        min_pnl_total: 0,
        min_pnl_recent: 0,
        filter_whale_type: 'all',
        filter_market_category: 'all',
        virtual_stake_usd: 100,
        filter_market_slug: null,
        filter_winrate_min_percent: 0,
        filter_winrate_max_percent: 100
    }, user || {});
    const whaleTypeMap = { 'all': 'Все', 'whale': 'Киты (>5k)', 'smart_whale': 'Умные (>10k)', 'hamster': 'Хомяки (<0)' };
    const categoryMap = { 'all': 'Все', 'crypto': 'Крипто', 'politics': 'Политика', 'sports': 'Спорт', 'weather': 'Погода', 'other': 'Другое' };
    const wrMin = (u.filter_winrate_min_percent !== undefined && u.filter_winrate_min_percent !== null) ? u.filter_winrate_min_percent : 0;
    const wrMax = (u.filter_winrate_max_percent !== undefined && u.filter_winrate_max_percent !== null) ? u.filter_winrate_max_percent : 100;
    
    return {
        inline_keyboard: [
            [
                { text: `💵 Мин. Ставка: $${u.min_bet}`, callback_data: "set_min_bet" }
            ],
            [
                { text: `💰 Вирт. ставка: $${u.virtual_stake_usd || 100}`, callback_data: "set_virtual_stake" }
            ],
            [
                { text: `📈 Мин. PnL (Общий): $${u.min_pnl_total}`, callback_data: "set_min_pnl_total" }
            ],
            [
                { text: `📅 Мин. PnL (10 сделок): $${u.min_pnl_recent}`, callback_data: "set_min_pnl_recent" }
            ],
            [
                { text: `🎯 Мин. винрейт: ${wrMin}%`, callback_data: "set_winrate_min" }
            ],
            [
                { text: `🎯 Макс. винрейт: ${wrMax}%`, callback_data: "set_winrate_max" }
            ],
            [
                { text: `🐳 Тип: ${whaleTypeMap[u.filter_whale_type] || u.filter_whale_type}`, callback_data: "toggle_whale_type" }
            ],
            [
                { text: `📂 Категория: ${categoryMap[u.filter_market_category] || 'Все'}`, callback_data: "toggle_market_category" }
            ],
            [
                { text: `🎯 Событие: ${u.filter_market_slug ? '✅ Вкл' : '❌ Выкл'}`, callback_data: "set_market_filter" }
            ],
            [
                { text: "🧹 Очистить фильтр события", callback_data: "clear_market_filter" }
            ],
            [
                { text: "🧹 Сброс винрейта", callback_data: "clear_winrate_filter" }
            ],
            [
                { text: "🔙 Назад", callback_data: "menu_main" }
            ]
        ]
    };
};

const challengeMenu = {
    inline_keyboard: [
        [
            { text: "🚀 Старт ($20)", callback_data: "challenge_start" }
        ],
        [
            { text: "💰 Портфель", callback_data: "challenge_portfolio" },
            { text: "📊 Статистика", callback_data: "challenge_stats" }
        ],
        [
            { text: "🔙 Назад", callback_data: "menu_main" }
        ]
    ]
};

module.exports = {
    mainMenu,
    settingsMenu,
    challengeMenu
};

const mainMenu = {
    inline_keyboard: [
        [
            { text: "📊 Stats", callback_data: "cmd_stats" },
            { text: "🔄 Reset", callback_data: "cmd_reset" }
        ]
    ]
};

module.exports = {
    mainMenu
};

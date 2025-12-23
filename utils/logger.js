const fs = require('fs');
const path = require('path');
const util = require('util');

// Ensure logs directory exists
const LOG_DIR = path.resolve(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const getLogFileName = () => {
    const date = new Date().toISOString().split('T')[0];
    return path.join(LOG_DIR, `bot_${date}.log`);
};

const COLORS = {
    RESET: "\x1b[0m",
    INFO: "\x1b[36m",    // Cyan
    WARN: "\x1b[33m",    // Yellow
    ERROR: "\x1b[31m",   // Red
    DEBUG: "\x1b[90m",   // Gray
    SUCCESS: "\x1b[32m"  // Green
};

const formatMessage = (level, message, meta) => {
    const timestamp = new Date().toISOString();
    const metaStr = meta ? ` ${util.inspect(meta, { colors: false, depth: null, breakLength: Infinity })}` : '';
    return `[${timestamp}] [${level}] ${message}${metaStr}`;
};

const writeToFile = (text) => {
    try {
        fs.appendFileSync(getLogFileName(), text + '\n');
    } catch (err) {
        console.error("Failed to write to log file:", err);
    }
};

const log = (level, message, meta) => {
    const text = formatMessage(level, message, meta);
    
    // Console Output (Colored)
    const color = COLORS[level] || COLORS.RESET;
    const metaConsole = meta ? ` ${util.inspect(meta, { colors: true, depth: 2 })}` : '';
    console.log(`${color}[${level}]${COLORS.RESET} ${message}${metaConsole}`);

    // File Output (Plain text)
    writeToFile(text);
};

const logger = {
    info: (msg, meta) => log('INFO', msg, meta),
    warn: (msg, meta) => log('WARN', msg, meta),
    error: (msg, meta) => log('ERROR', msg, meta),
    success: (msg, meta) => log('SUCCESS', msg, meta),
    debug: (msg, meta) => {
        if (process.env.DEBUG_MODE === '1' || process.env.FORWARD_DEBUG === '1') {
            log('DEBUG', msg, meta);
        }
    }
};

module.exports = logger;
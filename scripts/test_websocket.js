const WebSocket = require('ws');
const fetch = require('node-fetch');
const dns = require('dns');

// Force IPv4
if (dns.setDefaultResultOrder) dns.setDefaultResultOrder('ipv4first');

// Configuration
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const HTTP_API = 'https://clob.polymarket.com';

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Origin': 'https://polymarket.com',
    'Referer': 'https://polymarket.com/'
};

async function getTopMarkets() {
    // Hardcoded ID from DB for testing
    const testId = '0x36d55727d86c061259fdf5807d4462383b60271c29b1eb66e5dff1046c187903';
    console.log(`✅ Using hardcoded token ID: ${testId}`);
    return [testId];
}

async function startWebSocket() {
    const tokens = await getTopMarkets();
    if (tokens.length === 0) {
        console.log('⚠️ No tokens found. Exiting.');
        return;
    }

    console.log(`🔌 Connecting to WebSocket: ${WS_URL}`);
    const ws = new WebSocket(WS_URL, {
        headers: HEADERS
    });

    ws.on('open', () => {
        console.log('✅ WebSocket Connected!');
        
        // Subscribe to trades for these tokens
        const msg = {
            type: "subscribe",
            channel: "trades",
            asset_ids: tokens
        };
        
        console.log(`📤 Sending subscription for ${tokens.length} assets...`);
        ws.send(JSON.stringify(msg));
    });

    ws.on('message', (data) => {
        const msg = JSON.parse(data);
        
        if (Array.isArray(msg)) {
            for (const event of msg) {
                if (event.event_type === 'trade') {
                    const tradeTime = new Date(Number(event.timestamp) || Date.now());
                    const now = new Date();
                    const latency = now - tradeTime;
                    
                    console.log(`⚡ [WS TRADE] ${event.asset_id.slice(0,10)}... | Price: ${event.price} | Size: ${event.size} | Latency: ${latency}ms`);
                }
            }
        } else {
            console.log('📩 Message:', msg);
        }
    });

    ws.on('error', (err) => {
        console.error('❌ WebSocket Error:', err.message);
    });

    ws.on('close', () => {
        console.log('🔌 WebSocket Disconnected');
    });
}

startWebSocket();

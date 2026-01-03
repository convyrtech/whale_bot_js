const fetch = require('node-fetch');

async function checkApi() {
    try {
        console.log("Fetching recent trades...");
        const tradesResp = await fetch('https://data-api.polymarket.com/trades?limit=1');
        const trades = await tradesResp.json();

        if (trades.length > 0) {
            console.log("\n--- TRADE OBJECT ---");
            console.log(JSON.stringify(trades[0], null, 2));

            const conditionId = trades[0].conditionId || trades[0].condition_id;
            if (conditionId) {
                console.log(`\nFetching market details for condition: ${conditionId}...`);
                // Use CLOB API as seen in forward_tester.js
                const marketResp = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
                const text = await marketResp.text();

                try {
                    const market = JSON.parse(text);
                    if (market && market.condition_id) {
                        console.log("\n--- MARKET OBJECT (Single) ---");
                        // Print all keys to find the date field
                        const keys = Object.keys(market).sort();
                        console.log("Keys:", keys);
                        // Check common date fields
                        console.log("endDate:", market.endDate);
                        console.log("end_date:", market.end_date);
                        console.log("end_date_iso:", market.end_date_iso);
                        console.log("expiration:", market.expiration);
                        console.log("close_time:", market.close_time);
                        console.log("seconds_delay:", market.seconds_delay);
                    } else {
                        console.log("Market object empty or invalid: " + text.substring(0, 100));
                    }
                } catch (e) {
                    console.log("JSON Parse Error. Raw text start: " + text.substring(0, 200));
                }
            }
        }
    } catch (e) {
        console.error("Error:", e);
    }
}

checkApi();

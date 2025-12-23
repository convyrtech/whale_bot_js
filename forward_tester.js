const nodeFetch = require('node-fetch');
let fetchFn = nodeFetch;
function setFetch(fn) { fetchFn = fn; }
let rateSleepMs = 200;
function setRateSleep(ms) { rateSleepMs = ms; }
const db = require('./database');
const math = require('./math_utils');

const CHECK_INTERVAL_MS = 10 * 60 * 1000; // Check every 10 minutes

// Helpers
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

function findTokenIndex(tokens, outcomeStr) {
    const target = norm(outcomeStr);
    const outcomesNorm = tokens.map(t => norm(t.outcome));
    let idx = outcomesNorm.findIndex(o => o === target);
    if (idx < 0) idx = outcomesNorm.findIndex(o => o.includes(target) || target.includes(o));
    if (idx < 0 && tokens.length === 2) {
        if (target === 'up' || target === 'bull' || target === 'yes') idx = outcomesNorm.findIndex(o => o === 'yes');
        if (target === 'down' || target === 'bear' || target === 'no') idx = outcomesNorm.findIndex(o => o === 'no');
    }
    return idx;
}

function isValidEntry(price) {
    return isFinite(price) && price >= 0.01 && price <= 1.0;
}

function computeRoi(side, payout, entry, sizeUsd) {
    // Default: realistic mode (actual Polymarket conditions)
    // Override: ROI_MODE=conservative for stress-testing
    const mode = (process.env.ROI_MODE || 'realistic').toLowerCase();
    const calculateFn = mode === 'conservative' 
        ? math.calculateConservativeRoi 
        : math.calculateRealisticRoi;
    
    const s = (side || 'BUY').toUpperCase();
    if (s === 'BUY') {
        return calculateFn(payout, entry, sizeUsd);
    }
    // SELL: take opposite leg
    const effectiveEntry = 1 - entry;
    const effectivePayout = 1 - payout;
    return calculateFn(effectivePayout, effectiveEntry, sizeUsd);
}

async function backfillConditionIdIfNeeded(signal) {
    if (signal.condition_id) return true;
    if (process.env.BACKFILL_CONDITION !== '1') return false;
    try {
        const slug = signal.event_slug || signal.market_slug || '';
        if (!slug) return false;
        const resp = await fetchFn(`https://polymarket.com/api/events/${slug}`);
        if (!resp.ok) return false;
        const data = await resp.json();
        const markets = (data.markets || []).map(m => ({ id: m.conditionId || m.id, tokens: m.tokens || [] }));
        let picked = null;
        for (const m of markets) {
            const idx = findTokenIndex(m.tokens, signal.outcome || '');
            if (idx >= 0) { picked = m; break; }
        }
        if (picked && picked.id) {
            const vresp = await fetchFn(`https://clob.polymarket.com/markets/${picked.id}`);
            if (vresp.ok) {
                await db.updateSignalConditionId(signal.id, picked.id);
                return true;
            }
        }
    } catch (_) {}
    return false;
}

async function checkResolutions() {
    if (process.env.FORWARD_DEBUG === '1') console.log('🔍 [ForwardTest] Checking for market resolutions...');
    try {
        const pendingSignals = await db.getPendingSignals();
        if (!pendingSignals || pendingSignals.length === 0) {
            if (process.env.FORWARD_DEBUG === '1') console.log('   [ForwardTest] No pending signals.');
            return;
        }
        if (process.env.FORWARD_DEBUG === '1') console.log(`   [ForwardTest] Found ${pendingSignals.length} pending signals.`);

        const batchLimit = Number(process.env.FORWARD_BATCH_LIMIT || '200');
        const signalsToProcess = pendingSignals.slice(-Math.max(1, batchLimit));
        for (const signal of signalsToProcess) {
            await new Promise(r => setTimeout(r, rateSleepMs));
            try {
                // Ensure we have condition_id
                if (!signal.condition_id) {
                    const ok = await backfillConditionIdIfNeeded(signal);
                    if (!ok) {
                        if (process.env.FORWARD_DEBUG === '1') console.log(`   ⚠️ Signal ${signal.id}: Missing condition_id. Skipping.`);
                        continue;
                    }
                }

                // Fetch market
                const resp = await fetchFn(`https://clob.polymarket.com/markets/${signal.condition_id}`);
                if (!resp.ok) {
                    if (resp.status === 404) {
                        await db.updateSignalResult(signal.id, { status: 'ERROR', result_pnl_percent: null, resolved_outcome: null });
                    }
                    if (process.env.FORWARD_DEBUG === '1') console.error(`   ❌ Signal ${signal.id}: API Error ${resp.status}`);
                    continue;
                }
                const market = await resp.json();
                const tokens = Array.isArray(market.tokens) ? market.tokens : [];
                const winnerIndex = tokens.findIndex(t => t.winner);
                const winnerOutcome = (winnerIndex >= 0 && tokens[winnerIndex]) ? tokens[winnerIndex].outcome : (tokens.find(t => t.winner)?.outcome || null);

                if (!market.closed) continue;
                
                // VOID/REFUND HANDLING: Full stake return, ROI=0%
                const marketStatus = String(market.status || '').toLowerCase();
                const isVoid = marketStatus === 'voided' || marketStatus === 'refunded' || marketStatus === 'invalid';
                if (isVoid) {
                    if (process.env.FORWARD_DEBUG === '1') console.log(`   ♻️ Signal ${signal.id}: Market VOIDED/REFUNDED. Returning stakes...`);
                    await db.updateSignalResult(signal.id, { status: 'CLOSED_VOID', result_pnl_percent: 0, resolved_outcome: 'VOID' });
                    
                    // Update user logs and return bets
                    const userLogs = await db.getUserLogsBySignalId(signal.id);
                    for (const row of userLogs) {
                        try {
                            await db.updateUserSignalLogById(row.id, { status: 'CLOSED_VOID', result_pnl_percent: 0, resolved_outcome: 'VOID' });
                            const betAmt = Number(row.bet_amount || 0);
                            if (betAmt > 0) {
                                // Return full stake: release locked, add to balance
                                await db.updatePortfolio(row.chat_id, { balanceDelta: betAmt, lockedDelta: -betAmt });
                            }
                        } catch (_) {}
                    }
                    if (process.env.FORWARD_DEBUG === '1') console.log(`   ✅ Signal ${signal.id}: Void settled.`);
                    continue;
                }
                
                if (process.env.FORWARD_DEBUG === '1') console.log(`   🏁 Signal ${signal.id}: Market CLOSED. Resolving...`);

                // Determine which token the signal references (supports multi-outcome markets)
                let signalTokenIndex = typeof signal.token_index === 'number' ? signal.token_index : findTokenIndex(tokens, signal.outcome || '');
                
                if (process.env.FORWARD_DEBUG === '1') {
                    const availableOutcomes = tokens.map((t, i) => `[${i}] ${t.outcome}${t.winner ? ' ✓' : ''}`).join(', ');
                    console.log(`   📊 Signal ${signal.id}: Outcome="${signal.outcome}" → Token[${signalTokenIndex}], Available: ${availableOutcomes}`);
                }

                let signalWon = false;
                if (signalTokenIndex >= 0 && winnerIndex >= 0) {
                    signalWon = (signalTokenIndex === winnerIndex);
                } else if (winnerOutcome) {
                    // Fallback textual compare
                    signalWon = norm(signal.outcome || '') === norm(winnerOutcome || '');
                }
                const payout = signalWon ? 1.0 : 0.0;

                // Entry Price Integrity
                const entry = Number(signal.entry_price);
                const sizeUsd = Number(signal.size_usd || 1000);
                if (!isValidEntry(entry)) {
                    if (process.env.FORWARD_DEBUG === '1') console.log(`   ❌ Signal ${signal.id}: Invalid entry_price=${signal.entry_price}. Marking ERROR.`);
                    await db.updateSignalResult(signal.id, { status: 'ERROR', result_pnl_percent: null, resolved_outcome: winnerOutcome });
                    continue;
                }

                // ROI (Honest Math)
                const roiPercent = computeRoi(signal.side, payout, entry, sizeUsd);
                if (process.env.FORWARD_DEBUG === '1') {
                    console.log(`   🧮 Signal ${signal.id}: Side=${signal.side}, Outcome=${signal.outcome}, Winner=${winnerOutcome}, Entry=${entry}, Size=${sizeUsd}, ROI=${roiPercent.toFixed(2)}%`);
                }

                // Update signal
                await db.updateSignalResult(signal.id, { status: 'CLOSED', result_pnl_percent: roiPercent, resolved_outcome: winnerOutcome });

                // Update user logs
                const userLogs = await db.getUserLogsBySignalId(signal.id);
                for (const row of userLogs) {
                    try {
                        let userWon = false;
                        if (typeof row.token_index === 'number' && winnerIndex >= 0) {
                            userWon = (row.token_index === winnerIndex);
                        } else {
                            userWon = norm(row.outcome || '') === norm(winnerOutcome || '');
                        }
                        const userPayout = userWon ? 1.0 : 0.0;
                        const userEntry = Number(row.entry_price || 0);
                        const userSize = Number(row.size_usd || 1000);
                        let userRoi = 0;
                        if (isValidEntry(userEntry)) {
                            userRoi = computeRoi(row.side, userPayout, userEntry, userSize);
                        }
                        await db.updateUserSignalLogById(row.id, { status: 'CLOSED', result_pnl_percent: userRoi, resolved_outcome: winnerOutcome });

                        // --- SEPARATION LOGIC ---
                        const betAmt = Number(row.bet_amount || 0);
                        
                        if (row.strategy === 'shadow_mining') {
                            // TRACK A: Data Mining
                            // Do NOTHING to portfolio. Just saved the ROI above.
                            if (process.env.FORWARD_DEBUG === '1') console.log(`   ⛏️ Shadow Bet ${row.id} resolved. ROI: ${userRoi.toFixed(2)}%`);
                        } 
                        else if (betAmt > 0) {
                            // TRACK B: Real Challenge / Portfolio
                            // Calculate Payout and Update Balance
                            const payoutFactor = Math.max(0, 1 + (userRoi / 100));
                            const payoutUsd = Math.round(betAmt * payoutFactor * 100) / 100;
                            
                            // Release locked and credit balance
                            await db.updatePortfolio(row.chat_id, { balanceDelta: payoutUsd, lockedDelta: -betAmt });
                            
                            if (process.env.FORWARD_DEBUG === '1') console.log(`   💰 Real Bet ${row.id} resolved. Payout: $${payoutUsd}`);
                        }
                    } catch (_) {}
                }

                if (process.env.FORWARD_DEBUG === '1') console.log(`   ✅ Signal ${signal.id}: Resolved.`);
            } catch (err) {
                if (process.env.FORWARD_DEBUG === '1') console.error(`   ❌ Error processing signal ${signal.id}:`, err.message);
            }
        }
    } catch (err) {
        if (process.env.FORWARD_DEBUG === '1') console.error('❌ [ForwardTest] Global Error:', err);
    }
}

function startService() {
    console.log('🚀 Forward Testing Service Started.');
    checkResolutions();
    setInterval(checkResolutions, CHECK_INTERVAL_MS);
}

module.exports = {
    startService,
    checkResolutions,
    setFetch,
    setRateSleep,
    backfillMissingConditionIds: async function() {
        try {
            const pendingSignals = await db.getPendingSignals();
            const targets = pendingSignals.filter(s => !s.condition_id);
            for (const signal of targets) {
                await new Promise(r => setTimeout(r, rateSleepMs));
                try {
                    await backfillConditionIdIfNeeded(signal);
                } catch (_) {}
            }
        } catch (_) {}
    }
};

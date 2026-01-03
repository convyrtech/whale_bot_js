const { ethers } = require('ethers');
const axios = require('axios');
const logger = require('./logger');

// Polygon USDC Contract
const USDC_ADDRESS = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'];

// Minimal public RPCs (Use user key if available)
const RPC_URLS = [
    process.env.POLYGON_RPC_URL,
    'https://polygon-rpc.com',
    'https://rpc-mainnet.matic.quiknode.pro'
].filter(Boolean);

let provider = null;

// Initialize Provider
function getProvider() {
    if (provider) return provider;
    // Simple Round-Robin or just First for now.
    // In production, we'd want a FallbackProvider.
    // For simplicity, pick the first valid one.
    const url = RPC_URLS[0];
    try {
        provider = new ethers.JsonRpcProvider(url);
        // logger.info(`Connected to RPC: ${url}`);
    } catch (e) {
        logger.error(`RPC Connection Failed: ${e.message}`);
    }
    return provider;
}

/**
 * Get USDC Balance of an address.
 * @param {string} address Wallet Address
 * @returns {Promise<number>} Balance in USD (float)
 */
async function getUsdcBalance(address) {
    try {
        const prov = getProvider();
        if (!prov) return 0;

        const contract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, prov);
        const bal = await contract.balanceOf(address);
        // USDC has 6 decimals
        return Number(ethers.formatUnits(bal, 6));
    } catch (e) {
        logger.error(`Failed to fetch USDC balance for ${address}: ${e.message}`);
        return 0; // Fail safe
    }
}

/**
 * Get Wallet Age (First Transaction Time).
 * Uses PolygonScan API.
 * @param {string} address 
 * @returns {Promise<number|null>} Timestamp in ms, or null if failed
 */
async function getWalletAgeMs(address) {
    const apiKey = process.env.POLYGONSCAN_API_KEY || 'YourApiKeyToken'; // Fallback to free tier
    const url = `https://api.polygonscan.com/api?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&page=1&offset=1&sort=asc&apikey=${apiKey}`;

    try {
        const resp = await axios.get(url, { timeout: 3000 });
        const data = resp.data;
        if (data.status === '1' && data.result.length > 0) {
            const firstTx = data.result[0];
            return Number(firstTx.timeStamp) * 1000;
        }
    } catch (e) {
        // Silent fail (API limits likely)
    }
    return null;
}

module.exports = {
    getUsdcBalance,
    getWalletAgeMs
};

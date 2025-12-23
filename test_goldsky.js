const axios = require('axios');

const endpoints = [
    'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/polymarket/prod/gn',
    'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/polymarket-subgraph/prod/gn',
    'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/fpmm-subgraph/prod/gn',
    'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/polymarket/v1/gn',
    'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/polymarket/v2/gn',
    'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/polymarket-subgraph/v1/gn',
    'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/polymarket-subgraph/v2/gn',
    'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/matic-graph-fast/prod/gn',
];

async function test() {
    for (const url of endpoints) {
        try {
            console.log(`Testing ${url}...`);
            const response = await axios.post(url, {
                query: '{ _meta { block { number } } }'
            });
            console.log(`SUCCESS: ${url}`);
            console.log('Status:', response.status);
            // console.log('Data:', JSON.stringify(response.data, null, 2));
            return; // Found it!
        } catch (error) {
            if (error.response) {
                console.log(`Failed: ${error.response.status} - ${error.response.data.message || error.response.statusText}`);
            } else {
                console.log(`Failed: ${error.message}`);
            }
        }
    }
    console.log('All endpoints failed.');
}

test();

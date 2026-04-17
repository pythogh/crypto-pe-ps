const express = require('express');
const path    = require('path');
const https   = require('https');
const app     = express();

const CG_KEY  = 'CG-zQg6pyzA4RPm5Tti2p7RTsn2';
const CG_BASE = 'https://api.coingecko.com/api/v3';
const LL_BASE = 'https://api.llama.fi';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// Simple fetch using built-in https — zero dependencies
function fetchJSON(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const options = {
      headers: { 'Accept': 'application/json', ...headers },
      timeout: 12000,
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
        } else {
          try { resolve(JSON.parse(data)); }
          catch(e) { reject(e); }
        }
      });
    }).on('error', reject).on('timeout', () => reject(new Error('timeout')));
  });
}

const CG_H = { 'x-cg-demo-api-key': CG_KEY };

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/batch', async (req, res) => {
  const coins = req.body;
  console.log(`[batch] ${coins.length} coins`);

  const results = await Promise.all(coins.map(async ({ cgId, llamaSlug }) => {
    try {
      const coin = await fetchJSON(
        `${CG_BASE}/coins/${cgId}?localization=false&tickers=false&community_data=false&developer_data=false`,
        CG_H
      );
      console.log(`[CG ✅] ${cgId}`);

      // Price history via DefiLlama
      const start365 = Math.floor(Date.now() / 1000) - 365 * 86400;
      let prices = [];
      try {
        const llPrice = await fetchJSON(
          `https://coins.llama.fi/chart/coingecko:${cgId}?start=${start365}&span=365&period=1d`
        );
        const pts = llPrice?.coins?.[`coingecko:${cgId}`]?.prices || [];
        prices = pts.map(p => [p.timestamp * 1000, p.price]);
      } catch(e) { console.warn(`[LL price ⚠️] ${cgId}`); }

      // Revenue via DefiLlama
      let revData = null;
      for (const slug of [llamaSlug, cgId].filter(Boolean)) {
        try {
          const d = await fetchJSON(
            `${LL_BASE}/summary/fees/${encodeURIComponent(slug)}?dataType=dailyRevenue`
          );
          const allPts = d.totalDataChart || [];
          if (!allPts.length) continue;
          const last30 = allPts.slice(-30);
          const rev30d = last30.reduce((s, [, v]) => s + (v || 0), 0);
          const rev24h = allPts[allPts.length - 1]?.[1] ?? null;
          const rev48h = allPts[allPts.length - 2]?.[1] ?? null;
          revData = {
            rev30d, rev7d: last30.slice(-7).reduce((s,[,v])=>s+(v||0),0),
            rev24h, rev24hChange: (rev24h&&rev48h&&rev48h>0)?((rev24h-rev48h)/rev48h)*100:null,
            revAnn: rev30d * 12,
            history: allPts.map(([ts,v])=>[ts*1000,v||0]),
          };
          console.log(`[LL ✅] ${slug}`);
          break;
        } catch(e) { console.warn(`[LL ⚠️] ${slug}`); }
      }

      return {
        cgId, name: coin.name, symbol: coin.symbol?.toUpperCase(),
        logo: coin.image?.small, price: coin.market_data?.current_price?.usd,
        mcap: coin.market_data?.market_cap?.usd, fdv: coin.market_data?.fully_diluted_valuation?.usd,
        change24h: coin.market_data?.price_change_percentage_24h,
        prices, rev: revData, error: null,
      };
    } catch(e) {
      console.error(`[CG ❌] ${cgId} — ${e.message}`);
      return { cgId, error: e.message };
    }
  }));

  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server on port ${PORT}`));

const express = require('express');
const path    = require('path');
const app     = express();

const CG_KEY  = 'CG-zQg6pyzA4RPm5Tti2p7RTsn2';
const CG_BASE = 'https://api.coingecko.com/api/v3';
const LL_BASE = 'https://api.llama.fi';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

async function fetchJSON(url, headers = {}, timeoutMs = 12000) {
  const { default: fetch } = await import('node-fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch(e) { clearTimeout(timer); throw e; }
}

const CG_H = { 'x-cg-demo-api-key': CG_KEY };

app.post('/api/batch', async (req, res) => {
  const coins = req.body;
  console.log(`[batch] ${coins.length} coins…`);

  const results = await Promise.all(coins.map(async ({ cgId, llamaSlug }) => {
    try {
      const coin = await fetchJSON(
        `${CG_BASE}/coins/${cgId}?localization=false&tickers=false&community_data=false&developer_data=false`,
        CG_H
      );
      console.log(`[CG ✅] ${cgId}`);

      // Price history via DefiLlama (365d, free, no key needed)
      const start365 = Math.floor(Date.now() / 1000) - 365 * 86400;
      let prices = [];
      try {
        const llPrice = await fetchJSON(
          `https://coins.llama.fi/chart/coingecko:${cgId}?start=${start365}&span=365&period=1d`
        );
        const pts = llPrice?.coins?.[`coingecko:${cgId}`]?.prices || [];
        prices = pts.map(p => [p.timestamp * 1000, p.price]);
        console.log(`[LL price ✅] ${cgId} — ${prices.length} pts`);
      } catch(e) {
        console.warn(`[LL price ⚠️] ${cgId} — ${e.message}`);
      }

      // Revenue via DefiLlama
      let revData = null;
      const slugsToTry = [llamaSlug, cgId].filter(Boolean);
      for (const slug of slugsToTry) {
        try {
          const d = await fetchJSON(
            `${LL_BASE}/summary/fees/${encodeURIComponent(slug)}?dataType=dailyRevenue`
          );
          const allPts = d.totalDataChart || [];
          if (allPts.length === 0) continue;

          const last30 = allPts.slice(-30);
          const rev30d = last30.reduce((s, [, v]) => s + (v || 0), 0);

          const rev24h  = allPts.length >= 1 ? allPts[allPts.length - 1][1] : null;
          const rev48h  = allPts.length >= 2 ? allPts[allPts.length - 2][1] : null;
          const rev24hChange = (rev24h && rev48h && rev48h > 0)
            ? ((rev24h - rev48h) / rev48h) * 100
            : null;

          revData = {
            rev30d,
            rev7d:       last30.slice(-7).reduce((s, [, v]) => s + (v || 0), 0),
            rev24h,
            rev24hChange,
            revAnn:      rev30d * 12,
            history:     allPts.map(([ts, v]) => [ts * 1000, v || 0]),
          };
          console.log(`[LL rev ✅] ${slug} — 30d=$${Math.round(rev30d).toLocaleString()}`);
          break;
        } catch(e) {
          console.warn(`[LL rev ⚠️] ${slug} — ${e.message}`);
        }
      }

      return {
        cgId,
        name:      coin.name,
        symbol:    coin.symbol?.toUpperCase(),
        logo:      coin.image?.small,
        price:     coin.market_data?.current_price?.usd,
        mcap:      coin.market_data?.market_cap?.usd,
        fdv:       coin.market_data?.fully_diluted_valuation?.usd,
        change24h: coin.market_data?.price_change_percentage_24h,
        prices,
        rev:       revData,
        error:     null,
      };
    } catch(e) {
      console.error(`[CG ❌] ${cgId} — ${e.message}`);
      return { cgId, error: e.message };
    }
  }));

  const ok = results.filter(r => !r.error).length;
  console.log(`[batch] ${ok}/${coins.length} ok`);
  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅  http://0.0.0.0:${PORT}`));

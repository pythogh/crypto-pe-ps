const express = require('express');
const path    = require('path');
const app     = express();

const CG_KEY  = 'CG-zQg6pyzA4RPm5Tti2p7RTsn2';
const CG_BASE = 'https://api.coingecko.com/api/v3';
const LL_BASE = 'https://api.llama.fi';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Fetch avec timeout ────────────────────────────────────────────────────────
async function fetchJSON(url, headers = {}, timeoutMs = 10000) {
  const { default: fetch } = await import('node-fetch');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
    return res.json();
  } catch(e) {
    clearTimeout(timer);
    throw e;
  }
}

const CG_H = { 'x-cg-demo-api-key': CG_KEY };

// ── Batch : charge tous les coins ─────────────────────────────────────────────
app.post('/api/batch', async (req, res) => {
  const coins = req.body;
  console.log(`[batch] Chargement de ${coins.length} coins…`);

  const results = await Promise.all(coins.map(async ({ cgId, llamaSlug }) => {
    try {
      // CoinGecko : infos + historique prix (parallèle)
      const [coin, chart] = await Promise.all([
        fetchJSON(`${CG_BASE}/coins/${cgId}?localization=false&tickers=false&community_data=false&developer_data=false`, CG_H),
        fetchJSON(`${CG_BASE}/coins/${cgId}/market_chart?vs_currency=usd&days=30&interval=daily`, CG_H),
      ]);
      console.log(`[CG ✅] ${cgId}`);

      // DefiLlama : revenue (optionnel, ne fait pas planter le reste)
      let revData = null;
      const slug = llamaSlug || cgId;
      try {
        const d = await fetchJSON(`${LL_BASE}/summary/fees/${slug}?dataType=dailyRevenue`);
        const last30 = (d.totalDataChart || []).slice(-30);
        const rev30d = last30.reduce((s, [, v]) => s + (v || 0), 0);
        revData = {
          rev30d,
          rev7d:   last30.slice(-7).reduce((s, [, v]) => s + (v || 0), 0),
          revAnn:  rev30d * (365 / 30),
          history: last30.map(([ts, v]) => ({ ts: ts * 1000, v: v || 0 })),
        };
        console.log(`[LL ✅] ${slug} — rev30d: $${Math.round(revData.rev30d).toLocaleString()}`);
      } catch(llamaErr) {
        console.warn(`[LL ⚠️] ${slug} — ${llamaErr.message}`);
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
        prices:    chart.prices,
        rev:       revData,
        error:     null,
      };
    } catch (e) {
      console.error(`[CG ❌] ${cgId} — ${e.message}`);
      return { cgId, error: e.message };
    }
  }));

  const ok  = results.filter(r => !r.error).length;
  const err = results.filter(r =>  r.error).length;
  console.log(`[batch] Terminé : ${ok} ok, ${err} erreurs`);
  res.json(results);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅  Dashboard → http://localhost:${PORT}`));

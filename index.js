const express = require('express');
const path    = require('path');
const app     = express();

const CG_KEY  = 'CG-zQg6pyzA4RPm5Tti2p7RTsn2';
const CG_BASE = 'https://api.coingecko.com/api/v3';
const LL_BASE = 'https://api.llama.fi';

app.use(express.static(path.join(__dirname, 'public')));

// ── Helper fetch ────────────────────────────────────────────────────────────
async function fetchJSON(url, headers = {}) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

// ── Route : coin info + price history ───────────────────────────────────────
app.get('/api/coin/:id', async (req, res) => {
  try {
    const id      = req.params.id.toLowerCase();
    const headers = { 'x-cg-demo-api-key': CG_KEY };

    const [coin, chart] = await Promise.all([
      fetchJSON(`${CG_BASE}/coins/${id}?localization=false&tickers=false&community_data=false&developer_data=false`, headers),
      fetchJSON(`${CG_BASE}/coins/${id}/market_chart?vs_currency=usd&days=30&interval=daily`, headers),
    ]);

    res.json({
      name:      coin.name,
      symbol:    coin.symbol?.toUpperCase(),
      logo:      coin.image?.small,
      price:     coin.market_data?.current_price?.usd,
      mcap:      coin.market_data?.market_cap?.usd,
      fdv:       coin.market_data?.fully_diluted_valuation?.usd,
      change24h: coin.market_data?.price_change_percentage_24h,
      prices:    chart.prices,   // [[ts, price], ...]
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── Route : DefiLlama revenue ────────────────────────────────────────────────
app.get('/api/revenue/:slug', async (req, res) => {
  try {
    const slug = req.params.slug.toLowerCase();
    const data = await fetchJSON(`${LL_BASE}/summary/fees/${slug}?dataType=dailyRevenue`);

    const chart  = data.totalDataChart || [];
    const last30 = chart.slice(-30);
    const rev30d = last30.reduce((s, [, v]) => s + (v || 0), 0);

    res.json({
      slug,
      rev30d,
      rev7d:    last30.slice(-7).reduce((s, [, v]) => s + (v || 0), 0),
      revAnn:   rev30d * (365 / 30),
      history:  last30.map(([ts, v]) => ({ ts: ts * 1000, v: v || 0 })),
    });
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// ── Route : chercher le bon slug DefiLlama ───────────────────────────────────
app.get('/api/find-protocol/:name', async (req, res) => {
  try {
    const search   = req.params.name.toLowerCase();
    const overview = await fetchJSON(`${LL_BASE}/overview/fees?excludeTotalDataChartBreakdown=true&excludeTotalDataChart=true`);
    const protos   = overview.protocols || [];

    const match =
      protos.find(p => p.slug === search) ||
      protos.find(p => p.name?.toLowerCase() === search) ||
      protos.find(p => p.slug?.includes(search)) ||
      protos.find(p => p.name?.toLowerCase().includes(search));

    if (!match) return res.status(404).json({ error: 'Protocol not found' });
    res.json({ slug: match.slug, name: match.name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅  Dashboard running on http://localhost:${PORT}`));

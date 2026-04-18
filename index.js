const express = require('express');
const path    = require('path');
const https   = require('https');
const app     = express();

const CG_KEY  = process.env.CG_KEY || 'CG-zQg6pyzA4RPm5Tti2p7RTsn2';
const CG_BASE = 'https://api.coingecko.com/api/v3';
const LL_BASE = 'https://api.llama.fi';

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ── Cache ─────────────────────────────────────────────────────────────────────
const fs        = require('fs');
const CACHE_FILE = '/tmp/token_pe_cache.json';
const CACHE_TTL  = 5 * 60 * 1000; // 5 minutes

let cache     = null;
let cacheTime = 0;

// Load from disk on startup
try {
  const raw  = fs.readFileSync(CACHE_FILE, 'utf8');
  const { data, time } = JSON.parse(raw);
  cache     = data;
  cacheTime = time;
  console.log(`[cache] loaded from disk (${Math.round((Date.now()-time)/1000)}s old)`);
} catch(e) {
  console.log('[cache] no disk cache found, will fetch fresh');
}

function saveCacheToDisk(data) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ data, time: Date.now() }));
  } catch(e) {
    console.warn('[cache] could not write to disk:', e.message);
  }
}

// ── HTTP helper ───────────────────────────────────────────────────────────────
function fetchJSON(url, headers = {}, retries = 2) {
  return new Promise((resolve, reject) => {
    const options = { headers: { 'Accept': 'application/json', ...headers }, timeout: 15000 };
    const attempt = (n) => {
      https.get(url, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 429 && n > 0) {
            setTimeout(() => attempt(n - 1), 1500);
          } else if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
          } else {
            try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
          }
        });
      }).on('error', reject).on('timeout', () => {
        if (n > 0) setTimeout(() => attempt(n - 1), 500);
        else reject(new Error('timeout'));
      });
    };
    attempt(retries);
  });
}

const CG_H = { 'x-cg-demo-api-key': CG_KEY };

// ── Fetch all coins data ──────────────────────────────────────────────────────
async function fetchAllCoins(coins) {
  console.log(`[refresh] fetching ${coins.length} coins…`);
  const start = Date.now();

  // Step 1 — CoinGecko batch: prix/mcap/fdv/24h for ALL coins in ONE request
  const ids = coins.map(c => c.cgId).join(',');
  const markets = await fetchJSON(
    `${CG_BASE}/coins/markets?vs_currency=usd&ids=${ids}&order=market_cap_desc&per_page=250&price_change_percentage=24h`,
    CG_H
  );
  const marketMap = {};
  markets.forEach(m => { marketMap[m.id] = m; });
  console.log(`[CG batch ✅] ${markets.length} coins in ${Date.now()-start}ms`);

  // Step 2 — DefiLlama price history (parallel, no rate limit)
  const priceResults = await Promise.all(
    coins.map(async ({ cgId }) => {
      try {
        const start365 = Math.floor(Date.now() / 1000) - 365 * 86400;
        const d = await fetchJSON(
          `https://coins.llama.fi/chart/coingecko:${cgId}?start=${start365}&span=365&period=1d`
        );
        const pts = d?.coins?.[`coingecko:${cgId}`]?.prices || [];
        return { cgId, prices: pts.map(p => [p.timestamp * 1000, p.price]) };
      } catch(e) {
        return { cgId, prices: [] };
      }
    })
  );
  const priceMap = {};
  priceResults.forEach(({ cgId, prices }) => { priceMap[cgId] = prices; });
  console.log(`[LL prices ✅] ${Date.now()-start}ms`);

  // Step 3 — DefiLlama revenue (batches of 8, small delay)
  const revResults = [];
  for (let i = 0; i < coins.length; i += 8) {
    const batch = coins.slice(i, i + 8);
    const results = await Promise.all(batch.map(async ({ cgId, llamaSlug }) => {
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
          return {
            cgId,
            rev: {
              rev30d, rev7d: last30.slice(-7).reduce((s,[,v])=>s+(v||0),0),
              rev24h, rev24hChange: (rev24h&&rev48h&&rev48h>0)?((rev24h-rev48h)/rev48h)*100:null,
              revAnn: rev30d * 12,
              history: allPts.map(([ts,v]) => [ts*1000, v||0]),
            }
          };
        } catch(e) {}
      }
      return { cgId, rev: null };
    }));
    revResults.push(...results);
    if (i + 8 < coins.length) await new Promise(r => setTimeout(r, 300));
  }
  const revMap = {};
  revResults.forEach(({ cgId, rev }) => { revMap[cgId] = rev; });
  console.log(`[LL rev ✅] ${Date.now()-start}ms`);

  // Step 4 — Assemble results
  const results = coins.map(({ cgId }) => {
    const m = marketMap[cgId];
    if (!m) return { cgId, error: 'not found in markets' };
    return {
      cgId,
      name:      m.name,
      symbol:    m.symbol?.toUpperCase(),
      logo:      m.image,
      price:     m.current_price,
      mcap:      m.market_cap,
      fdv:       m.fully_diluted_valuation,
      change24h: m.price_change_percentage_24h_in_currency ?? m.price_change_percentage_24h,
      prices:    priceMap[cgId] || [],
      rev:       revMap[cgId]   || null,
      error:     null,
    };
  });

  console.log(`[refresh done] ${Date.now()-start}ms total`);
  return results;
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/batch', async (req, res) => {
  const coins = req.body;

  // Serve from cache if fresh
  if (cache && Date.now() - cacheTime < CACHE_TTL) {
    console.log(`[cache hit] ${Math.round((Date.now()-cacheTime)/1000)}s old`);
    return res.json(cache);
  }

  // Fetch fresh data
  try {
    const results = await fetchAllCoins(coins);
    cache     = results;
    cacheTime = Date.now();
    saveCacheToDisk(results);
    res.json(results);
  } catch(e) {
    console.error('[batch error]', e.message);
    // Serve stale cache if available
    if (cache) { console.log('[serving stale cache]'); return res.json(cache); }
    res.status(500).json({ error: e.message });
  }
});

// Pre-warm cache on startup after 2s
const DEFAULT_COINS = [
  { cgId: 'hyperliquid',             llamaSlug: 'hyperliquid'   },
  { cgId: 'pump-fun',                llamaSlug: 'pump'          },
  { cgId: 'aave',                    llamaSlug: 'aave'          },
  { cgId: 'lido-dao',                llamaSlug: 'lido'          },
  { cgId: 'ether-fi',                llamaSlug: 'ether.fi'      },
  { cgId: 'syrup',                   llamaSlug: 'maple-finance' },
  { cgId: 'railgun',                 llamaSlug: 'railgun'       },
  { cgId: 'sky',                     llamaSlug: 'sky'           },
  { cgId: 'derive',                  llamaSlug: 'derive'        },
  { cgId: 'kinetiq',                 llamaSlug: 'kinetiq'       },
  { cgId: 'pendle',                  llamaSlug: 'pendle'        },
  { cgId: 'jupiter-exchange-solana', llamaSlug: 'jupiter'       },
  { cgId: 'lighter',                 llamaSlug: 'lighter'       },
  { cgId: 'aerodrome-finance',       llamaSlug: 'aerodrome'     },
  { cgId: 'meteora',                 llamaSlug: 'meteora'       },
  { cgId: 'gmx',                     llamaSlug: 'gmx'           },
  { cgId: 'fluid',                   llamaSlug: 'fluid'         },
  { cgId: 'raydium',                 llamaSlug: 'raydium'       },
  { cgId: 'uniswap',                 llamaSlug: 'uniswap'       },
  { cgId: 'helium',                  llamaSlug: 'helium'        },
  { cgId: 'bluefin',                 llamaSlug: 'bluefin'       },
  { cgId: 'ethena',                  llamaSlug: 'ethena'        },
];

setTimeout(async () => {
  console.log('[pre-warm] starting cache warm-up…');
  try {
    cache     = await fetchAllCoins(DEFAULT_COINS);
    cacheTime = Date.now();
    saveCacheToDisk(cache);
    console.log('[pre-warm] done ✅');
  } catch(e) {
    console.error('[pre-warm error]', e.message);
  }
}, 2000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server on port ${PORT}`));

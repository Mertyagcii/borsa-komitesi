/* TradingOfis dış tetikleyici (Cloudflare Worker).
   Neden: GitHub'ın kendi zamanlayıcısı "15 dakikada bir" yerine pratikte 4-5 saatte bir çalışıyor (ölçülen: %6). Bu Worker, Cloudflare'ın güvenilir
   cron'uyla GitHub'a "iş akışını şimdi çalıştır" (workflow_dispatch) çağrısı yapar. Sitenin veri sıklığı bununla gerçek 10 dakikaya iner.
   Gizli anahtar (GH_TOKEN) KOD İÇİNDE DEĞİL: Cloudflare panelinde "Secret" olarak saklanır. Kurulum: README.md. */
const REPO = "Mertyagcii/borsa-komitesi", WORKFLOW = "pages.yml", REF = "main";

async function dispatch(env) {
  if (!env.GH_TOKEN) throw new Error("GH_TOKEN secret tanımlı değil");
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GH_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "tradingofis-tetikleyici",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ref: REF}),
  });
  if (r.status !== 204) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.status;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env).then(() => console.log("tetiklendi", event.cron, new Date().toISOString()), e => console.error("tetikleme başarısız:", e.message)));
  },
  // Tarayıcıdan adresi açınca durum kontrolü (tetiklemez; yalnızca çalıştığını gösterir).
  async fetch(req, env) {
    return new Response(JSON.stringify({ok: true, repo: REPO, workflow: WORKFLOW, token_tanimli: !!env.GH_TOKEN}), {headers: {"content-type": "application/json"}});
  },
};

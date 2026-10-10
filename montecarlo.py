"""Monte Carlo risk simülasyonu (GBM). Tarihsel fiyat serisi olmadığı için günlük oynaklık
ATR/kapanış oranından (sigma ≈ 0.8 × ATR%) yaklaşık olarak alınır."""
import numpy as np
import pandas as pd


def simulate(
    df: pd.DataFrame,
    horizon_days: int = 20,
    n_paths: int = 5000,
    stop_pct: float = 7.0,
    seed: int = 42,
) -> pd.DataFrame:
    """Her hisse için ufuk sonu getiri dağılımı ve stop'a değme olasılığını hesaplar. Drift = 0."""
    rng = np.random.default_rng(seed)
    rows = []
    for _, r in df.dropna(subset=["ATR", "close"]).iterrows():
        sigma = max(0.8 * float(r["ATR"]) / float(r["close"]), 1e-4)
        rets = rng.normal(-0.5 * sigma**2, sigma, size=(n_paths, horizon_days))
        paths = np.exp(np.cumsum(rets, axis=1))  # başlangıç fiyatına göre oran
        final = paths[:, -1] - 1
        hit_stop = (paths.min(axis=1) <= 1 - stop_pct / 100).mean()
        rows.append({
            "name": r["name"],
            "sigma_daily_pct": sigma * 100,
            "p05_pct": np.percentile(final, 5) * 100,
            "p50_pct": np.percentile(final, 50) * 100,
            "p95_pct": np.percentile(final, 95) * 100,
            "prob_loss_pct": (final < 0).mean() * 100,
            "prob_stop_hit_pct": hit_stop * 100,
        })
    return pd.DataFrame(rows)

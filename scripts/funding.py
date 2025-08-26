#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Funding actual por token (bases tomadas de Lighter) para:
- Hyperliquid (agregador)
- Lighter (agregador)
- Paradex (REST histórico -> último funding_rate)

Salida: pivote con columnas Hyperliquid/hr | Lighter/hr | Paradex/hr
"""

import sys
import time
import math
import argparse
from collections import Counter
from typing import Any, Dict, Iterable, List, Optional, Tuple
from datetime import datetime, timezone

import httpx

API_AGG = "https://mainnet.zklighter.elliot.ai/api/v1/funding-rates"
PARADEX_URL = "https://api.prod.paradex.trade/v1/funding/data?market={market}"

# ---------------- util comunes ----------------
def clean_alnum(s: str) -> str:
    return "".join(ch for ch in s if ch.isalnum()).lower()

def pct(x: Optional[float]) -> str:
    if x is None or math.isnan(x):
        return "—"
    return f"{x*100:.4f}%"

def coerce_rate(val: Any) -> Optional[float]:
    """Normaliza a fracción por hora. Si viene en % (1..100) => /100. Descarta >50%/h."""
    if val is None:
        return None
    try:
        x = float(val)
    except Exception:
        return None
    if 1.0 < abs(x) <= 100.0:
        x /= 100.0
    if abs(x) > 0.5:
        return None
    return x

def base_from_symbol(symbol: str) -> str:
    s = (symbol or "").upper().replace("/", "-").replace("__", "-").strip()
    parts = [p for p in s.split("-") if p]
    return parts[0] if parts else (s or "?")

# ---------------- agregador (parser robusto) ----------------
PLAT_MAP = {
    "lighter": "Lighter",
    "zklighter": "Lighter",
    "hyperliquid": "Hyperliquid",
    "hyperliquidv2": "Hyperliquid",
    "hyper": "Hyperliquid",
}
PLATFORM_KEYS = ("platform", "exchange", "venue", "source", "provider", "dex", "market_provider")
SYMBOL_KEYS = ("symbol", "market", "pair", "name", "base", "asset", "coin", "ticker")
FUND_KEYS = ("funding_rate", "fundingrate", "hourlyfundingrate", "predictedfundingrate", "rate", "value")

def norm_platform_label(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    key = clean_alnum(raw)
    if key in PLAT_MAP:
        return PLAT_MAP[key]
    for k, v in PLAT_MAP.items():
        if k in key:
            return v
    return None

def is_probable_symbol_key(k: str) -> bool:
    return any(x in k.lower() for x in SYMBOL_KEYS)

def is_probable_platform_key(k: str) -> bool:
    return any(x in k.lower() for x in PLATFORM_KEYS)

def is_probable_rate_key(k: str) -> bool:
    k = k.lower()
    return any(x in k for x in FUND_KEYS) or ("fund" in k and "index" not in k and "time" not in k)

def traverse(node: Any, path_keys: Tuple[str, ...]) -> Iterable[Tuple[Dict[str, Any], Tuple[str, ...]]]:
    if isinstance(node, dict):
        yield node, path_keys
        for k, v in node.items():
            yield from traverse(v, path_keys + (str(k),))
    elif isinstance(node, list):
        for idx, v in enumerate(node):
            yield from traverse(v, path_keys + (str(idx),))

def extract_record(d: Dict[str, Any], path_keys: Tuple[str, ...]) -> Tuple[Optional[str], Optional[str], Optional[float]]:
    """(platform, base, rate) desde cualquier sub-dict del agregador."""
    platform = None
    symbol = None
    rate = None

    # 1) directos
    for k, v in d.items():
        if isinstance(v, str):
            if is_probable_platform_key(k) and not platform:
                platform = norm_platform_label(v)
            if is_probable_symbol_key(k) and not symbol:
                symbol = v
        if isinstance(v, (int, float, str)) and is_probable_rate_key(k) and rate is None:
            rate = coerce_rate(v)

    # 2) plataforma por ruta (p.ej. claves superiores "Hyperliquid" / "Lighter")
    if not platform:
        for key in path_keys[::-1]:
            guess = norm_platform_label(key)
            if guess:
                platform = guess
                break

    # 3) símbolo anidado
    if not symbol:
        for v in d.values():
            if isinstance(v, dict):
                for kk, vv in v.items():
                    if isinstance(vv, str) and is_probable_symbol_key(kk):
                        symbol = vv
                        break
            if symbol:
                break

    # 4) rate anidado
    if rate is None:
        for v in d.values():
            if isinstance(v, dict):
                for kk, vv in v.items():
                    if is_probable_rate_key(kk) and isinstance(vv, (int, float, str)):
                        rate = coerce_rate(vv)
                        if rate is not None:
                            break
            if rate is not None:
                break

    base = base_from_symbol(symbol or "")
    return platform, base if symbol else None, rate

def fetch_agg(agg_debug: bool=False) -> Tuple[Dict[str, Dict[str, float]], List[str]]:
    """
    Devuelve:
      - by_base: { BASE: { 'Lighter': rate?, 'Hyperliquid': rate? } }
      - bases_lighter: lista de BASE detectadas en Lighter (para seed de Paradex)
    """
    by_base: Dict[str, Dict[str, float]] = {}
    bases_lighter: List[str] = []
    seen_platforms = Counter()
    debug_samples: List[Tuple[Dict[str, Any], Tuple[str, ...]]] = []

    with httpx.Client(timeout=12, headers={"User-Agent": "funding-triplet/1.1"}) as client:
        r = client.get(API_AGG)
        r.raise_for_status()
        data = r.json()

    for node, path in traverse(data, ()):
        if not isinstance(node, dict):
            continue
        plat, base, rate = extract_record(node, path)
        if plat:
            seen_platforms[plat] += 1
        if plat not in ("Lighter", "Hyperliquid") or not base or rate is None:
            # guarda candidatos de debug
            if agg_debug and len(debug_samples) < 10:
                has_sym = any(is_probable_symbol_key(k) for k in node.keys())
                has_rate = any(is_probable_rate_key(k) for k in node.keys())
                if has_sym or has_rate:
                    debug_samples.append((node, path))
            continue

        by_base.setdefault(base, {})
        by_base[base][plat] = rate
        if plat == "Lighter" and base not in bases_lighter:
            bases_lighter.append(base)

    if not by_base and agg_debug:
        print("⚠ agregador vacío; plataformas vistas:", dict(seen_platforms))
        if debug_samples:
            import json as _json
            print("\nEjemplos de nodos candidatos del agregador:")
            for node, path in debug_samples:
                slim = {k: node[k] for k in list(node)[:8]}
                print(f"- path={'/'.join(path)} :: {_json.dumps(slim, ensure_ascii=False)[:300]} ...")

    return by_base, bases_lighter

# ---------------- Paradex ----------------
def _parse_ts(ts_val: Any) -> Optional[float]:
    if ts_val is None: return None
    if isinstance(ts_val, (int, float)):
        x = float(ts_val)
        return x/1000.0 if x > 1e12 else x
    if isinstance(ts_val, str):
        s = ts_val.strip()
        try:
            if s.endswith("Z"): s = s[:-1] + "+00:00"
            return datetime.fromisoformat(s).timestamp()
        except Exception:
            return None
    return None

def extract_paradex_latest(payload: Any) -> Optional[float]:
    items = None
    if isinstance(payload, list):
        items = payload
    elif isinstance(payload, dict):
        items = payload.get("data") or payload.get("results") or payload.get("items")
    if not isinstance(items, list) or not items:
        return None
    best_rate, best_ts = None, -1.0
    for it in items:
        if not isinstance(it, dict): continue
        rate_raw = it.get("funding_rate") or it.get("fundingRate") or it.get("hourly_funding_rate")
        try:
            rate = float(rate_raw) if rate_raw is not None else None
        except Exception:
            rate = None
        if rate is None: continue
        ts = (_parse_ts(it.get("timestamp")) or _parse_ts(it.get("time")) or
              _parse_ts(it.get("ts")) or _parse_ts(it.get("created_at")) or
              _parse_ts(it.get("updated_at")))
        if ts is None: ts = best_ts + 1.0
        if ts > best_ts:
            best_ts, best_rate = ts, rate
    return best_rate

def fetch_paradex_latest_for_base(base: str, quotes: List[str], client: httpx.Client, verbose: bool=False) -> Optional[float]:
    for q in quotes:
        mkt = f"{base}-{q}-PERP"
        url = PARADEX_URL.format(market=mkt)
        try:
            r = client.get(url, timeout=12)
            if verbose:
                print(f"[Paradex] GET {url} -> {r.status_code}")
            if r.status_code == 404:
                continue
            r.raise_for_status()
            rate = extract_paradex_latest(r.json())
            if rate is not None:
                if verbose:
                    print(f"[Paradex] {mkt} latest funding_rate={rate:.8f}")
                return rate
        except Exception as e:
            if verbose:
                print(f"[Paradex] {mkt} error: {e}")
            continue
    if verbose:
        print(f"[Paradex] {base}: sin mercado válido (quotes probadas: {quotes})")
    return None

# ---------------- render ----------------
def print_pivot(by_base: Dict[str, Dict[str, Optional[float]]]) -> None:
    bases = sorted(by_base.keys())
    headers = ["Activo", "Hyperliquid/hr", "Lighter/hr", "Paradex/hr"]
    col1 = max(len(headers[0]), *(len(b) for b in bases)) if bases else len(headers[0])
    col2 = max(len(headers[1]), *(len(pct(by_base[b].get("Hyperliquid"))) for b in bases)) if bases else len(headers[1])
    col3 = max(len(headers[2]), *(len(pct(by_base[b].get("Lighter"))) for b in bases)) if bases else len(headers[2])
    col4 = max(len(headers[3]), *(len(pct(by_base[b].get("Paradex"))) for b in bases)) if bases else len(headers[3])

    def pad(s,w): return s + " "*(w-len(s))
    line = "-"*(col1+col2+col3+col4+10)

    print(line)
    print(f"| {pad(headers[0], col1)} | {pad(headers[1], col2)} | {pad(headers[2], col3)} | {pad(headers[3], col4)} |")
    print(line)
    for b in bases:
        row = by_base[b]
        print(f"| {pad(b, col1)} | {pad(pct(row.get('Hyperliquid')), col2)} | {pad(pct(row.get('Lighter')), col3)} | {pad(pct(row.get('Paradex')), col4)} |")
    print(line)
    print(f"{len(bases)} tokens • {datetime.now(timezone.utc).isoformat(timespec='seconds')}")

# ---------------- main ----------------
def parse_args():
    ap = argparse.ArgumentParser(description="Funding actual: Hyperliquid + Lighter + Paradex (bases sacadas de Lighter)")
    ap.add_argument("--only-bases", type=str, default="", help="Limitar a estas bases (coma): 'BTC,ETH,SOL'")
    ap.add_argument("--limit", type=int, default=0, help="Limitar número de tokens (útil para tests)")
    ap.add_argument("--quotes", type=str, default="USD,USDC", help="Quotes a probar en Paradex: 'USD,USDC,USDT'")
    ap.add_argument("--sleep-ms", type=int, default=250, help="Pausa entre llamadas a Paradex (ms)")
    ap.add_argument("--paradex-verbose", action="store_true", help="Logs detallados de Paradex")
    ap.add_argument("--agg-debug", action="store_true", help="Depurar parseo del agregador si no aparecen HL/Lighter")
    return ap.parse_args()

def main() -> int:
    args = parse_args()

    # 1) HL + Lighter (parser robusto)
    try:
        by_base, bases_lighter = fetch_agg(agg_debug=args.agg_debug)
    except Exception as e:
        print(f"Error leyendo agregador: {e}", file=sys.stderr)
        return 1

    if args.only_bases.strip():
        bases = [b.strip().upper() for b in args.only_bases.split(",") if b.strip()]
        # garantiza que existan en la tabla
        for b in bases:
            by_base.setdefault(b, {})
    else:
        bases = bases_lighter[:]  # seed desde Lighter (lo que pediste)

    if args.limit > 0:
        bases = bases[:args.limit]

    # 2) Paradex para esas bases
    quotes = [q.strip().upper() for q in args.quotes.split(",") if q.strip()]
    sleep_s = max(0, args.sleep_ms)/1000.0
    with httpx.Client(timeout=12, headers={"User-Agent": "funding-triplet/1.1"}) as client:
        for base in bases:
            rate = fetch_paradex_latest_for_base(base, quotes, client, verbose=args.paradex_verbose)
            by_base.setdefault(base, {})
            if rate is not None:
                by_base[base]["Paradex"] = rate
            if sleep_s: time.sleep(sleep_s)

    # 3) Mostrar pivote
    if by_base:
        print_pivot(by_base)
    else:
        print("Sin datos que mostrar.")
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

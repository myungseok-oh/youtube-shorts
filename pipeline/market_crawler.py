"""시장 데이터 크롤러 — 코인 브리핑 등 채널 프롬프트에 시세 주입

collect_market_data() → 통합 시장 데이터 dict
format_market_context(data) → 프롬프트 주입용 마크다운 텍스트
"""
from __future__ import annotations

import json
import logging
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta

log = logging.getLogger(__name__)

KST = timezone(timedelta(hours=9))

# ---------- 개별 fetch 함수 ----------

def _parse_naver_index(data: dict) -> dict:
    """네이버 지수 API 공통 파싱"""
    return {
        "price": data.get("closePrice"),
        "change": data.get("compareToPreviousClosePrice"),
        "change_pct": data.get("fluctuationsRatio"),
        "time": data.get("localTradedAt"),
    }


def fetch_global_indices() -> dict:
    """네이버 해외지수 API — 다우/S&P500/나스닥"""
    result = {}
    symbols = {
        "dow": ".DJI",
        "sp500": ".INX",
        "nasdaq": ".IXIC",
    }
    for key, sym in symbols.items():
        try:
            url = f"https://api.stock.naver.com/index/{sym}/basic"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
            result[key] = _parse_naver_index(data)
        except Exception as e:
            log.warning("fetch_global_indices(%s) failed: %s", key, e)
            result[key] = {}
    return result


def fetch_kr_indices() -> dict:
    """네이버 국내지수 API — 코스피/코스닥 (m.stock 엔드포인트)"""
    result = {}
    symbols = {
        "kospi": "KOSPI",
        "kosdaq": "KOSDAQ",
    }
    for key, sym in symbols.items():
        try:
            url = f"https://m.stock.naver.com/api/index/{sym}/basic"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
            result[key] = _parse_naver_index(data)
        except Exception as e:
            log.warning("fetch_kr_indices(%s) failed: %s", key, e)
            result[key] = {}
    return result


def fetch_investor_trends() -> dict:
    """네이버 투자자별 매매동향 — 코스피/코스닥 (외국인/기관/개인 순매수)"""
    result = {}
    symbols = {
        "kospi": "KOSPI",
        "kosdaq": "KOSDAQ",
    }
    for key, sym in symbols.items():
        try:
            url = f"https://m.stock.naver.com/api/index/{sym}/trend"
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = json.loads(resp.read().decode())
            result[key] = {
                "personal": data.get("personalValue"),       # 개인 (억원)
                "foreign": data.get("foreignValue"),         # 외국인 (억원)
                "institutional": data.get("institutionalValue"),  # 기관 (억원)
                "date": data.get("bizdate"),
            }
        except Exception as e:
            log.warning("fetch_investor_trends(%s) failed: %s", key, e)
            result[key] = {}
    return result


def fetch_btc() -> dict:
    """CoinGecko API — BTC 시세 + 거래량"""
    try:
        url = ("https://api.coingecko.com/api/v3/simple/price"
               "?ids=bitcoin&vs_currencies=usd,krw"
               "&include_24hr_change=true&include_24hr_vol=true")
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        btc = data.get("bitcoin", {})
        now_kst = datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")
        return {
            "price_usd": btc.get("usd"),
            "price_krw": btc.get("krw"),
            "change_24h_pct": btc.get("usd_24h_change"),
            "volume_24h_usd": btc.get("usd_24h_vol"),
            "time": now_kst,
        }
    except Exception as e:
        log.warning("fetch_btc failed: %s", e)
        return {}


def fetch_fear_greed() -> dict:
    """alternative.me 공포탐욕지수 — 오늘 + 어제 (전일 대비 변화 계산)"""
    try:
        url = "https://api.alternative.me/fng/?limit=2"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        items = data.get("data", [])
        today = items[0] if len(items) > 0 else {}
        yesterday = items[1] if len(items) > 1 else {}
        result = {
            "value": today.get("value"),
            "label": today.get("value_classification"),
            "time": today.get("timestamp"),
        }
        if today.get("value") and yesterday.get("value"):
            try:
                diff = int(today["value"]) - int(yesterday["value"])
                result["prev_value"] = yesterday["value"]
                result["prev_label"] = yesterday.get("value_classification")
                result["change"] = diff
            except (ValueError, TypeError):
                pass
        return result
    except Exception as e:
        log.warning("fetch_fear_greed failed: %s", e)
        return {}


# ---------- 통합 ----------

# 소스 이름 → fetch 함수 매핑
_SOURCE_MAP = {
    "global_stocks": fetch_global_indices,
    "kr_stocks": fetch_kr_indices,
    "investor_trends": fetch_investor_trends,
    "crypto": fetch_btc,
    "fear_greed": fetch_fear_greed,
}


def collect_market_data(sources: list[str] | None = None) -> dict:
    """지정 소스들의 시장 데이터를 수집. 실패 시 해당 항목만 빈값."""
    if sources is None:
        sources = list(_SOURCE_MAP.keys())
    result = {}
    for src in sources:
        fn = _SOURCE_MAP.get(src)
        if fn:
            result[src] = fn()
        else:
            log.warning("Unknown market source: %s", src)
    return result


# ---------- 포맷팅 ----------

_LABEL_KO = {
    "Extreme Fear": "극단적 공포",
    "Fear": "공포",
    "Neutral": "중립",
    "Greed": "탐욕",
    "Extreme Greed": "극단적 탐욕",
}

_INDEX_NAMES = {
    "dow": "다우",
    "sp500": "S&P 500",
    "nasdaq": "나스닥",
    "kospi": "코스피",
    "kosdaq": "코스닥",
}


def _fmt_change(change, change_pct) -> str:
    """변동폭 + 등락률 포맷: -34.29 (-0.07%)"""
    parts = []
    if change is not None:
        parts.append(str(change))
    if change_pct is not None:
        try:
            pct = float(change_pct)
            sign = "+" if pct >= 0 else ""
            parts.append(f"{sign}{pct:.2f}%")
        except (ValueError, TypeError):
            parts.append(str(change_pct))
    return f" ({', '.join(parts)})" if parts else ""


def _fmt_price(val, sep: bool = True) -> str:
    """숫자를 천단위 콤마 포맷"""
    if val is None:
        return "N/A"
    try:
        num = float(str(val).replace(",", ""))
        if num == int(num) and num > 1000:
            return f"{int(num):,}"
        return f"{num:,.2f}"
    except (ValueError, TypeError):
        return str(val)


def _fmt_volume(val) -> str:
    """거래량을 읽기 좋은 단위로"""
    if val is None:
        return "N/A"
    try:
        num = float(val)
        if num >= 1e9:
            return f"${num / 1e9:.1f}B"
        if num >= 1e6:
            return f"${num / 1e6:.1f}M"
        return f"${num:,.0f}"
    except (ValueError, TypeError):
        return str(val)


def _fmt_investor(val) -> str:
    """투자자 순매수 포맷: +7,821억"""
    if val is None:
        return "N/A"
    s = str(val).strip()
    return f"{s}억"


def _market_time_label(market: str) -> str:
    """요일+시간(KST) 기반 시장 시점 표현 반환.

    market: "us" | "kr" | "crypto"

    US 증시 (월~금 23:30~06:00 KST, 서머타임 기준 변동):
      월/일        → "지난 금요일 마감"
      화~금        → "간밤 마감"
      토           → "어젯밤 마감"

    국내 증시 (월~금 09:00~15:30 KST):
      평일 09~15시  → "오늘 장중"  (장 열려 있음)
      평일 15시 이후 → "오늘 마감"
      평일 09시 이전 → "어제 마감" (화~금) / "지난 금요일 마감" (월)
      토/일          → "지난 금요일 마감"

    코인: 항상 "현재"
    """
    if market == "crypto":
        return "현재"
    now = datetime.now(KST)
    wd = now.weekday()  # 0=월 ~ 6=일
    hour = now.hour

    if market == "us":
        if wd in (0, 6):  # 월/일 → 금요일 데이터
            return "지난 금요일 마감"
        elif wd == 5:     # 토 → 어젯밤 금요일 장 마감
            return "어젯밤 마감"
        else:             # 화~금
            return "간밤 마감"
    else:  # kr
        if wd in (5, 6):  # 토/일 → 금요일 데이터
            return "지난 금요일 마감"
        elif wd == 0 and hour < 9:  # 월요일 장 전
            return "지난 금요일 마감"
        elif hour < 9:    # 화~금 장 전
            return "어제 마감"
        elif hour < 16:   # 평일 장중 (09~15:30, 여유 두고 16시까지)
            return "오늘 장중"
        else:             # 평일 장 마감 후
            return "오늘 마감"


def _is_market_closed(market: str) -> bool:
    """주말 휴장 여부 판단. market: 'us' | 'kr'"""
    now = datetime.now(KST)
    wd = now.weekday()  # 0=월 ~ 6=일
    if market == "us":
        # 토/일: 미국장 없음.  월요일: 간밤 미국장 없음 (일요일 밤)
        return wd in (0, 5, 6)
    else:  # kr
        return wd in (5, 6)


def format_market_context(data: dict) -> str:
    """수집 데이터 → 프롬프트 주입용 마크다운"""
    now_kst = datetime.now(KST).strftime("%Y-%m-%d %H:%M KST")
    lines = [f"## 오늘 시장 데이터 ({now_kst})", ""]

    us_label = _market_time_label("us")
    kr_label = _market_time_label("kr")
    us_closed = _is_market_closed("us")
    kr_closed = _is_market_closed("kr")

    # 글로벌 증시
    gl = data.get("global_stocks", {})
    if gl and any(gl.get(k) for k in ("dow", "sp500", "nasdaq")):
        lines.append(f"### 글로벌 증시 ({us_label})")
        if us_closed:
            lines.append(f"⚠️ 오늘은 미국 증시 휴장일입니다. 아래 수치는 지난 거래일 기준입니다.")
            lines.append(f"★ 나레이션에서 \"지난 거래일\" 또는 \"{us_label}\" 표현을 사용하고, 오늘/어제 장이 열린 것처럼 표현하지 말 것")
        else:
            lines.append(f"★ 나레이션에서 \"{us_label}\" 표현을 사용할 것")
        for key in ("dow", "sp500", "nasdaq"):
            info = gl.get(key, {})
            if info.get("price"):
                name = _INDEX_NAMES.get(key, key)
                price = _fmt_price(info["price"])
                chg = _fmt_change(info.get("change"), info.get("change_pct"))
                lines.append(f"- {name}: {price}{chg}")
        lines.append("")

    # 국내 증시
    kr = data.get("kr_stocks", {})
    if kr and any(kr.get(k) for k in ("kospi", "kosdaq")):
        lines.append(f"### 국내 증시 ({kr_label})")
        if kr_closed:
            lines.append(f"⚠️ 오늘은 국내 증시 휴장일입니다. 아래 수치는 지난 거래일 기준입니다.")
            lines.append(f"★ 나레이션에서 \"지난 거래일\" 또는 \"{kr_label}\" 표현을 사용하고, 오늘/어제 장이 열린 것처럼 표현하지 말 것")
        else:
            lines.append(f"★ 나레이션에서 \"{kr_label}\" 표현을 사용할 것")
        for key in ("kospi", "kosdaq"):
            info = kr.get(key, {})
            if info.get("price"):
                name = _INDEX_NAMES.get(key, key)
                price = _fmt_price(info["price"])
                chg = _fmt_change(info.get("change"), info.get("change_pct"))
                lines.append(f"- {name}: {price}{chg}")
        lines.append("")

    # 투자자별 매매동향
    inv = data.get("investor_trends", {})
    if inv:
        for key in ("kospi", "kosdaq"):
            info = inv.get(key, {})
            if info.get("personal") or info.get("foreign") or info.get("institutional"):
                name = _INDEX_NAMES.get(key, key)
                lines.append(f"#### {name} 투자자별 순매수 ({info.get('date', '')} 기준)")
                lines.append(f"- 개인: {_fmt_investor(info.get('personal'))}")
                lines.append(f"- 외국인: {_fmt_investor(info.get('foreign'))}")
                lines.append(f"- 기관: {_fmt_investor(info.get('institutional'))}")
                lines.append("")

    # 코인
    btc = data.get("crypto", {})
    if btc and btc.get("price_usd"):
        lines.append(f"### 코인 시장 ({_market_time_label('crypto')})")
        usd = _fmt_price(btc["price_usd"])
        krw = _fmt_price(btc.get("price_krw"))
        chg = ""
        if btc.get("change_24h_pct") is not None:
            try:
                pct = float(btc["change_24h_pct"])
                sign = "+" if pct >= 0 else ""
                chg = f" 전일대비 {sign}{pct:.1f}%"
            except (ValueError, TypeError):
                pass
        lines.append(f"- BTC: ${usd} (₩{krw}){chg}")
        vol = _fmt_volume(btc.get("volume_24h_usd"))
        lines.append(f"- 24시간 거래량: {vol}")
        lines.append("")

    # 공포탐욕지수
    fg = data.get("fear_greed", {})
    if fg and fg.get("value"):
        label_en = fg.get("label", "")
        label_ko = _LABEL_KO.get(label_en, label_en)
        fg_line = f"- 공포탐욕지수: {fg['value']} ({label_ko})"
        if fg.get("change") is not None:
            diff = fg["change"]
            sign = "+" if diff >= 0 else ""
            prev_label = _LABEL_KO.get(fg.get("prev_label", ""), fg.get("prev_label", ""))
            fg_line += f" | 전일 {fg['prev_value']}({prev_label})에서 {sign}{diff}"
        lines.append(fg_line)
        lines.append("")

    lines.append("⚠️ 위 시장 데이터는 실시간 크롤링된 정확한 수치입니다.")
    lines.append("- 위 수치를 대본에 그대로 사용할 것 (WebSearch로 별도 시세 검색 금지)")
    lines.append("- ★ 각 섹션의 시점 표현(간밤/어제/지난 금요일/현재)을 나레이션에 반드시 반영할 것")
    lines.append("- 위에 없는 추가 정보(핫 코인, 특이 이벤트, 원인 분석 등)만 WebSearch로 보충")
    return "\n".join(lines)

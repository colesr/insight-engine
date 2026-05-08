"""
Insight Engine - FastAPI Backend
Handles API proxying, dataset operations, caching, and static file serving.
"""
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
import requests
import aiohttp
import asyncio
import json
import os
import time
import hashlib
from typing import List, Dict, Optional, Any
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta
import pandas as pd
import numpy as np

app = FastAPI(title="Insight Engine API", version="5.0")

# CORS - allow all origins for now (HF Spaces handles auth)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# In-memory cache with TTL
_cache: Dict[str, tuple] = {}  # key -> (value, expires_at)
CACHE_TTL = 3600  # 1 hour

def _cache_get(key: str) -> Any:
    if key in _cache:
        value, expires = _cache[key]
        if time.time() < expires:
            return value
        del _cache[key]
    return None

def _cache_set(key: str, value: Any, ttl: int = CACHE_TTL):
    _cache[key] = (value, time.time() + ttl)

# --- DATASET STORAGE ---
# Users can upload datasets via POST /api/dataset/upload
# Each dataset gets a unique ID and is stored in memory
_loaded_datasets: Dict[str, Dict[str, Any]] = {}

def _make_id() -> str:
    return hashlib.sha256(str(time.time()).encode()).hexdigest()[:12]

# Root: serve the frontend app
@app.get("/")
def serve_index():
    with open("static/index.html", "r") as f:
        return f.read()

# Root health endpoint
@app.get("/api/health")
def health():
    return {"status": "ok", "datasets_loaded": len(_loaded_datasets), "cache_entries": len(_cache)}

# Static files — serve at /static/ for JS, CSS, images
app.mount("/static", StaticFiles(directory="static"), name="static")

# ============================================================================
# WORLD BANK API
# ============================================================================

WORLD_BANK_BASE = "https://api.worldbank.org/v2"

WORLDBANK_INDICATORS = {
    "gdp_current": "NY.GDP.MKTP.CD",
    "gdp_per_capita": "NY.GDP.PCAP.CD",
    "gdp_growth": "NY.GDP.MKTP.KD.ZG",
    "population": "SP.POP.TOTL",
    "life_expectancy": "SP.DYN.LE00.IN",
    "primary_enrollment": "SE.PRM.ENRR",
    "tertiary_enrollment": "SE.TER.ENRR",
    "electricity_access": "EG.ELC.ACCS.ZS",
    "internet_users": "IT.NET.USER.ZS",
    "co2_per_capita": "EN.ATM.CO2E.PC",
    "renewable_energy": "EG.FEC.RNEW.ZS",
    "gini": "SI.POV.GINI",
    "unemployment": "SL.UEM.TOTL.ZS",
    "health_exp_per_capita": "SH.XPD.CHEX.PC.CD",
    "infant_mortality": "SP.DYN.IMRT.IN",
    "sanitation": "SH.STA.SMSS.ZS",
    "agriculture_employment": "SL.AGR.EMPL.ZS",
    "industry_value_added": "NV.IND.TOTL.ZS",
    "fdi_inflows": "BX.KLT.DINV.WD.GD.ZS",
    "gov_debt": "GC.DOD.TOTL.GD.ZS",
    "population_density": "EN.POP.DNST",
    "forest_cover": "AG.LND.FRST.ZS",
    "freshwater_withdrawal": "ER.H2O.FWTL.ZS",
    "methane_emissions": "EN.ATM.METH.AG.KT.CE",
    "nox_emissions": "EN.ATM.NOXE.AG.KT.CE",
}

COUNTRY_NAME_MAP = {
    "United States of America": "United States",
    "Russian Federation": "Russia",
    "Korea, Rep.": "South Korea",
    "Korea, Dem. People's Rep.": "North Korea",
    "Iran, Islamic Rep.": "Iran",
    "Egypt, Arab Rep.": "Egypt",
    "Yemen, Rep.": "Yemen",
    "Venezuela, RB": "Venezuela",
    "Syrian Arab Republic": "Syria",
    "Lao PDR": "Laos",
    "Kyrgyz Republic": "Kyrgyzstan",
    "Czechia": "Czech Republic",
    "Slovak Republic": "Slovakia",
    "Bahamas, The": "Bahamas",
    "Gambia, The": "Gambia",
    "Congo, Dem. Rep.": "Democratic Republic of Congo",
    "Congo, Rep.": "Congo",
    "Brunei Darussalam": "Brunei",
    "Cabo Verde": "Cape Verde",
    "Timor-Leste": "Timor Leste",
    "Guinea-Bissau": "Guinea Bissau",
    "Micronesia, Fed. Sts.": "Micronesia",
    "North Macedonia": "Macedonia",
    "Eswatini": "Swaziland",
    "Türkiye": "Turkey",
    "Cote d'Ivoire": "Ivory Coast",
    "Hong Kong SAR, China": "Hong Kong",
    "Macao SAR, China": "Macao",
    "West Bank and Gaza": "Palestine",
    "British Virgin Islands": "Virgin Islands",
    "Tanzania": "Tanzania",
}

def normalize_country(name: str) -> Optional[str]:
    if not name:
        return None
    name = name.strip()
    return COUNTRY_NAME_MAP.get(name, name)

@app.get("/api/worldbank/indicators")
def list_worldbank_indicators():
    """List all available World Bank indicators with metadata."""
    result = []
    for key, wb_code in WORLDBANK_INDICATORS.items():
        result.append({
            "id": key,
            "wb_code": wb_code,
            "name": key.replace("_", " ").title(),
            "source": "World Bank",
            "category": _guess_category(key),
        })
    return {"indicators": result, "count": len(result)}

def _guess_category(key: str) -> str:
    if any(x in key for x in ["gdp", "unemployment", "fdi", "industry", "agriculture", "gov_debt"]):
        return "Economy"
    if any(x in key for x in ["life", "health", "mortality", "sanitation"]):
        return "Health"
    if any(x in key for x in ["enrollment", "education"]):
        return "Education"
    if any(x in key for x in ["electricity", "internet"]):
        return "Infrastructure"
    if any(x in key for x in ["co2", "renewable", "forest", "freshwater", "methane", "nox", "emissions"]):
        return "Environment"
    if any(x in key for x in ["population", "gini"]):
        return "Social"
    return "General"

@app.get("/api/worldbank/fetch")
def fetch_worldbank(
    indicators: str = Query(..., description="Comma-separated indicator IDs (e.g., gdp_per_capita,life_expectancy)"),
    countries: str = Query("all", description="Comma-separated country codes or 'all'"),
    date_range: str = Query("2020:2023", description="Date range like 2020:2023"),
    latest_only: bool = Query(True, description="Only return latest year per country"),
):
    """Fetch World Bank data for specified indicators. Returns normalized dataset."""
    cache_key = f"wb:{indicators}:{countries}:{date_range}:{latest_only}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    ind_list = [i.strip() for i in indicators.split(",")]
    records = {}

    for ind_id in ind_list:
        wb_code = WORLDBANK_INDICATORS.get(ind_id)
        if not wb_code:
            continue
        # Fetch all pages for this indicator
        page = 1
        all_wb_data = []
        while True:
            paged_url = f"{WORLD_BANK_BASE}/country/{countries}/indicator/{wb_code}"
            try:
                r = requests.get(paged_url, params={
                    "format": "json", "per_page": 300, "date": date_range, "page": page
                }, timeout=30)
                paged_data = r.json()
                if len(paged_data) < 2 or not paged_data[1]:
                    break
                all_wb_data.extend(paged_data[1])
                meta = paged_data[0]
                if meta.get("page", 1) >= meta.get("pages", 1):
                    break
                page += 1
            except Exception as e:
                print(f"WB page fetch error for {ind_id} page {page}: {e}")
                break

        # Known World Bank aggregate/region codes (not real countries)
        # Observed from actual API: 1A,1W,4E,7E,8S,B8,F1,OE,EU, ZH,ZI,ZG,ZF,Z4,Z7,ZJ,ZQ,ZT, S1-S4, T2-T7, V1-V4, XC-XT,XY, and long 3-char region codes
        WB_AGGREGATE_CODES = {
            "1A","1W","4E","7E","8S","B8","F1","OE","EU",
            "ZH","ZI","ZG","ZF","Z4","Z7","ZJ","ZQ","ZT",
            "S1","S2","S3","S4","T2","T3","T4","T5","T6","T7",
            "V1","V2","V3","V4",
            "XC","XD","XE","XF","XG","XH","XI","XJ","XL","XM","XN","XO","XP","XQ","XT","XU","XY",
            "AFE","AFW","ARB","CSS","CEB","EAP","EAR","EAS","ECA","ECS",
            "EUU","FCS","HPC","IBD","IBT","IDA","IDB","IDX","INX",
            "LAC","LCN","LDC","LIC","LMC","LMY","LTE","MEA","MIC","MNA",
            "NAC","OED","OSS","PSS","PRE","PST","SAS","SSA","SSF","SST",
            "TEA","TEC","TLA","TMN","TSA","TSS","WLD"
        }
        # Common aggregate name patterns
        AGGREGATE_NAME_PATTERNS = ["(excluding", "income levels)", "all income", "small states", "demographic dividend", "World", "Arab World", "European Union"]
        for item in all_wb_data:
            country_info = item.get("country", {})
            country_id = country_info.get("id", "")
            country_raw = country_info.get("value", "")
            country = normalize_country(country_raw)
            value = item.get("value")
            year = item.get("date")
            if not country or value is None:
                continue
            # Skip known aggregate codes AND all single/double-letter codes (they're all aggregates)
            if country_id in WB_AGGREGATE_CODES:
                continue
            # Also skip if name contains aggregate patterns
            if any(p in country_raw for p in AGGREGATE_NAME_PATTERNS):
                continue
            if country not in records:
                records[country] = {"country": country}
            # Keep the latest year for each indicator
            current = records[country].get(ind_id)
            if current is None or (year and year > current.get("_year", "0")):
                records[country][ind_id] = round(float(value), 3)
                records[country]["_year_" + ind_id] = year
        time.sleep(0.15)  # Rate limit

    # Clean up internal year fields
    result_records = []
    for rec in records.values():
        clean = {k: v for k, v in rec.items() if not k.startswith("_")}
        if len(clean) > 1:  # At least country + one indicator
            result_records.append(clean)

    result = {
        "source": "World Bank",
        "record_count": len(result_records),
        "indicators_fetched": len(ind_list),
        "data": result_records,
    }
    _cache_set(cache_key, result)
    return result

# ============================================================================
# REST COUNTRIES API
# ============================================================================

@app.get("/api/countries/list")
def fetch_countries_list():
    """Fetch basic country data (population, area, region, etc.)"""
    cache_key = "restcountries"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    try:
        url = "https://restcountries.com/v3.1/all?fields=name,population,area,region,subregion,flags,capital,cca3,landlocked,independent,unMember"
        r = requests.get(url, timeout=30)
        data = r.json()
        records = []
        for item in data:
            country = normalize_country(item.get("name", {}).get("common"))
            if not country:
                continue
            rec = {
                "country": country,
                "population": item.get("population"),
                "area_km2": item.get("area"),
                "region": item.get("region"),
                "subregion": item.get("subregion"),
                "landlocked": 1 if item.get("landlocked") else 0,
                "independent": 1 if item.get("independent") else 0,
                "un_member": 1 if item.get("unMember") else 0,
                "num_borders": len(item.get("borders", [])),
                "cca3": item.get("cca3"),
                "flag_url": item.get("flags", {}).get("png", ""),
            }
            records.append(rec)
        result = {"source": "REST Countries", "record_count": len(records), "data": records}
        _cache_set(cache_key, result)
        return result
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))

# ============================================================================
# OPEN-METEO CLIMATE API
# ============================================================================

CAPITALS = {
    "United States": (38.9072, -77.0369),
    "China": (39.9042, 116.4074),
    "India": (28.6139, 77.2090),
    "Brazil": (-15.7975, -47.8919),
    "Russia": (55.7558, 37.6173),
    "Japan": (35.6762, 139.6503),
    "Germany": (52.5200, 13.4050),
    "United Kingdom": (51.5074, -0.1278),
    "France": (48.8566, 2.3522),
    "Italy": (41.9028, 12.4964),
    "Canada": (45.4215, -75.6972),
    "Australia": (-35.2809, 149.1300),
    "South Korea": (37.5665, 126.9780),
    "Spain": (40.4168, -3.7038),
    "Mexico": (19.4326, -99.1332),
    "Indonesia": (-6.2088, 106.8456),
    "Turkey": (39.9334, 32.8597),
    "Saudi Arabia": (24.7136, 46.6753),
    "South Africa": (-25.7479, 28.2293),
    "Egypt": (30.0444, 31.2357),
    "Argentina": (-34.6037, -58.3816),
    "Nigeria": (9.0820, 7.3983),
    "Pakistan": (33.6844, 73.0479),
    "Bangladesh": (23.8103, 90.4125),
    "Vietnam": (21.0278, 105.8342),
    "Philippines": (14.5995, 120.9842),
    "Ethiopia": (9.0084, 38.7575),
    "Iran": (35.6892, 51.3890),
    "Thailand": (13.7563, 100.5018),
    "Poland": (52.2297, 21.0122),
    "Ukraine": (50.4501, 30.5234),
    "Colombia": (4.7110, -74.0721),
    "Malaysia": (3.1390, 101.6869),
    "Morocco": (34.0209, -6.8416),
    "Peru": (-12.0464, -77.0428),
    "Czech Republic": (50.0755, 14.4378),
    "Netherlands": (52.3676, 4.9041),
    "Belgium": (50.8503, 4.3517),
    "Sweden": (59.3293, 18.0686),
    "Chile": (-33.4489, -70.6693),
    "Portugal": (38.7223, -9.1393),
    "Austria": (48.2082, 16.3738),
    "Switzerland": (46.9480, 7.4474),
    "Israel": (31.7683, 35.2137),
    "Singapore": (1.3521, 103.8198),
    "Denmark": (55.6761, 12.5683),
    "Finland": (60.1699, 24.9384),
    "Norway": (59.9139, 10.7522),
    "Ireland": (53.3498, -6.2603),
    "New Zealand": (-41.2865, 174.7762),
    "Chad": (12.1348, 15.0557),
    "Mali": (12.6392, -8.0029),
    "Niger": (13.5116, 2.1254),
    "Burkina Faso": (12.3714, -1.5197),
    "Madagascar": (-18.8792, 47.5079),
    "Malawi": (-13.9626, 33.7741),
    "Rwanda": (-1.9441, 30.0619),
    "Haiti": (18.5944, -72.3074),
    "Nepal": (27.7172, 85.3240),
    "Myanmar": (19.7633, 96.0785),
    "Cambodia": (11.5564, 104.9282),
    "Laos": (17.9757, 102.6331),
    "Mongolia": (47.8864, 106.9057),
    "Bolivia": (-17.7833, -63.1821),
    "Ecuador": (-0.1807, -78.4678),
    "Guatemala": (14.6349, -90.5069),
    "Honduras": (14.0723, -87.2021),
    "Nicaragua": (12.1364, -86.2514),
    "Paraguay": (-25.2637, -57.5759),
    "Senegal": (14.7167, -17.4677),
    "Ghana": (5.6037, -0.1870),
    "Kenya": (-1.2921, 36.8219),
    "Uganda": (0.3476, 32.5825),
    "Tanzania": (-6.1630, 35.7516),
    "Zambia": (-15.3875, 28.3228),
    "Zimbabwe": (-17.8252, 31.0335),
    "Algeria": (36.7538, 3.0588),
    "Angola": (-8.8390, 13.2894),
    "Cameroon": (3.8480, 11.5021),
    "Congo": (-4.4419, 15.2663),
    "Ivory Coast": (6.8276, -5.2893),
    "Gabon": (0.4162, 9.4673),
    "Guinea": (9.6412, -13.5784),
    "Liberia": (6.2907, -10.7605),
    "Libya": (32.8872, 13.1913),
    "Mozambique": (-25.9692, 32.5732),
    "Sierra Leone": (8.4657, -13.2317),
    "Somalia": (2.0469, 45.3182),
    "Sudan": (15.5007, 32.5599),
    "Togo": (6.1256, 1.2254),
    "Democratic Republic of Congo": (-4.3250, 15.3222),
    "Central African Republic": (4.3947, 18.5582),
    "Equatorial Guinea": (1.6508, 10.2679),
    "Eritrea": (15.3229, 38.9251),
    "Lesotho": (-29.6100, 28.2336),
    "Botswana": (-24.6282, 25.9231),
    "Namibia": (-22.5609, 17.0658),
    "Swaziland": (-26.3054, 31.1367),
    "Mauritania": (18.0735, -15.9582),
    "Western Sahara": (27.1536, -13.2033),
    "Djibouti": (11.5721, 43.1456),
    "Comoros": (-11.6455, 43.3333),
    "Cape Verde": (14.9330, -23.5133),
    "Sao Tome and Principe": (0.1864, 6.6131),
    "Seychelles": (-4.6796, 55.4920),
    "Mauritius": (-20.1619, 57.4989),
    "Maldives": (4.1755, 73.5093),
    "Bhutan": (27.4728, 89.6390),
    "Brunei": (4.5353, 114.7277),
    "Timor Leste": (-8.5569, 125.5603),
    "Papua New Guinea": (-9.4438, 147.1803),
    "Solomon Islands": (-9.4456, 159.9729),
    "Vanuatu": (-17.7333, 168.3273),
    "Fiji": (-18.1248, 178.4501),
    "Samoa": (-13.7590, -172.1046),
    "Tonga": (-21.1394, -175.2018),
    "Kiribati": (1.8709, -157.3630),
    "Tuvalu": (-8.6319, 179.1583),
    "Nauru": (-0.5477, 166.9209),
    "Palau": (7.5000, 134.6243),
    "Marshall Islands": (7.0897, 171.3803),
    "Micronesia": (6.9240, 158.1618),
    "Guyana": (6.8013, -58.1551),
    "Suriname": (5.8520, -55.2038),
    "Belize": (17.1899, -88.4976),
    "Barbados": (13.1939, -59.5432),
    "Trinidad and Tobago": (10.6918, -61.2225),
    "Jamaica": (18.0179, -76.8099),
    "Bahamas": (25.0343, -77.3963),
    "Cuba": (23.1136, -82.3666),
    "Dominican Republic": (18.4861, -69.9312),
    "Puerto Rico": (18.2208, -66.5901),
    "Grenada": (12.1165, -61.6790),
    "Saint Vincent and the Grenadines": (13.1600, -61.2248),
    "Saint Lucia": (13.9094, -60.9789),
    "Dominica": (15.4150, -61.3710),
    "Antigua and Barbuda": (17.1274, -61.8468),
    "Saint Kitts and Nevis": (17.3578, -62.7820),
    "Armenia": (40.1792, 44.4991),
    "Azerbaijan": (40.4093, 49.8671),
    "Georgia": (41.7151, 44.8271),
    "Kazakhstan": (51.1605, 71.4704),
    "Kyrgyzstan": (42.8746, 74.5698),
    "Tajikistan": (38.5598, 68.7870),
    "Turkmenistan": (37.9601, 58.3261),
    "Uzbekistan": (41.2995, 69.2401),
    "Afghanistan": (34.5553, 69.2075),
    "Iraq": (33.3152, 44.3661),
    "Jordan": (31.9454, 35.9284),
    "Lebanon": (33.8938, 35.5018),
    "Palestine": (31.8980, 35.2042),
    "Syria": (33.5138, 36.2765),
    "Yemen": (15.3694, 44.1910),
    "Oman": (23.5880, 58.3829),
    "Qatar": (25.2854, 51.5310),
    "Kuwait": (29.3759, 47.9774),
    "Bahrain": (26.0667, 50.5577),
    "United Arab Emirates": (24.4539, 54.3773),
    "Sri Lanka": (6.9271, 79.8612),
    "Bangladesh": (23.8103, 90.4125),
    "Pakistan": (33.6844, 73.0479),
    "Nepal": (27.7172, 85.3240),
    "India": (28.6139, 77.2090),
    "Bhutan": (27.4728, 89.6390),
    "Maldives": (4.1755, 73.5093),
    "Thailand": (13.7563, 100.5018),
    "Vietnam": (21.0278, 105.8342),
    "Laos": (17.9757, 102.6331),
    "Cambodia": (11.5564, 104.9282),
    "Myanmar": (19.7633, 96.0785),
    "Malaysia": (3.1390, 101.6869),
    "Singapore": (1.3521, 103.8198),
    "Indonesia": (-6.2088, 106.8456),
    "Philippines": (14.5995, 120.9842),
    "Taiwan": (25.0330, 121.5654),
    "North Korea": (39.0392, 125.7625),
    "South Korea": (37.5665, 126.9780),
    "Japan": (35.6762, 139.6503),
    "Mongolia": (47.8864, 106.9057),
    "China": (39.9042, 116.4074),
    "Hong Kong": (22.3193, 114.1694),
    "Macao": (22.1987, 113.5439),
    "Australia": (-35.2809, 149.1300),
    "New Zealand": (-41.2865, 174.7762),
    "Papua New Guinea": (-9.4438, 147.1803),
    "Fiji": (-18.1248, 178.4501),
    "Solomon Islands": (-9.4456, 159.9729),
    "Vanuatu": (-17.7333, 168.3273),
    "Samoa": (-13.7590, -172.1046),
    "Tonga": (-21.1394, -175.2018),
    "Kiribati": (1.8709, -157.3630),
    "Tuvalu": (-8.6319, 179.1583),
    "Nauru": (-0.5477, 166.9209),
    "Palau": (7.5000, 134.6243),
    "Marshall Islands": (7.0897, 171.3803),
    "Micronesia": (6.9240, 158.1618),
    "United States": (38.9072, -77.0369),
    "Canada": (45.4215, -75.6972),
    "Mexico": (19.4326, -99.1332),
    "Guatemala": (14.6349, -90.5069),
    "Belize": (17.1899, -88.4976),
    "El Salvador": (13.6929, -89.2182),
    "Honduras": (14.0723, -87.2021),
    "Nicaragua": (12.1364, -86.2514),
    "Costa Rica": (9.7489, -83.7534),
    "Panama": (8.9824, -79.5199),
    "Colombia": (4.7110, -74.0721),
    "Venezuela": (10.4806, -66.9036),
    "Ecuador": (-0.1807, -78.4678),
    "Peru": (-12.0464, -77.0428),
    "Bolivia": (-17.7833, -63.1821),
    "Brazil": (-15.7975, -47.8919),
    "Chile": (-33.4489, -70.6693),
    "Argentina": (-34.6037, -58.3816),
    "Uruguay": (-34.9011, -56.1645),
    "Paraguay": (-25.2637, -57.5759),
    "Guyana": (6.8013, -58.1551),
    "Suriname": (5.8520, -55.2038),
    "French Guiana": (4.9333, -52.3306),
    "Germany": (52.5200, 13.4050),
    "United Kingdom": (51.5074, -0.1278),
    "France": (48.8566, 2.3522),
    "Italy": (41.9028, 12.4964),
    "Spain": (40.4168, -3.7038),
    "Portugal": (38.7223, -9.1393),
    "Netherlands": (52.3676, 4.9041),
    "Belgium": (50.8503, 4.3517),
    "Luxembourg": (49.6116, 6.1319),
    "Switzerland": (46.9480, 7.4474),
    "Austria": (48.2082, 16.3738),
    "Liechtenstein": (47.1410, 9.5209),
    "Denmark": (55.6761, 12.5683),
    "Sweden": (59.3293, 18.0686),
    "Norway": (59.9139, 10.7522),
    "Finland": (60.1699, 24.9384),
    "Iceland": (64.1466, -21.9426),
    "Ireland": (53.3498, -6.2603),
    "Poland": (52.2297, 21.0122),
    "Czech Republic": (50.0755, 14.4378),
    "Slovakia": (48.1486, 17.1077),
    "Hungary": (47.4979, 19.0402),
    "Slovenia": (46.0569, 14.5058),
    "Croatia": (45.8150, 15.9819),
    "Bosnia and Herzegovina": (43.8563, 18.4131),
    "Serbia": (44.7866, 20.4489),
    "Montenegro": (42.4304, 19.2594),
    "North Macedonia": (41.9981, 21.4254),
    "Albania": (41.3275, 19.8187),
    "Greece": (37.9838, 23.7275),
    "Bulgaria": (42.6977, 23.3219),
    "Romania": (44.4268, 26.1025),
    "Moldova": (47.0105, 28.8638),
    "Ukraine": (50.4501, 30.5234),
    "Belarus": (53.9045, 27.5615),
    "Lithuania": (54.6872, 25.2797),
    "Latvia": (56.9496, 24.1052),
    "Estonia": (59.4370, 24.7536),
    "Russia": (55.7558, 37.6173),
    "Turkey": (39.9334, 32.8597),
    "Cyprus": (35.1856, 33.3823),
    "Malta": (35.8989, 14.5146),
    "Andorra": (42.5063, 1.5218),
    "Monaco": (43.7384, 7.4246),
    "San Marino": (43.9424, 12.4578),
    "Vatican City": (41.9029, 12.4534),
    "Kosovo": (42.6026, 20.9030),
    "South Africa": (-25.7479, 28.2293),
    "Egypt": (30.0444, 31.2357),
    "Morocco": (34.0209, -6.8416),
    "Algeria": (36.7538, 3.0588),
    "Tunisia": (36.8065, 10.1815),
    "Libya": (32.8872, 13.1913),
    "Sudan": (15.5007, 32.5599),
    "Mauritania": (18.0735, -15.9582),
    "Mali": (12.6392, -8.0029),
    "Niger": (13.5116, 2.1254),
    "Chad": (12.1348, 15.0557),
    "Burkina Faso": (12.3714, -1.5197),
    "Senegal": (14.7167, -17.4677),
    "Gambia": (13.4432, -15.3101),
    "Guinea Bissau": (11.8632, -15.5843),
    "Guinea": (9.6412, -13.5784),
    "Sierra Leone": (8.4657, -13.2317),
    "Liberia": (6.2907, -10.7605),
    "Ivory Coast": (6.8276, -5.2893),
    "Ghana": (5.6037, -0.1870),
    "Togo": (6.1256, 1.2254),
    "Benin": (6.4969, 2.6283),
    "Nigeria": (9.0820, 7.3983),
    "Cameroon": (3.8480, 11.5021),
    "Central African Republic": (4.3947, 18.5582),
    "Equatorial Guinea": (1.6508, 10.2679),
    "Gabon": (0.4162, 9.4673),
    "Democratic Republic of Congo": (-4.3250, 15.3222),
    "Republic of Congo": (-4.2634, 15.2429),
    "Angola": (-8.8390, 13.2894),
    "Zambia": (-15.3875, 28.3228),
    "Zimbabwe": (-17.8252, 31.0335),
    "Malawi": (-13.9626, 33.7741),
    "Mozambique": (-25.9692, 32.5732),
    "Botswana": (-24.6282, 25.9231),
    "Namibia": (-22.5609, 17.0658),
    "South Africa": (-25.7479, 28.2293),
    "Lesotho": (-29.6100, 28.2336),
    "Eswatini": (-26.3054, 31.1367),
    "Madagascar": (-18.8792, 47.5079),
    "Comoros": (-11.6455, 43.3333),
    "Seychelles": (-4.6796, 55.4920),
    "Mauritius": (-20.1619, 57.4989),
    "Djibouti": (11.5721, 43.1456),
    "Eritrea": (15.3229, 38.9251),
    "Ethiopia": (9.0084, 38.7575),
    "Somalia": (2.0469, 45.3182),
    "Kenya": (-1.2921, 36.8219),
    "Uganda": (0.3476, 32.5825),
    "Tanzania": (-6.1630, 35.7516),
    "Rwanda": (-1.9441, 30.0619),
    "Burundi": (-3.3614, 29.3599),
    "South Sudan": (4.8594, 31.5713),
    "Saudi Arabia": (24.7136, 46.6753),
    "Iran": (35.6892, 51.3890),
    "Iraq": (33.3152, 44.3661),
    "Jordan": (31.9454, 35.9284),
    "Lebanon": (33.8938, 35.5018),
    "Syria": (33.5138, 36.2765),
    "Yemen": (15.3694, 44.1910),
    "Oman": (23.5880, 58.3829),
    "Qatar": (25.2854, 51.5310),
    "Kuwait": (29.3759, 47.9774),
    "Bahrain": (26.0667, 50.5577),
    "United Arab Emirates": (24.4539, 54.3773),
    "Israel": (31.7683, 35.2137),
    "Palestine": (31.8980, 35.2042),
    "Azerbaijan": (40.4093, 49.8671),
    "Armenia": (40.1792, 44.4991),
    "Georgia": (41.7151, 44.8271),
    "Kazakhstan": (51.1605, 71.4704),
    "Kyrgyzstan": (42.8746, 74.5698),
    "Tajikistan": (38.5598, 68.7870),
    "Turkmenistan": (37.9601, 58.3261),
    "Uzbekistan": (41.2995, 69.2401),
    "Afghanistan": (34.5553, 69.2075),
    "Pakistan": (33.6844, 73.0479),
    "India": (28.6139, 77.2090),
    "Nepal": (27.7172, 85.3240),
    "Bhutan": (27.4728, 89.6390),
    "Bangladesh": (23.8103, 90.4125),
    "Sri Lanka": (6.9271, 79.8612),
    "Maldives": (4.1755, 73.5093),
    "Myanmar": (19.7633, 96.0785),
    "Thailand": (13.7563, 100.5018),
    "Laos": (17.9757, 102.6331),
    "Cambodia": (11.5564, 104.9282),
    "Vietnam": (21.0278, 105.8342),
    "Malaysia": (3.1390, 101.6869),
    "Singapore": (1.3521, 103.8198),
    "Indonesia": (-6.2088, 106.8456),
    "Philippines": (14.5995, 120.9842),
    "Brunei": (4.5353, 114.7277),
    "Timor Leste": (-8.5569, 125.5603),
    "China": (39.9042, 116.4074),
    "Japan": (35.6762, 139.6503),
    "South Korea": (37.5665, 126.9780),
    "North Korea": (39.0392, 125.7625),
    "Mongolia": (47.8864, 106.9057),
    "Taiwan": (25.0330, 121.5654),
    "Hong Kong": (22.3193, 114.1694),
    "Macao": (22.1987, 113.5439),
    "Australia": (-35.2809, 149.1300),
    "New Zealand": (-41.2865, 174.7762),
    "Papua New Guinea": (-9.4438, 147.1803),
    "Fiji": (-18.1248, 178.4501),
    "Solomon Islands": (-9.4456, 159.9729),
    "Vanuatu": (-17.7333, 168.3273),
    "Samoa": (-13.7590, -172.1046),
    "Tonga": (-21.1394, -175.2018),
    "Kiribati": (1.8709, -157.3630),
    "Tuvalu": (-8.6319, 179.1583),
    "Nauru": (-0.5477, 166.9209),
    "Palau": (7.5000, 134.6243),
    "Marshall Islands": (7.0897, 171.3803),
    "Micronesia": (6.9240, 158.1618),
    "United States": (38.9072, -77.0369),
    "Canada": (45.4215, -75.6972),
    "Mexico": (19.4326, -99.1332),
    "Guatemala": (14.6349, -90.5069),
    "Belize": (17.1899, -88.4976),
    "El Salvador": (13.6929, -89.2182),
    "Honduras": (14.0723, -87.2021),
    "Nicaragua": (12.1364, -86.2514),
    "Costa Rica": (9.7489, -83.7534),
    "Panama": (8.9824, -79.5199),
    "Cuba": (23.1136, -82.3666),
    "Jamaica": (18.0179, -76.8099),
    "Haiti": (18.5944, -72.3074),
    "Dominican Republic": (18.4861, -69.9312),
    "Puerto Rico": (18.2208, -66.5901),
    "Bahamas": (25.0343, -77.3963),
    "Barbados": (13.1939, -59.5432),
    "Trinidad and Tobago": (10.6918, -61.2225),
    "Grenada": (12.1165, -61.6790),
    "Saint Vincent and the Grenadines": (13.1600, -61.2248),
    "Saint Lucia": (13.9094, -60.9789),
    "Dominica": (15.4150, -61.3710),
    "Antigua and Barbuda": (17.1274, -61.8468),
    "Saint Kitts and Nevis": (17.3578, -62.7820),
    "Virgin Islands": (18.3358, -64.8963),
    "Bermuda": (32.2949, -64.7820),
    "Greenland": (64.1814, -51.6941),
    "Colombia": (4.7110, -74.0721),
    "Venezuela": (10.4806, -66.9036),
    "Ecuador": (-0.1807, -78.4678),
    "Peru": (-12.0464, -77.0428),
    "Bolivia": (-17.7833, -63.1821),
    "Chile": (-33.4489, -70.6693),
    "Argentina": (-34.6037, -58.3816),
    "Uruguay": (-34.9011, -56.1645),
    "Paraguay": (-25.2637, -57.5759),
    "Guyana": (6.8013, -58.1551),
    "Suriname": (5.8520, -55.2038),
    "French Guiana": (4.9333, -52.3306),
    "Falkland Islands": (-51.7963, -59.5236),
}

@app.get("/api/climate/fetch")
def fetch_climate(countries: str = Query("all", description="Comma-separated country names or 'all'")):
    """Fetch climate data (temperature, precipitation) for capital cities."""
    cache_key = f"climate:{countries}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    target_countries = list(CAPITALS.keys()) if countries == "all" else [c.strip() for c in countries.split(",")]
    records = []

    for country in target_countries:
        if country not in CAPITALS:
            continue
        lat, lon = CAPITALS[country]
        url = "https://archive-api.open-meteo.com/v1/archive"
        params = {
            "latitude": lat, "longitude": lon,
            "start_date": "2020-01-01", "end_date": "2023-12-31",
            "daily": "temperature_2m_mean,precipitation_sum",
            "timezone": "auto"
        }
        try:
            r = requests.get(url, params=params, timeout=15)
            data = r.json()
            daily = data.get("daily", {})
            temps = daily.get("temperature_2m_mean", [])
            precip = daily.get("precipitation_sum", [])
            if temps and precip:
                valid_temps = [t for t in temps if t is not None]
                valid_precip = [p for p in precip if p is not None]
                records.append({
                    "country": country,
                    "avg_temp_c": round(sum(valid_temps) / len(valid_temps), 2) if valid_temps else None,
                    "total_precip_mm": round(sum(valid_precip), 2) if valid_precip else None,
                    "max_temp_c": round(max(valid_temps), 2) if valid_temps else None,
                    "min_temp_c": round(min(valid_temps), 2) if valid_temps else None,
                })
        except Exception as e:
            print(f"Climate fetch error for {country}: {e}")
        time.sleep(0.1)

    result = {"source": "Open-Meteo", "record_count": len(records), "data": records}
    _cache_set(cache_key, result)
    return result

# ============================================================================
# DATASET MANAGEMENT
# ============================================================================

@app.post("/api/dataset/upload")
def upload_dataset(data: dict = Body(...)):
    """Upload a custom dataset. Returns a dataset ID."""
    ds_id = _make_id()
    records = data.get("records", [])
    indicators = data.get("indicators", [])
    _loaded_datasets[ds_id] = {
        "id": ds_id,
        "name": data.get("name", f"Custom Dataset {ds_id[:6]}"),
        "uploaded_at": datetime.utcnow().isoformat(),
        "record_count": len(records),
        "indicators": indicators,
        "data": records,
    }
    return {"dataset_id": ds_id, "record_count": len(records), "indicators_count": len(indicators)}

@app.get("/api/dataset/list")
def list_datasets():
    """List all loaded datasets (built-in + user uploads)."""
    result = []
    for ds_id, ds in _loaded_datasets.items():
        result.append({
            "id": ds_id,
            "name": ds["name"],
            "record_count": ds["record_count"],
            "indicators_count": len(ds["indicators"]),
            "uploaded_at": ds.get("uploaded_at"),
        })
    return {"datasets": result}

@app.get("/api/dataset/{ds_id}")
def get_dataset(ds_id: str):
    """Get full dataset by ID."""
    if ds_id not in _loaded_datasets:
        raise HTTPException(status_code=404, detail="Dataset not found")
    return _loaded_datasets[ds_id]

@app.delete("/api/dataset/{ds_id}")
def delete_dataset(ds_id: str):
    """Delete a dataset."""
    if ds_id not in _loaded_datasets:
        raise HTTPException(status_code=404, detail="Dataset not found")
    del _loaded_datasets[ds_id]
    return {"deleted": ds_id}

# ============================================================================
# MERGED / COMBINED DATASETS
# ============================================================================

@app.post("/api/dataset/merge")
def merge_datasets(request: dict = Body(...)):
    """Merge multiple datasets on the 'country' key. Returns a new combined dataset."""
    ds_ids = request.get("dataset_ids", [])
    if len(ds_ids) < 2:
        raise HTTPException(status_code=400, detail="Need at least 2 datasets to merge")

    # Fetch all datasets
    all_data = []
    all_indicators = []
    for ds_id in ds_ids:
        if ds_id.startswith("builtin:"):
            # Built-in datasets fetched via other endpoints
            continue
        if ds_id not in _loaded_datasets:
            raise HTTPException(status_code=404, detail=f"Dataset {ds_id} not found")
        ds = _loaded_datasets[ds_id]
        all_data.append(ds["data"])
        all_indicators.extend(ds["indicators"])

    # Merge on country
    merged = {}
    for data in all_data:
        for rec in data:
            country = rec.get("country")
            if not country:
                continue
            if country not in merged:
                merged[country] = {"country": country}
            merged[country].update(rec)

    result_records = list(merged.values())
    ds_id = _make_id()
    _loaded_datasets[ds_id] = {
        "id": ds_id,
        "name": request.get("name", f"Merged Dataset {ds_id[:6]}"),
        "uploaded_at": datetime.utcnow().isoformat(),
        "record_count": len(result_records),
        "indicators": all_indicators,
        "data": result_records,
        "merged_from": ds_ids,
    }
    return {"dataset_id": ds_id, "record_count": len(result_records), "indicators_count": len(all_indicators)}

# ============================================================================
# CORRELATION / ANALYSIS ENDPOINTS (Server-side computation)
# ============================================================================

@app.post("/api/analyze/correlations")
def analyze_correlations(request: dict = Body(...)):
    """Compute Pearson correlations between all variable pairs in a dataset."""
    ds_id = request.get("dataset_id")
    if not ds_id or ds_id not in _loaded_datasets:
        raise HTTPException(status_code=400, detail="Valid dataset_id required")

    ds = _loaded_datasets[ds_id]
    records = ds["data"]
    indicators = ds["indicators"]

    if not records:
        return {"correlations": [], "count": 0}

    df = pd.DataFrame(records)
    numeric_cols = []
    for ind in indicators:
        key = ind.get("key")
        if key and key in df.columns and df[key].dtype in [np.float64, np.int64, 'float64', 'int64']:
            numeric_cols.append((key, ind))

    correlations = []
    for i, (k1, ind1) in enumerate(numeric_cols):
        for j, (k2, ind2) in enumerate(numeric_cols):
            if i >= j:
                continue
            corr = df[k1].corr(df[k2])
            if pd.isna(corr):
                continue
            correlations.append({
                "var1": {"key": k1, "name": ind1["name"], "category": ind1.get("category", "General")},
                "var2": {"key": k2, "name": ind2["name"], "category": ind2.get("category", "General")},
                "r": round(float(corr), 4),
                "abs_r": round(abs(float(corr)), 4),
                "n": int(df[[k1, k2]].dropna().shape[0]),
            })

    correlations.sort(key=lambda x: x["abs_r"], reverse=True)
    return {"correlations": correlations, "count": len(correlations)}

@app.post("/api/analyze/outliers")
def analyze_outliers(request: dict = Body(...)):
    """Find statistical outliers (z-score > threshold) in a dataset."""
    ds_id = request.get("dataset_id")
    threshold = request.get("threshold", 2.0)
    if not ds_id or ds_id not in _loaded_datasets:
        raise HTTPException(status_code=400, detail="Valid dataset_id required")

    ds = _loaded_datasets[ds_id]
    df = pd.DataFrame(ds["data"])
    indicators = ds["indicators"]

    outliers = []
    for ind in indicators:
        key = ind.get("key")
        if not key or key not in df.columns:
            continue
        col = pd.to_numeric(df[key], errors="coerce").dropna()
        if len(col) < 5:
            continue
        mean, std = col.mean(), col.std()
        if std == 0:
            continue
        z_scores = (col - mean) / std
        for country, z in z_scores.items():
            if abs(z) > threshold:
                outliers.append({
                    "country": df.iloc[country]["country"] if "country" in df.columns else str(country),
                    "variable": key,
                    "variable_name": ind["name"],
                    "value": round(float(col.iloc[country]), 3),
                    "z_score": round(float(z), 2),
                    "direction": "high" if z > 0 else "low",
                })

    # Group by country
    grouped = {}
    for o in outliers:
        c = o["country"]
        if c not in grouped:
            grouped[c] = []
        grouped[c].append(o)

    result = []
    for country, devs in grouped.items():
        devs.sort(key=lambda x: abs(x["z_score"]), reverse=True)
        result.append({
            "country": country,
            "deviation_count": len(devs),
            "top_deviation": devs[0],
            "deviations": devs,
        })

    result.sort(key=lambda x: abs(x["top_deviation"]["z_score"]), reverse=True)
    return {"outliers": result, "country_count": len(result), "total_deviations": len(outliers)}

# ============================================================================
# HEALTH CHECK
# ============================================================================

@app.get("/api/health")
def health():
    return {"status": "ok", "datasets_loaded": len(_loaded_datasets), "cache_entries": len(_cache)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7860)

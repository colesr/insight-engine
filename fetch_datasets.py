#!/usr/bin/env python3
"""Insight Engine Dataset Fetcher — Run: python fetch_datasets.py"""

import json, time, sys
from pathlib import Path
import requests, pandas as pd, numpy as np
from io import StringIO
import datetime

OUTPUT = Path(".")
COUNTRY_MAP = {
    "United States of America": "United States",
    "Russian Federation": "Russia",
    "Korea, Republic of": "South Korea", "Korea, Rep.": "South Korea",
    "Iran, Islamic Republic of": "Iran", "Iran, Islamic Rep.": "Iran",
    "Viet Nam": "Vietnam",
    "Venezuela, Bolivarian Republic of": "Venezuela", "Venezuela, RB": "Venezuela",
    "Egypt, Arab Republic of": "Egypt", "Egypt, Arab Rep.": "Egypt",
    "Syrian Arab Republic": "Syria", "Yemen, Republic of": "Yemen",
    "Tanzania, United Republic of": "Tanzania",
    "Congo, Democratic Republic of the": "Democratic Republic of the Congo", "Congo, Dem. Rep.": "Democratic Republic of the Congo",
    "Congo, Republic of": "Republic of the Congo", "Congo, Rep.": "Republic of the Congo",
    "Lao People's Democratic Republic": "Laos", "Lao PDR": "Laos",
    "Libyan Arab Jamahiriya": "Libya", "Moldova, Republic of": "Moldova",
    "Macedonia, the former Yugoslav Republic of": "North Macedonia", "North Macedonia, Republic of": "North Macedonia",
    "Czechia": "Czech Republic", "Brunei Darussalam": "Brunei",
    "Cabo Verde": "Cape Verde", "Eswatini": "Swaziland",
    "Gambia, The": "Gambia", "Bahamas, The": "Bahamas",
}
def norm(name):
    return COUNTRY_MAP.get(name.strip(), name.strip()) if name else ""

print("[1/5] Building country lookup...")
rc = {}
try:
    r = requests.get("https://restcountries.com/v3.1/all?fields=name,cca3,population,area,region", timeout=30)
    for c in r.json():
        for k in [c.get("name",{}).get("common",""), c.get("name",{}).get("official","")]:
            if k: rc[norm(k)] = c
except Exception as e:
    print(f"  REST Countries failed: {e}")

def iso3(name):
    name = norm(name)
    if name in rc: return rc[name].get("cca3", name)
    for c in rc.values():
        if c.get("cca3","").upper() == name.upper(): return name
    return name

def w(name, unit, cat, icon, hib):
    return {"key":None,"name":name,"unit":unit,"category":cat,"desc":"","icon":icon,"higherIsBetter":hib}

def write(name, source, desc, vars, data, fname):
    js = f"""// {name} Dataset
// Source: {source}
// Variables: {len(vars)} | Countries: {len(data)}
const DATASET_{name.upper().replace(' ','_').replace('-','_')} = {json.dumps(data, ensure_ascii=False, indent=2)};
const VARIABLE_DEFS_{name.upper().replace(' ','_').replace('-','_')} = {json.dumps(vars, ensure_ascii=False, indent=2)};
const DATASET_PACK_{name.upper().replace(' ','_').replace('-','_')} = {{
  name: "{name}", source: "{source}", description: "{desc}",
  variableCount: {len(vars)}, countryCount: {len(data)},
  lastUpdated: "{time.strftime('%Y-%m-%d')}", requiresKey: false,
  dataset: DATASET_{name.upper().replace(' ','_').replace('-','_')},
  variables: VARIABLE_DEFS_{name.upper().replace(' ','_').replace('-','_')}
}};
"""
    (OUTPUT / fname).write_text(js, encoding="utf-8")
    print(f"  ✓ {fname} ({len(data)} rows, {len(vars)} vars)")

# ===== WORLD BANK =====
print("\n[2/5] Fetching World Bank indicators...")
inds = {
    "NY.GDP.PCAP.CD":w("GDP per Capita","USD","Economy","trending-up",None),
    "NY.GDP.MKTP.KD.ZG":w("GDP Growth","%","Economy","trending-up",True),
    "NE.TRD.GNFS.ZS":w("Trade (% of GDP)","%","Economy","globe",None),
    "SL.UEM.TOTL.ZS":w("Unemployment","%","Economy","users",False),
    "SP.DYN.LE00.IN":w("Life Expectancy","years","Health","heart",True),
    "SH.DYN.MORT":w("Mortality (under 5 per 1k)","per 1k","Health","skull",False),
    "SH.XPD.CHEX.GD.ZS":w("Health Expenditure (% GDP)","%","Health","activity",None),
    "SE.PRM.CMPT.ZS":w("Primary Completion","%","Education","graduation-cap",True),
    "SE.TER.ENRR":w("Tertiary Enrollment","%","Education","book-open",True),
    "IT.NET.USER.ZS":w("Internet Users","%","Infrastructure","wifi",True),
    "EG.ELC.ACCS.ZS":w("Electricity Access","%","Infrastructure","zap",True),
    "EN.ATM.CO2E.PC":w("CO2 per Capita","tonnes","Environment","cloud",False),
    "AG.LND.FRST.ZS":w("Forest Cover","%","Environment","trees",None),
    "EG.FEC.RNEW.ZS":w("Renewable Energy","%","Environment","sun",True),
    "SP.POP.TOTL":w("Population","people","Demographics","users",None),
    "SP.POP.GROW":w("Population Growth","%","Demographics","baby",None),
    "SP.DYN.TFRT.IN":w("Fertility Rate","births/woman","Demographics","baby",None),
    "SI.POV.GINI":w("Gini Index","index","Social","bar-chart",False),
    "SG.GEN.PARL.ZS":w("Women in Parliament","%","Social","user-check",True),
    "VC.IHR.PSRC.P5":w("Intentional Homicides","per 100k","Social","alert-triangle",False),
}
wb_data = {}
for code, v in inds.items():
    v["key"] = code
    try:
        r = requests.get(f"https://api.worldbank.org/v2/country/all/indicator/{code}?format=json&per_page=10000&mrnev=1&date=2018:2023", timeout=30)
        d = r.json()
        if len(d)>1 and isinstance(d[1], list):
            for e in d[1]:
                val = e.get("value")
                if val is not None:
                    c = norm(e.get("country",{}).get("value",""))
                    if c:
                        if c not in wb_data: wb_data[c] = {"country": c}
                        wb_data[c][code] = val
    except Exception as e:
        print(f"    {code} failed: {e}")
    time.sleep(0.2)
write("World Bank Extended","api.worldbank.org/v2","Economy, health, education, infrastructure, environment, demographics and social",list(inds.values()),list(wb_data.values()),"dataset_worldbank.js")

# ===== REST COUNTRIES =====
print("\n[3/5] Fetching REST Countries...")
try:
    r = requests.get("https://restcountries.com/v3.1/all?fields=name,cca3,population,area,region,subregion,capital,languages,currencies,independent,unMember,landlocked,gini", timeout=60)
    rc_data = r.json()
    rc_vars = [
        {"key":"population","name":"Population","unit":"people","category":"Demographics","desc":"Total population","icon":"users","higherIsBetter":None},
        {"key":"area","name":"Land Area","unit":"km2","category":"Demographics","desc":"Total land area","icon":"map","higherIsBetter":None},
        {"key":"independent","name":"Independent","unit":"boolean","category":"Politics","desc":"Recognized independent","icon":"flag","higherIsBetter":True},
        {"key":"unMember","name":"UN Member","unit":"boolean","category":"Politics","desc":"UN membership","icon":"globe","higherIsBetter":None},
        {"key":"landlocked","name":"Landlocked","unit":"boolean","category":"Geography","desc":"No ocean coastline","icon":"map-pin","higherIsBetter":False},
        {"key":"num_languages","name":"Official Languages","unit":"count","category":"Culture","desc":"Number of official languages","icon":"languages","higherIsBetter":None},
        {"key":"num_currencies","name":"Currencies","unit":"count","category":"Economy","desc":"Number of official currencies","icon":"coins","higherIsBetter":None},
    ]
    rc_rows = []
    for c in rc_data:
        country = norm(c.get("name",{}).get("common",""))
        rc_rows.append({
            "country": country, "iso3": c.get("cca3",""),
            "population": c.get("population"), "area": c.get("area"),
            "independent": 1 if c.get("independent") else 0,
            "unMember": 1 if c.get("unMember") else 0,
            "landlocked": 1 if c.get("landlocked") else 0,
            "num_languages": len(c.get("languages",{})),
            "num_currencies": len(c.get("currencies",{})),
        })
    write("REST Countries","restcountries.com/v3.1","Geography, demographics, politics and cultural",rc_vars,rc_rows,"dataset_countries.js")
except Exception as e:
    print(f"  Failed: {e}")

# ===== OWID =====
print("\n[4/5] Fetching Our World in Data...")
try:
    r = requests.get("https://raw.githubusercontent.com/owid/covid-19-data/master/public/data/owid-covid-data.csv", timeout=60)
    df = pd.read_csv(StringIO(r.text))
    latest = df.sort_values("date").groupby("location").last().reset_index()
    owid_cols = {
        "total_cases_per_million":w("Total Cases per Million","per million","Health","virus",False),
        "total_deaths_per_million":w("Total Deaths per Million","per million","Health","skull",False),
        "people_vaccinated_per_hundred":w("People Vaccinated","%","Health","syringe",True),
        "hospital_beds_per_thousand":w("Hospital Beds per 1k","per 1000","Health","bed",True),
        "human_development_index":w("Human Development Index","0-1","Social","award",True),
        "extreme_poverty":w("Extreme Poverty Rate","%","Social","frown",False),
        "median_age":w("Median Age","years","Demographics","calendar",None),
        "gdp_per_capita":w("GDP per Capita","USD","Economy","trending-up",True),
        "life_expectancy":w("Life Expectancy","years","Health","heart",True),
    }
    for col,v in owid_cols.items(): v["key"] = col
    owid_rows = []
    for _, row in latest.iterrows():
        c = norm(row.get("location",""))
        if not c or c in ["World","International","High income","Low income","Upper middle income","Lower middle income","European Union"]:
            continue
        rec = {"country": c, "iso3": row.get("iso_code","")}
        for col in owid_cols.keys():
            v = row.get(col)
            if pd.notna(v): rec[col] = float(v)
        if len(rec)>2: owid_rows.append(rec)
    write("OWID Health & COVID","github.com/owid/covid-19-data","COVID-19 outcomes, vaccination, HDI, demographics",list(owid_cols.values()),owid_rows,"dataset_owid.js")
except Exception as e:
    print(f"  Failed: {e}")

# ===== CLIMATE =====
print("\n[5/5] Fetching Open-Meteo climate data...")
caps = {
    "United States":(38.9072,-77.0369),"China":(39.9042,116.4074),"India":(28.6139,77.2090),
    "Russia":(55.7558,37.6173),"Japan":(35.6762,139.6503),"Germany":(52.5200,13.4050),
    "United Kingdom":(51.5074,-0.1278),"France":(48.8566,2.3522),"Brazil":(-15.7975,-47.8919),
    "Italy":(41.9028,12.4964),"Canada":(45.4215,-75.6972),"Australia":(-35.2809,149.1300),
    "South Korea":(37.5665,126.9780),"Spain":(40.4168,-3.7038),"Mexico":(19.4326,-99.1332),
    "Indonesia":(-6.2088,106.8456),"Turkey":(39.9334,32.8597),"Saudi Arabia":(24.7136,46.6753),
    "South Africa":(-25.7479,28.2293),"Egypt":(30.0444,31.2357),"Argentina":(-34.6037,-58.3816),
    "Nigeria":(9.0765,7.3986),"Pakistan":(33.6844,73.0479),"Bangladesh":(23.8103,90.4125),
    "Vietnam":(21.0278,105.8342),"Thailand":(13.7563,100.5018),"Poland":(52.2297,21.0122),
    "Ukraine":(50.4501,30.5234),"Malaysia":(3.1390,101.6869),"Philippines":(14.5995,120.9842),
    "Chile":(-33.4489,-70.6693),"Singapore":(1.3521,103.8198),"Sweden":(59.3293,18.0686),
    "Norway":(59.9139,10.7522),"Netherlands":(52.3676,4.9041),"Belgium":(50.8503,4.3517),
    "Switzerland":(46.9480,7.4474),"Austria":(48.2082,16.3738),"Israel":(31.7683,35.2137),
    "UAE":(24.4539,54.3773),"Czech Republic":(50.0755,14.4378),"Portugal":(38.7223,-9.1393),
    "Greece":(37.9838,23.7275),"Finland":(60.1699,24.9384),"Denmark":(55.6761,12.5683),
    "Ireland":(53.3498,-6.2603),"New Zealand":(-41.2865,174.7762),"Colombia":(4.7110,-74.0721),
    "Peru":(-12.0464,-77.0428),"Morocco":(34.0209,-6.8416),"Kenya":(-1.2921,36.8219),
    "Ethiopia":(9.0054,38.7636),"Ghana":(5.6037,-0.1870),
}
om_vars = [
    {"key":"temp_mean_annual","name":"Mean Annual Temperature","unit":"°C","category":"Climate","desc":"Average temperature","icon":"thermometer","higherIsBetter":None},
    {"key":"temp_max_annual","name":"Max Annual Temperature","unit":"°C","category":"Climate","desc":"Maximum temperature","icon":"flame","higherIsBetter":None},
    {"key":"temp_min_annual","name":"Min Annual Temperature","unit":"°C","category":"Climate","desc":"Minimum temperature","icon":"snowflake","higherIsBetter":None},
    {"key":"precipitation_annual","name":"Annual Precipitation","unit":"mm","category":"Climate","desc":"Total annual rainfall","icon":"cloud-rain","higherIsBetter":None},
    {"key":"rain_days","name":"Rain Days","unit":"days","category":"Climate","desc":"Days with precipitation","icon":"umbrella","higherIsBetter":None},
]
ed = datetime.datetime.now().strftime("%Y-%m-%d")
sd = (datetime.datetime.now()-datetime.timedelta(days=365)).strftime("%Y-%m-%d")
om_rows = []
for country,(lat,lon) in caps.items():
    try:
        url = f"https://archive-api.open-meteo.com/v1/archive?latitude={lat}&longitude={lon}&start_date={sd}&end_date={ed}&daily=temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto"
        r = requests.get(url, timeout=15)
        if r.status_code!=200: continue
        d = r.json().get("daily",{})
        t,m,n,p = d.get("temperature_2m_mean",[]),d.get("temperature_2m_max",[]),d.get("temperature_2m_min",[]),d.get("precipitation_sum",[])
        if t:
            om_rows.append({"country":country,"temp_mean_annual":round(np.mean(t),1) if t else None,"temp_max_annual":round(np.max(m),1) if m else None,"temp_min_annual":round(np.min(n),1) if n else None,"precipitation_annual":round(np.sum(p),1) if p else None,"rain_days":sum(1 for x in p if x and x>0.1) if p else None})
        time.sleep(0.05)
    except: continue
write("Open-Meteo Climate","archive-api.open-meteo.com/v1","Historical climate: temperature ranges and precipitation",om_vars,om_rows,"dataset_climate.js")

# ===== INDEX =====
print("\n[Generating dataset index...]")
packs = []
for f in sorted(OUTPUT.glob("dataset_*.js")):
    if f.name == "dataset_index.js": continue
    content = f.read_text()
    import re
    m = re.search(r'const DATASET_PACK_(\\w+) =', content)
    if m:
        key = f"DATASET_PACK_{m.group(1)}"
        nm = re.search(r'name: "([^"]+)"', content)
        src = re.search(r'source: "([^"]+)"', content)
        desc = re.search(r'description: "([^"]+)"', content)
        vc = re.search(r'variableCount: (\\d+)', content)
        cc = re.search(r'countryCount: (\\d+)', content)
        if nm:
            packs.append({"name":nm.group(1),"source":src.group(1) if src else "","description":desc.group(1) if desc else "","variableCount":int(vc.group(1)) if vc else 0,"countryCount":int(cc.group(1)) if cc else 0,"lastUpdated":time.strftime("%Y-%m-%d"),"requiresKey":False,"jsFile":f.name,"key":key})

idx = f"""// Insight Engine Dataset Index
const DATASET_INDEX = {json.dumps({"packs":packs}, ensure_ascii=False, indent=2)};
function listAvailableDatasets(){{ return DATASET_INDEX.packs; }}
function loadDataset(packKey){{ const p=DATASET_INDEX.packs.find(x=>x.key===packKey); return p?window[p.key]:null; }}
"""
(OUTPUT / "dataset_index.js").write_text(idx, encoding="utf-8")
print(f"  ✓ dataset_index.js ({len(packs)} packs)")

print("\n" + "="*50 + "\nDONE\n" + "="*50)
for p in packs:
    print(f"  {p['name']:25s} | {p['variableCount']:3d} vars | {p['countryCount']:3d} countries")
print(f"\nNext steps:")
print(f"  1. cd ~/insight-engine-v3")
print(f"  2. cp ~/CodingProjects/Insights\\ Engine/dataset_*.js .")
print(f"  3. git add . && git commit -m 'multi-dataset support' && git push")
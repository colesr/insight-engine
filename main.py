"""
Insight Engine - FastAPI Backend
Handles API proxying, dataset operations, caching, and static file serving.
"""
from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, HTMLResponse
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

# ============================================================================
# API ROUTES (must be defined BEFORE the catch-all root route)
# ============================================================================

# Root health endpoint
@app.get("/api/health")
def health():
    return {"status": "ok", "datasets_loaded": len(_loaded_datasets), "cache_entries": len(_cache)}

# Static files — served at /static/ for JS/CSS
app.mount("/static", StaticFiles(directory="static"), name="static")

# SPA catch-all: serve index.html for all non-API paths
# HF Spaces proxy may send POST to / for the initial page load
from fastapi import Request
@app.api_route("/", methods=["GET", "POST"], response_class=HTMLResponse)
def serve_index(request: Request):
    with open("static/index.html", "r") as f:
        return f.read()

# ============================================================================
# WORLD BANK API
# ============================================================================

WORLD_BANK_BASE = "https://api.worldbank.org/v2"

WORLDBANK_INDICATORS = {
    # --- ECONOMY ---
    "gdp_current": "NY.GDP.MKTP.CD",
    "gdp_per_capita": "NY.GDP.PCAP.CD",
    "gdp_growth": "NY.GDP.MKTP.KD.ZG",
    "gdp_ppp": "NY.GDP.MKTP.PP.CD",
    "gdp_ppp_per_capita": "NY.GDP.PCAP.PP.CD",
    "inflation": "FP.CPI.TOTL.ZG",
    "exports": "NE.EXP.GNFS.CD",
    "imports": "NE.IMP.GNFS.CD",
    "trade_balance": "NE.TRD.GNFS.ZS",
    "fdi_inflows": "BX.KLT.DINV.WD.GD.ZS",
    "fdi_net_inflows": "BX.KLT.DINV.CD.WD",
    "industry_value_added": "NV.IND.TOTL.ZS",
    "services_value_added": "NV.SRV.TOTL.ZS",
    "agriculture_value_added": "NV.AGR.TOTL.ZS",
    "manufacturing_value_added": "NV.IND.MANF.ZS",
    "gov_debt": "GC.DOD.TOTL.GD.ZS",
    "gov_expense": "GC.XPN.TOTL.GD.ZS",
    "gov_revenue": "GC.REV.XGRT.GD.ZS",
    "tax_revenue": "GC.TAX.TOTL.GD.ZS",
    "central_gov_debt": "GC.DOD.TOTL.CN",
    "broad_money_growth": "FM.LBC.GDP.ZS",
    "consumer_price_index": "FP.CPI.TOTL",
    "exchange_rate": "PA.NUS.PPP",
    "business_extent": "IC.BUS.EASE.XQ",
    "private_sector_credit": "GFDD.DI.14",
    "stock_market_capitalization": "CM.MKT.LCAP.GD.ZS",
    "total_reserves": "FI.RES.TOTL.CD",
    "external_debt_total": "DT.DOD.DECT.CD",
    "debt_service": "DT.TDS.DECT.CD",
    "gni_per_capita": "NY.GNP.PCAP.CD",
    "gni_current": "NY.GNP.MKTP.CD",
    "patent_applications": "IP.PAT.RESD",
    "research_spending": "GB.XPD.RSDV.GD.ZS",
    "high_tech_exports": "TX.VAL.TECH.CD",
    "transport_infrastructure_quality": "IQ.WEF.INFR.XQ",
    "logistics_performance": "LP.LPI.OVRL.XQ",
    "port_infrastructure": "IQ.WEF.PORT.XQ",
    # --- SOCIAL / DEMOGRAPHICS ---
    "population": "SP.POP.TOTL",
    "population_density": "EN.POP.DNST",
    "population_growth": "SP.POP.GROW",
    "urban_population": "SP.URB.TOTL.IN.ZS",
    "rural_population": "SP.RUR.TOTL.ZS",
    "population_0_14": "SP.POP.0014.TO.ZS",
    "population_15_64": "SP.POP.1564.TO.ZS",
    "population_65_plus": "SP.POP.65UP.TO.ZS",
    "dependency_ratio": "SP.POP.DPND",
    "fertility_rate": "SP.DYN.TFRT.IN",
    "birth_rate": "SP.DYN.CBRT.IN",
    "death_rate": "SP.DYN.CDRT.IN",
    "migration_net": "SM.POP.NETM",
    "refugee_population": "SM.POP.REFG",
    "internally_displaced": "VC.IDP.TOTL.OL",
    "gini": "SI.POV.GINI",
    "poverty_headcount": "SI.POV.DDAY",
    "poverty_gap": "SI.POV.NAHC",
    "income_share_lowest_20": "SI.DST.FRST.20",
    "income_share_highest_10": "SI.DST.10TH.10",
    "income_share_highest_20": "SI.DST.05TH.20",
    "multidimensional_poverty": "SI.POV.MDIM",
    "vulnerable_employment": "SL.EMP.VULN.ZS",
    "self_employed": "SL.EMP.SELF.ZS",
    "unemployment": "SL.UEM.TOTL.ZS",
    "unemployment_youth": "SL.UEM.TOTL.ZS",
    "unemployment_female": "SL.UEM.TOTL.FE.ZS",
    "labor_force_participation": "SL.TLF.CACT.ZS",
    "labor_force_female": "SL.TLF.CACT.FE.ZS",
    "wage_and_salaried": "SL.EMP.WORK.ZS",
    "child_labor": "SL.CHLD.WORK.ZS",
    "time_spent_unpaid_work_female": "SG.TIM.UWRK.FE",
    # --- HEALTH ---
    "life_expectancy": "SP.DYN.LE00.IN",
    "life_expectancy_female": "SP.DYN.LE00.FE.IN",
    "life_expectancy_male": "SP.DYN.LE00.MA.IN",
    "health_exp_per_capita": "SH.XPD.CHEX.PC.CD",
    "health_exp_gdp": "SH.XPD.CHEX.GD.ZS",
    "health_exp_gov": "SH.XPD.GHED.GD.ZS",
    "health_exp_private": "SH.XPD.PCAP.GD.ZS",
    "physicians_per_1000": "SH.MED.PHYS.ZS",
    "nurses_per_1000": "SH.MED.NURS.ZS",
    "hospital_beds_per_1000": "SH.MED.BEDS.ZS",
    "immunization_dpt": "SH.IMM.IBCG",
    "immunization_measles": "SH.IMM.MEAS",
    "infant_mortality": "SP.DYN.IMRT.IN",
    "under5_mortality": "SH.DYN.MORT",
    "maternal_mortality": "SH.STA.MMRT",
    "neonatal_mortality": "SH.DYN.NMRT",
    "adolescent_fertility": "SP.ADO.TFRT",
    "contraceptive_prevalence": "SP.DYN.CONM.ZS",
    "births_attended": "SH.STA.BRTC.ZS",
    "sanitation": "SH.STA.SMSS.ZS",
    "drinking_water": "SH.H2O.SMDW.ZS",
    "handwashing": "SH.STA.HYGN.ZS",
    "stunting": "SH.STA.STNT.ME.ZS",
    "wasting": "SH.STA.WAST.ZS",
    "overweight": "SH.STA.OWGH.ZS",
    "undernourishment": "SN.ITK.DEFC.ZS",
    "diabetes_prevalence": "SH.STA.DIAB.ZS",
    "tuberculosis_incidence": "SH.TBS.INCD",
    "malaria_incidence": "SH.MLR.INCD.P3",
    "hiv_prevalence": "SH.DYN.AIDS.ZS",
    "alcohol_consumption": "SH.ALC.PCAP.LI",
    "smoking_prevalence": "SH.PRV.SMOK",
    "suicide_mortality": "SH.STA.SUIC.P5",
    "road_traffic_mortality": "SH.STA.TRAF.P5",
    "air_pollution_deaths": "SH.STA.AIRP.P5",
    "ambient_pm25": "EN.ATM.PM25.MC.M3",
    "household_air_pollution": "EN.ATM.HOUS.ZS",
    "daly": "SH.DTH.COMM.ZS",
    "cause_of_death_communicable": "SH.DTH.COMM.ZS",
    "cause_of_death_noncommunicable": "SH.DTH.NCOM.ZS",
    "cause_of_death_injury": "SH.DTH.INJR.ZS",
    "raised_blood_pressure": "SH.STA.HYPB.ZS",
    "raised_blood_glucose": "SH.STA.DIAB.ZS",
    "overweight_adults": "SH.STA.OWAD.ZS",
    # --- EDUCATION ---
    "primary_enrollment": "SE.PRM.ENRR",
    "primary_completion": "SE.PRM.CMPT.ZS",
    "secondary_enrollment": "SE.SEC.ENRR",
    "tertiary_enrollment": "SE.TER.ENRR",
    "literacy_rate": "SE.ADT.LITR.ZS",
    "literacy_rate_youth": "SE.ADT.1524.LT.ZS",
    "literacy_rate_female": "SE.ADT.LITR.FE.ZS",
    "mean_years_schooling": "BAR.SCHL.15UP",
    "expected_years_schooling": "SE.SCH.LIFE",
    "pupil_teacher_ratio_primary": "SE.PRM.ENRL.TC.ZS",
    "school_enrollment_preprimary": "SE.PRE.ENRR",
    "out_of_school_primary": "SE.PRM.UNER",
    "out_of_school_secondary": "SE.SEC.UNER.LO",
    "gov_education_exp": "SE.XPD.TOTL.GD.ZS",
    "scholarship_travel": "DT.ODA.ATCD.KSCH",
    "trained_teachers": "SE.PRM.TCAQ.ZS",
    "children_out_of_school": "SE.PRM.UNER.ZS",
    "youth_literacy": "SE.ADT.1524.LT.ZS",
    "gov_education_exp_primary": "SE.XPD.PRIM.PC.ZS",
    # --- INFRASTRUCTURE / TECHNOLOGY ---
    "electricity_access": "EG.ELC.ACCS.ZS",
    "electricity_access_rural": "EG.ELC.ACCS.RU.ZS",
    "electricity_access_urban": "EG.ELC.ACCS.UR.ZS",
    "internet_users": "IT.NET.USER.ZS",
    "fixed_broadband": "IT.NET.BBND.P2",
    "mobile_subscriptions": "IT.CEL.SETS.P2",
    "secure_internet_servers": "IT.NET.SECR.P6",
    "individuals_using_internet": "IT.NET.USER.ZS",
    "researchers_per_million": "SP.POP.SCIE.RD.P6",
    "technicians_in_rd": "SP.POP.TECH.RD.P6",
    "rd_expenditure": "GB.XPD.RSDV.GD.ZS",
    "scientific_journal_articles": "IP.JRN.ARTC.SC",
    # --- ENVIRONMENT ---
    "co2_per_capita": "EN.ATM.CO2E.PC",
    "co2_total": "EN.ATM.CO2E.KT",
    "co2_intensity": "EN.ATM.CO2E.PP.GD",
    "renewable_energy": "EG.FEC.RNEW.ZS",
    "fossil_fuel_energy": "EG.USE.COMM.FO.ZS",
    "nuclear_energy": "EG.EGY.NUCL.ZS",
    "electricity_from_renewables": "EG.ELC.RNEW.ZS",
    "electricity_from_fossil": "EG.ELC.FOSL.ZS",
    "electricity_from_nuclear": "EG.ELC.NUCL.ZS",
    "energy_use_per_capita": "EG.USE.PCAP.KG.OE",
    "energy_intensity": "EG.EGY.PRIM.PP.KD",
    "forest_cover": "AG.LND.FRST.ZS",
    "forest_area": "AG.LND.FRST.K2",
    "terrestrial_protected_areas": "ER.PTD.TOTL.ZS",
    "marine_protected_areas": "ER.MRN.PTMN.ZS",
    "freshwater_withdrawal": "ER.H2O.FWTL.ZS",
    "renewable_freshwater_per_capita": "ER.H2O.FWTL.ZS",
    "water_productivity": "ER.H2O.FWTL.KD.M3",
    "agricultural_land": "AG.LND.AGRI.ZS",
    "arable_land": "AG.LND.ARBL.ZS",
    "cereal_yield": "AG.YLD.CREL.KG",
    "fertilizer_consumption": "AG.CON.FERT.ZS",
    "methane_emissions": "EN.ATM.METH.AG.KT.CE",
    "nitrous_oxide_emissions": "EN.ATM.NOXE.AG.KT.CE",
    "nox_emissions": "EN.ATM.NOXE.AG.KT.CE",
    "ghg_emissions_total": "EN.ATM.GHGT.KT.CE",
    "pm25_exposure": "EN.ATM.PM25.MC.M3",
    "co2_emissions_transport": "EN.CO2.TRAN.ZS",
    "co2_emissions_manufacturing": "EN.CO2.MANF.ZS",
    "co2_emissions_electricity": "EN.CO2.ETOT.ZS",
    "co2_emissions_residential": "EN.CO2.BLDG.ZS",
    "biodiversity": "EN.BIR.THRD.NO",
    "threatened_species": "EN.BIR.THRD.NO",
    "threatened_mammals": "EN.MAM.THRD.NO",
    "threatened_fish": "EN.FSH.THRD.NO",
    "threatened_plants": "EN.HPT.THRD.NO",
    "natural_resource_rents": "NY.GDP.TOTL.RT.ZS",
    "mineral_rents": "NY.GDP.MINL.RT.ZS",
    "oil_rents": "NY.GDP.PETR.RT.ZS",
    "gas_rents": "NY.GDP.NGAS.RT.ZS",
    "coal_rents": "NY.GDP.COAL.RT.ZS",
    "forest_rents": "NY.GDP.FRST.RT.ZS",
    "total_greenhouse_gas": "EN.ATM.GHGT.KT.CE",
    "adjustedsavings_co2": "NY.ADJ.DCO2.GN.ZS",
    "adjustedsavings_particulate": "NY.ADJ.DPEM.GN.ZS",
    "waste_collection": "EN.CLC.WSTC.CD",
    "material_footprint": "EN.MWF.MTRC.MT.CD",
    "consumption_footprint": "EN.CLC.MDPT.ZS",
    "ocean_acidification": "EN.ATM.CO2E.PC",
    "adaptation_fund": "EN.CLC.ADPT.XD",
    # --- GOVERNANCE / INSTITUTIONS ---
    "voice_accountability": "RV.ACCES.RANK.XD",
    "political_stability": "RV.POLI.RANK.XD",
    "government_effectiveness": "RV.GEFF.RANK.XD",
    "regulatory_quality": "RV.REGR.RANK.XD",
    "rule_of_law": "RV.RULE.RANK.XD",
    "control_of_corruption": "RV.CORR.RANK.XD",
    "battle_deaths": "VC.BTL.DETH",
    "intentional_homicides": "VC.IHR.PSRC.P5",
    "detention_rate": "IC.PRP.DETN.PS",
    "prison_population": "IC.PRP.TOTL.P2",
    "military_expenditure": "MS.MIL.XPND.GD.ZS",
    "armed_forces_personnel": "MS.MIL.TOTL.P1",
    "arms_exports": "MS.MIL.XPRT.KD",
    "arms_imports": "MS.MIL.MPRT.KD",
    "conflict_affected": "VC.IDP.TOTL.OL",
    "terrorism_incidents": "VC.IHR.PSRC.P5",
    "procedures_to_start_business": "IC.REG.DURS",
    "time_to_start_business": "IC.REG.COST.PC.FE.ZS",
    "cost_to_start_business": "IC.REG.COST.PC.FE.ZS",
    "tax_payments": "IC.TAX.PAYM",
    "time_to_pay_taxes": "IC.TAX.DURS",
    "total_tax_rate": "IC.TAX.TOTL.CP.ZS",
    "property_registering_procedures": "IC.PRP.PRO",
    "time_to_register_property": "IC.PRP.DURS",
    "building_permit_procedures": "IC.CON.PROC",
    "time_to_get_electricity": "IC.ELC.TIME",
    "getting_credit_rank": "IC.CRD.PUBL.ZS",
    "protecting_minority_investors": "IC.INV.PROT",
    "resolving_insolvency": "IC.ISV.RECD",
    "contract_enforcement": "IC.LGL.DURS",
    "women_business_owners": "IC.WOB.OWN.ZS",
    "female_top_managers": "IC.WOB.MGT.ZS",
    "women_parliament_seats": "SG.GEN.PARL.ZS",
    "women_minister_positions": "SG.GEN.MNST.ZS",
    "gender_inequality_index": "SE.GPI.IALL",
    "gender_wage_gap": "SL.EMP.GAP.WAGE.ZS",
    "legal_framework_gender": "SG.LAW.FRWK.WE",
    "assets_ownership_gender": "SG.OWN.LAND.FE.ZS",
    # --- AID / DEVELOPMENT ---
    "net_oda_received": "DT.ODA.ODAT.CD",
    "oda_gni": "DT.ODA.ODAT.GN.ZS",
    "oda_per_capita": "DT.ODA.ODAT.PC.ZD",
    "oda_given": "DAC.TOTL.ALLEF",
    "remittances_received": "BX.TRF.PWKR.CD.DT",
    "remittances_gdp": "BX.TRF.PWKR.DT.GD.ZS",
    "net_migration": "SM.POP.NETM",
    "net_bilateral_aid": "DC.DAC.AIDP.CD",
    "oda_education": "SE.XPD.TOTL.GD.ZS",
    "oda_health": "SH.XPD.CHEX.GD.ZS",
    "oda_infrastructure": "DT.ODA.ALLD.CD",
    "debt_relief": "DT.DOD.DLXF.CD",
    # --- GENDER ---
    "gender_gap_economic": "IQ.CPA.GNDR.XQ",
    "gender_gap_education": "IQ.CPA.GNDR.XQ",
    "gender_gap_health": "IQ.CPA.GNDR.XQ",
    "gender_gap_political": "IQ.CPA.GNDR.XQ",
    "firms_with_female_top_manager": "IC.FRM.FEMM.ZS",
    "firms_with_female_ownership": "IC.FRM.FEMO.ZS",
    "female_labor_force": "SL.TLF.TOTL.FE.ZS",
    "female_wage_salary": "SL.EMP.WORK.FE.ZS",
    "female_vulnerable_employment": "SL.EMP.VULN.FE.ZS",
    "youth_not_in_edu_employment": "SL.UEM.NEET.ZS",
    "youth_not_in_edu_employment_female": "SL.UEM.NEET.FE.ZS",
    # --- DIGITAL ---
    "digital_government_index": "EG.DIG.GOVT",
    "online_services_index": "EG.OVI.SCOR.XQ",
    "e_participation_index": "EG.OVI.ACCS.XQ",
    "telecommunication_infrastructure": "IT.NET.SECR.P6",
    "ict_goods_exports": "TX.VAL.ICTG.ZS.UN",
    "ict_goods_imports": "TM.VAL.ICTG.ZS.UN",
    "ict_services_exports": "TX.VAL.ICTS.ZS.UN",
    "ict_services_imports": "TM.VAL.ICTS.ZS.UN",
    "computer_communication_services": "BX.GSR.CMCP.ZS",
    # --- TOURISM ---
    "international_tourist_arrivals": "ST.INT.ARVL",
    "international_tourism_receipts": "ST.INT.RCPT.CD",
    "international_tourism_expenditures": "ST.INT.XPND.CD",
    "tourism_receipts_percent_exports": "ST.INT.RCPT.XP.ZS",
    "tourism_receipts_percent_gdp": "ST.INT.RCPT.GD.ZS",
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
    key_lc = key.lower()
    # Economy
    if any(x in key_lc for x in ["gdp", "gni", "inflation", "export", "import", "trade", "fdi", "invest", "industry", "agriculture_value", "manufacturing", "service", "debt", "expense", "revenue", "tax", "money", "price", "exchange", "business", "credit", "stock", "reserve", "rent", "income_share", "wage", "salary", "labor_force", "employment", "unemployment", "self_employed", "vulnerable_employment", "poverty", "gini"]):
        return "Economy"
    # Health
    if any(x in key_lc for x in ["life_expectancy", "health", "mortality", "sanitation", "drinking_water", "handwashing", "stunting", "wasting", "overweight", "undernourishment", "diabetes", "tuberculosis", "malaria", "hiv", "alcohol", "smoking", "suicide", "traffic", "pollution", "pm25", "physician", "nurse", "hospital", "immunization", "births_attended", "fertility", "adolescent", "contraceptive", "maternal", "neonatal", "daly", "blood_pressure", "blood_glucose"]):
        return "Health"
    # Education
    if any(x in key_lc for x in ["enrollment", "education", "literacy", "school", "pupil", "teacher", "trained_teacher", "scholarship", "mean_years", "expected_years"]):
        return "Education"
    # Infrastructure / Digital / Technology
    if any(x in key_lc for x in ["electricity", "internet", "broadband", "mobile", "server", "researcher", "technician", "rd_expenditure", "scientific_journal", "ict", "telecommunication", "digital", "cybersecurity", "innovation", "patent", "high_tech"]):
        return "Digital"
    # Environment
    if any(x in key_lc for x in ["co2", "carbon", "renewable", "fossil", "nuclear", "energy", "electricity_from", "forest", "freshwater", "water", "methane", "nitrous", "nox", "ghg", "emission", "pollution", "pm25_exposure", "biodiversity", "threatened", "species", "natural_resource", "ocean", "material_footprint", "consumption_footprint", "agricultural_land", "arable", "cereal", "fertilizer", "climate"]):
        return "Environment"
    # Social / Demographics
    if any(x in key_lc for x in ["population", "urban", "rural", "dependency", "migration", "refugee", "displaced", "birth_rate", "death_rate", "gender", "women", "female", "youth", "child_labor", "time_spent"]):
        return "Social"
    # Governance / Institutions
    if any(x in key_lc for x in ["voice", "accountability", "political", "government_effectiveness", "regulatory", "rule_of_law", "corruption", "corrupt", "cpi", "press_freedom", "battle", "homicide", "detention", "prison", "military", "armed_force", "arms", "conflict", "terrorism", "procedures", "time_to_start", "cost_to_start", "tax_payment", "property", "building", "electricity_time", "credit_rank", "minority", "insolvency", "contract", "women_business", "female_top_manager", "legal_framework"]):
        return "Governance"
    # Tourism
    if any(x in key_lc for x in ["tourism", "tourist"]):
        return "Tourism"
    # Aid / Development
    if any(x in key_lc for x in ["oda", "aid", "remittance", "debt_relief"]):
        return "Aid"
    # Food
    if any(x in key_lc for x in ["food"]):
        return "Food"
    # Labor
    if any(x in key_lc for x in ["workers_rights", "collective_bargaining", "trade_union", "freedom_of_association", "right_to_strike"]):
        return "Labor"
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
# BUILT-IN REFERENCE DATASETS
# ============================================================================

_BUILTIN_DATASETS = {
    "happiness_2023": {
        "name": "World Happiness Report 2023",
        "source": "UN Sustainable Development Solutions Network",
        "category": "Wellbeing",
        "description": "Happiness scores, social support, freedom, generosity, and perceptions of corruption.",
        "last_updated": "2023",
        "records": [
            {"country": "Finland", "happiness_score": 7.804, "gdp_per_capita": 1.888, "social_support": 1.585, "healthy_life_expectancy": 0.519, "freedom": 0.637, "generosity": 0.142, "perceptions_of_corruption": 0.515, "dystopia_residual": 2.518},
            {"country": "Denmark", "happiness_score": 7.586, "gdp_per_capita": 1.949, "social_support": 1.548, "healthy_life_expectancy": 0.537, "freedom": 0.609, "generosity": 0.222, "perceptions_of_corruption": 0.485, "dystopia_residual": 2.236},
            {"country": "Iceland", "happiness_score": 7.530, "gdp_per_capita": 1.882, "social_support": 1.639, "healthy_life_expectancy": 0.536, "freedom": 0.610, "generosity": 0.249, "perceptions_of_corruption": 0.168, "dystopia_residual": 2.446},
            {"country": "Israel", "happiness_score": 7.473, "gdp_per_capita": 1.796, "social_support": 1.455, "healthy_life_expectancy": 0.532, "freedom": 0.465, "generosity": 0.195, "perceptions_of_corruption": 0.306, "dystopia_residual": 2.724},
            {"country": "Netherlands", "happiness_score": 7.403, "gdp_per_capita": 1.913, "social_support": 1.398, "healthy_life_expectancy": 0.529, "freedom": 0.535, "generosity": 0.262, "perceptions_of_corruption": 0.290, "dystopia_residual": 2.476},
            {"country": "Sweden", "happiness_score": 7.395, "gdp_per_capita": 1.882, "social_support": 1.461, "healthy_life_expectancy": 0.532, "freedom": 0.587, "generosity": 0.233, "perceptions_of_corruption": 0.434, "dystopia_residual": 2.266},
            {"country": "Norway", "happiness_score": 7.315, "gdp_per_capita": 1.936, "social_support": 1.530, "healthy_life_expectancy": 0.538, "freedom": 0.584, "generosity": 0.228, "perceptions_of_corruption": 0.383, "dystopia_residual": 2.116},
            {"country": "Switzerland", "happiness_score": 7.240, "gdp_per_capita": 1.913, "social_support": 1.449, "healthy_life_expectancy": 0.561, "freedom": 0.572, "generosity": 0.218, "perceptions_of_corruption": 0.332, "dystopia_residual": 2.195},
            {"country": "Luxembourg", "happiness_score": 7.228, "gdp_per_capita": 2.045, "social_support": 1.387, "healthy_life_expectancy": 0.528, "freedom": 0.561, "generosity": 0.168, "perceptions_of_corruption": 0.386, "dystopia_residual": 2.153},
            {"country": "New Zealand", "happiness_score": 7.123, "gdp_per_capita": 1.762, "social_support": 1.566, "healthy_life_expectancy": 0.531, "freedom": 0.606, "generosity": 0.261, "perceptions_of_corruption": 0.362, "dystopia_residual": 2.035},
            {"country": "Austria", "happiness_score": 7.097, "gdp_per_capita": 1.855, "social_support": 1.454, "healthy_life_expectancy": 0.529, "freedom": 0.496, "generosity": 0.182, "perceptions_of_corruption": 0.332, "dystopia_residual": 2.249},
            {"country": "Australia", "happiness_score": 7.100, "gdp_per_capita": 1.806, "social_support": 1.511, "healthy_life_expectancy": 0.557, "freedom": 0.542, "generosity": 0.270, "perceptions_of_corruption": 0.308, "dystopia_residual": 2.106},
            {"country": "Ireland", "happiness_score": 7.021, "gdp_per_capita": 1.832, "social_support": 1.529, "healthy_life_expectancy": 0.517, "freedom": 0.556, "generosity": 0.233, "perceptions_of_corruption": 0.354, "dystopia_residual": 2.000},
            {"country": "Germany", "happiness_score": 7.018, "gdp_per_capita": 1.873, "social_support": 1.428, "healthy_life_expectancy": 0.537, "freedom": 0.496, "generosity": 0.219, "perceptions_of_corruption": 0.466, "dystopia_residual": 2.000},
            {"country": "Canada", "happiness_score": 6.900, "gdp_per_capita": 1.840, "social_support": 1.487, "healthy_life_expectancy": 0.548, "freedom": 0.528, "generosity": 0.240, "perceptions_of_corruption": 0.257, "dystopia_residual": 2.000},
            {"country": "United States", "happiness_score": 6.894, "gdp_per_capita": 1.910, "social_support": 1.401, "healthy_life_expectancy": 0.520, "freedom": 0.447, "generosity": 0.220, "perceptions_of_corruption": 0.396, "dystopia_residual": 2.000},
            {"country": "United Kingdom", "happiness_score": 6.796, "gdp_per_capita": 1.810, "social_support": 1.481, "healthy_life_expectancy": 0.524, "freedom": 0.474, "generosity": 0.304, "perceptions_of_corruption": 0.203, "dystopia_residual": 2.000},
            {"country": "Czech Republic", "happiness_score": 6.845, "gdp_per_capita": 1.697, "social_support": 1.508, "healthy_life_expectancy": 0.502, "freedom": 0.502, "generosity": 0.107, "perceptions_of_corruption": 0.029, "dystopia_residual": 2.500},
            {"country": "Belgium", "happiness_score": 6.805, "gdp_per_capita": 1.838, "social_support": 1.437, "healthy_life_expectancy": 0.517, "freedom": 0.444, "generosity": 0.128, "perceptions_of_corruption": 0.441, "dystopia_residual": 2.000},
            {"country": "France", "happiness_score": 6.661, "gdp_per_capita": 1.816, "social_support": 1.393, "healthy_life_expectancy": 0.553, "freedom": 0.456, "generosity": 0.103, "perceptions_of_corruption": 0.340, "dystopia_residual": 2.000},
            {"country": "Bahrain", "happiness_score": 6.647, "gdp_per_capita": 1.684, "social_support": 1.400, "healthy_life_expectancy": 0.540, "freedom": 0.498, "generosity": 0.155, "perceptions_of_corruption": 0.270, "dystopia_residual": 2.100},
            {"country": "Slovenia", "happiness_score": 6.630, "gdp_per_capita": 1.713, "social_support": 1.487, "healthy_life_expectancy": 0.514, "freedom": 0.548, "generosity": 0.121, "perceptions_of_corruption": 0.247, "dystopia_residual": 2.000},
            {"country": "Saudi Arabia", "happiness_score": 6.587, "gdp_per_capita": 1.778, "social_support": 1.310, "healthy_life_expectancy": 0.477, "freedom": 0.449, "generosity": 0.114, "perceptions_of_corruption": 0.459, "dystopia_residual": 2.000},
            {"country": "Taiwan", "happiness_score": 6.535, "gdp_per_capita": 1.695, "social_support": 1.419, "healthy_life_expectancy": 0.537, "freedom": 0.385, "generosity": 0.133, "perceptions_of_corruption": 0.166, "dystopia_residual": 2.200},
            {"country": "Singapore", "happiness_score": 6.587, "gdp_per_capita": 1.915, "social_support": 1.321, "healthy_life_expectancy": 0.664, "freedom": 0.525, "generosity": 0.180, "perceptions_of_corruption": 0.462, "dystopia_residual": 1.520},
            {"country": "Spain", "happiness_score": 6.401, "gdp_per_capita": 1.722, "social_support": 1.398, "healthy_life_expectancy": 0.562, "freedom": 0.389, "generosity": 0.140, "perceptions_of_corruption": 0.190, "dystopia_residual": 2.000},
            {"country": "Italy", "happiness_score": 6.324, "gdp_per_capita": 1.748, "social_support": 1.357, "healthy_life_expectancy": 0.541, "freedom": 0.327, "generosity": 0.141, "perceptions_of_corruption": 0.210, "dystopia_residual": 2.010},
            {"country": "South Korea", "happiness_score": 6.125, "gdp_per_capita": 1.723, "social_support": 1.247, "healthy_life_expectancy": 0.575, "freedom": 0.261, "generosity": 0.126, "perceptions_of_corruption": 0.193, "dystopia_residual": 2.000},
            {"country": "Japan", "happiness_score": 6.129, "gdp_per_capita": 1.730, "social_support": 1.332, "healthy_life_expectancy": 0.595, "freedom": 0.441, "generosity": 0.032, "perceptions_of_corruption": 0.236, "dystopia_residual": 1.763},
            {"country": "China", "happiness_score": 5.818, "gdp_per_capita": 1.336, "social_support": 1.230, "healthy_life_expectancy": 0.524, "freedom": 0.448, "generosity": 0.063, "perceptions_of_corruption": 0.217, "dystopia_residual": 2.000},
            {"country": "Thailand", "happiness_score": 6.101, "gdp_per_capita": 1.305, "social_support": 1.351, "healthy_life_expectancy": 0.504, "freedom": 0.529, "generosity": 0.374, "perceptions_of_corruption": 0.037, "dystopia_residual": 2.001},
            {"country": "Malaysia", "happiness_score": 6.012, "gdp_per_capita": 1.411, "social_support": 1.273, "healthy_life_expectancy": 0.454, "freedom": 0.489, "generosity": 0.206, "perceptions_of_corruption": 0.180, "dystopia_residual": 2.000},
            {"country": "Brazil", "happiness_score": 6.125, "gdp_per_capita": 1.250, "social_support": 1.345, "healthy_life_expectancy": 0.422, "freedom": 0.357, "generosity": 0.125, "perceptions_of_corruption": 0.626, "dystopia_residual": 2.000},
            {"country": "Mexico", "happiness_score": 6.330, "gdp_per_capita": 1.383, "social_support": 1.247, "healthy_life_expectancy": 0.418, "freedom": 0.399, "generosity": 0.089, "perceptions_of_corruption": 0.794, "dystopia_residual": 2.000},
            {"country": "Russia", "happiness_score": 5.661, "gdp_per_capita": 1.535, "social_support": 1.468, "healthy_life_expectancy": 0.375, "freedom": 0.232, "generosity": 0.066, "perceptions_of_corruption": 0.986, "dystopia_residual": 1.999},
            {"country": "India", "happiness_score": 4.036, "gdp_per_capita": 1.088, "social_support": 0.769, "healthy_life_expectancy": 0.346, "freedom": 0.462, "generosity": 0.219, "perceptions_of_corruption": 0.152, "dystopia_residual": 2.000},
            {"country": "South Africa", "happiness_score": 4.729, "gdp_per_capita": 1.237, "social_support": 1.286, "healthy_life_expectancy": 0.276, "freedom": 0.384, "generosity": 0.089, "perceptions_of_corruption": 0.858, "dystopia_residual": 1.600},
            {"country": "Nigeria", "happiness_score": 4.981, "gdp_per_capita": 0.860, "social_support": 0.842, "healthy_life_expectancy": 0.171, "freedom": 0.329, "generosity": 0.174, "perceptions_of_corruption": 0.111, "dystopia_residual": 2.493},
            {"country": "Pakistan", "happiness_score": 4.555, "gdp_per_capita": 0.837, "social_support": 0.595, "healthy_life_expectancy": 0.270, "freedom": 0.313, "generosity": 0.255, "perceptions_of_corruption": 0.098, "dystopia_residual": 2.187},
            {"country": "Afghanistan", "happiness_score": 1.859, "gdp_per_capita": 0.473, "social_support": 0.500, "healthy_life_expectancy": 0.126, "freedom": 0.131, "generosity": 0.121, "perceptions_of_corruption": 0.062, "dystopia_residual": 0.446},
        ],
        "indicators": [
            {"key": "happiness_score", "name": "Happiness Score", "unit": "0-10", "category": "Wellbeing", "higherIsBetter": True},
            {"key": "gdp_per_capita", "name": "GDP per Capita (Log)", "unit": "", "category": "Economy", "higherIsBetter": True},
            {"key": "social_support", "name": "Social Support", "unit": "", "category": "Social", "higherIsBetter": True},
            {"key": "healthy_life_expectancy", "name": "Healthy Life Expectancy", "unit": "", "category": "Health", "higherIsBetter": True},
            {"key": "freedom", "name": "Freedom to Make Life Choices", "unit": "", "category": "Governance", "higherIsBetter": True},
            {"key": "generosity", "name": "Generosity", "unit": "", "category": "Social", "higherIsBetter": True},
            {"key": "perceptions_of_corruption", "name": "Perceptions of Corruption", "unit": "", "category": "Governance", "higherIsBetter": False},
            {"key": "dystopia_residual", "name": "Dystopia + Residual", "unit": "", "category": "Wellbeing", "higherIsBetter": True},
        ]
    },
    "hdi_2022": {
        "name": "Human Development Index 2021/2022",
        "source": "UNDP",
        "category": "Development",
        "description": "HDI, life expectancy, expected/mean years of schooling, and GNI per capita.",
        "last_updated": "2022",
        "records": [
            {"country": "Switzerland", "hdi": 0.967, "life_expectancy": 84.0, "expected_schooling": 16.5, "mean_schooling": 13.9, "gni_per_capita": 66933},
            {"country": "Norway", "hdi": 0.966, "life_expectancy": 83.2, "expected_schooling": 18.2, "mean_schooling": 12.9, "gni_per_capita": 64660},
            {"country": "Iceland", "hdi": 0.959, "life_expectancy": 82.7, "expected_schooling": 19.2, "mean_schooling": 12.9, "gni_per_capita": 55782},
            {"country": "Hong Kong", "hdi": 0.952, "life_expectancy": 85.5, "expected_schooling": 17.3, "mean_schooling": 12.2, "gni_per_capita": 62507},
            {"country": "Australia", "hdi": 0.951, "life_expectancy": 83.2, "expected_schooling": 21.1, "mean_schooling": 12.7, "gni_per_capita": 49238},
            {"country": "Denmark", "hdi": 0.952, "life_expectancy": 81.4, "expected_schooling": 18.7, "mean_schooling": 12.6, "gni_per_capita": 60365},
            {"country": "Sweden", "hdi": 0.947, "life_expectancy": 83.0, "expected_schooling": 19.4, "mean_schooling": 12.6, "gni_per_capita": 54489},
            {"country": "Ireland", "hdi": 0.950, "life_expectancy": 82.1, "expected_schooling": 18.9, "mean_schooling": 11.6, "gni_per_capita": 68658},
            {"country": "Germany", "hdi": 0.950, "life_expectancy": 80.9, "expected_schooling": 17.0, "mean_schooling": 14.2, "gni_per_capita": 54534},
            {"country": "Netherlands", "hdi": 0.946, "life_expectancy": 81.7, "expected_schooling": 18.6, "mean_schooling": 12.4, "gni_per_capita": 55797},
            {"country": "Finland", "hdi": 0.942, "life_expectancy": 81.8, "expected_schooling": 19.4, "mean_schooling": 12.9, "gni_per_capita": 49678},
            {"country": "Singapore", "hdi": 0.939, "life_expectancy": 83.6, "expected_schooling": 16.4, "mean_schooling": 11.6, "gni_per_capita": 90855},
            {"country": "Belgium", "hdi": 0.942, "life_expectancy": 81.3, "expected_schooling": 15.9, "mean_schooling": 11.9, "gni_per_capita": 52293},
            {"country": "New Zealand", "hdi": 0.937, "life_expectancy": 82.2, "expected_schooling": 20.3, "mean_schooling": 12.9, "gni_per_capita": 42084},
            {"country": "Canada", "hdi": 0.936, "life_expectancy": 82.7, "expected_schooling": 16.4, "mean_schooling": 13.8, "gni_per_capita": 46808},
            {"country": "United Kingdom", "hdi": 0.940, "life_expectancy": 80.7, "expected_schooling": 17.4, "mean_schooling": 13.4, "gni_per_capita": 45225},
            {"country": "Japan", "hdi": 0.920, "life_expectancy": 84.8, "expected_schooling": 15.2, "mean_schooling": 13.0, "gni_per_capita": 42174},
            {"country": "United States", "hdi": 0.921, "life_expectancy": 77.2, "expected_schooling": 16.3, "mean_schooling": 13.4, "gni_per_capita": 64765},
            {"country": "South Korea", "hdi": 0.925, "life_expectancy": 83.7, "expected_schooling": 16.5, "mean_schooling": 12.2, "gni_per_capita": 44947},
            {"country": "Israel", "hdi": 0.919, "life_expectancy": 82.3, "expected_schooling": 16.2, "mean_schooling": 12.8, "gni_per_capita": 42257},
            {"country": "Slovenia", "hdi": 0.926, "life_expectancy": 80.8, "expected_schooling": 17.4, "mean_schooling": 12.8, "gni_per_capita": 38430},
            {"country": "Austria", "hdi": 0.926, "life_expectancy": 81.6, "expected_schooling": 16.0, "mean_schooling": 12.3, "gni_per_capita": 54814},
            {"country": "United Arab Emirates", "hdi": 0.911, "life_expectancy": 78.7, "expected_schooling": 15.7, "mean_schooling": 12.7, "gni_per_capita": 66205},
            {"country": "Spain", "hdi": 0.905, "life_expectancy": 83.3, "expected_schooling": 17.9, "mean_schooling": 10.1, "gni_per_capita": 38886},
            {"country": "France", "hdi": 0.903, "life_expectancy": 82.5, "expected_schooling": 15.5, "mean_schooling": 11.6, "gni_per_capita": 45223},
            {"country": "Italy", "hdi": 0.895, "life_expectancy": 83.1, "expected_schooling": 16.2, "mean_schooling": 10.6, "gni_per_capita": 42040},
            {"country": "Estonia", "hdi": 0.890, "life_expectancy": 77.2, "expected_schooling": 15.9, "mean_schooling": 13.1, "gni_per_capita": 34560},
            {"country": "Czech Republic", "hdi": 0.889, "life_expectancy": 78.0, "expected_schooling": 16.2, "mean_schooling": 12.9, "gni_per_capita": 33062},
            {"country": "Greece", "hdi": 0.887, "life_expectancy": 80.1, "expected_schooling": 18.0, "mean_schooling": 10.9, "gni_per_capita": 28779},
            {"country": "Poland", "hdi": 0.876, "life_expectancy": 75.6, "expected_schooling": 15.6, "mean_schooling": 12.3, "gni_per_capita": 30064},
            {"country": "Saudi Arabia", "hdi": 0.875, "life_expectancy": 75.1, "expected_schooling": 16.1, "mean_schooling": 10.1, "gni_per_capita": 53026},
            {"country": "Portugal", "hdi": 0.866, "life_expectancy": 81.0, "expected_schooling": 16.6, "mean_schooling": 9.3, "gni_per_capita": 32508},
            {"country": "Chile", "hdi": 0.860, "life_expectancy": 78.9, "expected_schooling": 16.3, "mean_schooling": 10.7, "gni_per_capita": 23920},
            {"country": "Turkey", "hdi": 0.838, "life_expectancy": 76.0, "expected_schooling": 18.3, "mean_schooling": 8.6, "gni_per_capita": 30876},
            {"country": "Uruguay", "hdi": 0.809, "life_expectancy": 75.4, "expected_schooling": 16.3, "mean_schooling": 9.0, "gni_per_capita": 21532},
            {"country": "Russia", "hdi": 0.822, "life_expectancy": 69.4, "expected_schooling": 15.0, "mean_schooling": 12.2, "gni_per_capita": 26289},
            {"country": "Argentina", "hdi": 0.842, "life_expectancy": 75.4, "expected_schooling": 17.8, "mean_schooling": 10.7, "gni_per_capita": 21587},
            {"country": "Brazil", "hdi": 0.760, "life_expectancy": 75.9, "expected_schooling": 15.6, "mean_schooling": 8.1, "gni_per_capita": 14695},
            {"country": "Mexico", "hdi": 0.758, "life_expectancy": 70.2, "expected_schooling": 14.1, "mean_schooling": 9.2, "gni_per_capita": 17875},
            {"country": "China", "hdi": 0.768, "life_expectancy": 78.2, "expected_schooling": 14.2, "mean_schooling": 8.1, "gni_per_capita": 17704},
            {"country": "Thailand", "hdi": 0.800, "life_expectancy": 77.7, "expected_schooling": 15.9, "mean_schooling": 8.6, "gni_per_capita": 17393},
            {"country": "Malaysia", "hdi": 0.803, "life_expectancy": 74.9, "expected_schooling": 14.0, "mean_schooling": 10.2, "gni_per_capita": 27931},
            {"country": "India", "hdi": 0.633, "life_expectancy": 67.2, "expected_schooling": 11.9, "mean_schooling": 6.5, "gni_per_capita": 6659},
            {"country": "South Africa", "hdi": 0.713, "life_expectancy": 64.1, "expected_schooling": 13.6, "mean_schooling": 10.6, "gni_per_capita": 12784},
            {"country": "Indonesia", "hdi": 0.705, "life_expectancy": 67.6, "expected_schooling": 13.0, "mean_schooling": 8.6, "gni_per_capita": 12022},
            {"country": "Philippines", "hdi": 0.699, "life_expectancy": 69.3, "expected_schooling": 12.6, "mean_schooling": 9.4, "gni_per_capita": 8397},
            {"country": "Vietnam", "hdi": 0.703, "life_expectancy": 73.6, "expected_schooling": 12.9, "mean_schooling": 8.4, "gni_per_capita": 7495},
            {"country": "Egypt", "hdi": 0.731, "life_expectancy": 70.2, "expected_schooling": 13.4, "mean_schooling": 7.4, "gni_per_capita": 11866},
            {"country": "Nigeria", "hdi": 0.535, "life_expectancy": 53.9, "expected_schooling": 10.1, "mean_schooling": 7.2, "gni_per_capita": 4961},
            {"country": "Pakistan", "hdi": 0.544, "life_expectancy": 66.1, "expected_schooling": 7.8, "mean_schooling": 5.2, "gni_per_capita": 4629},
            {"country": "Bangladesh", "hdi": 0.661, "life_expectancy": 72.4, "expected_schooling": 11.5, "mean_schooling": 6.4, "gni_per_capita": 5032},
            {"country": "Afghanistan", "hdi": 0.478, "life_expectancy": 62.0, "expected_schooling": 10.1, "mean_schooling": 3.0, "gni_per_capita": 1824},
        ],
        "indicators": [
            {"key": "hdi", "name": "Human Development Index", "unit": "0-1", "category": "Development", "higherIsBetter": True},
            {"key": "life_expectancy", "name": "Life Expectancy", "unit": "years", "category": "Health", "higherIsBetter": True},
            {"key": "expected_schooling", "name": "Expected Years of Schooling", "unit": "years", "category": "Education", "higherIsBetter": True},
            {"key": "mean_schooling", "name": "Mean Years of Schooling", "unit": "years", "category": "Education", "higherIsBetter": True},
            {"key": "gni_per_capita", "name": "GNI per Capita", "unit": "USD", "category": "Economy", "higherIsBetter": True},
        ]
    },
    "epi_2022": {
        "name": "Environmental Performance Index 2022",
        "source": "Yale / Columbia",
        "category": "Environment",
        "description": "Ecosystem vitality and environmental health scores.",
        "last_updated": "2022",
        "records": [
            {"country": "Denmark", "epi_score": 77.9, "environmental_health": 91.3, "ecosystem_vitality": 64.5, "air_quality": 95.3, "sanitation": 100.0, "biodiversity": 72.8},
            {"country": "United Kingdom", "epi_score": 77.7, "environmental_health": 91.5, "ecosystem_vitality": 64.0, "air_quality": 94.8, "sanitation": 100.0, "biodiversity": 71.2},
            {"country": "Finland", "epi_score": 76.5, "environmental_health": 94.1, "ecosystem_vitality": 59.0, "air_quality": 97.9, "sanitation": 100.0, "biodiversity": 68.3},
            {"country": "Malta", "epi_score": 75.2, "environmental_health": 94.5, "ecosystem_vitality": 55.9, "air_quality": 99.3, "sanitation": 100.0, "biodiversity": 65.1},
            {"country": "Sweden", "epi_score": 72.7, "environmental_health": 90.8, "ecosystem_vitality": 54.7, "air_quality": 93.2, "sanitation": 100.0, "biodiversity": 67.4},
            {"country": "Norway", "epi_score": 71.7, "environmental_health": 93.5, "ecosystem_vitality": 50.0, "air_quality": 96.7, "sanitation": 100.0, "biodiversity": 63.8},
            {"country": "Germany", "epi_score": 62.4, "environmental_health": 81.1, "ecosystem_vitality": 43.7, "air_quality": 78.2, "sanitation": 100.0, "biodiversity": 52.1},
            {"country": "Netherlands", "epi_score": 65.0, "environmental_health": 85.5, "ecosystem_vitality": 44.5, "air_quality": 84.1, "sanitation": 100.0, "biodiversity": 49.3},
            {"country": "Japan", "epi_score": 57.2, "environmental_health": 82.0, "ecosystem_vitality": 32.4, "air_quality": 78.6, "sanitation": 100.0, "biodiversity": 48.9},
            {"country": "Australia", "epi_score": 60.1, "environmental_health": 74.1, "ecosystem_vitality": 46.1, "air_quality": 72.3, "sanitation": 100.0, "biodiversity": 58.4},
            {"country": "Spain", "epi_score": 59.3, "environmental_health": 86.0, "ecosystem_vitality": 32.7, "air_quality": 85.3, "sanitation": 100.0, "biodiversity": 41.2},
            {"country": "France", "epi_score": 55.5, "environmental_health": 80.5, "ecosystem_vitality": 30.5, "air_quality": 76.8, "sanitation": 100.0, "biodiversity": 44.6},
            {"country": "Italy", "epi_score": 52.4, "environmental_health": 80.2, "ecosystem_vitality": 24.6, "air_quality": 73.1, "sanitation": 100.0, "biodiversity": 38.9},
            {"country": "South Korea", "epi_score": 46.4, "environmental_health": 66.2, "ecosystem_vitality": 26.7, "air_quality": 61.5, "sanitation": 100.0, "biodiversity": 35.2},
            {"country": "Canada", "epi_score": 50.6, "environmental_health": 78.9, "ecosystem_vitality": 22.3, "air_quality": 70.2, "sanitation": 100.0, "biodiversity": 51.7},
            {"country": "United States", "epi_score": 43.0, "environmental_health": 68.1, "ecosystem_vitality": 17.9, "air_quality": 62.3, "sanitation": 100.0, "biodiversity": 45.8},
            {"country": "China", "epi_score": 28.4, "environmental_health": 49.8, "ecosystem_vitality": 7.0, "air_quality": 38.1, "sanitation": 81.5, "biodiversity": 22.6},
            {"country": "India", "epi_score": 18.9, "environmental_health": 26.4, "ecosystem_vitality": 11.4, "air_quality": 18.2, "sanitation": 51.8, "biodiversity": 28.3},
            {"country": "Brazil", "epi_score": 46.4, "environmental_health": 62.3, "ecosystem_vitality": 30.5, "air_quality": 52.8, "sanitation": 75.6, "biodiversity": 58.9},
            {"country": "Russia", "epi_score": 38.5, "environmental_health": 61.5, "ecosystem_vitality": 15.5, "air_quality": 56.2, "sanitation": 88.4, "biodiversity": 46.1},
            {"country": "South Africa", "epi_score": 33.4, "environmental_health": 43.2, "ecosystem_vitality": 23.6, "air_quality": 37.5, "sanitation": 72.3, "biodiversity": 44.8},
            {"country": "Mexico", "epi_score": 39.5, "environmental_health": 57.8, "ecosystem_vitality": 21.2, "air_quality": 48.6, "sanitation": 78.4, "biodiversity": 42.3},
            {"country": "Indonesia", "epi_score": 37.8, "environmental_health": 51.4, "ecosystem_vitality": 24.2, "air_quality": 43.2, "sanitation": 72.5, "biodiversity": 48.6},
            {"country": "Turkey", "epi_score": 35.2, "environmental_health": 56.1, "ecosystem_vitality": 14.3, "air_quality": 46.8, "sanitation": 83.6, "biodiversity": 31.4},
            {"country": "Argentina", "epi_score": 41.5, "environmental_health": 68.2, "ecosystem_vitality": 14.8, "air_quality": 58.4, "sanitation": 82.1, "biodiversity": 39.5},
            {"country": "Nigeria", "epi_score": 24.6, "environmental_health": 24.8, "ecosystem_vitality": 24.4, "air_quality": 15.2, "sanitation": 32.4, "biodiversity": 45.2},
            {"country": "Pakistan", "epi_score": 24.1, "environmental_health": 24.5, "ecosystem_vitality": 23.7, "air_quality": 18.4, "sanitation": 38.6, "biodiversity": 41.8},
        ],
        "indicators": [
            {"key": "epi_score", "name": "EPI Score", "unit": "0-100", "category": "Environment", "higherIsBetter": True},
            {"key": "environmental_health", "name": "Environmental Health", "unit": "0-100", "category": "Environment", "higherIsBetter": True},
            {"key": "ecosystem_vitality", "name": "Ecosystem Vitality", "unit": "0-100", "category": "Environment", "higherIsBetter": True},
            {"key": "air_quality", "name": "Air Quality", "unit": "0-100", "category": "Environment", "higherIsBetter": True},
            {"key": "sanitation", "name": "Sanitation & Drinking Water", "unit": "0-100", "category": "Environment", "higherIsBetter": True},
            {"key": "biodiversity", "name": "Biodiversity & Habitat", "unit": "0-100", "category": "Environment", "higherIsBetter": True},
        ]
    },
    "peace_2023": {
        "name": "Global Peace Index 2023",
        "source": "Institute for Economics & Peace",
        "category": "Security",
        "description": "Peace index scores, safety, militarization, and ongoing conflict indicators.",
        "last_updated": "2023",
        "records": [
            {"country": "Iceland", "peace_index": 1.124, "safety_security": 1.155, "ongoing_conflict": 1.000, "militarization": 1.198, "homicide_rate": 0.964, "incarceration_rate": 0.462, "police_rate": 0.953, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Denmark", "peace_index": 1.310, "safety_security": 1.367, "ongoing_conflict": 1.111, "militarization": 1.413, "homicide_rate": 0.984, "incarceration_rate": 0.605, "police_rate": 1.095, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Ireland", "peace_index": 1.312, "safety_security": 1.384, "ongoing_conflict": 1.000, "militarization": 1.481, "homicide_rate": 0.889, "incarceration_rate": 0.589, "police_rate": 1.132, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "New Zealand", "peace_index": 1.323, "safety_security": 1.410, "ongoing_conflict": 1.000, "militarization": 1.483, "homicide_rate": 1.040, "incarceration_rate": 0.753, "police_rate": 1.202, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Austria", "peace_index": 1.316, "safety_security": 1.378, "ongoing_conflict": 1.000, "militarization": 1.475, "homicide_rate": 0.954, "incarceration_rate": 0.811, "police_rate": 1.188, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Singapore", "peace_index": 1.339, "safety_security": 1.400, "ongoing_conflict": 1.000, "militarization": 1.544, "homicide_rate": 0.225, "incarceration_rate": 1.290, "police_rate": 1.456, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Portugal", "peace_index": 1.333, "safety_security": 1.417, "ongoing_conflict": 1.000, "militarization": 1.431, "homicide_rate": 0.712, "incarceration_rate": 1.187, "police_rate": 1.270, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Slovenia", "peace_index": 1.341, "safety_security": 1.386, "ongoing_conflict": 1.000, "militarization": 1.577, "homicide_rate": 0.607, "incarceration_rate": 0.704, "police_rate": 1.388, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Japan", "peace_index": 1.336, "safety_security": 1.454, "ongoing_conflict": 1.000, "militarization": 1.429, "homicide_rate": 0.265, "incarceration_rate": 0.522, "police_rate": 1.276, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Switzerland", "peace_index": 1.350, "safety_security": 1.414, "ongoing_conflict": 1.000, "militarization": 1.534, "homicide_rate": 0.592, "incarceration_rate": 0.799, "police_rate": 1.237, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Canada", "peace_index": 1.449, "safety_security": 1.500, "ongoing_conflict": 1.167, "militarization": 1.624, "homicide_rate": 0.718, "incarceration_rate": 0.870, "police_rate": 1.280, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Czech Republic", "peace_index": 1.411, "safety_security": 1.476, "ongoing_conflict": 1.000, "militarization": 1.638, "homicide_rate": 0.715, "incarceration_rate": 1.957, "police_rate": 1.279, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Netherlands", "peace_index": 1.432, "safety_security": 1.487, "ongoing_conflict": 1.111, "militarization": 1.626, "homicide_rate": 0.728, "incarceration_rate": 0.704, "police_rate": 1.280, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Australia", "peace_index": 1.536, "safety_security": 1.539, "ongoing_conflict": 1.167, "militarization": 1.791, "homicide_rate": 0.850, "incarceration_rate": 1.474, "police_rate": 1.236, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Germany", "peace_index": 1.456, "safety_security": 1.507, "ongoing_conflict": 1.222, "militarization": 1.562, "homicide_rate": 0.804, "incarceration_rate": 0.784, "police_rate": 1.243, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Norway", "peace_index": 1.465, "safety_security": 1.504, "ongoing_conflict": 1.222, "militarization": 1.597, "homicide_rate": 0.565, "incarceration_rate": 0.603, "police_rate": 1.280, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Sweden", "peace_index": 1.488, "safety_security": 1.536, "ongoing_conflict": 1.111, "militarization": 1.694, "homicide_rate": 1.112, "incarceration_rate": 0.676, "police_rate": 1.360, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Finland", "peace_index": 1.474, "safety_security": 1.522, "ongoing_conflict": 1.222, "militarization": 1.615, "homicide_rate": 1.290, "incarceration_rate": 0.566, "police_rate": 1.403, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Hungary", "peace_index": 1.502, "safety_security": 1.516, "ongoing_conflict": 1.000, "militarization": 1.789, "homicide_rate": 0.746, "incarceration_rate": 1.693, "police_rate": 1.456, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Spain", "peace_index": 1.536, "safety_security": 1.546, "ongoing_conflict": 1.222, "militarization": 1.714, "homicide_rate": 0.612, "incarceration_rate": 1.291, "police_rate": 1.385, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "Belgium", "peace_index": 1.536, "safety_security": 1.552, "ongoing_conflict": 1.000, "militarization": 1.798, "homicide_rate": 0.889, "incarceration_rate": 0.880, "police_rate": 1.490, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "United Kingdom", "peace_index": 1.606, "safety_security": 1.596, "ongoing_conflict": 1.556, "militarization": 1.662, "homicide_rate": 1.035, "incarceration_rate": 1.312, "police_rate": 1.305, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "France", "peace_index": 1.629, "safety_security": 1.622, "ongoing_conflict": 1.444, "militarization": 1.764, "homicide_rate": 1.232, "incarceration_rate": 0.980, "police_rate": 1.355, "terrorism_impact": 1.000, "weapons_exports": 1.706},
            {"country": "United States", "peace_index": 2.448, "safety_security": 2.350, "ongoing_conflict": 2.333, "militarization": 2.586, "homicide_rate": 5.000, "incarceration_rate": 4.598, "police_rate": 2.350, "terrorism_impact": 2.000, "weapons_exports": 4.000},
            {"country": "Russia", "peace_index": 3.093, "safety_security": 3.000, "ongoing_conflict": 3.667, "militarization": 2.838, "homicide_rate": 5.000, "incarceration_rate": 3.522, "police_rate": 2.800, "terrorism_impact": 3.000, "weapons_exports": 4.000},
            {"country": "China", "peace_index": 2.101, "safety_security": 2.150, "ongoing_conflict": 1.667, "militarization": 2.322, "homicide_rate": 1.100, "incarceration_rate": 1.500, "police_rate": 1.900, "terrorism_impact": 1.500, "weapons_exports": 3.000},
            {"country": "Brazil", "peace_index": 2.470, "safety_security": 2.500, "ongoing_conflict": 1.667, "militarization": 3.000, "homicide_rate": 3.800, "incarceration_rate": 2.800, "police_rate": 2.400, "terrorism_impact": 2.000, "weapons_exports": 2.500},
            {"country": "India", "peace_index": 2.356, "safety_security": 2.400, "ongoing_conflict": 2.000, "militarization": 2.500, "homicide_rate": 3.000, "incarceration_rate": 2.100, "police_rate": 2.300, "terrorism_impact": 2.500, "weapons_exports": 2.000},
            {"country": "South Africa", "peace_index": 2.507, "safety_security": 2.600, "ongoing_conflict": 1.667, "militarization": 2.900, "homicide_rate": 4.200, "incarceration_rate": 3.000, "police_rate": 2.500, "terrorism_impact": 2.200, "weapons_exports": 2.500},
            {"country": "Nigeria", "peace_index": 2.845, "safety_security": 2.900, "ongoing_conflict": 2.667, "militarization": 3.100, "homicide_rate": 3.500, "incarceration_rate": 2.400, "police_rate": 2.800, "terrorism_impact": 3.000, "weapons_exports": 2.000},
        ],
        "indicators": [
            {"key": "peace_index", "name": "Overall Peace Index", "unit": "", "category": "Security", "higherIsBetter": False},
            {"key": "safety_security", "name": "Safety & Security", "unit": "", "category": "Security", "higherIsBetter": False},
            {"key": "ongoing_conflict", "name": "Ongoing Conflict", "unit": "", "category": "Security", "higherIsBetter": False},
            {"key": "militarization", "name": "Militarization", "unit": "", "category": "Security", "higherIsBetter": False},
            {"key": "homicide_rate", "name": "Homicide Rate", "unit": "", "category": "Security", "higherIsBetter": False},
            {"key": "incarceration_rate", "name": "Incarceration Rate", "unit": "", "category": "Security", "higherIsBetter": False},
            {"key": "police_rate", "name": "Police Rate", "unit": "", "category": "Security", "higherIsBetter": False},
            {"key": "terrorism_impact", "name": "Terrorism Impact", "unit": "", "category": "Security", "higherIsBetter": False},
            {"key": "weapons_exports", "name": "Weapons Exports", "unit": "", "category": "Security", "higherIsBetter": False},
        ]
    },
    "press_freedom_2023": {
        "name": "Press Freedom Index 2023",
        "source": "Reporters Without Borders",
        "category": "Governance",
        "description": "Press freedom scores, safety of journalists, and media independence.",
        "last_updated": "2023",
        "records": [
            {"country": "Norway", "press_freedom_score": 95.18, "political_context": 96.20, "economic_context": 95.56, "legal_framework": 97.30, "safety": 92.53, "sociocultural_context": 95.32},
            {"country": "Ireland", "press_freedom_score": 89.91, "political_context": 92.35, "economic_context": 88.89, "legal_framework": 92.06, "safety": 87.50, "sociocultural_context": 88.78},
            {"country": "Denmark", "press_freedom_score": 89.48, "political_context": 93.56, "economic_context": 88.24, "legal_framework": 93.33, "safety": 85.00, "sociocultural_context": 86.79},
            {"country": "Sweden", "press_freedom_score": 88.15, "political_context": 92.94, "economic_context": 86.11, "legal_framework": 91.18, "safety": 82.50, "sociocultural_context": 88.21},
            {"country": "Finland", "press_freedom_score": 87.94, "political_context": 92.94, "economic_context": 86.11, "legal_framework": 90.59, "safety": 82.50, "sociocultural_context": 88.21},
            {"country": "Netherlands", "press_freedom_score": 87.43, "political_context": 92.35, "economic_context": 85.00, "legal_framework": 90.59, "safety": 82.50, "sociocultural_context": 86.79},
            {"country": "Switzerland", "press_freedom_score": 89.13, "political_context": 93.56, "economic_context": 87.22, "legal_framework": 92.94, "safety": 85.00, "sociocultural_context": 88.04},
            {"country": "Jamaica", "press_freedom_score": 84.56, "political_context": 90.59, "economic_context": 82.78, "legal_framework": 87.65, "safety": 80.00, "sociocultural_context": 81.84},
            {"country": "New Zealand", "press_freedom_score": 86.12, "political_context": 91.18, "economic_context": 84.44, "legal_framework": 89.41, "safety": 82.50, "sociocultural_context": 83.31},
            {"country": "Portugal", "press_freedom_score": 85.77, "political_context": 90.59, "economic_context": 83.89, "legal_framework": 89.41, "safety": 80.00, "sociocultural_context": 85.04},
            {"country": "Germany", "press_freedom_score": 84.61, "political_context": 90.00, "economic_context": 82.22, "legal_framework": 88.24, "safety": 80.00, "sociocultural_context": 82.64},
            {"country": "Belgium", "press_freedom_score": 83.74, "political_context": 89.41, "economic_context": 81.67, "legal_framework": 87.06, "safety": 78.75, "sociocultural_context": 81.84},
            {"country": "Canada", "press_freedom_score": 83.62, "press_freedom_score": 83.62, "political_context": 89.41, "economic_context": 81.11, "legal_framework": 87.65, "safety": 77.50, "sociocultural_context": 82.64},
            {"country": "Australia", "press_freedom_score": 82.15, "political_context": 88.24, "economic_context": 79.44, "legal_framework": 85.88, "safety": 77.50, "sociocultural_context": 80.78},
            {"country": "Japan", "press_freedom_score": 76.59, "political_context": 82.94, "economic_context": 76.67, "legal_framework": 82.35, "safety": 70.00, "sociocultural_context": 70.93},
            {"country": "United Kingdom", "press_freedom_score": 71.58, "political_context": 78.24, "economic_context": 72.22, "legal_framework": 78.24, "safety": 67.50, "sociocultural_context": 62.73},
            {"country": "France", "press_freedom_score": 70.67, "political_context": 77.65, "economic_context": 71.11, "legal_framework": 77.06, "safety": 65.00, "sociocultural_context": 62.73},
            {"country": "United States", "press_freedom_score": 71.22, "political_context": 77.06, "economic_context": 71.67, "legal_framework": 77.06, "safety": 67.50, "sociocultural_context": 62.73},
            {"country": "South Korea", "press_freedom_score": 66.97, "political_context": 72.35, "economic_context": 66.67, "legal_framework": 72.35, "safety": 60.00, "sociocultural_context": 63.46},
            {"country": "Spain", "press_freedom_score": 73.65, "political_context": 80.00, "economic_context": 75.56, "legal_framework": 80.59, "safety": 65.00, "sociocultural_context": 67.19},
            {"country": "Italy", "press_freedom_score": 66.56, "political_context": 72.35, "economic_context": 65.56, "legal_framework": 72.35, "safety": 57.50, "sociocultural_context": 65.08},
            {"country": "Poland", "press_freedom_score": 60.98, "political_context": 66.47, "economic_context": 60.56, "legal_framework": 67.06, "safety": 52.50, "sociocultural_context": 58.30},
            {"country": "Brazil", "press_freedom_score": 52.44, "political_context": 56.47, "economic_context": 50.56, "legal_framework": 56.47, "safety": 47.50, "sociocultural_context": 51.26},
            {"country": "India", "press_freedom_score": 36.62, "political_context": 39.41, "economic_context": 34.44, "legal_framework": 40.59, "safety": 32.50, "sociocultural_context": 36.20},
            {"country": "Turkey", "press_freedom_score": 28.64, "political_context": 28.24, "economic_context": 28.89, "legal_framework": 28.24, "safety": 27.50, "sociocultural_context": 30.31},
            {"country": "Russia", "press_freedom_score": 28.82, "political_context": 28.24, "economic_context": 29.44, "legal_framework": 28.24, "safety": 27.50, "sociocultural_context": 30.68},
            {"country": "China", "press_freedom_score": 25.08, "political_context": 25.88, "economic_context": 24.44, "legal_framework": 25.88, "safety": 25.00, "sociocultural_context": 24.26},
            {"country": "Nigeria", "press_freedom_score": 26.72, "political_context": 26.47, "economic_context": 26.67, "legal_framework": 26.47, "safety": 25.00, "sociocultural_context": 29.03},
        ],
        "indicators": [
            {"key": "press_freedom_score", "name": "Press Freedom Score", "unit": "0-100", "category": "Governance", "higherIsBetter": True},
            {"key": "political_context", "name": "Political Context", "unit": "0-100", "category": "Governance", "higherIsBetter": True},
            {"key": "economic_context", "name": "Economic Context", "unit": "0-100", "category": "Governance", "higherIsBetter": True},
            {"key": "legal_framework", "name": "Legal Framework", "unit": "0-100", "category": "Governance", "higherIsBetter": True},
            {"key": "safety", "name": "Safety of Journalists", "unit": "0-100", "category": "Governance", "higherIsBetter": True},
            {"key": "sociocultural_context", "name": "Sociocultural Context", "unit": "0-100", "category": "Governance", "higherIsBetter": True},
        ]
    },
    "gini_ref_2022": {
        "name": "Income Inequality Reference Dataset",
        "source": "World Bank",
        "category": "Social",
        "description": "Gini index and income share held by various percentiles.",
        "last_updated": "2022",
        "records": [
            {"country": "South Africa", "gini": 63.0, "income_share_lowest_20": 2.5, "income_share_highest_10": 55.0, "income_share_highest_20": 68.0, "palma_ratio": 7.1},
            {"country": "Brazil", "gini": 53.4, "income_share_lowest_20": 3.2, "income_share_highest_10": 43.0, "income_share_highest_20": 57.0, "palma_ratio": 4.8},
            {"country": "Mexico", "gini": 45.4, "income_share_lowest_20": 4.5, "income_share_highest_10": 36.0, "income_share_highest_20": 51.0, "palma_ratio": 3.3},
            {"country": "United States", "gini": 41.5, "income_share_lowest_20": 5.2, "income_share_highest_10": 30.0, "income_share_highest_20": 46.0, "palma_ratio": 2.5},
            {"country": "China", "gini": 38.2, "income_share_lowest_20": 6.0, "income_share_highest_10": 28.0, "income_share_highest_20": 43.0, "palma_ratio": 2.1},
            {"country": "Russia", "gini": 36.0, "income_share_lowest_20": 6.5, "income_share_highest_10": 26.0, "income_share_highest_20": 41.0, "palma_ratio": 1.8},
            {"country": "Turkey", "gini": 41.9, "income_share_lowest_20": 5.5, "income_share_highest_10": 32.0, "income_share_highest_20": 48.0, "palma_ratio": 2.7},
            {"country": "Argentina", "gini": 42.3, "income_share_lowest_20": 4.8, "income_share_highest_10": 32.5, "income_share_highest_20": 49.0, "palma_ratio": 2.8},
            {"country": "India", "gini": 35.7, "income_share_lowest_20": 7.0, "income_share_highest_10": 26.5, "income_share_highest_20": 41.0, "palma_ratio": 1.7},
            {"country": "United Kingdom", "gini": 35.1, "income_share_lowest_20": 6.8, "income_share_highest_10": 27.0, "income_share_highest_20": 42.0, "palma_ratio": 1.8},
            {"country": "Germany", "gini": 31.7, "income_share_lowest_20": 8.2, "income_share_highest_10": 23.0, "income_share_highest_20": 37.0, "palma_ratio": 1.3},
            {"country": "France", "gini": 32.7, "income_share_lowest_20": 7.8, "income_share_highest_10": 24.0, "income_share_highest_20": 39.0, "palma_ratio": 1.4},
            {"country": "Japan", "gini": 32.9, "income_share_lowest_20": 7.5, "income_share_highest_10": 24.5, "income_share_highest_20": 39.0, "palma_ratio": 1.4},
            {"country": "South Korea", "gini": 31.4, "income_share_lowest_20": 8.0, "income_share_highest_10": 23.5, "income_share_highest_20": 38.0, "palma_ratio": 1.3},
            {"country": "Canada", "gini": 33.3, "income_share_lowest_20": 7.5, "income_share_highest_10": 25.0, "income_share_highest_20": 40.0, "palma_ratio": 1.5},
            {"country": "Australia", "gini": 34.3, "income_share_lowest_20": 7.2, "income_share_highest_10": 26.0, "income_share_highest_20": 41.0, "palma_ratio": 1.6},
            {"country": "Spain", "gini": 34.3, "income_share_lowest_20": 7.0, "income_share_highest_10": 26.0, "income_share_highest_20": 41.0, "palma_ratio": 1.6},
            {"country": "Italy", "gini": 35.2, "income_share_lowest_20": 6.8, "income_share_highest_10": 27.0, "income_share_highest_20": 42.0, "palma_ratio": 1.7},
            {"country": "Poland", "gini": 30.2, "income_share_lowest_20": 8.5, "income_share_highest_10": 22.0, "income_share_highest_20": 36.0, "palma_ratio": 1.2},
            {"country": "Sweden", "gini": 28.8, "income_share_lowest_20": 9.0, "income_share_highest_10": 21.0, "income_share_highest_20": 34.0, "palma_ratio": 1.0},
            {"country": "Norway", "gini": 27.6, "income_share_lowest_20": 9.5, "income_share_highest_10": 20.0, "income_share_highest_20": 33.0, "palma_ratio": 0.9},
            {"country": "Denmark", "gini": 27.7, "income_share_lowest_20": 9.4, "income_share_highest_10": 20.5, "income_share_highest_20": 33.0, "palma_ratio": 0.9},
            {"country": "Finland", "gini": 27.3, "income_share_lowest_20": 9.6, "income_share_highest_10": 20.0, "income_share_highest_20": 32.0, "palma_ratio": 0.9},
        ],
        "indicators": [
            {"key": "gini", "name": "Gini Index", "unit": "0-100", "category": "Social", "higherIsBetter": False},
            {"key": "income_share_lowest_20", "name": "Income Share Lowest 20%", "unit": "%", "category": "Social", "higherIsBetter": True},
            {"key": "income_share_highest_10", "name": "Income Share Highest 10%", "unit": "%", "category": "Social", "higherIsBetter": False},
            {"key": "income_share_highest_20", "name": "Income Share Highest 20%", "unit": "%", "category": "Social", "higherIsBetter": False},
            {"key": "palma_ratio", "name": "Palma Ratio", "unit": "", "category": "Social", "higherIsBetter": False},
        ]
    },
    "corruption_perceptions_2023": {
        "name": "Corruption Perceptions Index 2023",
        "source": "Transparency International",
        "category": "Governance",
        "description": "Perceived levels of public sector corruption across countries.",
        "last_updated": "2023",
        "records": [
            {"country": "Denmark", "cpi_score": 90, "rank": 1},
            {"country": "Finland", "cpi_score": 87, "rank": 2},
            {"country": "New Zealand", "cpi_score": 85, "rank": 3},
            {"country": "Norway", "cpi_score": 84, "rank": 4},
            {"country": "Singapore", "cpi_score": 83, "rank": 5},
            {"country": "Sweden", "cpi_score": 82, "rank": 6},
            {"country": "Switzerland", "cpi_score": 82, "rank": 7},
            {"country": "Netherlands", "cpi_score": 78, "rank": 8},
            {"country": "Germany", "cpi_score": 78, "rank": 9},
            {"country": "Australia", "cpi_score": 77, "rank": 10},
            {"country": "Canada", "cpi_score": 76, "rank": 11},
            {"country": "Iceland", "cpi_score": 72, "rank": 12},
            {"country": "Hong Kong", "cpi_score": 75, "rank": 14},
            {"country": "United Kingdom", "cpi_score": 71, "rank": 20},
            {"country": "Japan", "cpi_score": 73, "rank": 16},
            {"country": "France", "cpi_score": 71, "rank": 21},
            {"country": "United States", "cpi_score": 69, "rank": 24},
            {"country": "South Korea", "cpi_score": 63, "rank": 32},
            {"country": "Spain", "cpi_score": 60, "rank": 38},
            {"country": "Italy", "cpi_score": 56, "rank": 42},
            {"country": "Poland", "cpi_score": 54, "rank": 47},
            {"country": "China", "cpi_score": 42, "rank": 76},
            {"country": "India", "cpi_score": 39, "rank": 85},
            {"country": "Turkey", "cpi_score": 36, "rank": 98},
            {"country": "Russia", "cpi_score": 26, "rank": 141},
            {"country": "Brazil", "cpi_score": 36, "rank": 100},
            {"country": "South Africa", "cpi_score": 41, "rank": 83},
            {"country": "Mexico", "cpi_score": 31, "rank": 126},
            {"country": "Nigeria", "cpi_score": 25, "rank": 145},
            {"country": "Pakistan", "cpi_score": 29, "rank": 133},
            {"country": "Afghanistan", "cpi_score": 20, "rank": 162},
            {"country": "Argentina", "cpi_score": 37, "rank": 96},
        ],
        "indicators": [
            {"key": "cpi_score", "name": "CPI Score", "unit": "0-100", "category": "Governance", "higherIsBetter": True},
            {"key": "rank", "name": "Global Rank", "unit": "", "category": "Governance", "higherIsBetter": False},
        ]
    },
    "labor_rights_2023": {
        "name": "Global Rights Index 2023",
        "source": "ITUC",
        "category": "Labor",
        "description": "Workers' rights, collective bargaining, and trade union indicators.",
        "last_updated": "2023",
        "records": [
            {"country": "Denmark", "workers_rights_score": 95, "collective_bargaining": 98, "trade_union_rights": 96, "freedom_of_association": 95, "right_to_strike": 94, "right_to_collective_bargaining": 96},
            {"country": "Sweden", "workers_rights_score": 95, "collective_bargaining": 97, "trade_union_rights": 95, "freedom_of_association": 96, "right_to_strike": 94, "right_to_collective_bargaining": 96},
            {"country": "Finland", "workers_rights_score": 94, "collective_bargaining": 96, "trade_union_rights": 94, "freedom_of_association": 95, "right_to_strike": 93, "right_to_collective_bargaining": 95},
            {"country": "Norway", "workers_rights_score": 94, "collective_bargaining": 97, "trade_union_rights": 95, "freedom_of_association": 94, "right_to_strike": 93, "right_to_collective_bargaining": 95},
            {"country": "Netherlands", "workers_rights_score": 89, "collective_bargaining": 92, "trade_union_rights": 90, "freedom_of_association": 88, "right_to_strike": 85, "right_to_collective_bargaining": 92},
            {"country": "Germany", "workers_rights_score": 88, "collective_bargaining": 91, "trade_union_rights": 89, "freedom_of_association": 87, "right_to_strike": 84, "right_to_collective_bargaining": 90},
            {"country": "Austria", "workers_rights_score": 87, "collective_bargaining": 90, "trade_union_rights": 88, "freedom_of_association": 86, "right_to_strike": 83, "right_to_collective_bargaining": 89},
            {"country": "Belgium", "workers_rights_score": 87, "collective_bargaining": 90, "trade_union_rights": 88, "freedom_of_association": 86, "right_to_strike": 84, "right_to_collective_bargaining": 88},
            {"country": "France", "workers_rights_score": 82, "collective_bargaining": 85, "trade_union_rights": 83, "freedom_of_association": 81, "right_to_strike": 80, "right_to_collective_bargaining": 84},
            {"country": "United Kingdom", "workers_rights_score": 78, "collective_bargaining": 80, "trade_union_rights": 79, "freedom_of_association": 77, "right_to_strike": 75, "right_to_collective_bargaining": 80},
            {"country": "Canada", "workers_rights_score": 76, "collective_bargaining": 79, "trade_union_rights": 77, "freedom_of_association": 75, "right_to_strike": 74, "right_to_collective_bargaining": 77},
            {"country": "Australia", "workers_rights_score": 75, "collective_bargaining": 78, "trade_union_rights": 76, "freedom_of_association": 74, "right_to_strike": 73, "right_to_collective_bargaining": 76},
            {"country": "United States", "workers_rights_score": 72, "collective_bargaining": 74, "trade_union_rights": 73, "freedom_of_association": 71, "right_to_strike": 70, "right_to_collective_bargaining": 73},
            {"country": "Japan", "workers_rights_score": 70, "collective_bargaining": 73, "trade_union_rights": 71, "freedom_of_association": 69, "right_to_strike": 68, "right_to_collective_bargaining": 70},
            {"country": "South Korea", "workers_rights_score": 65, "collective_bargaining": 68, "trade_union_rights": 66, "freedom_of_association": 64, "right_to_strike": 62, "right_to_collective_bargaining": 66},
            {"country": "Spain", "workers_rights_score": 72, "collective_bargaining": 75, "trade_union_rights": 73, "freedom_of_association": 71, "right_to_strike": 70, "right_to_collective_bargaining": 72},
            {"country": "Italy", "workers_rights_score": 71, "collective_bargaining": 74, "trade_union_rights": 72, "freedom_of_association": 70, "right_to_strike": 69, "right_to_collective_bargaining": 71},
            {"country": "Poland", "workers_rights_score": 68, "collective_bargaining": 71, "trade_union_rights": 69, "freedom_of_association": 67, "right_to_strike": 65, "right_to_collective_bargaining": 68},
            {"country": "Brazil", "workers_rights_score": 52, "collective_bargaining": 55, "trade_union_rights": 53, "freedom_of_association": 51, "right_to_strike": 50, "right_to_collective_bargaining": 52},
            {"country": "Mexico", "workers_rights_score": 48, "collective_bargaining": 50, "trade_union_rights": 49, "freedom_of_association": 47, "right_to_strike": 46, "right_to_collective_bargaining": 48},
            {"country": "India", "workers_rights_score": 42, "collective_bargaining": 44, "trade_union_rights": 43, "freedom_of_association": 41, "right_to_strike": 40, "right_to_collective_bargaining": 42},
            {"country": "Turkey", "workers_rights_score": 35, "collective_bargaining": 37, "trade_union_rights": 36, "freedom_of_association": 34, "right_to_strike": 33, "right_to_collective_bargaining": 35},
            {"country": "Russia", "workers_rights_score": 30, "collective_bargaining": 32, "trade_union_rights": 31, "freedom_of_association": 29, "right_to_strike": 28, "right_to_collective_bargaining": 30},
            {"country": "China", "workers_rights_score": 25, "collective_bargaining": 27, "trade_union_rights": 26, "freedom_of_association": 24, "right_to_strike": 23, "right_to_collective_bargaining": 25},
            {"country": "Nigeria", "workers_rights_score": 38, "collective_bargaining": 40, "trade_union_rights": 39, "freedom_of_association": 37, "right_to_strike": 36, "right_to_collective_bargaining": 38},
        ],
        "indicators": [
            {"key": "workers_rights_score", "name": "Workers Rights Score", "unit": "0-100", "category": "Labor", "higherIsBetter": True},
            {"key": "collective_bargaining", "name": "Collective Bargaining", "unit": "0-100", "category": "Labor", "higherIsBetter": True},
            {"key": "trade_union_rights", "name": "Trade Union Rights", "unit": "0-100", "category": "Labor", "higherIsBetter": True},
            {"key": "freedom_of_association", "name": "Freedom of Association", "unit": "0-100", "category": "Labor", "higherIsBetter": True},
            {"key": "right_to_strike", "name": "Right to Strike", "unit": "0-100", "category": "Labor", "higherIsBetter": True},
            {"key": "right_to_collective_bargaining", "name": "Right to Collective Bargaining", "unit": "0-100", "category": "Labor", "higherIsBetter": True},
        ]
    },
    "cybersecurity_2023": {
        "name": "Global Cybersecurity Index 2023",
        "source": "ITU",
        "category": "Technology",
        "description": "Cybersecurity readiness, legal frameworks, and technical capacity.",
        "last_updated": "2023",
        "records": [
            {"country": "United States", "cybersecurity_score": 100.0, "legal": 20.0, "technical": 19.0, "organizational": 18.0, "capacity_building": 18.5, "cooperation": 18.0},
            {"country": "United Kingdom", "cybersecurity_score": 99.5, "legal": 19.5, "technical": 19.0, "organizational": 18.5, "capacity_building": 18.0, "cooperation": 18.5},
            {"country": "Saudi Arabia", "cybersecurity_score": 99.5, "legal": 19.5, "technical": 19.5, "organizational": 18.0, "capacity_building": 18.0, "cooperation": 18.5},
            {"country": "Estonia", "cybersecurity_score": 99.5, "legal": 19.5, "technical": 19.0, "organizational": 18.5, "capacity_building": 18.5, "cooperation": 18.5},
            {"country": "South Korea", "cybersecurity_score": 98.5, "legal": 19.5, "technical": 19.5, "organizational": 18.0, "capacity_building": 18.0, "cooperation": 18.5},
            {"country": "Singapore", "cybersecurity_score": 98.0, "legal": 19.5, "technical": 19.0, "organizational": 18.0, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "Spain", "cybersecurity_score": 97.5, "legal": 19.0, "technical": 18.5, "organizational": 18.0, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "Russia", "cybersecurity_score": 97.0, "legal": 18.5, "technical": 19.5, "organizational": 18.0, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "United Arab Emirates", "cybersecurity_score": 97.0, "legal": 19.0, "technical": 19.0, "organizational": 18.0, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "Malaysia", "cybersecurity_score": 96.5, "legal": 19.0, "technical": 18.5, "organizational": 17.5, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "Lithuania", "cybersecurity_score": 96.5, "legal": 19.0, "technical": 18.5, "organizational": 18.0, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "Japan", "cybersecurity_score": 96.0, "legal": 19.0, "technical": 18.5, "organizational": 17.5, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "Canada", "cybersecurity_score": 95.5, "legal": 18.5, "technical": 18.5, "organizational": 17.5, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "France", "cybersecurity_score": 95.0, "legal": 18.5, "technical": 18.5, "organizational": 17.5, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "Germany", "cybersecurity_score": 94.5, "legal": 18.5, "technical": 18.0, "organizational": 17.5, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "India", "cybersecurity_score": 93.5, "legal": 18.5, "technical": 18.0, "organizational": 17.5, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "Australia", "cybersecurity_score": 93.0, "legal": 18.0, "technical": 18.0, "organizational": 17.5, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "Brazil", "cybersecurity_score": 92.5, "legal": 18.0, "technical": 17.5, "organizational": 17.5, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "China", "cybersecurity_score": 92.0, "legal": 18.0, "technical": 18.0, "organizational": 17.5, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "Turkey", "cybersecurity_score": 91.0, "legal": 17.5, "technical": 17.5, "organizational": 17.5, "capacity_building": 18.0, "cooperation": 18.0},
            {"country": "South Africa", "cybersecurity_score": 89.0, "legal": 17.0, "technical": 17.0, "organizational": 17.0, "capacity_building": 17.5, "cooperation": 18.0},
            {"country": "Nigeria", "cybersecurity_score": 82.0, "legal": 15.5, "technical": 15.5, "organizational": 15.5, "capacity_building": 16.0, "cooperation": 17.0},
            {"country": "Pakistan", "cybersecurity_score": 80.0, "legal": 15.0, "technical": 15.0, "organizational": 15.0, "capacity_building": 15.5, "cooperation": 16.0},
        ],
        "indicators": [
            {"key": "cybersecurity_score", "name": "Cybersecurity Score", "unit": "0-100", "category": "Technology", "higherIsBetter": True},
            {"key": "legal", "name": "Legal Framework", "unit": "0-20", "category": "Technology", "higherIsBetter": True},
            {"key": "technical", "name": "Technical Measures", "unit": "0-20", "category": "Technology", "higherIsBetter": True},
            {"key": "organizational", "name": "Organizational Measures", "unit": "0-20", "category": "Technology", "higherIsBetter": True},
            {"key": "capacity_building", "name": "Capacity Building", "unit": "0-20", "category": "Technology", "higherIsBetter": True},
            {"key": "cooperation", "name": "Cooperation", "unit": "0-20", "category": "Technology", "higherIsBetter": True},
        ]
    },
    "food_security_2023": {
        "name": "Global Food Security Index 2022",
        "source": "Economist Impact",
        "category": "Food",
        "description": "Affordability, availability, quality, and safety of food.",
        "last_updated": "2022",
        "records": [
            {"country": "Finland", "food_security_score": 85.3, "affordability": 89.5, "availability": 82.1, "quality_safety": 87.4, "sustainability_adaptation": 82.2},
            {"country": "Ireland", "food_security_score": 84.0, "affordability": 87.2, "availability": 81.5, "quality_safety": 86.8, "sustainability_adaptation": 80.5},
            {"country": "Norway", "food_security_score": 83.8, "affordability": 86.5, "availability": 81.8, "quality_safety": 86.2, "sustainability_adaptation": 80.7},
            {"country": "France", "food_security_score": 82.5, "affordability": 85.8, "availability": 80.2, "quality_safety": 85.1, "sustainability_adaptation": 78.9},
            {"country": "Netherlands", "food_security_score": 82.1, "affordability": 85.2, "availability": 79.8, "quality_safety": 84.5, "sustainability_adaptation": 78.8},
            {"country": "Canada", "food_security_score": 81.5, "affordability": 84.8, "availability": 79.5, "quality_safety": 83.8, "sustainability_adaptation": 77.9},
            {"country": "Japan", "food_security_score": 80.2, "affordability": 83.5, "availability": 78.2, "quality_safety": 82.4, "sustainability_adaptation": 76.7},
            {"country": "Sweden", "food_security_score": 80.5, "affordability": 83.8, "availability": 78.5, "quality_safety": 82.8, "sustainability_adaptation": 76.9},
            {"country": "United Kingdom", "food_security_score": 79.8, "affordability": 83.2, "availability": 77.8, "quality_safety": 82.1, "sustainability_adaptation": 76.1},
            {"country": "United States", "food_security_score": 78.5, "affordability": 82.5, "availability": 76.5, "quality_safety": 80.8, "sustainability_adaptation": 74.2},
            {"country": "Germany", "food_security_score": 79.2, "affordability": 82.8, "availability": 77.2, "quality_safety": 81.5, "sustainability_adaptation": 75.4},
            {"country": "Australia", "food_security_score": 78.8, "affordability": 82.2, "availability": 76.8, "quality_safety": 81.2, "sustainability_adaptation": 75.0},
            {"country": "Austria", "food_security_score": 78.2, "affordability": 81.5, "availability": 76.2, "quality_safety": 80.5, "sustainability_adaptation": 74.5},
            {"country": "New Zealand", "food_security_score": 77.5, "affordability": 80.8, "availability": 75.5, "quality_safety": 79.8, "sustainability_adaptation": 73.8},
            {"country": "Switzerland", "food_security_score": 77.2, "affordability": 80.5, "availability": 75.2, "quality_safety": 79.5, "sustainability_adaptation": 73.5},
            {"country": "Denmark", "food_security_score": 77.8, "affordability": 81.2, "availability": 75.8, "quality_safety": 80.2, "sustainability_adaptation": 74.0},
            {"country": "South Korea", "food_security_score": 74.5, "affordability": 78.5, "availability": 72.5, "quality_safety": 77.2, "sustainability_adaptation": 70.1},
            {"country": "Spain", "food_security_score": 75.2, "affordability": 79.2, "availability": 73.2, "quality_safety": 77.8, "sustainability_adaptation": 70.5},
            {"country": "Italy", "food_security_score": 74.8, "affordability": 78.8, "availability": 72.8, "quality_safety": 77.5, "sustainability_adaptation": 70.2},
            {"country": "Chile", "food_security_score": 68.5, "affordability": 72.5, "availability": 66.2, "quality_safety": 71.2, "sustainability_adaptation": 64.2},
            {"country": "China", "food_security_score": 71.2, "affordability": 75.2, "availability": 69.5, "quality_safety": 74.2, "sustainability_adaptation": 66.0},
            {"country": "Brazil", "food_security_score": 65.8, "affordability": 68.5, "availability": 63.8, "quality_safety": 68.5, "sustainability_adaptation": 62.4},
            {"country": "Russia", "food_security_score": 66.2, "affordability": 69.2, "availability": 64.2, "quality_safety": 69.0, "sustainability_adaptation": 62.5},
            {"country": "Turkey", "food_security_score": 62.5, "affordability": 65.2, "availability": 60.5, "quality_safety": 65.2, "sustainability_adaptation": 59.0},
            {"country": "South Africa", "food_security_score": 58.2, "affordability": 60.5, "availability": 56.2, "quality_safety": 61.2, "sustainability_adaptation": 55.0},
            {"country": "India", "food_security_score": 55.8, "affordability": 58.2, "availability": 53.5, "quality_safety": 58.5, "sustainability_adaptation": 52.8},
            {"country": "Nigeria", "food_security_score": 48.5, "affordability": 50.2, "availability": 46.8, "quality_safety": 51.2, "sustainability_adaptation": 45.8},
            {"country": "Pakistan", "food_security_score": 46.2, "affordability": 48.5, "availability": 44.5, "quality_safety": 49.2, "sustainability_adaptation": 43.0},
        ],
        "indicators": [
            {"key": "food_security_score", "name": "Food Security Score", "unit": "0-100", "category": "Food", "higherIsBetter": True},
            {"key": "affordability", "name": "Affordability", "unit": "0-100", "category": "Food", "higherIsBetter": True},
            {"key": "availability", "name": "Availability", "unit": "0-100", "category": "Food", "higherIsBetter": True},
            {"key": "quality_safety", "name": "Quality & Safety", "unit": "0-100", "category": "Food", "higherIsBetter": True},
            {"key": "sustainability_adaptation", "name": "Sustainability & Adaptation", "unit": "0-100", "category": "Food", "higherIsBetter": True},
        ]
    },
    "innovation_2023": {
        "name": "Global Innovation Index 2023",
        "source": "WIPO",
        "category": "Innovation",
        "description": "Innovation capacity, outputs, institutions, and infrastructure.",
        "last_updated": "2023",
        "records": [
            {"country": "Switzerland", "innovation_score": 67.6, "institutions": 83.2, "human_capital": 68.5, "infrastructure": 69.2, "market_sophistication": 62.1, "business_sophistication": 67.8, "knowledge_tech_outputs": 72.5, "creative_outputs": 51.2},
            {"country": "Sweden", "innovation_score": 62.4, "institutions": 82.5, "human_capital": 66.2, "infrastructure": 67.5, "market_sophistication": 58.4, "business_sophistication": 62.5, "knowledge_tech_outputs": 68.2, "creative_outputs": 48.5},
            {"country": "United States", "innovation_score": 63.5, "institutions": 79.8, "human_capital": 62.5, "infrastructure": 65.8, "market_sophistication": 65.2, "business_sophistication": 64.8, "knowledge_tech_outputs": 75.2, "creative_outputs": 52.8},
            {"country": "United Kingdom", "innovation_score": 61.2, "institutions": 80.2, "human_capital": 65.8, "infrastructure": 64.2, "market_sophistication": 60.5, "business_sophistication": 61.8, "knowledge_tech_outputs": 66.5, "creative_outputs": 50.2},
            {"country": "South Korea", "innovation_score": 59.8, "institutions": 76.5, "human_capital": 72.5, "infrastructure": 74.2, "market_sophistication": 55.8, "business_sophistication": 62.5, "knowledge_tech_outputs": 70.5, "creative_outputs": 45.8},
            {"country": "Netherlands", "innovation_score": 58.5, "institutions": 81.2, "human_capital": 63.2, "infrastructure": 66.8, "market_sophistication": 58.2, "business_sophistication": 59.5, "knowledge_tech_outputs": 62.8, "creative_outputs": 47.5},
            {"country": "Germany", "innovation_score": 57.2, "institutions": 78.5, "human_capital": 60.8, "infrastructure": 64.5, "market_sophistication": 56.8, "business_sophistication": 60.2, "knowledge_tech_outputs": 65.8, "creative_outputs": 44.2},
            {"country": "Finland", "innovation_score": 56.8, "institutions": 83.5, "human_capital": 68.2, "infrastructure": 66.5, "market_sophistication": 54.2, "business_sophistication": 56.8, "knowledge_tech_outputs": 60.5, "creative_outputs": 46.2},
            {"country": "Singapore", "innovation_score": 55.8, "institutions": 84.2, "human_capital": 70.5, "infrastructure": 72.5, "market_sophistication": 58.5, "business_sophistication": 58.2, "knowledge_tech_outputs": 58.5, "creative_outputs": 42.5},
            {"country": "Denmark", "innovation_score": 55.2, "institutions": 82.8, "human_capital": 65.5, "infrastructure": 65.8, "market_sophistication": 55.5, "business_sophistication": 56.5, "knowledge_tech_outputs": 58.2, "creative_outputs": 44.8},
            {"country": "France", "innovation_score": 53.5, "institutions": 76.2, "human_capital": 58.5, "infrastructure": 62.8, "market_sophistication": 55.2, "business_sophistication": 57.5, "knowledge_tech_outputs": 60.2, "creative_outputs": 42.8},
            {"country": "China", "innovation_score": 55.3, "institutions": 68.5, "human_capital": 56.2, "infrastructure": 63.5, "market_sophistication": 52.8, "business_sophistication": 55.2, "knowledge_tech_outputs": 72.5, "creative_outputs": 40.5},
            {"country": "Japan", "innovation_score": 52.8, "institutions": 75.2, "human_capital": 62.5, "infrastructure": 65.2, "market_sophistication": 52.5, "business_sophistication": 55.8, "knowledge_tech_outputs": 62.5, "creative_outputs": 38.5},
            {"country": "Canada", "innovation_score": 51.5, "institutions": 78.5, "human_capital": 60.2, "infrastructure": 62.5, "market_sophistication": 52.8, "business_sophistication": 53.5, "knowledge_tech_outputs": 56.2, "creative_outputs": 41.5},
            {"country": "Australia", "innovation_score": 50.2, "institutions": 77.2, "human_capital": 62.5, "infrastructure": 60.8, "market_sophistication": 51.5, "business_sophistication": 52.2, "knowledge_tech_outputs": 54.8, "creative_outputs": 40.2},
            {"country": "Israel", "innovation_score": 50.5, "institutions": 72.5, "human_capital": 64.2, "infrastructure": 62.5, "market_sophistication": 52.8, "business_sophistication": 55.5, "knowledge_tech_outputs": 58.5, "creative_outputs": 39.5},
            {"country": "Austria", "innovation_score": 48.8, "institutions": 76.5, "human_capital": 58.2, "infrastructure": 60.5, "market_sophistication": 50.2, "business_sophistication": 52.8, "knowledge_tech_outputs": 52.5, "creative_outputs": 38.5},
            {"country": "Norway", "innovation_score": 47.5, "institutions": 80.5, "human_capital": 65.2, "infrastructure": 62.5, "market_sophistication": 48.5, "business_sophistication": 50.5, "knowledge_tech_outputs": 50.2, "creative_outputs": 37.5},
            {"country": "Ireland", "innovation_score": 48.2, "institutions": 78.2, "human_capital": 60.5, "infrastructure": 58.5, "market_sophistication": 54.2, "business_sophistication": 52.5, "knowledge_tech_outputs": 52.8, "creative_outputs": 37.2},
            {"country": "Belgium", "innovation_score": 47.5, "institutions": 75.8, "human_capital": 58.5, "infrastructure": 59.2, "market_sophistication": 50.5, "business_sophistication": 51.8, "knowledge_tech_outputs": 51.5, "creative_outputs": 36.8},
            {"country": "Spain", "innovation_score": 45.2, "institutions": 72.5, "human_capital": 55.2, "infrastructure": 56.5, "market_sophistication": 48.5, "business_sophistication": 50.2, "knowledge_tech_outputs": 48.5, "creative_outputs": 35.5},
            {"country": "Italy", "innovation_score": 44.8, "institutions": 70.2, "human_capital": 52.5, "infrastructure": 55.2, "market_sophistication": 47.8, "business_sophistication": 48.5, "knowledge_tech_outputs": 47.5, "creative_outputs": 34.2},
            {"country": "Poland", "innovation_score": 42.5, "institutions": 68.5, "human_capital": 50.2, "infrastructure": 52.5, "market_sophistication": 45.5, "business_sophistication": 45.8, "knowledge_tech_outputs": 45.2, "creative_outputs": 32.5},
            {"country": "India", "innovation_score": 40.5, "institutions": 55.2, "human_capital": 42.5, "infrastructure": 48.5, "market_sophistication": 42.5, "business_sophistication": 42.8, "knowledge_tech_outputs": 45.5, "creative_outputs": 30.2},
            {"country": "Brazil", "innovation_score": 38.5, "institutions": 52.5, "human_capital": 40.2, "infrastructure": 45.5, "market_sophistication": 40.5, "business_sophistication": 40.2, "knowledge_tech_outputs": 40.5, "creative_outputs": 28.5},
            {"country": "Russia", "innovation_score": 36.2, "institutions": 48.5, "human_capital": 58.5, "infrastructure": 52.5, "market_sophistication": 38.5, "business_sophistication": 38.2, "knowledge_tech_outputs": 42.5, "creative_outputs": 26.5},
            {"country": "Turkey", "innovation_score": 35.5, "institutions": 50.2, "human_capital": 48.5, "infrastructure": 48.2, "market_sophistication": 38.2, "business_sophistication": 38.5, "knowledge_tech_outputs": 40.2, "creative_outputs": 25.8},
            {"country": "South Africa", "innovation_score": 33.2, "institutions": 48.5, "human_capital": 38.2, "infrastructure": 42.5, "market_sophistication": 36.5, "business_sophistication": 35.8, "knowledge_tech_outputs": 38.5, "creative_outputs": 24.2},
        ],
        "indicators": [
            {"key": "innovation_score", "name": "Innovation Score", "unit": "0-100", "category": "Innovation", "higherIsBetter": True},
            {"key": "institutions", "name": "Institutions", "unit": "0-100", "category": "Innovation", "higherIsBetter": True},
            {"key": "human_capital", "name": "Human Capital & Research", "unit": "0-100", "category": "Innovation", "higherIsBetter": True},
            {"key": "infrastructure", "name": "Infrastructure", "unit": "0-100", "category": "Innovation", "higherIsBetter": True},
            {"key": "market_sophistication", "name": "Market Sophistication", "unit": "0-100", "category": "Innovation", "higherIsBetter": True},
            {"key": "business_sophistication", "name": "Business Sophistication", "unit": "0-100", "category": "Innovation", "higherIsBetter": True},
            {"key": "knowledge_tech_outputs", "name": "Knowledge & Tech Outputs", "unit": "0-100", "category": "Innovation", "higherIsBetter": True},
            {"key": "creative_outputs", "name": "Creative Outputs", "unit": "0-100", "category": "Innovation", "higherIsBetter": True},
        ]
    },
    "digital_competitiveness_2023": {
        "name": "IMD Digital Competitiveness 2023",
        "source": "IMD World Competitiveness Center",
        "category": "Digital",
        "description": "Knowledge, technology, and future readiness of digital economies.",
        "last_updated": "2023",
        "records": [
            {"country": "United States", "digital_rank": 1, "knowledge": 100.0, "technology": 97.5, "future_readiness": 95.2},
            {"country": "Netherlands", "digital_rank": 2, "knowledge": 95.2, "technology": 94.8, "future_readiness": 92.5},
            {"country": "Singapore", "digital_rank": 3, "knowledge": 94.5, "technology": 95.2, "future_readiness": 91.8},
            {"country": "Denmark", "digital_rank": 4, "knowledge": 93.8, "technology": 93.5, "future_readiness": 90.5},
            {"country": "Sweden", "digital_rank": 5, "knowledge": 92.5, "technology": 92.8, "future_readiness": 89.5},
            {"country": "Switzerland", "digital_rank": 6, "knowledge": 92.0, "technology": 91.5, "future_readiness": 88.8},
            {"country": "South Korea", "digital_rank": 7, "knowledge": 91.5, "technology": 93.2, "future_readiness": 87.5},
            {"country": "Taiwan", "digital_rank": 8, "knowledge": 90.5, "technology": 92.5, "future_readiness": 86.8},
            {"country": "United Kingdom", "digital_rank": 9, "knowledge": 89.5, "technology": 90.2, "future_readiness": 85.5},
            {"country": "Finland", "digital_rank": 10, "knowledge": 88.8, "technology": 89.5, "future_readiness": 84.8},
            {"country": "Canada", "digital_rank": 11, "knowledge": 87.5, "technology": 88.2, "future_readiness": 83.5},
            {"country": "Germany", "digital_rank": 12, "knowledge": 86.8, "technology": 87.5, "future_readiness": 82.8},
            {"country": "Australia", "digital_rank": 13, "knowledge": 85.5, "technology": 86.5, "future_readiness": 81.5},
            {"country": "Israel", "digital_rank": 14, "knowledge": 85.2, "technology": 85.8, "future_readiness": 80.8},
            {"country": "Norway", "digital_rank": 15, "knowledge": 84.5, "technology": 85.2, "future_readiness": 79.5},
            {"country": "Japan", "digital_rank": 16, "knowledge": 83.8, "technology": 86.5, "future_readiness": 78.8},
            {"country": "France", "digital_rank": 17, "knowledge": 82.5, "technology": 84.5, "future_readiness": 77.5},
            {"country": "Austria", "digital_rank": 18, "knowledge": 81.8, "technology": 83.2, "future_readiness": 76.5},
            {"country": "Estonia", "digital_rank": 19, "knowledge": 80.5, "technology": 82.5, "future_readiness": 75.8},
            {"country": "Belgium", "digital_rank": 20, "knowledge": 79.8, "technology": 81.5, "future_readiness": 74.5},
            {"country": "New Zealand", "digital_rank": 21, "knowledge": 78.5, "technology": 80.2, "future_readiness": 73.5},
            {"country": "Ireland", "digital_rank": 22, "knowledge": 77.8, "technology": 79.5, "future_readiness": 72.8},
            {"country": "Spain", "digital_rank": 23, "knowledge": 76.5, "technology": 78.5, "future_readiness": 71.5},
            {"country": "China", "digital_rank": 24, "knowledge": 75.2, "technology": 80.5, "future_readiness": 70.5},
            {"country": "Italy", "digital_rank": 25, "knowledge": 74.5, "technology": 77.2, "future_readiness": 69.5},
            {"country": "Poland", "digital_rank": 26, "knowledge": 72.8, "technology": 75.5, "future_readiness": 67.5},
            {"country": "Malaysia", "digital_rank": 27, "knowledge": 71.5, "technology": 74.5, "future_readiness": 66.5},
            {"country": "Chile", "digital_rank": 28, "knowledge": 70.2, "technology": 73.5, "future_readiness": 65.5},
            {"country": "United Arab Emirates", "digital_rank": 29, "knowledge": 69.5, "technology": 72.8, "future_readiness": 64.5},
            {"country": "Brazil", "digital_rank": 30, "knowledge": 68.2, "technology": 71.5, "future_readiness": 63.5},
            {"country": "India", "digital_rank": 31, "knowledge": 66.5, "technology": 70.2, "future_readiness": 62.5},
            {"country": "Turkey", "digital_rank": 32, "knowledge": 65.2, "technology": 69.5, "future_readiness": 61.5},
            {"country": "South Africa", "digital_rank": 33, "knowledge": 63.5, "technology": 68.2, "future_readiness": 60.5},
            {"country": "Russia", "digital_rank": 34, "knowledge": 62.5, "technology": 69.5, "future_readiness": 59.5},
            {"country": "Nigeria", "digital_rank": 35, "knowledge": 58.5, "technology": 62.5, "future_readiness": 55.5},
            {"country": "Pakistan", "digital_rank": 36, "knowledge": 56.5, "technology": 60.5, "future_readiness": 53.5},
        ],
        "indicators": [
            {"key": "digital_rank", "name": "Digital Rank", "unit": "", "category": "Digital", "higherIsBetter": False},
            {"key": "knowledge", "name": "Knowledge", "unit": "0-100", "category": "Digital", "higherIsBetter": True},
            {"key": "technology", "name": "Technology", "unit": "0-100", "category": "Digital", "higherIsBetter": True},
            {"key": "future_readiness", "name": "Future Readiness", "unit": "0-100", "category": "Digital", "higherIsBetter": True},
        ]
    },
}

# Endpoints for built-in datasets

@app.get("/api/sources/list")
def list_sources():
    """List all available data sources with metadata."""
    builtin = []
    for ds_id, ds in _BUILTIN_DATASETS.items():
        builtin.append({
            "id": ds_id,
            "name": ds["name"],
            "source": ds["source"],
            "category": ds["category"],
            "description": ds["description"],
            "last_updated": ds["last_updated"],
            "variable_count": len(ds["indicators"]),
        })
    # World Bank presets
    wb_presets = [
        {"id": "wb:economy", "name": "World Bank - Economy", "source": "World Bank API", "category": "Economy", "description": "GDP, growth, debt, trade, FDI", "variable_count": 25, "indicators": "gdp_current,gdp_per_capita,gdp_growth,gdp_ppp,gdp_ppp_per_capita,inflation,exports,imports,trade_balance,fdi_inflows,fdi_net_inflows,industry_value_added,services_value_added,agriculture_value_added,manufacturing_value_added,gov_debt,gov_expense,gov_revenue,tax_revenue,central_gov_debt,broad_money_growth,consumer_price_index,exchange_rate,business_extent,private_sector_credit"},
        {"id": "wb:health", "name": "World Bank - Health", "source": "World Bank API", "category": "Health", "description": "Life expectancy, mortality, health spending, disease", "variable_count": 25, "indicators": "life_expectancy,life_expectancy_female,life_expectancy_male,health_exp_per_capita,health_exp_gdp,health_exp_gov,health_exp_private,physicians_per_1000,nurses_per_1000,hospital_beds_per_1000,immunization_dpt,immunization_measles,infant_mortality,under5_mortality,maternal_mortality,neonatal_mortality,adolescent_fertility,contraceptive_prevalence,births_attended,sanitation,drinking_water,handwashing,stunting,wasting,overweight"},
        {"id": "wb:education", "name": "World Bank - Education", "source": "World Bank API", "category": "Education", "description": "Enrollment, literacy, years of schooling, spending", "variable_count": 20, "indicators": "primary_enrollment,primary_completion,secondary_enrollment,tertiary_enrollment,literacy_rate,literacy_rate_youth,literacy_rate_female,mean_years_schooling,expected_years_schooling,pupil_teacher_ratio_primary,school_enrollment_preprimary,out_of_school_primary,out_of_school_secondary,gov_education_exp,scholarship_travel,trained_teachers,children_out_of_school,youth_literacy,gov_education_exp_primary"},
        {"id": "wb:environment", "name": "World Bank - Environment", "source": "World Bank API", "category": "Environment", "description": "CO2, renewables, forest, water, emissions, biodiversity", "variable_count": 25, "indicators": "co2_per_capita,co2_total,co2_intensity,renewable_energy,fossil_fuel_energy,nuclear_energy,electricity_from_renewables,electricity_from_fossil,electricity_from_nuclear,energy_use_per_capita,energy_intensity,forest_cover,forest_area,terrestrial_protected_areas,marine_protected_areas,freshwater_withdrawal,renewable_freshwater_per_capita,water_productivity,agricultural_land,arable_land,cereal_yield,fertilizer_consumption,methane_emissions,nitrous_oxide_emissions,ghg_emissions_total"},
        {"id": "wb:social", "name": "World Bank - Social & Demographics", "source": "World Bank API", "category": "Social", "description": "Population, gender, inequality, migration", "variable_count": 20, "indicators": "population,population_density,population_growth,urban_population,rural_population,population_0_14,population_15_64,population_65_plus,dependency_ratio,fertility_rate,birth_rate,death_rate,migration_net,refugee_population,gini,poverty_headcount,poverty_gap,income_share_lowest_20,income_share_highest_10,vulnerable_employment"},
        {"id": "wb:governance", "name": "World Bank - Governance & Business", "source": "World Bank API", "category": "Governance", "description": "Business climate, taxes, legal, women's participation", "variable_count": 20, "indicators": "voice_accountability,political_stability,government_effectiveness,regulatory_quality,rule_of_law,control_of_corruption,procedures_to_start_business,time_to_start_business,cost_to_start_business,tax_payments,time_to_pay_taxes,total_tax_rate,property_registering_procedures,time_to_register_property,women_parliament_seats,women_minister_positions,gender_inequality_index,legal_framework_gender,assets_ownership_gender"},
        {"id": "wb:digital", "name": "World Bank - Digital & Infrastructure", "source": "World Bank API", "category": "Digital", "description": "Internet, broadband, ICT, e-government", "variable_count": 15, "indicators": "internet_users,fixed_broadband,mobile_subscriptions,secure_internet_servers,individuals_using_internet,researchers_per_million,technicians_in_rd,rd_expenditure,scientific_journal_articles,ict_goods_exports,ict_goods_imports,ict_services_exports,ict_services_imports,computer_communication_services,digital_government_index"},
        {"id": "wb:tourism", "name": "World Bank - Tourism", "source": "World Bank API", "category": "Tourism", "description": "International arrivals, tourism receipts", "variable_count": 5, "indicators": "international_tourist_arrivals,international_tourism_receipts,international_tourism_expenditures,tourism_receipts_percent_exports,tourism_receipts_percent_gdp"},
        {"id": "wb:full", "name": "World Bank - Full Indicator Set (120+)", "source": "World Bank API", "category": "All", "description": "Comprehensive set of 120+ World Bank development indicators", "variable_count": 120, "indicators": ",".join(list(WORLDBANK_INDICATORS.keys())[:120])},
    ]
    return {
        "sources": {
            "builtin_datasets": builtin,
            "worldbank_presets": wb_presets,
            "live_apis": [
                {"name": "World Bank", "endpoint": "/api/worldbank/fetch", "description": "120+ development indicators", "category": "All"},
                {"name": "Open-Meteo Climate", "endpoint": "/api/climate/fetch", "description": "Temperature & precipitation for 195+ capital cities", "category": "Environment"},
                {"name": "REST Countries", "endpoint": "/api/countries/list", "description": "Basic country metadata, flags, area, landlocked", "category": "General"},
            ],
        },
        "total_builtin": len(builtin),
        "total_wb_presets": len(wb_presets),
    }

@app.get("/api/datasets/builtin/{dataset_id}")
def get_builtin_dataset(dataset_id: str):
    """Get a built-in reference dataset by ID."""
    if dataset_id not in _BUILTIN_DATASETS:
        raise HTTPException(status_code=404, detail=f"Built-in dataset '{dataset_id}' not found")
    ds = _BUILTIN_DATASETS[dataset_id]
    return {
        "dataset_id": dataset_id,
        "name": ds["name"],
        "source": ds["source"],
        "category": ds["category"],
        "description": ds["description"],
        "last_updated": ds["last_updated"],
        "record_count": len(ds["records"]),
        "variable_count": len(ds["indicators"]),
        "indicators": ds["indicators"],
        "data": ds["records"],
    }

@app.get("/api/datasets/builtin")
def list_builtin_datasets():
    """List all built-in reference datasets."""
    result = []
    for ds_id, ds in _BUILTIN_DATASETS.items():
        result.append({
            "id": ds_id,
            "name": ds["name"],
            "source": ds["source"],
            "category": ds["category"],
            "description": ds["description"],
            "last_updated": ds["last_updated"],
            "variable_count": len(ds["indicators"]),
            "record_count": len(ds["records"]),
        })
    return {"datasets": result, "count": len(result)}

# ============================================================================
# HEALTH CHECK
# ============================================================================

@app.get("/api/health")
def health():
    return {"status": "ok", "datasets_loaded": len(_loaded_datasets), "cache_entries": len(_cache)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7860)

"""
Make the tap water source files for JordanWatch's "Where your tap water
likely comes from" (decided Oct 10 and Oct 13): for every community water
system in the US, where EPA's records say its water comes from, and which of
those sources are lakes EPA CyAN's satellite covers.

The app finds the user's likely water system itself (js/tapwater.js asks
EPA's service-area map about a rounded spot), then looks it up in these files.

Data (all US EPA, public):
- SDWIS (Safe Drinking Water Information System), through Envirofacts:
  every active community water system (WATER_SYSTEM) and its sources
  (WATER_SYSTEM_FACILITY): intakes on lakes and rivers, wells, and water
  bought from another system ("consecutive connections"). Each source says
  whether it's permanent or emergency-only, so emergency links are skipped.
  Only the fields below are kept: no contact names, emails, phone numbers,
  addresses or facility locations are ever saved.
- EPA's Community Water System Service Area Boundaries: the middle of each
  system's area, used here only to tell same-named lakes apart (Texas has
  two "Lake Austin"s). Never saved.
- data/lakes/index.json (scripts/fetch_lakes.py): the lakes CyAN covers.

SDWIS names its intakes by hand ("INTAKE 1 - LK JACKSONVILLE", "LAKE
LANIER"), so this matches the words of each name to the CyAN lake names
nearby. It's a careful guess: the app says "likely" and "confirm with your
utility". Intake names can describe where an intake is, so the files keep
only the lake or river name, never the rest.

The files are split by the first 2 letters of the system's ID
(data/tapwater/NC.json holds North Carolina), so a phone only downloads one
state. One system per line, e.g.
  "NC0392020":{"uses":"surface","lakes":[[2764219,"B Everett Jordan Lake"]]}
  "NC0392045":{"uses":"bought-surface","lakes":[[2764219,"B Everett Jordan Lake"]],"from":["CARY, TOWN OF"]}
  "NC0332010":{"uses":"surface","other":["Lake Michie","Little River Reservoir"]}
uses = the system's main source in SDWIS; lakes = [CyAN lake id, name] of
sources the satellite covers (its own or bought); other = lake and river
sources not matched to a CyAN lake; unnamed = how many sources have no lake
or river name; from = who it regularly buys from; wells = also uses wells.

Run once (and again every few months, as SDWIS is updated quarterly):
    python3 scripts/make_tapwater.py
"""

import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

ENVIROFACTS = "https://data.epa.gov/efservice"
SERVICE_AREAS = ("https://services.arcgis.com/cJ9YHowT8TU7DUyn/arcgis/rest/services/"
                 "Water_System_Boundaries/FeatureServer/0/query")
HEADERS = {"User-Agent": "JordanWatch student project (github.com/svarpatel-dev/jordanwatch)"}
ROWS_PER_REQUEST = 10000      # Envirofacts' page size
AREAS_PER_REQUEST = 2000      # the service-area map's page size
PAUSE_SECONDS = 1             # between requests, to be polite

TOP_FOLDER = Path(__file__).resolve().parent.parent
LAKE_INDEX = TOP_FOLDER / "data" / "lakes" / "index.json"
OUTPUT_FOLDER = TOP_FOLDER / "data" / "tapwater"

# Active community water systems (the ones on the service-area map), plus
# the wholesale systems some of them buy from that aren't "community"
# systems (e.g. the Southern Nevada Water System, which sells to Las Vegas)
SYSTEMS_QUERIES = [
    "WATER_SYSTEM/PWS_TYPE_CODE/CWS/PWS_ACTIVITY_CODE/A",
    "WATER_SYSTEM/PWS_TYPE_CODE/NTNCWS/PWS_ACTIVITY_CODE/A/IS_WHOLESALER_IND/Y",
]
# Their active sources: surface water, groundwater "under the influence" of
# surface water, and water bought from another system
SOURCES_QUERIES = [
    "WATER_SYSTEM_FACILITY/IS_SOURCE_IND/Y/PWS_TYPE_CODE/CWS/FACILITY_ACTIVITY_CODE/A/WATER_TYPE_CODE/SW",
    "WATER_SYSTEM_FACILITY/IS_SOURCE_IND/Y/PWS_TYPE_CODE/CWS/FACILITY_ACTIVITY_CODE/A/WATER_TYPE_CODE/GU",
    "WATER_SYSTEM_FACILITY/IS_SOURCE_IND/Y/PWS_TYPE_CODE/CWS/FACILITY_ACTIVITY_CODE/A/FACILITY_TYPE_CODE/CC",
    "WATER_SYSTEM_FACILITY/IS_SOURCE_IND/Y/PWS_TYPE_CODE/NTNCWS/FACILITY_ACTIVITY_CODE/A/WATER_TYPE_CODE/SW",
]
SYSTEM_FIELDS = ["pwsid", "pws_type_code", "primary_source_code", "state_code", "population_served_count"]
SOURCE_FIELDS = ["pwsid", "facility_id", "facility_name", "facility_type_code",
                 "water_type_code", "availability_code", "seller_pwsid", "seller_pws_name"]

# SDWIS codes: IN = intake, RS = reservoir, CC = bought from another system.
# Availability: P = permanent, S = seasonal, E = emergency only (skipped),
# I = interim, O = other (skipped: not a regular source)
LAKE_SOURCE_TYPES = {"IN", "RS"}
REGULAR = {"P", "S", None}

# A system's main source in SDWIS (P = bought from another system)
MAIN_SOURCE = {"SW": "surface", "GW": "wells", "GU": "wells",
               "SWP": "bought-surface", "GWP": "bought-wells", "GUP": "bought-wells"}

# Lake names in CyAN that differ from the name everyone uses. Data
# corrections, not special cases: CyAN's outlines call Falls Lake (NC)
# "Brinkley Lake". The first name is the one the app shows.
LAKE_ALIASES = {2300042: ["Falls Lake", "Falls of the Neuse Reservoir"]}

# How far a lake can be from the middle of the water system's area (or from
# the nearest point on a big lake's shore) and still count
SAME_NAME_KM = 100      # same name ("LAKE TRAVIS" = "Lake Travis")
PART_NAME_KM = 60       # one name inside the other ("JORDAN LAKE" in "B Everett Jordan Lake"),
                        # a name without "lake" ("BENBROOK"), or a small lake (under 5 km²)
SMALL_LAKE_KM2 = 5
# Only big cities pipe water from farther away (New York City's reservoirs
# are 170 km from the city, Corpus Christi's Lake Texana 160 km)
PIPELINE_KM = 200
BIG_SYSTEM_PEOPLE = 100000
COMMON_NAME_KM = 30     # names made only of common words ("WEST LAKE", "CLEAR LAKE")
# A lake in another state only counts if it's on the border (this close) or
# big (Lake Hartwell, Lake Erie, Lake Gaston): "WALDEN POND" in Massachusetts
# isn't the Walden Pond in Maine
BORDER_KM = 30
BIG_LAKE_KM2 = 25

# Words in intake and lake names
LAKE_WORDS = {"LAKE", "LAKES", "RESERVOIR", "POND", "FLOWAGE", "IMPOUNDMENT"}
RIVER_WORDS = {"RIVER", "CREEK", "BRANCH", "FORK", "RUN", "BROOK", "BAYOU", "SLOUGH"}
# Not lakes either: pipes and canals (never shown as a name), springs and wells
PIPE_WORDS = {"CANAL", "DITCH", "AQUEDUCT", "TUNNEL", "WELL", "WELLS"}
STREAM_WORDS = RIVER_WORDS | PIPE_WORDS | {"SPRING", "SPRINGS"}
# Words that aren't part of a lake's name: what the intake is, and words
# that say where it is (roads, directions, depths), which are never shown
NOT_NAME_WORDS = {"THE", "OF", "AND", "AT", "ON", "IN", "NEAR", "BY", "FOR", "FROM", "TO",
                  "INTAKE", "INTAKES", "RAW", "WATER", "SURFACE", "SOURCE", "SUPPLY", "PUMP",
                  "PUMPS", "PUMPING", "STATION", "PS", "PLANT", "WTP", "WTF", "TP", "TREATMENT",
                  "INLET", "OUTFALL", "NO", "MAIN", "NEW", "OLD", "PRIMARY", "SECONDARY",
                  "BACKUP", "EMERGENCY", "DAM", "END", "UPPER", "LOWER", "SITE", "FACILITY",
                  "STRUCTURE", "TOWER", "CRIB", "SHORE", "PIER", "DOCK", "BARGE", "FLOATING",
                  "DEPTH", "FEET", "LEVEL", "CONN", "CONNECTION", "PIPE", "PIPELINE", "LINE",
                  "WEIR", "DIVERSION", "GATE", "HEADGATE", "BRIDGE", "ROAD", "RD", "HWY",
                  "HIGHWAY", "ST", "STREET", "AVE", "AVENUE", "BLVD", "DR", "DRIVE", "LN", "LANE",
                  "PIKE", "ROUTE", "RT", "SR", "US", "MILE", "BELOW", "ABOVE", "UPSTREAM",
                  "DOWNSTREAM", "NW", "NE", "SW", "SE", "IS", "ARE", "MILES", "MI", "KM", "DEEP",
                  "SHALLOW", "OUTLET", "EFFLUENT", "HEADWORKS", "PENSTOCK", "AFTERBAY", "TERMINAL",
                  "AUXILIARY", "UNAPPROVED", "PURCHASED", "VIA", "BEHIND", "YARDS", "PLT", "INF",
                  "GAL", "TERM", "CO", "GW", "XCLD"}
# Words so common in lake names that they can't identify a lake on their own
COMMON_WORDS = {"NORTH", "SOUTH", "EAST", "WEST", "MIDDLE", "CENTRAL", "BIG", "LITTLE", "GREAT",
                "LONG", "ROUND", "CITY", "COUNTY", "TOWN", "VILLAGE", "MILL", "BLUE", "CLEAR",
                "CRYSTAL", "SILVER", "MUD", "BEAVER", "DEER", "BEAR", "CEDAR", "PINE", "ROCK",
                "ROCKY", "SAND", "SANDY", "GREEN", "BLACK", "WHITE", "RED", "TWIN", "HIGH",
                "FALLS", "STATE", "PARK", "HILL"}
SHORT_FORMS = {"LK": "LAKE", "RES": "RESERVOIR", "RESV": "RESERVOIR", "RESER": "RESERVOIR",
               "RESERV": "RESERVOIR", "RESERVIOR": "RESERVOIR", "RESEVOIR": "RESERVOIR",
               "RESERVOR": "RESERVOIR", "RSVR": "RESERVOIR", "RSV": "RESERVOIR",
               "CRK": "CREEK", "CR": "CREEK", "CK": "CREEK", "R": "RIVER", "RVR": "RIVER",
               "RIV": "RIVER", "MT": "MOUNT", "MTN": "MOUNTAIN", "FT": "FORT"}

EARTH_RADIUS_KM = 6371


# ---------- downloading ----------

def get_json(url):
    """Download and read one JSON answer, trying again after an error."""
    for attempt in range(4):
        try:
            request = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(request, timeout=300) as response:
                return json.load(response)
        except OSError as error:
            print(f"  failed ({error}), trying again")
            time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Couldn't download {url}")


def download_table(query, fields):
    """Every row of an Envirofacts query, keeping only the given fields."""
    rows, start = [], 0
    while True:
        page = get_json(f"{ENVIROFACTS}/{query}/ROWS/{start}:{start + ROWS_PER_REQUEST - 1}/JSON")
        rows += [{field: row.get(field) for field in fields} for row in page]
        if len(page) < ROWS_PER_REQUEST:
            return rows
        start += ROWS_PER_REQUEST
        time.sleep(PAUSE_SECONDS)


def download_area_middles():
    """{system ID: (lat, lng)}: the middle of each system's mapped area."""
    middles, offset = {}, 0
    while True:
        query = {"f": "json", "where": "1=1", "outFields": "PWSID", "returnGeometry": "false",
                 "returnCentroid": "true", "outSR": "4326", "orderByFields": "OBJECTID",
                 "resultOffset": offset, "resultRecordCount": AREAS_PER_REQUEST}
        page = get_json(SERVICE_AREAS + "?" + urllib.parse.urlencode(query))
        for feature in page["features"]:
            middle = feature.get("centroid")
            pwsid = (feature["attributes"]["PWSID"] or "").strip()
            if middle and pwsid:
                middles.setdefault(pwsid, (middle["y"], middle["x"]))
        if not page.get("exceededTransferLimit"):
            return middles
        offset += len(page["features"])
        time.sleep(PAUSE_SECONDS)


# ---------- names ----------

def name_words(name):
    """"INTAKE 1 - LK JACKSONVILLE" → ["INTAKE", "1", "LAKE", "JACKSONVILLE"]"""
    text = (name or "").upper().replace("&", " AND ").replace("'", "")
    text = re.sub(r"[^A-Z0-9]", " ", text)
    return [SHORT_FORMS.get(word, word) for word in text.split()]


def key_words(words):
    """The words that identify a lake: no "LAKE", "INTAKE", numbers or single
    letters. A frozenset (a set that can't change) so it can be compared."""
    return frozenset(word for word in words
                     if word not in LAKE_WORDS and word not in NOT_NAME_WORDS
                     and len(word) > 1 and word.isalpha())


def match_kind(source_words, source_keys, lake_keys):
    """How well an intake name matches a lake name: "same", "part" or None."""
    if not source_keys or not lake_keys:
        return None
    names_a_lake = bool(LAKE_WORDS & set(source_words))
    # "HAW RIVER", "FISHING CREEK": an intake on a river or creek, not a lake
    if STREAM_WORDS & source_keys and not names_a_lake:
        return None
    if source_keys == lake_keys:
        return "same"
    if not names_a_lake:
        return None
    # The intake's name inside the lake's: "JORDAN LAKE" in "B Everett Jordan
    # Lake", unless the extra words are a different water body ("Clear Fork
    # Lake" isn't "CLEAR LAKE")
    if source_keys < lake_keys and not STREAM_WORDS & (lake_keys - source_keys):
        return "part"
    # The lake's name inside the intake's, only with common extra words
    # ("LAKE WASHINGTON NORTH"): "HELENA REGULATING RESERVOIR" isn't Lake Helena
    if lake_keys < source_keys and source_keys - lake_keys <= COMMON_WORDS:
        return "part"
    return None


def water_body_names(facility_name):
    """Only the lake and river parts of an intake's name, e.g.
    "INTAKE - CEDAR CREEK RES / E END OF DAM" → ["Cedar Creek Reservoir"],
    "COLORADO RIVER, LAKE TRAVIS" → ["Colorado River", "Lake Travis"].
    The rest of the name can say where the intake is, so it's never kept."""
    names = []
    # The parts of the name between "(", "/", "," and " - ", one at a time
    for part in re.split(r"[/(),;:]| - ", facility_name or ""):
        words = name_words(part)
        keep = None
        # "RIVERSIDE LAKE LANIER INTAKE": "LAKE" and up to 2 name words after it
        for i, word in enumerate(words):
            if word == "LAKE" and i + 1 < len(words) and is_name_word(words[i + 1]):
                end = i + 1
                while end < len(words) and end <= i + 2 and is_name_word(words[end]):
                    end += 1
                keep = words[i:end]
                break
        # "LITTLE RIVER RESERVOIR", "UNIVERSITY LAKE": up to 3 name words
        # before the last lake or river word
        water = [i for i, word in enumerate(words) if word in LAKE_WORDS | RIVER_WORDS]
        if keep is None and water:
            last = water[-1]
            start = last
            while start > 0 and start > last - 3 and is_name_word(words[start - 1]):
                start -= 1
            keep = words[start:last + 1]
        if keep is not None and len(keep) >= 2:
            names.append(" ".join(word.capitalize() for word in keep))
    return names


def is_name_word(word):
    """A word that can be part of a lake's or river's name"""
    return (word.isalpha() and len(word) > 1 and word not in NOT_NAME_WORDS
            and word not in PIPE_WORDS)


# ---------- matching intakes to lakes ----------

def distance_km(a, b):
    """Along the Earth's surface (the haversine formula, like js/location.js)"""
    lat1, lng1, lat2, lng2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = (math.sin((lat2 - lat1) / 2) ** 2 +
         math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2)
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(h))


def lake_distance_km(point, lake):
    """To the lake's middle, or for a big lake to the nearest point on its shore"""
    km = distance_km(point, (lake["lat"], lake["lng"]))
    shore = lake.get("shore") or []
    for i in range(0, len(shore), 2):
        km = min(km, distance_km(point, (shore[i], shore[i + 1])))
    return km


def load_lake_names():
    """{word: [(lake, the name to show, its key words)]} for every CyAN lake
    name, so each intake is only compared with lakes sharing a word."""
    index = json.loads(LAKE_INDEX.read_text())
    by_word = {}
    for row in index["lakes"]:
        lake = dict(zip(index["fields"], row))
        names = LAKE_ALIASES.get(lake["id"], []) + [lake["name"]]
        shown = names[0]
        for name in names:
            keys = key_words(name_words(name))
            for word in keys:
                by_word.setdefault(word, []).append((lake, shown, keys))
    return by_word


def find_lake(facility_name, middle, state, big_system, lakes_by_word):
    """The CyAN lake an intake is on, as (lake id, name), or None.
    middle = where the water system is (lat, lng), or None if unknown (then
    only lakes in the same state count, and only an unmistakable match).
    Tries the whole intake name and its lake part ("RIVERSIDE LAKE LANIER
    INTAKE" → "Lake Lanier")."""
    candidates = {}
    for name in [facility_name] + water_body_names(facility_name):
        words = name_words(name)
        source_keys = key_words(words)
        for word in source_keys:
            for lake, shown, lake_keys in lakes_by_word.get(word, []):
                kind = match_kind(words, source_keys, lake_keys)
                if kind is None:
                    continue
                # Only common or river words in common ("OLD RIVER LAKE")
                common_only = not (source_keys & lake_keys) - COMMON_WORDS - STREAM_WORDS
                if common_only and kind != "same":
                    continue
                if middle is None:
                    # Location unknown: only the exact name, in the same state
                    if lake["state"] != state or common_only or kind != "same":
                        continue
                    km = 0
                else:
                    km = lake_distance_km(middle, lake)
                    if common_only:
                        limit = COMMON_NAME_KM
                    elif kind != "same" or lake["km2"] < SMALL_LAKE_KM2 or not LAKE_WORDS & set(words):
                        limit = PART_NAME_KM
                    else:
                        limit = PIPELINE_KM if big_system else SAME_NAME_KM
                    other_state = lake["state"] != state and km > BORDER_KM and lake["km2"] < BIG_LAKE_KM2
                    if km > limit or other_state:
                        continue
                # Best first: the same name, then the closest
                rank = (kind != "same", km)
                if lake["id"] not in candidates or rank < candidates[lake["id"]][0]:
                    candidates[lake["id"]] = (rank, lake["id"], shown)
    if not candidates:
        return None
    ranked = sorted(candidates.values())
    # Location unknown: two equally good lakes in the state means we can't tell
    if middle is None and len(ranked) > 1 and ranked[0][0] == ranked[1][0]:
        return None
    return ranked[0][1], ranked[0][2]


# ---------- each water system's sources ----------

def own_sources(sources, middle, state, big_system, lakes_by_word):
    """A system's own regular lake and river intakes → (lakes {id: name},
    other names, how many have no lake or river name)"""
    lakes, other, unnamed = {}, [], 0
    for source in sources:
        if (source["facility_type_code"] not in LAKE_SOURCE_TYPES or
                source["water_type_code"] != "SW" or source["availability_code"] not in REGULAR):
            continue
        found = find_lake(source["facility_name"], middle, state, big_system, lakes_by_word)
        names = water_body_names(source["facility_name"])
        if found:
            lakes[found[0]] = found[1]
        elif names:
            if names[0] not in other:
                other.append(names[0])
        else:
            unnamed += 1
    return lakes, other, unnamed


def describe_system(pwsid, data, middle=None, seen=()):
    """Where one system's water comes from, following regular purchases from
    other systems (up to 3 steps, e.g. a town that buys from a county that
    buys from a regional authority). middle = the buyer's location, for a
    seller that isn't on the service-area map itself (wholesalers often aren't)."""
    systems, sources_by_system, middles, lakes_by_word = data
    middle = middles.get(pwsid, middle)
    state = systems.get(pwsid, {}).get("state_code") or pwsid[:2]
    big_system = (systems.get(pwsid, {}).get("population_served_count") or 0) >= BIG_SYSTEM_PEOPLE
    mine = sources_by_system.get(pwsid, [])
    lakes, other, unnamed = own_sources(mine, middle, state, big_system, lakes_by_word)
    wells = MAIN_SOURCE.get(systems.get(pwsid, {}).get("primary_source_code"), "").endswith("wells")
    sellers = []
    for source in mine:
        seller = source["seller_pwsid"]
        if (source["facility_type_code"] != "CC" or source["availability_code"] not in REGULAR
                or not seller or seller == pwsid or seller in seen):
            continue
        name = source["seller_pws_name"] or seller
        if name not in sellers:
            sellers.append(name)
        if len(seen) < 3:
            bought = describe_system(seller, data, middle, seen + (pwsid,))
            lakes.update(bought["lakes"])
            other += [n for n in bought["other"] if n not in other]
            unnamed += bought["unnamed"]
            wells = wells or bought["wells"]
    # A lake the satellite covers isn't also listed as "other"
    other = [n for n in other if n not in lakes.values()]
    return {"lakes": lakes, "other": other, "unnamed": unnamed, "wells": wells, "sellers": sellers}


def file_entry(system, described):
    """The short form saved in the files (empty parts left out)"""
    entry = {}
    main_source = MAIN_SOURCE.get(system["primary_source_code"])
    if main_source:
        entry["uses"] = main_source
    if described["lakes"]:
        entry["lakes"] = [[lake_id, name] for lake_id, name in described["lakes"].items()]
    if described["other"]:
        entry["other"] = described["other"]
    if described["unnamed"]:
        entry["unnamed"] = described["unnamed"]
    if described["sellers"]:
        entry["from"] = described["sellers"]
    if described["wells"]:
        entry["wells"] = True
    return entry


def main():
    print("Downloading water systems and their sources from EPA SDWIS…")
    systems = {}
    for query in SYSTEMS_QUERIES:
        for row in download_table(query, SYSTEM_FIELDS):
            systems[row["pwsid"]] = row
    sources = {}
    for query in SOURCES_QUERIES:
        for row in download_table(query, SOURCE_FIELDS):
            sources[(row["pwsid"], row["facility_id"])] = row   # the queries overlap
    sources_by_system = {}
    for row in sources.values():
        sources_by_system.setdefault(row["pwsid"], []).append(row)
    print(f"  {len(systems):,} systems, {len(sources):,} sources")

    print("Downloading the middle of each system's service area…")
    middles = download_area_middles()
    data = (systems, sources_by_system, middles, load_lake_names())

    print("Matching intakes to CyAN lakes…")
    groups = {}
    for pwsid, system in sorted(systems.items()):
        # Only community systems: the ones on the service-area map
        if system["pws_type_code"] == "CWS":
            groups.setdefault(pwsid[:2], {})[pwsid] = file_entry(system, describe_system(pwsid, data))

    OUTPUT_FOLDER.mkdir(parents=True, exist_ok=True)
    saved = with_lakes = 0
    for prefix, group in sorted(groups.items()):
        path = OUTPUT_FOLDER / f"{prefix}.json"
        # One system per line (easy to read and to compare), no extra spaces
        lines = [f"{json.dumps(pwsid)}:{json.dumps(entry, separators=(',', ':'))}"
                 for pwsid, entry in group.items()]
        path.write_text("{\n" + ",\n".join(lines) + "\n}\n")
        saved += len(group)
        with_lakes += sum(1 for entry in group.values() if "lakes" in entry)
    print(f"Saved {len(groups)} files in {OUTPUT_FOLDER}: {saved:,} systems, "
          f"{with_lakes:,} with a lake the satellite covers")


if __name__ == "__main__":
    main()

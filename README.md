# JordanWatch

**Is the lake OK today?** JordanWatch rates about 7,000 US lakes **Avoid**, **Caution** or **Low Risk** for harmful algal blooms (cyanobacteria), so swimmers, paddlers and dog owners know before they hit the water.

**Live app:** https://jordanwatch.app · **License:** MIT (see `LICENSE`)

Built for Jordan Lake in North Carolina, where it rates 10 separate areas of the lake, and it works the same way for lakes across the country. Free, no account, no ads.

> **Not an official advisory.** JordanWatch is a screening tool. Always follow posted signs and your state's advisories.

---

## What it does

| Feature | What you get |
|---|---|
| **Today's rating** | Avoid / Caution / Low Risk for the lake (or Jordan Lake area) nearest you, with the satellite image date and, for Jordan Lake areas, whether it's getting better or worse |
| **Why this rating** | One small card per signal: satellite algae, rain and river flow, lake level, wind. The worst signal sets the rating |
| **What to do** | Short advice for people, kids and dogs, plus a link to report a bloom to your state |
| **Go here instead** | The nearest area or lake with a better rating today (beaches preferred) |
| **Satellite map** | EPA satellite colors for the past week, smoothed inside lake shorelines, with a rating pin on every lake |
| **Last 30 days** | A small chart of each lake's satellite readings |
| **Live stations near you** | Every USGS water station nearby, judged by its own state's water quality standards |
| **Your tap water** | The water system that likely serves your place and the lakes it draws from (context only, never a tap-water rating) |
| **Camera scan** | Point your phone at the water (or use a photo): possible bloom, plants, clear water or not water, with a confidence and an "Uncertain" result. A screening aid, not a diagnosis |
| **If exposed** | CDC steps for people and pets, with tap-to-call Poison Control and animal poison lines |
| **Search, favorites, guided tour** | ZIP code or lake name search, starred lakes saved on your phone, and a guided tour of every feature |

Your exact location stays on your phone. To find nearby stations, a wide box around your place is sent to USGS; to find your water system, a spot rounded to about 1 km is sent to EPA.

## How the rating works

1. **Satellite.** EPA's CyAN project estimates cyanobacteria (cells per milliliter) from the Sentinel-3 satellite. JordanWatch compares them with the WHO 1999/2003 cell-count guideline levels: below 20,000 cells/mL is Low Risk, 20,000 to 100,000 is Caution, 100,000 and above is Avoid.
2. **Hot spots.** If any satellite pixel near an area reaches the Avoid level, the area is never Low Risk, even when the average is low.
3. **Other signals.** Heavy rain (0.5 in. in 48 hours) or a river running above its usual range for the date raises Low Risk to Caution (general guidance after storms). So does unusually high lake water. Light wind blowing toward a beach raises that beach one level, because wind pushes floating scum to the downwind shore.
4. **Worst signal wins**, and **old data never gives an all-clear**: a reading over a week old can keep a warning but can't make a lake Low Risk.
5. **Camera.** A steady bloom result that you confirm raises the nearest area one level, on your phone only, until midnight.

Satellites count algae cells; they can't measure toxins. Health agencies (EPA, NC DHHS) judge recreation by a toxin, microcystin (8 µg/L), which needs a water test, so the cell-count levels here are an early warning.

## How it's built

- **Front end:** a web app in plain JavaScript (ES modules, no build step), HTML and CSS. **Leaflet** for the map, **TensorFlow.js** for the camera model. Every rating and every scan is computed in the browser.
- **Back end:** Python scripts run on **GitHub Actions**:
  - `scripts/fetch_cyan.py` (every 6 hours): satellite readings for Jordan Lake's 10 areas → `cyan.json`. EPA's API blocks browser requests, so the data is fetched here and served from the site.
  - `scripts/fetch_lakes.py` + `scripts/cyan_images.py` (4 times a day): EPA's nationwide satellite image for every covered lake, plus a per-lake check that is the only source of Low Risk ratings → `data/lakes/`.
  - `scripts/make_tiles.py` + `scripts/radar_tiles.py` (on every deploy): turns the nationwide image into map tiles, smoothed only between real readings and clipped to USGS shorelines.
  - Data built by hand: state water quality standards (`make_standards.py`), state bloom report links (`make_report_routes.py`), tap water sources (`make_tapwater.py`), lake beaches and gauges (`fetch_lake_extras.py`), ZIP code points (`make_zip_points.py`), lake shorelines (`fetch_shorelines.py`).
- **Camera model:** MobileNetV2 transfer learning in Keras (Google Colab), trained on 1,469 photos and tested on 265 held-out photos in 4 classes (bloom, vegetation, clear water, not water). Converted to TensorFlow.js. Notebook: `notebooks/jordanwatch_camera_v1.ipynb`. Dataset tools: `scripts/collect_photos.py`, `scripts/build_dataset.py`.
- **Hosting:** GitHub Pages, deployed by GitHub Actions (`.github/workflows/`).

### Accuracy and testing

- **Camera:** 81.1% correct on the 265 held-out photos, run through the app's own code (the Colab notebook's own Keras evaluation on the same photos prints 82.6%; the app's TensorFlow.js path and its photo preprocessing differ slightly). When the model is at least 70% confident (216 of 265 photos), it's right 90.7% of the time; below that it says "Uncertain". It caught 55 of 72 blooms.
- **Satellite colors:** JordanWatch's per-lake readings from EPA's nationwide image match EPA's own per-lake counts within a median of about 1% (18 lakes in 9 states, checked Oct 15, 2026).
- **Forecast, tested and not shipped:** a bloom forecast beat "same as the last image" on 2025–26 but failed on 2024 and had no skill in winter, so the app shows a labeled trend instead.

### Limits

- Satellite pixels are about 300 m wide: shorelines, narrow arms and lakes under about 1 km² are too small, and clouds hide lakes some days.
- EPA's nationwide image has no data south of about 29.9° N (southern Florida, Louisiana and the Texas coast), so the map has no colors there; those lakes still get ratings from the per-lake check.
- Satellite images are usually 1 to 3 days old. The app always shows their date.
- Cell counts are not toxin tests. The camera is a screening aid.

## Run it locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000/. Map colors need the `tiles/` folder, which the deploy builds with `python3 scripts/make_tiles.py`.

## Data sources and credits

**Data**
- **EPA CyAN** (Cyanobacteria Assessment Network: EPA, NASA, NOAA, USGS): satellite cyanobacteria estimates and lake outlines
- **USGS Water Data API:** live stream, lake level and rain gauges, and daily flow statistics; **USGS National Hydrography Dataset:** lake shorelines
- **Open-Meteo:** current wind
- **EPA** Community Water System Service Area Boundaries and Safe Drinking Water Information System: tap water systems and sources
- **EPA** Criteria Search Tool and each state's water quality regulations: station standards
- State environmental and health agencies: bloom report links
- **U.S. Census Bureau** ZCTA Gazetteer: ZIP code points
- **OpenStreetMap:** base map and beaches. © OpenStreetMap contributors, data available under the Open Database License (ODbL)
- **CDC** "Harmful Algal Blooms and Your Health" and "Preventing illness": If exposed steps
- **WHO** 1999/2003 cyanobacteria guideline levels; **EPA** 2019 recreational criteria; **NC DEQ** and **NC State Parks** (Jordan Lake beaches, report form); **USACE** (Jordan Lake normal pool, 216 ft)

**Libraries and fonts**
- Leaflet 1.9.4 (BSD-2-Clause)
- TensorFlow.js 4.22.0 (Apache-2.0)
- Public Sans (SIL Open Font License), via Google Fonts

**Camera training photos** (1,734 photos; every photo's author, license and link is listed in `model/photo_credits.csv`)
- Algal Blooms Sweden (Zenodo, 2020–2023), CC BY 4.0
- iNaturalist observers, CC BY and CC0
- Wikimedia Commons contributors, CC BY, CC BY-SA and public domain
- Open Images V7, CC BY 2.0
- U.S. Geological Survey and National Park Service, public domain
- "AI Based Water Pollution Detection Dataset" (Figshare 33036302), CC BY 4.0

Because some training photos are CC BY-SA, the trained camera model (`model/colab-v1/`) is shared under **CC BY-SA 4.0**.

## Thanks

To NC DEQ, which confirmed the state's bloom report form, and to NC DHHS, whose review led to using WHO's three levels exactly as written. And to the friends who tested the app.

---

Made by Svar Patel, a high school student in North Carolina, for the 2026 Congressional App Challenge.

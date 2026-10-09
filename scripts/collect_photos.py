"""Download candidate training photos for the JordanWatch camera model.

Photos are saved OUTSIDE the repo, in ../jordanwatch-photos, so they never
reach GitHub. Every photo gets one row in credits.csv (file, class, source,
author, license, url). Only CC0 and CC BY photos are downloaded.

Run from the jordanwatch folder:
    python3 scripts/collect_photos.py inat bloom 67334 500 --without 67332
    python3 scripts/collect_photos.py sweden 2020 2021 2022 2023

Running a command again skips photos that are already downloaded.
"""

import argparse
import csv
import json
import subprocess
import tempfile
import time
import urllib.request
import zipfile
from pathlib import Path

PHOTOS_DIR = Path(__file__).resolve().parent.parent.parent / "jordanwatch-photos"
CREDITS_FILE = PHOTOS_DIR / "credits.csv"
CREDIT_COLUMNS = ["file", "class", "source", "author", "license", "url"]
CLASSES = ["bloom", "vegetation", "clear_water", "not_water"]

USER_AGENT = "JordanWatch student project (https://github.com/svarpatel-dev/jordanwatch)"
MAX_SIZE = 640  # longest side in pixels; the model only sees 224 px anyway
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png")

INAT_API = "https://api.inaturalist.org/v1/observations"
INAT_LICENSES = {"cc0": "CC0", "cc-by": "CC BY"}

SWEDEN_RECORDS = {"2020": "4104638", "2021": "7551670", "2022": "7551676", "2023": "10599927"}


def get_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.load(response)


def download(url, path):
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(request, timeout=300) as response, open(path, "wb") as f:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            f.write(chunk)


def shrink_to_jpeg(source, target):
    """Use the Mac's built-in sips tool: convert to JPEG, longest side MAX_SIZE."""
    subprocess.run(
        ["sips", "-s", "format", "jpeg", "-Z", str(MAX_SIZE), str(source), "--out", str(target)],
        check=True, capture_output=True,
    )


def setup_folders():
    for class_name in CLASSES:
        (PHOTOS_DIR / "candidates" / class_name).mkdir(parents=True, exist_ok=True)
    (PHOTOS_DIR / "rejected").mkdir(parents=True, exist_ok=True)
    if not CREDITS_FILE.exists():
        with open(CREDITS_FILE, "w", newline="") as f:
            csv.writer(f).writerow(CREDIT_COLUMNS)


def already_downloaded():
    with open(CREDITS_FILE, newline="") as f:
        return {row["file"] for row in csv.DictReader(f)}


def add_credit(row):
    with open(CREDITS_FILE, "a", newline="") as f:
        csv.DictWriter(f, fieldnames=CREDIT_COLUMNS).writerow(row)


def collect_inat(class_name, taxon_id, limit, without):
    """First photo of each CC0 / CC BY observation of a taxon, newest first."""
    have = already_downloaded()
    folder = PHOTOS_DIR / "candidates" / class_name
    saved = 0
    last_id = None

    while saved < limit:
        url = (f"{INAT_API}?taxon_id={taxon_id}&photo_license=cc0,cc-by&photos=true"
               f"&order_by=id&order=desc&per_page=200")
        if last_id:
            url += f"&id_below={last_id}"
        if without:
            url += f"&without_taxon_id={without}"
        observations = get_json(url)["results"]
        if not observations:
            print("No more observations.")
            break

        for obs in observations:
            last_id = obs["id"]
            photo = obs["photos"][0]
            license_name = INAT_LICENSES.get(photo.get("license_code"))
            if license_name is None:
                continue  # first photo isn't CC0 / CC BY
            file_name = f"inat_{photo['id']}.jpg"
            if file_name in have:
                continue

            photo_url = photo["url"].replace("/square.", "/medium.")
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    raw = Path(tmp) / "photo"
                    download(photo_url, raw)
                    shrink_to_jpeg(raw, folder / file_name)
            except Exception as error:
                print(f"  skipped photo {photo['id']}: {error}")
                continue

            add_credit({
                "file": file_name,
                "class": class_name,
                "source": "iNaturalist",
                "author": photo["attribution"],
                "license": license_name,
                "url": f"https://www.inaturalist.org/observations/{obs['id']}",
            })
            saved += 1
            print(f"  {saved}/{limit} {file_name}")
            if saved >= limit:
                break
            time.sleep(1)  # be polite: about one download per second

        time.sleep(1)

    print(f"Done: {saved} new {class_name} photos from iNaturalist taxon {taxon_id}.")


def collect_sweden(years):
    """Algal Blooms Sweden (Zenodo, CC BY 4.0): every photo goes into the bloom class."""
    have = already_downloaded()
    folder = PHOTOS_DIR / "candidates" / "bloom"

    for year in years:
        record_id = SWEDEN_RECORDS[year]
        record = get_json(f"https://zenodo.org/api/records/{record_id}")
        authors = "; ".join(creator["name"] for creator in record["metadata"]["creators"])
        zip_info = record["files"][0]
        print(f"{year}: downloading {zip_info['key']} ({zip_info['size'] / 1e6:.0f} MB)...")

        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "photos.zip"
            download(zip_info["links"]["self"], zip_path)

            with zipfile.ZipFile(zip_path) as archive:
                photos = [name for name in archive.namelist()
                          if name.lower().endswith(IMAGE_EXTENSIONS)
                          and ".ipynb_checkpoints" not in name
                          and not name.split("/")[-1].startswith(".")]
                photos.sort()

                for number, name in enumerate(photos, start=1):
                    file_name = f"sweden{year}_{number:04d}.jpg"
                    if file_name in have:
                        continue
                    raw = Path(tmp) / ("raw" + Path(name).suffix.lower())
                    raw.write_bytes(archive.read(name))
                    try:
                        shrink_to_jpeg(raw, folder / file_name)
                    except subprocess.CalledProcessError:
                        print(f"  skipped unreadable file: {name}")
                        continue
                    add_credit({
                        "file": file_name,
                        "class": "bloom",
                        "source": f"Algal Blooms Sweden {year} (Zenodo)",
                        "author": authors,
                        "license": "CC BY 4.0",
                        "url": f"https://zenodo.org/records/{record_id}",
                    })
            print(f"{year}: {len(photos)} photos processed.")
        # the zip and full-size originals are deleted here with the temp folder


def main():
    parser = argparse.ArgumentParser(description="Download candidate training photos.")
    sources = parser.add_subparsers(dest="source", required=True)

    inat = sources.add_parser("inat", help="photos of one taxon from iNaturalist")
    inat.add_argument("class_name", choices=CLASSES)
    inat.add_argument("taxon_id", type=int)
    inat.add_argument("limit", type=int, help="how many new photos to download")
    inat.add_argument("--without", type=int, help="taxon id to leave out (e.g. Nostoc 67332)")

    sweden = sources.add_parser("sweden", help="Algal Blooms Sweden photos from Zenodo")
    sweden.add_argument("years", nargs="+", choices=list(SWEDEN_RECORDS))

    args = parser.parse_args()
    setup_folders()
    if args.source == "inat":
        collect_inat(args.class_name, args.taxon_id, args.limit, args.without)
    else:
        collect_sweden(args.years)


if __name__ == "__main__":
    main()

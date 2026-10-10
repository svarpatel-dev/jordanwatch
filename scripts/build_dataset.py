"""
Build the camera model's training and test sets from the hand-picked photos.

Reads  ../jordanwatch-photos/candidates/<class>/   (hand-picked photos)
       ../jordanwatch-photos/credits.csv           (one row per photo)
Writes ../jordanwatch-photos/dataset/train/<class>/  and  dataset/test/<class>/
       ../jordanwatch-photos/dataset/credits_used.csv  (only photos in the dataset,
                                                         with a train/test column)

What it does to every photo:
  1. turns it the right way up (phone photos store rotation as a tag)
  2. crops the center square and shrinks it to 224 x 224 pixels, the size
     MobileNet (the pretrained model we build on) expects
  3. saves it as a JPEG

Test set: about 15% of each class, chosen by GROUP, not by single photo.
A group is one photographer; big one-photographer sets (e.g. Algal Blooms
Sweden, the Bangladesh set) are cut into runs of 10 consecutive photos,
because neighbouring photos are often near-copies of the same scene. If
near-copies landed in both train and test, the test score would be too high.

Run:  python3 scripts/build_dataset.py      (needs Pillow)
"""

import csv
import random
import re
import shutil
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageOps

PHOTOS = Path(__file__).resolve().parent.parent.parent / "jordanwatch-photos"
CANDIDATES = PHOTOS / "candidates"
DATASET = PHOTOS / "dataset"
CLASSES = ["bloom", "vegetation", "clear_water", "not_water"]

SIZE = 224
TEST_SHARE = 0.15
BIG_GROUP = 50     # photographers with more photos than this get split into runs
RUN_LENGTH = 10
SEED = 10          # fixed, so the same test set comes out every time


def load_credits():
    """credits.csv rows by file name (later rows win, e.g. round 2 updates)."""
    with open(PHOTOS / "credits.csv", newline="") as f:
        return {row["file"]: row for row in csv.DictReader(f)}


def group_key(file_name, author, author_sizes):
    """Which group a photo belongs to, so near-copies stay together."""
    if author_sizes[author] <= BIG_GROUP:
        return author
    number = re.search(r"(\d+)\.\w+$", file_name)
    run = int(number.group(1)) // RUN_LENGTH if number else 0
    prefix = re.sub(r"_?\d+\.\w+$", "", file_name)
    return f"{author} | {prefix} | run {run}"


def split(files, credits, rng):
    """Pick whole groups for the test set until it holds ~15% of the photos."""
    authors = [credits[f]["author"] or credits[f]["source"] for f in files]
    author_sizes = defaultdict(int)
    for author in authors:
        author_sizes[author] += 1

    groups = defaultdict(list)
    for f, author in zip(files, authors):
        groups[group_key(f, author, author_sizes)].append(f)

    names = sorted(groups)
    rng.shuffle(names)
    test, target = set(), TEST_SHARE * len(files)
    for name in names:
        if len(test) >= target:
            break
        if len(test) + len(groups[name]) <= target * 1.2:   # skip groups that overshoot
            test.update(groups[name])
    return test


def square_224(source, destination):
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        image = ImageOps.fit(image, (SIZE, SIZE), Image.Resampling.LANCZOS)
        image.save(destination, "JPEG", quality=92)


def main():
    credits = load_credits()
    rng = random.Random(SEED)
    if DATASET.exists():
        shutil.rmtree(DATASET)   # rebuilt from candidates/ every time; originals untouched

    used = []
    for class_name in CLASSES:
        files = sorted(p.name for p in (CANDIDATES / class_name).iterdir()
                       if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp"))
        missing = [f for f in files if f not in credits]
        if missing:
            raise SystemExit(f"{class_name}: no credits row for {missing[:5]} ...")

        test = split(files, credits, rng)
        for part in ("train", "test"):
            (DATASET / part / class_name).mkdir(parents=True, exist_ok=True)
        for f in files:
            part = "test" if f in test else "train"
            out_name = Path(f).stem + ".jpg"
            square_224(CANDIDATES / class_name / f, DATASET / part / class_name / out_name)
            used.append({**credits[f], "class": class_name, "file": out_name, "split": part})
        print(f"{class_name:12} train {len(files) - len(test):4}   test {len(test):4}")

    with open(DATASET / "credits_used.csv", "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["file", "class", "split", "source", "author", "license", "url"])
        writer.writeheader()
        writer.writerows(used)
    print(f"Saved {len(used)} photos to {DATASET}")


if __name__ == "__main__":
    main()

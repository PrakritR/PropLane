"""Regenerate the cover's critical font after changing HOME_HEADLINE.

Run: uv run --with 'fonttools[woff]' python scripts/generate-home-swiss-cover.py
Source: the committed OFL Inter Tight variable font (license beside it).
"""
from pathlib import Path
import json
import re
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset

root = Path(__file__).resolve().parents[1]
fonts = root / "src/components/marketing/fonts"
font = TTFont(fonts / "InterTight-variable.woff2", recalcTimestamp=False)
font = instantiateVariableFont(font, {"wght": 600}, inplace=True)
copy = (root / "src/lib/marketing/home-copy.ts").read_text()
headline = json.loads(re.search(r'HOME_HEADLINE\s*=\s*("[^"]+")', copy).group(1))
options = subset.Options()
options.layout_features = ["*"]
subsetter = subset.Subsetter(options=options)
subsetter.populate(text=headline + "0123456789()+- Text us")
subsetter.subset(font)
font.flavor = "woff2"
font.save(fonts / "InterTight-cover.woff2")

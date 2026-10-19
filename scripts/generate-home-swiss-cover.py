"""Regenerate the Latin UI font and critical cover subset after changing HOME_HEADLINE.

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
# Keep the full source font committed; the marketing UI needs Latin-1 and punctuation, with fallback for other scripts.
latin = TTFont(fonts / "InterTight-variable.woff2", recalcTimestamp=False)
latin_options = subset.Options()
latin_options.layout_features = ["*"]
latin_subsetter = subset.Subsetter(options=latin_options)
latin_subsetter.populate(unicodes=[
    *range(0x0000, 0x0100),
    *range(0x2000, 0x2070), *range(0x20A0, 0x20D0),
    *range(0x2100, 0x2150), *range(0x2190, 0x2200), 0x2212, 0xFEFF, 0xFFFD,
])
latin_subsetter.subset(latin)
latin.flavor = "woff2"
latin.save(fonts / "InterTight-latin-variable.woff2")

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

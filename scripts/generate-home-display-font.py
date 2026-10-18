"""Generate the homepage's smaller Bricolage instance without dropping glyphs.

Run: uv run --with 'fonttools[woff]' python scripts/generate-home-display-font.py
The original OFL font and embedded copyright/license remain intact.
"""
from pathlib import Path
import json
import re

from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont
from fontTools import subset

fonts = Path(__file__).resolve().parents[1] / "src/components/marketing/fonts"
source = TTFont(fonts / "BricolageGrotesque-variable.woff2", recalcTimestamp=False)
original_cmap = source.getBestCmap().copy()
home = instantiateVariableFont(source, {"wdth": 100, "wght": 600}, inplace=True)
assert home.getBestCmap() == original_cmap
assert [axis.axisTag for axis in home["fvar"].axes] == ["opsz"]
home.save(fonts / "BricolageGrotesque-home.woff2")

# The fixed first-paint headline does not need to wait for the full alphabet.
copy = (fonts.parents[2] / "lib/marketing/home-copy.ts").read_text()
headline = json.loads(re.search(r'HOME_HEADLINE\s*=\s*("[^"]+")', copy).group(1))
critical = TTFont(fonts / "BricolageGrotesque-home.woff2", recalcTimestamp=False)
options = subset.Options()
options.layout_features = ["*"]
subsetter = subset.Subsetter(options=options)
critical_text = headline + "0123456789()+- Text us"
subsetter.populate(text=critical_text)
subsetter.subset(critical)
assert set(map(ord, critical_text)) <= set(critical.getBestCmap())
critical.save(fonts / "BricolageGrotesque-headline.woff2")

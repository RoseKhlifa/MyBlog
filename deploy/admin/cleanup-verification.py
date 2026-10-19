#!/usr/bin/env python3
"""Remove only an already-deleted acceptance entry's disposable attachment folder."""
from pathlib import Path
import re
import shutil
import sys

entry_id = sys.argv[1]
if not re.fullmatch(r"online-smoke-[0-9]+", entry_id):
    raise SystemExit('Expected the unique temporary acceptance entry ID')
essay = Path('/opt/rosekhlifa-blog/source/src/content/essay').resolve()
if (essay / (entry_id + '.md')).exists():
    raise SystemExit('Entry is still present; preserve its attachments')
assets = essay / (entry_id + '-assets')
if assets.is_symlink() or assets.resolve().parent != essay:
    raise SystemExit('Unexpected acceptance attachment directory')
if assets.is_dir():
    shutil.rmtree(assets)
print('CLEANUP PASS: temporary attachment directory removed; real articles preserved')

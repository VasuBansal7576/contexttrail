"""Embed the final launch film and local player assets in one portable HTML."""
from pathlib import Path
import base64
import re
import shutil

root = Path(__file__).resolve().parents[1]
player = root / '.lavish/contexttrail-launch.html'
final = root / 'videos/contexttrail/renders/contexttrail-launch-final.mp4'
if not final.exists():
    raise SystemExit('Render videos/contexttrail/renders/contexttrail-launch-final.mp4 first.')
shutil.copy2(final, root / '.lavish/contexttrail-assets/contexttrail-launch-revised.mp4')
source = player.read_text()
media_types = {'.mp4':'video/mp4', '.jpg':'image/jpeg', '.woff2':'font/woff2', '.vtt':'text/vtt'}
for reference in set(re.findall(r'contexttrail-assets/[^\s"\)<>]+', source)):
    asset = player.parent / reference
    media_type = media_types[asset.suffix.lower()]
    encoded = base64.b64encode(asset.read_bytes()).decode('ascii')
    source = source.replace(reference, f'data:{media_type};base64,{encoded}')
output = root / 'videos/contexttrail/renders/contexttrail-launch-interactive.html'
output.write_text(source)
print(f'Portable player saved: {output.name}')

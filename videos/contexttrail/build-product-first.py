"""Retiming for the product-first launch, using measured local narration."""
from pathlib import Path
import html
import json
import re

root = Path(__file__).resolve().parent
audio = json.loads((root / 'audio_meta_product_first.json').read_text())
voices = audio['voices']
assert len(voices) == 7, 'All seven narration clips must exist before assembly.'
assert all(v.get('words') for v in voices), 'Captions require transcription timings.'
lead = .2
holds = [.5, .5, 1.0, .65, .5, .6, 1.2]
durations = [round(v['duration_s'] + lead + h, 3) for v, h in zip(voices, holds)]
starts = []
elapsed = 0
for duration in durations:
    starts.append(round(elapsed, 3))
    elapsed += duration
total = round(elapsed, 3)
titles = ['Meet ContextTrail', 'A question about UPI', 'Read the distinction', 'Check the dates', 'Keep the open questions', 'Return to the evidence', 'Bring your next question']
request = json.loads((root / 'audio_request_product_first.json').read_text())
index = (root / 'index.html').read_text()
index = re.sub(r'(id="main"[^>]*data-duration=")[^"]+', rf'\g<1>{total}', index)
for i, (start, duration, voice) in enumerate(zip(starts, durations, voices), 1):
    def host(match):
        tag = re.sub(r'data-start="[^"]+"', f'data-start="{start}"', match[0])
        return re.sub(r'data-duration="[^"]+"', f'data-duration="{duration}"', tag)
    index = re.sub(r'<div[^>]*id="el-revised' + str(i) + r'"[^>]*>', host, index)
    def media(match):
        tag = re.sub(r'src="[^"]+"', f'src="{voice["path"]}"', match[0])
        tag = re.sub(r'data-start="[^"]+"', f'data-start="{round(start + lead, 3)}"', tag)
        return re.sub(r'data-duration="[^"]+"', f'data-duration="{voice["duration_s"]}"', tag)
    index = re.sub(r'<audio[^>]*id="revised-voice' + str(i) + r'"[^>]*>', media, index)
    path = root / f'compositions/revised{i}.html'
    scene = path.read_text()
    scene = re.sub(r'data-duration="[^"]+"', f'data-duration="{duration}"', scene, count=1)
    if i == 1:
        header = re.search(r'<div[^>]*class="header"[^>]*>.*?</div>', scene)
        footer = re.search(r'<div[^>]*class="footer"[^>]*>', scene)
        body = '''<div class="block" style="left:90px;top:170px;width:540px"><p class="eyebrow">Bring something you want to understand.</p><h1 class="serif" style="font-size:105px;line-height:1;margin-top:35px">ContextTrail</h1><h2 class="serif rust" style="font-size:80px;line-height:1.03;margin-top:42px">Find the<br>context.</h2><p class="subtitle rule" style="margin-top:42px">Investigate questions,<br>claims and media.</p><p class="caption" style="margin-top:24px">Sources you can inspect.<br>Evidence you can return to.</p></div><div class="block product-cover" style="left:690px;top:180px;width:1140px"><img src="assets/revised/cover.jpg" alt="Recorded ContextTrail cover" style="display:block;width:1140px;height:641.25px;border:1px solid #81877d"><p class="caption" style="margin-top:24px">The recorded app, before we follow one question.</p></div>'''
        scene = scene[:header.end()] + body + scene[footer.start():]
        scene = scene.replace('The everyday question', 'Meet ContextTrail')
        scene = re.sub(r'<script>.*?</script>', '<script>const tl=gsap.timeline({paused:true});tl.fromTo("#revised1 .product-cover",{opacity:0,x:12},{opacity:1,x:0,duration:.45,ease:"power2.out"},.05);window.__timelines.revised1=tl;</script>', scene)
    if i == 3:
        merchant = next((w['start'] for w in voice['words'] if 'merchant' in w['text'].lower()), 4)
        scene = scene.replace('},6.5);', '},' + str(round(lead + merchant, 3)) + ');')
    if i == 4:
        scene = scene.replace('},1.3);', '},1.0);').replace('},4.4);', '},2.6);')
    if i == 6:
        scene = scene.replace('},3.8);', '},1.5);')
    if i == 7:
        scene = scene.replace('},3.4);', '},2.2);')
    path.write_text(scene)

cues = []
for start, voice in zip(starts, voices):
    group = []
    for word in voice['words']:
        group.append(word)
        if len(group) >= 9 or word['text'].endswith(('.', '?', '!')):
            cues.append({'start': round(start + lead + group[0]['start'], 3), 'end': round(min(start + lead + voice['duration_s'], start + lead + group[-1]['end'] + .12), 3), 'text': ' '.join(w['text'] for w in group).replace('context trail', 'ContextTrail').replace('Context Trail', 'ContextTrail')})
            group = []
    if group:
        cues.append({'start': round(start + lead + group[0]['start'], 3), 'end': round(start + lead + voice['duration_s'], 3), 'text': ' '.join(w['text'] for w in group)})
assert all(c['end'] > c['start'] for c in cues)
for cue, following in zip(cues, cues[1:]):
    cue['end'] = min(cue['end'], round(following['start'] - .01, 3))
for cue in cues:
    cue['text'] = cue['text'].replace('UP eye', 'UPI')
captions = ''.join(f'<div id="caption-revised-{i}" class="clip" data-start="{c["start"]}" data-duration="{c["end"]-c["start"]:.3f}" data-track-index="6"><div class="caption-revised-text">{html.escape(c["text"])}</div></div>' for i, c in enumerate(cues))
(root / 'compositions/captions-revised.html').write_text('<template><style>.caption-revised-text{position:absolute;left:90px;top:915px;max-width:1020px;padding:12px 18px;background:#f2ecd9;color:#242c2b;border-left:3px solid #b44833;font:30px/1.35 Geist,Arial,sans-serif}</style><div id="captions-revised" data-composition-id="captions-revised" data-width="1920" data-height="1080" data-duration="'+str(total)+'">'+captions+'</div><script>window.__timelines["captions-revised"]=gsap.timeline({paused:true});</script></template>')
index = re.sub(r'(<div[^>]*id="el-captions-revised"[^>]*data-duration=")[^"]+', rf'\g<1>{total}', index)
if 'data-track-kind="captions"' not in index:
    index = index.replace('id="el-captions-revised" class="clip"', 'id="el-captions-revised" class="clip" data-track-kind="captions"')
(root / 'index.html').write_text(index)
def timestamp(sec):
    ms = round(sec*1000)
    return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}.{ms%1000:03}'
(root / 'captions-revised.vtt').write_text('WEBVTT\n\n'+'\n\n'.join(f'{i}\n{timestamp(c["start"])} --> {timestamp(c["end"])}\n{c["text"]}' for i, c in enumerate(cues, 1))+'\n')
(root / 'caption_groups_revised.json').write_text(json.dumps(cues, indent=2))
(root / 'revision-timing.json').write_text(json.dumps({'duration': total, 'starts': starts, 'durations': durations, 'titles': titles}, indent=2))
(root / 'SCRIPT.md').write_text('# ContextTrail launch narration\n\n'+'\n\n'.join(f'## {i}. {title}\n\n    {line["text"]}' for i, (title, line) in enumerate(zip(titles, request['lines']), 1))+'\n')
board = (root / 'STORYBOARD.md').read_text()
board = re.sub(r'^duration: .*$', f'duration: {total}s', board, flags=re.M)
board = board.replace('Everyday question → Investigation', 'Product → Example question → Investigation')
note = '''## Changes from the 80-second cut

User notes: "too me it feels like too slow" and "do u wanna styart with a product usecase or do u wanna tell what product is first".

ContextTrail is introduced before UPI. The opening shows the recorded cover and describes questions, claims and media. Narration is rewritten at 1.04 local voice speed. Repeated sentences are cut. Post-narration holds are 0.5–1.2 seconds, with the quote readable during the voice. This pacing revision does not certify HTML fidelity or completion of the product.

'''
if '## Changes from the 80-second cut' not in board:
    board = board.replace('## Frame 1', note+'## Frame 1', 1)
for i, (title, duration, line) in enumerate(zip(titles, durations, request['lines']), 1):
    block = re.search(r'## Frame '+str(i)+r'[^\n]*\n.*?(?=\n## Frame |\Z)', board, re.S)
    if block:
        revised = re.sub(r'^## Frame [^\n]+', f'## Frame {i} — {title}', block[0])
        revised = re.sub(r'^- duration: .*$', f'- duration: {duration}s', revised, flags=re.M)
        revised = re.sub(r'^- voiceover: .*$', '- voiceover: '+line['text'], revised, flags=re.M)
        if i == 1:
            revised = re.sub(r'0–2s:.*', '0s: name and purpose visible. Actual recorded cover enters within 0.05s. Narration explains the product before the UPI example. Short 0.5s hold.', revised, flags=re.S)
        revised = revised.replace('Hold for at least five seconds after the narration.', 'Hold for one second after narration; the quote is already readable during speech.').replace('At 4s, cut', 'At 1.5s, cut').replace('Long final hold.', 'Final hold of 1.2 seconds.')
        board = board[:block.start()] + revised + board[block.end():]
(root / 'STORYBOARD.md').write_text(board)
print(json.dumps({'duration': total, 'starts': starts, 'voice_seconds': round(sum(v['duration_s'] for v in voices), 3), 'outside_voice_seconds': round(total-sum(v['duration_s'] for v in voices), 3)}, indent=2))

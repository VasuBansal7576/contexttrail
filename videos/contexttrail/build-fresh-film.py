from pathlib import Path
import html,json,shutil
root=Path(__file__).resolve().parent
run=root.parents[1]/'runs/2026-10-04'
assets=root/'assets/fresh';assets.mkdir(exist_ok=True)
for name in ['input','search','result-repaired','evidence','inspector','casebook','reopened']:
 shutil.copy2(run/f'fresh-metro-{name}.png',assets/f'{name}.png')
shutil.copy2(root.parents[1]/'public/illustrative-pointing-hand.png',assets/'hand.png')
meta=json.loads((root/'audio_meta_fresh.json').read_text());voices=meta['voices']
assert len(voices)==7 and all(v['words'] for v in voices)
groups=[[0],[1,2],[3,4],[5],[6]];holds=[.3,.5,.6,.4,1.4]
starts=[];durations=[];voice_starts={};t=0
for group,hold in zip(groups,holds):
 starts.append(round(t,3));vstart=t+.1
 for i in group:
  voice_starts[i]=round(vstart,3);vstart+=voices[i]['duration_s']+.1
 duration=round(vstart-t+hold,3);durations.append(duration);t+=duration
total=round(t,3)
css='''@font-face{font-family:Instrument;src:url(assets/fonts/instrument-serif-latin.woff2)}@font-face{font-family:Instrument;src:url(assets/fonts/instrument-serif-latin-italic.woff2);font-style:italic}@font-face{font-family:Geist;src:url(assets/fonts/geist-sans-latin.woff2)}*{box-sizing:border-box;margin:0}html,body{width:1920px;height:1080px;overflow:hidden;background:#f2ecd9;color:#242c2b}#main{width:100%;height:100%;position:relative;font-family:Geist,Arial,sans-serif}.clip{position:absolute;inset:0;overflow:hidden}.ground{position:absolute;inset:0;background:#f2ecd9}.shot{position:absolute;inset:0;overflow:hidden}.shot img{display:block;width:1920px;height:1080px}.micro{font:23px/1.5 'Courier New',monospace;letter-spacing:2px;text-transform:uppercase}.intro-copy{position:absolute;left:135px;top:150px;width:1100px}.wordmark{font:218px/1 Instrument;letter-spacing:-4px}.purpose{font:67px/1.13 Instrument;max-width:1050px;margin-top:44px}.purpose em{color:#b44833}.trail-paper{position:absolute;left:1210px;top:195px;width:550px;height:610px;border:1px solid #b9ad93;background:#faf5e5;box-shadow:12px 15px 0 #d7cbb0;padding:45px}.trail-paper h2{font:60px/1.08 Instrument;margin:25px 0}.trail-paper p{font:28px/1.6 Geist}.trail-paper .rule{border-top:1px solid #b9ad93;margin-top:34px;padding-top:26px;font:20px/1.5 'Courier New',monospace}.topline{position:absolute;left:135px;right:135px;top:48px;border-bottom:1px solid #b9ad93;padding-bottom:24px;display:flex;justify-content:space-between;font:24px Geist}.caption-box{position:absolute;left:130px;bottom:27px;max-width:1500px;padding:13px 21px;background:#f2ecd9;color:#242c2b;border-left:4px solid #b44833;font:34px/1.32 Geist}.recorded{position:absolute;right:110px;top:20px;background:#f2ecd9;padding:8px 12px;font:18px/1.4 'Courier New',monospace}.date-frame{position:absolute;left:1387px;top:283px;width:330px;height:156px;border:4px solid #b44833;box-shadow:0 0 0 7px #f2ecd9aa}.date-note{position:absolute;left:1020px;top:763px;width:710px;background:#254c70;color:#f2ecd9;padding:28px 35px;font:45px/1.1 Instrument}.end-copy{position:absolute;left:150px;top:205px;width:1440px}.end-copy h1{font:184px/1 Instrument}.end-copy p{font:60px/1.13 Instrument;margin-top:30px;width:1050px}.end-copy p.micro{font:23px/1.5 Courier New,monospace;letter-spacing:2px;text-transform:uppercase;margin-top:0}.end-cta{position:absolute;left:720px;top:720px;width:650px;height:112px;background:#242c2b;color:#f2ecd9;border-bottom:6px solid #e2b956;display:flex;align-items:center;justify-content:center;font:36px Geist}.end-hand{position:absolute;left:1425px;top:678px;width:380px;height:auto}.end-rule{position:absolute;left:150px;right:150px;bottom:150px;border-top:1px solid #b9ad93}.intro-note{position:absolute;left:150px;bottom:170px;font:31px Geist}'''
def clip(i,body):return f'<section id="fresh-scene-{i}" class="clip" data-start="{starts[i]}" data-duration="{durations[i]}" data-track-index="0"><div class="ground"></div>{body}</section>'
def shot(id,name):return f'<div id="{id}" class="shot"><img src="assets/fresh/{name}.png" alt="Actual ContextTrail computer-use capture" data-layout-allow-overflow="true"></div>'
scenes=[]
scenes.append(clip(0,'<div class="topline"><span>ContextTrail</span><span>A place for the question</span></div><div class="intro-copy"><p class="micro">Bring something you want to understand.</p><h1 class="wordmark" style="margin-top:35px">ContextTrail</h1><p class="purpose">Find the sources behind<br><em>questions, claims and media.</em></p></div><div class="trail-paper"><p class="micro">A question becomes a trail</p><h2>Ask.<br>Read.<br>Return.</h2><p>Sources you can inspect.<br>Evidence you can keep.</p><p class="rule">Your question starts<br>the investigation.</p></div>'))
scenes.append(clip(1,shot('fresh-input','input')+shot('fresh-search','search')+'<div class="recorded">Actual live run · search wait shortened</div>'))
scenes.append(clip(2,shot('fresh-evidence','evidence')+shot('fresh-inspector','inspector')+'<div class="recorded">Same live run · retained source inspection</div><div id="fresh-date-frame" class="date-frame"></div><p id="fresh-date-note" class="date-note">Publication ≠ the date of the event</p>'))
scenes.append(clip(3,shot('fresh-casebook','casebook')+shot('fresh-reopened','reopened')+'<div class="recorded">Saved case · reopening makes no provider requests</div>'))
scenes.append(clip(4,'<div class="topline"><span>ContextTrail</span><span>A place for the question</span></div><div class="end-copy"><p class="micro">Your next question</p><h1 style="margin-top:38px">ContextTrail</h1><p>Bring something you<br><em style="color:#b44833">want to understand.</em></p></div><div class="end-cta">Bring your question ↗</div><img class="end-hand" src="assets/fresh/hand.png" alt="Engraved hand pointing to Bring your question"><div class="end-rule"></div>'))
cues=[]
for i,v in enumerate(voices):
 group=[]
 for word in v['words']:
  group.append(word)
  if len(group)>=8 or word['text'].endswith(('.', '?','!')):
   cues.append({'start':round(voice_starts[i]+group[0]['start'],3),'end':round(min(voice_starts[i]+v['duration_s'],voice_starts[i]+group[-1]['end']+.1),3),'text':' '.join(w['text'] for w in group).replace('Context Trail','ContextTrail').replace('context trail','ContextTrail')});group=[]
 if group:cues.append({'start':round(voice_starts[i]+group[0]['start'],3),'end':round(voice_starts[i]+v['duration_s'],3),'text':' '.join(w['text'] for w in group)})
for c in cues:
 if 'January 2025' in c['text']: c['text']=c['text'].rstrip('.')+'?'
 if c['text'].startswith('bring something'): c['text']='B'+c['text'][1:]
for c,n in zip(cues,cues[1:]):c['end']=min(c['end'],n['start']-.01)
caption_html=''.join(f'<div id="fresh-caption-{i}" class="clip" data-start="{c["start"]}" data-duration="{c["end"]-c["start"]:.3f}" data-track-index="4"><div class="caption-box">{html.escape(c["text"])}</div></div>' for i,c in enumerate(cues))
audio=''.join(f'<audio id="fresh-voice-{i}" class="clip" src="{v["path"]}" data-start="{voice_starts[i]}" data-duration="{v["duration_s"]}" data-track-index="3" data-volume="1"></audio>' for i,v in enumerate(voices))
# Explicit cuts between actual captured states, rather than invented UI motion.
s2=starts[1];s3=starts[2];s4=starts[3];s5=starts[4]
js=f'''const tl=gsap.timeline({{paused:true}});tl.fromTo('.trail-paper',{{y:24,rotation:2,opacity:0}},{{y:0,rotation:1,opacity:1,duration:.55,ease:'power2.out'}},.5);tl.fromTo('.purpose',{{y:14,opacity:0}},{{y:0,opacity:1,duration:.45}},.08);tl.fromTo('#fresh-search',{{opacity:0}},{{opacity:1,duration:.12}},{voice_starts[2]});tl.fromTo('#fresh-inspector',{{opacity:0}},{{opacity:1,duration:.15}},{s3+1.8});tl.fromTo('#fresh-date-frame',{{opacity:0}},{{opacity:1,duration:.25}},{voice_starts[4]});tl.fromTo('#fresh-date-note',{{y:15,opacity:0}},{{y:0,opacity:1,duration:.25}},{voice_starts[4]+.3});tl.fromTo('#fresh-reopened',{{opacity:0}},{{opacity:1,duration:.15}},{s4+1.6});tl.fromTo('.end-cta',{{y:15,opacity:0}},{{y:0,opacity:1,duration:.3}},{s5+.35});tl.fromTo('.end-hand',{{x:25,opacity:0,rotation:-28}},{{x:0,opacity:1,rotation:-28,duration:.4,ease:'power2.out'}},{s5+.45});window.__timelines.main=tl;'''
(root/'index.html').write_text('<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script><style>'+css+'</style></head><body><main id="main" data-composition-id="main" data-duration="'+str(total)+'" data-width="1920" data-height="1080">'+''.join(scenes)+audio+caption_html+'</main><script>'+js+'</script></body></html>')
titles=['What ContextTrail does','Bring the question','Read the source and dates','Return to the evidence','Your next question']
(root/'fresh-timing.json').write_text(json.dumps({'duration':total,'starts':starts,'durations':durations,'titles':titles,'voice_starts':voice_starts},indent=2))
(root/'caption_groups_fresh.json').write_text(json.dumps(cues,indent=2))
def ts(sec):
 ms=round(sec*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}.{ms%1000:03}'
(root/'captions-fresh.vtt').write_text('WEBVTT\n\n'+'\n\n'.join(f'{i}\n{ts(c["start"])} --> {ts(c["end"])}\n{c["text"]}' for i,c in enumerate(cues,1))+'\n')
print(json.dumps({'duration':total,'starts':starts,'voiceSeconds':sum(v['duration_s'] for v in voices)}))

"""Two-pass launch audio mastering; encoded picture is copied unchanged."""
from pathlib import Path
import subprocess, json, shutil

P=Path(__file__).resolve().parent
movie=P/'renders/contexttrail-launch-20261005.mp4'
archive=P/'renders/launch-verification/unmastered-render.mp4'
if not archive.exists():shutil.copy2(movie,archive)
analysis=subprocess.run(['ffmpeg','-hide_banner','-i',str(archive),'-af','loudnorm=I=-16:TP=-2:LRA=11:print_format=json','-f','null','-'],capture_output=True,text=True,check=True)
d=json.JSONDecoder().raw_decode(analysis.stderr[analysis.stderr.rindex('{'):])[0]
fx=f'loudnorm=I=-16:TP=-2:LRA=11:measured_I={d["input_i"]}:measured_TP={d["input_tp"]}:measured_LRA={d["input_lra"]}:measured_thresh={d["input_thresh"]}:offset={d["target_offset"]}:linear=true:print_format=json'
temp=movie.with_name('contexttrail-launch-mastered.tmp.mp4')
result=subprocess.run(['ffmpeg','-hide_banner','-y','-i',str(archive),'-map','0:v:0','-map','0:a:0','-c:v','copy','-af',fx,'-c:a','aac','-b:a','192k','-ar','48000','-t','90','-movflags','+faststart','-metadata','title=ContextTrail — Follow the question','-metadata','comment=Real production UI; generated Kokoro narration; original local score.',str(temp)],capture_output=True,text=True,check=True)
temp.replace(movie)
(P/'renders/launch-verification/mastering.json').write_text(json.dumps(dict(target_lufs=-16,true_peak_ceiling_db=-1,pre_encode_limiter_db=-2,source_analysis=d,video='Copied unchanged',command_filter=fx),indent=2))
print('Mastered launch film saved; rendered video stream preserved.')

"""Verify the delivered encode and create a contact sheet from its pixels."""
from pathlib import Path
import subprocess, json, concurrent.futures

P=Path(__file__).resolve().parent
movie=P/'renders/contexttrail-launch-20261005.mp4'
out=P/'renders/launch-verification'; out.mkdir(exist_ok=True)
probe=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_format','-show_streams','-of','json',str(movie)]))
v=next(s for s in probe['streams'] if s['codec_type']=='video')
a=next(s for s in probe['streams'] if s['codec_type']=='audio')
assert (v['width'],v['height'])==(1920,1080)
assert v['avg_frame_rate']=='60/1'
assert abs(float(probe['format']['duration'])-90)<.1
assert a['sample_rate']=='48000'
decode=subprocess.run(['ffmpeg','-v','error','-i',str(movie),'-f','null','-'],capture_output=True,text=True)
assert decode.returncode==0,decode.stderr
assert not decode.stderr.strip(),decode.stderr
times=[4,8,12,16,24,32,37,45,48,56,65,69,71.5,74.5,78,86]
def capture(item):
    i,t=item
    subprocess.run(['ffmpeg','-v','error','-y','-ss',str(t),'-i',str(movie),'-frames:v','1','-vf','scale=480:270',str(out/f'frame-{i:02d}.png')],check=True)
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
    list(pool.map(capture,enumerate(times)))
subprocess.run(['ffmpeg','-v','error','-y','-framerate','1','-i',str(out/'frame-%02d.png'),'-vf','tile=4x4:padding=10:margin=10:color=0x222c29','-frames:v','1',str(out/'contact-sheet.jpg')],check=True)
audio=subprocess.run(['ffmpeg','-hide_banner','-i',str(movie),'-af','loudnorm=I=-16:TP=-1:LRA=11:print_format=json','-f','null','-'],capture_output=True,text=True,check=True)
report=dict(file=str(movie),duration=float(probe['format']['duration']),width=v['width'],height=v['height'],fps=v['avg_frame_rate'],frames=v.get('nb_frames'),audio_codec=a['codec_name'],audio_sample_rate=a['sample_rate'],audio_channels=a['channels'],bytes=int(probe['format']['size']),decode_errors=decode.stderr,contact_sheet=str(out/'contact-sheet.jpg'),sample_times=times)
if '{' in audio.stderr:
    report['audio_analysis']=json.JSONDecoder().raw_decode(audio.stderr[audio.stderr.rindex('{'):])[0]
(out/'verification.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report,indent=2))

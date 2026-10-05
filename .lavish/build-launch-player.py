"""Build the current fresh-run companion and portable HTML."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).resolve().parents[1] / 'videos/contexttrail/build-interactive-player.py'), run_name='__main__')

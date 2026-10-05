"""Local launch player server with byte ranges for browser video seeking."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import re

class LaunchHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        if path.split("?", 1)[0] == "/contexttrail-launch-interactive.html":
            return str(Path(__file__).resolve().parents[1] / "videos/contexttrail/renders/contexttrail-launch-interactive.html")
        return super().translate_path(path)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def send_head(self):
        self.remaining = None
        range_header = self.headers.get('Range')
        path = self.translate_path(self.path)
        if not range_header or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        match = re.fullmatch(r'bytes=(\d*)-(\d*)', range_header)
        if not match or not any(match.groups()) or size == 0:
            self.send_error(416, 'Unsupported byte range')
            return None
        first, last = match.groups()
        if not first:
            start, end = max(0, size-int(last)), size-1
        else:
            start = int(first)
            end = min(int(last), size-1) if last else size-1
        if start >= size or start > end:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{size}')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        source = open(path, 'rb')
        source.seek(start)
        self.remaining = end-start+1
        self.send_response(206)
        self.send_header('Content-Type', self.guess_type(path))
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
        self.send_header('Content-Length', str(self.remaining))
        self.end_headers()
        return source

    def copyfile(self, source, output):
        if self.remaining is None:
            return super().copyfile(source, output)
        while self.remaining:
            chunk = source.read(min(65536, self.remaining))
            if not chunk:
                break
            output.write(chunk)
            self.remaining -= len(chunk)

if __name__ == '__main__':
    root = Path(__file__).resolve().parent
    ThreadingHTTPServer(('127.0.0.1', 3237), partial(LaunchHandler, directory=str(root))).serve_forever()

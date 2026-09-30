"""開発用の静的サーバー（キャッシュ無効）。

    python serve.py            # http://localhost:8080
    python serve.py 9000       # ポート指定

WebXR の AR は HTTPS か localhost でしか動きません。スマホで試す方法は README を参照。
"""
import http.server
import os
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.js': 'text/javascript', '.mjs': 'text/javascript'}

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


if __name__ == '__main__':
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f'NekoAR: http://localhost:{port}')
    http.server.ThreadingHTTPServer(('0.0.0.0', port), NoCacheHandler).serve_forever()

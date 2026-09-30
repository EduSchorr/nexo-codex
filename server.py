"""Interface local para o Codex. Python 3.11+, sem dependencias externas."""
import argparse
import atexit
import base64
from collections import deque
import json
import mimetypes
import os
from pathlib import Path
import queue
import secrets
import shutil
import subprocess
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
ATTACHMENTS = Path(os.environ.get('LOCALAPPDATA', tempfile.gettempdir())) / 'Nexo' / 'attachments'
IMAGE_TYPES = {'.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'}
BLOCKED_TYPES = {'.exe', '.dll', '.com', '.scr', '.bat', '.cmd', '.ps1', '.msi', '.vbs', '.js', '.jse', '.wsf', '.hta'}
PERSONAL_DIR_NAMES = ('Desktop', 'Documents', 'Downloads', 'OneDrive')


def personal_folders():
    home = Path.home()
    return {name: folder.resolve() for name in PERSONAL_DIR_NAMES
            if (folder := home / name).is_dir()}


def personal_cwd(value, folders):
    if not value:
        value = folders.get('Documents') or next(iter(folders.values()), None)
    if value is None:
        raise ValueError('Nenhuma pasta pessoal autorizada foi encontrada.')
    path = Path(value).resolve()
    if not path.is_dir() or not any(path == root or root in path.parents for root in folders.values()):
        raise ValueError('Escolha uma pasta dentro de Área de Trabalho, Documentos, Downloads ou OneDrive pessoal.')
    return str(path)


def scoped_rpc_params(method, params):
    params = dict(params)
    folders = personal_folders()
    if method in {'thread/start', 'thread/resume'}:
        sandbox = params.get('sandbox')
        if sandbox == 'workspace-write':
            params['cwd'] = personal_cwd(params.get('cwd'), folders)
            params['approvalPolicy'] = 'on-request'
        elif sandbox == 'read-only':
            params['approvalPolicy'] = 'on-request'
        else:
            raise ValueError('Modo de acesso inválido para o Nexo.')
    elif method == 'turn/start':
        policy = params.get('sandboxPolicy') or {}
        kind = policy.get('type')
        if kind == 'workspaceWrite':
            params['cwd'] = personal_cwd(params.get('cwd'), folders)
            params['sandboxPolicy'] = {
                'type': 'workspaceWrite',
                'writableRoots': [str(path) for path in folders.values()],
                'networkAccess': False,
            }
            params['approvalPolicy'] = 'on-request'
        elif kind == 'readOnly':
            params['sandboxPolicy'] = {'type': 'readOnly'}
            params['approvalPolicy'] = 'on-request'
        else:
            raise ValueError('Modo de acesso inválido para o Nexo.')
    return params


class Bridge:
    def __init__(self):
        exe = shutil.which('codex') or str(Path.home() / 'AppData/Local/Programs/OpenAI/Codex/bin/codex.exe')
        self.exe = exe
        self.lock = threading.RLock()
        self.write_lock = threading.Lock()
        self.lifecycle_lock = threading.Lock()
        self.pending = {}
        self.requests = {}
        self.events = deque(maxlen=6000)
        self.sequence = 0
        self.counter = 0
        self.closed = False
        self.proc = None
        self.log = (ROOT / 'nexo-service.log').open('a', encoding='utf-8')
        self._launch()

    def _launch(self):
        self.closed = False
        self.proc = subprocess.Popen(
            [self.exe, 'app-server', '--stdio'],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self.log,
            text=True,
            encoding='utf-8',
            cwd=Path.home(),
            creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0),
        )
        threading.Thread(target=self.read, daemon=True).start()
        self.rpc('initialize', {'clientInfo': {'name': 'nexo_local', 'title': 'Nexo', 'version': '1.0.0'}})
        self.send({'method': 'initialized', 'params': {}})

    @property
    def connected(self):
        return not self.closed and self.proc is not None and self.proc.poll() is None

    def disconnect(self):
        with self.lifecycle_lock:
            if self.proc is not None and self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait(timeout=5)
            self.closed = True
            with self.lock:
                self.requests.clear()
        return {'connected': False}

    def reconnect(self):
        with self.lifecycle_lock:
            if self.connected:
                return {'connected': True}
            with self.lock:
                self.requests.clear()
            self._launch()
        return {'connected': True}

    def send(self, message):
        with self.write_lock:
            if self.closed:
                raise RuntimeError('A conexão com o assistente foi encerrada. Reinicie o Nexo.')
            self.proc.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
            self.proc.stdin.flush()

    def emit(self, message):
        with self.lock:
            self.sequence += 1
            self.events.append({'seq': self.sequence, **message})

    def read(self):
        try:
            for line in self.proc.stdout:
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                if 'method' not in msg and 'id' in msg:
                    with self.lock:
                        pending = self.pending.get(msg['id'])
                    if pending:
                        pending.put(msg)
                else:
                    if 'id' in msg:
                        with self.lock:
                            self.requests[str(msg['id'])] = msg
                    if msg.get('method') == 'serverRequest/resolved':
                        with self.lock:
                            self.requests.pop(str(msg.get('params', {}).get('requestId')), None)
                    self.emit(msg)
        finally:
            self.closed = True
            with self.lock:
                for pending in self.pending.values():
                    pending.put({'error': {'message': 'A conexão com o assistente terminou. Consulte nexo-service.log.'}})
            self.emit({'method': 'local/disconnected', 'params': {}})

    def rpc(self, method, params):
        with self.lock:
            self.counter += 1
            ident = self.counter
            pending = queue.Queue()
            self.pending[ident] = pending
        try:
            self.send({'id': ident, 'method': method, 'params': params})
            result = pending.get(timeout=90)
            if 'error' in result:
                raise RuntimeError(result['error'].get('message', str(result['error'])))
            return result.get('result', {})
        except queue.Empty:
            raise RuntimeError('O assistente demorou para responder. Atualize a conversa antes de tentar novamente.')
        finally:
            with self.lock:
                self.pending.pop(ident, None)

    def reply(self, ident, result=None, error=None):
        with self.lock:
            request = self.requests.pop(str(ident), None)
        if not request:
            raise ValueError('Esta solicitacao ja foi respondida ou expirou.')
        message = {'id': request['id']}
        message.update({'error': error} if error else {'result': result})
        self.send(message)
        return {}

    def close(self):
        self.disconnect()
        self.log.close()


ALLOWED = {
    'thread/list',
    'thread/read',
    'thread/start',
    'thread/resume',
    'thread/name/set',
    'turn/start',
    'turn/steer',
    'turn/interrupt',
    'account/read',
    'account/rateLimits/read',
    'account/usage/read',
    'model/list',
}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def output(self, status, body, mime='application/json; charset=utf-8'):
        raw = json.dumps(body, ensure_ascii=False).encode() if not isinstance(body, bytes) else body
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; "
            "img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        )
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def valid_host(self):
        return self.headers.get('Host') in {
            f'127.0.0.1:{self.server.server_port}',
            f'localhost:{self.server.server_port}',
        }

    def do_GET(self):
        if not self.valid_host():
            return self.output(403, {'error': 'Host invalido'})
        parsed = urlparse(self.path)
        if parsed.path == '/api/bootstrap':
            folders = personal_folders()
            default = folders.get('Documents') or next(iter(folders.values()), Path.home())
            return self.output(200, {
                'token': self.server.token,
                'cwd': str(default),
                'home': str(Path.home()),
                'personalFolders': {name: str(path) for name, path in folders.items()},
                'connected': self.server.bridge.connected,
            })
        if parsed.path == '/api/events':
            if self.headers.get('X-Local-Token') != self.server.token:
                return self.output(403, {'error': 'Token invalido'})
            try:
                after = int(parse_qs(parsed.query).get('after', ['0'])[0])
            except ValueError:
                return self.output(400, {'error': 'Cursor invalido'})
            bridge = self.server.bridge
            with bridge.lock:
                return self.output(200, {
                    'events': [e for e in bridge.events if e['seq'] > after],
                    'cursor': bridge.sequence,
                    'requests': list(bridge.requests.values()),
                    'connected': bridge.connected,
                })
        assets = {
            '/': ('index.html', 'text/html; charset=utf-8'),
            '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
            '/style.css': ('style.css', 'text/css; charset=utf-8'),
            '/nexo-mark.svg': ('nexo-mark.svg', 'image/svg+xml'),
            '/nexo-wordmark.svg': ('nexo-wordmark.svg', 'image/svg+xml'),
        }
        if parsed.path in assets:
            name, mime = assets[parsed.path]
            return self.output(200, (ROOT / 'static' / name).read_bytes(), mime)
        self.output(404, {'error': 'Nao encontrado'})

    def do_POST(self):
        origin = self.headers.get('Origin')
        origins = {
            f'http://127.0.0.1:{self.server.server_port}',
            f'http://localhost:{self.server.server_port}',
        }
        if not self.valid_host() or origin not in origins or self.headers.get('X-Local-Token') != self.server.token:
            return self.output(403, {'error': 'Origem ou token invalido'})
        try:
            size = int(self.headers.get('Content-Length', 0))
            upload = self.path == '/api/upload'
            if not 0 < size <= (14_000_000 if upload else 2_000_000):
                raise ValueError('Tamanho de mensagem invalido')
            data = json.loads(self.rfile.read(size))
            bridge = self.server.bridge
            if self.path == '/api/service':
                action = data.get('action')
                if action == 'on':
                    result = bridge.reconnect()
                elif action == 'off':
                    result = bridge.disconnect()
                else:
                    raise ValueError('Ação inválida.')
            elif upload:
                name = Path(str(data.get('name', '')).replace('\\', '/')).name
                suffix = Path(name).suffix.lower()
                if not name or suffix in BLOCKED_TYPES:
                    raise ValueError('Tipo de arquivo nao aceito.')
                try:
                    content = base64.b64decode(data['data'], validate=True)
                except (ValueError, KeyError):
                    raise ValueError('Arquivo invalido.')
                if not content or len(content) > 10_000_000:
                    raise ValueError('Cada arquivo deve ter no maximo 10 MB.')
                ATTACHMENTS.mkdir(parents=True, exist_ok=True)
                stored = ATTACHMENTS / (uuid.uuid4().hex + suffix)
                stored.write_bytes(content)
                guessed = mimetypes.guess_type(name)[0] or 'application/octet-stream'
                inline_text = None
                if suffix in {'.txt', '.md', '.csv', '.json', '.log', '.xml', '.yaml', '.yml'} and len(content) <= 65_536:
                    try:
                        inline_text = content.decode('utf-8-sig')
                    except UnicodeDecodeError:
                        inline_text = content.decode('cp1252', errors='replace')
                result = {
                    'id': stored.stem,
                    'name': name,
                    'size': len(content),
                    'mime': guessed,
                    'image': suffix in IMAGE_TYPES,
                    'path': str(stored),
                    'text': inline_text,
                }
            elif self.path == '/api/rpc':
                method = data['method']
                if method not in ALLOWED:
                    raise ValueError('Metodo nao permitido')
                result = bridge.rpc(method, scoped_rpc_params(method, data.get('params', {})))
            elif self.path == '/api/reply':
                result = bridge.reply(data['id'], data.get('result'), data.get('error'))
            else:
                return self.output(404, {'error': 'Nao encontrado'})
            self.output(200, result)
        except (ValueError, KeyError, RuntimeError, OSError) as error:
            self.output(400, {'error': str(error)})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.token = secrets.token_urlsafe(32)
    server.bridge = Bridge()
    atexit.register(server.bridge.close)
    print(f'Nexo: http://127.0.0.1:{args.port}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        server.bridge.close()


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Probe FileScope prerequisites on the actual QNX target image."""
import importlib
from importlib import metadata
import io
import json
import os
import platform
import shutil
import socket
import sqlite3
import ssl
import stat
import sys
import tempfile
import zipfile
from pathlib import Path

MODULES = ('flask', 'werkzeug', 'jinja2', 'itsdangerous', 'click', 'blinker', 'sqlite3', 'zipfile', 'zlib', 'ssl')
report = {
    'platform': platform.platform(), 'system': platform.system(), 'python': sys.version,
    'filesystem': {name: hasattr(os, name) for name in ('statvfs', 'walk', 'replace', 'chmod')},
    'modules': {}, 'probes': {},
}
for name in MODULES:
    try:
        module = importlib.import_module(name)
        try:
            report['modules'][name] = metadata.version(name)
        except metadata.PackageNotFoundError:
            report['modules'][name] = 'available'
    except Exception as error:
        report['modules'][name] = f'missing: {error}'

temp_root = os.environ.get('FILEMANAGER_TMP') or tempfile.gettempdir()
try:
    with tempfile.TemporaryDirectory(prefix='filescope-check-', dir=temp_root) as directory:
        first, second = Path(directory) / 'source.txt', Path(directory) / 'renamed.txt'
        first.write_text('filesystem probe', encoding='utf-8')
        os.chmod(first, 0o640)
        os.replace(first, second)
        report['filesystem']['writable_temp'] = second.read_text(encoding='utf-8') == 'filesystem probe'
        report['filesystem']['chmod'] = stat.S_IMODE(second.stat().st_mode) == 0o640
        report['filesystem']['free_bytes'] = shutil.disk_usage(directory).free
except Exception as error:
    report['filesystem']['writable_temp'] = f'failed: {error}'

try:
    with sqlite3.connect(':memory:') as database:
        report['probes']['sqlite3_runtime'] = database.execute('select 1').fetchone()[0] == 1
except Exception as error:
    report['probes']['sqlite3_runtime'] = f'failed: {error}'
try:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, 'w', zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('probe.txt', 'zip runtime probe')
    stream.seek(0)
    with zipfile.ZipFile(stream) as archive:
        report['probes']['zip_deflate_runtime'] = archive.read('probe.txt') == b'zip runtime probe'
except Exception as error:
    report['probes']['zip_deflate_runtime'] = f'failed: {error}'
try:
    ssl.create_default_context()
    report['probes']['tls_context'] = True
except Exception as error:
    report['probes']['tls_context'] = f'failed: {error}'
try:
    with socket.socket() as probe_socket:
        probe_socket.bind(('127.0.0.1', 0))
    report['probes']['loopback_socket'] = True
except Exception as error:
    report['probes']['loopback_socket'] = f'inconclusive: {error}'

print(json.dumps(report, indent=2, ensure_ascii=False))
missing = [name for name, value in report['modules'].items() if str(value).startswith('missing:')]
if sys.version_info < (3, 10):
    missing.append('Python >= 3.10')
if not all(report['filesystem'].get(key) is True for key in ('statvfs', 'walk', 'replace', 'chmod', 'writable_temp')):
    missing.append('required filesystem APIs (statvfs/walk/replace/chmod/writable temp)')
for key in ('sqlite3_runtime', 'zip_deflate_runtime', 'tls_context'):
    if report['probes'].get(key) is not True:
        missing.append(key)
if missing:
    print('MISSING/FAILED: ' + ', '.join(missing), file=sys.stderr)
    raise SystemExit(1)

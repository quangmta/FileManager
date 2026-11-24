#!/usr/bin/env python3
"""Run on the KR260 target image to report FileScope runtime prerequisites."""
import importlib
from importlib import metadata
import json
import io
import os
import platform
import shutil
import sys
import tempfile
from pathlib import Path

MODULES = ('flask', 'werkzeug', 'sqlite3', 'zipfile', 'zlib', 'ssl')
report = {
    'platform': platform.platform(),
    'system': platform.system(),
    'python': sys.version,
    'filesystem': {'statvfs': hasattr(os, 'statvfs'), 'walk': hasattr(os, 'walk'), 'replace': hasattr(os, 'replace')},
    'modules': {},
}
for name in MODULES:
    try:
        module = importlib.import_module(name)
        report['modules'][name] = metadata.version(name) if name in ('flask','werkzeug') else getattr(module, '__version__', 'available')
    except Exception as error:
        report['modules'][name] = f'missing: {error}'

try:
    with tempfile.TemporaryDirectory(prefix='filescope-check-') as directory:
        first = Path(directory) / 'source.txt'
        second = Path(directory) / 'renamed.txt'
        first.write_text('filesystem probe', encoding='utf-8')
        os.replace(first, second)
        report['filesystem']['writable_temp'] = second.read_text(encoding='utf-8') == 'filesystem probe'
        report['filesystem']['free_bytes'] = shutil.disk_usage(directory).free
except Exception as error:
    report['filesystem']['writable_temp'] = f'failed: {error}'

try:
    import sqlite3
    with sqlite3.connect(':memory:') as database:
        report['modules']['sqlite3_runtime'] = database.execute('select 1').fetchone()[0] == 1
except Exception as error:
    report['modules']['sqlite3_runtime'] = f'failed: {error}'
try:
    import zipfile
    stream=io.BytesIO()
    with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:archive.writestr('probe.txt','zip runtime probe')
    stream.seek(0)
    with zipfile.ZipFile(stream) as archive:report['modules']['zip_deflate_runtime']=archive.read('probe.txt')==b'zip runtime probe'
except Exception as error:
    report['modules']['zip_deflate_runtime']=f'failed: {error}'

print(json.dumps(report, indent=2, ensure_ascii=False))
missing = [name for name, value in report['modules'].items() if str(value).startswith('missing:')]
if sys.version_info < (3, 10):
    missing.append('Python >= 3.10')
if not all(report['filesystem'].get(key) for key in ('statvfs', 'walk', 'replace', 'writable_temp')):
    missing.append('required filesystem APIs')
if report['modules'].get('sqlite3_runtime') is not True:missing.append('sqlite3 runtime')
if report['modules'].get('zip_deflate_runtime') is not True:missing.append('ZIP Deflate/zlib runtime')
if missing:
    print('MISSING: ' + ', '.join(missing), file=sys.stderr)
    raise SystemExit(1)

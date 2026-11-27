import io
import json
import os
import tempfile
import unittest
import zipfile
import time
from pathlib import Path
from unittest.mock import patch

import app as fm


class FileManagerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.root = base / 'managed'
        self.root.mkdir()
        fm.ROOT = self.root.resolve()
        fm.DB = base / 'private' / 'db.sqlite3'
        fm.app.secret_key = 'unit-test-secret-not-for-production'
        fm.app.config['TESTING'] = True
        fm.initdb()
        with fm.dbconn() as db:
            from werkzeug.security import generate_password_hash
            db.execute('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',
                       ('admin', generate_password_hash('strong-test-password'), 'admin', 'now'))
            db.execute('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',
                       ('reader', generate_password_hash('strong-reader-password'), 'read', 'now'))
        self.client = fm.app.test_client()

    def tearDown(self):
        self.temp.cleanup()

    def login(self, username='admin', password='strong-test-password'):
        response = self.client.post('/api/login', json={'username': username, 'password': password})
        self.assertEqual(response.status_code, 200)
        return response.json['csrf']

    def post(self, path, csrf, body):
        return self.client.post(path, json=body, headers={'X-CSRF-Token': csrf})

    def test_login_required_and_bad_password(self):
        self.assertEqual(self.client.get('/api/list').status_code, 401)
        self.assertEqual(self.client.post('/api/login', json={'username': 'admin', 'password': 'wrong'}).status_code, 401)

    def test_disk_uses_configured_mounts(self):
        self.login()
        with patch.dict(os.environ, {'FILEMANAGER_MOUNTS': str(self.root)}):
            response = self.client.get('/api/disk')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([entry['mount'] for entry in response.json['partitions']], [str(self.root)])

    def test_disk_non_linux_falls_back_without_proc_mounts(self):
        self.login()
        with patch.dict(os.environ, {}, clear=True), patch.object(fm.platform, 'system', return_value='QNX'):
            response = self.client.get('/api/disk')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([entry['mount'] for entry in response.json['partitions']], [str(self.root)])

    def test_reader_is_forbidden_from_mutating_and_audit(self):
        token = self.login('reader', 'strong-reader-password')
        self.assertEqual(self.post('/api/create', token, {'path': '', 'name': 'nope', 'type': 'file'}).status_code, 403)
        self.assertEqual(self.post('/api/transfer', token, {'path': 'a', 'destination': '', 'operation': 'copy'}).status_code, 403)
        self.assertEqual(self.client.get('/api/audit').status_code, 403)
        self.assertFalse((self.root / 'nope').exists())

    def test_qnx_per_core_cpu_is_normalized_separately_from_machine_total(self):
        self.login()
        process = {'pid': 4242, 'name': 'worker', 'uid': 1000, 'process_group': 4243,
                   'threads': [{'tid': 4243, 'last_cpu': 2}], 'cpu_ticks': 0,
                   'memory_bytes': 0, 'memory_percent': 0, 'start_time': 0}
        with patch('routes.system.platform.system', return_value='QNX'), \
             patch('routes.system._qnx_memory_snapshot', return_value={'total': 4 * 1024**3, 'cpu_count': 4}), \
             patch('routes.system._qnx_process_snapshot', return_value=[process]), \
             patch('routes.system._qnx_top_process_cpu', return_value={4242: {4243: 25.0}}):
            response = self.client.get('/api/system/processes')
        self.assertEqual(response.status_code, 200)
        row = response.json['processes'][0]
        self.assertEqual(response.json['poll_interval_ms'], 1000)
        self.assertEqual(row['cpu_percent'], 25.0)
        self.assertEqual(row['cpu_cores'], [0.0, 0.0, 100.0, 0.0])

    def test_file_operations_upload_download_and_audit(self):
        token = self.login()
        self.assertEqual(self.post('/api/create', token, {'path': '', 'name': 'folder', 'type': 'directory'}).status_code, 200)
        upload = self.client.post('/api/upload', data={'path': 'folder', 'files': (io.BytesIO(b'hello'), 'note.txt')}, headers={'X-CSRF-Token': token})
        self.assertEqual(upload.status_code, 200)
        downloaded = self.client.get('/api/download?path=folder/note.txt')
        self.assertEqual(downloaded.data, b'hello')
        downloaded.close()
        self.assertEqual(self.post('/api/chmod', token, {'path': 'folder/note.txt', 'mode': '640'}).status_code, 200)
        self.assertIn('rw-r-----', self.client.get('/api/list?path=folder').json['items'][0]['mode'])
        self.assertEqual(self.post('/api/rename', token, {'path': 'folder/note.txt', 'name': 'renamed.txt'}).status_code, 200)
        self.assertEqual(self.post('/api/delete', token, {'path': 'folder'}).status_code, 200)
        events = self.client.get('/api/audit')
        self.assertEqual(events.status_code, 200)
        self.assertTrue(any(e['action'] == 'delete' for e in events.json['events']))

    def test_directory_download_is_zip_and_audited(self):
        self.login()
        folder = self.root / 'folder'
        (folder / 'nested' / 'empty').mkdir(parents=True)
        (folder / 'note.txt').write_text('hello zip', encoding='utf-8')
        (folder / 'nested' / 'data.bin').write_bytes(b'\x00\x01archive')
        response = self.client.get('/api/download?path=folder')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.mimetype, 'application/zip')
        self.assertIn('folder.zip', response.headers['Content-Disposition'])
        with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
            self.assertEqual(archive.read('folder/note.txt'), b'hello zip')
            self.assertEqual(archive.read('folder/nested/data.bin'), b'\x00\x01archive')
            self.assertIn('folder/nested/empty/', archive.namelist())
        response.close()
        events = self.client.get('/api/audit').json['events']
        self.assertTrue(any(e['action'] == 'download_directory' and e['path'] == 'folder' for e in events))

    def test_directory_download_rejects_symlinks(self):
        self.login()
        folder = self.root / 'folder'
        folder.mkdir()
        outside = Path(self.temp.name) / 'outside.txt'
        outside.write_text('secret', encoding='utf-8')
        (folder / 'escape.txt').symlink_to(outside)
        response = self.client.get('/api/download?path=folder')
        self.assertEqual(response.status_code, 400)

    def test_upload_zip_safely_extracts_nested_files(self):
        token = self.login()
        target = self.root / 'destination'
        target.mkdir()
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w', zipfile.ZIP_DEFLATED) as archive:
            archive.writestr('package/', '')
            archive.writestr('package/sub/note.txt', 'archive data')
        data.seek(0)
        response = self.client.post('/api/upload-archive?path=destination',
            data={'archive': (data, 'package.zip')}, headers={'X-CSRF-Token': token})
        self.assertEqual(response.status_code, 200, response.json)
        self.assertEqual((target / 'package' / 'sub' / 'note.txt').read_text(), 'archive data')
        self.assertTrue(any(event['action']=='extract_archive' for event in self.client.get('/api/audit').json['events']))

    def test_upload_zip_rejects_traversal_and_conflicts(self):
        token=self.login();target=self.root/'destination';target.mkdir()
        bad=io.BytesIO()
        with zipfile.ZipFile(bad,'w') as archive:archive.writestr('../outside.txt','bad')
        bad.seek(0)
        response=self.client.post('/api/upload-archive?path=destination',data={'archive':(bad,'bad.zip')},headers={'X-CSRF-Token':token})
        self.assertEqual(response.status_code,400)
        self.assertFalse((self.root/'outside.txt').exists())
        (target/'taken.txt').write_text('original')
        conflict=io.BytesIO()
        with zipfile.ZipFile(conflict,'w') as archive:archive.writestr('taken.txt','replace')
        conflict.seek(0)
        response=self.client.post('/api/upload-archive?path=destination',data={'archive':(conflict,'conflict.zip')},headers={'X-CSRF-Token':token})
        self.assertEqual(response.status_code,409)
        self.assertEqual((target/'taken.txt').read_text(),'original')

    def test_search_and_capacity_filters(self):
        self.login()
        (self.root/'needle-alpha.txt').write_text('needle content')
        (self.root/'beta.pdf').write_bytes(b'12345')
        (self.root/'sub').mkdir();(self.root/'sub'/'needle.log').write_text('nested')
        response=self.client.get('/api/search?q=needle&type=file&min_size=1')
        self.assertEqual(response.status_code,200)
        self.assertEqual({item['name'] for item in response.json['items']},{'needle-alpha.txt','needle.log'})
        capacity=self.client.get('/api/capacity?path=')
        self.assertEqual(capacity.status_code,200)
        self.assertGreater(capacity.json['free'],0)
        self.assertGreater(capacity.json['max_upload'],0)

    def test_upload_is_rejected_when_destination_has_no_free_space(self):
        token=self.login();(self.root/'destination').mkdir()
        usage=os.statvfs(self.root)
        exhausted=type('Usage',(),{'total':usage.f_blocks*usage.f_frsize,'used':0,'free':1})()
        with patch('app.shutil.disk_usage',return_value=exhausted):
            response=self.client.post('/api/upload?path=destination',data={'files':(io.BytesIO(b'data'),'tiny.txt')},headers={'X-CSRF-Token':token})
        self.assertEqual(response.status_code,507)
        self.assertFalse((self.root/'destination'/'tiny.txt').exists())

    def test_idle_session_expiration_and_admin_revocation(self):
        token=self.login()
        with fm.dbconn() as db:db.execute('UPDATE sessions SET last_activity=?',(time.time()-fm.MAX_SESSION_IDLE-1,))
        self.assertEqual(self.client.get('/api/list').status_code,401)
        token=self.login()
        second=self.app_client()
        self.login_client(second,'reader','strong-reader-password')
        sessions=self.client.get('/api/admin/sessions').json['sessions']
        reader_session=next(item for item in sessions if item['username']=='reader')
        response=self.client.post('/api/admin/sessions/revoke',json={'session_key':reader_session['session_key']},headers={'X-CSRF-Token':token})
        self.assertEqual(response.status_code,200)
        self.assertEqual(second.get('/api/list').status_code,401)

    def app_client(self):
        return fm.app.test_client()

    def login_client(self,client,username,password):
        response=client.post('/api/login',json={'username':username,'password':password})
        self.assertEqual(response.status_code,200)
        return response.json['csrf']

    def test_backup_export_and_restore(self):
        token=self.login()
        backup=self.client.get('/api/admin/backup')
        self.assertEqual(backup.status_code,200)
        payload=json.loads(backup.data)
        self.assertEqual(payload['format'],'filescope-backup-v1')
        self.post('/api/users',token,{'username':'temporary','password':'long-temporary-password','role':'read'})
        form={'backup':(io.BytesIO(backup.data),'filescope-backup.json')}
        restored=self.client.post('/api/admin/restore',data=form,headers={'X-CSRF-Token':token})
        self.assertEqual(restored.status_code,200,restored.json)
        usernames={user['username'] for user in self.client.get('/api/users').json['users']}
        self.assertNotIn('temporary',usernames)
        self.assertIn('admin',usernames)

    def test_path_traversal_and_symlink_are_rejected(self):
        self.login()
        self.assertIn(self.client.get('/api/list?path=..').status_code, (400, 404))
        outside = Path(self.temp.name) / 'outside.txt'
        outside.write_text('secret')
        (self.root / 'escape').symlink_to(outside)
        self.assertFalse(any(x['name'] == 'escape' for x in self.client.get('/api/list').json['items']))
        self.assertIn(self.client.get('/api/download?path=escape').status_code, (400, 404))

    def test_tree_disk_and_create_file(self):
        token = self.login()
        (self.root / 'branch').mkdir()
        (self.root / 'branch' / 'leaf').mkdir()
        tree = self.client.get('/api/tree')
        self.assertEqual(tree.status_code, 200)
        self.assertEqual(tree.json['children'][0]['name'], 'branch')
        self.assertEqual(tree.json['children'][0]['children'][0]['name'], 'leaf')
        disk = self.client.get('/api/disk')
        self.assertEqual(disk.status_code, 200)
        self.assertTrue(disk.json['partitions'])
        self.assertTrue(all({'total', 'used', 'free', 'percent'} <= set(p) for p in disk.json['partitions']))
        self.assertEqual(self.post('/api/create', token, {'path': 'branch/leaf', 'name': 'new.txt', 'type': 'file'}).status_code, 200)
        self.assertEqual((self.root / 'branch' / 'leaf' / 'new.txt').read_bytes(), b'')
        self.assertEqual(self.post('/api/create', token, {'path': 'branch/leaf', 'name': 'new.txt', 'type': 'file'}).status_code, 409)

    def test_admin_can_manage_users(self):
        token = self.login()
        response = self.post('/api/users', token, {'username': 'writer', 'password': 'strong-writer-password', 'role': 'write'})
        self.assertEqual(response.status_code, 201)
        self.assertIn({'username': 'writer', 'role': 'write'}, [
            {'username': user['username'], 'role': user['role']} for user in self.client.get('/api/users').json['users']
        ])
        deleted = self.client.delete('/api/users/writer', headers={'X-CSRF-Token': token})
        self.assertEqual(deleted.status_code, 200)

    def test_copy_cut_paste_files_and_directories(self):
        token = self.login()
        (self.root / 'target').mkdir()
        (self.root / 'target2').mkdir()
        (self.root / 'notes.txt').write_text('copy me')
        (self.root / 'folder').mkdir()
        (self.root / 'folder' / 'nested.txt').write_text('nested')
        (self.root / 'folder' / 'child').mkdir()

        copied = self.post('/api/transfer', token, {'path': 'notes.txt', 'destination': 'target', 'operation': 'copy'})
        self.assertEqual(copied.status_code, 200)
        self.assertEqual((self.root / 'target' / 'notes.txt').read_text(), 'copy me')
        conflict = self.post('/api/transfer', token, {'path': 'notes.txt', 'destination': 'target', 'operation': 'copy'})
        self.assertEqual(conflict.status_code, 409)

        moved = self.post('/api/transfer', token, {'path': 'notes.txt', 'destination': 'target2', 'operation': 'cut'})
        self.assertEqual(moved.status_code, 200)
        self.assertFalse((self.root / 'notes.txt').exists())
        self.assertEqual((self.root / 'target2' / 'notes.txt').read_text(), 'copy me')

        copied_dir = self.post('/api/transfer', token, {'path': 'folder', 'destination': 'target', 'operation': 'copy'})
        self.assertEqual(copied_dir.status_code, 200)
        self.assertEqual((self.root / 'target' / 'folder' / 'nested.txt').read_text(), 'nested')
        outside = Path(self.temp.name) / 'outside.txt'
        outside.write_text('do not follow links')
        link = self.root / 'folder' / 'escape'
        link.symlink_to(outside)
        linked_copy = self.post('/api/transfer', token, {'path': 'folder', 'destination': 'target2', 'operation': 'copy'})
        self.assertEqual(linked_copy.status_code, 400)
        link.unlink()
        descendant = self.post('/api/transfer', token, {'path': 'folder', 'destination': 'folder/child', 'operation': 'cut'})
        self.assertEqual(descendant.status_code, 400)
        moved_dir = self.post('/api/transfer', token, {'path': 'folder', 'destination': 'target2', 'operation': 'cut'})
        self.assertEqual(moved_dir.status_code, 200)
        self.assertFalse((self.root / 'folder').exists())
        self.assertEqual((self.root / 'target2' / 'folder' / 'nested.txt').read_text(), 'nested')

    def test_preview_text_pdf_image_and_reject_html_rendering(self):
        self.login('reader', 'strong-reader-password')
        (self.root / 'readme.txt').write_text('Preview works', encoding='utf-8')
        (self.root / 'sample.pdf').write_bytes(b'%PDF-1.4\n%%EOF')
        (self.root / 'sample.png').write_bytes(b'png-bytes')
        (self.root / 'page.html').write_text('<script>alert(1)</script>', encoding='utf-8')
        (self.root / 'archive.bin').write_bytes(b'binary')

        text = self.client.get('/api/preview?path=readme.txt')
        self.addCleanup(text.close)
        self.assertEqual(text.status_code, 200)
        self.assertIn('text/plain', text.content_type)
        self.assertIn('inline', text.headers['Content-Disposition'])
        self.assertEqual(text.data, b'Preview works')
        pdf = self.client.get('/api/preview?path=sample.pdf')
        self.addCleanup(pdf.close)
        self.assertEqual(pdf.status_code, 200)
        self.assertEqual(pdf.mimetype, 'application/pdf')
        image = self.client.get('/api/preview?path=sample.png')
        self.addCleanup(image.close)
        self.assertEqual(image.status_code, 200)
        self.assertEqual(image.mimetype, 'image/png')
        unsafe = self.client.get('/api/preview?path=page.html')
        self.addCleanup(unsafe.close)
        self.assertEqual(unsafe.status_code, 200)
        self.assertEqual(unsafe.mimetype, 'text/plain')
        self.assertIn('nosniff', unsafe.headers['X-Content-Type-Options'])
        unsupported = self.client.get('/api/preview?path=archive.bin')
        self.assertEqual(unsupported.status_code, 415)

    def test_database_directory_is_not_browsable(self):
        fm.DB = self.root / '.filescope' / 'filemanager.sqlite3'
        fm.initdb()
        with fm.dbconn() as db:
            from werkzeug.security import generate_password_hash
            db.execute('INSERT INTO users(username,password_hash,role,created_at) VALUES(?,?,?,?)',
                       ('admin', generate_password_hash('strong-test-password'), 'admin', 'now'))
        self.login()
        protected = fm.DB.parent
        protected.mkdir(parents=True, exist_ok=True)
        (protected / fm.DB.name).touch()
        self.assertFalse(any(x['name'] == protected.name for x in self.client.get('/api/list').json['items']))
        self.assertEqual(self.client.get('/api/list?path=.filescope').status_code, 400)


if __name__ == '__main__':
    unittest.main()

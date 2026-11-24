import io
import os
import tempfile
import unittest
from pathlib import Path

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

    def test_reader_is_forbidden_from_mutating_and_audit(self):
        token = self.login('reader', 'strong-reader-password')
        self.assertEqual(self.post('/api/create', token, {'path': '', 'name': 'nope', 'type': 'file'}).status_code, 403)
        self.assertEqual(self.client.get('/api/audit').status_code, 403)
        self.assertFalse((self.root / 'nope').exists())

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
        descendant = self.post('/api/transfer', token, {'path': 'folder', 'destination': 'folder/child', 'operation': 'cut'})
        self.assertEqual(descendant.status_code, 400)
        moved_dir = self.post('/api/transfer', token, {'path': 'folder', 'destination': 'target2', 'operation': 'cut'})
        self.assertEqual(moved_dir.status_code, 200)
        self.assertFalse((self.root / 'folder').exists())
        self.assertEqual((self.root / 'target2' / 'folder' / 'nested.txt').read_text(), 'nested')

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

import hashlib
import os
import importlib.util
import json
from pathlib import Path
import sys
import tarfile
import tempfile
import time
import unittest

MODULE_PATH = Path(__file__).resolve().parent.parent / 'publisher.py'
spec = importlib.util.spec_from_file_location('publisher', MODULE_PATH)
publisher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = publisher
spec.loader.exec_module(publisher)

FAKE = r'''
import hashlib, json, os
from pathlib import Path
import shutil, sys, tarfile, time
mode = sys.argv[1]
args = sys.argv[2:]
root = Path(os.environ['FIXTURE_ROOT'])
if mode == 'rsync':
    src, dst = Path(args[-2]), Path(args[-1])
    ignored = {'node_modules','dist','.astro','.git','deploy','.trash','.ssh','.aws','.gnupg','.cache','__pycache__'}
    def omitted(p):
        return p.name in ignored or p.name.startswith('.env') or p.name.endswith(('.tmp','.bak','.pem','.key','.p12','.pfx','.crt','.cer','~'))
    def copytree(source, target):
        target.mkdir(parents=True, exist_ok=True)
        for prior in target.iterdir():
            if not omitted(prior) and not (source/prior.name).exists():
                shutil.rmtree(prior) if prior.is_dir() else prior.unlink()
        for p in source.iterdir():
            if omitted(p) or p.is_symlink(): continue
            q = target/p.name
            if p.is_dir(): copytree(p,q)
            else: shutil.copy2(p,q)
    copytree(src,dst)
    print('RSYNC PASS')
elif mode == 'npm':
    assert args[0] == 'run'
    assert os.environ['NODE_ENV'] == 'production'
    assert os.environ['SITE_URL'] == 'https://blog.rosekhlifa.com'
    assert os.environ['ASTRO_WHONO_BASE_PATH'] == '/'
    step = args[1]
    if (root/'fail').exists():
        print('fixture build rejected')
        sys.exit(7)
    if (root/'timeout').exists(): time.sleep(3)
    if step == 'build':
        if (root/'edit-during-build').exists():
            (root/'source/src/content/post.md').write_text('changed during build')
            (root/'edit-during-build').unlink()
        if (root/'verbose').exists(): print('x'*400000)
        output = Path.cwd()/'dist'
        output.mkdir(exist_ok=True)
        text = (Path.cwd()/'src/content/post.md').read_text()
        (output/'index.html').write_text('<html>'+text+'</html>')
        (output/'site.css').write_text('body{color:black}')
    print(step+' PASS')
elif mode == 'sudo':
    wrapper, release, expected = args
    archive=root/'online-incoming'/(release+'.tar.gz')
    assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected
    with tarfile.open(archive) as t:
        (root/'live.html').write_bytes(t.extractfile('index.html').read())
    count=root/'activations'
    count.write_text(str(int(count.read_text())+1 if count.exists() else 1))
    print('ACTIVATE PASS '+release)
'''

class PublisherIntegration(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='whono-publish-fixture-')
        self.root = Path(self.temp.name)
        (self.root/'source/src/content').mkdir(parents=True)
        (self.root/'source/src/content/post.md').write_text('baseline')
        (self.root/'source/public').mkdir()
        (self.root/'source/package.json').write_text('{}')
        (self.root/'source/.env').write_text('SECRET=fixture')
        (self.root/'source/public/test.key').write_text('fixture-key')
        (self.root/'source/.trash').mkdir()
        (self.root/'source/.trash/removed.md').write_text('deleted')
        (self.root/'build/node_modules').mkdir(parents=True)
        (self.root/'build/node_modules/installed').write_text('independent deps')
        (self.root/'live.html').write_text('previous live release')
        self.fake=self.root/'fake.py'
        self.fake.write_text(FAKE)
        self.config=publisher.Config(root=self.root,
            npm=(sys.executable,str(self.fake),'npm'),
            rsync=(sys.executable,str(self.fake),'rsync'),
            sudo=(sys.executable,str(self.fake),'sudo'),
            debounce=.05,poll=.01,timeout=2,retry=.1,
            environment={'FIXTURE_ROOT':str(self.root)})
        self.app=publisher.Publisher(self.config)
    def tearDown(self):
        self.app.close()
        self.temp.cleanup()
    def status(self):
        return json.loads((self.root/'publish-state/status.json').read_text())
    def count(self):
        path=self.root/'activations'
        return int(path.read_text()) if path.exists() else 0
    def publish(self):
        self.app.tick()
        time.sleep(.07)
        self.app.tick()
    def test_debounce_publish_snapshot_and_independent_dependencies(self):
        self.app.tick()
        self.assertEqual('queued',self.status()['state'])
        self.assertEqual(0,self.count())
        time.sleep(.025)
        (self.root/'source/src/content/post.md').write_text('final article')
        self.app.tick()
        time.sleep(.025)
        self.app.tick()
        self.assertEqual(0,self.count())
        time.sleep(.04)
        self.app.tick()
        self.assertEqual('published',self.status()['state'])
        self.assertEqual(1,self.count())
        self.assertIn('final article',(self.root/'live.html').read_text())
        self.assertEqual('independent deps',(self.root/'build/node_modules/installed').read_text())
        self.assertFalse((self.root/'build/.env').exists())
        with tarfile.open(next((self.root/'source-backups').glob('*.tar.gz'))) as archive:
            self.assertFalse(any('.env' in n or 'node_modules' in n or '.trash' in n or '.key' in n for n in archive.getnames()))
        if os.name != 'nt':
            self.assertEqual(0o644, (self.root/'publish-state/status.json').stat().st_mode & 0o777)
    def test_build_failure_preserves_live_and_retry_recovers(self):
        (self.root/'fail').touch()
        self.publish()
        self.assertEqual('error',self.status()['state'])
        self.assertIn('status 7',self.status()['error'])
        self.assertEqual(0,self.count())
        self.assertEqual('previous live release',(self.root/'live.html').read_text())
        self.assertFalse((self.root/'publish-state/last-published.json').exists())
        (self.root/'fail').unlink()
        self.app.tick()
        self.assertEqual(0,self.count())
        time.sleep(.12)
        self.app.tick()
        self.assertEqual(1,self.count())
    def test_change_during_build_queues_latest_and_skips_stale_activation(self):
        (self.root/'edit-during-build').touch()
        self.publish()
        self.assertEqual('queued',self.status()['state'])
        self.assertEqual(0,self.count())
        self.assertEqual('previous live release',(self.root/'live.html').read_text())
        self.publish()
        self.assertEqual('published',self.status()['state'])
        self.assertEqual(1,self.count())
        self.assertIn('changed during build',(self.root/'live.html').read_text())
    def test_restart_does_not_publish_same_version_and_recovers_pending_change(self):
        self.publish()
        saved=self.app.release_id
        self.app.close()
        self.app=publisher.Publisher(self.config)
        self.publish()
        self.assertEqual(1,self.count())
        self.assertEqual('published',self.status()['state'])
        self.assertEqual(saved,self.status()['releaseId'])
        (self.root/'source/src/content/post.md').write_text('saved before restart')
        self.app.close()
        self.app=publisher.Publisher(self.config)
        self.publish()
        self.assertEqual(2,self.count())
        self.assertIn('saved before restart',(self.root/'live.html').read_text())
    def test_timeout_does_not_activate(self):
        self.config.timeout=.2
        (self.root/'timeout').touch()
        self.publish()
        self.assertEqual('error',self.status()['state'])
        self.assertIn('exceeded 0.2 seconds',self.status()['error'])
        self.assertEqual(0,self.count())
    def test_latest_log_is_bounded(self):
        (self.root/'verbose').touch()
        self.publish()
        self.assertEqual('published',self.status()['state'])
        self.assertLessEqual((self.root/'publish-state/latest.log').stat().st_size,publisher.MAX_LOG_BYTES)
    def test_fingerprint_ignores_scratch_and_secrets_but_tracks_deletions(self):
        before=publisher.fingerprint(self.root/'source')
        (self.root/'source/src/content/work.tmp').write_text('scratch')
        (self.root/'source/.env').write_text('OTHER=fixture')
        self.assertEqual(before,publisher.fingerprint(self.root/'source'))
        (self.root/'source/src/content/post.md').unlink()
        self.assertNotEqual(before,publisher.fingerprint(self.root/'source'))

if __name__ == '__main__':
    unittest.main(verbosity=2)

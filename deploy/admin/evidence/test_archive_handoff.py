from pathlib import Path
import ast
import hashlib
import os
import stat
import subprocess
import sys
import tempfile
import unittest

WRAPPER = Path(sys.argv.pop(1)) if len(sys.argv)>1 else Path(__file__).resolve().parent.parent / 'activate-online.sh'
BODY = WRAPPER.read_text().split("<<'PY'\n",1)[1].split('\nPY\n',1)[0]
ast.parse(BODY)

@unittest.skipUnless(os.name == 'posix' and os.geteuid() == 0, 'Root Linux file flags required')
class RootArchiveHandoff(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='whono-root-archive-fixture-')
        self.root=Path(self.temp.name)
        (self.root/'online-incoming').mkdir()
        (self.root/'incoming').mkdir(mode=0o755)
        self.release='online-fixture'
        self.source=self.root/'online-incoming'/(self.release+'.tar.gz')
        self.target=self.root/'incoming'/(self.release+'.tar.gz')
        self.payload=b'fixture checked archive bytes'
        self.digest=hashlib.sha256(self.payload).hexdigest()
    def tearDown(self): self.temp.cleanup()
    def invoke(self,sha=None):
        body=BODY.replace('ROOT = Path("/opt/rosekhlifa-blog")','ROOT = Path('+repr(str(self.root))+')')
        return subprocess.run([sys.executable,'-c',body,self.release,sha or self.digest],capture_output=True,text=True)
    def test_valid_copy_is_root_owned_and_retries_identically(self):
        self.source.write_bytes(self.payload)
        result=self.invoke()
        self.assertEqual(0,result.returncode,result.stderr)
        self.assertEqual(self.payload,self.target.read_bytes())
        self.assertEqual(0,self.target.stat().st_uid)
        self.assertEqual(0o644,stat.S_IMODE(self.target.stat().st_mode))
        self.assertEqual(0,self.invoke().returncode)
    def test_symlink_source_is_rejected_without_target(self):
        other=self.root/'other'
        other.write_bytes(self.payload)
        self.source.symlink_to(other)
        result=self.invoke()
        self.assertNotEqual(0,result.returncode)
        self.assertFalse(self.target.exists())
    def test_digest_mismatch_removes_partial_root_copy(self):
        self.source.write_bytes(b'wrong archive bytes')
        result=self.invoke()
        self.assertNotEqual(0,result.returncode)
        self.assertIn('SHA256 mismatch',result.stderr)
        self.assertFalse(self.target.exists())
    def test_existing_different_archive_is_never_overwritten(self):
        self.source.write_bytes(self.payload)
        self.target.write_bytes(b'keep existing')
        self.target.chmod(0o644)
        result=self.invoke()
        self.assertNotEqual(0,result.returncode)
        self.assertEqual(b'keep existing',self.target.read_bytes())
    def test_writable_root_destination_directory_is_rejected(self):
        self.source.write_bytes(self.payload)
        (self.root/'incoming').chmod(0o777)
        result=self.invoke()
        self.assertNotEqual(0,result.returncode)
        self.assertFalse(self.target.exists())
    def test_fifo_source_fails_without_blocking(self):
        os.mkfifo(self.source)
        result=self.invoke()
        self.assertNotEqual(0,result.returncode)
        self.assertIn('regular file',result.stderr)
        self.assertFalse(self.target.exists())

if __name__ == '__main__': unittest.main(verbosity=2)

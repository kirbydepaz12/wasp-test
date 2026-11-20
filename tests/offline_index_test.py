"""Run independently: python3 tests/offline_index_test.py. No network or real library."""
import hashlib, importlib.util, io, json, os, sqlite3, tarfile, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('offline_index',Path(__file__).resolve().parents[1]/'docker/offline-index.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
A='11111111-1111-4111-8111-111111111111'; B='22222222-2222-4222-8222-222222222222'
def archive(p,kind,records,member=None):
    data=b''.join(json.dumps(row).encode()+b'\n' for row in records)
    with tarfile.open(p,'w:xz') as tar:
        for name,body in [(member or 'mbdump/'+kind,data),('../../forbidden',b'not extracted')]:
            info=tarfile.TarInfo(name);info.size=len(body);tar.addfile(info,io.BytesIO(body))
class IndexTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.d=Path(self.tmp.name);self.arts=self.d/'artist.tar.xz';self.albs=self.d/'release-group.tar.xz'; self.a={'id':A,'name':'Band','country':'PH','tags':[{'name':'ignored'}]};self.b={'id':B,'title':'Album','artist-credit':[{'name':'Band'}],'first-release-date':'2003-04-01'}
        archive(self.arts,'artist',[self.a]);archive(self.albs,'release-group',[self.b]);self.archives={'artist':self.arts,'release-group':self.albs}
    def tearDown(self): self.tmp.cleanup()
    def build(self,version='20261118-001001'):m.create_index(self.d,version,self.archives)
    def test_import_and_atomic_replacement(self):
        self.build(); db=self.d/'index.sqlite'
        with sqlite3.connect(db) as con:
            self.assertEqual(con.execute('SELECT * FROM artists').fetchone(),('band',A,'PH'));self.assertEqual(con.execute('SELECT * FROM albums').fetchone(),('band','album',B,2003));self.assertEqual(con.execute('PRAGMA quick_check').fetchone()[0],'ok')
        archive(self.albs,'release-group',[{**self.b,'first-release-date':'2010'}]);self.build('20261121-001001')
        with sqlite3.connect(db) as con:self.assertEqual(con.execute('SELECT year FROM albums').fetchone()[0],2010)
    def test_bad_update_keeps_previous_index(self):
        self.build(); old=hashlib.sha256((self.d/'index.sqlite').read_bytes()).digest();archive(self.albs,'release-group',[self.b],member='wrong')
        with self.assertRaises(RuntimeError): self.build('20261121-001001')
        self.assertEqual(hashlib.sha256((self.d/'index.sqlite').read_bytes()).digest(),old);self.assertFalse((self.d/'index.build.sqlite').exists())
    def test_ambiguous_and_missing_records_preserved(self):
        archive(self.arts,'artist',[self.a,{**self.a,'id':B,'country':None}]);self.build()
        with sqlite3.connect(self.d/'index.sqlite') as con:self.assertEqual(len(con.execute('SELECT * FROM artists WHERE name=?',('band',)).fetchall()),2)
    def test_checksum_failure_and_storage_gate(self):
        class Resp(io.BytesIO):
            headers={'Content-Length':'3'}
        with patch.object(m,'remote',return_value=Resp(b'abc')):
            with self.assertRaisesRegex(RuntimeError,'SHA-256'):m.download(self.d,'20261118-001001','artist','0'*64)
        self.assertFalse((self.d/'artist.tar.xz.part').exists())
        with patch.object(m.shutil,'disk_usage',return_value=type('Disk',(),{'free':0})()):
            with self.assertRaisesRegex(RuntimeError,'Insufficient'):m.guard(self.d,m.MIN_FREE)
if __name__=='__main__':unittest.main()

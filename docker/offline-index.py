#!/usr/bin/env python3
"""Build an atomic, compact SQLite index from official MusicBrainz JSONL dumps.
No music files or WASP operational database are opened by this process.
"""
import argparse, hashlib, json, os, re, shutil, sqlite3, tarfile, time, urllib.request, urllib.parse
from pathlib import Path

BASE = 'https://ftp.musicbrainz.org/pub/musicbrainz/data/json-dumps/'
KINDS = ('artist', 'release-group')
GIB = 1024**3
MIN_FREE = 10 * GIB
RESERVE = 2 * GIB
UUID = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$', re.I)
STAMP = re.compile(r'^\d{8}-\d{6}$')

def norm(value):
    return str(value or '').strip()[:200].lower()

def publish(directory, **values):
    tmp = directory / 'status.tmp'
    tmp.write_text(json.dumps({**values, 'updated': int(time.time()*1000)}), encoding='utf-8')
    os.replace(tmp, directory / 'status.json')

def guard(directory, minimum=RESERVE):
    if shutil.disk_usage(directory).free < minimum:
        raise RuntimeError('Insufficient free disk space; existing index retained. Free or expand storage.')

class OfficialRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        u = urllib.parse.urlparse(newurl)
        if u.scheme != 'https' or u.hostname not in ('ftp.musicbrainz.org', 'data.metabrainz.org') or not u.path.startswith('/pub/musicbrainz/data/json-dumps/'):
            raise RuntimeError('Unexpected MusicBrainz download redirect')
        return super().redirect_request(req, fp, code, msg, headers, newurl)

OPENER = urllib.request.build_opener(OfficialRedirect())
def remote(url):
    return OPENER.open(urllib.request.Request(url, headers={'User-Agent':'WASP-offline-metadata/18.0.4'}), timeout=60)

def download(directory, stamp, kind, expected):
    name = kind + '.tar.xz'
    partial = directory / (name + '.part')
    digest = hashlib.sha256()
    size = 0
    last = 0
    try:
        with remote(BASE + stamp + '/' + name) as response, partial.open('wb') as out:
            total = int(response.headers.get('Content-Length') or 0)
            if total and shutil.disk_usage(directory).free < total + RESERVE:
                raise RuntimeError('Insufficient disk space for archive plus reserve')
            while True:
                chunk = response.read(1024*1024)
                if not chunk: break
                out.write(chunk); digest.update(chunk); size += len(chunk)
                if time.monotonic()-last >= 2:
                    guard(directory); publish(directory,state='downloading',snapshot=stamp,entity=kind,bytes=size,totalBytes=total); last=time.monotonic()
        if digest.hexdigest() != expected or (total and size != total):
            raise RuntimeError('MusicBrainz archive SHA-256 verification failed')
        guard(directory)
        return partial
    except BaseException:
        partial.unlink(missing_ok=True)
        raise

def facts(kind, obj):
    mid = obj.get('id')
    if not isinstance(mid,str) or not UUID.fullmatch(mid): return None
    if kind == 'artist':
        name = norm(obj.get('name'))
        begin = obj.get('begin-area') or {}
        area = obj.get('area') or {}
        code = (begin.get('iso-3166-1-codes') or [None])[0] or obj.get('country') or (area.get('iso-3166-1-codes') or [None])[0]
        code = code if isinstance(code,str) and re.fullmatch('[A-Z]{2}',code) else None
        # Retain unknown-country artists to reject ambiguous names rather than choosing the sole known one.
        return (name, mid, code) if name else None
    credit = obj.get('artist-credit') or []
    name = norm(''.join((c.get('name') or (c.get('artist') or {}).get('name') or '')+(c.get('joinphrase') or '') for c in credit))
    title = norm(obj.get('title'))
    raw = str(obj.get('first-release-date') or '')
    year = int(raw[:4]) if re.match(r'^\d{4}(?:-|$)',raw) else None
    if year is not None and not 1850 <= year <= time.gmtime().tm_year+1: year=None
    return (name,title,mid,year) if name and title else None

def create_index(directory, stamp, archives=None):
    tmp = directory / 'index.build.sqlite'
    tmp.unlink(missing_ok=True)
    os.environ['SQLITE_TMPDIR']=str(directory)
    con = sqlite3.connect(tmp)
    try:
        con.executescript('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-32768; CREATE TABLE artists(name TEXT NOT NULL, mbid TEXT NOT NULL, country TEXT); CREATE TABLE albums(artist TEXT NOT NULL, title TEXT NOT NULL, mbid TEXT NOT NULL, year INTEGER); CREATE TABLE snapshot(version TEXT NOT NULL, artists INTEGER NOT NULL, albums INTEGER NOT NULL);')
        counts={}
        manifest={} if archives else checksums(stamp)
        for kind in KINDS:
            source = Path(archives[kind]) if archives else download(directory,stamp,kind,manifest[kind])
            table, placeholders = ('artists','?,?,?') if kind=='artist' else ('albums','?,?,?,?')
            count=0; seen=0; batch=[]; last=0; found=False
            try:
                with tarfile.open(source,'r|xz') as tar:
                    for member in tar:
                        if not member.isfile() or member.name.strip('./') != 'mbdump/'+kind: continue
                        if found: raise RuntimeError('Unexpected duplicate data member')
                        found=True
                        stream=tar.extractfile(member)
                        for line in stream:
                            obj=json.loads(line); seen+=1
                            item=facts(kind,obj)
                            if item: batch.append(item)
                            if len(batch)>=5000:
                                con.executemany(f'INSERT INTO {table} VALUES({placeholders})',batch); count+=len(batch); batch=[]; con.commit()
                            if time.monotonic()-last>=4:
                                guard(directory); publish(directory,state='indexing',snapshot=stamp,entity=kind,records=seen,indexed=count,uncompressedBytes=stream.tell(),totalUncompressedBytes=member.size); last=time.monotonic()
                if not found or not seen: raise RuntimeError('MusicBrainz JSONL archive missing expected data member')
                if batch: con.executemany(f'INSERT INTO {table} VALUES({placeholders})',batch); count+=len(batch)
                con.commit(); counts[kind]=count
                if not count: raise RuntimeError('MusicBrainz index contains no usable records')
            finally:
                if not archives: source.unlink(missing_ok=True)
        guard(directory)
        publish(directory,state='building-indexes',snapshot=stamp,artists=counts['artist'],albums=counts['release-group'])
        last_check=[0.0]
        def monitor():
            if time.monotonic()-last_check[0]>2:
                last_check[0]=time.monotonic()
                if shutil.disk_usage(directory).free<RESERVE:return 1
            return 0
        con.set_progress_handler(monitor,100000)
        con.executescript('CREATE INDEX artist_name ON artists(name); CREATE INDEX album_identity ON albums(artist,title);')
        con.execute('INSERT INTO snapshot VALUES(?,?,?)',(stamp,counts['artist'],counts['release-group']))
        con.commit()
        if con.execute('PRAGMA quick_check').fetchone()[0]!='ok': raise RuntimeError('Offline index integrity check failed')
        con.close(); con=None
        guard(directory)
        os.replace(tmp,directory/'index.sqlite')
        publish(directory,state='ready',snapshot=stamp,artists=counts['artist'],albums=counts['release-group'])
    finally:
        if con is not None: con.close()
        tmp.unlink(missing_ok=True)

def checksums(stamp):
    with remote(BASE+stamp+'/SHA256SUMS') as response: raw=response.read(65536).decode('ascii')
    result={}
    for line in raw.splitlines():
        m=re.fullmatch(r'([a-fA-F0-9]{64})\s+\*?(?:\./)?(artist|release-group)\.tar\.xz',line.strip())
        if m: result[m[2]]=m[1].lower()
    if set(result)!=set(KINDS): raise RuntimeError('Official SHA-256 manifest missing required files')
    return result

def main(directory):
    directory.mkdir(parents=True,exist_ok=True)
    try:
        publish(directory,state='checking')
        with remote(BASE+'LATEST') as response: stamp=response.read(128).decode('ascii').strip()
        if not STAMP.fullmatch(stamp): raise RuntimeError('Invalid MusicBrainz snapshot identifier')
        current=directory/'index.sqlite'
        if current.exists():
            with sqlite3.connect(f'file:{current}?mode=ro',uri=True) as con:
                version,artists,albums=con.execute('SELECT * FROM snapshot').fetchone()
            if stamp==version:
                publish(directory,state='ready',snapshot=stamp,artists=artists,albums=albums); return
        guard(directory,MIN_FREE)
        create_index(directory,stamp)
    except Exception as error:
        publish(directory,state='error',error=str(error)[:250]); raise

if __name__=='__main__':
    parser=argparse.ArgumentParser(); parser.add_argument('directory',type=Path); args=parser.parse_args(); main(args.directory)

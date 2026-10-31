#!/usr/bin/env python3
"""Create and fully read-verify an encrypted recovery archive of one stopped writer.
Supply the existing backup passphrase over stdin, never argv or repository files.
"""
import sys, subprocess, os, pathlib, json, hashlib, tarfile, datetime
key = sys.stdin.buffer.read().strip()
if len(key) < 24:
    raise SystemExit('Backup key unavailable; nothing changed')
root = pathlib.Path('/var/backups/essoria-connect')
root.mkdir(mode=0o700, parents=True, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
archive = root / (stamp + '.tar.enc')
partial = root / (stamp + '.partial.enc')
if archive.exists() or partial.exists():
    raise SystemExit('Existing archive preserved')
service = 'essoria-connect.service'
was_active = subprocess.run(['systemctl', 'is-active', '--quiet', service]).returncode == 0
paths = [pathlib.Path('/var/lib/essoria-connect'), pathlib.Path('/etc/essoria-connect')]
current = pathlib.Path('/opt/essoria-connect/current')
if current.exists():
    paths += [current, current.resolve()]
paths = [p for p in paths if p.exists()]
if not paths:
    raise SystemExit('No Essoria data found')

def password_fd():
    r, w = os.pipe()
    os.write(w, key + b'\n')
    os.close(w)
    return r

try:
    if was_active:
        subprocess.run(['systemctl', 'stop', service], check=True)
    r = password_fd()
    try:
        fd = os.open(partial, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'wb') as out:
            tar = subprocess.Popen(['tar', '--numeric-owner', '-C', '/', '-czf', '-',
                *[str(p).lstrip('/') for p in paths]], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            enc = subprocess.run(['openssl', 'enc', '-aes-256-cbc', '-salt', '-pbkdf2', '-iter', '200000',
                '-pass', 'fd:' + str(r)], stdin=tar.stdout, stdout=out, pass_fds=(r,), stderr=subprocess.DEVNULL)
            tar.stdout.close()
            code = tar.wait()
        if code or enc.returncode:
            raise RuntimeError('Encryption failed')
    finally:
        os.close(r)
    r, count = password_fd(), 0
    try:
        dec = subprocess.Popen(['openssl', 'enc', '-d', '-aes-256-cbc', '-pbkdf2', '-iter', '200000',
            '-pass', 'fd:' + str(r), '-in', str(partial)], stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, pass_fds=(r,))
        with tarfile.open(fileobj=dec.stdout, mode='r|gz') as tf:
            for entry in tf:
                count += 1
                if entry.isfile():
                    f = tf.extractfile(entry)
                    while f.read(1024 * 1024):
                        pass
        if dec.wait():
            raise RuntimeError('Read-back verification failed')
    finally:
        os.close(r)
    partial.rename(archive)
    h = hashlib.sha256()
    with archive.open('rb') as f:
        while chunk := f.read(1024 * 1024):
            h.update(chunk)
    receipt = {'archive': str(archive), 'bytes': archive.stat().st_size, 'sha256': h.hexdigest(),
        'verified_entries': count, 'encrypted': True,
        'release': current.resolve().name if current.exists() else None}
    (root / (stamp + '.receipt.json')).write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))
finally:
    partial.unlink(missing_ok=True)
    if was_active:
        subprocess.run(['systemctl', 'start', service], check=True)

#!/usr/bin/env python3
"""
deploy_qris.py — SSH/SCP helper for aacsensoria.id VPS via paramiko.

Usage:
  python scripts/deploy_qris.py exec "<shell command>"
  python scripts/deploy_qris.py put  <local-path>  <remote-path>
  python scripts/deploy_qris.py get  <remote-path> <local-path>

Credentials come from env vars (set per-invocation, never stored):
  VPS_HOST (default 72.60.193.211), VPS_USER (default root), VPS_PASS.
"""
import os
import sys

import paramiko


def connect():
    host = os.environ.get("VPS_HOST", "72.60.193.211")
    user = os.environ.get("VPS_USER", "root")
    password = os.environ.get("VPS_PASS", "")
    if not password:
        print("ERROR: VPS_PASS env var is required", file=sys.stderr)
        sys.exit(2)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(host, username=user, password=password, timeout=20, banner_timeout=20)
    return client


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    mode = sys.argv[1]
    client = connect()
    try:
        if mode == "exec":
            cmd = sys.argv[2]
            stdin, stdout, stderr = client.exec_command(cmd, timeout=120)
            out = stdout.read().decode("utf-8", "replace")
            err = stderr.read().decode("utf-8", "replace")
            rc = stdout.channel.recv_exit_status()
            if out:
                print(out, end="")
            if err:
                print(err, end="", file=sys.stderr)
            sys.exit(rc)
        elif mode == "put":
            local, remote = sys.argv[2], sys.argv[3]
            sftp = client.open_sftp()
            sftp.put(local, remote)
            sftp.close()
            print(f"PUT ok: {local} -> {remote}")
        elif mode == "get":
            remote, local = sys.argv[2], sys.argv[3]
            sftp = client.open_sftp()
            sftp.get(remote, local)
            sftp.close()
            print(f"GET ok: {remote} -> {local}")
        else:
            print(f"Unknown mode: {mode}", file=sys.stderr)
            sys.exit(2)
    finally:
        client.close()


if __name__ == "__main__":
    main()

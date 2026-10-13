#!/usr/bin/env python3
"""Manage the per-project macOS Codex bridge without touching Codex's own daemon."""
import argparse, hashlib, os, plistlib, shutil, subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
suffix=hashlib.sha256(str(root).encode()).hexdigest()[:16]
label='ai.gossipcat.codex-bridge.'+suffix
plist=Path.home()/'Library/LaunchAgents'/(label+'.plist')
dir=root/'.gossip/codex-bridge'
p=argparse.ArgumentParser();p.add_argument('action',choices=['install','start','restart','stop','status','uninstall']);args=p.parse_args()
uid=os.getuid();service='gui/'+str(uid)+'/'+label
if args.action=='install':
 node=shutil.which('node')
 if not node:raise SystemExit('node is required')
 script=root/'dist-mcp/codex-bridge-server.js'
 if not script.exists():raise SystemExit('Run npm run build:mcp first')
 dir.mkdir(parents=True,exist_ok=True,mode=0o700);plist.parent.mkdir(parents=True,exist_ok=True)
 config={'Label':label,'ProgramArguments':[node,str(script),str(root)],'WorkingDirectory':str(root),'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,'EnvironmentVariables':{'PATH':str(Path(node).parent)+':/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'},'StandardOutPath':str(dir/'service.log'),'StandardErrorPath':str(dir/'service-error.log')}
 if plist.exists() and plistlib.loads(plist.read_bytes())!=config:raise SystemExit('Existing service configuration differs; inspect it before replacing')
 plist.write_bytes(plistlib.dumps(config));plist.chmod(0o600)
 (dir/'enabled').write_text('1\n');(dir/'enabled').chmod(0o600)
 print('Installed '+str(plist));print('Start: python3 scripts/codex-bridge-service.py start')
elif args.action=='start':
 check=subprocess.run(['launchctl','print',service],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if check.returncode==0:print('Already running: '+service)
 else:
  result=subprocess.run(['launchctl','bootstrap','gui/'+str(uid),str(plist)])
  if result.returncode:raise SystemExit('LaunchAgent could not start here. Run the same start command in a normal macOS terminal. Exit: '+str(result.returncode))
elif args.action=='restart':
 import json
 for job in dir.glob('job-*.json'):
  if json.loads(job.read_text()).get('status') in ['queued','running']:raise SystemExit('Finish pending Codex tasks before restarting the bridge')
 result=subprocess.run(['launchctl','kickstart','-k',service])
 if result.returncode:raise SystemExit('Restart failed here. Run the same restart command in a normal macOS terminal.')
elif args.action=='status':subprocess.run(['launchctl','print',service],check=True)
elif args.action=='stop':subprocess.run(['launchctl','bootout',service],check=True)
elif args.action=='uninstall':
 subprocess.run(['launchctl','bootout',service],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if plist.exists():plist.unlink()
 marker=dir/'enabled'
 if marker.exists():marker.unlink()
 print('Removed bridge launch agent; durable task records retained. Reconnect Gossipcat to use the direct CLI worker.')

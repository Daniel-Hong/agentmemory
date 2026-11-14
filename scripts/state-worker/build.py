#!/usr/bin/env python3
"""Build local State artifact from pinned clean git objects, never working-tree files."""
import argparse, hashlib, json, os, pathlib, subprocess, tarfile

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def run(args, **kwargs): return subprocess.run(args, check=True, **kwargs)
def output(args, **kwargs): return subprocess.check_output(args, text=True, **kwargs).strip()

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--workers-source', required=True, type=pathlib.Path)
    parser.add_argument('--output', required=True, type=pathlib.Path)
    parser.add_argument('--work-dir', required=True, type=pathlib.Path)
    parser.add_argument('--cargo', default='cargo')
    parser.add_argument('--jobs', type=int, default=2)
    parser.add_argument('--resume', action='store_true', help='Reuse a marked build workspace and Cargo cache')
    parser.add_argument('--online', action='store_true', help='Allow Cargo registry downloads; default uses cached dependencies')
    args=parser.parse_args()
    if not 1 <= args.jobs <= 32: parser.error('jobs must be 1..32')
    repo=pathlib.Path(__file__).resolve().parents[2]
    pin=json.loads((repo/'deploy/state-worker/pin.json').read_text()); patch=repo/'deploy/state-worker/compat.patch'
    if sha(patch)!=pin['patchSha256']: raise RuntimeError('State patch digest mismatch')
    source=args.workers_source.resolve(); work=args.work_dir.resolve(); dest=args.output.resolve()
    marker=work/'.state-build-workspace.json'
    if dest.exists(): raise RuntimeError('Output directory must not exist')
    if work.exists() and (not args.resume or not marker.exists() or json.loads(marker.read_text()).get('upstreamCommit')!=pin['upstreamCommit']): raise RuntimeError('Work directory must be absent or a matching --resume build workspace')
    if output(['git','rev-parse',pin['upstreamCommit']+'^{commit}'],cwd=source)!=pin['upstreamCommit']: raise RuntimeError('Upstream commit mismatch')
    work.mkdir(parents=True,exist_ok=True); dest.mkdir(parents=True)
    marker.write_text(json.dumps({'upstreamCommit':pin['upstreamCommit']}))
    archive=work/'upstream.tar'
    run(['git','archive','--format=tar','--output='+str(archive),pin['upstreamCommit'],'state','crates','LICENSE','package.json','pnpm-workspace.yaml','pnpm-lock.yaml','packages'],cwd=source)
    import shutil
    tree=work/'source'
    if tree.exists(): shutil.rmtree(tree)
    tree.mkdir()
    with tarfile.open(archive) as f: f.extractall(tree, filter='data')
    run(['git','apply','--check',str(patch)],cwd=tree)
    run(['git','apply',str(patch)],cwd=tree)
    env=dict(os.environ,CARGO_BUILD_JOBS=str(args.jobs),CARGO_TARGET_DIR=str(work/'target'),SOURCE_DATE_EPOCH=output(['git','show','-s','--format=%ct',pin['upstreamCommit']],cwd=source))
    env['RUSTFLAGS']='--remap-path-prefix='+str(work)+'=/usr/src/agentmemory-state'
    pnpm=['pnpm','--filter','@iii-workers/state-ui...','install','--frozen-lockfile']
    if not args.online: pnpm.append('--offline')
    run(pnpm,cwd=tree)
    run(['pnpm','--filter','@iii-workers/state-ui','build'],cwd=tree)
    env['SKIP_UI_BUILD']='1'
    command=[args.cargo,'build','--release','--locked','--bin','state']
    if not args.online: command.append('--offline')
    run(command,cwd=tree/'state',env=env)
    binary=work/'target/release/state'; target=dest/'state'; target.write_bytes(binary.read_bytes());target.chmod(0o755)
    import shutil
    shutil.copyfile(patch,dest/'compat.patch');shutil.copyfile(tree/'LICENSE',dest/'LICENSE')
    manifest={**pin,'profile':'release','binary':'state','binarySha256':sha(target),'sourceArchiveSha256':sha(archive),'cargoLockSha256':sha(tree/'state/Cargo.lock'),'rustc':output(['rustc','-Vv']),'cargo':output([args.cargo,'-V']),'pnpm':output(['pnpm','--version']),'node':output(['node','--version']),'sourceDateEpoch':env['SOURCE_DATE_EPOCH'],'target':output(['rustc','-vV']).split('host: ')[1].splitlines()[0]}
    (dest/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    archive_path=dest.with_name(pin['artifactVersion']+'-'+manifest['target']+'.tar.gz')
    if archive_path.exists(): raise RuntimeError('Artifact archive already exists')
    import gzip
    with archive_path.open('wb') as raw, gzip.GzipFile(filename='',mode='wb',fileobj=raw,mtime=0) as compressed, tarfile.open(fileobj=compressed,mode='w') as tar:
        for path in sorted(dest.iterdir()):
            info=tar.gettarinfo(str(path),arcname='state-worker/'+path.name);info.uid=info.gid=0;info.uname=info.gname='';info.mtime=int(env['SOURCE_DATE_EPOCH'])
            with path.open('rb') as handle: tar.addfile(info,handle)
    print(json.dumps({'archive':str(archive_path),'archiveSha256':sha(archive_path),'artifact':str(dest),'sha256':manifest['binarySha256'],'version':pin['artifactVersion']}))
if __name__=='__main__': main()

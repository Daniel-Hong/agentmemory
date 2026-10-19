"""Preserve concurrent hook queues separately from certified stopped engine state."""
from pathlib import Path
import hashlib,os,stat,tempfile,time


def require(value,code):
    if not value:raise RuntimeError(code)


def stopped_hashes(root,guard,queue='capture-spool'):
    root=Path(root);require(queue in ('capture-spool','hook-outbox'),'QUEUE_EXCLUSION_REFUSED')
    require(root.is_dir() and not root.is_symlink(),'TREE_PATH_INVALID')
    result={}
    for child in sorted(root.iterdir()):
        require(not child.is_symlink(),'TREE_SYMLINK_REFUSED')
        if child.name==queue:continue
        if child.is_dir():result.update({child.name+'/'+name:digest for name,digest in guard.file_hashes(child).items()})
        elif child.is_file():result[child.name]=guard.sha(child)
    return result


def _snapshot_queue(source,target):
    """Each file is a verified byte prefix, not a global atomic queue snapshot.

    Producers remain active; these backup bytes never replace a live queue.
    """
    source,target=Path(source),Path(target)
    require(source.is_dir() and not source.is_symlink(),'QUEUE_SYMLINK_REFUSED')
    target.mkdir(mode=0o700,parents=True)
    records={}
    for path in sorted(source.rglob('*')):
        require(not path.is_symlink() and not any((source/p).is_symlink() for p in path.relative_to(source).parents),'QUEUE_SYMLINK_REFUSED')
        entry=path.stat(follow_symlinks=False)
        if stat.S_ISDIR(entry.st_mode):continue
        require(stat.S_ISREG(entry.st_mode),'QUEUE_FILE_TYPE_REFUSED')
        rel=path.relative_to(source);destination=target/rel;destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        # Opening the inode retains a claimed/renamed file without touching producers.
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
        try:
            size=os.fstat(fd).st_size;remaining=size;digest=hashlib.sha256()
            with destination.open('xb') as file:
                os.chmod(destination,0o600)
                while remaining:
                    data=os.read(fd,min(1024*1024,remaining));require(data,'QUEUE_PREFIX_TRUNCATED');remaining-=len(data);digest.update(data);file.write(data)
                file.flush();os.fsync(file.fileno())
            os.lseek(fd,0,os.SEEK_SET);remaining=size;again=hashlib.sha256()
            while remaining:
                data=os.read(fd,min(1024*1024,remaining));require(data,'QUEUE_PREFIX_TRUNCATED');remaining-=len(data);again.update(data)
            require(again.digest()==digest.digest(),'QUEUE_PREFIX_CHANGED')
        finally:os.close(fd)
        check=hashlib.sha256()
        with destination.open('rb') as file:
            for data in iter(lambda:file.read(1024*1024),b''):check.update(data)
        require(check.digest()==digest.digest(),'QUEUE_BACKUP_READBACK_MISMATCH')
        records[str(rel)]={'bytes':size,'sha256':digest.hexdigest()}
    for directory in [target,*[p for p in target.rglob('*') if p.is_dir()]]:
        fd=os.open(directory,os.O_RDONLY)
        try:os.fsync(fd)
        finally:os.close(fd)
    return {'queue':source.name,'readBackVerified':True,'consistency':'per-file-verified-prefix','wholeQueueAtomic':False,'liveQueueModified':False,'files':records}


def snapshot_queue(source,target):
    source,target=Path(source),Path(target)
    require(not target.exists(),'QUEUE_BACKUP_EXISTS')
    target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
    for attempt in range(3):
        try:
            with tempfile.TemporaryDirectory(prefix='.queue-copy-',dir=target.parent) as scratch:
                staged=Path(scratch)/'snapshot'
                record=_snapshot_queue(source,staged)
                os.rename(staged,target)
                fd=os.open(target.parent,os.O_RDONLY)
                try:os.fsync(fd)
                finally:os.close(fd)
                return record
        except FileNotFoundError:
            if attempt==2:raise RuntimeError('QUEUE_SNAPSHOT_BUSY') from None
            time.sleep(0.05)


def backup_tree(source,target,queue,guard,copy):
    source,target=Path(source),Path(target)
    require(queue in ('capture-spool','hook-outbox'),'QUEUE_EXCLUSION_REFUSED')
    target.mkdir(mode=0o700,parents=True)
    snapshot=None
    for child in sorted(source.iterdir()):
        require(not child.is_symlink(),'TREE_SYMLINK_REFUSED')
        if child.name==queue:snapshot=snapshot_queue(child,target/child.name)
        else:copy(child,target/child.name)
    require(stopped_hashes(source,guard,queue)==stopped_hashes(target,guard,queue),'BACKUP_READBACK_MISMATCH')
    return snapshot

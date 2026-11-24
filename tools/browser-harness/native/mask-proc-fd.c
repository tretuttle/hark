/*
 * Run by the export-failures check inside one browser's own mount namespace. `mask-proc-fd <pid>` mounts an empty tmpfs
 * over /proc/<pid>/fd, so /proc/self/fd there leads nowhere, and `mask-proc-fd <pid> unmask` takes it away again: Gecko
 * itself needs /proc/self/fd to make shared memory, and aborts (MOZ_CRASH) when it cannot. `mask-proc-fd <pid> fill
 * <folder> <bytes>` fills the file system holding <folder> with one new file, <folder>/.hark-fill, until <bytes> are
 * free, and prints what is free then.
 * It enters the user namespace the harness made for the browser (the parent of the browser's own), where this user is
 * root, then the browser's mount namespace. It refuses a process that shares this one's mount namespace, so nothing
 * outside the browser's namespace changes.
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <sched.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

#define NS_GET_PARENT 0xb702

static int fail(const char *what) {
  perror(what);
  return 1;
}

static unsigned long long room(int fd) {
  struct statvfs vfs;
  if (fstatvfs(fd, &vfs) != 0) return 0;
  return (unsigned long long)vfs.f_bavail * vfs.f_frsize;
}

static int fill(const char *folder, const char *bytes) {
  unsigned long long leave = strtoull(bytes, NULL, 10);
  char path[4096];
  if (snprintf(path, sizeof path, "%s/.hark-fill", folder) >= (int)sizeof path) return fail("path");
  int fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
  if (fd < 0) return fail("open fill");
  unsigned long long free = room(fd);
  if (free > leave && fallocate(fd, 0, 0, (off_t)(free - leave)) != 0) return fail("fallocate");
  printf("%llu\n", room(fd));
  return close(fd) == 0 ? 0 : fail("close fill");
}

int main(int argc, char **argv) {
  int filling = argc == 5 && strcmp(argv[2], "fill") == 0;
  int unmasking = argc == 3 && strcmp(argv[2], "unmask") == 0;
  if (argc != 2 && !filling && !unmasking)
    return fail("usage: mask-proc-fd <pid> [unmask | fill <folder> <bytes>]");
  long pid = strtol(argv[1], NULL, 10);
  if (pid <= 1) return fail("pid");
  char path[64];
  struct stat own, theirs;
  snprintf(path, sizeof path, "/proc/%ld/ns/mnt", pid);
  if (stat("/proc/self/ns/mnt", &own) != 0 || stat(path, &theirs) != 0) return fail("stat mnt");
  if (own.st_ino == theirs.st_ino && own.st_dev == theirs.st_dev) {
    fputs("refused: the process shares this mount namespace\n", stderr);
    return 1;
  }
  int mnt = open(path, O_RDONLY | O_CLOEXEC);
  snprintf(path, sizeof path, "/proc/%ld/ns/user", pid);
  int user = open(path, O_RDONLY | O_CLOEXEC);
  if (mnt < 0 || user < 0) return fail("open ns");
  int parent = ioctl(user, NS_GET_PARENT);
  if (parent < 0) return fail("parent user namespace");
  if (setns(parent, CLONE_NEWUSER) != 0) return fail("enter user namespace");
  if (setns(mnt, CLONE_NEWNS) != 0) return fail("enter mount namespace");
  if (filling) return fill(argv[3], argv[4]);
  snprintf(path, sizeof path, "/proc/%ld/fd", pid);
  if (unmasking) return umount2(path, MNT_DETACH) == 0 ? 0 : fail("umount");
  if (mount("hark-mask", path, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC, "size=4k") != 0)
    return fail("mount");
  return 0;
}

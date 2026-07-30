#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <stddef.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

static int peer_is_in_unit(pid_t pid, const char *unit) {
  char path[64];
  char content[4096];
  const int path_length = snprintf(path, sizeof(path), "/proc/%ld/cgroup", (long)pid);
  if (path_length <= 0 || (size_t)path_length >= sizeof(path)) {
    return 0;
  }
  const int descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (descriptor < 0) {
    return 0;
  }
  const ssize_t length = read(descriptor, content, sizeof(content) - 1);
  close(descriptor);
  if (length <= 0 || (size_t)length >= sizeof(content)) {
    return 0;
  }
  content[length] = '\0';
  const size_t unit_length = strlen(unit);
  for (char *line = content; line != NULL && *line != '\0';) {
    char *newline = strchr(line, '\n');
    if (newline != NULL) {
      *newline = '\0';
    }
    const size_t line_length = strlen(line);
    if (
      line_length > unit_length
      && strcmp(line + line_length - unit_length, unit) == 0
      && line[line_length - unit_length - 1] == '/'
    ) {
      return 1;
    }
    line = newline == NULL ? NULL : newline + 1;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 2 || argv[1][0] == '\0' || strchr(argv[1], '/') != NULL) {
    return 1;
  }
  struct ucred credentials;
  socklen_t length = sizeof(credentials);
  if (getsockopt(3, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0) {
    return 2;
  }
  if (length != sizeof(credentials) || credentials.pid <= 0) {
    return 3;
  }
  if (credentials.uid != getuid()) {
    return 4;
  }
  return peer_is_in_unit(credentials.pid, argv[1]) ? 0 : 5;
}

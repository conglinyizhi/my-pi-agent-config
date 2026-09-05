// network-block-run.c — deny network syscalls, then exec the requested command.
//
// Used by sandbox-shell.mjs for unapproved subagent bash commands. The filter is
// inherited by every descendant. Approved exact commands bypass this runner.

#include <errno.h>
#include <seccomp.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>

static int deny_socket_domain(scmp_filter_ctx ctx, int domain) {
  return seccomp_rule_add(
    ctx,
    SCMP_ACT_ERRNO(EPERM),
    SCMP_SYS(socket),
    1,
    SCMP_A0(SCMP_CMP_EQ, (scmp_datum_t)domain)
  );
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "network-block-run: expected command and arguments\n");
    return 125;
  }

  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (ctx == NULL) {
    fprintf(stderr, "network-block-run: seccomp_init failed\n");
    return 125;
  }

  // Block creation of IPv4/IPv6 sockets while preserving AF_UNIX sockets used by
  // local build tools. Bash children receive no pre-opened Internet sockets, so
  // preventing socket creation is the enforceable boundary needed here.
  int failed = 0;
#ifdef AF_INET
  failed |= deny_socket_domain(ctx, AF_INET);
#else
  failed |= deny_socket_domain(ctx, 2);
#endif
#ifdef AF_INET6
  failed |= deny_socket_domain(ctx, AF_INET6);
#else
  failed |= deny_socket_domain(ctx, 10);
#endif

  if (failed != 0 || seccomp_load(ctx) != 0) {
    fprintf(stderr, "network-block-run: failed to install seccomp filter\n");
    seccomp_release(ctx);
    return 125;
  }
  seccomp_release(ctx);

  execvp(argv[1], &argv[1]);
  perror("network-block-run: execvp");
  return 125;
}

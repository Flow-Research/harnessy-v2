#define _GNU_SOURCE 1
#define _DARWIN_C_SOURCE 1
#define _POSIX_C_SOURCE 200809L
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t interrupted = 0;

static void request_stop(int signal_number) {
  (void)signal_number;
  interrupted = 1;
}

static int64_t monotonic_millis(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_MONOTONIC, &now) != 0) return -1;
  return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

int main(int argc, char **argv) {
  if (argc < 3 || argv[2][0] != '/' || fcntl(3, F_GETFD) < 0) return 125;
  char *end = NULL;
  errno = 0;
  long timeout_millis = strtol(argv[1], &end, 10);
  if (errno || end == argv[1] || *end || timeout_millis < 1 || timeout_millis > 5400000) return 125;
  if (fcntl(3, F_SETFD, FD_CLOEXEC) != 0) return 125;
  struct sigaction action = {0};
  action.sa_handler = request_stop;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) || sigaction(SIGINT, &action, NULL) || sigaction(SIGHUP, &action, NULL)) return 125;
  int64_t started = monotonic_millis();
  if (started < 0) return 125;
  /* The host queues cancellation until handlers are installed, before any fork. */
  static const char ready[] = "HSY_EVALUATOR_READY\n";
  if (write(3, ready, sizeof(ready) - 1) != (ssize_t)(sizeof(ready) - 1)) return 125;
  pid_t child = fork();
  if (child < 0) return 125;
  if (child == 0) {
    close(3);
    struct sigaction reset = {0};
    reset.sa_handler = SIG_DFL;
    sigemptyset(&reset.sa_mask);
    sigaction(SIGTERM, &reset, NULL);
    sigaction(SIGINT, &reset, NULL);
    sigaction(SIGHUP, &reset, NULL);
    execv(argv[2], &argv[2]);
    _exit(126);
  }
  int status = 0;
  struct rusage usage = {0};
  bool timed_out = false;
  bool cancelled = false;
  bool killed = false;
  for (;;) {
    pid_t settled = wait4(child, &status, WNOHANG, &usage);
    if (settled == child) break;
    if (settled < 0 && errno != EINTR) return 125;
    int64_t now = monotonic_millis();
    if (now < 0) interrupted = 1;
    if (!killed && (interrupted || now - started >= timeout_millis)) {
      timed_out = !interrupted;
      cancelled = interrupted != 0;
      /* The unreaped child owns this PID. No PID can be reused before wait4. */
      if (kill(child, SIGKILL) != 0 && errno != ESRCH) return 125;
      killed = true;
    }
    struct timespec pause = { .tv_sec = 0, .tv_nsec = 5000000 };
    nanosleep(&pause, NULL);
  }
  uint64_t rss_bytes = (uint64_t)usage.ru_maxrss;
#if !defined(__APPLE__)
  rss_bytes *= 1024;
#endif
  int64_t user_micros = (int64_t)usage.ru_utime.tv_sec * 1000000 + usage.ru_utime.tv_usec;
  int64_t system_micros = (int64_t)usage.ru_stime.tv_sec * 1000000 + usage.ru_stime.tv_usec;
  int signal_number = WIFSIGNALED(status) ? WTERMSIG(status) : 0;
  FILE *report = fdopen(3, "w");
  if (!report) return 125;
  fprintf(report, "{\"schema\":\"harnessy.engineering.resources.v1\",\"childPid\":%ld,\"reaped\":true,\"exitCode\":", (long)child);
  if (WIFEXITED(status)) fprintf(report, "%d", WEXITSTATUS(status));
  else fputs("null", report);
  fprintf(report, ",\"signal\":%d,\"timedOut\":%s,\"cancelled\":%s,\"userCpuMicros\":%lld,\"systemCpuMicros\":%lld,\"peakRssBytes\":%llu}\n",
      signal_number, timed_out ? "true" : "false", cancelled ? "true" : "false",
      (long long)user_micros, (long long)system_micros, (unsigned long long)rss_bytes);
  if (fclose(report) != 0) return 125;
  return 0;
}

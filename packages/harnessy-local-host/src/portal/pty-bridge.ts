/** POSIX PTY bridge. stdin is bounded JSON control; stdout is raw terminal bytes. */
export const PTY_BRIDGE = String.raw`
import os, sys, pty, signal, select, json, base64, fcntl, termios, struct, time
shell, cwd = sys.argv[1:3]
pid, master = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvpe(shell, [shell, '-l'], dict(os.environ, TERM='xterm-256color', COLORTERM='truecolor'))
def stop(*args):
    groups = {pid}
    try: groups.add(os.tcgetpgrp(master))
    except OSError: pass
    for group in groups:
        if group > 0:
            try: os.killpg(group, signal.SIGHUP)
            except ProcessLookupError: pass
    time.sleep(0.1)
    for group in groups:
        if group > 0:
            try: os.killpg(group, signal.SIGKILL)
            except ProcessLookupError: pass
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
pending = b''
try:
    while True:
        ready, _, _ = select.select([master, 0], [], [])
        if master in ready:
            try: data = os.read(master, 65536)
            except OSError: break
            if not data: break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        if 0 in ready:
            data = os.read(0, 8192)
            if not data: stop()
            pending += data
            if len(pending) > 32768: stop()
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                message = json.loads(line)
                if message['action'] == 'input':
                    data = base64.b64decode(message['data'])
                    while data:
                        count = os.write(master, data)
                        data = data[count:]
                elif message['action'] == 'resize':
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', message['rows'], message['cols'], 0, 0))
finally:
    os.close(master)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
`;

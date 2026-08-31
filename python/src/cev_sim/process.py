from __future__ import annotations

import json
import os
import queue
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from typing import TextIO

from .config import PROTOCOL_MAJOR, PROTOCOL_MINOR, SupervisorLaunch
from .errors import CevSimLaunchError


class OwnedSupervisor:
    """Own a local `cev-sim supervisor` process and its private Unix socket."""

    def __init__(self, configuration: SupervisorLaunch) -> None:
        self.configuration = configuration
        self.process: subprocess.Popen[str] | None = None
        self.directory: Path | None = None
        self.socket_path: Path | None = None
        self.target: str | None = None
        self._stderr: deque[str] = deque(maxlen=100)
        self._stderr_thread: threading.Thread | None = None

    @property
    def stderr_tail(self) -> str:
        return "".join(self._stderr).strip()

    def start(self) -> str:
        if self.process is not None:
            if self.target is None:
                raise CevSimLaunchError("Supervisor process exists without a target")
            return self.target
        executable = self._resolve_executable()
        socket_root = Path("/tmp") if os.name == "posix" and Path("/tmp").is_dir() else None
        self.directory = Path(tempfile.mkdtemp(prefix="cev-sim-python-", dir=socket_root))
        self.socket_path = self.directory / "supervisor.sock"
        command = [executable, "supervisor", "--socket", str(self.socket_path)]
        if self.configuration.config_path is not None:
            command.extend(("--config", str(self.configuration.config_path)))
        if self.configuration.preset is not None:
            command.extend(("--preset", self.configuration.preset))
        command.extend(self.configuration.extra_args)
        try:
            self.process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                start_new_session=os.name == "posix",
            )
            assert self.process.stdout is not None
            assert self.process.stderr is not None
            self._stderr_thread = threading.Thread(
                target=self._drain_stderr,
                args=(self.process.stderr,),
                name="cev-sim-stderr",
                daemon=True,
            )
            self._stderr_thread.start()
            line = self._readline(self.process.stdout, self.configuration.startup_timeout_s)
            record = json.loads(line)
            self._validate_record(record)
            self.target = f"unix:{record['address']}"
            return self.target
        except Exception as error:
            detail = self.stderr_tail
            self.close()
            suffix = f" Supervisor stderr: {detail}" if detail else ""
            if isinstance(error, CevSimLaunchError):
                raise CevSimLaunchError(f"{error}{suffix}") from error
            raise CevSimLaunchError(f"Could not launch cev-sim supervisor: {error}.{suffix}") from error

    def close(self) -> None:
        process = self.process
        self.process = None
        if process is not None:
            was_running = process.poll() is None
            self._signal_process_group(process, signal.SIGTERM)
            if was_running:
                try:
                    process.wait(timeout=self.configuration.shutdown_grace_s)
                except subprocess.TimeoutExpired:
                    self._signal_process_group(process, signal.SIGKILL)
                    try:
                        process.wait(timeout=self.configuration.kill_grace_s)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait()
            elif os.name == "posix" and self._process_group_exists(process.pid):
                if not self._wait_for_process_group_exit(process.pid, self.configuration.shutdown_grace_s):
                    self._signal_process_group(process, signal.SIGKILL)
                    self._wait_for_process_group_exit(process.pid, self.configuration.kill_grace_s)
        for stream in (process.stdout if process else None, process.stderr if process else None):
            stream and stream.close()
        if self._stderr_thread is not None:
            self._stderr_thread.join(timeout=0.25)
            self._stderr_thread = None
        if self.directory is not None:
            shutil.rmtree(self.directory, ignore_errors=True)
        self.directory = None
        self.socket_path = None
        self.target = None

    def _resolve_executable(self) -> str:
        configured = str(self.configuration.executable)
        if os.sep in configured or (os.altsep and os.altsep in configured):
            path = Path(configured).expanduser().resolve()
            if not path.is_file() or not os.access(path, os.X_OK):
                raise CevSimLaunchError(f"Configured cev-sim executable is not executable: {path}")
            return str(path)
        resolved = shutil.which(configured)
        if resolved is None:
            raise CevSimLaunchError(
                f"Configured cev-sim executable {configured!r} was not found on PATH; "
                "install it or provide an explicit path"
            )
        return resolved

    def _drain_stderr(self, stream: TextIO) -> None:
        for line in stream:
            self._stderr.append(line)

    def _readline(self, stream: TextIO, timeout: float) -> str:
        result: queue.Queue[str | BaseException] = queue.Queue(maxsize=1)

        def read() -> None:
            try:
                result.put(stream.readline())
            except BaseException as error:  # pragma: no cover - platform stream failures are integration-tested.
                result.put(error)

        thread = threading.Thread(target=read, name="cev-sim-listener-record", daemon=True)
        thread.start()
        try:
            value = result.get(timeout=timeout)
        except queue.Empty as error:
            raise CevSimLaunchError(
                f"Supervisor did not publish a listener record within {timeout:g} seconds"
            ) from error
        if isinstance(value, BaseException):
            raise CevSimLaunchError(f"Could not read supervisor listener record: {value}") from value
        if not value:
            return_code = self.process.poll() if self.process else None
            raise CevSimLaunchError(f"Supervisor exited before publishing a listener record (exit {return_code})")
        return value

    def _validate_record(self, record: object) -> None:
        if not isinstance(record, dict):
            raise CevSimLaunchError("Supervisor listener record is not a JSON object")
        protocol = record.get("protocol")
        expected = {"major": PROTOCOL_MAJOR, "minor": PROTOCOL_MINOR}
        if (
            record.get("kind") != "cev-sim.headless.supervisor-listening"
            or record.get("version") != 1
            or record.get("transport") != "socket"
            or protocol != expected
            or record.get("address") != str(self.socket_path)
        ):
            raise CevSimLaunchError(f"Incompatible supervisor listener record: {record!r}")

    @staticmethod
    def _signal_process_group(process: subprocess.Popen[str], requested: signal.Signals) -> None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, requested)
            elif requested == signal.SIGTERM:
                process.terminate()
            else:
                process.kill()
        except ProcessLookupError:
            pass
        except PermissionError:
            # A process group can disappear between poll() and killpg() on macOS.
            try:
                if requested == signal.SIGTERM:
                    process.terminate()
                else:
                    process.kill()
            except ProcessLookupError:
                pass

    @staticmethod
    def _process_group_exists(process_group_id: int) -> bool:
        try:
            os.killpg(process_group_id, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    @classmethod
    def _wait_for_process_group_exit(cls, process_group_id: int, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while cls._process_group_exists(process_group_id):
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.01)
        return True

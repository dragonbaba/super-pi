"""Own only SearXNG processes launched by Super Pi on Windows."""

import ctypes
from ctypes import wintypes
from pathlib import Path
import re
import runpy
import sys
import time


kernel = ctypes.WinDLL("kernel32", use_last_error=True)
RECORD = re.compile(r"(searxng-[a-f0-9-]{36})\.(job|stopping)")


def bind(name, result, *args):
    function = getattr(kernel, name)
    function.restype = result
    function.argtypes = args
    return function


create_job = bind("CreateJobObjectW", wintypes.HANDLE, wintypes.LPVOID, wintypes.LPCWSTR)
open_job = bind("OpenJobObjectW", wintypes.HANDLE, wintypes.DWORD, wintypes.BOOL, wintypes.LPCWSTR)
current_process = bind("GetCurrentProcess", wintypes.HANDLE)
assign_job = bind("AssignProcessToJobObject", wintypes.BOOL, wintypes.HANDLE, wintypes.HANDLE)
terminate_job = bind("TerminateJobObject", wintypes.BOOL, wintypes.HANDLE, wintypes.UINT)
query_job = bind(
    "QueryInformationJobObject", wintypes.BOOL,
    wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD, wintypes.LPVOID,
)
close = bind("CloseHandle", wintypes.BOOL, wintypes.HANDLE)


class Accounting(ctypes.Structure):
    _fields_ = [
        ("user_time", ctypes.c_int64),
        ("kernel_time", ctypes.c_int64),
        ("period_user_time", ctypes.c_int64),
        ("period_kernel_time", ctypes.c_int64),
        ("page_faults", wintypes.DWORD),
        ("total_processes", wintypes.DWORD),
        ("active_processes", wintypes.DWORD),
        ("terminated_processes", wintypes.DWORD),
    ]


def job_name(record):
    return "Local\\SuperPi-" + record.stem


def serve(entry, marker):
    if not RECORD.fullmatch(marker.name) or marker.suffix != ".job":
        raise ValueError("Invalid service ownership record.")
    job = create_job(None, job_name(marker))
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        if not assign_job(job, current_process()):
            raise ctypes.WinError(ctypes.get_last_error())
        # The last client may revoke this generation before Python reaches the job.
        if marker.is_file():
            runpy.run_path(str(entry), run_name="__main__")
    finally:
        close(job)


def stop(directory):
    deadline = time.monotonic() + 2
    for marker in directory.iterdir():
        if not RECORD.fullmatch(marker.name) or not marker.is_file() or marker.is_symlink():
            continue
        revoked = marker.with_suffix(".stopping")
        if marker != revoked:
            marker.replace(revoked)
        job = open_job(0x000C, False, job_name(revoked))  # QUERY | TERMINATE
        if job:
            try:
                if not terminate_job(job, 0):
                    raise ctypes.WinError(ctypes.get_last_error())
                accounting = Accounting()
                while True:
                    if not query_job(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
                        raise ctypes.WinError(ctypes.get_last_error())
                    if accounting.active_processes == 0:
                        break
                    if time.monotonic() >= deadline:
                        raise TimeoutError("SearXNG job is still active.")
                    time.sleep(0.025)
            finally:
                close(job)
        elif ctypes.get_last_error() != 2:  # ERROR_FILE_NOT_FOUND
            raise ctypes.WinError(ctypes.get_last_error())
        revoked.unlink(missing_ok=True)


if sys.argv[1] == "serve":
    serve(Path(sys.argv[2]), Path(sys.argv[3]))
elif sys.argv[1] == "stop":
    stop(Path(sys.argv[2]))

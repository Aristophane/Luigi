#!/usr/bin/env python3
"""Collecte en lecture seule pour Luigi sur Ubuntu et Debian."""

from __future__ import annotations

import datetime as dt
import glob
import json
import os
import pathlib
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import uuid

AGENT_VERSION = "0.2.0"


def read_text(path: str) -> str:
    try:
        return pathlib.Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def command(*arguments: str, timeout: int = 30) -> tuple[int, str]:
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=timeout, check=False)
        return result.returncode, result.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def cpu_sample() -> list[int]:
    first = read_text("/proc/stat").splitlines()[0].split()[1:]
    return [int(value) for value in first]


def cpu_percent() -> float:
    before = cpu_sample()
    time.sleep(1)
    after = cpu_sample()
    idle_before = before[3] + (before[4] if len(before) > 4 else 0)
    idle_after = after[3] + (after[4] if len(after) > 4 else 0)
    total_delta = sum(after) - sum(before)
    idle_delta = idle_after - idle_before
    return round(100 * (1 - idle_delta / total_delta), 2) if total_delta > 0 else 0.0


def memory_metrics() -> tuple[float, float]:
    values: dict[str, int] = {}
    for line in read_text("/proc/meminfo").splitlines():
        key, _, raw_value = line.partition(":")
        try:
            values[key] = int(raw_value.strip().split()[0])
        except (ValueError, IndexError):
            continue
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", 0)
    swap_total = values.get("SwapTotal", 0)
    swap_free = values.get("SwapFree", 0)
    memory = 100 * (total - available) / total if total else 0
    swap = 100 * (swap_total - swap_free) / swap_total if swap_total else 0
    return round(memory, 2), round(swap, 2)


def package_updates() -> dict[str, int | bool]:
    code, output = command("apt-get", "-s", "-o", "Debug::NoLocking=1", "upgrade", timeout=60)
    install_lines = [line for line in output.splitlines() if line.startswith("Inst ")] if code == 0 else []
    held_code, held_output = command("apt-mark", "showhold")
    return {
        "available": len(install_lines),
        "security": sum(1 for line in install_lines if "security" in line.lower()),
        "held": len([line for line in held_output.splitlines() if line.strip()]) if held_code == 0 else 0,
        "rebootRequired": pathlib.Path("/var/run/reboot-required").exists(),
    }


def ssh_setting(name: str) -> str | None:
    result: str | None = None
    for path in ["/etc/ssh/sshd_config", *sorted(glob.glob("/etc/ssh/sshd_config.d/*.conf"))]:
        for raw_line in read_text(path).splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            key, _, value = line.partition(" ")
            if key.lower() == name.lower() and value.strip():
                result = value.strip().split()[0].lower()
    return result


def security_state() -> dict[str, bool | None]:
    ufw_code, _ = command("systemctl", "is-active", "--quiet", "ufw")
    password_auth = ssh_setting("PasswordAuthentication")
    root_login = ssh_setting("PermitRootLogin")
    return {
        "ufwActive": ufw_code == 0,
        "sshPasswordAuthentication": None if password_auth is None else password_auth not in {"no", "false"},
        "sshRootLogin": None if root_login is None else root_login not in {"no", "false"},
    }


def backup_state() -> dict[str, str | None] | None:
    stamp_path = os.environ.get("LUIGI_BACKUP_STAMP_FILE", "").strip()
    if not stamp_path:
        return None
    stamp = pathlib.Path(stamp_path)
    if not stamp.exists():
        return {"status": "failed", "lastSuccessAt": None}
    observed = dt.datetime.fromtimestamp(stamp.stat().st_mtime, tz=dt.timezone.utc)
    max_hours = int(os.environ.get("LUIGI_BACKUP_MAX_HOURS", "24"))
    age = dt.datetime.now(dt.timezone.utc) - observed
    return {
        "status": "ok" if age <= dt.timedelta(hours=max_hours) else "failed",
        "lastSuccessAt": observed.isoformat(),
    }


def service_states() -> list[dict[str, str | bool]]:
    names = [name.strip() for name in os.environ.get("LUIGI_SERVICES", "").split(",") if name.strip()]
    states = []
    for name in names[:50]:
        code, _ = command("systemctl", "is-active", "--quiet", name)
        states.append({"name": name, "active": code == 0})
    return states


def system_information() -> dict[str, str]:
    values: dict[str, str] = {}
    for raw_line in read_text("/etc/os-release").splitlines():
        key, separator, value = raw_line.partition("=")
        if separator and key:
            values[key] = value.strip().strip('"').strip("'")
    distribution = values.get("ID", "unknown").lower()
    return {
        "distribution": distribution if distribution in {"ubuntu", "debian"} else "unknown",
        "distributionVersion": values.get("VERSION_ID", "unknown")[:40],
        "distributionLabel": values.get("PRETTY_NAME", distribution)[:120],
        "architecture": os.uname().machine[:40],
        "agentVersion": AGENT_VERSION,
    }


def build_report() -> dict[str, object]:
    memory, swap = memory_metrics()
    disk = shutil.disk_usage("/")
    report: dict[str, object] = {
        "schemaVersion": 1,
        "reportId": str(uuid.uuid4()),
        "agentId": os.environ["LUIGI_AGENT_ID"],
        "hostname": os.uname().nodename,
        "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "system": system_information(),
        "metrics": {
            "cpuPercent": cpu_percent(),
            "memoryPercent": memory,
            "diskPercent": round(100 * disk.used / disk.total, 2) if disk.total else 0,
            "swapPercent": swap,
            "load1": round(os.getloadavg()[0], 2),
            "uptimeSeconds": int(float(read_text("/proc/uptime").split()[0])),
        },
        "updates": package_updates(),
        "security": security_state(),
        "services": service_states(),
    }
    backup = backup_state()
    if backup is not None:
        report["backup"] = backup
    return report


def send(report: dict[str, object]) -> None:
    endpoint = os.environ["LUIGI_ENDPOINT"]
    if not endpoint.startswith("https://") and os.environ.get("LUIGI_ALLOW_INSECURE_HTTP") != "1":
        raise RuntimeError("LUIGI_ENDPOINT doit utiliser HTTPS")
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(report, separators=(",", ":")).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {os.environ['LUIGI_TOKEN']}",
            "Content-Type": "application/json",
            "User-Agent": f"Luigi-VPS-Agent/{AGENT_VERSION}",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            if response.status not in {200, 202}:
                raise RuntimeError(f"Luigi a répondu HTTP {response.status}")
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Luigi a refusé le rapport (HTTP {error.code})") from None


if __name__ == "__main__":
    try:
        send(build_report())
        print("Rapport envoyé à Luigi.")
    except Exception as error:  # Le journal ne contient jamais le jeton ni le rapport brut.
        print(f"Échec de la collecte Luigi : {error}", file=os.sys.stderr)
        raise SystemExit(1)

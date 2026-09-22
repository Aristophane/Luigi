#!/usr/bin/env python3
"""Signaux d’exécution locaux, bornés et sans réseau pour Luigi : arrêts mémoire et redémarrages."""

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import tempfile

OUTPUT = pathlib.Path("/var/lib/luigi-agent/runtime.json")
STATE = pathlib.Path("/var/lib/luigi-agent/runtime-state.json")
DOCKER_CONTAINERS = pathlib.Path(os.environ.get("LUIGI_DOCKER_ROOT", "/var/lib/docker")) / "containers"
CGROUP_ROOT = pathlib.Path("/sys/fs/cgroup")
BOOT_ID = pathlib.Path("/proc/sys/kernel/random/boot_id")
PROC_STAT = pathlib.Path("/proc/stat")
EVENT_WINDOW = dt.timedelta(hours=24)
MAX_UNITS = 40
MAX_EVENTS = 50
MAX_SERVICES = 20
MAX_KERNEL_LINES = 5000
MAX_STORED_EVENTS = 5000
COLLECTION_ERRORS: list[str] = []

CONTAINER_ID = re.compile(r"^[0-9a-f]{64}$")
UNIT_NAME = re.compile(r"^[A-Za-z0-9@._:-]{1,120}$")
MEMCG_CONTAINER = re.compile(r"(?:docker-|/docker/)([0-9a-f]{64})")
KILLED_PROCESS = re.compile(r"Killed process (\d+) \(([^)]*)\).*?anon-rss:(\d+)kB")
DOCKER_TIME = re.compile(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$")


def command(*arguments: str, timeout: int = 20) -> tuple[int, str]:
    try:
        result = subprocess.run(arguments, capture_output=True, text=True, timeout=timeout, check=False)
        return result.returncode, result.stdout
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def iso(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).isoformat()


def parse_iso(value: object) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else None


def parse_docker_time(value: object) -> dt.datetime | None:
    """Docker écrit des nanosecondes, que datetime ne sait pas lire ; « 0001-… » signifie jamais."""
    if not isinstance(value, str) or value.startswith("0001-"):
        return None
    match = DOCKER_TIME.match(value)
    if not match:
        return None
    base, fraction, zone = match.groups()
    microseconds = (fraction or "0")[:6].ljust(6, "0")
    try:
        return dt.datetime.fromisoformat(f"{base}.{microseconds}{'+00:00' if zone == 'Z' else zone}")
    except ValueError:
        return None


def clean_label(value: object, fallback: str) -> str:
    text = re.sub(r"[\x00-\x1f\x7f]", "", value).strip() if isinstance(value, str) else ""
    return (text or fallback)[:120]


def unit_key(kind: str, value: str) -> str:
    return f"{kind}:{re.sub(r'[^A-Za-z0-9@._:/-]', '-', value)}"[:150]


def read_int(path: pathlib.Path) -> int | None:
    try:
        raw = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return int(raw) if raw.isdigit() else None


def cgroup_memory(path: pathlib.Path | None) -> dict[str, int | None]:
    memory: dict[str, int | None] = {
        "memoryCurrentBytes": None,
        "memoryMaxBytes": None,
        "memoryPeakBytes": None,
        "oomKills": None,
    }
    if path is None or not path.is_dir():
        return memory
    memory["memoryCurrentBytes"] = read_int(path / "memory.current")
    # « max » signifie aucune limite : la valeur reste nulle.
    memory["memoryMaxBytes"] = read_int(path / "memory.max")
    memory["memoryPeakBytes"] = read_int(path / "memory.peak")
    try:
        for line in (path / "memory.events").read_text(encoding="utf-8").splitlines():
            key, _, raw = line.partition(" ")
            if key == "oom_kill" and raw.strip().isdigit():
                memory["oomKills"] = int(raw.strip())
    except OSError:
        pass
    return memory


def container_cgroup(container_id: str) -> pathlib.Path | None:
    for candidate in (
        CGROUP_ROOT / "system.slice" / f"docker-{container_id}.scope",
        CGROUP_ROOT / "docker" / container_id,
    ):
        if candidate.is_dir():
            return candidate
    return None


def boot_time() -> dt.datetime | None:
    try:
        for line in PROC_STAT.read_text(encoding="utf-8").splitlines():
            if line.startswith("btime "):
                return dt.datetime.fromtimestamp(int(line.split()[1]), tz=dt.timezone.utc)
    except (OSError, ValueError, IndexError):
        pass
    return None


def docker_containers(collected_at: dt.datetime) -> list[dict[str, object]]:
    """Lit les métadonnées Docker sur disque : aucun accès au socket, donc aucune capacité d’action."""
    containers: list[dict[str, object]] = []
    try:
        entries = [entry for entry in os.scandir(DOCKER_CONTAINERS) if CONTAINER_ID.match(entry.name)]
    except FileNotFoundError:
        return containers
    except OSError:
        COLLECTION_ERRORS.append("docker_inventory_unreadable")
        return containers
    for entry in entries:
        try:
            config = json.loads((pathlib.Path(entry.path) / "config.v2.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            COLLECTION_ERRORS.append("docker_metadata_unreadable")
            continue
        if not isinstance(config, dict):
            COLLECTION_ERRORS.append("docker_metadata_invalid")
            continue
        state = config.get("State") if isinstance(config.get("State"), dict) else {}
        running = bool(state.get("Running")) or bool(state.get("Restarting"))
        finished_at = parse_docker_time(state.get("FinishedAt"))
        if not running and (finished_at is None or collected_at - finished_at > EVENT_WINDOW):
            continue
        container_config = config.get("Config") if isinstance(config.get("Config"), dict) else {}
        labels = container_config.get("Labels") if isinstance(container_config.get("Labels"), dict) else {}
        name = clean_label(str(config.get("Name") or "").lstrip("/"), entry.name[:12])
        project = labels.get("com.docker.compose.project")
        service = labels.get("com.docker.compose.service")
        if isinstance(project, str) and isinstance(service, str) and project and service:
            key = unit_key("container", f"{project}/{service}")
        else:
            key = unit_key("container", name)
        label = clean_label(labels.get("coolify.resourceName") or service, name)
        restart_count = config.get("RestartCount")
        containers.append({
            "id": entry.name,
            "key": key,
            "label": label,
            "running": running,
            "restartCount": restart_count if isinstance(restart_count, int) and restart_count >= 0 else 0,
            "startedAt": parse_docker_time(state.get("StartedAt")),
        })
    return containers


def systemd_services(boot: dt.datetime | None) -> list[dict[str, object]]:
    names = [name.strip() for name in os.environ.get("LUIGI_SERVICES", "").split(",") if name.strip()]
    services: list[dict[str, object]] = []
    if len(names) > MAX_SERVICES:
        COLLECTION_ERRORS.append("service_budget_exceeded")
    for name in names[:MAX_SERVICES]:
        if not UNIT_NAME.match(name):
            COLLECTION_ERRORS.append("invalid_service_name")
            continue
        unit = name if "." in name else f"{name}.service"
        code, output = command(
            "systemctl",
            "show",
            unit,
            "--property=LoadState,ActiveState,NRestarts,ControlGroup,ExecMainStartTimestampMonotonic",
        )
        if code != 0:
            COLLECTION_ERRORS.append("service_unreadable")
            continue
        values = dict(line.split("=", 1) for line in output.splitlines() if "=" in line)
        if values.get("LoadState") != "loaded":
            COLLECTION_ERRORS.append("service_not_loaded")
            continue
        started_monotonic = values.get("ExecMainStartTimestampMonotonic", "0")
        started_at = None
        if boot and started_monotonic.isdigit() and int(started_monotonic) > 0:
            started_at = boot + dt.timedelta(microseconds=int(started_monotonic))
        control_group = values.get("ControlGroup", "")
        restarts = values.get("NRestarts", "")
        services.append({
            "unit": unit,
            "key": unit_key("service", unit),
            "label": clean_label(unit.removesuffix(".service"), unit),
            "running": values.get("ActiveState") == "active",
            "restartCount": int(restarts) if restarts.isdigit() else None,
            "startedAt": started_at,
            "cgroup": control_group,
        })
    return services


def kernel_oom_kills(cursor: str | None) -> tuple[list[dict[str, object]], str | None]:
    arguments = ["journalctl", "-k", "-o", "json", "--no-pager", "-n", str(MAX_KERNEL_LINES)]
    arguments.append(f"--after-cursor={cursor}" if cursor else "--since=-15min")
    code, output = command(*arguments)
    if code != 0 and cursor:
        # Curseur illisible, par exemple après une rotation du journal : repartir d’une fenêtre courte.
        COLLECTION_ERRORS.append("journal_cursor_lost")
        return kernel_oom_kills(None)
    if code != 0:
        COLLECTION_ERRORS.append("journal_unreadable")
        return [], cursor
    if len(output.splitlines()) >= MAX_KERNEL_LINES:
        COLLECTION_ERRORS.append("journal_budget_exceeded")

    kills: list[dict[str, object]] = []
    rss_by_pid: dict[str, int] = {}
    next_cursor = cursor
    for line in output.splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if isinstance(entry.get("__CURSOR"), str):
            next_cursor = entry["__CURSOR"]
        message = entry.get("MESSAGE")
        if not isinstance(message, str):
            continue
        killed = KILLED_PROCESS.search(message)
        if killed:
            rss_by_pid[killed.group(1)] = int(killed.group(3)) * 1024
            continue
        _, marker, details = message.partition("oom-kill:")
        if not marker:
            continue
        fields = dict(part.split("=", 1) for part in details.split(",") if "=" in part)
        timestamp = entry.get("__REALTIME_TIMESTAMP")
        occurred_at = (
            dt.datetime.fromtimestamp(int(timestamp) / 1_000_000, tz=dt.timezone.utc)
            if isinstance(timestamp, str) and timestamp.isdigit()
            else dt.datetime.now(dt.timezone.utc)
        )
        kills.append({
            "memcg": fields.get("task_memcg") or fields.get("oom_memcg") or "",
            "task": clean_label(fields.get("task"), "processus")[:64],
            "pid": fields.get("pid", ""),
            "scope": "cgroup" if fields.get("constraint") == "CONSTRAINT_MEMCG" else "host",
            "occurredAt": occurred_at,
        })
    for kill in kills:
        rss = rss_by_pid.get(str(kill.pop("pid")))
        if rss is not None:
            kill["anonRssBytes"] = rss
    return kills, next_cursor


def resolve_memcg(memcg: str, known_containers: dict[str, dict[str, str]], services: list[dict[str, object]]) -> tuple[str, str]:
    match = MEMCG_CONTAINER.search(memcg)
    if match:
        known = known_containers.get(match.group(1))
        if known:
            return known["key"], known["label"]
        short_id = match.group(1)[:12]
        return unit_key("container", short_id), short_id
    for service in services:
        if service["cgroup"] and service["cgroup"] == memcg:
            return str(service["key"]), str(service["label"])
    leaf = memcg.rstrip("/").rsplit("/", 1)[-1] or "/"
    if leaf.endswith(".service"):
        return unit_key("service", leaf), clean_label(leaf.removesuffix(".service"), leaf)
    return unit_key("cgroup", leaf), clean_label(leaf, "cgroup")


def load_state() -> dict[str, object]:
    try:
        state = json.loads(STATE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return state if isinstance(state, dict) else {}


def collect() -> tuple[dict[str, object], dict[str, object]]:
    collected_at = dt.datetime.now(dt.timezone.utc)
    COLLECTION_ERRORS.clear()
    state = load_state()
    boot_id = BOOT_ID.read_text(encoding="utf-8").strip()
    # Au premier passage ou après un redémarrage du VPS, les compteurs servent de référence sans événement.
    baseline_only = state.get("bootId") != boot_id or "containers" not in state

    containers = docker_containers(collected_at)
    services = systemd_services(boot_time())
    previous_containers = state.get("containers") if isinstance(state.get("containers"), dict) else {}
    previous_services = state.get("services") if isinstance(state.get("services"), dict) else {}

    events = [
        event for event in state.get("events", [])
        if isinstance(event, dict) and (parse_iso(event.get("occurredAt")) or dt.datetime.min.replace(tzinfo=dt.timezone.utc)) >= collected_at - EVENT_WINDOW
    ] if isinstance(state.get("events"), list) else []

    if not baseline_only:
        for container in containers:
            previous = previous_containers.get(container["id"])
            previous_count = previous.get("restartCount", 0) if isinstance(previous, dict) else 0
            increase = int(container["restartCount"]) - (previous_count if isinstance(previous_count, int) else 0)
            if increase > 0:
                started_at = container["startedAt"] or collected_at
                events.append({
                    "type": "restart",
                    "unitKey": container["key"],
                    "unitLabel": container["label"],
                    "occurredAt": iso(started_at),
                    "count": increase,
                })
        for service in services:
            previous = previous_services.get(service["unit"])
            if not isinstance(previous, dict) or service["restartCount"] is None:
                continue
            previous_count = previous.get("restartCount")
            if isinstance(previous_count, int) and service["restartCount"] > previous_count:
                events.append({
                    "type": "restart",
                    "unitKey": service["key"],
                    "unitLabel": service["label"],
                    "occurredAt": iso(service["startedAt"] or collected_at),
                    "count": int(service["restartCount"]) - previous_count,
                })

    known_containers: dict[str, dict[str, str]] = {
        container_id: {"key": str(value.get("key")), "label": str(value.get("label"))}
        for container_id, value in previous_containers.items()
        if isinstance(value, dict) and value.get("key") and value.get("label")
    }
    known_containers.update({
        str(container["id"]): {"key": str(container["key"]), "label": str(container["label"])}
        for container in containers
    })

    cursor = state.get("cursor") if isinstance(state.get("cursor"), str) else None
    kills, next_cursor = kernel_oom_kills(cursor)
    for kill in kills:
        key, label = resolve_memcg(str(kill["memcg"]), known_containers, services)
        event: dict[str, object] = {
            "type": "oom_kill",
            "unitKey": key,
            "unitLabel": label,
            "occurredAt": iso(kill["occurredAt"]),
            "task": kill["task"],
            "scope": kill["scope"],
        }
        if "anonRssBytes" in kill:
            event["anonRssBytes"] = kill["anonRssBytes"]
        events.append(event)
    events.sort(key=lambda event: parse_iso(event.get("occurredAt")) or collected_at)
    dropped_now = max(0, len(events) - MAX_STORED_EVENTS)
    loss_until = parse_iso(state.get("eventLossUntil"))
    lost_events = int(state.get("lostEvents", 0)) if loss_until and loss_until > collected_at else 0
    if dropped_now:
        lost_events += dropped_now
        loss_until = collected_at + EVENT_WINDOW
    events = events[-MAX_STORED_EVENTS:]

    # Un même service compose peut avoir deux conteneurs pendant un déploiement : garder le plus récent.
    by_key: dict[str, dict[str, object]] = {}
    for container in containers:
        current = by_key.get(str(container["key"]))
        rank = (bool(container["running"]), container["startedAt"] or dt.datetime.min.replace(tzinfo=dt.timezone.utc))
        if current is None or rank > (bool(current["running"]), current["startedAt"] or dt.datetime.min.replace(tzinfo=dt.timezone.utc)):
            by_key[str(container["key"])] = container

    units: list[dict[str, object]] = []
    for container in sorted(by_key.values(), key=lambda item: (not item["running"], str(item["label"]))):
        units.append({
            "key": container["key"],
            "kind": "container",
            "label": container["label"],
            "running": container["running"],
            **cgroup_memory(container_cgroup(str(container["id"])) if container["running"] else None),
            "restartCount": container["restartCount"],
            "startedAt": iso(container["startedAt"]) if container["startedAt"] else None,
        })
    for service in services:
        control_group = str(service["cgroup"]).lstrip("/")
        units.append({
            "key": service["key"],
            "kind": "service",
            "label": service["label"],
            "running": service["running"],
            **cgroup_memory(CGROUP_ROOT / control_group if control_group else None),
            "restartCount": service["restartCount"],
            "startedAt": iso(service["startedAt"]) if service["startedAt"] else None,
        })

    selected = {key.strip() for key in os.environ.get("LUIGI_RUNTIME_UNITS", "").split(",") if key.strip()}
    if selected:
        units = [unit for unit in units if unit["key"] in selected]
        if selected - {str(unit["key"]) for unit in units}:
            COLLECTION_ERRORS.append("selected_unit_missing")
    # Rotation bounds payload size while eventually observing every eligible unit.
    offset = int(state.get("unitOffset", 0)) % max(1, len(units))
    batch = (units[offset:] + units[:offset])[:MAX_UNITS]
    services_requested = [name for name in os.environ.get("LUIGI_SERVICES", "").split(",") if name.strip()]
    omitted_units = max(0, len(units) - len(batch)) + max(0, len(services_requested) - MAX_SERVICES)
    omitted_events = max(0, len(events) - MAX_EVENTS) + lost_events
    events_since = parse_iso(state.get("eventsSince")) or collected_at
    if baseline_only or COLLECTION_ERRORS:
        events_since = collected_at
    snapshot = {
        "completeness": {
            "units": "partial" if omitted_units or COLLECTION_ERRORS else "complete",
            "events": "partial" if omitted_events or COLLECTION_ERRORS else "complete",
            "omittedUnits": omitted_units,
            "omittedEvents": omitted_events,
            "eventsSince": iso(events_since),
            "errors": sorted(set(COLLECTION_ERRORS))[:20],
            "selection": "explicit" if selected else "all",
        },
        "schemaVersion": 1,
        "collectedAt": iso(collected_at),
        "units": batch,
        "events": events[-MAX_EVENTS:],
    }
    next_state = {
        "unitOffset": (offset + MAX_UNITS) % max(1, len(units)),
        "eventsSince": iso(events_since),
        "eventLossUntil": iso(loss_until) if loss_until else None,
        "lostEvents": lost_events,
        "bootId": boot_id,
        "cursor": next_cursor,
        "containers": {
            str(container["id"]): {
                "key": container["key"],
                "label": container["label"],
                "restartCount": container["restartCount"],
            }
            for container in containers
        },
        "services": {
            str(service["unit"]): {"restartCount": service["restartCount"]}
            for service in services
        },
        "events": events,
    }
    return snapshot, next_state


def write_atomically(path: pathlib.Path, payload: dict[str, object], mode: int) -> None:
    path.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f"{path.stem}-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, mode)
        os.replace(temporary_name, path)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


if __name__ == "__main__":
    try:
        snapshot, next_state = collect()
        write_atomically(OUTPUT, snapshot, 0o640)
        write_atomically(STATE, next_state, 0o600)
        print(f"Signaux d’exécution Luigi actualisés : {len(snapshot['units'])} unités, {len(snapshot['events'])} événements sur 24 h.")
    except Exception as error:
        print(f"Échec de la collecte d’exécution Luigi : {error}", file=os.sys.stderr)
        raise SystemExit(1)

#!/usr/bin/env python3
"""Inventaire disque local, borné et sans réseau pour Luigi."""

from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import time
import uuid

OUTPUT = pathlib.Path("/var/lib/luigi-agent/storage.json")
MAX_ITEMS = 250
DEADLINE_SECONDS = 540

CATEGORIES = [
    ("coolify", "Coolify", ["/data/coolify"]),
    ("docker", "Docker", ["/var/lib/docker"]),
    ("databases", "Bases de données", ["/var/lib/postgresql", "/var/lib/mysql", "/var/lib/mariadb"]),
    ("logs", "Journaux", ["/var/log"]),
    ("backups", "Sauvegardes", ["/var/backups", "/backup", "/backups"]),
    ("applications", "Applications", ["/opt", "/srv"]),
    ("homes", "Utilisateurs", ["/home"]),
    ("system", "Système", ["/usr", "/etc", "/boot", "/root"]),
]


def directory_size(path: pathlib.Path, deadline: float) -> int:
    remaining = max(1, min(60, int(deadline - time.monotonic())))
    if remaining <= 1:
        raise TimeoutError("budget de scan atteint")
    try:
        result = subprocess.run(
            ["du", "-x", "-B1", "-s", "--", str(path)],
            capture_output=True,
            text=True,
            timeout=remaining,
            check=False,
        )
        if result.returncode not in {0, 1}:
            return 0
        return max(0, int(result.stdout.split()[0])) if result.stdout.strip() else 0
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return 0


def scan_children(root: pathlib.Path, category_id: str, deadline: float) -> list[dict[str, object]]:
    children_root = root
    if root == pathlib.Path("/data/coolify") and (root / "applications").is_dir():
        children_root = root / "applications"
    if root == pathlib.Path("/var/lib/docker") and (root / "volumes").is_dir():
        children_root = root / "volumes"

    try:
        entries = [entry for entry in os.scandir(children_root) if not entry.is_symlink()]
    except OSError:
        return []

    items: list[dict[str, object]] = []
    for entry in entries:
        if time.monotonic() >= deadline or len(items) >= MAX_ITEMS:
            break
        path = pathlib.Path(entry.path)
        size = directory_size(path, deadline) if entry.is_dir(follow_symlinks=False) else max(0, entry.stat().st_size)
        if size == 0:
            continue
        shared = category_id == "docker" and entry.name in {"overlay2", "image", "buildkit", "containerd"}
        items.append({
            "key": f"path:{path}",
            "label": entry.name[:160],
            "path": str(path)[:500],
            "kind": "directory" if entry.is_dir(follow_symlinks=False) else "file",
            "sizeBytes": size,
            "shared": shared,
            "hint": entry.name[:160],
        })
    return items


def collect() -> dict[str, object]:
    started = time.monotonic()
    deadline = started + DEADLINE_SECONDS
    disk = shutil.disk_usage("/")
    categories: list[dict[str, object]] = []
    item_count = 0
    categorized_total = 0

    for category_id, label, roots in CATEGORIES:
        category_items: list[dict[str, object]] = []
        category_total = 0
        for raw_root in roots:
            root = pathlib.Path(raw_root)
            if not root.exists() or root.is_symlink() or time.monotonic() >= deadline:
                continue
            total = directory_size(root, deadline)
            category_total += total
            if item_count < MAX_ITEMS:
                children = scan_children(root, category_id, deadline)
                category_items.extend(children[: MAX_ITEMS - item_count])
                item_count += len(children[: MAX_ITEMS - item_count])
        if category_total:
            categorized_total += category_total
            visible = sum(int(item["sizeBytes"]) for item in category_items)
            if category_total > visible:
                category_items.append({
                    "key": f"aggregate:{category_id}",
                    "label": "Autres éléments",
                    "path": "—",
                    "kind": "aggregate",
                    "sizeBytes": category_total - visible,
                    "shared": category_id in {"system", "docker"},
                })
            categories.append({"id": category_id, "label": label, "sizeBytes": category_total, "items": category_items})

    uncategorized = max(0, disk.used - categorized_total)
    if uncategorized:
        categories.append({
            "id": "other",
            "label": "Autres zones du volume",
            "sizeBytes": uncategorized,
            "items": [{
                "key": "aggregate:other",
                "label": "Autres zones du volume",
                "path": "/",
                "kind": "aggregate",
                "sizeBytes": uncategorized,
                "shared": True,
            }],
        })

    return {
        "schemaVersion": 1,
        "snapshotId": str(uuid.uuid4()),
        "agentId": os.environ["LUIGI_AGENT_ID"],
        "hostname": os.uname().nodename[:255],
        "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "scanDurationMs": int((time.monotonic() - started) * 1000),
        "filesystem": {"mount": "/", "totalBytes": disk.total, "usedBytes": disk.used, "freeBytes": disk.free},
        "categories": categories,
    }


def write_atomically(payload: dict[str, object]) -> None:
    OUTPUT.parent.mkdir(mode=0o750, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix="storage-", dir=OUTPUT.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary_name, 0o640)
        os.replace(temporary_name, OUTPUT)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


if __name__ == "__main__":
    try:
        write_atomically(collect())
        print("Inventaire disque Luigi actualisé.")
    except Exception as error:
        print(f"Échec de l’inventaire disque Luigi : {error}", file=os.sys.stderr)
        raise SystemExit(1)

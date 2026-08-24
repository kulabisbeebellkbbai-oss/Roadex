import csv
import hashlib
import hmac
import importlib.util
import json
import sqlite3
import sys
import tempfile
import threading
import time
import os
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = Path("/home/god/codex_project_manager.py")
SPEC = importlib.util.spec_from_file_location("codex_project_manager", MODULE_PATH)
assert SPEC and SPEC.loader
manager = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = manager
SPEC.loader.exec_module(manager)


class ControlledThreadRegistrarTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        base = Path(self.temp.name)
        self.workspace = base / "workspace"
        self.project = self.workspace / "Project Alpha"
        self.project.mkdir(parents=True)
        self.operation_id = "project-operation-abcdefgh"
        (self.project / ".roadex-project-operation").write_text(
            f"{self.operation_id}\n", encoding="ascii"
        )
        self.thread_id = "thread_abcdefgh12345678"
        self.state_db = base / "state.sqlite"
        with sqlite3.connect(self.state_db) as con:
            con.execute(
                "create table threads (id text primary key, cwd text not null, archived integer not null, created_at integer not null)"
            )
            con.execute(
                "insert into threads values (?, ?, 0, ?)",
                (self.thread_id, str(self.project), int(time.time())),
            )
        self.paths = manager.RegistrarPaths(
            workspace_root=self.workspace,
            state_db=self.state_db,
            registry=base / "state" / "codex-projects.csv",
            link_dir=base / "bin",
            audit_log=base / "state" / "registrar-audit.jsonl",
        )
        self.key = b"k" * 32
        self.audit_key = b"a" * 32
        self.request = self.make_request()

    def tearDown(self):
        self.temp.cleanup()

    def make_request(self, **overrides):
        values = {
            "operation_id": self.operation_id,
            "project_root": str(self.project),
            "thread_id": self.thread_id,
            "project_identity_digest": hashlib.sha256(b"approved project").hexdigest(),
        }
        values.update(overrides)
        payload = json.dumps(
            {
                "operationId": values["operation_id"],
                "projectIdentityDigest": values["project_identity_digest"],
                "projectRoot": values["project_root"],
                "threadId": values["thread_id"],
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        values["bootstrap_binding"] = hmac.new(
            self.key, payload, hashlib.sha256
        ).hexdigest()
        return values

    def register(self, request=None):
        return manager.register_controlled_thread(
            request or self.request,
            paths=self.paths,
            enabled=True,
            hmac_key=self.key,
            audit_hmac_key=self.audit_key,
        )

    def retirement_request(self, generation="1"):
        operation_id = f"human-thread-retirement-{self.thread_id}:1"
        payload = json.dumps(
            {
                "generation": generation,
                "operationId": operation_id,
                "projectRoot": str(self.project),
                "threadId": self.thread_id,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        return {
            "operation_id": operation_id,
            "project_root": str(self.project),
            "thread_id": self.thread_id,
            "generation": generation,
            "retirement_binding": hmac.new(self.key, payload, hashlib.sha256).hexdigest(),
        }

    def test_is_default_off_and_rejects_malformed_flags(self):
        for enabled in (False, None, "TRUE", "1"):
            with self.subTest(enabled=enabled), self.assertRaisesRegex(
                ValueError, "registrar_disabled"
            ):
                manager.register_controlled_thread(
                    self.request,
                    paths=self.paths,
                    enabled=enabled is True,
                    hmac_key=self.key,
                    audit_hmac_key=self.audit_key,
                )
        self.assertFalse(self.paths.registry.exists())
        with self.assertRaisesRegex(ValueError, "registrar_audit_key_invalid"):
            manager.register_controlled_thread(
                self.request,
                paths=self.paths,
                enabled=True,
                hmac_key=self.key,
                audit_hmac_key=self.key,
            )

    def test_registers_exact_public_projection_and_durable_files(self):
        result = self.register()
        self.assertEqual(
            set(result),
            {
                "registered",
                "alreadyRegistered",
                "operationId",
                "projectName",
                "threadId",
            },
        )
        self.assertEqual(result["projectName"], "Project Alpha")
        self.assertNotIn(str(self.project), json.dumps(result))
        with self.paths.registry.open(encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(len(rows), 1)
        launcher = Path(rows[0]["launcher"])
        self.assertTrue(launcher.is_file())
        self.assertEqual(launcher.stat().st_mode & 0o777, 0o755)
        self.assertEqual(rows[0]["source"], "registry+codex-state")
        self.assertEqual(
            rows[0]["label"],
            "This is the dedicated Roadex human interaction thread for the "
            "Project Alpha project. Do not use another thread for human interaction.",
        )
        launcher_content = launcher.read_text(encoding="utf-8")
        self.assertTrue(launcher_content.startswith("#!/usr/bin/python3\n"))
        self.assertIn("fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)", launcher_content)
        self.assertIn(f'CONVERSATION = "{self.thread_id}"', launcher_content)
        audit = self.paths.audit_log.read_text(encoding="utf-8")
        self.assertIn('"outcome":"allowed"', audit)
        self.assertNotIn(str(self.project), audit)
        self.assertNotIn(self.thread_id, audit)

    def test_identical_retry_is_idempotent(self):
        first = self.register()
        registry_before = self.paths.registry.read_bytes()
        second = self.register()
        self.assertFalse(first["alreadyRegistered"])
        self.assertTrue(second["alreadyRegistered"])
        self.assertEqual(self.paths.registry.read_bytes(), registry_before)

    def test_retirement_is_locked_idempotent_and_sync_preserves_tombstone(self):
        self.register()
        request = self.retirement_request()
        first = manager.retire_controlled_thread(
            request, paths=self.paths, enabled=True,
            hmac_key=self.key, audit_hmac_key=self.audit_key,
        )
        second = manager.retire_controlled_thread(
            request, paths=self.paths, enabled=True,
            hmac_key=self.key, audit_hmac_key=self.audit_key,
        )
        self.assertFalse(first["alreadyRetired"])
        self.assertTrue(second["alreadyRetired"])
        with self.paths.registry.open(encoding="utf-8") as handle:
            row = next(csv.DictReader(handle))
        self.assertIn("roadex-retired-generation=1", row["notes"])
        launcher = Path(row["launcher"])
        tombstone = f"# retired Roadex human interaction thread {self.thread_id}\n"
        self.assertEqual(launcher.read_text(encoding="utf-8"), tombstone)
        self.assertEqual(launcher.stat().st_mode & 0o777, 0o444)
        rows = manager._read_registry_from(self.paths.registry, self.paths.link_dir)
        with mock.patch.multiple(
            manager,
            REGISTRY=self.paths.registry,
            LINK_DIR=self.paths.link_dir,
            merge_conversations=mock.Mock(return_value=rows),
            write_registry=mock.Mock(),
        ):
            manager.sync_registry_and_launchers()
        self.assertEqual(launcher.read_text(encoding="utf-8"), tombstone)
        with self.assertRaisesRegex(RuntimeError, "retired"):
            manager.start_resume_tmux(rows[self.thread_id], attach=False)

    def test_retirement_accepts_only_the_exact_prior_launcher_after_root_recreation(self):
        self.register()
        with self.paths.registry.open(encoding="utf-8") as handle:
            row = next(csv.DictReader(handle))
        launcher = Path(row["launcher"])
        prior_content = launcher.read_text(encoding="utf-8")
        previous = self.project.with_name(f"{self.project.name}-previous")
        os.rename(self.project, previous)
        self.project.mkdir()
        result = manager.retire_controlled_thread(
            self.retirement_request(), paths=self.paths, enabled=True,
            hmac_key=self.key, audit_hmac_key=self.audit_key,
        )
        self.assertTrue(result["retired"])
        self.assertNotEqual(prior_content, manager._project_human_thread_launcher_content(
            manager._read_registry_from(self.paths.registry, self.paths.link_dir)[self.thread_id]
        ))
        self.assertEqual(
            launcher.read_text(encoding="utf-8"),
            f"# retired Roadex human interaction thread {self.thread_id}\n",
        )

    def test_sync_never_reactivates_a_retired_row_after_tombstone_loss(self):
        self.register()
        manager.retire_controlled_thread(
            self.retirement_request(), paths=self.paths, enabled=True,
            hmac_key=self.key, audit_hmac_key=self.audit_key,
        )
        rows = manager._read_registry_from(self.paths.registry, self.paths.link_dir)
        item = rows[self.thread_id]
        item.launcher.unlink()
        with mock.patch.multiple(
            manager,
            REGISTRY=self.paths.registry,
            LINK_DIR=self.paths.link_dir,
            merge_conversations=mock.Mock(return_value=rows),
        ):
            synced = manager.sync_registry_and_launchers()
        self.assertFalse(item.launcher.exists())
        with self.assertRaisesRegex(RuntimeError, "retired"):
            manager.start_resume_tmux(synced[self.thread_id], attach=False)

    def test_sync_does_not_claim_a_state_only_thread_before_registrar(self):
        command = manager.command_for(self.project, self.thread_id)
        launcher = self.paths.link_dir / command
        discovered = manager.Conversation(
            conversation_id=self.thread_id,
            label=self.thread_id,
            project=self.project,
            command=command,
            launcher=launcher,
            created_at="",
            updated_at="",
            source="codex-state",
            notes="",
        )
        self.paths.registry.parent.mkdir(parents=True)
        self.paths.link_dir.mkdir(parents=True)
        with mock.patch.multiple(
            manager,
            REGISTRY=self.paths.registry,
            LINK_DIR=self.paths.link_dir,
            merge_conversations=mock.Mock(return_value={self.thread_id: discovered}),
        ):
            self.assertEqual(manager.sync_registry_and_launchers(), {})
        self.assertFalse(launcher.exists())
        with self.paths.registry.open(encoding="utf-8") as handle:
            self.assertEqual(list(csv.DictReader(handle)), [])

    def test_ordinary_registration_cannot_overwrite_a_controlled_row(self):
        self.register()
        rows = manager._read_registry_from(self.paths.registry, self.paths.link_dir)
        controlled = rows[self.thread_id]
        ordinary = manager.Conversation(
            conversation_id=controlled.conversation_id,
            label=controlled.conversation_id,
            project=controlled.project,
            command=controlled.command,
            launcher=controlled.launcher,
            created_at=controlled.created_at,
            updated_at=controlled.updated_at,
            source="codex-state",
            notes="",
        )
        before = self.paths.registry.read_bytes()
        with mock.patch.multiple(manager, REGISTRY=self.paths.registry, LINK_DIR=self.paths.link_dir):
            with self.assertRaisesRegex(RuntimeError, "reserved"):
                manager.register_conversation(ordinary)
        self.assertEqual(self.paths.registry.read_bytes(), before)

    def test_concurrent_duplicate_creates_one_row(self):
        results = []
        failures = []

        def run():
            try:
                results.append(self.register())
            except Exception as exc:  # pragma: no cover - assertion reports it
                failures.append(exc)

        threads = [threading.Thread(target=run) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(failures, [])
        self.assertEqual(len(results), 4)
        with self.paths.registry.open(encoding="utf-8") as handle:
            self.assertEqual(len(list(csv.DictReader(handle))), 1)

    def test_rejects_unknown_fields_bad_binding_and_wrong_cwd(self):
        with self.assertRaisesRegex(ValueError, "registrar_request_invalid"):
            self.register({**self.request, "credential": "secret"})
        with self.assertRaisesRegex(ValueError, "bootstrap_binding_invalid"):
            self.register({**self.request, "bootstrap_binding": "0" * 64})
        with sqlite3.connect(self.state_db) as con:
            con.execute(
                "update threads set cwd = ? where id = ?",
                (str(self.workspace), self.thread_id),
            )
        with self.assertRaisesRegex(ValueError, "codex_thread_invalid"):
            self.register()
        self.assertFalse(self.paths.registry.exists())

    def test_rejects_symlink_and_marker_mismatch(self):
        linked = self.workspace / "Linked"
        linked.symlink_to(self.project, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "unsafe_project_root"):
            self.register(self.make_request(project_root=str(linked)))
        (self.project / ".roadex-project-operation").write_text(
            "project-operation-wrongwrong\n", encoding="ascii"
        )
        with self.assertRaisesRegex(ValueError, "operation_marker_invalid"):
            self.register()

    def test_registry_failure_rolls_back_new_launcher(self):
        original_replace = manager.os.replace
        calls = 0

        def fail_second(source, target):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected")
            return original_replace(source, target)

        with mock.patch.object(manager.os, "replace", side_effect=fail_second):
            with self.assertRaises(OSError):
                self.register()
        self.assertFalse(self.paths.registry.exists())
        self.assertEqual(list(self.paths.link_dir.iterdir()), [])

    def test_crash_after_exact_launcher_publication_repairs_same_pair_on_retry(self):
        original_replace = manager.os.replace
        calls = 0

        def crash_second(source, target):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise KeyboardInterrupt("injected crash")
            return original_replace(source, target)

        with mock.patch.object(manager.os, "replace", side_effect=crash_second):
            with self.assertRaises(KeyboardInterrupt):
                self.register()
        self.assertFalse(self.paths.registry.exists())
        self.assertEqual(len(list(self.paths.link_dir.glob("codex-*"))), 1)
        repaired = self.register()
        self.assertFalse(repaired["alreadyRegistered"])
        with self.paths.registry.open(encoding="utf-8") as handle:
            self.assertEqual(len(list(csv.DictReader(handle))), 1)

    def test_sync_adopts_an_exact_orphan_launcher_without_downgrading_it(self):
        original_replace = manager.os.replace
        calls = 0

        def crash_second(source, target):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise KeyboardInterrupt("injected crash")
            return original_replace(source, target)

        with mock.patch.object(manager.os, "replace", side_effect=crash_second):
            with self.assertRaises(KeyboardInterrupt):
                self.register()
        launcher = next(self.paths.link_dir.glob("codex-*"))
        locked = launcher.read_text(encoding="utf-8")
        command = launcher.name
        discovered = manager.Conversation(
            conversation_id=self.thread_id,
            label=self.thread_id,
            project=self.project,
            command=command,
            launcher=launcher,
            created_at="",
            updated_at="",
            source="codex-state",
            notes="",
        )
        with mock.patch.multiple(
            manager,
            REGISTRY=self.paths.registry,
            LINK_DIR=self.paths.link_dir,
            merge_conversations=mock.Mock(return_value={self.thread_id: discovered}),
        ):
            manager.sync_registry_and_launchers()
        self.assertEqual(launcher.read_text(encoding="utf-8"), locked)
        with self.paths.registry.open(encoding="utf-8") as handle:
            self.assertEqual(list(csv.DictReader(handle)), [])
        self.assertFalse(self.register()["alreadyRegistered"])
        with self.paths.registry.open(encoding="utf-8") as handle:
            row = next(csv.DictReader(handle))
        self.assertEqual(row["source"], "registry+codex-state")
        self.assertEqual(row["label"], manager._project_human_thread_label(self.project.name))

    def test_human_purpose_resume_rejects_missing_or_mismatched_launcher(self):
        self.register()
        rows = manager._read_registry_from(self.paths.registry, self.paths.link_dir)
        item = rows[self.thread_id]
        item.launcher.unlink()
        with self.assertRaisesRegex(RuntimeError, "launcher is unavailable"):
            manager.start_resume_tmux(item, attach=False)
        item.launcher.write_text("#!/usr/bin/env bash\nexit 0\n", encoding="utf-8")
        item.launcher.chmod(0o755)
        with self.assertRaisesRegex(RuntimeError, "launcher is unavailable"):
            manager.start_resume_tmux(item, attach=False)

    def test_atomic_sync_failure_preserves_existing_registry_bytes(self):
        self.register()
        before = self.paths.registry.read_bytes()
        rows = manager._read_registry_from(self.paths.registry, self.paths.link_dir)
        rows[self.thread_id].notes += ";sync-fixture-change"
        with mock.patch.multiple(
            manager,
            REGISTRY=self.paths.registry,
            LINK_DIR=self.paths.link_dir,
            merge_conversations=mock.Mock(return_value=rows),
        ), mock.patch.object(manager.os, "replace", side_effect=OSError("injected")):
            with self.assertRaises(OSError):
                manager.sync_registry_and_launchers()
        self.assertEqual(self.paths.registry.read_bytes(), before)

    def test_post_registry_fsync_failure_preserves_reconcilable_pair(self):
        original_fsync = manager._fsync_directory
        calls = 0

        def fail_registry_fsync(directory):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise OSError("injected")
            return original_fsync(directory)

        with mock.patch.object(
            manager, "_fsync_directory", side_effect=fail_registry_fsync
        ):
            with self.assertRaises(OSError):
                self.register()
        self.assertTrue(self.paths.registry.is_file())
        with self.paths.registry.open(encoding="utf-8") as handle:
            row = next(csv.DictReader(handle))
        self.assertTrue(Path(row["launcher"]).is_file())

    def test_launcher_migration_adopts_exact_orphan_after_crash(self):
        self.register()
        rows = manager._read_registry_from(self.paths.registry, self.paths.link_dir)
        item = rows[self.thread_id]
        item.command = f"{item.command}-migrated"
        item.launcher = self.paths.link_dir / item.command
        item.launcher.write_text(manager._launcher_content(item), encoding="utf-8")
        item.launcher.chmod(0o755)

        manager._commit_launcher_migration(
            self.paths.registry, rows, [item]
        )

        recovered = manager._read_registry_from(
            self.paths.registry, self.paths.link_dir
        )[self.thread_id]
        self.assertEqual(recovered.command, item.command)
        self.assertEqual(recovered.launcher, item.launcher)

    def test_launcher_migration_rejects_changed_orphan(self):
        self.register()
        rows = manager._read_registry_from(self.paths.registry, self.paths.link_dir)
        item = rows[self.thread_id]
        item.command = f"{item.command}-migrated"
        item.launcher = self.paths.link_dir / item.command
        item.launcher.write_text("untrusted\n", encoding="utf-8")
        item.launcher.chmod(0o755)

        with self.assertRaisesRegex(
            ValueError, "launcher_migration_target_conflict"
        ):
            manager._commit_launcher_migration(
                self.paths.registry, rows, [item]
            )

    def test_sync_never_rebinds_controlled_launcher_to_recreated_root(self):
        self.register()
        rows = manager._read_registry_from(self.paths.registry, self.paths.link_dir)
        item = rows[self.thread_id]
        before = item.launcher.read_bytes()
        displaced = self.project.with_name("Project Alpha old")
        self.project.rename(displaced)
        self.project.mkdir()

        with mock.patch.multiple(
            manager,
            REGISTRY=self.paths.registry,
            LINK_DIR=self.paths.link_dir,
            merge_conversations=mock.Mock(return_value=rows),
        ):
            manager.sync_registry_and_launchers()

        self.assertEqual(item.launcher.read_bytes(), before)

    def test_discovered_cwd_drift_cannot_downgrade_controlled_row(self):
        self.register()
        registered = manager._read_registry_from(
            self.paths.registry, self.paths.link_dir
        )
        renamed = self.workspace / "Renamed Alpha"
        renamed.mkdir()
        found = manager.Conversation(
            conversation_id=self.thread_id,
            label=self.thread_id,
            project=renamed,
            command=manager.command_for(renamed, self.thread_id),
            launcher=self.paths.link_dir / manager.command_for(renamed, self.thread_id),
            created_at="",
            updated_at="2026-08-24T00:00:00+00:00",
            source="codex-state",
            notes="",
        )
        with mock.patch.object(manager, "read_registry", return_value=registered), mock.patch.object(
            manager, "discover_threads", return_value={self.thread_id: found}
        ):
            merged = manager.merge_conversations()

        self.assertEqual(merged[self.thread_id].project, self.project)
        self.assertTrue(manager._is_project_human_thread(merged[self.thread_id]))

    def test_legacy_truncated_human_label_remains_reserved(self):
        command = f"codex-project-alpha-{self.thread_id[:8]}"
        item = manager.Conversation(
            conversation_id=self.thread_id,
            label=(
                "This is the dedicated Roadex human interaction thread for "
                "the Project Alpha project. Do"
            ),
            project=self.project,
            command=command,
            launcher=self.paths.link_dir / command,
            created_at="",
            updated_at="",
            source="registry+codex-state",
            notes="",
        )
        with mock.patch.object(manager, "LINK_DIR", self.paths.link_dir):
            self.assertTrue(manager._is_project_human_thread(item))
        item.command = f"{command}-other"
        with mock.patch.object(manager, "LINK_DIR", self.paths.link_dir):
            self.assertFalse(manager._is_project_human_thread(item))


if __name__ == "__main__":
    unittest.main()

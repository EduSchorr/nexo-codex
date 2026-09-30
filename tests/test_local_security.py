import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class LocalSecurityTests(unittest.TestCase):
    def test_executable_attachments_are_blocked(self):
        for suffix in {'.exe', '.dll', '.cmd', '.ps1', '.msi', '.vbs'}:
            self.assertIn(suffix, server.BLOCKED_TYPES)

    def test_read_only_mode_is_preserved(self):
        result = server.scoped_rpc_params('thread/start', {'sandbox': 'read-only'})
        self.assertEqual(result['sandbox'], 'read-only')
        self.assertEqual(result['approvalPolicy'], 'on-request')

    def test_workspace_is_limited_to_allowed_personal_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp).resolve()
            child = root / 'project'
            child.mkdir()
            with patch.object(server, 'personal_folders', return_value={'Documents': root}):
                result = server.scoped_rpc_params(
                    'thread/start',
                    {'sandbox': 'workspace-write', 'cwd': str(child)}
                )
            self.assertEqual(Path(result['cwd']), child)
            self.assertEqual(result['approvalPolicy'], 'on-request')

    def test_workspace_outside_allowed_roots_is_rejected(self):
        with tempfile.TemporaryDirectory() as allowed, tempfile.TemporaryDirectory() as denied:
            with patch.object(server, 'personal_folders', return_value={'Documents': Path(allowed).resolve()}):
                with self.assertRaises(ValueError):
                    server.scoped_rpc_params(
                        'thread/start',
                        {'sandbox': 'workspace-write', 'cwd': denied}
                    )

    def test_unknown_sandbox_mode_is_rejected(self):
        with self.assertRaises(ValueError):
            server.scoped_rpc_params('thread/start', {'sandbox': 'dangerously-unrestricted'})


if __name__ == '__main__':
    unittest.main()

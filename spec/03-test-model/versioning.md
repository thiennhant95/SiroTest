# Test Versioning

- `tests.definition_json` contains current definition.
- On meaningful save, create immutable `test_versions` snapshot.
- Store author, timestamp and optional change message.
- Restore creates a new version; it does not delete history.
- Autosave drafts may be debounced and should not create a permanent version for every keystroke.

P0 UI: History list → Preview → Restore.

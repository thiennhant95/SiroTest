# Database Schema

P0: SQLite via Prisma; schema must remain PostgreSQL-compatible.

## users
`id, email, name, password_hash/auth_ref, role, created_at, updated_at`

## projects
`id, name, description, base_url, created_at, updated_at`

## project_members
`project_id, user_id, role`

## environments
`id, project_id, name, is_default, created_at, updated_at`

## variables
`id, project_id, environment_id?, key, value_encrypted/value, is_secret, created_at, updated_at`

## tests
`id, project_id, name, description, definition_json, status, created_by, created_at, updated_at`

## test_versions
`id, test_id, version_number, definition_json, created_by, change_message, created_at`

## test_suites
`id, project_id, name, description`

## suite_tests
`suite_id, test_id, sort_order`

## runs
`id, project_id, test_id, environment_id, browser, status, trigger, started_at, finished_at, duration_ms, error_summary`

## run_steps
`id, run_id, step_id, sort_order, status, started_at, finished_at, duration_ms, error_message, screenshot_path`

## artifacts
`id, run_id, type, path, mime_type, size_bytes, created_at`

### P0 simplification
Keep steps inside `definition_json`; do not normalize them into relational tables. Suites/tags can be deferred if schedule is tight.

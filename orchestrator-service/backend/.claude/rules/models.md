# Data Models

## Model Files
- `db/migrations/0001_init.sql`
- `db/migrations/0002_role_pipeline.sql`
- `db/migrations/0003_scanner_dispatches.sql`
- `db/migrations/0004_connectors.sql`
- `db/migrations/0005_runner.sql`
- `db/migrations/0006_project_stages.sql`
- `db/migrations/0007_project_root_path.sql`
- `db/migrations/0008_business_storage.sql`
- `db/migrations/0009_role_configuration.sql`
- `db/migrations/0010_pipeline_local_executor.sql`
- `db/migrations/0011_database_connections.sql`
- `db/migrations/0012_task_external_id.sql`
- `db/migrations/0013_stage_enabled_explicit.sql`
- `db/migrations/0014_stage_task_status.sql`
- `db/migrations/0015_role_groups.sql`
- `db/migrations/0016_role_prompts.sql`
- `db/migrations/0017_stage_status_all.sql`
- `db/migrations/0018_field_contracts.sql`
- `db/migrations/0019_prompt_neutral_routing.sql`
- `db/migrations/0020_development_scheme.sql`
- `db/migrations/0021_task_intake_officer.sql`
- `db/migrations/0022_project_scanner_enabled.sql`
- `db/migrations/0023_tools.sql`
- `db/migrations/0024_stage_enabled_default_true.sql`
- `db/migrations/0025_waiting_status.sql`
- `db/migrations/0026_fork_join_graph.sql`
- `db/migrations/0026_project_tasks_path.sql`
- `db/migrations/0027_fork_join_runtime.sql`
- `db/migrations/0028_task_unassigned_intake.sql`
- `db/migrations/0029_programmer_context_cleanup_prompt.sql`
- `db/migrations/0030_task_restart_status.sql`
- `db/migrations/0031_app_settings.sql`
- `db/migrations/0032_programmer_concurrency.sql`
- `db/migrations/0033_orchestrator_auditor.sql`
- `db/migrations/0034_task_decomposition.sql`
- `db/migrations/0035_agent_run_kpi.sql`
- `db/migrations/0036_agent_run_connector_snapshot.sql`
- `db/migrations/0036_driver_connectors.sql`
- `db/migrations/0036_version_kpi_tracking.sql`
- `db/migrations/0037_task_acceptance.sql`
- `db/migrations/0038_english_role_prompts.sql`
- `db/migrations/0039_orchestrator_enabled.sql`
- `db/migrations/0040_remove_decomposer.sql`
- `db/migrations/0040_task_intake_contract.sql`
- `db/migrations/0041_mcp_roles.sql`
- `db/migrations/0042_task_intake_officer_mcp.sql`
- `db/migrations/0043_agent_run_token_split.sql`
- `db/migrations/0043_intake_integrations.sql`
- `db/migrations/0044_programmer_concurrency_restore.sql`
- `db/migrations/0045_intake_category_validation.sql`
- `db/migrations/0046_docs_commit_on_join.sql`
- `db/migrations/0047_task_priority_scale.sql`
- `db/migrations/0048_intake_officer_priority.sql`
- `db/migrations/0049_remove_postjoin_git_integrator.sql`
- `db/migrations/0050_intake_optional_list_fields.sql`
- `db/migrations/0051_task_duplicate_close.sql`
- `db/migrations/0052_auto_accept_done_default_off.sql`
- `db/migrations/0053_hide_unexecutable_roles.sql`
- `db/migrations/0053_role_connectors_reasoning_only.sql`
- `db/migrations/0054_stage_enabled_no_default.sql`
- `db/migrations/0055_codebase_memory_documents.sql`
- `db/migrations/0056_codebase_memory_role_prompts.sql`
- `db/migrations/0057_work_stack.sql`


## Enums & Constants
- Scan model files above for enum definitions

## Migration notes
- No migrations detected

## New Models (added 2026-07-10)
- `db/migrations/0058_infrastructure_department.sql`

## New Models (added 2026-07-10)
- `db/migrations/0059_infrastructure_pipeline.sql`

## New Models (added 2026-07-11)
- `src/clickhouseSchema.js`

## New Models (added 2026-07-12)
- `tmp-inspect-schema.mjs`
- `tmp-schema.txt`

## New Models (added 2026-07-13)
- `db/migrations/0060_restore_postjoin_git_integrator.sql`

## New Models (added 2026-07-14)
- `db/migrations/0061_task_size_triage.sql`

## New Models (added 2026-07-14)
- `db/migrations/0062_task_router_mini_architect.sql`

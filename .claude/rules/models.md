# Data Models

## Model Files
- `_orchestrator_template/migrations/0.0.0_to_1.0.0.md`
- `_orchestrator_template/migrations/1.0.0_to_1.1.0.md`
- `_orchestrator_template/migrations/1.1.0_to_1.2.0.md`
- `_orchestrator_template/migrations/1.2.0_to_1.3.0.md`
- `_orchestrator_template/migrations/README.md`
- `marshrutka/oxidized/model/ndms.rb`
- `orchestrator-service/backend/db/migrations/0001_init.sql`
- `orchestrator-service/backend/db/migrations/0002_role_pipeline.sql`
- `orchestrator-service/backend/db/migrations/0003_scanner_dispatches.sql`
- `orchestrator-service/backend/db/migrations/0004_connectors.sql`
- `orchestrator-service/backend/db/migrations/0005_runner.sql`
- `orchestrator-service/backend/db/migrations/0006_project_stages.sql`
- `orchestrator-service/backend/db/migrations/0007_project_root_path.sql`
- `orchestrator-service/backend/db/migrations/0008_business_storage.sql`
- `orchestrator-service/backend/db/migrations/0009_role_configuration.sql`
- `orchestrator-service/backend/db/migrations/0010_pipeline_local_executor.sql`
- `orchestrator-service/backend/db/migrations/0011_database_connections.sql`
- `orchestrator-service/backend/db/migrations/0012_task_external_id.sql`
- `orchestrator-service/backend/db/migrations/0013_stage_enabled_explicit.sql`
- `orchestrator-service/backend/db/migrations/0014_stage_task_status.sql`
- `orchestrator-service/backend/db/migrations/0015_role_groups.sql`
- `orchestrator-service/backend/db/migrations/0016_role_prompts.sql`
- `orchestrator-service/backend/db/migrations/0017_stage_status_all.sql`
- `orchestrator-service/backend/db/migrations/0018_field_contracts.sql`
- `orchestrator-service/backend/db/migrations/0019_prompt_neutral_routing.sql`
- `orchestrator-service/backend/db/migrations/0020_development_scheme.sql`
- `orchestrator-service/backend/db/migrations/0021_task_intake_officer.sql`
- `orchestrator-service/backend/db/migrations/0022_project_scanner_enabled.sql`
- `orchestrator-service/backend/db/migrations/0023_tools.sql`
- `orchestrator-service/backend/db/migrations/0024_stage_enabled_default_true.sql`
- `orchestrator-service/backend/db/migrations/0025_waiting_status.sql`
- `orchestrator-service/backend/db/migrations/0026_fork_join_graph.sql`
- `orchestrator-service/backend/db/migrations/0026_project_tasks_path.sql`
- `orchestrator-service/backend/db/migrations/0027_fork_join_runtime.sql`
- `orchestrator-service/backend/db/migrations/0028_task_unassigned_intake.sql`
- `orchestrator-service/backend/db/migrations/0029_programmer_context_cleanup_prompt.sql`
- `orchestrator-service/backend/db/migrations/0030_task_restart_status.sql`
- `orchestrator-service/backend/db/migrations/0031_app_settings.sql`
- `orchestrator-service/backend/db/migrations/0032_programmer_concurrency.sql`
- `orchestrator-service/backend/db/migrations/0033_orchestrator_auditor.sql`
- `orchestrator-service/backend/db/migrations/0034_task_decomposition.sql`
- `orchestrator-service/backend/db/migrations/0035_agent_run_kpi.sql`
- `orchestrator-service/backend/db/migrations/0036_agent_run_connector_snapshot.sql`
- `orchestrator-service/backend/db/migrations/0036_driver_connectors.sql`
- `orchestrator-service/backend/db/migrations/0036_version_kpi_tracking.sql`
- `orchestrator-service/backend/db/migrations/0037_task_acceptance.sql`
- `orchestrator-service/backend/db/migrations/0038_english_role_prompts.sql`
- `orchestrator-service/backend/db/migrations/0039_orchestrator_enabled.sql`
- `orchestrator-service/backend/db/migrations/0040_remove_decomposer.sql`
- `orchestrator-service/backend/db/migrations/0040_task_intake_contract.sql`
- `orchestrator-service/backend/db/migrations/0041_mcp_roles.sql`
- `orchestrator-service/backend/db/migrations/0042_task_intake_officer_mcp.sql`
- `orchestrator-service/backend/db/migrations/0043_agent_run_token_split.sql`
- `orchestrator-service/backend/db/migrations/0043_intake_integrations.sql`
- `orchestrator-service/backend/db/migrations/0044_programmer_concurrency_restore.sql`
- `orchestrator-service/backend/db/migrations/0045_intake_category_validation.sql`
- `orchestrator-service/backend/db/migrations/0046_docs_commit_on_join.sql`
- `orchestrator-service/backend/db/migrations/0047_task_priority_scale.sql`
- `orchestrator-service/backend/db/migrations/0048_intake_officer_priority.sql`
- `orchestrator-service/backend/db/migrations/0049_remove_postjoin_git_integrator.sql`
- `orchestrator-service/backend/db/migrations/0050_intake_optional_list_fields.sql`
- `orchestrator-service/backend/db/migrations/0051_task_duplicate_close.sql`
- `orchestrator-service/backend/db/migrations/0052_auto_accept_done_default_off.sql`
- `orchestrator-service/backend/db/migrations/0053_hide_unexecutable_roles.sql`
- `orchestrator-service/backend/db/migrations/0053_role_connectors_reasoning_only.sql`
- `orchestrator-service/backend/db/migrations/0054_stage_enabled_no_default.sql`
- `orchestrator-service/backend/db/migrations/0055_codebase_memory_documents.sql`
- `orchestrator-service/backend/db/migrations/0056_codebase_memory_role_prompts.sql`
- `orchestrator-service/backend/db/migrations/0057_work_stack.sql`
- `orchestrator-service/backend/db/migrations/0058_infrastructure_department.sql`
- `orchestrator-service/backend/db/migrations/0059_infrastructure_pipeline.sql`
- `orchestrator-service/backend/db/migrations/0060_restore_postjoin_git_integrator.sql`
- `orchestrator-service/backend/db/migrations/0061_task_size_triage.sql`
- `orchestrator-service/backend/db/migrations/0062_task_router_mini_architect.sql`
- `orchestrator-service/backend/src/clickhouseSchema.js`
- `output/razrabotka-block-schema-vertical-clean.png`
- `output/razrabotka-block-schema-vertical-table-names.png`
- `output/razrabotka-block-schema-vertical.png`
- `output/razrabotka-block-schema.png`
- `shared/logging/event.schema.json`
- `src/types/common.ts`
- `src/types/feedback.ts`
- `src/types/fields.ts`
- `src/types/intakeIntegration.ts`
- `src/types/integration.ts`
- `src/types/project.ts`
- `src/types/server.ts`
- `src/types/settings.ts`
- `src/types/taskStats.ts`


## Enums & Constants
- Scan model files above for enum definitions

## Migration notes
- No migrations detected

## Postgres Memory Tables
- `codebase_memory_documents` mirrors Codebase Memory markdown files in Postgres, keyed by `(project_id, doc_key)`.

## New Models (added 2026-07-20)
- `orchestrator-service/backend/db/migrations/0063_task_needs_input_status.sql`
- `orchestrator-service/backend/db/migrations/0064_task_questions.sql`

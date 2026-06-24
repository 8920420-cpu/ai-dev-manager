import { ConfigLoader } from './ConfigLoader.js';
import { PipelineRunner } from './PipelineRunner.js';

export { ConfigLoader, ConfigError } from './ConfigLoader.js';
export { PipelineRunner } from './PipelineRunner.js';
export { StageRunner } from './StageRunner.js';
export { CommandExecutor } from './CommandExecutor.js';
export { Logger } from './Logger.js';
export { ResultWriter } from './ResultWriter.js';
export {
  ServicePipelineTask,
  PipelineTaskError,
  runServicePipeline,
  resolveServicePaths,
  isServiceRelPathSafe,
  isInsideRoot,
  safeLogFragment,
  PIPELINE_ROLE_CODE,
  DEFAULT_PIPELINE_CONFIG_FILENAME,
  SAFE_LOG_FRAGMENT_LIMIT,
} from './ServicePipelineTask.js';

/**
 * Высокоуровневая точка входа: загрузить конфиг и выполнить pipeline.
 * Возвращает объект результата для оркестратора.
 *
 * @param {Object} opts
 * @param {string} [opts.configPath='.pipeline.json']
 * @param {Object} [opts.deps] переопределение зависимостей (для тестов)
 * @returns {Promise<{success: boolean, runId: string, reportPath: string, failedStage?: string}>}
 */
export async function runPipeline({ configPath = '.pipeline.json', deps = {} } = {}) {
  const config = await new ConfigLoader().load(configPath);
  const runner = new PipelineRunner({ config, ...deps });
  return runner.execute();
}

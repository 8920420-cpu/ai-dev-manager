import { writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * ResultWriter — единственная ответственность: сохранить итоговый summary.json
 * в каталог конкретного запуска.
 */
export class ResultWriter {
  /**
   * @param {string} reportDir каталог запуска (.tmp/pipeline-results/<runId>)
   * @param {Object} summary объект, сериализуемый в summary.json
   */
  async write(reportDir, summary) {
    const file = path.join(reportDir, 'summary.json');
    await writeFile(file, JSON.stringify(summary, null, 2) + '\n', 'utf8');
    return file;
  }
}

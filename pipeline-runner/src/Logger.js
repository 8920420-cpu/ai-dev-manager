import { createWriteStream } from 'node:fs';

/**
 * Logger — единственная ответственность: писать ход выполнения в pipeline.log.
 *
 * Эхо дублируется в stderr (НЕ в stdout), чтобы stdout оставался чистым
 * каналом для финального JSON-результата, который читает оркестратор.
 */
export class Logger {
  /**
   * @param {string} logFilePath путь к pipeline.log
   * @param {Object} [opts]
   * @param {boolean} [opts.echo=true] дублировать ли вывод в stderr
   */
  constructor(logFilePath, { echo = true } = {}) {
    this.stream = createWriteStream(logFilePath, { flags: 'a' });
    this.echo = echo;
  }

  /** Сырой фрагмент (stdout/stderr команды) без переноса строки. */
  raw(chunk) {
    this._write(chunk);
  }

  /** Строка с переносом. */
  line(message) {
    this._write(message + '\n');
  }

  log(level, message) {
    this.line(`[${new Date().toISOString()}] [${level}] ${message}`);
  }

  info(message) {
    this.log('INFO', message);
  }
  warn(message) {
    this.log('WARN', message);
  }
  error(message) {
    this.log('ERROR', message);
  }

  _write(text) {
    this.stream.write(text);
    if (this.echo) process.stderr.write(text);
  }

  /** Дождаться сброса буфера на диск. */
  close() {
    return new Promise((resolve) => this.stream.end(resolve));
  }
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isServicePathSafe,
  resolveWorkingDirectory,
  buildPipelineClaimContract,
  PIPELINE_CONFIG_FILENAME,
} from '../src/pipelineDispatch.js';
import { LLM_ROLE_CODES, HOST_ROLE_CODES } from '../src/roleEngine.js';

// --- Гарантия: PIPELINE_SERVICE — не LLM-роль -------------------------------

test('PIPELINE_SERVICE исключён из LLM-диспетчера и помечен host-ролью', () => {
  assert.ok(!LLM_ROLE_CODES.includes('PIPELINE_SERVICE')); // не рассуждающая роль → нет LLM-вызова
  assert.ok(HOST_ROLE_CODES.includes('PIPELINE_SERVICE'));
});

// --- Безопасность пути сервиса ----------------------------------------------

test('isServicePathSafe: относительный ок, traversal/абсолютный — нет', () => {
  assert.equal(isServicePathSafe(''), true); // сервис в корне проекта
  assert.equal(isServicePathSafe('services/catalog'), true);
  assert.equal(isServicePathSafe('../escape'), false);
  assert.equal(isServicePathSafe('a/../b'), false);
  assert.equal(isServicePathSafe('/abs'), false);
  assert.equal(isServicePathSafe('C:/win'), false);
});

test('resolveWorkingDirectory: join, null для небезопасного/без корня', () => {
  assert.equal(resolveWorkingDirectory('PS', 'services/catalog'), 'PS/services/catalog');
  assert.equal(resolveWorkingDirectory('PS/', 'services/catalog'), 'PS/services/catalog');
  assert.equal(resolveWorkingDirectory('PS', ''), 'PS');
  assert.equal(resolveWorkingDirectory('PS', '../x'), null);
  assert.equal(resolveWorkingDirectory('', 'services/catalog'), null);
});

// --- Контракт claim ----------------------------------------------------------

test('buildPipelineClaimContract: валидный вход → стабильный DTO', () => {
  const dto = buildPipelineClaimContract({
    projectId: 'p1', projectCode: 'PS',
    serviceId: 's1', serviceCode: 'Catalog_Service', serviceName: 'Catalog Service',
    projectRoot: 'PS', repositoryPath: 'services/catalog',
  });
  assert.equal(dto.projectId, 'p1');
  assert.equal(dto.serviceId, 's1');
  assert.equal(dto.serviceName, 'Catalog Service');
  assert.equal(dto.workingDirectory, 'PS/services/catalog');
  assert.equal(dto.pipelineConfigRef, `PS/services/catalog/${PIPELINE_CONFIG_FILENAME}`);
});

test('buildPipelineClaimContract: serviceName fallback к serviceCode', () => {
  const dto = buildPipelineClaimContract({
    projectId: 'p1', serviceId: 's1', serviceCode: 'Svc', projectRoot: 'PS', repositoryPath: '',
  });
  assert.equal(dto.serviceName, 'Svc');
  assert.equal(dto.workingDirectory, 'PS');
});

test('buildPipelineClaimContract: неизвестный сервис → ошибка', () => {
  assert.throws(
    () => buildPipelineClaimContract({ projectId: 'p1', serviceId: '', projectRoot: 'PS', repositoryPath: 'x' }),
    /pipeline_service_required/,
  );
});

test('buildPipelineClaimContract: выход за корень проекта → ошибка', () => {
  assert.throws(
    () => buildPipelineClaimContract({ projectId: 'p1', serviceId: 's1', projectRoot: 'PS', repositoryPath: '../escape' }),
    /pipeline_service_path_escape/,
  );
});

test('buildPipelineClaimContract: нет корня проекта → ошибка', () => {
  assert.throws(
    () => buildPipelineClaimContract({ projectId: 'p1', serviceId: 's1', projectRoot: '', repositoryPath: 'svc' }),
    /pipeline_working_directory_unresolved/,
  );
});

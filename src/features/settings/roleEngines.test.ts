import { describe, it, expect } from 'vitest';
import { NON_EXECUTABLE_ROLE_CODES, roleHasExecutor } from './roleEngines';

// STAGE-ROLE-EXECUTOR-001 — роли без исполнителя не должны попадать в выбор этапа
// (иначе задача зависнет). Набор зеркалит бэкенд (roles.hidden + отсутствие в ROLE_FLOW).
describe('roleEngines — роли без исполнителя (STAGE-ROLE-EXECUTOR-001)', () => {
  it('NON_EXECUTABLE_ROLE_CODES содержит ровно 5 согласованных с бэкендом ролей', () => {
    expect([...NON_EXECUTABLE_ROLE_CODES].sort()).toEqual(
      ['COMMITTER', 'DEPLOYER', 'REVIEWER', 'STRUCTURE_KEEPER', 'TESTER'].sort(),
    );
  });

  it('roleHasExecutor = false для каждой роли без исполнителя', () => {
    for (const code of NON_EXECUTABLE_ROLE_CODES) {
      expect(roleHasExecutor(code)).toBe(false);
    }
  });

  it('roleHasExecutor = true для исполняемых ролей маршрута', () => {
    expect(roleHasExecutor('PROGRAMMER')).toBe(true);
    expect(roleHasExecutor('GIT_INTEGRATOR')).toBe(true);
    expect(roleHasExecutor('DOCUMENTATION_AUDITOR')).toBe(true);
  });

  it('пустой код (роль без code) считается без исполнителя', () => {
    expect(roleHasExecutor('')).toBe(false);
  });
});

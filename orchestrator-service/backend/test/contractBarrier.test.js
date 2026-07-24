import test from 'node:test';
import assert from 'node:assert/strict';
import { isContractPath, detectContractOwnerIndex } from '../src/db.js';

// PROGRAMMER-CONTRACT-BARRIER-001 — детект владельца общего контракта (proto) для
// очерёдности «контракт раньше потребителей».

test('isContractPath: .proto и каталоги контрактов → true', () => {
  assert.equal(isContractPath('proto-contracts/chat/chat.proto'), true);
  assert.equal(isContractPath('chat.proto'), true);
  assert.equal(isContractPath('services/proto/user.go'), true);   // сегмент proto/
  assert.equal(isContractPath('proto/user.proto'), true);         // начинается с proto/
  assert.equal(isContractPath('a/proto-contracts/x.txt'), true);  // каталог proto-contracts
});

test('isContractPath: нормализация слэшей и регистра', () => {
  assert.equal(isContractPath('proto-contracts\\chat\\chat.proto'), true);
  assert.equal(isContractPath('PROTO-CONTRACTS/Chat/Chat.PROTO'), true);
});

test('isContractPath: обычные исходники и сгенерированный код → false', () => {
  assert.equal(isContractPath('CRM/Chat_Service/backend/internal/repo/identity.go'), false);
  assert.equal(isContractPath('chat.pb.go'), false);         // сгенерированный, не исходник контракта
  assert.equal(isContractPath('frontend/src/inbox.ts'), false);
  assert.equal(isContractPath('src/prototype.ts'), false);   // 'proto' как подстрока, не сегмент
  assert.equal(isContractPath(''), false);
  assert.equal(isContractPath(null), false);
  assert.equal(isContractPath(undefined), false);
});

test('detectContractOwnerIndex: ровно один владелец → его индекс', () => {
  const items = [
    { serviceCode: 'Chat_Service', files: [{ path: 'proto-contracts/chat/chat.proto' }, { path: 'internal/repo/identity.go' }] },
    { serviceCode: 'Getway', files: [{ path: 'internal/handlers/http/inbox.go' }] },
    { serviceCode: 'Chat_Frontend', files: [{ path: 'src/ClientCard.tsx' }] },
  ];
  assert.equal(detectContractOwnerIndex(items), 0);
});

test('detectContractOwnerIndex: нет контракта → -1', () => {
  const items = [
    { serviceCode: 'Mail', files: [{ path: 'frontend/src/MailPage.tsx' }] },
    { serviceCode: 'Getway', files: [{ path: 'internal/handlers/http/inbox.go' }] },
  ];
  assert.equal(detectContractOwnerIndex(items), -1);
});

test('detectContractOwnerIndex: ≥2 владельца → -1 (неоднозначно, барьер не ставим)', () => {
  const items = [
    { serviceCode: 'Chat', files: [{ path: 'proto-contracts/chat/chat.proto' }] },
    { serviceCode: 'Order', files: [{ path: 'proto-contracts/order/order.proto' }] },
  ];
  assert.equal(detectContractOwnerIndex(items), -1);
});

test('detectContractOwnerIndex: устойчив к отсутствию files и пустому входу', () => {
  assert.equal(detectContractOwnerIndex([{ serviceCode: 'A' }, { serviceCode: 'B', files: [{ path: 'x.proto' }] }]), 1);
  assert.equal(detectContractOwnerIndex([]), -1);
  assert.equal(detectContractOwnerIndex(null), -1);
});

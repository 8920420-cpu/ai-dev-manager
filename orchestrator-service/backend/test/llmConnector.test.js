import { test } from 'node:test';
import assert from 'node:assert/strict';

// Чистые функции коннектора — без сети. Проверяем «точно такую же» логику,
// что и в источнике (Connector_Service, llm_connector_client_test.go).
const { buildRequest, parseLLMResponse, _internal } = await import('../src/llmConnector.js');

test('DeepSeek endpoint распознаётся как OpenAI-совместимый chat API', () => {
  assert.equal(_internal.usesOpenAIChatAPI('https://api.deepseek.com'), true);
  assert.equal(_internal.usesOpenAIChatAPI('https://api.openai.com/v1'), true);
  assert.equal(_internal.usesOpenAIChatAPI('http://localhost:9000/ingest'), false);
});

test('normalizeChatCompletionsEndpoint дополняет путь до /chat/completions', () => {
  assert.equal(
    _internal.normalizeChatCompletionsEndpoint('https://api.deepseek.com'),
    'https://api.deepseek.com/chat/completions',
  );
  assert.equal(
    _internal.normalizeChatCompletionsEndpoint('https://api.deepseek.com/v1'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    _internal.normalizeChatCompletionsEndpoint('https://api.deepseek.com/v1/chat/completions'),
    'https://api.deepseek.com/v1/chat/completions',
  );
});

test('defaultModelForEndpoint: явная модель важнее, иначе deepseek-chat', () => {
  assert.equal(_internal.defaultModelForEndpoint('https://api.deepseek.com', 'my-model'), 'my-model');
  assert.equal(_internal.defaultModelForEndpoint('https://api.deepseek.com', ''), 'deepseek-chat');
});

test('buildRequest формирует OpenAI chat payload для DeepSeek', () => {
  const { endpoint, body } = buildRequest(
    { name: 'ds', endpoint: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    { system: 'You are a bot', user: 'Дай json со списком' },
  );
  assert.equal(endpoint, 'https://api.deepseek.com/v1/chat/completions');
  const payload = JSON.parse(body);
  assert.equal(payload.model, 'deepseek-chat');
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[1].role, 'user');
  assert.equal(payload.temperature, 0);
});

test('json_object режим добавляет подсказку, если в user нет слова json', () => {
  const { body } = buildRequest(
    { name: 'ds', endpoint: 'https://api.deepseek.com/v1' },
    { user: 'Список товаров' },
  );
  const payload = JSON.parse(body);
  assert.equal(payload.response_format.type, 'json_object');
  const lastUser = payload.messages[payload.messages.length - 1];
  assert.match(lastUser.content.toLowerCase(), /json/);
});

test('buildRequest бросает на пустом промте и пустом endpoint', () => {
  assert.throws(() => buildRequest({ name: 'x', endpoint: 'https://api.deepseek.com' }, {}));
  assert.throws(() => buildRequest({ name: 'x', endpoint: '' }, { user: 'hi' }));
});

test('parseLLMResponse извлекает текст из OpenAI choices', () => {
  const raw = JSON.stringify({ choices: [{ message: { content: 'привет' } }] });
  assert.equal(parseLLMResponse(raw), 'привет');
});

test('parseLLMResponse отдаёт plain text как есть', () => {
  assert.equal(parseLLMResponse('просто текст'), 'просто текст');
});

test('parseLLMResponse бросает на error-объекте API', () => {
  const raw = JSON.stringify({ error: { message: 'invalid api key' } });
  assert.throws(() => parseLLMResponse(raw), /api error: invalid api key/);
});

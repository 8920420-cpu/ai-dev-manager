// Глобальный setup для vitest: подключает матчеры jest-dom (toBeInTheDocument и т.п.)
// и чистит DOM между тестами.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

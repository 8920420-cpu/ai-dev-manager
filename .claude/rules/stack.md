# Tech Stack

## Languages
- TypeScript
- JavaScript

## Frameworks & Libraries
- React 18.3.1
- Tailwind CSS 4.3.1
- Vitest ^2.1.9
- Vite ^6.4.3
- Docker 

## Database
- None detected

## External APIs
- Check .env.example for API keys

## Dev Tooling
- Package manager: npm
- Linter: not detected
- Test runner: Vitest
- Bundler: Vite

## All Commands
| Command | What it does |
|---------|-------------|
| `npm run dev` | vite |
| `npm run build` | tsc --noEmit && vite build |
| `npm run build:only` | vite build |
| `npm run preview` | vite preview --port 4186 |
| `npm run typecheck` | tsc --noEmit |
| `npm run test` | vitest run |
| `npm run test:services` | npm --prefix orchestrator-service/backend test && npm --prefix tools-service test && npm --prefix mcp-service test && npm --prefix scanner-service test && npm --prefix tester-service test && npm --prefix pipeline-runner test && npm --prefix host-runner test && npm --prefix programmer-runner test && npm --prefix codex-runner test |
| `npm run test:all` | npm test && npm run test:services |
| `npm run test:watch` | vitest |
| `npm run memory:sync:pg` | node scripts/sync-codebase-memory-to-postgres.js |

## Codebase Memory
- `codebase-memory.cmd analyze .` regenerates local Claude/Codex-facing memory markdown.
- `codebase-memory.cmd update .` appends incremental local memory updates.
- `npm run memory:sync:pg` mirrors memory markdown into PostgreSQL.

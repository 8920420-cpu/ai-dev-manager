# Tech Stack

## Languages
- JavaScript

## Frameworks & Libraries
- None detected

## Database
- PostgreSQL

## External APIs
- Check .env.example for API keys

## Dev Tooling
- Package manager: npm
- Linter: not detected
- Test runner: not detected
- Bundler: not detected

## All Commands
| Command | What it does |
|---------|-------------|
| `npm run start` | node bin/server.js |
| `npm run test` | node --test |
| `npm run init-db` | node -e "import('./src/config.js').then(c=>c.loadSettings()).then(s=>import('./src/db.js').then(d=>d.bootstrap(s))).then(r=>console.log(r))" |

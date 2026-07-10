# Conventions & Patterns

## Naming
- Files: camelCase
- Functions: Check source files for convention
- Types: Check types/ or interfaces/ folders

## Error Handling
- Check source for error handling patterns

## Auth Pattern
- Check middleware/ or auth/ folders

## State Management
- Check for Zustand, Redux, or React Context usage


## Testing Approach
- Test command: `npm run test`
- Framework: Vitest

## Code Style Notes

- Text files must be saved as UTF-8 without BOM. This includes `.md`, `.env`,
  `.js`, `.ts`, `.json`, `.yml`, `.yaml`, `.sql`, `.conf`, `.ps1`, and `.sh`.
- Do not paste Windows console mojibake back into source files. Verify Cyrillic by
  reading file bytes/UTF-8 content, because PowerShell output can corrupt display
  even when the file is valid.
- When generating files from PowerShell, set UTF-8 explicitly (`Set-Content
  -Encoding utf8` in PowerShell 7, or `System.IO.File.WriteAllText` with
  `UTF8Encoding($false)` for Windows PowerShell compatibility).

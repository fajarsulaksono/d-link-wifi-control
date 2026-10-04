# Agent Instructions

## Language
All comments, logs, error messages, and documentation must be written in English.

## Code Style
- Do not add any comments unless explicitly requested by the user.
- Follow existing code conventions in each file (naming, indentation, structure).
- Preserve the same coding style as the existing codebase.

## Testing
- Tests do not touch real hardware/AP.
- Use the mock server (`tests/mock_router.py`) when needed for API contract verification.
- Run `npm test` to verify changes.

## Git
- Never commit changes unless explicitly asked by the user.
- Do not commit secrets or credentials.

## CLI Usage
- Prefer `node src/cli.js` for day-to-day operations.
- All commands follow existing patterns in the codebase.
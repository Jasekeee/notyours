# Contract change requests

`src/types.ts` and `src/schemas.ts` are frozen. To change them, add a request below and stop.
Only the coordinator applies approved changes, on `main`, and every branch then rebases.

## Template

### CC-<n>: <short title>
- **Requested by:** <branch, e.g. feat/engine>
- **Date:** <YYYY-MM-DD>
- **File / symbol:** <e.g. src/schemas.ts ProbeResultSchema.hits>
- **Change:** <exact field/type change>
- **Why:** <what breaks or is impossible without it>
- **Impact on other branches:** <who must adapt, and how>
- **Status:** proposed | approved | rejected | applied (<commit>)

## Requests

_None yet._

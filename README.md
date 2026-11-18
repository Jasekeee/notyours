# notyours

notyours proves your users' data stays theirs: Kane CLI runs Alice, Bob, a guest and a free user against your app; a canary-token oracle decides; leaks go back to your coding agent.

## Status

Early spike. See `spike/RESULTS.md`.

## Development

Requires Node 22+ and [kane-cli](https://www.testmuai.com/kane-cli/).

Secrets live only in `.env` (gitignored); copy `.env.example` to start. After cloning, enable the
repo's secret-blocking pre-push hook:

```sh
git config core.hooksPath .githooks
```

## License

MIT

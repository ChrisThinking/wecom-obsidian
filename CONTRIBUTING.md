# Contributing to wecom-obsidian

Thanks for your interest in contributing to **wecom-obsidian**.

wecom-obsidian is an open-source, local-first bridge between WeCom, AI agents, web content ingestion, and Obsidian.

## Ways to contribute

Contributions are welcome in many forms:

- Bug reports
- Documentation improvements
- New content-source integrations
- Test coverage
- Installation and compatibility improvements
- Security improvements
- Agent workflow improvements
- Pull requests

## Development setup

Clone the repository:

```bash
git clone https://github.com/ChrisThinking/wecom-obsidian.git
cd wecom-obsidian
```

Follow the installation and development instructions in [README.md](README.md) and the `docs/` directory.

Do not introduce installation or validation commands here that are not already supported by the repository.

## Pull requests

Before submitting a pull request:

1. Keep changes focused on one problem or feature.
2. Run the existing checks and tests relevant to your change.
3. Add or update tests when appropriate.
4. Update documentation when behavior changes.
5. Explain what changed and how the change was verified.
6. Do not include credentials, private content, or environment-specific secrets.

## Issues

When reporting a bug, please include:

- Environment and operating system
- DSH version
- Node.js or Python version when relevant
- Steps to reproduce
- Expected behavior
- Actual behavior
- Relevant logs with secrets removed

Never include WeCom secrets, API keys, access tokens, authentication credentials, or private Obsidian content in an issue.

## Security

Please do not publicly disclose vulnerabilities that could expose credentials, private data, or local files.

See [SECURITY.md](SECURITY.md) for security reporting guidance.

## License

By contributing to this repository, you agree that your contributions will be licensed under the project's MIT License.

# Security Policy

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues.

If you discover a vulnerability involving credential exposure, unauthorized file access, command execution, private data exposure, or other security-sensitive behavior, please contact the maintainer privately through the contact information available on the maintainer's GitHub profile.

Please include:

- A description of the vulnerability
- Steps to reproduce it
- The affected component
- The potential impact
- A suggested mitigation, if available

Please avoid including real credentials, private Obsidian content, or other sensitive data in the report.

## Sensitive information

Never include the following in public issues, logs, pull requests, or example configuration:

- WeCom Bot secrets
- API keys
- Authentication tokens
- Access tokens
- Private Obsidian content
- Sensitive local filesystem data
- Other user credentials

## Agent permissions

Some collection workflows require filesystem access so that content and local assets can be written into an Obsidian Vault.

Depending on the runtime configuration, an agent may operate with elevated filesystem permissions or unattended approval settings.

Users should review the agent configuration and filesystem permissions before enabling unattended workflows. Grant access only to the directories and resources required by the workflow.

Treat configurations such as `danger-full-access` and `approval=never` as security-sensitive. They should only be used in trusted environments where the execution scope and accessible data are understood.

## Local-first data

wecom-obsidian is designed around a local-first workflow. Users remain responsible for the security, permissions, backups, and access controls of their local Obsidian Vault and related assets.

Do not expose an Obsidian Vault or its containing filesystem directories to untrusted agents, services, or users.

## Supported versions

This project is currently in active early-stage development.

Security fixes are applied to the latest version on the main branch.

# Security

Inkleaf opens files that may come from anyone, so security reports are taken
seriously.

## Reporting a problem

Please **don't** open a public issue for a security problem. Instead, use
GitHub's private reporting: the **Security** tab of this repository, then
**Report a vulnerability**. Include the steps to reproduce it and, if you can,
a PDF that triggers it.

You should hear back within a week. Once a fix is released you'll be credited,
unless you'd rather not be.

## What's in scope

- A PDF that runs code, reads or writes files it shouldn't, or reaches the
  network when opened in Inkleaf.
- Redaction or Edit text leaving the removed words recoverable from the saved
  file.
- Password protection that can be opened without the password.
- Anything that gets past the app's sandbox or content security policy.

## Supported versions

Only the latest release gets security fixes. The installed app updates itself;
the portable version needs downloading again.

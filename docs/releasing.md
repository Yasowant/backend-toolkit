# Release and hosting guide

1. Review CHANGELOG, documentation and public API; set the intended SemVer version with `npm version`.
2. Run `npm ci`, `npm run check`, `npm run format:check`, `npm run test:coverage`, and `npm run test:package`.
3. Inspect `npm pack --dry-run`. Only dist, README, LICENSE, and package metadata belong in the tarball.
4. Obtain explicit maintainer approval to publish the reviewed version.
5. Authenticate to npm with an account that owns or can publish to the `@yasowant` scope. Do not paste tokens into chat, source files, or issue comments. Use `npm login` interactively.
6. First local release: `npm publish --access public`. An OTP may be required. Verify using `npm view @yasowant/backend-toolkit version` and a clean consumer install.
7. For later CI releases, configure npm trusted publishing for the exact repository and `publish.yml` workflow. Configure the GitHub `npm-publish` environment with required reviewers. The workflow is manually dispatched and checks the confirmation string against package.json before publishing with provenance.

The GitHub Pages site uses `/docs` on the main branch and GitHub's built-in Jekyll renderer. Enable Pages in repository Settings → Pages, choose Deploy from a branch, main, /docs. The Markdown source is readable on GitHub even before Pages is enabled.

Trusted publishing setup: https://docs.npmjs.com/trusted-publishers/

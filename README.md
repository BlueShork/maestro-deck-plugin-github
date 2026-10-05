# Maestro Deck — GitHub plugin

Open a GitHub pull request from the files you changed in the project folder open
in [Maestro Deck](https://github.com/BlueShork/maestro-deck): flows, screenshots,
anything git tracks.

Install it from **Plugins** in Maestro Deck, then open the GitHub panel:

1. **Sign in with GitHub.** A code appears; enter it on github.com. The token is
   stored in your OS keychain.
2. Tick the changed files to send, pick the target branch, and write a commit
   message and a pull request title. The description is pre-filled with the file
   list; edit it if you like.
3. **Open pull request.** The plugin creates a `qa/<title>` branch from the target
   branch, commits the selected files on it through the GitHub API, and opens the
   pull request. Nothing is run or changed in your local folder, and no git
   install is needed.

If a selected file also changed on the target branch since your copy, the plugin
refuses to send it. Update your folder first.

Requires Maestro Deck 1.2.0 or later (the `workspace` host API).

## Development

```bash
pnpm install
pnpm test
pnpm dev      # vite build --watch into dist/
```

`src/config.ts` must hold the Client ID of the Maestro Deck OAuth App (Device Flow
enabled). In a development build of Maestro Deck, open **Plugins → Load local
plugin** and pick `dist/`. Reopen the panel after each rebuild.

## Release

1. Bump `version` in `public/manifest.json` and `package.json`, then commit.
2. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The `release` workflow tests, builds and publishes `plugin.zip`, and prints its sha256 in the release notes.
4. Add or update the entry in [`BlueShork/maestro-deck-plugins`](https://github.com/BlueShork/maestro-deck-plugins) `registry.json` (`version`, `url`, `sha256`).

# Run Kagi Rune on Linux

Kagi Rune uses native Rune windows and a private child engine. It does not load the website, start an HTTP server, or require a hosted Kagi instance. The portable package includes the Rust application, a compiled Bun engine, the Skia canvas addon, fonts, an icon, and dependency notices. You do not need Bun, Node.js, Rust, or Electron to run the package.

App authentication, account billing, and account-based sync are absent. Optional provider authorization is separate from an app account. The browser and Electron applications keep their existing commands and data.

## Check your environment

Use Linux x64 with glibc and an active Wayland or X11 desktop. Rune needs a working Vulkan driver, keyboard support through xkbcommon, and the desktop's display libraries. Native file dialogs need a session D-Bus and a working XDG desktop portal with a FileChooser backend. Opening external links needs `xdg-open`. The launcher uses `/bin/sh`, `dirname`, and GNU `readlink`.

The package is relocatable, not a static Linux system image. It includes `lib/skia.linux-x64-gnu.node`, not the host's glibc, display server, Vulkan driver, or desktop portal. The generated `package.json` records the builder's glibc version and the linked libraries reported by `ldd`. Use a compatible distribution. A successful build on one distribution does not prove compatibility with an older glibc.

Wake inhibition is unsupported. Kagi Rune does not prevent screen blanking or system sleep while you read, download, or generate. Configure your desktop's power settings when needed.

## Install and start the portable package

1. Put `kagi-rune-linux-x64.tar.gz` and its `SHA256SUMS` file in a directory on disk. Verify the archive before extraction:

   ```sh
   sha256sum -c SHA256SUMS
   tar -xzf kagi-rune-linux-x64.tar.gz
   ```

2. Start the package's top-level launcher:

   ```sh
   ./kagi-rune-linux-x64/kagi-rune
   ```

   Keep the directory intact. The launcher resolves its own location, sets the engine, asset, and canvas paths, and forwards arguments to the Rust application. Do not start `bin/kagi-rune` directly or copy only the executable.

3. Choose a separate native data directory when needed:

   ```sh
   ./kagi-rune-linux-x64/kagi-rune --data-dir /absolute/path/to/native-data
   ```

   A new or outdated database requires explicit initialization through the app's approval action. Starting the application is not permission to restore or erase an existing library. Do not point the native application at a browser or Electron profile.

To add Kagi Rune to your desktop menu, keep the extracted package at a permanent location. Run these commands from that location's `kagi-rune-linux-x64` directory:

```sh
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/scalable/apps"
ln -s "$PWD/kagi-rune" "$HOME/.local/bin/kagi-rune"
cp kagi-rune.desktop "$HOME/.local/share/applications/kagi-rune.desktop"
cp assets/icon.svg "$HOME/.local/share/icons/hicolor/scalable/apps/kagi-rune.svg"
```

Ensure that your desktop session includes `$HOME/.local/bin` in `PATH`. The symlink command refuses to replace an existing launcher. If you move the package, update that symlink. The desktop entry uses `Exec=kagi-rune` and `Icon=kagi-rune`.

## Keep your data separate

The native data directory defaults to `$XDG_DATA_HOME/kagi-rune` when `XDG_DATA_HOME` is absolute. Otherwise, the Rust host uses `$HOME/.local/share/kagi-rune`. `--data-dir` overrides that choice.

The engine stores the library in `library.sqlite`. It stores imported files under `local/`, saved comic pages under `offline/`, cached images under `image-cache/`, and blob data under `blob-cache/`. The default generation journal directory is `generation-journal/`. Font and generation services also keep their local data under the selected native data directory. A journal directory selected in settings can be outside that directory.

Use **Settings**, **Data** to export a library backup. This SQLite export is not a full copy of imported books, downloads, fonts, or journal artifacts. It excludes private keys, source credentials, the adaptation endpoint, and machine-local paths and preferences. Journal exports are separate. Reconfigure the provider connection after moving a backup to another machine.

For a complete filesystem backup, close Kagi Rune before copying the native data directory and any separately configured journal directory. Exclude `private/` from any backup that you share. The provider endpoint and optional key share an atomic private file with mode `0600`, inside a directory with mode `0700`. An unfiltered filesystem copy includes that connection. Backup and journal contents can include reading history, source addresses, prompts, and generated content, so treat them as private even without the key.

Restore and deletion controls change local data. Review their confirmation before continuing. Moving or replacing a package does not move or erase the native data directory. Native backup and restore do not implicitly modify a browser profile.

## Connect an optional local CLIProxy

Reading, importing local files, and managing the library do not need a generation provider. To generate adaptations, run your own OpenAI-compatible CLIProxy separately.

1. Open **Settings**, **Adapt**.
2. Enter the proxy's base endpoint. A local CLIProxy example is `http://localhost:8317/v1`.
3. Enter an API key only if your proxy requires one. Save the connection and use the model-list action to inspect `/models`.
4. Keep the exact configured models available on the proxy. Kagi does not silently substitute another model when a configured model is unavailable.

The planning and script defaults are both `gpt-6-sol(low)`. The image default is `gpt-image-2.5-flare`. **Priority speed** defaults to off. When enabled, it requests `service_tier: "priority"` for text requests only. Provider support and charges can differ. Do not use invented `-fast` model aliases.

The native engine contacts the configured endpoint directly. Kagi does not install CLIProxy or copy its credentials. Keep API keys out of logs, exported preferences, and shared journal payloads. Source browsing also contacts third-party sites directly and remains subject to their limits and terms.

## Develop and check the native application

Build prerequisites are Bun with standalone compilation support, a Rust toolchain that supports edition 2024, the `x86_64-unknown-linux-gnu` target, a C and C++ linker toolchain, and the Linux development libraries required by Rune and Skia. The build also uses `tar`, `patch`, and `ldd`. Install the root dependencies and the separate `rune/engine` dependencies from their lockfiles before building. Do not replace the pinned native dependencies with newer versions. The package records the Bun version used to build it.

Rune and rune-kit are pinned to `ae8dfeb87cfad081fa87dc38d215ed0d1ba417a7`. `prepare-rune.ts` copies the pinned source into `.tmp/rune-upstream` and applies the repository's runtime-font patch. It prefers the Cargo checkout cache. If that cache is missing, preparation downloads the pinned archive. Cargo package compilation uses `--locked --offline`, so the Cargo dependency cache and target must already be present. Bun's baseline compiler target can also require a cached runtime download. Populate caches before a build that must not access the network.

The build copies Bun's unmodified upstream distribution license for the build runtime's version. It caches that file at `.tmp/rune-build-inputs/bun-<version>-LICENSE.md`. Populate this cache before a network-restricted build. The package includes the upstream list of linked libraries and licenses, not a reconstructed MIT license.

Run commands from the repository root:

```sh
bun run rune:dev -- --data-dir "$PWD/.tmp/rune-dev-data"
bun run rune:check
bun run rune:build
bun run rune:verify -- --offline --seed 429 --repeat 50 \
  --soak-seconds 1200 --idle-seconds 300 \
  --data-dir "$PWD/.tmp/stress-rune-native/data"
```

`rune:dev` starts the native window with the bundled JavaScript engine and the development Bun runtime. `rune:check` checks the web application, native TypeScript, and Rust, then bundles the engine. These commands can prepare the pinned Rune source. They do not authorize database initialization or live source or provider requests. Review the verification script's inputs and approval requirements before running `rune:verify`.

Offline verification also requires `bwrap`, `strace`, `ip`, and `getconf`. The command refuses database changes without `--allow-database-initialize`. Add that flag only after approving the target and pending migrations. The verifier creates isolated run directories under the selected scratch directory and uses a private network namespace.

To inspect a database's migration status without initializing it:

```sh
bun run rune:db:status -- --data-dir "$PWD/.tmp/rune-dev-data"
```

`rune:db:init` applies schema and library migrations. Obtain approval for the exact target directory and pending migrations before running it. Use scratch data for verification, not a real library. Live source and provider checks require separate approval and a request cap.

The package builder places its temporary files in the project's disk-backed `.tmp/` and `rune/dist/` directories. Cargo artifacts go to `rune/target/`. Do not redirect large build files to RAM-backed `/tmp`.

## Find and verify build artifacts

After a successful `bun run rune:build`, inspect these paths:

```text
rune/dist/current/kagi-rune-linux-x64/
rune/dist/current/kagi-rune-linux-x64.tar.gz
rune/dist/current/SHA256SUMS
```

The package directory contains the top-level launcher and desktop entry, `bin/kagi-rune`, `bin/kagi-engine`, `lib/skia.linux-x64-gnu.node`, the canvas SBOM, `assets/`, `licenses/`, this guide, and a generated `package.json`. Font licenses are under `assets/fonts/licenses/`. The manifest records dependency versions, linked system libraries, and SHA-256 hashes for package files other than the manifest itself. Installed npm and Cargo dependency notices and their license inventories are under `licenses/`. Bun's notice identifies the runtime version and upstream licensing reference.

The builder stages a complete package and archive before publication. It flushes staged files and directories, moves them into a unique `rune/dist/packages/` directory, then atomically replaces the `current` symlink. Failed staging leaves the previous `current` package untouched. Older package directories remain available. A process killed during a build can leave a `.build.lock` or staging directory. Confirm that no build process is running before removing such files.

For package verification, check the archive checksum, extract it to a different disk-backed directory, and run the top-level launcher from an unrelated working directory. Use an explicit scratch `--data-dir` and an environment without a Bun executable in `PATH`. Confirm that the native window opens and that bundled fonts and local image composition work without a separately installed JavaScript runtime. Database initialization, restore, deletion, and live requests still require their own approval.

A build, checksum, or typecheck does not prove native feature parity, display compatibility, or performance. Record actual launch, interaction, and stress results separately. No verification result is implied by these instructions.

# HDU Library Sniper

TypeScript/Bun + React + Tauri v2 implementation of the HDU library seat
reservation client. The runtime is a single long-lived service: it serves the
WebUI/API and runs the booking/check-in scheduler in the same process.

## Development

The current repository is developed with Bun. Install dependencies and start
the browser UI with:

```bash
bun install
bun run dev
```

Start the backend separately with `bun run server:dev`. The Vite development
server expects the backend at the same origin in a deployed build; during local
development, proxy `/api` to port `8000` or open the backend-served UI.

## Container

Set `HDU_STUDENT_ID` and `HDU_PASSWORD` through an environment file or Docker
secrets, then run:

```bash
bun run podman:build
bun run podman:up
```

The SQLite database, session Cookie Jar, plans, and audit data live in the
`hdu-data` volume. Do not expose the single-tenant WebUI directly to the public
internet without a trusted network boundary or an authenticated reverse proxy.
`compose.yaml` is also provided for installations that have a Podman Compose
provider.

On Linux, Podman deployment also installs a host systemd timer named
`hdu-library-sniper-booking.timer`. It invokes the one-shot `booking-run`
command daily at 20:00 Asia/Shanghai. The long-running service only polls
automatic check-in every 15 minutes between 07:30 and 19:30.

Use `bun run booking-run --dry-run` to verify the target lookup without
submitting a booking request.

## Windows

The Windows artifact is built on a Windows CI runner because the Tauri NSIS
bundle and Windows secure storage integration require Windows tooling:

```bash
bun run build
bun run build:server
bun run tauri build
```

The installed app keeps the backend running after the window is hidden. The
tray exit action stops the backend.
